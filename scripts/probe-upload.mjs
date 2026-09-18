// 隔离实验：直接测试 REST 的 multipart 文件上传通道（发消息 + 立刻删除）。
// 用法：node --env-file-if-exists=.env /opt/dcdice-bot/_probe-upload.mjs <channelId>
import { REST, Routes } from 'discord.js';

const channelId = process.argv[2];
if (!channelId) {
  console.error('缺少 channelId');
  process.exit(1);
}
const token = process.env.DISCORD_TOKEN;
const rest = new REST({ version: '10', timeout: 20000, retries: 0 }).setToken(token);

const file = Buffer.from('dcdice upload probe\n', 'utf8');
const t0 = Date.now();
try {
  const message = await rest.post(Routes.channelMessages(channelId), {
    body: { content: '【上传通道自检，稍后自动删除】' },
    files: [{ attachment: file, name: 'probe.txt' }],
  });
  const t1 = Date.now();
  console.log(`✅ 带附件上传成功：${t1 - t0}ms  message=${message?.id ?? 'n/a'}`);
  try {
    await rest.delete(Routes.channelMessage(channelId, message.id));
    console.log('✅ 探测消息已删除');
  } catch (error) {
    console.warn('⚠️ 探测消息删除失败（请手动删掉）：', error?.message ?? error);
  }
} catch (error) {
  const t1 = Date.now();
  console.error(`❌ 带附件上传失败：${t1 - t0}ms`);
  console.error('  name   =', error?.name);
  console.error('  message=', error?.message);
  console.error('  status =', error?.status);
  console.error('  method =', error?.method, 'url =', error?.url);
}
process.exit(0);
