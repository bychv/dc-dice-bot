/**
 * Slash-command registration — `node src/bot/deploy.ts`.
 *
 * Registers exactly the documented command set (`src/bot/manifest.ts`, loaded from
 * `src/bot/spec/discord-commands.json`). **只注册一处作用域**，并把另一处清空：
 * Discord 允许同一个应用同时在 guild 与全局存在同名命令，客户端会把两套都列出来
 * （"命令注册了两次"），所以：
 *   - 设置了 `DISCORD_GUILD_ID` → 注册 guild 命令（即时生效）并**清空全局命令**（开发/测试）
 *   - 未设置 → 只注册全局命令（生产，最长约 1 小时生效）
 *
 * 环境：
 *   DISCORD_TOKEN            required — bot token
 *   DISCORD_APPLICATION_ID   required — application id（别名 CLIENT_ID）
 *   DISCORD_GUILD_ID         optional — 别名 GUILD_ID；设置后命令注册到该服务器
 *   DISCORD_GUILD_IDS        optional — **多个**服务器 id（逗号/空格分隔），与上面合并去重
 *   HTTPS_PROXY / HTTP_PROXY optional — 无直连环境时走代理（见 net-proxy.ts）
 *
 * 小技巧：只想给某几个服务器补命令（不动 .env）时，直接用行内环境变量覆盖：
 *   DISCORD_GUILD_ID=<新服务器 id> node --env-file-if-exists=.env src/bot/deploy.ts
 */
import { REST, Routes } from 'discord.js';

import {
  globalCommandRoute,
  parseGuildIds,
  registerGuildCommands,
} from './command-sync.ts';
import { COMMANDS } from './manifest.ts';
import { installProxyFromEnv, redactProxy } from './net-proxy.ts';
import { validateManifest } from './spec-validate.ts';

const token = process.env.DISCORD_TOKEN ?? '';
const applicationId = process.env.DISCORD_APPLICATION_ID ?? process.env.CLIENT_ID ?? '';
const guildIds = parseGuildIds(
  process.env.DISCORD_GUILD_ID,
  process.env.GUILD_ID,
  process.env.DISCORD_GUILD_IDS,
);

if (token.length === 0 || applicationId.length === 0) {
  console.error('缺少 DISCORD_TOKEN 或 DISCORD_APPLICATION_ID（CLIENT_ID）环境变量。');
  process.exit(1);
}

const proxy = installProxyFromEnv();
if (proxy) console.log(`通过代理访问 Discord：${redactProxy(proxy)}`);

const rest = new REST({ version: '10' }).setToken(token);
const body = COMMANDS;

// 先本地校验，避免把 Discord 的 400 Invalid Form Body 抛给用户（例如本地化名用了大写）
const problems = validateManifest(body);
if (problems.length > 0) {
  console.error(`${problems.length} 处 payload 不合法，未向 Discord 发送：`);
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}

async function count(path: `/${string}`): Promise<number> {
  const list = await rest.get(path);
  return Array.isArray(list) ? list.length : 0;
}

if (guildIds.length > 0) {
  const registered = await registerGuildCommands(rest, applicationId, guildIds, body);
  // 清掉全局命令：否则同一个 guild 里同名命令会出现两套
  const globalBefore = await count(globalCommandRoute(applicationId));
  await rest.put(globalCommandRoute(applicationId), { body: [] });
  console.log(
    `已注册 ${body.length} 条命令到 ${registered.length} 个服务器（即时生效）：${registered.join('、')}；` +
      `全局命令 ${globalBefore} → 0（避免同一 guild 内重复）。`,
  );
} else {
  await rest.put(Routes.applicationCommands(applicationId), { body });
  const global = await count(Routes.applicationCommands(applicationId));
  console.log(`已注册 ${global} 条全局命令（未设置 DISCORD_GUILD_ID(S)；最长约 1 小时生效）。`);
}
