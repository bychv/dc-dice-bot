/**
 * Math.random-backed `Rng` (owner: `src/dice/**`).
 * Tests always inject a fake `Rng`; production uses this one.
 */
import type { Rng } from '../contracts/rng.ts';

export function createMathRng(): Rng {
  return {
    int(min: number, max: number): number {
      let low = Math.ceil(min);
      let high = Math.floor(max);
      if (!Number.isFinite(low) || !Number.isFinite(high)) return 0;
      if (high < low) [low, high] = [high, low];
      return low + Math.floor(Math.random() * (high - low + 1));
    },
  };
}
