/**
 * `/r` and `/rs` — 整行原文解析 (docs §4.1/§4.3).
 *
 * The dice grammar and rendering belong to `src/dice/**` (T1): `parseRollText` splits
 * "[N#expresssion] [理由]" and `renderRoll` renders a `RollResult` (compact = `/rs`).
 * Rolling goes through `deps.dice` so tests can inject a stub engine.
 *
 * Seam notes (Lead, T1 hand-off):
 * - `parseRollText` strips the `N#` round count, so it is re-attached before rolling;
 * - results are read from `total` / `totals` (never `modifier` — `3d6X5` has modifier 0);
 * - a first token that is neither a dice expression nor a card expression means the whole line
 *   is the 理由 of a default d100 roll (docs §4.1), not an error.
 */
import type { CommandHandler, HandlerDeps, InteractionContext } from '../../contracts/bot.ts';
import { parseRollText, renderRoll } from '../../dice/index.ts';
import { resolveNick, resolveSheet } from './context.ts';
import { clamp, fail, ok, optionString } from './options.ts';

/** `1d4+2`, `3d6k2`, `3#1d6`, `b2`, `p` … — anything that looks like a dice expression. */
export function looksLikeExpression(token: string): boolean {
  if (/^\d*[dD]\d+/.test(token)) return true;
  if (/^\d+#/.test(token)) return true;
  if (/^[bBpP]\d*$/.test(token)) return true;
  return false;
}

export interface RollOutcome {
  ok: boolean;
  lines: string[];
  error?: string;
  expression?: string;
}

/**
 * Shared roll path for `/r`, `/rs` and `/rh`.
 * Empty text → the COC default of one d100 (docs §4.1).
 */
export function performRoll(
  ctx: InteractionContext,
  deps: HandlerDeps,
  text: string | null,
  opts: { compact?: boolean; defaultExpression?: string } = {},
): RollOutcome {
  const trimmed = (text ?? '').trim();
  const fallback = opts.defaultExpression ?? '1d100';
  let expression = fallback;
  let reason: string | null = null;
  let rounds = 1;

  if (trimmed.length > 0) {
    const parsed = parseRollText(trimmed);
    const head = parsed.expression;
    if (head === '') {
      reason = trimmed;
    } else if (looksLikeExpression(head)) {
      expression = head;
      reason = parsed.reason ?? null;
      rounds = parsed.rounds;
    } else {
      const sheet = resolveSheet(ctx, deps);
      const resolved = deps.coc.resolveRollExpression(sheet, head);
      if (resolved && resolved.trim().length > 0) {
        expression = resolved.trim();
        reason = parsed.reason ?? null;
        rounds = parsed.rounds;
      } else {
        // `.r [掷骰原因]` 回落：整串当理由，掷默认 100 面骰 1 次
        reason = trimmed;
      }
    }
  }

  const rolled = rounds > 1 ? `${rounds}#${expression}` : expression;
  const result = deps.dice.roll(rolled, deps.rng);
  if (!result.ok) return { ok: false, lines: [], error: result.error, expression: rolled };

  const rendered = renderRoll(result, { compact: opts.compact === true });
  return {
    ok: true,
    lines: [reason ? `${rendered} · ${reason}` : rendered],
    expression: rolled,
  };
}

/** `【称呼】` prefix when the user configured one (docs §12.1). */
export function withNick(ctx: InteractionContext, deps: HandlerDeps, content: string): string {
  const nick = resolveNick(ctx, deps);
  return nick ? `【${nick}】${content}` : content;
}

export const rHandler: CommandHandler = async (ctx, deps) => {
  const text = optionString(ctx, 'text');
  const outcome = performRoll(ctx, deps, text, { compact: false });
  if (!outcome.ok) return fail(`掷骰失败：${outcome.error ?? '无法解析的骰式'}`);
  return ok(clamp(withNick(ctx, deps, outcome.lines.join('\n'))));
};

export const rsHandler: CommandHandler = async (ctx, deps) => {
  const text = optionString(ctx, 'text');
  if (!text || text.trim().length === 0) {
    return fail('请提供要掷骰的表达式或角色卡表达式名，例如 `/rs 沙鹰伤害`。');
  }
  const outcome = performRoll(ctx, deps, text, { compact: true });
  if (!outcome.ok) return fail(`掷骰失败：${outcome.error ?? '无法解析的骰式'}`);
  return ok(clamp(withNick(ctx, deps, outcome.lines.join('\n'))));
};
