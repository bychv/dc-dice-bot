import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiceEngine } from '../../src/dice/index.ts';
import type { RollResult } from '../../src/dice/index.ts';
import type { Rng } from '../../src/dice/index.ts';
import { descendingValues, maxRng, minRng, sequenceRng } from './helpers.ts';

const engine = createDiceEngine();

function expectSuccess(result: RollResult) {
  if (!result.ok) assert.fail(`unexpected failure: ${result.error}`);
  return result;
}

describe('roll: 基本骰式', () => {
  test('3d6 按掷骰顺序记录每个点数并求和', () => {
    const rng = sequenceRng([3, 4, 5]);
    const result = expectSuccess(engine.roll('3d6', rng));
    assert.equal(result.expression, '3d6');
    assert.equal(result.rounds, 1);
    assert.deepEqual(result.groups, [{ sides: 6, values: [3, 4, 5] }]);
    assert.equal(result.modifier, 0);
    assert.deepEqual(result.totals, [12]);
    assert.equal(result.total, 12);
    assert.equal(result.sorted, false);
    assert.equal(rng.calls, 3);
  });

  test('空表达式回落到默认 1d100', () => {
    const rng = sequenceRng([42]);
    const result = expectSuccess(engine.roll('', rng));
    assert.equal(result.expression, '1d100');
    assert.deepEqual(result.groups, [{ sides: 100, values: [42] }]);
    assert.equal(result.total, 42);
    assert.equal(rng.calls, 1);
  });

  test('大小写与 `d` 的缺省写法都会归一化', () => {
    assert.equal(expectSuccess(engine.roll('D100', sequenceRng([7]))).expression, '1d100');
    assert.equal(expectSuccess(engine.roll('d', sequenceRng([7]))).expression, '1d100');
    assert.equal(expectSuccess(engine.roll('1D10', sequenceRng([7]))).expression, '1d10');
    assert.equal(expectSuccess(engine.roll('2d', sequenceRng([1, 2]))).expression, '2d100');
  });

  test('1d1000 面数上界可用', () => {
    const result = expectSuccess(engine.roll('1d1000', minRng()));
    assert.equal(result.total, 1);
    assert.deepEqual(result.groups, [{ sides: 1000, values: [1] }]);
  });

  test('100d1000 个数量上界可用并自动排序', () => {
    const result = expectSuccess(engine.roll('100d1000', maxRng()));
    assert.equal(result.groups[0]?.values.length, 100);
    assert.equal(result.total, 100000);
    assert.equal(result.sorted, true);
  });
});

describe('roll: 非百面骰的额外奖惩骰（`XdYbN` / `XdYpN`）', () => {
  test('1d10b2 = 1d10 再补 2 个 d10，取最大：3/8/2 -> 8', () => {
    const rng = sequenceRng([3, 8, 2]);
    const result = expectSuccess(engine.roll('1d10b2', rng));
    assert.equal(result.expression, '1d10b2');
    assert.deepEqual(result.groups, [{ sides: 10, values: [3, 8, 2], bonus: 2 }]);
    assert.equal(result.total, 8);
    assert.equal(rng.calls, 3, '1 个基础骰 + 2 个奖励骰');
  });

  test('1d10p2 = 取最小：3/8/2 -> 2', () => {
    const result = expectSuccess(engine.roll('1d10p2', sequenceRng([3, 8, 2])));
    assert.equal(result.expression, '1d10p2');
    assert.deepEqual(result.groups, [{ sides: 10, values: [3, 8, 2], penalty: 2 }]);
    assert.equal(result.total, 2);
  });

  test('2d6b1 = 3d6 取最大的 2 个求和：5+3 -> 8', () => {
    const result = expectSuccess(engine.roll('2d6b1', sequenceRng([1, 5, 3])));
    assert.equal(result.total, 8);
    assert.deepEqual(result.groups, [{ sides: 6, values: [1, 5, 3], bonus: 1 }]);
  });

  test('2d6p1 = 3d6 取最小的 2 个求和：1+3 -> 4', () => {
    const result = expectSuccess(engine.roll('2d6p1', sequenceRng([1, 5, 3])));
    assert.equal(result.total, 4);
  });

  test('b0/p0 等价于不带奖惩骰', () => {
    assert.equal(expectSuccess(engine.roll('1d10b0', sequenceRng([7]))).total, 7);
    assert.equal(expectSuccess(engine.roll('1d10p0', sequenceRng([7]))).total, 7);
  });

  test('非百面骰的奖惩骰也能参与算术式与多轮', () => {
    const single = expectSuccess(engine.roll('1d10b2+3', sequenceRng([3, 8, 2])));
    assert.equal(single.total, 11);
    assert.equal(single.expression, '1d10b2+3');

    const rounds = expectSuccess(engine.roll('2#1d10b1', sequenceRng([1, 5, 2, 9])));
    assert.deepEqual(rounds.totals, [5, 9]);
    assert.equal(rounds.total, 14);
  });

  test('百面骰仍走 CoC 十位骰：1d100b2 归一化为 b2', () => {
    const result = expectSuccess(engine.roll('1d100b2', sequenceRng([45, 3, 7])));
    assert.equal(result.expression, 'b2');
    assert.deepEqual(result.groups, [{ sides: 100, values: [45, 2, 6], bonus: 2 }]);
    assert.equal(result.total, 25);
  });
});

describe('roll: 算术项', () => {
  test('1d4+2 常量折叠进 modifier', () => {
    const result = expectSuccess(engine.roll('1d4+2', sequenceRng([3])));
    assert.equal(result.expression, '1d4+2');
    assert.deepEqual(result.groups, [{ sides: 4, values: [3] }]);
    assert.equal(result.modifier, 2);
    assert.equal(result.total, 5);
  });

  test('1d10+1d6+3 多骰式相加', () => {
    const result = expectSuccess(engine.roll('1d10+1d6+3', sequenceRng([7, 3])));
    assert.equal(result.expression, '1d10+1d6+3');
    assert.deepEqual(result.groups, [
      { sides: 10, values: [7] },
      { sides: 6, values: [3] },
    ]);
    assert.equal(result.modifier, 3);
    assert.equal(result.total, 13);
  });

  test('1d6-2 负常量', () => {
    const result = expectSuccess(engine.roll('1d6-2', sequenceRng([5])));
    assert.equal(result.expression, '1d6-2');
    assert.equal(result.modifier, -2);
    assert.equal(result.total, 3);
  });

  test('-1d6 前导负号', () => {
    const result = expectSuccess(engine.roll('-1d6', sequenceRng([5])));
    assert.equal(result.expression, '-1d6');
    assert.equal(result.total, -5);
  });

  test('+- 与 -- 折叠成合法符号', () => {
    assert.equal(expectSuccess(engine.roll('1d6+-2', sequenceRng([5]))).total, 3);
    assert.equal(expectSuccess(engine.roll('1d6--2', sequenceRng([5]))).total, 7);
    assert.equal(expectSuccess(engine.roll('1d6++2', sequenceRng([5]))).total, 7);
  });

  test('常量自身的乘除也会折叠', () => {
    const result = expectSuccess(engine.roll('1d4+2X3', sequenceRng([1])));
    assert.equal(result.modifier, 6);
    assert.equal(result.total, 7);
  });
});

describe('roll: 乘号与除号', () => {
  test('3d6X5 乘号作用于该骰式', () => {
    const result = expectSuccess(engine.roll('3d6X5', sequenceRng([3, 4, 5])));
    assert.equal(result.expression, '3d6X5');
    assert.equal(result.total, 60);
  });

  test('* 与 x 都等价于 X', () => {
    assert.equal(expectSuccess(engine.roll('3d6*5', sequenceRng([3, 4, 5]))).expression, '3d6X5');
    assert.equal(expectSuccess(engine.roll('3d6x5', sequenceRng([3, 4, 5]))).expression, '3d6X5');
  });

  test('3d6/2 常量除数向下取整（C++ 截断）', () => {
    const result = expectSuccess(engine.roll('3d6/2', sequenceRng([3, 4, 5])));
    assert.equal(result.expression, '3d6/2');
    assert.equal(result.total, 6);
  });

  test('3d6X5/2 先乘后除', () => {
    const result = expectSuccess(engine.roll('3d6X5/2', sequenceRng([3, 4, 5])));
    assert.equal(result.total, 30);
  });
});

describe('roll: k 取大', () => {
  test('3d6k2 保留全部点数、总计取最高两个', () => {
    const result = expectSuccess(engine.roll('3d6k2', sequenceRng([2, 5, 4])));
    assert.equal(result.expression, '3d6k2');
    assert.deepEqual(result.groups, [{ sides: 6, values: [2, 5, 4], keep: 2 }]);
    assert.equal(result.total, 9);
  });

  test('3d6k 缺省取 1 个；2dk2 面数缺省 100', () => {
    assert.equal(expectSuccess(engine.roll('3d6k', sequenceRng([2, 5, 4]))).total, 5);
    assert.equal(expectSuccess(engine.roll('2dk2', sequenceRng([30, 90]))).total, 120);
  });

  test('3d6k3 等价于全取', () => {
    assert.equal(expectSuccess(engine.roll('3d6k3', sequenceRng([1, 2, 3]))).total, 6);
  });
});

describe('roll: 多轮 N#', () => {
  test('3#1d6 逐轮掷骰并给出每轮 totals', () => {
    const rng = sequenceRng([1, 2, 3]);
    const result = expectSuccess(engine.roll('3#1d6', rng));
    assert.equal(result.expression, '3#1d6');
    assert.equal(result.rounds, 3);
    assert.deepEqual(result.groups, [{ sides: 6, values: [1, 2, 3] }]);
    assert.deepEqual(result.totals, [1, 2, 3]);
    assert.equal(result.total, 6);
    assert.equal(rng.calls, 3);
  });

  test('2#1d4+1 每轮都加常量', () => {
    const result = expectSuccess(engine.roll('2#1d4+1', sequenceRng([3, 1])));
    assert.equal(result.expression, '2#1d4+1');
    assert.deepEqual(result.totals, [4, 2]);
    assert.equal(result.total, 6);
  });

  test('#1d6 等价 1d6；3# 回落到 3 轮 d100', () => {
    const single = expectSuccess(engine.roll('#1d6', sequenceRng([4])));
    assert.equal(single.expression, '1d6');
    assert.equal(single.rounds, 1);

    const fallback = expectSuccess(engine.roll('3#', sequenceRng([10, 20, 30])));
    assert.equal(fallback.expression, '3#1d100');
    assert.deepEqual(fallback.totals, [10, 20, 30]);
    assert.equal(fallback.total, 60);
  });

  test('10#1d10 轮数上界可用', () => {
    const values = Array.from({ length: 10 }, (_, index) => index + 1);
    const result = expectSuccess(engine.roll('10#1d10', sequenceRng(values)));
    assert.equal(result.rounds, 10);
    assert.deepEqual(result.totals, values);
  });
});

describe('roll: 超过 20 个骰子自动排序', () => {
  test('20 个骰子保持掷骰顺序', () => {
    const values = descendingValues(20);
    const result = expectSuccess(engine.roll('20d20', sequenceRng(values)));
    assert.equal(result.sorted, false);
    assert.deepEqual(result.groups[0]?.values, values);
  });

  test('21 个骰子排序并置 sorted=true', () => {
    const values = descendingValues(21);
    const result = expectSuccess(engine.roll('21d21', sequenceRng(values)));
    assert.equal(result.sorted, true);
    assert.deepEqual(
      result.groups[0]?.values,
      Array.from({ length: 21 }, (_, index) => index + 1),
    );
    assert.equal(result.total, 231);
  });

  test('21d6k2 排序后仍只取最高两个', () => {
    const result = expectSuccess(engine.roll('21d6k2', sequenceRng([6, ...Array.from({ length: 20 }, () => 1)])));
    assert.equal(result.sorted, true);
    assert.equal(result.groups[0]?.keep, 2);
    assert.equal(result.total, 7);
    assert.deepEqual(result.groups[0]?.values, [...Array.from({ length: 20 }, () => 1), 6]);
  });
});

describe('roll: 非法输入返回 { ok:false, error } 且不抛异常', () => {
  const cases: [string, string][] = [
    ['0d6', '骰子个数'],
    ['101d6', '骰子个数'],
    ['1d0', '骰子面数'],
    ['1d1001', '骰子面数'],
    ['0#1d6', '掷骰次数'],
    ['11#1d6', '掷骰次数'],
    ['3d6k0', '取大数量'],
    ['3d6k4', '取大数量'],
    ['b10', '0-9'],
    ['p10', '0-9'],
    ['1d6+', '运算符结尾'],
    ['abc', '无法解析'],
    ['沙漠之鹰', '无法解析'],
    ['1d6X', '乘数'],
    ['1d6/0', '除数不能为 0'],
    ['1d6/1d4', '除数'],
    ['1d6b10', '0-9'],
    ['1d10#', '掷骰次数'],
    ['1d6 伤害', '无法解析'],
    ['2#3#1d6', '一个 #'],
    ['1d6**2', '乘数'],
  ];

  for (const [expression, fragment] of cases) {
    test(`${JSON.stringify(expression)} 报错包含 ${fragment}`, () => {
      const result = engine.roll(expression, sequenceRng([]));
      assert.equal(result.ok, false);
      if (result.ok) assert.fail('expected failure');
      assert.ok(
        result.error.includes(fragment),
        `expected error of ${JSON.stringify(expression)} to contain ${fragment}, got ${JSON.stringify(result.error)}`,
      );
    });
  }

  test('任意垃圾输入都不会抛异常', () => {
    const garbage: string[] = ['', '#', '# #', '1d6#1d6', 'd', 'k2', '1dd6', '1d6k2k3', '1d6X2X3/0', '999d6', '💥', '-'];
    for (const expression of garbage) {
      let result: RollResult | undefined;
      assert.doesNotThrow(() => {
        result = engine.roll(expression, minRng());
      }, `roll(${JSON.stringify(expression)}) must not throw`);
      assert.ok(result !== undefined);
      assert.equal(typeof (result as RollResult).ok, 'boolean');
    }
  });

  test('假 Rng 返回越界值时报错而不是抛异常', () => {
    const badRng = { int: () => 0 } as unknown as Rng;
    const result = engine.roll('1d6', badRng);
    assert.equal(result.ok, false);
    if (result.ok) assert.fail('expected failure');
    assert.ok(result.error.includes('随机数生成器'));

    const fractional = engine.roll('1d6', { int: () => 1.5 } as Rng);
    assert.equal(fractional.ok, false);
  });
});
