/**
 * `/setcoc` — 检定房规 (docs §8.1).
 *
 * With an active session the rule is stored **on the session** (局内所有场景共享、切局自动跟随);
 * otherwise on the scene. Effective order: 本局房规 → 场景房规 → 骰主默认. Setting a session rule
 * is limited to the session KP or a server admin (docs §16.6).
 */
import type { CommandHandler } from '../../contracts/bot.ts';
import { HOUSE_RULES, type HouseRule } from '../../contracts/model.ts';
import { currentGame, resolveRule } from './context.ts';
import { fmtRule, mentionChannel } from './format.ts';
import { fail, ok, optionInteger, subcommand } from './options.ts';

function maySet(ctx: { isAdmin: boolean; userId: string }, keeperId: string): boolean {
  return ctx.isAdmin || ctx.userId === keeperId;
}

export const setcocHandler: CommandHandler = async (ctx, deps) => {
  const sub = subcommand(ctx) ?? 'show';
  const game = currentGame(ctx, deps);

  if (sub === 'set') {
    const raw = optionInteger(ctx, 'rule');
    if (raw === null) return fail('请提供房规编号 0-6，例如 `/setcoc set rule:1`。');
    if (!HOUSE_RULES.includes(raw as HouseRule)) return fail('房规编号必须是 0-6。');
    const rule = raw as HouseRule;

    if (game) {
      if (!maySet(ctx, game.keeperId)) {
        return fail(`本局房规由该局 KP <@${game.keeperId}> 或服务器管理员设置。`);
      }
      deps.store.setGameRule(game.id, rule, ctx.guildId ?? undefined);
      game.rule = rule;
      deps.store.putGame(game);
      return ok(`已设置本局 ${game.id} ${game.name} 的房规为 ${rule}（局内所有场景共享，切局自动跟随）。`);
    }
    deps.store.setSceneRule(ctx.channelId, rule);
    return ok(`已设置场景 ${mentionChannel(ctx.channelId)} 的房规为 ${rule}。（未绑定局的场景使用场景房规）`);
  }

  if (sub === 'clr') {
    if (game) {
      if (!maySet(ctx, game.keeperId)) {
        return fail(`本局房规由该局 KP <@${game.keeperId}> 或服务器管理员清除。`);
      }
      deps.store.setGameRule(game.id, null, ctx.guildId ?? undefined);
      game.rule = null;
      deps.store.putGame(game);
      const effective = resolveRule(ctx, deps);
      return ok(`已清除本局房规，当前生效：${fmtRule(effective.rule, effective.source)}。`);
    }
    deps.store.setSceneRule(ctx.channelId, null);
    const effective = resolveRule(ctx, deps);
    return ok(`已清除场景房规，回落到骰主默认：${fmtRule(effective.rule, effective.source)}。`);
  }

  // show（也接受直接 /setcoc）
  const effective = resolveRule(ctx, deps);
  const scope = game ? `本局 ${game.id} ${game.name}` : `场景 ${mentionChannel(ctx.channelId)}`;
  return ok(`当前生效房规：${fmtRule(effective.rule, effective.source)}（${scope}）`);
};
