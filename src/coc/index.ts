/**
 * CoC 规则引擎入口 —— `createCocRules(dice)` 组装 `/st` `/rc` `/ra` `/sc` `/en` 的解析与掷骰。
 *
 * 契约：bot/src/contracts/coc.ts（冻结）。本目录（`src/coc/**`）只依赖 contracts + DiceEngine 契约，
 * 不依赖 T1 的具体实现，因此测试可注入 stub DiceEngine。
 */
import type { CocRules, CheckOptions, SanityOptions, ImproveOptions, StResult, CheckResult, SanityResult, ImproveResult, ParsedCheck, CocFailure } from '../contracts/coc.ts';
import type { CharacterSheet } from '../contracts/model.ts';
import type { DiceEngine } from '../contracts/dice.ts';
import type { Rng } from '../contracts/rng.ts';
import { canonicalAttr } from './attrs.ts';
import { parseCheck, runCheck } from './check.ts';
import { runImprove } from './improve.ts';
import { resolveRollExpression } from './resolve.ts';
import { runSanity } from './sanity.ts';
import { runApplySt } from './st.ts';

export function createCocRules(dice: DiceEngine): CocRules {
  const rng: Rng = {
    int: (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1)),
  };
  return {
    applySt(text: string, sheet: CharacterSheet | null): StResult {
      return runApplySt(dice, text, sheet, new Date().toISOString(), rng);
    },
    check(text: string, opts: CheckOptions): CheckResult {
      return runCheck(dice, text, opts);
    },
    sanity(text: string, opts: SanityOptions): SanityResult {
      return runSanity(dice, text, opts);
    },
    improve(text: string, opts: ImproveOptions): ImproveResult {
      return runImprove(dice, text, opts);
    },
    parseCheck(text: string): ParsedCheck | CocFailure {
      return parseCheck(text);
    },
    resolveRollExpression(sheet: CharacterSheet | null, text: string): string | null {
      return resolveRollExpression(sheet, text);
    },
    canonicalAttr,
  };
}

export { canonicalAttr } from './attrs.ts';
export { successLevel, isDoubles } from './houseRule.ts';
export { parseCheck, runCheck } from './check.ts';
export { runSanity } from './sanity.ts';
export { runImprove } from './improve.ts';
export { runApplySt } from './st.ts';
export { resolveRollExpression } from './resolve.ts';
export type { ParsedCheckText } from './check.ts';

export type {
  CocRules,
  CocFailure,
  StResult,
  CheckResult,
  SanityResult,
  ImproveResult,
  CheckOptions,
  SanityOptions,
  ImproveOptions,
  ParsedCheck,
  CharacterSheet,
  DiceEngine,
  Rng,
};
