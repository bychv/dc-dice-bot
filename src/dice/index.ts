/**
 * Public surface of the dice module (owner: `src/dice/**`).
 *
 *   import { createDiceEngine, parseRollText, renderRoll, createMathRng } from './dice/index.ts';
 */
export { createDiceEngine } from './engine.ts';
export { parseRollText } from './text.ts';
export { renderRoll } from './render.ts';
export { createMathRng } from './rng.ts';
export { parseExpression, isDiceTerm } from './expression.ts';
export type { ConstTerm, DiceTerm, ParsedExpression, ParsedExpressionResult, Term } from './expression.ts';
export type { DiceEngine, DieGroup, PercentileResult, RollResult, RollTextParse } from '../contracts/dice.ts';
export type { Rng } from '../contracts/rng.ts';
