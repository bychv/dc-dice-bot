/**
 * `/nn` 设置称呼 and `/nnn` 随机称呼 — docs §12.1/§12.2.
 *
 * The frozen `BotStore` has no nickname slot, so `jsonStore` provides the optional `NickStore`
 * capability (`src/store/extras.ts`) and this handler falls back to an in-process map for
 * stores that do not implement it. Display priority: 频道称呼 > 全局称呼 (docs §12.1).
 */
import type { CommandHandler } from '../../contracts/bot.ts';
import { nickStore } from './context.ts';
import { mentionChannel } from './format.ts';
import { randomName, normalizeLang } from './names.ts';
import { fail, ok, optionString, requireText, subcommand } from './options.ts';

export const nnHandler: CommandHandler = async (ctx, deps) => {
  const sub = subcommand(ctx) ?? 'set';
  const nicks = nickStore(deps.store);

  if (sub === 'set') {
    const name = requireText(ctx, 'name');
    if (!name) return fail('请提供称呼，例如 `/nn set name:kp`。');
    if (ctx.guildId) {
      nicks.setNick(ctx.guildId, ctx.channelId, ctx.userId, name);
      return ok(`已设置本场景 ${mentionChannel(ctx.channelId)} 的称呼为「${name}」。`);
    }
    nicks.setGlobalNick(null, ctx.userId, name);
    return ok(`已设置全局称呼为「${name}」（私聊设置的称呼视为全局称呼）。`);
  }

  if (sub === 'del') {
    if (ctx.guildId) {
      const previous = nicks.getNick(ctx.guildId, ctx.channelId, ctx.userId);
      if (!previous) return ok('本场景没有设置称呼。');
      nicks.setNick(ctx.guildId, ctx.channelId, ctx.userId, null);
      return ok(`已删除本场景的称呼「${previous}」。`);
    }
    const previous = nicks.getGlobalNick(null, ctx.userId);
    if (!previous) return ok('没有设置全局称呼。');
    nicks.setGlobalNick(null, ctx.userId, null);
    return ok(`已删除全局称呼「${previous}」。`);
  }

  if (sub === 'clr') {
    const removed = nicks.clearNicks(ctx.userId);
    return ok(`已删除你在各场景记录的全部称呼（共 ${removed} 条）。`);
  }

  return fail('未知的 `/nn` 子命令，可用：set / del / clr。');
};

export const nnnHandler: CommandHandler = async (ctx, deps) => {
  const lang = normalizeLang(optionString(ctx, 'lang'));
  const name = randomName(deps.rng, lang);
  const nicks = nickStore(deps.store);
  if (ctx.guildId) {
    nicks.setNick(ctx.guildId, ctx.channelId, ctx.userId, name);
    return ok(`已从随机姓名牌堆设置本场景称呼为「${name}」。`);
  }
  nicks.setGlobalNick(null, ctx.userId, name);
  return ok(`已从随机姓名牌堆设置全局称呼为「${name}」。`);
};
