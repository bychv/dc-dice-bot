/**
 * `/sc` 理智检定（整行原文解析）。
 *
 * 依据 docs/Discord_CoC_Command_Set.md §9.1 与 ref/Dice/Dice/DiceEvent.cpp `pref2 == "sc"`
 * （第 3843-3948 行）：
 * - `成功损失/失败损失`，两侧为常量或骰式；
 * - 结尾数字 = 当前 san，省略时读卡（`理智`/`san`）；结尾非数字串 = 理由；
 * - 成功类等级（大成功/极难/困难/成功）扣成功损失，失败扣失败损失；
 * - 大失败按房规判定后「失去最大 san 值」（ref `RD::Max()`）；
 * - 支持 `-1d6` 这类回复 san 的写法；
 * - 读卡时把剩余 san 回写（不可变更新）。
 */
import type { SanityOptions, SanityResult, SanityRound } from '../contracts/coc.ts';
import type { CharacterSheet } from '../contracts/model.ts';
import type { DiceEngine } from '../contracts/dice.ts';
import { findAttrValue } from './attrs.ts';
import { evalExpr, maxOfExpr } from './expr.ts';
import { successLevel } from './houseRule.ts';

function toInt(value: string): number | null {
  const text = (value ?? '').trim();
  return /^[+-]?\d+$/.test(text) ? Number.parseInt(text, 10) : null;
}

/** `.sc` 主入口。 */
export function runSanity(dice: DiceEngine, text: string, opts: SanityOptions): SanityResult {
  const source = (text ?? '').trim();
  if (!source) return { ok: false, error: '请提供理智损失，例如：0/1 70' };

  const spaceAt = source.search(/\s/);
  const cost = spaceAt < 0 ? source : source.slice(0, spaceAt);
  const tail = spaceAt < 0 ? '' : source.slice(spaceAt).trim();

  const slash = cost.indexOf('/');
  if (slash < 0) return { ok: false, error: '理智损失格式应为 成功损失/失败损失，例如：0/1、1d10/1d100' };
  const successExpr = cost.slice(0, slash).trim();
  const failExpr = cost.slice(slash + 1).trim();
  if (!successExpr || !failExpr) {
    return { ok: false, error: '理智损失格式应为 成功损失/失败损失，例如：0/1、1d10/1d100' };
  }
  for (const part of [successExpr, failExpr]) {
    if (!/^[0-9dD+\-]+$/.test(part)) {
      return { ok: false, error: `理智损失只能是常量或骰式：${part}` };
    }
  }

  let sanFromText: number | null = null;
  let reason = '';
  if (tail) {
    const match = /^(\d+)(?:\s+([\s\S]*))?$/.exec(tail);
    if (match) {
      sanFromText = Number.parseInt(match[1], 10);
      reason = (match[2] ?? '').trim();
    } else {
      reason = tail;
    }
  }
  const cardAttr = findAttrValue(opts.sheet, '理智');
  let san: number | null = sanFromText;
  if (san === null && typeof opts.sanOverride === 'number') san = opts.sanOverride;
  if (san === null && cardAttr) san = toInt(cardAttr.value);
  if (san === null) {
    return {
      ok: false,
      error: '缺少当前理智值：请在指令后给出（如 /sc 0/1 70），或在角色卡中录入理智（san）',
    };
  }
  if (san <= 0) return { ok: false, error: `当前理智值 ${san} 无效（必须大于 0）` };

  const rolled = dice.percentile({}, opts.rng);
  if (!rolled.ok) return { ok: false, error: rolled.error };

  const level = successLevel(rolled.value, san, opts.rule);
  let loss: number;
  if (level === '大失败') {
    const max = maxOfExpr(dice, failExpr);
    if (max === null) return { ok: false, error: `无法计算最大理智损失：${failExpr}` };
    loss = max;
  } else {
    const evaluated = evalExpr(dice, level === '失败' ? failExpr : successExpr, opts.rng);
    if (!evaluated.ok) return { ok: false, error: evaluated.error };
    loss = evaluated.total;
  }
  const sanAfter = Math.max(0, san - loss);

  const details: SanityRound[] = [{ roll: rolled.value, level, loss, sanAfter }];

  const deltaText = loss >= 0 ? `-${loss}` : `+${-loss}`;
  const reasonText = reason ? ` ｜${reason}` : '';
  const lines = [
    `理智检定 D100=${rolled.value}/${san} → ${level}，理智变化 ${deltaText}；理智 ${san}→${sanAfter}（房规${opts.rule}）${reasonText}`,
  ];

  let sheet: CharacterSheet | undefined;
  if (opts.sheet && sanAfter !== san) {
    const key = cardAttr ? cardAttr.key : '理智';
    sheet = {
      ...opts.sheet,
      attrs: { ...opts.sheet.attrs, [key]: String(sanAfter) },
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    ok: true,
    rule: opts.rule,
    rounds: 1,
    details,
    sanBefore: san,
    sanAfter,
    lines,
    reason: reason || undefined,
    sheet,
  };
}
