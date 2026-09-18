/**
 * Injectable randomness. Every随机 path in the bot takes an `Rng`, so tests are fully deterministic.
 */
export interface Rng {
  /** Returns an integer in the inclusive range [min, max]. */
  int(min: number, max: number): number;
}
