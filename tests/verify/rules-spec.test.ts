/**
 * T4 独立验证 · 房规 0-6 大成功/大失败边界 + 难度档
 *
 * 预期值表**独立转录自规格** docs/Discord_CoC_Command_Set.md §8.1（第 346-361 行），
 * 不引用实现者注释：
 *
 * | 房规 | 大成功 | 大失败 |
 * | 0 | 出 1 | 不满 50 出 96-100；满 50 出 100 |
 * | 1 | 不满 50 出 1；满 50 出 1-5 | 不满 50 出 96-100；满 50 出 100 |
 * | 2 | 出 1-5 且 <= 成功率 | 出 100，或出 96-99 且 > 成功率 |
 * | 3 | 出 1-5 | 出 96-100 |
 * | 4 | 出 1-5 且 <= 成功率/10 | 不满 50 出 >= 96+成功率/10；满 50 出 100 |
 * | 5 | 出 1-2 且 < 成功率/5 | 不满 50 出 96-100；满 50 出 99-100 |
 * | 6 | 个位=十位 且 <= 成功率（特例 1） | 个位=十位 且 > 成功率（特例 100） |
 *
 * 除档：极难 = 成功率/5，困难 = 成功率/2（§7.1 保留规则 / ref RD.cpp:1113-1115）。
 *
 * 除法口径：规格里的 `成功率/N` 一律按整数除法（floor）理解——依据是房规 4 的大失败
 * 「不满 50 出 >= 96+成功率/10」：若按实数除法，成功率 45-49 时阈值为 100.5-100.9，
 * d100 永远不可能大失败，明显不是原表本意；原实现 RD.cpp 亦全部为 C++ 整型除法。
 * 该口径的结论已写进 T4 报告（见 §"房规 5 的除法口径"）。
 *
 * Run: node tests/verify/rules-spec.test.ts
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { successLevel } from '../../src/coc/houseRule.ts';
import type { HouseRule, SuccessLevel } from '../../src/contracts/model.ts';

type Rule = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const isDoubles = (roll: number): boolean => roll >= 11 && roll <= 99 && roll % 11 === 0;

/** 独立 oracle：按 §8.1 字面表 + 整数除法推导的完整成功等级。 */
function oracle(roll: number, rate: number, rule: Rule): SuccessLevel {
  const fifth = Math.floor(rate / 5);
  const half = Math.floor(rate / 2);
  const tenth = Math.floor(rate / 10);
  const tier = (): SuccessLevel => {
    if (rule === 6) return roll <= rate ? '成功' : '失败';
    if (roll <= fifth) return '极难成功';
    if (roll <= half) return '困难成功';
    if (roll <= rate) return '成功';
    return '失败';
  };
  switch (rule) {
    case 0:
      if (roll === 1) return '大成功';
      if (rate < 50 ? roll >= 96 : roll === 100) return '大失败';
      return tier();
    case 1:
      if (rate < 50 ? roll === 1 : roll <= 5) return '大成功';
      if (rate < 50 ? roll >= 96 : roll === 100) return '大失败';
      return tier();
    case 2:
      if (roll === 100) return '大失败';
      if (roll <= 5 && roll <= rate) return '大成功';
      if (roll > rate) return roll >= 96 ? '大失败' : '失败';
      return tier();
    case 3:
      if (roll >= 96) return '大失败';
      if (roll <= 5) return '大成功';
      return tier();
    case 4:
      if (roll <= 5 && roll <= tenth) return '大成功';
      if (rate < 50 ? roll >= 96 + tenth : roll === 100) return '大失败';
      return tier();
    case 5:
      if (roll <= 2 && roll < fifth) return '大成功';
      if (rate < 50 ? roll >= 96 : roll >= 99) return '大失败';
      return tier();
    case 6:
      if (roll === 1) return '大成功';
      if (roll === 100) return '大失败';
      if (isDoubles(roll)) return roll > rate ? '大失败' : '大成功';
      return roll <= rate ? '成功' : '失败';
  }
}

const RATES = [1, 2, 4, 5, 9, 10, 11, 14, 15, 19, 20, 25, 30, 45, 48, 49, 50, 51, 55, 60, 75, 90, 95, 96, 99, 100, 150, 1000];

describe('T4 · 房规 0-6 全量边界（d100 1..100 × 多档成功率）', () => {
  for (const rule of [0, 1, 2, 3, 4, 5, 6] as Rule[]) {
    test(`房规 ${rule}：与 §8.1 独立 oracle 完全一致`, () => {
      const mismatches: string[] = [];
      for (const rate of RATES) {
        for (let roll = 1; roll <= 100; roll += 1) {
          const got = successLevel(roll, rate, rule as HouseRule);
          const want = oracle(roll, rate, rule);
          if (got !== want) mismatches.push(`roll=${roll} rate=${rate}: got ${got}, want ${want}`);
        }
      }
      assert.deepEqual(mismatches, [], `房规 ${rule} 共 ${mismatches.length} 处偏差`);
    });
  }
});

describe('T4 · 房规边界逐条构造（任务清单原文用例）', () => {
  const lv = (roll: number, rate: number, rule: Rule): SuccessLevel => successLevel(roll, rate, rule as HouseRule);

  test('房规 0：出 1 大成功；不满 50 出 96-100 大失败；满 50 只有 100 大失败', () => {
    assert.equal(lv(1, 30, 0), '大成功');
    assert.equal(lv(96, 30, 0), '大失败');
    assert.equal(lv(99, 30, 0), '大失败');
    assert.equal(lv(100, 30, 0), '大失败');
    assert.equal(lv(95, 30, 0), '失败');
    assert.equal(lv(99, 70, 0), '失败', '满 50 时 99 不是大失败');
    assert.equal(lv(100, 70, 0), '大失败');
    assert.equal(lv(96, 70, 0), '失败');
  });

  test('房规 1：不满 50 仅出 1；满 50 出 1-5；大失败同房规 0', () => {
    assert.equal(lv(1, 30, 1), '大成功');
    // 不满 50 时 2-5 只是普通成功档，落到极难（30/5=6）
    for (const roll of [2, 3, 4, 5]) assert.equal(lv(roll, 30, 1), '极难成功', `roll=${roll} rate=30 不应大成功`);
    for (const roll of [1, 2, 3, 4, 5]) assert.equal(lv(roll, 50, 1), '大成功', `roll=${roll} rate=50 应大成功`);
    assert.equal(lv(96, 30, 1), '大失败');
    assert.equal(lv(96, 80, 1), '失败');
    assert.equal(lv(100, 80, 1), '大失败');
  });

  test('房规 2：1-5 且 <= 成功率；100 或 96-99 且 > 成功率', () => {
    for (const roll of [1, 2, 3, 4, 5]) assert.equal(lv(roll, 5, 2), '大成功', `roll=${roll} rate=5`);
    assert.equal(lv(5, 4, 2), '失败', '5 > 4 不是大成功');
    assert.equal(lv(100, 90, 2), '大失败', '100 无条件大失败');
    assert.equal(lv(100, 1000, 2), '大失败', '100 即使是 1000% 也是大失败（表字面）');
    assert.equal(lv(99, 30, 2), '大失败', '96-99 且 > 成功率');
    assert.equal(lv(96, 30, 2), '大失败');
    assert.equal(lv(96, 99, 2), '成功', '96 <= 成功率时按成功档');
    assert.equal(lv(97, 99, 2), '成功');
    assert.equal(lv(99, 99, 2), '成功');
  });

  test('房规 3：1-5 大成功；96-100 大失败（与成功率无关）', () => {
    for (const roll of [1, 2, 3, 4, 5]) assert.equal(lv(roll, 1, 3), '大成功', `roll=${roll}`);
    assert.equal(lv(6, 1, 3), '失败');
    for (const roll of [96, 97, 98, 99, 100]) assert.equal(lv(roll, 1000, 3), '大失败', `roll=${roll}`);
  });

  test('房规 4：1-5 且 <= 成功率/10 大成功；不满 50 出 >=96+成功率/10；满 50 出 100', () => {
    assert.equal(lv(5, 50, 4), '大成功', '50/10 = 5');
    assert.equal(lv(5, 49, 4), '极难成功', '49/10 = 4 → 5 不是大成功');
    assert.equal(lv(4, 49, 4), '大成功');
    assert.equal(lv(1, 9, 4), '极难成功', '9/10 = 0 → 无大成功');
    assert.equal(lv(99, 30, 4), '大失败', '30<50，阈值 96+3=99');
    assert.equal(lv(98, 30, 4), '失败');
    assert.equal(lv(100, 40, 4), '大失败', '40<50，阈值 96+4=100');
    assert.equal(lv(99, 40, 4), '失败');
    assert.equal(lv(99, 50, 4), '失败', '满 50 只有 100 大失败');
    assert.equal(lv(100, 50, 4), '大失败');
  });

  test('房规 5：1-2 且 < 成功率/5；不满 50 出 96-100；满 50 出 99-100', () => {
    assert.equal(lv(1, 20, 5), '大成功', '20/5 = 4');
    assert.equal(lv(2, 20, 5), '大成功');
    assert.equal(lv(3, 20, 5), '极难成功');
    assert.equal(lv(1, 9, 5), '极难成功', '9/5 = 1 → roll<1 不可能（整数除法口径）');
    assert.equal(lv(1, 10, 5), '大成功', '10/5 = 2 → 1 < 2');
    assert.equal(lv(2, 10, 5), '极难成功', '2 < 2 为假');
    assert.equal(lv(1, 15, 5), '大成功');
    assert.equal(lv(2, 15, 5), '大成功');
    assert.equal(lv(96, 30, 5), '大失败');
    assert.equal(lv(100, 30, 5), '大失败');
    assert.equal(lv(98, 60, 5), '失败', '满 50 时 98 不是大失败');
    assert.equal(lv(99, 60, 5), '大失败');
    assert.equal(lv(100, 60, 5), '大失败');
  });

  test('房规 6：个位=十位；特例 1 大成功、100 大失败；无困难/极难档', () => {
    assert.equal(lv(1, 1, 6), '大成功', '特例：出 1');
    assert.equal(lv(100, 1, 6), '大失败', '特例：出 100');
    assert.equal(lv(100, 1000, 6), '大失败');
    for (const roll of [11, 22, 33, 44, 55, 66, 77, 88, 99]) {
      assert.equal(lv(roll, roll, 6), '大成功', `${roll} 是重数且 <= 成功率`);
      assert.equal(lv(roll, roll - 1, 6), '大失败', `${roll} 是重数且 > 成功率`);
    }
    assert.equal(lv(50, 50, 6), '成功', '非重数按普通成功');
    assert.equal(lv(51, 50, 6), '失败');
    assert.equal(lv(10, 50, 6), '成功', '10 不是重数（1 vs 0）');
    assert.equal(lv(11, 1000, 6), '大成功');
  });

  test('困难=成功率/2、极难=成功率/5（整数除法），且大成功/大失败优先', () => {
    // 房规 0：10/5=2 极难；10/2=5 困难；10 成功；11 失败
    assert.equal(lv(2, 10, 0), '极难成功');
    assert.equal(lv(3, 10, 0), '困难成功');
    assert.equal(lv(5, 10, 0), '困难成功');
    assert.equal(lv(6, 10, 0), '成功');
    assert.equal(lv(11, 10, 0), '失败');
    // 奇数成功率取整：15/5=3、15/2=7
    assert.equal(lv(3, 15, 0), '极难成功');
    assert.equal(lv(4, 15, 0), '困难成功');
    assert.equal(lv(7, 15, 0), '困难成功');
    assert.equal(lv(8, 15, 0), '成功');
    // 房规 3 的大成功/大失败覆盖难度档
    assert.equal(lv(5, 100, 3), '大成功');
    assert.equal(lv(96, 100, 3), '大失败');
  });

  test('极难/困难边界：roll == floor(rate/5) / floor(rate/2) 属于对应档', () => {
    for (const rate of [19, 55, 101]) {
      const fifth = Math.floor(rate / 5);
      const half = Math.floor(rate / 2);
      assert.equal(lv(fifth, rate, 0), '极难成功', `rate=${rate}`);
      assert.notEqual(lv(fifth + 1, rate, 0), '极难成功', `rate=${rate}`);
      assert.equal(lv(half, rate, 0), '困难成功', `rate=${rate}`);
      assert.equal(lv(rate, rate, 0), '成功', `rate=${rate}`);
      assert.equal(lv(rate + 1, rate, 0), '失败', `rate=${rate}`);
    }
  });
});
