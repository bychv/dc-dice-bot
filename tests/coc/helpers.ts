/**
 * 测试工具：确定性 Rng、stub DiceEngine、角色卡工厂。
 *
 * T1 的 `src/dice/**` 未落地时测试也完全可跑（契约只有两个方法）。
 */
import type { DiceEngine, RollResult } from '../../src/contracts/dice.ts';
import type { Rng } from '../../src/contracts/rng.ts';
import type { CharacterSheet } from '../../src/contracts/model.ts';

/** 按给定序列返回随机整数（越界则夹紧到 [min,max]）；耗尽后循环。 */
export function seqRng(values: number[]): Rng {
  let index = 0;
  return {
    int(min: number, max: number): number {
      const raw = values[index % values.length];
      index++;
      return Math.min(max, Math.max(min, raw));
    },
  };
}

export function testSheet(
  attrs: Record<string, string> = {},
  exprs: Record<string, string> = {},
): CharacterSheet {
  return {
    name: '测试卡',
    template: 'COC7',
    attrs,
    exprs,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

function okResult(expression: string, groups: { sides: number; values: number[] }[], total: number): RollResult {
  return {
    ok: true,
    expression,
    rounds: 1,
    groups,
    modifier: 0,
    totals: [total],
    total,
    sorted: false,
  };
}

/** 最小骰式求值：支持常量与 `NdM` 的加减求和，够 `/st`、`/sc`、`/en` 测试用。 */
function evalExpression(expression: string, rng: Rng): RollResult {
  const norm = expression.replace(/\s+/g, '');
  if (!norm) return { ok: false, error: 'empty expression' };
  if (/^[+-]?\d+$/.test(norm)) {
    return okResult(norm, [], Number.parseInt(norm, 10));
  }
  const terms = norm.match(/[+-]?[^+-]+/g);
  if (!terms) return { ok: false, error: `cannot parse: ${expression}` };
  const groups: { sides: number; values: number[] }[] = [];
  let total = 0;
  for (const term of terms) {
    const sign = term.startsWith('-') ? -1 : 1;
    const body = term.replace(/^[+-]/, '');
    const dice = /^(\d*)[dD](\d+)$/.exec(body);
    if (dice) {
      const count = dice[1] ? Number.parseInt(dice[1], 10) : 1;
      const sides = Number.parseInt(dice[2], 10);
      const values: number[] = [];
      for (let i = 0; i < count; i++) values.push(rng.int(1, sides));
      groups.push({ sides, values });
      total += sign * values.reduce((a, b) => a + b, 0);
      continue;
    }
    if (/^\d+$/.test(body)) {
      total += sign * Number.parseInt(body, 10);
      continue;
    }
    return { ok: false, error: `unsupported term: ${term}` };
  }
  return okResult(norm, groups, total);
}

export function stubDice(): DiceEngine {
  return {
    percentile(opts, rng) {
      const value = rng.int(1, 100);
      return {
        ok: true,
        value,
        tens: Math.floor(value / 10) % 10,
        units: value % 10,
        candidates: [value],
        bonus: opts.bonus ?? 0,
        penalty: opts.penalty ?? 0,
      };
    },
    roll(expression, rng) {
      return evalExpression(expression, rng);
    },
  };
}
