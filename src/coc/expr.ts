/**
 * 骰式求值辅助：`.st` 相对修改、`.sc` 理智损失、`.en` 成长都复用这里的三个入口。
 *
 * - `constValue`：`0` / `-3` 这类纯常量不经过 DiceEngine（ref 里 `RD("0")` 亦为常量）。
 * - `evalExpr`：优先把整条表达式交给 DiceEngine（保序、保语义）；
 *   引擎不接受前导符号时退化为「逐项求和」，从而 `-1D6+2` == `-1d6 + 2` 而非 `-(1d6+2)`。
 * - `expressionMax`：`.sc` 大失败「失去最大 san」需要表达式的最大值（ref `RD::Max()`）。
 *   简单求和式（`NdM`/常量）直接解析；复杂式回退为「全部取最大面的 Rng」。
 */
import type { DiceEngine, RollResult } from '../contracts/dice.ts';
import type { Rng } from '../contracts/rng.ts';

/** 固定返回上界的 Rng：让 DiceEngine 把 `NdM` 全部掷出最大值。 */
const MAX_RNG: Rng = {
  int: (_min: number, max: number) => max,
};

export function constValue(expr: string): number | null {
  const text = (expr ?? '').trim();
  return /^[+-]?\d+$/.test(text) ? Number.parseInt(text, 10) : null;
}

export function splitSign(expr: string): { sign: 1 | -1; body: string } {
  const text = (expr ?? '').trim();
  if (text.startsWith('-')) return { sign: -1, body: text.slice(1) };
  if (text.startsWith('+')) return { sign: 1, body: text.slice(1) };
  return { sign: 1, body: text };
}

export type EvalResult = { ok: true; total: number } | { ok: false; error: string };

/** 求表达式数值（含前导 `+` / `-`）。 */
export function evalExpr(dice: DiceEngine, expr: string, rng: Rng): EvalResult {
  const text = (expr ?? '').trim();
  if (!text) return { ok: false, error: '表达式为空' };
  const constant = constValue(text);
  if (constant !== null) return { ok: true, total: constant };

  const whole = dice.roll(text, rng);
  if (whole.ok) return { ok: true, total: whole.total };

  // 整条失败时按加减拆项，保证 `-1D6+2` 的符号只作用于第一项。
  const terms = text.replace(/\s+/g, '').match(/[+-]?[^+-]+/g);
  if (!terms) return { ok: false, error: whole.error };
  let total = 0;
  for (const term of terms) {
    const c = constValue(term);
    if (c !== null) {
      total += c;
      continue;
    }
    const { sign, body } = splitSign(term);
    const rolled: RollResult = dice.roll(body, rng);
    if (!rolled.ok) return { ok: false, error: rolled.error };
    total += sign * rolled.total;
  }
  return { ok: true, total };
}

/** 求和式 `NdM`/常量的最大值；无法解析时返回 null（调用方回退到 MAX_RNG）。 */
export function expressionMax(expr: string): number | null {
  const norm = (expr ?? '').replace(/\s+/g, '');
  if (!norm) return null;
  const terms = norm.match(/[+-]?[^+-]+/g);
  if (!terms) return null;
  let total = 0;
  for (const term of terms) {
    const m = /^([+-]?)(?:(\d*)d(\d+)|(\d+))$/i.exec(term);
    if (!m) return null;
    const sign = m[1] === '-' ? -1 : 1;
    if (m[4] !== undefined) {
      total += sign * Number.parseInt(m[4], 10);
    } else {
      const count = m[2] ? Number.parseInt(m[2], 10) : 1;
      total += sign * count * Number.parseInt(m[3], 10);
    }
  }
  return total;
}

/** 表达式最大值；复杂式子通过「全取最大面」的 DiceEngine 调用来求。 */
export function maxOfExpr(dice: DiceEngine, expr: string): number | null {
  const analytic = expressionMax(expr);
  if (analytic !== null) return analytic;
  const { sign, body } = splitSign(expr);
  if (!body) return null;
  const rolled = dice.roll(body, MAX_RNG);
  return rolled.ok ? sign * rolled.total : null;
}
