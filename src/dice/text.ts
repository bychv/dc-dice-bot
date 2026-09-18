/**
 * `/r`-family argument splitting (owner: `src/dice/**`).
 *
 * Mirrors DiceEvent.cpp's `.r` handler: the dice expression is the leading run of
 * expression characters, the rest of the line is the human-readable reason, and a
 * leading `N#` is the round count (1-10).
 *
 *   parseRollText('1d4+2 中型刀伤害') -> { expression: '1d4+2', reason: '中型刀伤害', rounds: 1 }
 *   parseRollText('3#1d6 3发.22伤害') -> { expression: '1d6',   reason: '3发.22伤害',  rounds: 3 }
 *   parseRollText('沙漠之鹰')         -> { expression: '沙漠之鹰', rounds: 1 }
 *
 * Never throws. The returned `expression` is still raw (a card expression name is
 * possible), so callers resolve names first and then hand the expression to `roll()`.
 */
import type { RollTextParse } from '../contracts/dice.ts';

const ROUND_PREFIX = /^(\d+)#/;
const WHITESPACE = /\s/;

export function parseRollText(text: string): RollTextParse {
  const source = typeof text === 'string' ? text : '';
  const trimmed = source.replace(/^\s+/, '').replace(/\s+$/, '');
  if (trimmed === '') return { expression: '', rounds: 1 };

  let rest = trimmed;
  let rounds = 1;
  const match = ROUND_PREFIX.exec(rest);
  if (match) {
    const candidate = Number(match[1]);
    // out-of-range counts stay in the expression so `roll()` can report the error
    if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 10) {
      rounds = candidate;
      rest = rest.slice((match[0] as string).length);
    }
  }

  const separator = rest.search(WHITESPACE);
  if (separator === -1) return { expression: rest, rounds };

  const expression = rest.slice(0, separator);
  const reason = rest.slice(separator).replace(/^\s+/, '').replace(/\s+$/, '');
  if (reason === '') return { expression, rounds };
  return { expression, reason, rounds };
}
