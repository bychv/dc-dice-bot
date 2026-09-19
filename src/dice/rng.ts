/**
 * Math.random-backed `Rng` (owner: `src/dice/**`).
 * Tests always inject a fake `Rng`; production uses this one.
 */
import type { Rng } from '../contracts/rng.ts';

export function createMathRng(): Rng {
  return {
    int(min: number, max: number): number {
      // 非有限数直接报错：契约承诺"返回区间内的整数"，旧实现返回 0（可能落在区间外）
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        throw new RangeError(`随机数范围必须是有限数（收到 ${String(min)}-${String(max)}）`);
      }
      let low = Math.ceil(min);
      let high = Math.floor(max);
      // 端点颠倒时按升序处理（防御性；引擎不会这样调用）
      if (high < low) [low, high] = [high, low];
      return low + Math.floor(Math.random() * (high - low + 1));
    },
  };
}
