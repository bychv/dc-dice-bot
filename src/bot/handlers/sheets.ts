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
