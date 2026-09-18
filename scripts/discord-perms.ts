/**
 * 权限自检 —— `node --env-file-if-exists=.env scripts/discord-perms.ts`
 *
 * 只读 REST（不连网关）：
 *  1) 找到本应用在该服务器的**托管角色**（身份组）及其权限
 *  2) 叠加 bot 成员的所有角色，算出服务器级权限，逐条核对本 bot 需要的位
 *  3) 打印带正确 permissions 的重新授权 URL（若缺权限，重拉一次即可补齐）
 */
import { PermissionsBitField, REST, Routes } from 'discord.js';

import { installProxyFromEnv, redactProxy } from '../src/bot/net-proxy.ts';

const token = process.env.DISCORD_TOKEN ?? '';
const appId = process.env.DISCORD_APPLICATION_ID ?? process.env.CLIENT_ID ?? '';
if (!token || !appId) {
  console.error('缺少 DISCORD_TOKEN 或 DISCORD_APPLICATION_ID。');
  process.exit(1);
}
const proxy = installProxyFromEnv();
if (proxy) console.log(`通过代理访问 Discord：${redactProxy(proxy)}`);

/** 本 bot 必需 / 建议的权限位 */
const REQUIRED = [
  'ViewChannel',
  'SendMessages',
  'SendMessagesInThreads',
  'CreatePublicThreads',
  'CreatePrivateThreads',
  'ManageThreads',
  'EmbedLinks',
  'AttachFiles',
  'ReadMessageHistory',
  'UseApplicationCommands',
] as const;

const rest = new REST({ version: '10' }).setToken(token);
const F = PermissionsBitField.Flags;

interface ApiRole {
  id: string;
  name: string;
  permissions: string;
  managed?: boolean;
  tags?: { bot_id?: string };
}
interface ApiMember {
  roles: string[];
  user?: { id: string; username: string };
}
interface ApiGuild {
  id: string;
  name: string;
}

const guilds = (await rest.get(Routes.userGuilds())) as ApiGuild[];
const guildId = process.env.DISCORD_GUILD_ID ?? process.env.GUILD_ID ?? guilds[0]?.id ?? '';

for (const guild of guilds.filter((g) => !guildId || g.id === guildId)) {
  console.log(`\n=== ${guild.name} (${guild.id}) ===`);
  const roles = (await rest.get(Routes.guildRoles(guild.id))) as ApiRole[];
  const member = (await rest.get(Routes.guildMember(guild.id, appId))) as ApiMember;

  const managed = roles.find((role) => role.tags?.bot_id === appId);
  console.log(
    managed
      ? `托管角色（身份组）：${managed.name} (${managed.id}) permissions=${managed.permissions}`
      : '托管角色：**没有**（通常说明 bot 是以「管理员」权限加入，或用旧式授权）',
  );

  let bits = BigInt(roles.find((role) => role.id === guild.id)?.permissions ?? '0');
  console.log(`成员角色：${member.roles.map((id) => roles.find((r) => r.id === id)?.name ?? id).join(', ') || '(仅 @everyone)'}`);
  for (const roleId of member.roles) {
    const role = roles.find((r) => r.id === roleId);
    if (role) bits |= BigInt(role.permissions);
  }

  const admin = (bits & BigInt(F.Administrator)) !== 0n;
  console.log(`服务器级权限：${admin ? 'Administrator（全权）' : bits.toString()}`);
  const missing: string[] = [];
  for (const name of REQUIRED) {
    const flag = BigInt(F[name as keyof typeof F] as bigint);
    const ok = admin || (bits & flag) !== 0n;
    console.log(`  ${ok ? '✅' : '❌'} ${name}`);
    if (!ok) missing.push(name);
  }

  const recommend = REQUIRED.reduce((acc, name) => acc | (F[name as keyof typeof F] as bigint), 0n);
  const url =
    `https://discord.com/api/oauth2/authorize?client_id=${appId}` +
    `&scope=bot%20applications.commands&permissions=${recommend.toString()}`;
  if (missing.length > 0) {
    console.log(`\n缺 ${missing.length} 项权限 → 用下面的链接重新授权（同一链接会把托管角色补上）：`);
    console.log(url);
  } else {
    console.log('\n权限齐全（子区创建/归档、消息发送、附件都可）。');
    console.log(`如需强制对齐权限，可用：${url}`);
  }
}

process.exit(0);
