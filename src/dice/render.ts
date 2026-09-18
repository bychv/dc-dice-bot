/**
 * Result renderer (owner: `src/dice/**`).
 *
 * `compact: false` (like `/r`): `表达式=单骰点数=分项小计=总点数`, with duplicate
 * segments collapsed, mirroring `RD::FormCompleteString()` in ref/Dice/Dice/RD.cpp.
 * `compact: true` (like `/rs`): only the totals are printed.
 *
 * Percentile terms render like the reference: `45[奖励骰:3 7]`.
 * 非百面骰的额外奖惩骰渲染成「保留值[奖惩骰:被丢掉的骰]」，如 `1d10b2` 掷 3/8/2 → `8[奖励骰:3 2]`.
 * For multi-round rolls every round is rendered; `groups[*].values` stores the dice
 * of all rounds concatenated (round order), so each round can be sliced back out.
 */
import type { DieGroup, RollResult } from '../contracts/dice.ts';
import { isDiceTerm, parseExpression } from './expression.ts';
import type { DiceTerm, ParsedExpression, Term } from './expression.ts';

function dedupJoin(parts: string[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    if (part === '') continue;
    if (segments.length > 0 && segments[segments.length - 1] === part) continue;
    segments.push(part);
  }
  return segments.join('=');
}

function perRoundCount(term: DiceTerm): number {
  const extra = term.bonus ?? term.penalty ?? 0;
  if (isPercentile(term)) return 1 + extra;
  return term.count + extra;
}

/** 百面骰上的 b/p 是十位骰（CoC 奖惩骰）；其他面数是额外同面数骰。 */
function isPercentile(term: DiceTerm): boolean {
  return term.sides === 100 && (term.bonus !== undefined || term.penalty !== undefined);
}

function isPoolBonus(term: DiceTerm): boolean {
  return !isPercentile(term) && (term.bonus !== undefined || term.penalty !== undefined);
}

function keptValues(term: DiceTerm, chunk: number[]): number[] {
  if (term.keep === undefined) return chunk;
  return chunk
    .slice()
    .sort((a, b) => a - b)
    .slice(chunk.length - term.keep);
}

/**
 * 额外同面数奖惩骰：奖励保留最大的 `count` 个、惩罚保留最小的 `count` 个；
 * 返回 `{ kept, dropped }`，两者都保持掷骰顺序。
 */
function poolSplit(term: DiceTerm, chunk: number[]): { kept: number[]; dropped: number[] } {
  const extra = term.bonus ?? term.penalty ?? 0;
  if (extra === 0 || chunk.length === 0) return { kept: chunk, dropped: [] };
  const preferHigh = term.bonus !== undefined;
  const order = chunk
    .map((value, index) => ({ value, index }))
    .sort((a, b) => (preferHigh ? b.value - a.value : a.value - b.value) || a.index - b.index);
  const keptIndexes = new Set(order.slice(0, term.count).map((entry) => entry.index));
  return {
    kept: chunk.filter((_, index) => keptIndexes.has(index)),
    dropped: chunk.filter((_, index) => !keptIndexes.has(index)),
  };
}

/** Candidate d100 values of a percentile chunk `[base, ...tensValues]`. */
function percentileCandidates(chunk: number[]): number[] {
  const base = chunk[0] as number;
  const units = base % 10;
  return [base, ...chunk.slice(1).map((tens) => tens * 10 + units)];
}

function contributionOf(term: DiceTerm, chunk: number[]): number {
  if (isPercentile(term)) {
    const candidates = percentileCandidates(chunk);
    let chosen = candidates[0] as number;
    for (let i = 1; i < candidates.length; i++) {
      const candidate = candidates[i] as number;
      if (term.bonus !== undefined ? candidate < chosen : candidate > chosen) chosen = candidate;
    }
    return chosen;
  }
  if (isPoolBonus(term)) {
    return poolSplit(term, chunk).kept.reduce((sum, value) => sum + value, 0);
  }
  return keptValues(term, chunk).reduce((sum, value) => sum + value, 0);
}

function displayOf(term: DiceTerm, chunk: number[], termCount: number): string {
  let text: string;
  if (isPercentile(term)) {
    const base = chunk[0] as number;
    const rest = chunk.slice(1);
    if (rest.length === 0) {
      text = `${base}`;
    } else {
      const label = term.bonus !== undefined ? '奖励骰' : '惩罚骰';
      text = `${base}[${label}:${rest.join(' ')}]`;
    }
  } else if (isPoolBonus(term)) {
    // 例：`1d10b2` 掷出 3/8/2 → 取最大的 8，丢掉的两个写在方括号里：`8[奖励骰:3 2]`
    const label = term.bonus !== undefined ? '奖励骰' : '惩罚骰';
    const { kept, dropped } = poolSplit(term, chunk);
    const keptText = kept.join('+');
    text = kept.length > 1 ? `(${keptText})` : keptText;
    if (dropped.length > 0) text += `[${label}:${dropped.join(' ')}]`;
  } else {
    const values = keptValues(term, chunk);
    text = values.join('+');
    const needsParens =
      values.length > 1 &&
      (termCount > 1 || term.multiplier !== 1 || term.divisor !== 1 || term.sign < 0);
    if (needsParens) text = `(${text})`;
  }
  if (term.multiplier !== 1) text += `×${term.multiplier}`;
  if (term.divisor !== 1) text += `/${term.divisor}`;
  return text;
}

interface RoundRender {
  detail: string;
  combined: string;
}

function renderRound(
  parsed: ParsedExpression,
  groups: DieGroup[],
  roundIndex: number,
  fallbackTotal: number,
): RoundRender {
  const detail: string[] = [];
  const combined: string[] = [];
  const termCount = parsed.terms.length;
  let groupIndex = 0;

  parsed.terms.forEach((term: Term, index) => {
    const sign = term.sign < 0 ? '-' : index > 0 ? '+' : '';
    if (!isDiceTerm(term)) {
      detail.push(`${sign}${term.text}`);
      combined.push(`${sign}${Math.trunc((term.value * term.multiplier) / term.divisor)}`);
      return;
    }
    const group = groups[groupIndex];
    groupIndex++;
    const count = perRoundCount(term);
    const values = group?.values ?? [];
    const chunk = values.slice(roundIndex * count, (roundIndex + 1) * count);
    detail.push(`${sign}${displayOf(term, chunk, termCount)}`);
    const contribution = Math.trunc((contributionOf(term, chunk) * term.multiplier) / term.divisor);
    combined.push(`${sign}${contribution}`);
  });

  void fallbackTotal;
  return { detail: detail.join(''), combined: combined.join('') };
}

/** Render a roll result for chat. Never throws. */
export function renderRoll(result: RollResult, opts?: { compact?: boolean }): string {
  if (!result.ok) return result.error;
  const compact = opts?.compact === true;
  const expression = result.expression;
  const singleRound = `${expression === '' ? '' : `${expression}=`}${result.total}`;

  const parsed = parseExpression(expression);
  if (!parsed.ok) return singleRound;
  const diceTermCount = parsed.value.terms.filter(isDiceTerm).length;
  if (diceTermCount !== result.groups.length) return singleRound;
  if (result.rounds !== parsed.value.rounds) return singleRound;
  if (result.totals.length !== result.rounds) return singleRound;

  if (result.rounds <= 1) {
    if (compact) return singleRound;
    const round = renderRound(parsed.value, result.groups, 0, result.totals[0] ?? result.total);
    return dedupJoin([expression, round.detail, round.combined, String(result.totals[0] ?? result.total)]);
  }

  if (compact) {
    return `${expression}=${result.totals.join('+')}=${result.total}`;
  }

  const rounds = result.totals.map((total, index) => {
    const round = renderRound(parsed.value as ParsedExpression, result.groups, index, total);
    return dedupJoin([round.detail, round.combined, String(total)]);
  });
  return `${expression}={ ${rounds.join('; ')} }=${result.total}`;
}
