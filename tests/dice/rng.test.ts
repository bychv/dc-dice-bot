import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMathRng } from '../../src/dice/index.ts';

describe('createMathRng', () => {
  test('覆盖区间两端', () => {
    const original = Math.random;
    try {
      Math.random = () => 0;
      assert.equal(createMathRng().int(1, 6), 1);
      Math.random = () => 0.999999999;
      assert.equal(createMathRng().int(1, 6), 6);
      Math.random = () => 0;
      assert.equal(createMathRng().int(10, 10), 10);
    } finally {
      Math.random = original;
    }
  });

  test('返回值始终是区间内的整数', () => {
    const rng = createMathRng();
    for (let i = 0; i < 2000; i++) {
      const value = rng.int(1, 100);
      assert.ok(Number.isInteger(value));
      assert.ok(value >= 1 && value <= 100, `out of range: ${value}`);
    }
  });

  test('参数颠倒时仍返回区间内的值', () => {
    const rng = createMathRng();
    for (let i = 0; i < 100; i++) {
      const value = rng.int(6, 1);
      assert.ok(value >= 1 && value <= 6, `out of range: ${value}`);
    }
  });

  test('非有限数范围直接报错（不再静默返回区间外的 0）', () => {
    const rng = createMathRng();
    assert.throws(() => rng.int(1, Number.NaN), RangeError);
    assert.throws(() => rng.int(Number.POSITIVE_INFINITY, 6), RangeError);
    assert.throws(() => rng.int(Number.NEGATIVE_INFINITY, 6), RangeError);
  });
});
