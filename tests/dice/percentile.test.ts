import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiceEngine } from '../../src/dice/index.ts';
import type { PercentileResult, RollResult } from '../../src/dice/index.ts';
import { minRng, sequenceRng } from './helpers.ts';

const engine = createDiceEngine();

function expectRoll(result: RollResult) {
  if (!result.ok) assert.fail(`unexpected failure: ${result.error}`);
  return result;
}

function expectPercentile(result: PercentileResult) {
  if (!result.ok) assert.fail(`unexpected failure: ${result.error}`);
  return result;
}

describe('roll: b/p 奖惩骰（固定百面骰）', () => {
  test('b2 取最小候选：基数 45、十位骰 3/7 -> 45[奖励骰:2 6] = 25', () => {
    const result = expectRoll(engine.roll('b2', sequenceRng([45, 3, 7])));
    assert.equal(result.expression, 'b2');
    assert.deepEqual(result.groups, [{ sides: 100, values: [45, 2, 6], bonus: 2 }]);
    assert.equal(result.total, 25);
    assert.equal(result.rounds, 1);
  });

  test('p2 取最大候选：基数 45、十位骰 3/7 -> 65', () => {
    const result = expectRoll(engine.roll('p2', sequenceRng([45, 3, 7])));
    assert.equal(result.expression, 'p2');
    assert.deepEqual(result.groups, [{ sides: 100, values: [45, 2, 6], penalty: 2 }]);
    assert.equal(result.total, 65);
  });

  test('1d100b2 归一化为 b2', () => {
    const result = expectRoll(engine.roll('1d100b2', sequenceRng([45, 3, 7])));
    assert.equal(result.expression, 'b2');
    assert.equal(result.total, 25);
  });

  test('b 缺省 1 个奖励骰', () => {
    const result = expectRoll(engine.roll('b', sequenceRng([45, 10])));
    assert.equal(result.expression, 'b1');
    assert.deepEqual(result.groups, [{ sides: 100, values: [45, 9], bonus: 1 }]);
    assert.equal(result.total, 45); // min(45, 95)
  });

  test('p 缺省 1 个惩罚骰', () => {
    const result = expectRoll(engine.roll('p', sequenceRng([45, 4])));
    assert.equal(result.expression, 'p1');
    assert.equal(result.total, 45); // max(45, 35)
  });

  test('b0 是合法输入（0 个奖励骰）', () => {
    const result = expectRoll(engine.roll('b0', sequenceRng([45])));
    assert.equal(result.expression, 'b0');
    assert.deepEqual(result.groups, [{ sides: 100, values: [45], bonus: 0 }]);
    assert.equal(result.total, 45);
  });

  test('基数末位为 0 时十位骰直接用 1..10', () => {
    const bonus = expectRoll(engine.roll('b', sequenceRng([100, 1])));
    assert.equal(bonus.total, 10); // min(100, 10)
    const penalty = expectRoll(engine.roll('p', sequenceRng([50, 10])));
    assert.equal(penalty.total, 100); // max(50, 100)
  });

  test('b2 也可以出现在算术式里', () => {
    const result = expectRoll(engine.roll('1d10+b2', sequenceRng([4, 45, 3, 7])));
    assert.deepEqual(result.groups, [
      { sides: 10, values: [4] },
      { sides: 100, values: [45, 2, 6], bonus: 2 },
    ]);
    assert.equal(result.total, 29);
  });
});

describe('percentile(): 奖惩骰取值', () => {
  test('奖励取最小候选，候选列表首位是选中值', () => {
    const result = expectPercentile(engine.percentile({ bonus: 2 }, sequenceRng([45, 3, 7])));
    assert.equal(result.value, 25);
    assert.equal(result.tens, 2);
    assert.equal(result.units, 5);
    assert.deepEqual(result.candidates, [25, 45, 65]);
    assert.equal(result.bonus, 2);
    assert.equal(result.penalty, 0);
  });

  test('惩罚取最大候选', () => {
    const result = expectPercentile(engine.percentile({ penalty: 2 }, sequenceRng([45, 3, 7])));
    assert.equal(result.value, 65);
    assert.equal(result.tens, 6);
    assert.equal(result.units, 5);
    assert.deepEqual(result.candidates, [65, 45, 25]);
    assert.equal(result.bonus, 0);
    assert.equal(result.penalty, 2);
  });

  test('无奖惩时只掷一次 d100', () => {
    const rng = sequenceRng([45]);
    const result = expectPercentile(engine.percentile({}, rng));
    assert.equal(result.value, 45);
    assert.deepEqual(result.candidates, [45]);
    assert.equal(rng.calls, 1);
  });

  test('奖惩骰互相抵消', () => {
    const rng = sequenceRng([42]);
    const result = expectPercentile(engine.percentile({ bonus: 1, penalty: 1 }, rng));
    assert.equal(result.value, 42);
    assert.equal(result.bonus, 0);
    assert.equal(result.penalty, 0);
    assert.equal(rng.calls, 1);
  });

  test('净奖励骰数决定额外 d10 的个数', () => {
    const rng = sequenceRng([45, 3, 7]);
    const result = expectPercentile(engine.percentile({ bonus: 3, penalty: 1 }, rng));
    assert.equal(result.bonus, 2);
    assert.equal(result.penalty, 0);
    assert.equal(rng.calls, 3); // 1 次 d100 + 2 个净奖励骰
    assert.equal(result.value, 25);
    assert.deepEqual(result.candidates, [25, 45, 65]);
  });

  test('9 个奖励骰是上界', () => {
    const values = [45, ...Array.from({ length: 9 }, () => 1)];
    const result = expectPercentile(engine.percentile({ bonus: 9 }, sequenceRng(values)));
    assert.equal(result.bonus, 9);
    assert.equal(result.candidates.length, 10);
    assert.equal(result.value, 5); // tens 0 + units 5
  });

  test('基数末位为 0 时十位 1..10', () => {
    assert.equal(expectPercentile(engine.percentile({ bonus: 1 }, sequenceRng([40, 3]))).value, 30);
    assert.equal(expectPercentile(engine.percentile({ penalty: 1 }, sequenceRng([40, 7]))).value, 70);
    assert.equal(expectPercentile(engine.percentile({ bonus: 1 }, sequenceRng([100, 1]))).value, 10);
    assert.equal(expectPercentile(engine.percentile({ penalty: 1 }, sequenceRng([100, 10]))).value, 100);
  });

  test('越界或非法数量返回错误而不是抛异常', () => {
    for (const opts of [{ bonus: 10 }, { penalty: 10 }, { bonus: -1 }, { bonus: 1.5 }, { penalty: Number.NaN }]) {
      const result = engine.percentile(opts, minRng());
      assert.equal(result.ok, false);
      if (result.ok) assert.fail('expected failure');
      assert.ok(result.error.includes('0-9'), `unexpected error: ${result.error}`);
    }
  });

  test('假 Rng 越界时报错', () => {
    const result = engine.percentile({ bonus: 1 }, { int: () => 101 });
    assert.equal(result.ok, false);
    if (result.ok) assert.fail('expected failure');
    assert.ok(result.error.includes('随机数生成器'));
  });
});

/**
 * Literal transcription of RD::RollDice's B_Dice / P_Dice branches
 * (ref/Dice/Dice/RD.cpp:202-275): the extra d10 replaces the tens digit,
 * bonus keeps the smallest tens (`<`), penalty the largest (`>`), units stay put.
 */
function referencePercentile(base: number, dice: number[], bonus: boolean): number {
  const roll = [base, ...dice.map((die) => (base % 10 === 0 ? die : die - 1))];
  let chosen = roll[0] as number;
  for (let i = 1; i < roll.length; i++) {
    const value = roll[i] as number;
    if (bonus ? value < Math.trunc(chosen / 10) : value > Math.trunc(chosen / 10)) {
      chosen = value * 10 + (chosen % 10);
    }
  }
  return chosen;
}

describe('percentile(): 与 RD.cpp 分支逐值对齐', () => {
  test('基数 1-100 × 十位骰 1-10 全部一致（奖励/惩罚）', () => {
    for (let base = 1; base <= 100; base++) {
      for (let die = 1; die <= 10; die++) {
        const bonus = expectPercentile(engine.percentile({ bonus: 1 }, sequenceRng([base, die])));
        assert.equal(
          bonus.value,
          referencePercentile(base, [die], true),
          `bonus mismatch base=${base} die=${die}`,
        );
        assert.equal(bonus.candidates[0], bonus.value);
        assert.equal(bonus.candidates.length, 2);
        assert.ok(bonus.candidates.includes(base), `bonus candidates must include the base ${base}`);

        const penalty = expectPercentile(engine.percentile({ penalty: 1 }, sequenceRng([base, die])));
        assert.equal(
          penalty.value,
          referencePercentile(base, [die], false),
          `penalty mismatch base=${base} die=${die}`,
        );
        assert.equal(penalty.candidates[0], penalty.value);
        assert.equal(penalty.candidates.length, 2);
        assert.ok(penalty.candidates.includes(base), `penalty candidates must include the base ${base}`);
      }
    }
  });

  test('多个十位骰时与参考实现一致', () => {
    for (let base = 1; base <= 100; base += 7) {
      for (const dice of [
        [1, 10],
        [10, 1],
        [3, 7, 5],
        [9, 2, 10, 4],
        [5, 5, 5],
      ]) {
        const bonus = expectPercentile(engine.percentile({ bonus: dice.length }, sequenceRng([base, ...dice])));
        assert.equal(
          bonus.value,
          referencePercentile(base, dice, true),
          `bonus mismatch base=${base} dice=${dice.join(',')}`,
        );
        assert.equal(bonus.candidates[0], bonus.value);
        assert.equal(bonus.candidates.length, dice.length + 1);

        const penalty = expectPercentile(engine.percentile({ penalty: dice.length }, sequenceRng([base, ...dice])));
        assert.equal(
          penalty.value,
          referencePercentile(base, dice, false),
          `penalty mismatch base=${base} dice=${dice.join(',')}`,
        );
        assert.equal(penalty.candidates[0], penalty.value);
        assert.equal(penalty.candidates.length, dice.length + 1);
      }
    }
  });
});
