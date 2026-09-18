/**
 * `/r` `/rs` 表达式来源解析。
 *
 * 依据 docs/Discord_CoC_Command_Set.md §4.1：「首个参数不是数字/骰式时，视为角色卡中保存的
 * 表达式名或技能名」；ref/Dice/Dice/CharacterCard.cpp `CharaCard::getExp` / `cal`
 * （第 311-343 行）负责把名字换成表达式/数值。
 *
 * - `沙漠之鹰` → `/st &沙漠之鹰=1D10+1D6+3` 保存的表达式；
 * - `hp` → 角色卡属性数值（如 `12`）；
 * - 原文本身就是骰式（`1d6`、`3#1d6`、`b2`…）→ 返回 null，交由 DiceEngine 处理。
 */
import type { CharacterSheet } from '../contracts/model.ts';
import { findAttrValue, findExpr, stripCardPrefix } from './attrs.ts';
import { constValue } from './expr.ts';

/** 原文本身看起来就是骰式/次数前缀时为 true。 */
export function isRawRollToken(token: string): boolean {
  if (/^\d/.test(token)) return true;
  if (/^[dD]\d+$/.test(token)) return true;
  if (/^[bpBP]\d*$/.test(token)) return true;
  return false;
}

function looksLikeExpression(value: string): boolean {
  return /^[dD]\d/.test(value) || /\d[dD]\d/.test(value) || /^\d{1,2}#/.test(value);
}

/** 把「名字」映射为可交给 DiceEngine 的表达式；无法映射返回 null。 */
export function resolveRollExpression(sheet: CharacterSheet | null, text: string): string | null {
  const source = (text ?? '').trim();
  if (!source || !sheet) return null;

  let prefix = '';
  let rest = source;
  const roundsMatch = /^(\d{1,2})#\s*/.exec(rest);
  if (roundsMatch) {
    prefix = `${roundsMatch[1]}#`;
    rest = rest.slice(roundsMatch[0].length).trim();
  }
  const first = rest.split(/\s+/)[0] ?? '';
  const token = stripCardPrefix(first);
  if (!token) return null;
  if (isRawRollToken(token)) return null;

  const expr = findExpr(sheet, token);
  if (expr) return prefix + expr.expr;

  const attr = findAttrValue(sheet, token);
  if (attr) {
    const value = attr.value.trim();
    if (constValue(value) !== null) return prefix + value;
    if (looksLikeExpression(value)) return prefix + value;
  }
  return null;
}
