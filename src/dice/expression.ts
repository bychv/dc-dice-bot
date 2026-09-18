/**
 * Internal dice-expression parser / normalizer (owner: `src/dice/**`).
 *
 * Aligned with the reference implementation `ref/Dice/Dice/RD.cpp`
 * (`RD::RD` normalizing constructor + `RD::RollDice`) and
 * `docs/Discord_CoC_Command_Set.md` §4.1:
 *
 *   ([轮数]#)([个数]d[面数])(b[奖励骰]|p[惩罚骰])(k[取大])  + 算术项
 *
 * Ranges: 轮数 1-10, 个数 1-100, 面数 1-1000, 奖励/惩罚骰 0-9.
 * `b`/`p` 有两种形态：单独的 `bN`/`pN` 或 `1d100bN` 是**百面骰十位骰**（CoC 奖惩骰）；
 * 非百面骰的 `XdYbN`/`XdYpN` 是**额外掷 N 个同面数骰**，奖励取最大、惩罚取最小（docs §4.1）。
 * `X` / `*` are both the multiplication sign, `/` is allowed as a constant divisor
 * (RD.cpp keeps `+ - X /` semantics).
 *
 * This module never throws: every failure is returned as `{ ok: false, error }`.
 */

/** A dice term (`3d6`, `3d6k2`, `b2`, `p`, `1d100b2`, `1d10b2`, `3d6X5`, `3d6/2`). */
export interface DiceTerm {
  kind: 'dice';
  sign: 1 | -1;
  /** dice count for plain terms; bonus/penalty dice count for percentile terms */
  count: number;
  /** 1-1000; always 100 for percentile (b/p) terms */
  sides: number;
  /** k: how many highest values are kept */
  keep?: number;
  /** b: extra dice count — percentile tens dice when `sides === 100`, otherwise extra same-type dice */
  bonus?: number;
  /** p: extra dice count — percentile tens dice when `sides === 100`, otherwise extra same-type dice */
  penalty?: number;
  /** constant multiplier (`X`/`*`), 1 when absent */
  multiplier: number;
  /** constant divisor (`/`), 1 when absent */
  divisor: number;
  /** normalized text without the leading sign, e.g. `3d6k2`, `b2` */
  text: string;
}

/** A bare constant term (`2`, `2X3`). */
export interface ConstTerm {
  kind: 'const';
  sign: 1 | -1;
  value: number;
  multiplier: number;
  divisor: number;
  text: string;
}

export type Term = DiceTerm | ConstTerm;

export interface ParsedExpression {
  /** 1-10 */
  rounds: number;
  /** normalized expression, e.g. `3d6k2`, `3#1d6`, `1d10+1d6+3`, `b2` */
  expression: string;
  terms: Term[];
  /** signed sum of the constant terms, already folded (informational) */
  modifier: number;
}

export type ParsedExpressionResult =
  | { ok: true; value: ParsedExpression }
  | { ok: false; error: string };

function failure(error: string): ParsedExpressionResult {
  return { ok: false, error };
}

export function isDiceTerm(term: Term): term is DiceTerm {
  return term.kind === 'dice';
}

function diceText(
  count: number,
  sides: number,
  keep: number | undefined,
  multiplier: number,
  divisor: number,
): string {
  let text = `${count}d${sides}`;
  if (keep !== undefined) text += `k${keep}`;
  if (multiplier !== 1) text += `X${multiplier}`;
  if (divisor !== 1) text += `/${divisor}`;
  return text;
}

function percentileText(
  flag: 'b' | 'p',
  count: number,
  multiplier: number,
  divisor: number,
): string {
  let text = `${flag}${count}`;
  if (multiplier !== 1) text += `X${multiplier}`;
  if (divisor !== 1) text += `/${divisor}`;
  return text;
}

/** Split the trailing constant `X`/`*` multiplier and `/` divisor off a term. */
function parseScale(
  text: string,
): { ok: true; core: string; multiplier: number; divisor: number } | { ok: false; error: string } {
  let core = text;
  let multiplier = 1;
  let divisor = 1;

  let index = core.lastIndexOf('/');
  while (index >= 0) {
    const rhs = core.slice(index + 1);
    if (!/^\d+$/.test(rhs)) return { ok: false, error: `除数必须为正整数（输入：${text}）` };
    const value = Number(rhs);
    if (value === 0) return { ok: false, error: `除数不能为 0（输入：${text}）` };
    if (value > 100000) return { ok: false, error: `除数过大（输入：${text}）` };
    divisor *= value;
    core = core.slice(0, index);
    index = core.lastIndexOf('/');
  }

  index = core.lastIndexOf('X');
  while (index >= 0) {
    const rhs = core.slice(index + 1);
    if (!/^\d+$/.test(rhs)) return { ok: false, error: `乘数必须为非负整数（输入：${text}）` };
    const value = Number(rhs);
    if (value > 100000) return { ok: false, error: `乘数过大（输入：${text}）` };
    multiplier *= value;
    core = core.slice(0, index);
    index = core.lastIndexOf('X');
  }

  if (core === '') return { ok: false, error: `无法解析的掷骰表达式：${text}` };
  if (multiplier > 1000000000 || divisor > 1000000000) {
    return { ok: false, error: `乘数/除数过大（输入：${text}）` };
  }
  return { ok: true, core, multiplier, divisor };
}

function ranged(
  label: string,
  value: number,
  min: number,
  max: number,
  source: string,
): string | undefined {
  if (!Number.isInteger(value) || value < min || value > max) {
    return `${label}必须在 ${min}-${max} 之间（输入：${source}）`;
  }
  return undefined;
}

/** Parse one term (sign is applied by the caller). */
function parseTerm(
  text: string,
): { ok: true; term: DiceTerm | ConstTerm } | { ok: false; error: string } {
  const scaled = parseScale(text);
  if (!scaled.ok) return scaled;
  const { core, multiplier, divisor } = scaled;

  const makeDice = (
    count: number,
    sides: number,
    keep: number | undefined,
    bonus: number | undefined,
    penalty: number | undefined,
    termText: string,
  ): DiceTerm => {
    const term: DiceTerm = { kind: 'dice', sign: 1, count, sides, multiplier, divisor, text: termText };
    if (keep !== undefined) term.keep = keep;
    if (bonus !== undefined) term.bonus = bonus;
    if (penalty !== undefined) term.penalty = penalty;
    return term;
  };

  // bare constant, e.g. `2`, `003`
  if (/^\d+$/.test(core)) {
    if (core.length > 5) return { ok: false, error: `常量数值过大（输入：${text}）` };
    const value = Number(core);
    let constText = String(value);
    if (multiplier !== 1) constText += `X${multiplier}`;
    if (divisor !== 1) constText += `/${divisor}`;
    return { ok: true, term: { kind: 'const', sign: 1, value, multiplier, divisor, text: constText } };
  }

  // percentile: `b2`, `p`, `b0` (fixed d100 + 奖励/惩罚骰)
  let match = /^([bp])(\d*)$/.exec(core);
  if (match) {
    const count = match[2] === '' ? 1 : Number(match[2]);
    const error = ranged('奖励骰/惩罚骰数量', count, 0, 9, text);
    if (error) return { ok: false, error };
    const flag = match[1] as 'b' | 'p';
    const termText = percentileText(flag, count, multiplier, divisor);
    return {
      ok: true,
      term: flag === 'b'
        ? makeDice(count, 100, undefined, count, undefined, termText)
        : makeDice(count, 100, undefined, undefined, count, termText),
    };
  }

  // 百面骰 + 奖惩骰（percentile）: `1d100b2` / `d100p3`（固定 d100 only）；
  // 非百面骰的 `XdYbN` / `XdYpN` 走下面的「额外同面数骰」分支（`1d10b2` 等）。
  match = /^(\d*)d(\d+)([bp])(\d*)$/.exec(core);
  if (match) {
    const diceCount = match[1] === '' ? 1 : Number(match[1]);
    const sides = Number(match[2]);
    const count = match[4] === '' ? 1 : Number(match[4]);
    const error =
      ranged('骰子个数', diceCount, 1, 100, text) ?? ranged('骰子面数', sides, 1, 1000, text);
    if (error) return { ok: false, error };
    const flag = match[3] as 'b' | 'p';
    if (sides === 100) {
      if (diceCount !== 1) return { ok: false, error: `百面骰的奖惩骰只能配一个百面骰（输入：${text}）` };
      const bonusError = ranged('奖励骰/惩罚骰数量', count, 0, 9, text);
      if (bonusError) return { ok: false, error: bonusError };
      const termText = percentileText(flag, count, multiplier, divisor);
      return {
        ok: true,
        term: flag === 'b'
          ? makeDice(count, 100, undefined, count, undefined, termText)
          : makeDice(count, 100, undefined, undefined, count, termText),
      };
    }
    // 非百面骰：奖惩骰 = **额外掷 N 个同面数骰**，奖励取最大的 count 个、惩罚取最小的 count 个。
    // 例：`1d10b2` = 1d10 再补 2 个 d10，取最大那个（docs §4.1，Dice! 手册 §.r）。
    const bonusError = ranged('奖励骰/惩罚骰数量', count, 0, 9, text);
    if (bonusError) return { ok: false, error: bonusError };
    let termText = `${diceCount}d${sides}${flag}${count}`;
    if (multiplier !== 1) termText += `X${multiplier}`;
    if (divisor !== 1) termText += `/${divisor}`;
    return {
      ok: true,
      term: flag === 'b'
        ? makeDice(diceCount, sides, undefined, count, undefined, termText)
        : makeDice(diceCount, sides, undefined, undefined, count, termText),
    };
  }

  // keep-highest: `3d6k2`, `2dk2`, `3d6k`
  match = /^(\d*)d(\d*)k(\d*)$/.exec(core);
  if (match) {
    const count = match[1] === '' ? 1 : Number(match[1]);
    const sides = match[2] === '' ? 100 : Number(match[2]);
    const keep = match[3] === '' ? 1 : Number(match[3]);
    let error = ranged('骰子个数', count, 1, 100, text) ?? ranged('骰子面数', sides, 1, 1000, text);
    if (error) return { ok: false, error };
    if (!Number.isInteger(keep) || keep < 1 || keep > count) {
      return { ok: false, error: `取大数量必须在 1-${count} 之间（输入：${text}）` };
    }
    return { ok: true, term: makeDice(count, sides, keep, undefined, undefined, diceText(count, sides, keep, multiplier, divisor)) };
  }

  // plain dice: `3d6`, `d100`, `3d`, `d`
  match = /^(\d*)d(\d*)$/.exec(core);
  if (match) {
    const count = match[1] === '' ? 1 : Number(match[1]);
    const sides = match[2] === '' ? 100 : Number(match[2]);
    const error = ranged('骰子个数', count, 1, 100, text) ?? ranged('骰子面数', sides, 1, 1000, text);
    if (error) return { ok: false, error };
    return { ok: true, term: makeDice(count, sides, undefined, undefined, undefined, diceText(count, sides, undefined, multiplier, divisor)) };
  }

  return { ok: false, error: `无法解析的掷骰表达式：${text}` };
}

/**
 * Parse + normalize a full expression (including an optional leading `N#`).
 * Never throws.
 */
export function parseExpression(raw: string): ParsedExpressionResult {
  const source = typeof raw === 'string' ? raw : '';
  if (source.length > 300) return failure('掷骰表达式过长');
  const trimmed = source.trim();

  let rounds = 1;
  let body = trimmed;
  const hash = trimmed.indexOf('#');
  if (hash >= 0) {
    if (trimmed.indexOf('#', hash + 1) >= 0) return failure('掷骰表达式只能包含一个 #');
    const head = trimmed.slice(0, hash).trim();
    body = trimmed.slice(hash + 1).trim();
    if (head !== '') {
      if (!/^\d+$/.test(head)) {
        return failure(`无法解析的掷骰次数：${head}（请写成 次数#表达式，如 3#1d6）`);
      }
      const count = Number(head);
      if (!Number.isInteger(count) || count < 1 || count > 10) {
        return failure(`掷骰次数必须在 1-10 之间（输入：${head}）`);
      }
      rounds = count;
    }
  }

  // Normalize like RD::RD: case-insensitive, `*` == `x` == `X`, whitespace inside is dropped.
  body = body.replace(/[ \t]/g, '').toLowerCase().replace(/[x*]/g, 'X');

  const rawTerms: { sign: 1 | -1; text: string }[] = [];
  if (body === '') {
    // `.r` without an expression -> default 100-sided die (手册 §4.1)
    rawTerms.push({ sign: 1, text: 'd100' });
  } else {
    let sign: 1 | -1 = 1;
    let current = '';
    let started = false;
    for (const char of body) {
      if (char === '+' || char === '-') {
        const nextSign: 1 | -1 = char === '-' ? -1 : 1;
        if (current === '') {
          if (!started) {
            sign = nextSign;
            started = true;
          } else {
            // collapse consecutive operators the way RD::RD does (`+-` -> `-`, `--` -> `+`)
            sign = (sign * nextSign) as 1 | -1;
          }
          continue;
        }
        rawTerms.push({ sign, text: current });
        sign = nextSign;
        current = '';
        started = true;
        continue;
      }
      current += char;
      started = true;
    }
    if (current === '') {
      return failure(rawTerms.length === 0 ? '掷骰表达式为空' : '掷骰表达式不能以运算符结尾');
    }
    rawTerms.push({ sign, text: current });
  }

  const terms: Term[] = [];
  let expression = '';
  for (let i = 0; i < rawTerms.length; i++) {
    const entry = rawTerms[i] as { sign: 1 | -1; text: string };
    const parsed = parseTerm(entry.text);
    if (!parsed.ok) return failure(parsed.error);
    const term: Term = { ...parsed.term, sign: entry.sign };
    terms.push(term);
    if (i === 0) {
      if (term.sign < 0) expression += '-';
    } else {
      expression += term.sign < 0 ? '-' : '+';
    }
    expression += term.text;
  }

  let modifier = 0;
  for (const term of terms) {
    if (term.kind === 'const') {
      modifier += term.sign * Math.trunc((term.value * term.multiplier) / term.divisor);
    }
  }

  if (rounds > 1) expression = `${rounds}#${expression}`;

  return { ok: true, value: { rounds, expression, terms, modifier } };
}
