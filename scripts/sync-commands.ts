/**
 * 手动同步 slash 命令到**bot 当前所在的所有服务器**（幂等，覆盖式）：
 *
 *   node --env-file-if-exists=.env scripts/sync-commands.ts
 *
 * 平时不需要跑：`main.ts` 启动时会对所有服务器同步一次，被邀请进新服务器时（guildCreate）
 * 也会自动补注册。这个脚本用于：
 *   - 命令定义变了但不想重启进程；
 *   - bot 被邀请时恰好离线等异常情况；
 *   - 想在 CI / 部署流程里显式同步。
 *
 * 也可以只同步指定服务器（逗号/空格分隔，覆盖 bot 所在列表）：
 *   node --env-file-if-exists=.env scripts/sync-commands.ts 123456789012345678
 *
 * 环境变量与 `src/bot/deploy.ts` 相同：DISCORD_TOKEN / DISCORD_APPLICATION_ID（CLIENT_ID）。
 * 只写 guild 作用域，不会创建全局命令（避免同一 guild 里出现两套）。
 */
import { REST } from 'discord.js';

import {
  globalCommandRoute,
  parseGuildIds,
  registerGuildCommands,
} from '../src/bot/command-sync.ts';
import { COMMANDS } from '../src/bot/manifest.ts';
import { installProxyFromEnv, redactProxy } from '../src/bot/net-proxy.ts';
import { validateManifest } from '../src/bot/spec-validate.ts';

const token = process.env.DISCORD_TOKEN ?? '';
const applicationId = process.env.DISCORD_APPLICATION_ID ?? process.env.CLIENT_ID ?? '';

if (token.length === 0 || applicationId.length === 0) {
  console.error('缺少 DISCORD_TOKEN 或 DISCORD_APPLICATION_ID（CLIENT_ID）环境变量。');
  process.exit(1);
}

const problems = validateManifest(COMMANDS);
if (problems.length > 0) {
  console.error(`${problems.length} 处 payload 不合法，未向 Discord 发送：`);
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}

const proxy = installProxyFromEnv();
if (proxy) console.log(`通过代理访问 Discord：${redactProxy(proxy)}`);

const rest = new REST({ version: '10' }).setToken(token);

/** 显式参数优先；否则取 bot 当前所在的服务器列表。 */
async function resolveGuildIds(): Promise<string[]> {
  const explicit = parseGuildIds(...process.argv.slice(2));
  if (explicit.length > 0) return explicit;
  const guilds = (await rest.get('/users/@me/guilds')) as { id: string }[];
  return parseGuildIds(...(Array.isArray(guilds) ? guilds.map((guild) => guild.id) : []));
}

const guildIds = await resolveGuildIds();
if (guildIds.length === 0) {
  console.error('没有可同步的服务器（bot 未加入任何服务器，或参数里没有合法 id）。');
  process.exit(1);
}

const done = await registerGuildCommands(rest, applicationId, guildIds, COMMANDS);

// 全局命令保持为空：同一 guild 里全局与 guild 同名命令会显示两套
const before = (await rest.get(globalCommandRoute(applicationId))) as unknown[];
const globalBefore = Array.isArray(before) ? before.length : 0;
if (globalBefore > 0) {
  await rest.put(globalCommandRoute(applicationId), { body: [] });
}

console.log(
  `已同步 ${COMMANDS.length} 条命令到 ${done.length} 个服务器：${done.join('、')}` +
    (globalBefore > 0 ? `；全局命令 ${globalBefore} → 0` : '；全局命令本来就是 0'),
);
