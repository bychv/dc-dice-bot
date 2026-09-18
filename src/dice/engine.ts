/**
 * Dice engine (owner: `src/dice/**`).
 *
 * `roll()` mirrors `ref/Dice/Dice/RD.cpp`:
 *  - one `N#` round prefix (1-10), each round re-rolls every dice term;
 *  - `XdY` (X 1-100, Y 1-1000), `kN` keeps the N highest values;
 *  - `bN` / `pN` alone (or with a single `d100`) are percentile dice (fixed d100, 0-9 extra tens
 *    dice), and the chosen value is the **minimum** candidate for a bonus die and the **maximum**
 *    candidate for a penalty die (RD::RollDice, B_Dice / P_Dice branches);
 *  - on any other die type `XdYbN` / `XdYpN` means **N extra dice of the same type**: the bonus
 *    keeps the X highest, the penalty the X lowest (`1d10b2` = 3d10 keep the max, docs §4.1);
 *  - a roll of more than 20 dice in one term is auto-sorted (`sorted: true`);
 *  - illegal input is reported as `{ ok: false, error }` and never throws.
 */
import type { DiceEngine, DieGroup, PercentileResult, RollResult } from '../contracts/dice.ts';
import type { Rng } from '../contracts/rng.ts';
import { isDiceTerm, parseExpression } from './expression.ts';

function die(rng: Rng, min: number, max: number): number {
  const value = rng.int(min, max);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`随机数生成器返回了非法值：${String(value)}（期望 ${min}-${max}）`);
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bonus/penalty tens dice, exactly like RD::RollDice (B_Dice / P_Dice branches):
 * the extra d10 only replaces the tens digit of the base d100.  The rolled die is
 * stored as RD does (`die` when the base ends in 0, otherwise `die - 1`), and the
 * candidate d100 values swap that tens digit in while keeping the base units digit.
 */
interface PercentileRoll {
  base: number;
  /** raw tens values, stored in `DieGroup.values` exactly like RD's `vvintRes` */
  tensValues: number[];
  /** candidate d100 values: the base roll plus every tens-swapped value */
  candidates: number[];
}

function rollPercentileDice(extra: number, rng: Rng): PercentileRoll {
  const base = die(rng, 1, 100);
  const units = base % 10;
  const tensValues: number[] = [];
  const candidates = [base];
  for (let i = 0; i < extra; i++) {
    const tensDie = die(rng, 1, 10);
    const tens = units === 0 ? tensDie : tensDie - 1;
    tensValues.push(tens);
    candidates.push(tens * 10 + units);
  }
  return { base, tensValues, candidates };
}

/** Bonus dice keep the lowest candidate, penalty dice the highest (RD.cpp). */
function choosePercentile(candidates: number[], preferLow: boolean): number {
  let chosen = candidates[0] as number;
  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i] as number;
    if (preferLow ? candidate < chosen : candidate > chosen) chosen = candidate;
  }
  return chosen;
}

function rollExpression(expression: string, rng: Rng): RollResult {
  const parsed = parseExpression(expression);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { rounds, terms, expression: normalized, modifier } = parsed.value;

  const groups: DieGroup[] = [];
  for (const term of terms) {
    if (!isDiceTerm(term)) continue;
    const group: DieGroup = { sides: term.sides, values: [] };
    if (term.keep !== undefined) group.keep = term.keep;
    if (term.bonus !== undefined) group.bonus = term.bonus;
    if (term.penalty !== undefined) group.penalty = term.penalty;
    groups.push(group);
  }

  const totals: number[] = [];
  let sorted = false;

  for (let round = 0; round < rounds; round++) {
    let roundTotal = modifier;
    let groupIndex = 0;

    for (const term of terms) {
      if (!isDiceTerm(term)) continue;
      const group = groups[groupIndex] as DieGroup;
      groupIndex++;

      let contribution: number;
      // 百面骰 + b/p = CoC 十位骰奖惩；其他面数的 b/p = 额外同面数骰（docs §4.1）
      if (term.sides === 100 && (term.bonus !== undefined || term.penalty !== undefined)) {
        const extra = (term.bonus ?? term.penalty ?? 0) as number;
        const percentile = rollPercentileDice(extra, rng);
        contribution = choosePercentile(percentile.candidates, term.bonus !== undefined);
        group.values.push(percentile.base, ...percentile.tensValues);
      } else {
        const extra = (term.bonus ?? term.penalty ?? 0) as number;
        const diceCount = term.count + extra;
        const start = group.values.length;
        for (let i = 0; i < diceCount; i++) group.values.push(die(rng, 1, term.sides));
        const chunk = group.values.slice(start);
        if (term.keep !== undefined) {
          const kept = chunk
            .slice()
            .sort((a, b) => a - b)
            .slice(chunk.length - term.keep);
          contribution = kept.reduce((sum, value) => sum + value, 0);
        } else if (extra > 0) {
          // 奖励骰取最大的 count 个，惩罚骰取最小的 count 个（`1d10b2` 即 3 个 d10 取最大）
          const ordered = chunk
            .slice()
            .sort((a, b) => (term.bonus !== undefined ? b - a : a - b));
          contribution = ordered.slice(0, term.count).reduce((sum, value) => sum + value, 0);
        } else {
          contribution = chunk.reduce((sum, value) => sum + value, 0);
        }
        if (diceCount > 20) {
          const ordered = chunk.slice().sort((a, b) => a - b);
          for (let i = 0; i < ordered.length; i++) group.values[start + i] = ordered[i] as number;
          sorted = true;
        }
      }

      contribution = Math.trunc((contribution * term.multiplier) / term.divisor);
      roundTotal += term.sign < 0 ? -contribution : contribution;
    }

    totals.push(roundTotal);
  }

  return {
    ok: true,
    expression: normalized,
    rounds,
    groups,
    modifier,
    totals,
    total: totals.reduce((sum, value) => sum + value, 0),
    sorted,
  };
}

function rollPercentile(
  opts: { bonus?: number; penalty?: number } | undefined,
  rng: Rng,
): PercentileResult {
  const bonus = opts?.bonus ?? 0;
  const penalty = opts?.penalty ?? 0;
  const inputs: [string, number][] = [
    ['奖励骰', bonus],
    ['惩罚骰', penalty],
  ];
  for (const [label, value] of inputs) {
    if (!Number.isInteger(value) || value < 0 || value > 9) {
      return { ok: false, error: `${label}数量必须在 0-9 之间（输入：${String(value)}）` };
    }
  }

  // Bonus and penalty dice cancel out, like CoC table play.
  const net = bonus - penalty;
  const extra = Math.abs(net);
  const effectiveBonus = net > 0 ? net : 0;
  const effectivePenalty = net < 0 ? -net : 0;

  const { candidates } = rollPercentileDice(extra, rng);
  let chosenIndex = 0;
  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i] as number;
    if (net > 0 ? candidate < (candidates[chosenIndex] as number) : candidate > (candidates[chosenIndex] as number)) {
      chosenIndex = i;
    }
  }
  const value = candidates[chosenIndex] as number;
  return {
    ok: true,
    value,
    tens: Math.floor(value / 10),
    units: value % 10,
    candidates: [value, ...candidates.filter((_, index) => index !== chosenIndex)],
    bonus: effectiveBonus,
    penalty: effectivePenalty,
  };
}

/** Create a stateless dice engine; every roll takes its own `Rng`. */
export function createDiceEngine(): DiceEngine {
  return {
    roll(expression: string, rng: Rng): RollResult {
      try {
        return rollExpression(expression, rng);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
    percentile(opts: { bonus?: number; penalty?: number }, rng: Rng): PercentileResult {
      try {
        return rollPercentile(opts, rng);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
  };
}
