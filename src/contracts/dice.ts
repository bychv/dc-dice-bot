/**
 * Dice engine contract — owner: `src/dice/**`.
 *
 * Grammar (from docs/User_Manual.md §4 and ref/Dice/Dice/RD.cpp):
 *   ([轮数]#)([个数]d[面数])(b[奖励骰]|p[惩罚骰])(k[取大])  + 算术项
 * Ranges: 轮数 1-10, 个数 1-100, 面数 1-1000, 奖励/惩罚骰 0-9.
 * `b`/`p` 在百面骰上是十位骰（CoC 奖惩骰），在 D100 之外的骰子上是额外同面数骰（取最大/最小）。
 */
import type { Rng } from './rng';

export interface RollFailure {
  ok: false;
  error: string;
}

export interface DieGroup {
  sides: number;
  /** every rolled value, in roll order */
  values: number[];
  /** k: how many highest values are kept (undefined = keep all) */
  keep?: number;
  /** b: bonus dice count */
  bonus?: number;
  /** p: penalty dice count */
  penalty?: number;
}

export interface RollSuccess {
  ok: true;
  /** normalized expression, e.g. `3d6k2`, `3#1d6`, `1d10+1d6+3` */
  expression: string;
  /** multi-roll count (原 `N#`), 1-10 */
  rounds: number;
  groups: DieGroup[];
  /** constant part of the expression (addends / multipliers), already folded */
  modifier: number;
  /** totals per round, `totals.length === rounds` */
  totals: number[];
  /** sum of all per-round totals */
  total: number;
  /** true when a group exceeded 20 dice and was auto-sorted */
  sorted: boolean;
}

export type RollResult = RollSuccess | RollFailure;

export interface PercentileSuccess {
  ok: true;
  /** chosen value in 1..100 (after bonus/penalty dice resolution) */
  value: number;
  tens: number;
  units: number;
  /** all candidate values, the first is the chosen one */
  candidates: number[];
  bonus: number;
  penalty: number;
}

export type PercentileResult = PercentileSuccess | RollFailure;

/** Result of parsing a `.r`-family argument line into its expression / reason parts. */
export interface RollTextParse {
  /** expression part, e.g. `1d4+2` or a card-stored expression name like `沙漠之鹰` */
  expression: string;
  /** trailing human-readable reason, e.g. `中型刀伤害` */
  reason?: string;
  /** leading `N#` round count if present (also kept out of `expression`) */
  rounds: number;
}

export interface DiceEngine {
  /** Parse + roll an expression (`N#` prefix included). `expr` may be a card expression name. */
  roll(expression: string, rng: Rng): RollResult;
  /** Roll a percentile (d100) with optional bonus/penalty dice. */
  percentile(opts: { bonus?: number; penalty?: number }, rng: Rng): PercentileResult;
}

/**
 * Owner: `src/dice/**`.
 * Split a raw `.r` argument line into expression + reason (手册: `.r [表达式] ([理由])` /
 * `.r [理由]`). Must not throw: illegal input is reported by the caller through `roll()`.
 */
export type ParseRollText = (text: string) => RollTextParse;

/** Owner: `src/dice/**`. Render a roll result for chat. `compact` = `/rs` (totals only). */
export type RenderRoll = (result: RollResult, opts?: { compact?: boolean }) => string;
