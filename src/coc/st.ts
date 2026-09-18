/**
 * `/st` 属性录入（整行原文解析）。
 *
 * 依据 docs/Discord_CoC_Command_Set.md §6.1 与 ref/Dice/Dice/DiceEvent.cpp `pref2 == "st"`
 * （第 3950-4228 行）：
 * - `名称:值` / `名称=值`，多组以空格分隔；
 * - 值以 `+` / `-` 开头 → 基于原值修改（`RD(old + readDice())`，可含骰式）；
 * - `&名称=表达式` → 存入 exprs，供 `/r` `/rs` 调用；
 * - `名称::子项+值` → 原样透传 `::` 语义（本集不做多卡联动，仅剥离卡名前缀）；
 * - `show [属性名]` / `del [属性名]` / `clr` 由文本前缀决定；
 * - 属性名按同义词归一化后写入（`CharaCard::set` 内部 `standard()`）；
 * - **连写模式**（外部骰娘导出的无分隔符卡片串，如 `力量40str40敏捷80…`）：
 *   现有语法都不匹配时才启用，见 `looksLikeConcatenatedCard` / `applyConcatenatedCard`；
 * - **前导指令名兼容**：粘贴过来的整行命令（`.st 力量:50`、`.st力量40str40…`、`/st …`）
 *   先用 `stripStPrefix` 剥掉前缀再解析。
 *
 * 所有更新均为不可变更新：原 sheet 不被修改，返回新的 sheet。
 */
import { COC7_DEFAULT_TEMPLATE } from '../contracts/model.ts';
import type { CharacterSheet } from '../contracts/model.ts';
import type { StResult } from '../contracts/coc.ts';
import type { DiceEngine } from '../contracts/dice.ts';
import type { Rng } from '../contracts/rng.ts';
import {
  canonicalAttr,
  findAttrValue,
  findExpr,
  isKnownNameRun,
  splitConcatenatedNames,
  stripCardPrefix,
} from './attrs.ts';
import { evalExpr } from './expr.ts';

function hasOwn(record: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * 兼容粘贴：从骰娘里复制的整行命令常带前导指令名（`.st 力量:50`、`.st力量40str40…`、
 * `/st 力量:50`、全角 `.` / `！`），解析前先剥掉这层前缀——**只剥开头一次**，卡内文本不动。
 * 前缀后无论是空格、中文还是数字都能剥（`.st力量40` 也是合法输入）。
 */
export function stripStPrefix(text: string): string {
  return (text ?? '').replace(/^\s*[.\/。!！]st/i, '').trim();
}

/** `show`（不带属性名）压缩排版：同一行能塞多少条 `名称:值` 就塞多少，超宽才换行。 */
const SHOW_ROW_WIDTH = 90;

/** `show` 全量列表的字符预算——Discord 单条消息 2000 字，这里留出标题与截断提示的余量。 */
const SHOW_MAX_CHARS = 1500;

/**
 * 把 `名称:值` 条目按显示宽度打包成行：一行塞不下就换行。
 * 参见 `ref/Dice/Dice/CharacterCard.cpp:398-405`（数字属性用空格分隔、不逐条换行）。
 */
function packShowRows(entries: string[], width = SHOW_ROW_WIDTH): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const entry of entries) {
    if (current.length === 0) {
      current = [entry];
      length = entry.length;
      continue;
    }
    if (length + 1 + entry.length <= width) {
      current.push(entry);
      length += 1 + entry.length;
      continue;
    }
    rows.push(current);
    current = [entry];
    length = entry.length;
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

function blankSheet(now: string): CharacterSheet {
  return {
    name: '',
    template: COC7_DEFAULT_TEMPLATE,
    attrs: {},
    exprs: {},
    createdAt: now,
    updatedAt: now,
  };
}

function withUpdated(
  base: CharacterSheet,
  attrs: Record<string, string>,
  exprs: Record<string, string>,
  now: string,
): CharacterSheet {
  return { ...base, attrs, exprs, updatedAt: now };
}

function toInt(value: string): number | null {
  const text = (value ?? '').trim();
  if (!/^[+-]?\d+$/.test(text)) return null;
  return Number.parseInt(text, 10);
}

function isDigitChar(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/**
 * 连写模式判定——只有「既有语法都不匹配」时才为 true：
 * - 含空白 / `:` / `=` / `&` → 既有语法（多组、名称:值、表达式）；
 * - 含 `+` / `-` / `*` → 相对修改或骰式乘号（连写卡片串只有名字与数字）；
 * - 以数字开头 → 数值/骰式；
 * - 必须有数字段；
 * - 且「首个名字段能切出 ≥2 个**已知**名」或「存在能被字典完整切分的名字段」：
 *   这样 `电话12345678分机01` 这类文本值仍走既有路径（`电话` 不是已知卡名）。
 */
function looksLikeConcatenatedCard(raw: string): boolean {
  if (/[+\-*=:&\s]/.test(raw)) return false;
  if (/^\d/.test(raw)) return false;
  const digitRuns = raw.match(/\d+/g);
  if (!digitRuns || digitRuns.length === 0) return false;
  const segments = raw.split(/\d+/);
  const firstRun = segments[0] ?? '';
  const firstRunKnown = firstRun ? splitConcatenatedNames(firstRun).known.filter(Boolean).length : 0;
  if (firstRunKnown >= 2) return true;
  return segments.some((segment) => segment.length > 0 && isKnownNameRun(segment));
}

interface ConcatenatedCard {
  /** 最终写入的 规范名 -> 值（同槽重复写取最后一次） */
  values: Map<string, string>;
  /** 无值 / 同义重复而被跳过的原始名字（按出现顺序去重） */
  skipped: string[];
  /** 字典外、被当作自定义技能的名字（按出现顺序去重） */
  custom: string[];
}

/**
 * 连写卡片串：线性扫描成「非数字段」与「数字段」交替。
 * - 非数字段：字典最长匹配切分（`splitConcatenatedNames`），字典外片段整体作为自定义技能名；
 * - 数字段：赋给该段前一个非数字段里的**最后一个**名字，更早的名字视为同义重复/无值 → 跳过；
 * - 没有后续数字的名字段（源数据缺值，如样本里的 `mp魔法hp体力`）同样只跳过、不臆造数值。
 */
function parseConcatenatedCard(raw: string): ConcatenatedCard {
  const entries: { name: string; value: string; known: boolean }[] = [];
  const skipped: string[] = [];
  const custom: string[] = [];
  let index = 0;
  while (index < raw.length) {
    let start = index;
    while (index < raw.length && !isDigitChar(raw[index])) index++;
    const text = raw.slice(start, index);
    start = index;
    while (index < raw.length && isDigitChar(raw[index])) index++;
    const digits = raw.slice(start, index);
    if (!text) continue; // 开头的数字段没有前导名字，忽略
    const { names, known } = splitConcatenatedNames(text);
    if (!digits) {
      for (const name of names) skipped.push(name);
      continue;
    }
    for (let i = 0; i < names.length - 1; i++) skipped.push(names[i]);
    const name = names[names.length - 1];
    const isKnown = known[known.length - 1] ?? false;
    entries.push({ name, value: String(Number.parseInt(digits, 10)), known: isKnown });
    if (!isKnown) custom.push(name);
  }

  const values = new Map<string, string>();
  for (const entry of entries) values.set(canonicalAttr(entry.name), entry.value);
  return { values, skipped: [...new Set(skipped)], custom: [...new Set(custom)] };
}

/** 连写模式落卡；没有解析出任何值（应回退既有路径）时返回 null。 */
function applyConcatenatedCard(base: CharacterSheet, raw: string, now: string): StResult | null {
  const parsed = parseConcatenatedCard(raw);
  if (parsed.values.size === 0) return null;

  const attrs = { ...base.attrs };
  for (const [key, value] of parsed.values) attrs[key] = value;

  const lines: string[] = [`连写识别：共写入 ${parsed.values.size} 条属性。`];
  if (parsed.skipped.length > 0) lines.push(`跳过无值/重复：${parsed.skipped.join('、')}`);
  if (parsed.custom.length > 0) lines.push(`自定义技能：${parsed.custom.join('、')}`);
  lines.push([...parsed.values].map(([key, value]) => `${key}=${value}`).join('、'));

  return {
    ok: true,
    op: 'set',
    lines,
    sheet: withUpdated(base, attrs, { ...base.exprs }, now),
  };
}

/** `/st` 主入口（rng 用于 `hp-1D6` 这类相对修改里的骰式）。 */
export function runApplySt(
  dice: DiceEngine,
  text: string,
  sheet: CharacterSheet | null,
  now: string,
  rng: Rng,
): StResult {
  const raw = stripStPrefix(text ?? '');
  if (!raw) return { ok: false, error: '请提供属性内容，例如：力量:50' };

  // —— clr ——
  if (/^clr(?=\s|$)/i.test(raw)) {
    const base = sheet ?? blankSheet(now);
    return { ok: true, op: 'clr', lines: ['已清空角色卡'], sheet: withUpdated(base, {}, {}, now) };
  }

  // —— del [属性名] ——
  if (/^del(?=\s|$)/i.test(raw)) {
    const names = raw.slice(3).trim().split(/\s+/).filter(Boolean);
    if (names.length === 0) return { ok: false, error: '请提供要删除的属性名，例如：del 侦查' };
    const base = sheet ?? blankSheet(now);
    const attrs = { ...base.attrs };
    const exprs = { ...base.exprs };
    const lines: string[] = [];
    let changed = false;
    for (const name of names) {
      const canonical = canonicalAttr(stripCardPrefix(name));
      let hit = false;
      for (const key of new Set([stripCardPrefix(name), canonical])) {
        if (hasOwn(attrs, key)) {
          delete attrs[key];
          hit = true;
        }
      }
      for (const key of new Set([stripCardPrefix(name), canonical])) {
        for (const candidate of [key, `&${key}`]) {
          if (hasOwn(exprs, candidate)) {
            delete exprs[candidate];
            hit = true;
          }
        }
      }
      lines.push(hit ? `已删除 ${canonical}` : `${canonical}≠ 未找到`);
      changed = changed || hit;
    }
    return {
      ok: true,
      op: 'del',
      lines,
      sheet: changed ? withUpdated(base, attrs, exprs, now) : undefined,
    };
  }

  // —— show [属性名] ——
  if (/^show(?=\s|$)/i.test(raw)) {
    const base = sheet ?? blankSheet(now);
    const arg = stripCardPrefix(raw.slice(4).trim()).trim();
    if (!arg) {
      const attrEntries = Object.entries(base.attrs).map(([key, value]) => `${key}:${value}`);
      const exprEntries = Object.entries(base.exprs).map(([key, value]) => `${key}=${value}`);
      if (attrEntries.length === 0 && exprEntries.length === 0) {
        return { ok: true, op: 'show', lines: ['（角色卡为空）'] };
      }
      const header =
        `【${base.name || '未命名'}】${attrEntries.length} 项属性` +
        (exprEntries.length > 0 ? `，${exprEntries.length} 条表达式` : '');
      const rows = packShowRows([...attrEntries, ...exprEntries]);
      const lines = [header];
      let used = header.length;
      let shown = 0;
      for (const row of rows) {
        const text = row.join(' ');
        if (shown > 0 && used + text.length + 1 > SHOW_MAX_CHARS) break;
        lines.push(text);
        used += text.length + 1;
        shown += row.length;
      }
      const total = attrEntries.length + exprEntries.length;
      if (shown < total) {
        lines.push(`…还有 ${total - shown} 项未显示；用 \`/st show <属性名>\` 查单个属性。`);
      }
      return { ok: true, op: 'show', lines };
    }
    const name = arg.split(/\s+/)[0] ?? arg;
    const attr = findAttrValue(base, name);
    if (attr) return { ok: true, op: 'show', lines: [`${attr.key}: ${attr.value}`] };
    const expr = findExpr(base, name);
    if (expr) return { ok: true, op: 'show', lines: [`${expr.key}=${expr.expr}`] };
    return { ok: true, op: 'show', lines: [`${canonicalAttr(name)}≠ 未找到`] };
  }

  // —— 名称:值 / 名称=值 / &名称=表达式 ——
  const base = sheet ?? blankSheet(now);

  // —— 连写模式（外部骰娘导出的无分隔符卡片串），仅在既有语法都不匹配时启用 ——
  if (looksLikeConcatenatedCard(raw)) {
    const concatenated = applyConcatenatedCard(base, raw, now);
    if (concatenated) return concatenated;
  }

  const attrs = { ...base.attrs };
  const exprs = { ...base.exprs };
  const lines: string[] = [];
  let changed = false;
  let hasSet = false;
  let hasModify = false;
  let hasExpr = false;

  // 同一行里后一个分组要能看到前一个分组的写入（`力量:50 力量+1` => 51）。
  const lookup = (name: string): { key: string; value: string } | null => {
    const canonical = canonicalAttr(name);
    for (const key of name === canonical ? [name] : [name, canonical]) {
      if (hasOwn(attrs, key)) return { key, value: attrs[key] };
    }
    return null;
  };

  for (const tokenRaw of raw.split(/\s+/).filter(Boolean)) {
    const token = stripCardPrefix(tokenRaw);
    if (!token) continue;

    if (token.startsWith('&')) {
      const body = token.slice(1);
      const at = body.search(/[=:]/);
      const name = at > 0 ? body.slice(0, at).trim() : '';
      const expr = at > 0 ? body.slice(at + 1).trim() : '';
      if (!name || !expr) {
        lines.push(`&${body}≠ 表达式格式应为 &名称=表达式`);
        continue;
      }
      const key = canonicalAttr(name);
      exprs[key] = expr;
      lines.push(`${key}=${expr}`);
      hasExpr = true;
      changed = true;
      continue;
    }

    let cursor = 0;
    while (cursor < token.length && !/[\d=:+\-*/]/.test(token[cursor])) cursor++;
    const rawName = token.slice(0, cursor).trim();
    const rest = token.slice(cursor).replace(/^[=:]+/, '');
    if (!rawName || !rest) {
      lines.push(`${rawName || token}≠ 无法解析`);
      continue;
    }

    const name = canonicalAttr(rawName);
    const found = lookup(rawName);
    const key = found ? found.key : name;

    if (rest.startsWith('+') || rest.startsWith('-')) {
      const old = found ? toInt(found.value) : 0;
      if (old === null) {
        lines.push(`${name}≠ 原值「${found?.value ?? ''}」不是数字`);
        continue;
      }
      const delta = evalExpr(dice, rest, rng);
      if (!delta.ok) {
        lines.push(`${name}≠ ${delta.error}`);
        continue;
      }
      const next = old + delta.total;
      attrs[key] = String(next);
      lines.push(`${name}: ${old}->${next}`);
      hasModify = true;
      changed = true;
      continue;
    }

    const oldText = found?.value;
    if (/^[+-]?\d+$/.test(rest)) {
      const next = Number.parseInt(rest, 10);
      if (oldText !== undefined && toInt(oldText) === next) {
        lines.push(`${name}: ${next}`);
        hasSet = true;
        continue;
      }
      attrs[key] = String(next);
      lines.push(oldText === undefined ? `${name}: ${next}` : `${name}: ${oldText}->${next}`);
      hasSet = true;
      changed = true;
      continue;
    }

    if (oldText === rest) {
      lines.push(`${name}: ${rest}`);
      hasSet = true;
      continue;
    }
    attrs[key] = rest;
    lines.push(oldText === undefined ? `${name}: ${rest}` : `${name}: ${oldText}->${rest}`);
    hasSet = true;
    changed = true;
  }

  if (lines.length === 0) return { ok: false, error: `无法解析：${raw}` };

  const op = hasSet ? 'set' : hasModify ? 'modify' : hasExpr ? 'expr' : 'set';
  return {
    ok: true,
    op,
    lines,
    sheet: changed ? withUpdated(base, attrs, exprs, now) : undefined,
  };
}
