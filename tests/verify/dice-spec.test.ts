/**
 * T4 独立验证 · 掷骰语法与取值（固定 Rng → 断言到具体数值）
 *
 * 规格：docs/Discord_CoC_Command_Set.md §4.1（第 154-184 行）
 *   [次数]# 1-10；[个数]d[面数] 1-100 / 1-1000；b/p 固定 d100 且 <=9；k 取大；
 *   X/* 乘号；超过 20 个骰子自动排序；奖惩骰：奖励取最小候选、惩罚取最大候选。
 *
 * Run: node tests/verify/dice-spec.test.ts
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createDiceEngine } from '../../src/dice/engine.ts';
import { isDiceTerm, parseExpression } from '../../src/dice/expression.ts';
import type { DiceTerm, Term } from '../../src/dice/expression.ts';
import { renderRoll } from '../../src/dice/render.ts';
import { parseRollText } from '../../src/dice/text.ts';
import { sequenceRng } from '../dice/helpers.ts';

const dice = createDiceEngine();

/** 取表达式里的第 n 个骰子项（带类型收窄）。 */
function asDice(term: Term | undefined): DiceTerm {
  if (!term || !isDiceTerm(term)) throw new Error('期望一个骰子项');
  return term;
}

describe('T4 · 掷骰表达式（固定 Rng）', () => {
  test('3d6k2：取最大的 2 个，点数与 total 逐值核对', () => {
    const result = dice.roll('3d6k2', sequenceRng([2, 5, 4]));
    assert.ok(result.ok);
    assert.equal(result.expression, '3d6k2');
    assert.deepEqual(result.groups, [{ sides: 6, values: [2, 5, 4], keep: 2 }]);
    assert.equal(result.total, 9, '5+4');
    assert.equal(result.totals.length, 1);
    assert.equal(renderRoll(result), '3d6k2=4+5=9', '渲染也要展示保留下来的 2 个骰（升序）');
  });

  test('3#1d6：三轮逐轮独立掷骰，totals/rounds 正确', () => {
    const result = dice.roll('3#1d6', sequenceRng([1, 2, 3]));
    assert.ok(result.ok);
    assert.equal(result.rounds, 3);
    assert.equal(result.expression, '3#1d6');
    assert.deepEqual(result.totals, [1, 2, 3]);
    assert.equal(result.total, 6);
    assert.deepEqual(result.groups[0].values, [1, 2, 3]);
  });

  test('b2：奖励骰取最小候选（数值级断言）', () => {
    // base=50（个位 0）→ 两次额外 d10 = 8 / 2，候选 50 / 80 / 20 → 取最小 20
    const result = dice.roll('b2', sequenceRng([50, 8, 2]));
    assert.ok(result.ok);
    assert.equal(result.total, 20);
    assert.equal(result.groups[0].bonus, 2);
    assert.equal(result.groups[0].sides, 100);
    assert.deepEqual(result.groups[0].values, [50, 8, 2]);
  });

  test('p：惩罚骰取最大候选（数值级断言）', () => {
    // base=45（个位 5）→ 额外 d10=3 → tens=2 → 候选 45 / 25 → 取最大 45
    const result = dice.roll('p', sequenceRng([45, 3]));
    assert.ok(result.ok);
    assert.equal(result.total, 45);
    assert.equal(result.groups[0].penalty, 1);
    assert.deepEqual(result.groups[0].values, [45, 2], 'RD 语义：个位非 0 时额外 d10 存 tensDie-1');
  });

  test('percentile()：奖励取最小、惩罚取最大，且奖惩骰互相抵消', () => {
    const bonus = dice.percentile({ bonus: 2 }, sequenceRng([50, 8, 2]));
    assert.ok(bonus.ok);
    assert.equal(bonus.value, 20);
    assert.equal(bonus.bonus, 2);
    assert.equal(bonus.penalty, 0);

    const penalty = dice.percentile({ penalty: 2 }, sequenceRng([50, 8, 2]));
    assert.ok(penalty.ok);
    assert.equal(penalty.value, 80, '惩罚骰取最大候选 80');

    // b1 p1 → 净 0 个额外骰，只有基础 d100
    const cancel = dice.percentile({ bonus: 1, penalty: 1 }, sequenceRng([37, 99]));
    assert.ok(cancel.ok);
    assert.equal(cancel.value, 37);
    assert.equal(cancel.candidates.length, 1, '抵消后不应再掷额外 d10');
  });

  test('3d6X5：乘号生效，total 含乘数、渲染含 ×', () => {
    const result = dice.roll('3d6X5', sequenceRng([2, 3, 4]));
    assert.ok(result.ok);
    assert.equal(result.expression, '3d6X5');
    assert.equal(result.total, 45, '(2+3+4)×5');
    assert.equal(result.groups[0].values.reduce((a, b) => a + b, 0), 9);
    const text = renderRoll(result);
    assert.ok(text.includes('×5'), `渲染必须含乘号，实际：${text}`);
    assert.ok(text.endsWith('=45'), `渲染必须以 total 结束，实际：${text}`);
  });

  test('X 与 * 等价，且大小写不敏感', () => {
    for (const expr of ['3d6*5', '3d6X5', '3D6x5']) {
      const result = dice.roll(expr, sequenceRng([2, 3, 4]));
      assert.ok(result.ok, expr);
      assert.equal(result.total, 45, expr);
      assert.equal(result.expression, '3d6X5', `${expr} 归一化为 3d6X5`);
    }
  });

  test('1d4+2：单个骰子 + 常量', () => {
    const result = dice.roll('1d4+2', sequenceRng([3]));
    assert.ok(result.ok);
    assert.equal(result.expression, '1d4+2');
    assert.equal(result.total, 5);
    assert.equal(result.modifier, 2);
    assert.deepEqual(result.groups, [{ sides: 4, values: [3] }]);
  });

  test('1d10+1d6+3：两个骰组 + 常量，逐组核对', () => {
    const result = dice.roll('1d10+1d6+3', sequenceRng([10, 6]));
    assert.ok(result.ok);
    assert.equal(result.expression, '1d10+1d6+3');
    assert.equal(result.total, 19);
    assert.equal(result.modifier, 3);
    assert.deepEqual(result.groups, [
      { sides: 10, values: [10] },
      { sides: 6, values: [6] },
    ]);
  });

  test('多轮 + 常量：3#1d6+2 每轮各自加常量', () => {
    const result = dice.roll('3#1d6+2', sequenceRng([1, 2, 3]));
    assert.ok(result.ok);
    assert.deepEqual(result.totals, [3, 4, 5]);
    assert.equal(result.total, 12);
    assert.equal(result.rounds, 3);
  });

  test('空表达式 → 默认 d100（COC 惯例）', () => {
    const result = dice.roll('', sequenceRng([77]));
    assert.ok(result.ok);
    assert.equal(result.expression, '1d100');
    assert.equal(result.total, 77);
  });
});

describe('T4 · 掷骰边界与拒绝', () => {
  const cases: [string, string][] = [
    ['0d6', '个数下界'],
    ['101d6', '个数上界'],
    ['1d0', '面数下界'],
    ['1d1001', '面数上界'],
    ['11#1d6', '轮数上界'],
    ['0#1d6', '轮数下界'],
    ['b10', '奖励骰上界'],
    ['p10', '惩罚骰上界'],
    ['1d100b10', '奖励骰上界（显式 d100 写法）'],
    ['3d6k4', '取大数量 > 骰数'],
    ['3d6k0', '取大数量下界'],
    ['3d6/0', '除数为 0'],
    ['1d6+', '表达式以运算符结尾'],
    ['2#3#1d6', '多个 #'],
    ['abc', '无法解析'],
  ];
  for (const [expr, label] of cases) {
    test(`拒绝：${expr}（${label}）`, () => {
      const result = dice.roll(expr, sequenceRng([3, 4, 5, 6]));
      assert.equal(result.ok, false, `${expr} 必须被拒绝`);
      assert.ok(!result.ok && result.error.length > 0);
    });
  }

  test('边界内合法：100d1000、10#1d6、b9/p9、1d6k1', () => {
    const big = dice.roll('100d1000', { int: (_min, _max) => 1 });
    assert.ok(big.ok);
    assert.equal(big.total, 100);
    assert.equal(big.groups[0].values.length, 100);

    const rounds = dice.roll('10#1d6', { int: () => 1 });
    assert.ok(rounds.ok);
    assert.equal(rounds.rounds, 10);
    assert.equal(rounds.total, 10);

    const b9 = dice.percentile({ bonus: 9 }, { int: (_min, max) => max });
    assert.ok(b9.ok);
    assert.equal(b9.value, 100, 'base=100、个位 0、tens=10 → 100');

    const p9 = dice.percentile({ penalty: 9 }, { int: (_min, max) => max });
    assert.ok(p9.ok);
    assert.equal(p9.value, 100);

    const keep1 = dice.roll('1d6k1', sequenceRng([4]));
    assert.ok(keep1.ok);
    assert.equal(keep1.total, 4);
  });

  test('超过 20 个骰自动排序（sorted=true 且 values 升序）', () => {
    const values = Array.from({ length: 21 }, (_, i) => 21 - i); // 21,20,...,1
    const result = dice.roll('21d21', sequenceRng(values));
    assert.ok(result.ok);
    assert.equal(result.sorted, true, '原手册：一次掷骰超过 20 个骰子时自动排序');
    for (let i = 1; i < result.groups[0].values.length; i += 1) {
      assert.ok(result.groups[0].values[i - 1] <= result.groups[0].values[i], 'values 必须升序');
    }
    assert.equal(result.total, 231, '排序不改变总数');

    const exactly20 = dice.roll('20d21', sequenceRng(values.slice(0, 20)));
    assert.ok(exactly20.ok);
    assert.equal(exactly20.sorted, false, '恰好 20 个不触发排序');
    assert.deepEqual(exactly20.groups[0].values, values.slice(0, 20), '≤20 个保持原始顺序');
  });

  test('表达式解析：3d6k2 / b2 / p / * 归一化字段', () => {
    const keep = parseExpression('3d6k2');
    assert.ok(keep.ok);
    assert.equal(asDice(keep.value.terms[0]).text, '3d6k2');
    assert.equal(keep.value.expression, '3d6k2');

    const bonus = parseExpression('b2');
    assert.ok(bonus.ok);
    assert.equal(asDice(bonus.value.terms[0]).sides, 100);
    assert.equal(asDice(bonus.value.terms[0]).bonus, 2);
    assert.equal(asDice(bonus.value.terms[0]).count, 2, 'b2 按 1 个基础百面骰 + 2 个额外骰');

    const penalty = parseExpression('p');
    assert.ok(penalty.ok);
    assert.equal(asDice(penalty.value.terms[0]).penalty, 1);

    const times = parseExpression('3d6X5');
    assert.ok(times.ok);
    assert.equal(asDice(times.value.terms[0]).multiplier, 5);
    assert.equal(times.value.modifier, 0, '乘法骰式的 modifier 必须为 0（交付说明特别标注）');
  });

  test('parseRollText：/r 家族表达式 + 理由拆分', () => {
    assert.deepEqual(parseRollText('3d6k2'), { expression: '3d6k2', rounds: 1 });
    assert.deepEqual(parseRollText('3#1d6 3发.22伤害'), { expression: '1d6', reason: '3发.22伤害', rounds: 3 });
    assert.deepEqual(parseRollText('1d4+2 中型刀伤害'), { expression: '1d4+2', reason: '中型刀伤害', rounds: 1 });
    assert.deepEqual(parseRollText('沙漠之鹰'), { expression: '沙漠之鹰', rounds: 1 });
    assert.deepEqual(parseRollText(''), { expression: '', rounds: 1 });
    assert.deepEqual(parseRollText('11#1d6'), { expression: '11#1d6', rounds: 1 }, '越界轮数原样留给 roll() 报错');
    assert.deepEqual(parseRollText('10#1d10'), { expression: '1d10', rounds: 10 });
  });
});
