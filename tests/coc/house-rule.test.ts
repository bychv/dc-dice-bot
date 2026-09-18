/**
 * 房规 0-6 大成功/大失败判定 —— 逐条对齐手册 §8.1 房规表。
 * 依据：docs/Discord_CoC_Command_Set.md §8.1（第 346-359 行）、
 *       docs/User_Manual.md 第 259-284 行（`.setcoc` 原文说明）、
 *       ref/Dice/Dice/RD.cpp `RollSuccessLevel`（第 1106-1188 行）。
 * 全部断言为确定性：直接构造 d100 骰值 + 用假 Rng 精确驱动 `/rc`。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { HouseRule, SuccessLevel } from '../../src/contracts/model.ts';
import { createCocRules, successLevel, isDoubles } from '../../src/coc/index.ts';
import { seqRng, stubDice } from './helpers.ts';

function expectLevel(roll: number, rate: number, rule: HouseRule, expected: SuccessLevel, label: string): void {
  assert.equal(successLevel(roll, rate, rule), expected, `${label}: rule=${rule} roll=${roll} rate=${rate}`);
}

describe('房规 0（规则书）', () => {
  test('满 50：出 1 大成功，100 大失败，96-99 只是失败', () => {
    expectLevel(1, 50, 0, '大成功', '出1');
    expectLevel(10, 50, 0, '极难成功', '成功率/5');
    expectLevel(11, 50, 0, '困难成功', '超过成功率/5');
    expectLevel(25, 50, 0, '困难成功', '成功率/2');
    expectLevel(26, 50, 0, '成功', '超过成功率/2');
    expectLevel(50, 50, 0, '成功', '等于成功率');
    expectLevel(51, 50, 0, '失败', '超过成功率');
    expectLevel(96, 50, 0, '失败', '满50出96只是失败');
    expectLevel(99, 50, 0, '失败', '满50出99只是失败');
    expectLevel(100, 50, 0, '大失败', '满50出100');
  });
  test('不满 50：出 1 大成功，96-100 大失败', () => {
    expectLevel(1, 49, 0, '大成功', '出1');
    expectLevel(9, 49, 0, '极难成功', '49/5=9');
    expectLevel(24, 49, 0, '困难成功', '49/2=24');
    expectLevel(25, 49, 0, '成功', '超过困难档');
    expectLevel(50, 49, 0, '失败', '超过成功率');
    expectLevel(95, 49, 0, '失败', '95 未到大失败');
    expectLevel(96, 49, 0, '大失败', '不满50出96');
    expectLevel(100, 49, 0, '大失败', '不满50出100');
  });
});

describe('房规 1', () => {
  test('满 50：1-5 大成功；不满 50：只有 1 大成功', () => {
    expectLevel(1, 50, 1, '大成功', '出1');
    expectLevel(5, 50, 1, '大成功', '满50出5');
    expectLevel(6, 50, 1, '极难成功', '50/5=10');
    expectLevel(10, 50, 1, '极难成功', '极难档');
    expectLevel(25, 50, 1, '困难成功', '困难档');
    expectLevel(50, 50, 1, '成功', '成功率');
    expectLevel(96, 50, 1, '失败', '满50出96只是失败');
    expectLevel(100, 50, 1, '大失败', '满50出100');
    expectLevel(5, 49, 1, '极难成功', '不满50出5不是大成功');
    expectLevel(1, 49, 1, '大成功', '不满50出1');
    expectLevel(96, 49, 1, '大失败', '不满50出96');
  });
});

describe('房规 2', () => {
  test('1-5 且 <= 成功率 大成功；100 或 96-99 且 > 成功率 大失败', () => {
    expectLevel(1, 50, 2, '大成功', '出1');
    expectLevel(5, 50, 2, '大成功', '出5');
    expectLevel(5, 3, 2, '失败', '出5但超过成功率');
    expectLevel(2, 3, 2, '大成功', '出2且<=成功率');
    expectLevel(6, 50, 2, '极难成功', '50/5=10');
    expectLevel(10, 50, 2, '极难成功', '极难档');
    expectLevel(25, 50, 2, '困难成功', '困难档');
    expectLevel(50, 50, 2, '成功', '成功率');
    expectLevel(95, 50, 2, '失败', '低于96');
    expectLevel(96, 50, 2, '大失败', '96且>成功率');
    expectLevel(99, 50, 2, '大失败', '99且>成功率');
    expectLevel(100, 150, 2, '大失败', '出100无条件大失败');
    expectLevel(96, 150, 2, '成功', '96且<=成功率');
  });
});

describe('房规 3', () => {
  test('1-5 大成功，96-100 大失败（不看成功率）', () => {
    expectLevel(1, 50, 3, '大成功', '出1');
    expectLevel(5, 50, 3, '大成功', '出5');
    expectLevel(6, 50, 3, '极难成功', '极难档');
    expectLevel(25, 50, 3, '困难成功', '困难档');
    expectLevel(50, 50, 3, '成功', '成功率');
    expectLevel(95, 50, 3, '失败', '95 不是大失败');
    expectLevel(96, 999, 3, '大失败', '96-100 无视成功率');
    expectLevel(100, 999, 3, '大失败', '出100');
  });
});

describe('房规 4', () => {
  test('1-5 且 <= 成功率/10 大成功；不满 50 出 >=96+成功率/10 大失败', () => {
    expectLevel(5, 50, 4, '大成功', '50/10=5');
    expectLevel(5, 45, 4, '极难成功', '45/10=4，出5不满足');
    expectLevel(4, 45, 4, '大成功', '45/10=4');
    expectLevel(6, 50, 4, '极难成功', '50/5=10');
    expectLevel(25, 50, 4, '困难成功', '困难档');
    expectLevel(50, 50, 4, '成功', '成功率');
    expectLevel(99, 45, 4, '失败', '45+4=49 阈值在100');
    expectLevel(100, 45, 4, '大失败', '满 96+4');
    expectLevel(99, 50, 4, '失败', '满50只有100大失败');
    expectLevel(100, 50, 4, '大失败', '满50出100');
    expectLevel(1, 10, 4, '大成功', '10/10=1');
    expectLevel(2, 10, 4, '极难成功', '出2不满足/10');
    expectLevel(96, 10, 4, '失败', '96 < 96+1');
    expectLevel(97, 10, 4, '大失败', '>= 96+1');
  });
});

describe('房规 5', () => {
  test('1-2 且 < 成功率/5 大成功；不满 50 出 96-100 / 满 50 出 99-100 大失败', () => {
    expectLevel(1, 50, 5, '大成功', '50/5=10');
    expectLevel(2, 50, 5, '大成功', '2 < 10');
    expectLevel(3, 50, 5, '极难成功', '3 不满足大成功');
    expectLevel(10, 50, 5, '极难成功', '极难档');
    expectLevel(25, 50, 5, '困难成功', '困难档');
    expectLevel(50, 50, 5, '成功', '成功率');
    expectLevel(98, 50, 5, '失败', '满50的98不是大失败');
    expectLevel(99, 50, 5, '大失败', '满50出99');
    expectLevel(100, 50, 5, '大失败', '满50出100');
    expectLevel(95, 45, 5, '失败', '未到96');
    expectLevel(96, 45, 5, '大失败', '不满50出96');
    expectLevel(1, 4, 5, '困难成功', '4/5=0，出1不是大成功');
  });
});

describe('房规 6（个位数 = 十位数）', () => {
  test('重数 <= 成功率 大成功，重数 > 成功率 大失败', () => {
    expectLevel(11, 50, 6, '大成功', '11 且 <=50');
    expectLevel(22, 50, 6, '大成功', '22 且 <=50');
    expectLevel(44, 50, 6, '大成功', '44 且 <=50');
    expectLevel(50, 50, 6, '成功', '50 不是重数');
    expectLevel(55, 50, 6, '大失败', '55 且 >50');
    expectLevel(66, 50, 6, '大失败', '66 且 >50');
    expectLevel(99, 50, 6, '大失败', '99 且 >50');
    expectLevel(100, 50, 6, '大失败', '100 且 >50');
    expectLevel(1, 50, 6, '大成功', '特例：出1必为大成功（ref RD.cpp:1170）');
    expectLevel(1, 1, 6, '大成功', '特例在最低成功率下同样成立');
    expectLevel(100, 999, 6, '大失败', '特例：出100必为大失败（ref RD.cpp:1165），无视成功率');
    expectLevel(12, 50, 6, '成功', '非重数且<=成功率');
    expectLevel(51, 50, 6, '失败', '非重数且>成功率');
    expectLevel(11, 10, 6, '大失败', '11 但 >10');
    expectLevel(22, 30, 6, '大成功', '22 且 <=30');
    assert.equal(isDoubles(100), true);
    assert.equal(isDoubles(11), true);
    assert.equal(isDoubles(12), false);
  });
});

describe('假 Rng 精确构造 d100 的端到端判定', () => {
  test('房规 0-6 的关键边界', () => {
    const rules = createCocRules(stubDice());
    const cases: { rule: HouseRule; roll: number; rate: number; expected: SuccessLevel }[] = [
      { rule: 0, roll: 1, rate: 50, expected: '大成功' },
      { rule: 0, roll: 96, rate: 50, expected: '失败' },
      { rule: 0, roll: 100, rate: 50, expected: '大失败' },
      { rule: 1, roll: 5, rate: 50, expected: '大成功' },
      { rule: 1, roll: 96, rate: 49, expected: '大失败' },
      { rule: 2, roll: 5, rate: 50, expected: '大成功' },
      { rule: 2, roll: 96, rate: 50, expected: '大失败' },
      { rule: 3, roll: 96, rate: 50, expected: '大失败' },
      { rule: 4, roll: 5, rate: 50, expected: '大成功' },
      { rule: 4, roll: 97, rate: 10, expected: '大失败' },
      { rule: 5, roll: 2, rate: 50, expected: '大成功' },
      { rule: 5, roll: 99, rate: 50, expected: '大失败' },
      { rule: 6, roll: 11, rate: 50, expected: '大成功' },
      { rule: 6, roll: 22, rate: 50, expected: '大成功' },
      { rule: 6, roll: 55, rate: 50, expected: '大失败' },
      { rule: 6, roll: 1, rate: 50, expected: '大成功' },
      { rule: 6, roll: 100, rate: 50, expected: '大失败' },
    ];
    for (const item of cases) {
      const result = rules.check(`力量 ${item.rate}`, {
        sheet: null,
        rule: item.rule,
        rng: seqRng([item.roll]),
      });
      assert.ok(result.ok, `rule=${item.rule} roll=${item.roll} 应成功`);
      assert.equal(result.details[0].roll, item.roll, `骰值应精确等于构造值`);
      assert.equal(result.details[0].level, item.expected, `rule=${item.rule} roll=${item.roll} rate=${item.rate}`);
      assert.equal(result.rule, item.rule);
    }
  });

  test('多轮各自按同一房规判定', () => {
    const rules = createCocRules(stubDice());
    const result = rules.check('3#力量 50', { sheet: null, rule: 0, rng: seqRng([1, 50, 100]) });
    assert.ok(result.ok);
    assert.deepEqual(
      result.details.map((detail) => detail.level),
      ['大成功', '成功', '大失败'],
    );
    assert.equal(result.rounds, 3);
    assert.equal(result.details.length, 3);
  });
});
