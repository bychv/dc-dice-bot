/**
 * Deterministic fake Rng helpers for the dice tests.
 */
import assert from 'node:assert/strict';
import type { Rng } from '../../src/contracts/rng.ts';

export interface FakeRng extends Rng {
  /** number of calls made so far */
  readonly calls: number;
}

/** Returns the given values in order; asserts every value is in range. */
export function sequenceRng(values: number[]): FakeRng {
  let index = 0;
  return {
    get calls(): number {
      return index;
    },
    int(min: number, max: number): number {
      const value = values[index];
      assert.ok(value !== undefined, `fake Rng exhausted after ${index} call(s), wanted [${min}, ${max}]`);
      assert.ok(
        Number.isInteger(value) && value >= min && value <= max,
        `fake Rng value ${String(value)} is outside [${min}, ${max}]`,
      );
      index++;
      return value;
    },
  };
}

/** Always returns the minimum of the requested range. */
export function minRng(): FakeRng {
  let calls = 0;
  return {
    get calls(): number {
      return calls;
    },
    int(min: number): number {
      calls++;
      return min;
    },
  };
}

/** Always returns the maximum of the requested range. */
export function maxRng(): FakeRng {
  let calls = 0;
  return {
    get calls(): number {
      return calls;
    },
    int(_min: number, max: number): number {
      calls++;
      return max;
    },
  };
}

/** Descending roll sequence: `count, count-1, ..., 1`. */
export function descendingValues(count: number): number[] {
  return Array.from({ length: count }, (_, index) => count - index);
}
