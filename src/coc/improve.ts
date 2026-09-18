/**
 * `/en` 成长检定（整行原文解析）。
 *
 * 依据 docs/Discord_CoC_Command_Set.md §9.3 与 ref/Dice/Dice/DiceEvent.cpp `pref2 == "en"`
 * （第 3097-3178 行）：
 * - `技能名 [技能值] [成长表达式] [理由]`；
 * - 技能值省略时读卡，缺卡可用 `valueOverride`；
 * - 成长表达式形如 `+1D3/1D10`：斜杠前为「成长检定失败」时的成长，斜杠后为成功时的成长；
 *   只写 `/` 前一段时（如 `+1D6`）失败不成长；省略时默认成功成长 `1D10`；
 * - 成长检定失败条件：`骰值 <= 技能值 && 骰值 <= 95`（即 96+ 必定成长）；
 * - 成功成长后回写技能值（不可变更新）。
 */
import type { ImproveOptions, ImproveResult } from '../contracts/coc.ts';
import type { CharacterSheet } from '../contracts/model.ts';
import type { DiceEngine } from '../contracts/dice.ts';
import { canonicalAttr, findAttrValue } from './attrs.ts';
import { evalExpr } from './expr.ts';

const DEFAULT_GROWTH = '1D10';

function toInt(value: string): number | null {
  const text = (value ?? '').trim();
  return /^[+-]?\d+$/.test(text) ? Number.parseInt(text, 10) : null;
}

/** `/en` 主入口。 */
export function runImprove(dice: DiceEngine, text: string, opts: ImproveOptions): ImproveResult {
  const source = (text ?? '').trim();
  if (!source) return { ok: false, error: '请提供技能名，例如：教育' };

  let cursor = 0;
  while (cursor < source.length && !/[\d=:+\-*/\s]/.test(source[cursor])) cursor++;
  const rawName = source.slice(0, cursor).trim();
  if (!rawName) return { ok: false, error: `无法解析技能名：${source}` };
  const skillName = canonicalAttr(rawName);
  let tail = source.slice(cursor).replace(/^\s+/, '');

  let explicit: number | null = null;
  const valueMatch = /^(\d+)/.exec(tail);
  if (valueMatch) {
    if (valueMatch[1].length > 3) return { ok: false, error: `技能值「${valueMatch[1]}」超出范围（最多 3 位）` };
    explicit = Number.parseInt(valueMatch[1], 10);
    tail = tail.slice(valueMatch[0].length);
    tail = tail.replace(/^\s+/, '');
  }

  let growth = '';
  if (tail.startsWith('+') || tail.startsWith('-')) {
    const tokenMatch = /^\S+/.exec(tail);
    growth = tokenMatch ? tokenMatch[0] : '';
    tail = tail.slice(growth.length).trim();
  }
  const reason = tail.trim();

  let failExpr = '';
  let successExpr = growth || DEFAULT_GROWTH;
  const growthSlash = growth.indexOf('/');
  if (growthSlash >= 0) {
    failExpr = growth.slice(0, growthSlash).trim();
    successExpr = growth.slice(growthSlash + 1).trim();
  }
  if (!successExpr) return { ok: false, error: `成长表达式无效：${growth}` };

  const cardAttr = findAttrValue(opts.sheet, rawName);
  let before: number | null = explicit;
  if (before === null && typeof opts.valueOverride === 'number') before = opts.valueOverride;
  if (before === null && cardAttr) before = toInt(cardAttr.value);
  if (before === null) {
    return {
      ok: false,
      error: `缺少技能值：请在指令后给出（如 /en ${rawName} 60），或在角色卡中录入 ${skillName}`,
    };
  }

  const rolled = dice.percentile({}, opts.rng);
  if (!rolled.ok) return { ok: false, error: rolled.error };
  const failed = rolled.value <= before && rolled.value <= 95;

  let gained = 0;
  if (failed) {
    if (failExpr) {
      const evaluated = evalExpr(dice, failExpr, opts.rng);
      if (!evaluated.ok) return { ok: false, error: evaluated.error };
      gained = evaluated.total;
    }
  } else {
    const evaluated = evalExpr(dice, successExpr, opts.rng);
    if (!evaluated.ok) return { ok: false, error: evaluated.error };
    gained = evaluated.total;
  }
  const after = before + gained;

  const reasonText = reason ? ` ｜${reason}` : '';
  const lines = failed
    ? gained === 0
      ? [`${skillName} 成长检定 D100=${rolled.value}/${before} → 失败（本次不成长）${reasonText}`]
      : [
          `${skillName} 成长检定 D100=${rolled.value}/${before} → 失败，成长 ${gained >= 0 ? '+' : ''}${gained}；${skillName} ${before}→${after}${reasonText}`,
        ]
    : [
        `${skillName} 成长检定 D100=${rolled.value}/${before} → 成功，成长 ${gained >= 0 ? '+' : ''}${gained}；${skillName} ${before}→${after}${reasonText}`,
      ];

  let sheet: CharacterSheet | undefined;
  if (opts.sheet) {
    const key = cardAttr ? cardAttr.key : skillName;
    sheet = {
      ...opts.sheet,
      attrs: { ...opts.sheet.attrs, [key]: String(after) },
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    ok: true,
    skillName,
    before,
    roll: rolled.value,
    gained,
    after,
    lines,
    reason: reason || undefined,
    sheet,
  };
}
