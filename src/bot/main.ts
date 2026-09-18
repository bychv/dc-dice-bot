/**
 * Production entry point — `node src/bot/main.ts`.
 *
 * Wires the frozen contracts to their implementations: JSON store, dice engine, CoC rules,
 * discord.js platform and the injected clock, then dispatches interactions and records chatter
 * into the active log.
 *
 * Environment:
 *   DISCORD_TOKEN      required — bot token
 *   DCDICE_DATA_DIR    optional — JSON data directory (default `./data`)
 */
import { Client, Events, GatewayIntentBits, Partials, REST, Routes } from 'discord.js';

import type { HandlerDeps } from '../contracts/bot.ts';
import { createCocRules } from '../coc/index.ts';
import { createDiceEngine, createMathRng } from '../dice/index.ts';
import { createJsonStoreWithExtras } from '../store/jsonStore.ts';
import {
  createDiscordPlatform,
  createLogRecorder,
  handleButtonInteraction,
  handleInteraction,
} from './adapter.ts';
import { createAuditLogger } from './audit.ts';
import { registerGuildCommands } from './command-sync.ts';
import { createPendingActions } from './confirm.ts';
import { COMMANDS } from './manifest.ts';
import { installProxyFromEnv, redactProxy } from './net-proxy.ts';

const token = process.env.DISCORD_TOKEN ?? '';
if (token.length === 0) {
  console.error('缺少 DISCORD_TOKEN 环境变量；请先设置后再启动。');
  process.exit(1);
}
// 必须早于任何网络客户端创建：同时接管 REST(undici) 与网关 WebSocket(https.globalAgent)
const proxy = installProxyFromEnv();
if (proxy) console.log(`通过代理访问 Discord：${redactProxy(proxy)}`);
const dataDir = process.env.DCDICE_DATA_DIR ?? './data';

/**
 * Message Content 是**特权 intent**：开发者门户没开启时请求它会被网关以
 * "Used disallowed intents" 直接踢掉。这里先查 `GET /applications/@me` 的 flags 决定要不要带上它：
 *   - bit 18 `GATEWAY_MESSAGE_CONTENT`：≥100 服务器的应用获批
 *   - bit 19 `GATEWAY_MESSAGE_CONTENT_LIMITED`：<100 服务器的应用在门户里打开了开关（大多数自建 bot 是这种）
 * 二者任一即说明可以请求；都没有时不请求，避免整只 bot 起不来（代价是 /log 记不到正文）。
 */
const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;
const MESSAGE_CONTENT_FLAGS = GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED;

async function resolveMessageContentIntent(): Promise<boolean> {
  const override = process.env.DCDICE_MESSAGE_CONTENT?.trim();
  if (override === '1' || override?.toLowerCase() === 'true') return true;
  if (override === '0' || override?.toLowerCase() === 'false') return false;
  try {
    const probe = new REST({ version: '10' }).setToken(token);
    const app = (await probe.get(Routes.currentApplication())) as { flags?: number };
    return ((app.flags ?? 0) & MESSAGE_CONTENT_FLAGS) !== 0;
  } catch (error) {
    console.warn('查询应用 flags 失败，暂不启用 Message Content intent：', error);
    return false;
  }
}

const messageContent = await resolveMessageContentIntent();
if (!messageContent) {
  console.warn(
    '未启用 Message Content Intent：/log 不会记录消息正文。' +
      '在 https://discord.com/developers/applications → Bot → Privileged Gateway Intents 打开 ' +
      '“Message Content Intent” 后重启即可（或用 DCDICE_MESSAGE_CONTENT=1 强制请求）。',
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    ...(messageContent ? [GatewayIntentBits.MessageContent] : []),
  ],
  partials: [Partials.Channel],
  // 交互回执要带附件（日志导出）时 15s 默认超时偏紧；加大超时并保留重试
  rest: {
    timeout: Number(process.env.DCDICE_REST_TIMEOUT ?? 30000),
    retries: Number(process.env.DCDICE_REST_RETRIES ?? 2),
  },
});

const store = createJsonStoreWithExtras({ dir: dataDir });
const dice = createDiceEngine();
const deps: HandlerDeps = {
  store,
  dice,
  coc: createCocRules(dice),
  rng: createMathRng(),
  platform: createDiscordPlatform(client),
  confirmations: createPendingActions(),
  now: () => new Date(),
};

/**
 * 命令自动同步（多服务器）：
 *   - 启动时把命令覆盖式注册到**当前已在的所有服务器**（补上漏注册的服务器、并让定义变更立即生效）；
 *   - 之后被邀请进新服务器（`guildCreate`）时立即给该服务器注册，无需人工再跑 deploy。
 * 只写 guild 作用域、不碰全局（见 `command-sync.ts` 顶部说明）。
 * `DCDICE_AUTO_SYNC_COMMANDS=0` 可关闭（例如命令由外部 CI 统一管理时）。
 */
const AUTO_SYNC = process.env.DCDICE_AUTO_SYNC_COMMANDS !== '0';
/** 本进程内已同步过的服务器：guildCreate 在启动时可能对已有服务器重复触发，靠它去重。 */
const syncedGuilds = new Set<string>();

async function syncGuildCommands(applicationId: string, guildIds: string[]): Promise<string[]> {
  const targets = guildIds.filter((id) => !syncedGuilds.has(id));
  if (!AUTO_SYNC || targets.length === 0) return [];
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    const done = await registerGuildCommands(rest, applicationId, targets, COMMANDS);
    for (const id of done) syncedGuilds.add(id);
    console.log(`已同步 ${COMMANDS.length} 条 slash 命令到服务器：${done.join('、')}`);
    return done;
  } catch (error) {
    console.error('slash 命令同步失败（不影响其它功能）：', error);
    for (const id of targets) syncedGuilds.add(id); // 不在同一次启动里反复重试刷日志
    return [];
  }
}

client.once(Events.ClientReady, (ready) => {
  console.log(`dcdice bot 已登录：${ready.user.tag}（数据目录 ${dataDir}）`);
  void syncGuildCommands(ready.application.id, [...client.guilds.cache.keys()]);
});

client.on(Events.GuildCreate, (guild) => {
  const applicationId = client.application?.id ?? client.user?.id ?? '';
  if (applicationId.length === 0) {
    console.error(`加入服务器 ${guild.name}（${guild.id}）但拿不到 application id；请手动跑 npm run deploy。`);
    return;
  }
  void syncGuildCommands(applicationId, [guild.id]);
});

/** 错误详情（AbortError 之类的 DOMException 光看 message 定位不到是哪条请求）。 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const extra = error as Error & { status?: number; method?: string; url?: string; code?: unknown };
  const parts = [`${error.name}: ${error.message}`];
  if (extra.status !== undefined) parts.push(`status=${extra.status}`);
  if (extra.code !== undefined) parts.push(`code=${String(extra.code)}`);
  if (extra.method && extra.url) parts.push(`${extra.method} ${extra.url}`);
  parts.push(`\n${error.stack ?? '(no stack)'}`);
  return parts.join(' | ');
}

/** 运行日志：每条交互记「命令 + 解析到的上下文 + 回执摘要」，排查跨子区/绑卡问题用（audit.ts）。 */
const audit = createAuditLogger(deps);

client.on(Events.InteractionCreate, (interaction) => {
  // 破坏性命令的确认/取消按钮 (docs §16.6)
  if (interaction.isButton()) {
    audit.button(interaction.customId, interaction.user.id);
    void handleButtonInteraction(interaction, deps).catch((error: unknown) => {
      console.error(`处理按钮 ${interaction.customId} 失败：${describeError(error)}`);
    });
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  void handleInteraction(interaction, deps, {
    onContext: (context) => audit.context(context),
    onPayload: (_context, payload) => audit.result(payload),
  }).catch((error: unknown) => {
    console.error(`处理 /${interaction.commandName} 失败：${describeError(error)}`);
  });
});

client.on(Events.MessageCreate, createLogRecorder(store));

client.on(Events.Error, (error) => {
  console.error('discord.js 客户端错误：', error);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal}：正在写盘并断开连接…`);
  try {
    await store.flush();
    await client.destroy();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await client.login(token);
