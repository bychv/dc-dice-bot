/**
 * CoC rule engine contract — owner: `src/coc/**`.
 *
 * All entry points take the **raw text after the command name** (整行原文解析,
 * docs §1.3) plus the caller's sheet context, and return rendered lines + an
 * optional updated sheet for the caller to persist.
 */
import type { CharacterSheet, HouseRule, SuccessLevel } from './model';
import type { Rng } from './rng';
import type { DiceEngine } from './dice';

export interface CocFailure {
  ok: false;
  error: string;
}

/** `/st` result. */
export interface StSuccess {
  ok: true;
  op: 'set' | 'modify' | 'expr' | 'show' | 'del' | 'clr';
  lines: string[];
  /** present when the sheet was mutated (caller persists it) */
  sheet?: CharacterSheet;
}

export type StResult = StSuccess | CocFailure;

export interface CheckRound {
  roll: number;
  target: number;
  level: SuccessLevel;
}

/** `/rc`, `/ra` result (multi-round aware). */
export interface CheckSuccess {
  ok: true;
  /** resolved skill/attribute name after synonym + keyword handling */
  skillName: string;
  /** effective target after `*5`, `-10`, difficulty tiers … */
  target: number;
  rule: HouseRule;
  rounds: number;
  details: CheckRound[];
  /** rendered chat lines */
  lines: string[];
  reason?: string;
}

export type CheckResult = CheckSuccess | CocFailure;

export interface SanityRound {
  roll: number;
  level: SuccessLevel;
  loss: number;
  /** san after applying the loss of this round (null when unknown) */
  sanAfter: number | null;
}

/** `/sc` result. */
export interface SanitySuccess {
  ok: true;
  rule: HouseRule;
  rounds: number;
  details: SanityRound[];
  /** san before/after, null when the sheet/param has no san */
  sanBefore: number | null;
  sanAfter: number | null;
  lines: string[];
  reason?: string;
  sheet?: CharacterSheet;
}

export type SanityResult = SanitySuccess | CocFailure;

/** `/en` result. */
export interface ImproveSuccess {
  ok: true;
  skillName: string;
  before: number | null;
  roll: number;
  /** growth amount (0 when the check failed) */
  gained: number;
  after: number | null;
  lines: string[];
  reason?: string;
  sheet?: CharacterSheet;
}

export type ImproveResult = ImproveSuccess | CocFailure;

export interface CheckOptions {
  sheet: CharacterSheet | null;
  rule: HouseRule;
  rng: Rng;
}

export interface SanityOptions extends CheckOptions {
  /** 无角色卡时由调用方给出的当前 san（`/sc 0/1 70`） */
  sanOverride?: number | null;
}

export interface ImproveOptions extends CheckOptions {
  /** 无角色卡时由调用方给出的技能值（`/en 教育 60`） */
  valueOverride?: number | null;
}

/** Given a raw text argument, the pieces the caller needs before rolling. */
export interface ParsedCheck {
  skillName: string;
  /**
   * 原文里解析出的**原始成功率**（未应用难度除数）。
   * 例如 `困难智力 99` → 99；`check()` 内部再按难度取 floor(target/2)。
   * 为 null 表示原文未给成功率，需读角色卡。
   */
  target: number | null;
  rounds: number;
  bonus: number;
  penalty: number;
  /** difficulty keyword detected in the skill text */
  difficulty: 'normal' | 'hard' | 'extreme' | 'auto';
}

/** Text parsers are separate so the bot layer can drive them (autocomplete, validation). */
export interface CocRules {
  /** `/st` */
  applySt(text: string, sheet: CharacterSheet | null): StResult;
  /** `/rc` `,` `/ra` */
  check(text: string, opts: CheckOptions): CheckResult;
  /** `/sc` */
  sanity(text: string, opts: SanityOptions): SanityResult;
  /** `/en` */
  improve(text: string, opts: ImproveOptions): ImproveResult;
  /** parse `/rc` argument without rolling (used by tests + autocomplete) */
  parseCheck(text: string): ParsedCheck | CocFailure;
  /**
   * Resolve a `/r` expression source: `沙漠之鹰` -> card expression, `hp` -> numeric value.
   * Returns null when the text is a raw dice expression (caller passes it to the dice engine).
   */
  resolveRollExpression(sheet: CharacterSheet | null, text: string): string | null;
  /** 属性同义词归一化（智力/灵感、理智/san、侦查/侦察） */
  canonicalAttr(name: string): string;
}

export type { CharacterSheet, HouseRule, SuccessLevel, DiceEngine };
