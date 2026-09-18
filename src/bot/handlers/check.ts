/**
 * `/rc`, `/ra`, `/sc`, `/en` — 整行原文解析的检定命令 (docs §7.1, §9.1, §9.3).
 *
 * Everything rule-specific lives behind `deps.coc`; this module only resolves the context
 * (角色卡 + 房规, 局优先于场景) and persists any sheet the engine mutated.
 */
import type { CommandHandler, InteractionContext, ReplyPayload } from '../../contracts/bot.ts';
import { resolveRule, resolveSheet } from './context.ts';
import { clamp, fail, ok, optionString } from './options.ts';
import { withNick } from './roll.ts';

/** First plain integer after the skill/spec token — `san` for /sc, 技能值 for /en. */
export function parseTrailingNumber(text: string, skipFirstToken: boolean): number | null {
  const tokens = text.trim().split(/\s+/);
  for (let i = skipFirstToken ? 1 : 0; i < tokens.length; i += 1) {
    if (/^\d+$/.test(tokens[i])) return Number(tokens[i]);
  }
  return null;
}

function requireTextArgument(ctx: InteractionContext, name: string): string | ReplyPayload {
  const text = optionString(ctx, 'text');
  if (!text || text.trim().length === 0) {
    return fail(`请提供检定文本，例如 \`/${name} 力量\`、\`/${name} 困难智力 99\`。`);
  }
  return text.trim();
}

function makeCheckHandler(name: string): CommandHandler {
  return async (ctx, deps) => {
    const text = requireTextArgument(ctx, name);
    if (typeof text !== 'string') return text;
    const sheet = resolveSheet(ctx, deps);
    const { rule } = resolveRule(ctx, deps);
    const result = deps.coc.check(text, { sheet, rule, rng: deps.rng });
    if (!result.ok) return fail(result.error);
    return ok(clamp(withNick(ctx, deps, result.lines.join('\n'))));
  };
}

export const rcHandler = makeCheckHandler('rc');
export const raHandler = makeCheckHandler('ra');

export const scHandler: CommandHandler = async (ctx, deps) => {
  const text = requireTextArgument(ctx, 'sc');
  if (typeof text !== 'string') return text;
  const sheet = resolveSheet(ctx, deps);
  const { rule } = resolveRule(ctx, deps);
  const result = deps.coc.sanity(text, {
    sheet,
    rule,
    rng: deps.rng,
    sanOverride: parseTrailingNumber(text, true),
  });
  if (!result.ok) return fail(result.error);
  if (result.sheet) deps.store.putSheet(ctx.userId, result.sheet);
  return ok(clamp(withNick(ctx, deps, result.lines.join('\n'))));
};

export const enHandler: CommandHandler = async (ctx, deps) => {
  const text = requireTextArgument(ctx, 'en');
  if (typeof text !== 'string') return text;
  const sheet = resolveSheet(ctx, deps);
  const { rule } = resolveRule(ctx, deps);
  const result = deps.coc.improve(text, {
    sheet,
    rule,
    rng: deps.rng,
    valueOverride: parseTrailingNumber(text, true),
  });
  if (!result.ok) return fail(result.error);
  if (result.sheet) deps.store.putSheet(ctx.userId, result.sheet);
  return ok(clamp(withNick(ctx, deps, result.lines.join('\n'))));
};
