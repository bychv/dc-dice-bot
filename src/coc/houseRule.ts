/**
 * 检定房规 0-6 的成功等级判定。
 *
 * 依据（逐条对齐 docs/Discord_CoC_Command_Set.md §8.1 房规表，该表与 docs/User_Manual.md
 * 第 259-284 行 `.setcoc` 原文一致）：
 *
 * | 房规 | 大成功 | 大失败 |
 * | 0 规则书 | 出 1 | 不满50出96-100；满50出100 |
 * | 1 | 不满50出1；满50出1-5 | 不满50出96-100；满50出100 |
 * | 2 | 出1-5且<=成功率 | 出100，或出96-99且>成功率 |
 * | 3 | 出1-5 | 出96-100 |
 * | 4 | 出1-5且<=成功率/10 | 不满50出>=96+成功率/10；满50出100 |
 * | 5 | 出1-2且<成功率/5 | 不满50出96-100；满50出99-100 |
 * | 6 | 个位数=十位数且<=成功率（特例：出1必为大成功） | 个位数=十位数且>成功率（特例：出100必为大失败） |
 *
 * 其余档位（极难=成功率/5，困难=成功率/2）沿用规则书，见 ref/Dice/Dice/RD.cpp
 * `RollSuccessLevel`（第 1106-1188 行）。房规 6 与 ref 一致地不再区分极难/困难档。
 *
 * 已裁决的两处 ref/手册差异：
 * - 房规 5 大成功：§8.1 表格与手册 `.setcoc` 文案均写「<成功率/5」；ref RD.cpp:1156 的
 *   `/10` 与它自身文案矛盾（ref bug），不采纳 —— 本实现取 rate/5。
 * - 房规 6 特例：表格字面覆盖不了 1 / 100 两个边界，按 ref 补全为「出 1 必为大成功、
 *   出 100 必为大失败」（docs §8.1 第 356、359 行已写明确）。
 */
import type { HouseRule, SuccessLevel } from '../contracts/model.ts';

/** 个位数 = 十位数（含 100 视为 `00`）。 */
export function isDoubles(roll: number): boolean {
  if (roll === 100) return true;
  return roll >= 11 && roll <= 99 && roll % 11 === 0;
}

function tier(roll: number, rate: number): SuccessLevel {
  if (roll <= Math.floor(rate / 5)) return '极难成功';
  if (roll <= Math.floor(rate / 2)) return '困难成功';
  if (roll <= rate) return '成功';
  return '失败';
}

export function successLevel(roll: number, rate: number, rule: HouseRule): SuccessLevel {
  switch (rule) {
    case 0: {
      if (roll === 1) return '大成功';
      if (rate < 50 ? roll >= 96 : roll === 100) return '大失败';
      return tier(roll, rate);
    }
    case 1: {
      if (roll === 1 || (rate >= 50 && roll <= 5)) return '大成功';
      if (rate < 50 ? roll >= 96 : roll === 100) return '大失败';
      return tier(roll, rate);
    }
    case 2: {
      if (roll === 100) return '大失败';
      if (roll <= 5 && roll <= rate) return '大成功';
      if (roll > rate) return roll >= 96 ? '大失败' : '失败';
      return tier(roll, rate);
    }
    case 3: {
      if (roll >= 96) return '大失败';
      if (roll <= 5) return '大成功';
      return tier(roll, rate);
    }
    case 4: {
      const tenth = Math.floor(rate / 10);
      if (roll <= 5 && roll <= tenth) return '大成功';
      if (rate < 50 ? roll >= 96 + tenth : roll === 100) return '大失败';
      return tier(roll, rate);
    }
    case 5: {
      if (roll <= 2 && roll < Math.floor(rate / 5)) return '大成功';
      if (rate < 50 ? roll >= 96 : roll >= 99) return '大失败';
      return tier(roll, rate);
    }
    case 6: {
      // 特例（docs §8.1 第 356、359 行，取自 ref RD.cpp:1170/1165）：1 必大成功、100 必大失败。
      if (roll === 1) return '大成功';
      if (roll === 100) return '大失败';
      if (isDoubles(roll)) return roll > rate ? '大失败' : '大成功';
      return roll <= rate ? '成功' : '失败';
    }
  }
}
