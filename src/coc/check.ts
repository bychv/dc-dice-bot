/**
 * `/rc` `/ra` 属性/技能检定（整行原文解析）。
 *
 * 依据 docs/Discord_CoC_Command_Set.md §7.1 与 ref/Dice/Dice/DiceEvent.cpp
 * `pref2 == "ra" || pref2 == "rc"`（第 3538-3783 行）：
 * - `[轮数]#` 前缀（§7：上限 9）；
 * - `b[个数]` / `p[个数]` 奖励骰 / 惩罚骰（各至多 9 个）；
 * - 技能名开头的 `困难` / `极难` / `自动成功`（另兼容 ref 的 `极限`、`简单`）；
 * - 名字后的数字 = 成功率，省略时读卡；
 * - 名字中的 `+ - * /` 修正，顺序「乘法 > 加减 > 除法」；
 * - 修正后成功率必须 1-1000。
 *
 * 最终公式与 ref 第 3692 行一致（C++ 整型从左到右截断）：
 *   ((基础值 * 乘法 + 加减) * 简单倍率) / 除法 / 难度除数
 */
import type { CheckOptions, CheckResult, CheckRound, CocFailure, ParsedCheck } from '../contracts/coc.ts';
import type { DiceEngine } from '../contracts/dice.ts';
import { canonicalAttr, findAttrValue } from './attrs.ts';
import { successLevel } from './houseRule.ts';

/** 内部解析结果；`easy`（简单）在公开的 `ParsedCheck.difficulty` 中无法表达，归入 `normal`。 */
export interface ParsedCheckText {
  ok: true;
  /** 归一化后的技能/属性名 */
  skillName: string;
  /** 原文中显式给出的基础成功率（乘加减除之前、难度除档之前），省略为 null */
  base: number | null;
  multiplier: number;
  addend: number;
  divisor: number;
  easy: boolean;
  difficulty: 'normal' | 'hard' | 'extreme' | 'auto';
  rounds: number;
  bonus: number;
  penalty: number;
  reason: string;
}

export type ParsedCheckTextResult = ParsedCheckText | CocFailure;

function toInt(value: string): number | null {
  const text = (value ?? '').trim();
  if (!/^[+-]?\d+$/.test(text)) return null;
  return Number.parseInt(text, 10);
}

/** 解析 `/rc` 参数串（不含掷骰）；供 `check` 与 `parseCheck` 共用。 */
export function parseCheckText(text: string): ParsedCheckTextResult {
  const source = (text ?? '').trim();
  if (!source) return { ok: false, error: '请提供技能名，例如：侦察' };
  let rest = source;

  let rounds = 1;
  const roundsMatch = /^(\d{1,2})#/.exec(rest);
  if (roundsMatch) {
    rounds = Number.parseInt(roundsMatch[1], 10);
    if (rounds < 1 || rounds > 9) return { ok: false, error: '检定轮数必须为 1-9' };
    rest = rest.slice(roundsMatch[0].length).trim();
  } else if (rest.startsWith('#')) {
    // 只有 `#` 没有轮数（ref 第 3561 行 `intMsgCnt++`）——按 1 轮处理。
    rest = rest.slice(1).trim();
  }

  let bonus = 0;
  let penalty = 0;
  const bpMatch = /^([bp])(\d+)?(?=\s|$)/i.exec(rest);
  if (bpMatch) {
    const count = bpMatch[2] ? Number.parseInt(bpMatch[2], 10) : 1;
    if (count > 9) return { ok: false, error: '奖励骰/惩罚骰至多 9 个' };
    if (bpMatch[1].toLowerCase() === 'b') bonus = count;
    else penalty = count;
    rest = rest.slice(bpMatch[0].length).trim();
  }

  let difficulty: ParsedCheckText['difficulty'] = 'normal';
  let easy = false;
  if (rest.startsWith('自动成功')) {
    difficulty = 'auto';
    rest = rest.slice(4).trim();
  } else if (rest.startsWith('极难') || rest.startsWith('极限')) {
    difficulty = 'extreme';
    rest = rest.slice(2).trim();
  } else if (rest.startsWith('困难')) {
    difficulty = 'hard';
    rest = rest.slice(2).trim();
  } else if (rest.startsWith('简单')) {
    easy = true;
    rest = rest.slice(2).trim();
  }
  if (!rest) return { ok: false, error: `请提供技能名：${source}` };

  let cursor = 0;
  while (cursor < rest.length && !/[\d=:+\-*/\s]/.test(rest[cursor])) cursor++;
  const rawName = rest.slice(0, cursor).trim();
  if (!rawName) return { ok: false, error: `无法解析技能名：${source}` };
  let tail = rest.slice(cursor).replace(/^\s+/, '');

  let multiplier = 1;
  let addend = 0;
  let divisor = 1;

  const multiplyMatch = /^\*\s*(\d+)/.exec(tail);
  if (multiplyMatch) {
    multiplier = Number.parseInt(multiplyMatch[1], 10);
    tail = tail.slice(multiplyMatch[0].length);
  }
  for (;;) {
    const addMatch = /^([+-])\s*(\d+)/.exec(tail);
    if (!addMatch) break;
    addend += (addMatch[1] === '-' ? -1 : 1) * Number.parseInt(addMatch[2], 10);
    tail = tail.slice(addMatch[0].length);
  }
  const divideMatch = /^\/\s*(\d+)/.exec(tail);
  if (divideMatch) {
    divisor = Number.parseInt(divideMatch[1], 10);
    if (divisor === 0) return { ok: false, error: '除数不能为 0' };
    tail = tail.slice(divideMatch[0].length);
  }

  tail = tail.replace(/^[\s=:]+/, '');
  let base: number | null = null;
  const valueMatch = /^(\d+)/.exec(tail);
  if (valueMatch) {
    base = Number.parseInt(valueMatch[1], 10);
    tail = tail.slice(valueMatch[0].length);
  }

  return {
    ok: true,
    skillName: canonicalAttr(rawName),
    base,
    multiplier,
    addend,
    divisor,
    easy,
    difficulty,
    rounds,
    bonus,
    penalty,
    reason: tail.trim(),
  };
}

/** 原文显式成功率：乘 > 加减 > 除（不含难度档）。 */
function textTarget(parsed: ParsedCheckText): number | null {
  if (parsed.base === null) return null;
  return Math.trunc(Math.trunc(parsed.base * parsed.multiplier + parsed.addend) / parsed.divisor);
}

function difficultyDivisor(difficulty: ParsedCheckText['difficulty']): number {
  if (difficulty === 'hard') return 2;
  if (difficulty === 'extreme') return 5;
  return 1;
}

/** `/rc` `/ra` 主入口。 */
export function runCheck(dice: DiceEngine, text: string, opts: CheckOptions): CheckResult {
  const parsed = parseCheckText(text);
  if (!parsed.ok) return parsed;

  let base = parsed.base;
  if (base === null) {
    const found = findAttrValue(opts.sheet, parsed.skillName);
    if (!found) {
      return {
        ok: false,
        error: `无法确定「${parsed.skillName}」的成功率：角色卡中没有该属性，请在指令中给出成功率`,
      };
    }
    const value = toInt(found.value);
    if (value === null) {
      return { ok: false, error: `属性「${found.key}」的值「${found.value}」不是数字` };
    }
    base = value;
  }

  let target = Math.trunc(base * parsed.multiplier + parsed.addend);
  if (parsed.easy) target *= 2;
  target = Math.trunc(target / parsed.divisor);
  target = Math.trunc(target / difficultyDivisor(parsed.difficulty));
  if (target < 1 || target > 1000) {
    return { ok: false, error: `修正后成功率 ${target} 必须在 1-1000 之间` };
  }

  const details: CheckRound[] = [];
  for (let round = 0; round < parsed.rounds; round++) {
    const rolled = dice.percentile({ bonus: parsed.bonus, penalty: parsed.penalty }, opts.rng);
    if (!rolled.ok) return { ok: false, error: rolled.error };
    let level = successLevel(rolled.value, target, opts.rule);
    if (parsed.difficulty === 'auto' && level === '失败') level = '成功';
    details.push({ roll: rolled.value, target, level });
  }

  const tags: string[] = [];
  if (parsed.difficulty === 'hard') tags.push('困难');
  else if (parsed.difficulty === 'extreme') tags.push('极难');
  else if (parsed.difficulty === 'auto') tags.push('自动成功');
  else if (parsed.easy) tags.push('简单');
  if (parsed.bonus > 0) tags.push(`奖励骰×${parsed.bonus}`);
  if (parsed.penalty > 0) tags.push(`惩罚骰×${parsed.penalty}`);
  tags.push(`房规${opts.rule}`);
  const reasonText = parsed.reason ? ` ｜${parsed.reason}` : '';

  const first = details[0];
  const lines =
    parsed.rounds === 1
      ? [`${parsed.skillName} 检定 D100=${first.roll}/${target} → ${first.level}（${tags.join('，')}）${reasonText}`]
      : [
          `${parsed.skillName} 检定 ×${parsed.rounds}（${tags.join('，')}）${reasonText}`,
          ...details.map((detail, index) => `${index + 1}. D100=${detail.roll}/${target} → ${detail.level}`),
        ];

  return {
    ok: true,
    skillName: parsed.skillName,
    target,
    rule: opts.rule,
    rounds: parsed.rounds,
    details,
    lines,
    reason: parsed.reason || undefined,
  };
}

/** 不掷骰的解析（测试 / autocomplete 用）。 */
export function parseCheck(text: string): ParsedCheck | CocFailure {
  const parsed = parseCheckText(text);
  if (!parsed.ok) return parsed;
  return {
    skillName: parsed.skillName,
    target: textTarget(parsed),
    rounds: parsed.rounds,
    bonus: parsed.bonus,
    penalty: parsed.penalty,
    difficulty: parsed.difficulty,
  };
}
