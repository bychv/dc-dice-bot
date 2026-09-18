/**
 * 线上自检 —— `node scripts/discord-info.ts`
 *
 * 打印：应用 flags（含 Message Content 特权 intent 是否获批）、bot 所在服务器、
 * 以及每个服务器里可用来测试的文本频道/子区，便于把 bot 拉进正确的频道测试。
 * 只读，不会发消息。
 */
import { Client, Events, GatewayIntentBits, REST, Routes } from 'discord.js';

import { installProxyFromEnv, redactProxy } from '../src/bot/net-proxy.ts';

const token = process.env.DISCORD_TOKEN ?? '';
if (token.length === 0) {
  console.error('缺少 DISCORD_TOKEN。');
  process.exit(1);
}
const proxy = installProxyFromEnv();
if (proxy) console.log(`通过代理访问 Discord：${redactProxy(proxy)}`);

const MESSAGE_CONTENT = 1 << 18;
const MESSAGE_CONTENT_LIMITED = 1 << 19;
const rest = new REST({ version: '10' }).setToken(token);

const app = (await rest.get(Routes.currentApplication())) as {
  id: string;
  name: string;
  flags?: number;
  bot?: { id: string; username: string };
};
const flags = app.flags ?? 0;
console.log(`应用：${app.name} (${app.id})  bot=${app.bot?.username}#${app.bot?.id ?? ''}`);
const messageContent = (flags & (MESSAGE_CONTENT | MESSAGE_CONTENT_LIMITED)) !== 0;
console.log(
  `Message Content 特权 intent：${messageContent ? '已开启 ✅' : '未开启 ❌'}` +
    `（flags=${flags}，≥100 服务器位=${(flags & MESSAGE_CONTENT) !== 0}，<100 服务器位=${(flags & MESSAGE_CONTENT_LIMITED) !== 0}）`,
);

const commands = await rest.get(Routes.applicationCommands(app.id));
console.log(`全局命令：${Array.isArray(commands) ? commands.length : 0} 条`);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(token);
await new Promise<void>((resolve) => {
  client.once(Events.ClientReady, () => { resolve(); });
});

for (const guild of client.guilds.cache.values()) {
  const guildCommands = await rest.get(Routes.applicationGuildCommands(app.id, guild.id));
  console.log(`\n服务器：${guild.name} (${guild.id})  guild 命令=${Array.isArray(guildCommands) ? guildCommands.length : 0} 条`);
  const me = guild.members.me;
  const textChannels = [...guild.channels.cache.values()].filter(
    (channel) => channel.type === 0 && channel.isTextBased(),
  );
  const usable = textChannels.filter((channel) =>
    me ? channel.permissionsFor(me)?.has(['SendMessages', 'ViewChannel', 'CreatePublicThreads']) : true,
  );
  for (const channel of usable.slice(0, 8)) {
    console.log(`  #${channel.name} (${channel.id}) 可发消息并可建子区`);
  }
  if (usable.length === 0) console.log('  没有可直接发消息 + 建子区的文本频道（检查 bot 权限）');
}

await client.destroy();
process.exit(0);
