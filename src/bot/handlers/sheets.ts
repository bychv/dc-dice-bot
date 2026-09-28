/**
 * Character-sheet helpers (`/pc`, `/st`). A sheet is always user-owned; persistence goes
 * through `BotStore` (docs §5.1, §6.1).
 */
import type { CharacterSheet } from '../../contracts/model.ts';
import { COC7_DEFAULT_TEMPLATE } from '../../contracts/model.ts';
import type { BotStore } from '../../contracts/store.ts';

export const MAX_SHEETS_PER_USER = 16;

export function createSheet(name: string, template: string, now: Date): CharacterSheet {
  const stamp = now.toISOString();
  return { name, template, attrs: {}, exprs: {}, createdAt: stamp, updatedAt: stamp };
}

/** Unique per user; conflicting names get a numeric suffix. */
export function uniqueSheetName(store: BotStore, userId: string, base: string): string {
  const existing = new Set(store.listSheets(userId).map((s) => s.name));
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} ${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/** COC7 9 项主属性按 3d6×5 生成（docs §5.1 `build` / `redo`）。 */
export const COC7_PRIMARY_ATTRS: readonly string[] = [
  '力量',
  '体质',
  '体型',
  '敏捷',
  '外貌',
  '智力',
  '意志',
  '教育',
  '幸运',
];

export type IntRng = { int(min: number, max: number): number };

export function rollCoc7Attrs(rng: IntRng): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of COC7_PRIMARY_ATTRS) {
    let sum = 0;
    for (let i = 0; i < 3; i += 1) sum += rng.int(1, 6);
    attrs[attr] = String(sum * 5);
  }
  return attrs;
}

/** CoC 7e 手册的掷法：`(2d6+6)×5` 的属性（体型/智力/教育）。 */
export const COC7_BONUS6_ATTRS: readonly string[] = ['体型', '智力', '教育'];

export interface Coc7RolledCard {
  /** 8 项基础属性（不含幸运） */
  attrs: Record<string, string>;
  /** 幸运 3d6×5 */
  luck: number;
  /** 8 项基础属性总值 */
  baseTotal: number;
  /** 8 项基础属性 + 幸运 的总值 */
  totalWithLuck: number;
}

/**
 * **CoC 7e 标准掷法**掷一张调查员卡（docs §5.4 `/coc`）：
 *   力量/体质/敏捷/外貌/意志 = 3d6×5；体型/智力/教育 = (2d6+6)×5；幸运 = 3d6×5。
 * （`rollCoc7Attrs` 是简化的"全部 3d6×5"，`/pc new` 仍在用它，两者刻意分开。）
 */
export function rollCoc7Card(rng: IntRng): Coc7RolledCard {
  const d6 = (): number => rng.int(1, 6);
  const threeD6 = (): number => d6() + d6() + d6();
  const attrs: Record<string, string> = {};
  let baseTotal = 0;
  for (const attr of COC7_PRIMARY_ATTRS) {
    if (attr === '幸运') continue;
    const dice = COC7_BONUS6_ATTRS.includes(attr) ? d6() + d6() + 6 : threeD6();
    const value = dice * 5;
    attrs[attr] = String(value);
    baseTotal += value;
  }
  const luck = threeD6() * 5;
  return { attrs, luck, baseTotal, totalWithLuck: baseTotal + luck };
}

/** `show`-style listing: attributes then stored roll expressions. */
export function renderSheet(sheet: CharacterSheet): string[] {
  const lines: string[] = [`【${sheet.name}】模板 ${sheet.template}`];
  const attrs = Object.entries(sheet.attrs);
  lines.push(attrs.length > 0 ? `属性：${attrs.map(([k, v]) => `${k}:${v}`).join('  ')}` : '属性：（空）');
  const exprs = Object.entries(sheet.exprs);
  if (exprs.length > 0) lines.push(`表达式：${exprs.map(([k, v]) => `${k}=${v}`).join('  ')}`);
  lines.push(`更新于 ${sheet.updatedAt}`);
  return lines;
}

export { COC7_DEFAULT_TEMPLATE };
