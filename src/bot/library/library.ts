/**
 * Dice! 词库 —— `/help` 与 `/rules` 的知识库。
 *
 * 内容优先级（后者覆盖前者）：
 *   1. 本机 Discord 适配词条（`./discord-entries.ts`，Dice! 内置帮助里没有 Discord 专有命令）
 *   2. Dice! 内置词条（`./dice-defaults.json`，由 `scripts/import-dice-library.ts` 从
 *      `ref/Dice/Dice/GlobalVar.cpp` 的 `PlainMsg` / `HelpDoc` 抽取）
 *   3. 外部词库（`opts.dir` 或环境变量 `DICE_LIBRARY_DIR` 指向的目录里的 `*.json` / `*.yaml`）
 *
 * 外部词库目录约定：
 *   - 只读该目录**第一层**的 `*.json` / `*.yaml` / `*.yml`，按文件名排序依次加载，后加载的覆盖先加载的；
 *   - JSON 支持 Dice! 风格 `{ "entries": {词条: 文本}, "messages": {key: 文案} }` 与扁平
 *     `{ 词条: 文本 }`；YAML 只需最简单的 `词条: 文本`、引号标量、`|`/`>` 块标量，以及
 *     一层 `entries:` / `messages:` 缩进映射（不引入 yaml 依赖）；
 *   - 读不了 / 解析失败 / 非字符串项一律跳过并记入 `warnings()`，绝不抛异常中断启动。
 *
 * 词条文本按 Dice! 语义处理：以 `&` 开头的值是**别名**（指向同表中另一个词条，见
 * `DiceMod.cpp::format`），`lookup()` 会跟随别名链（带环保护）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import { DISCORD_HELP_ENTRIES, DISCORD_RULE_ENTRIES } from './discord-entries.ts';

/** 词条来源：外部词库 > Dice! 内置 > 本机 Discord 适配。 */
export type LibrarySource = 'external' | 'dice' | 'discord';

export interface LibraryLookup {
  /** 命中的规范化词条名（别名会换成被指向的词条名）。 */
  term: string;
  /** 词条正文（已去除首尾空白；`&别名` 已解析）。 */
  text: string;
  source: LibrarySource;
}

export interface LibraryStats {
  /** Dice! 内置默认文案（`PlainMsg`）条数。 */
  messages: number;
  /** Dice! 内置帮助词条（`HelpDoc`）条数。 */
  entries: number;
  /** 是否加载到了外部词库。 */
  external: boolean;
  /** 成功解析的外部词库文件数。 */
  externalFiles: number;
  /** 本机 Discord 适配词条数。 */
  discord: number;
  /** 可查询词条总数（三来源去重后）。 */
  terms: number;
}

export interface LibraryOptions {
  /** 外部词库目录；省略时看 `DICE_LIBRARY_DIR`（空字符串视为未设置）。 */
  dir?: string | null;
  /** 便于测试注入的环境变量表，默认 `process.env`。 */
  env?: Record<string, string | undefined>;
}

export interface DiceLibrary {
  /** `/help` 无参总览：Dice! 的 `strHlpMsg` 原文（加载失败时为空串）。 */
  overview(): string;
  /** 取内置默认文案（`getMsg(key)` 的离线近似），`&别名` 会解析。 */
  message(key: string): string | null;
  /** 精确 → 大小写不敏感 → 别名链。 */
  lookup(term: string): LibraryLookup | null;
  /** 供「你是不是想找」：前缀/子串/编辑距离，得分升序，稳定排序。 */
  suggest(term: string, limit?: number): string[];
  /** 全部可查询词条名（码元升序）。 */
  terms(): string[];
  stats(): LibraryStats;
  /** 加载期间的问题（缺目录、坏文件、跳过项…），只读快照。 */
  warnings(): string[];
  /** 生效的外部词库目录（绝对路径），未配置时为 null。 */
  dir(): string | null;
}

interface DefaultsFile {
  source?: string;
  helpMessageKey?: string;
  messages?: Record<string, unknown>;
  entries?: Record<string, unknown>;
}

interface TermRecord {
  text: string;
  source: LibrarySource;
}

const DEFAULTS_URL = new URL('./dice-defaults.json', import.meta.url);

/** 只保留字符串值的映射；其它值跳过并记录。 */
function stringMap(
  raw: unknown,
  where: string,
  warnings: string[],
  keep?: (key: string) => boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`${where}: 期望映射，实际是 ${Array.isArray(raw) ? '数组' : typeof raw}，跳过`);
    return out;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (keep && !keep(key)) continue;
    if (typeof value === 'string') out[key] = value;
    else warnings.push(`${where}: 跳过非字符串项「${key}」（${typeof value}）`);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 展示用规范化：去掉首尾空白（Dice! 的原始串里常有前导换行）。 */
function displayText(text: string): string {
  return text.replace(/^[\s\uFEFF]+/, '').replace(/[\s]+$/, '');
}

// ---------------------------------------------------------------------------
// 内置词库（Dice! GlobalVar.cpp 导出物）
// ---------------------------------------------------------------------------

function loadDefaults(warnings: string[]): { messages: Record<string, string>; entries: Record<string, string> } {
  try {
    const parsed = JSON.parse(readFileSync(DEFAULTS_URL, 'utf8')) as DefaultsFile;
    return {
      messages: stringMap(parsed.messages, 'dice-defaults.json/messages', warnings),
      entries: stringMap(parsed.entries, 'dice-defaults.json/entries', warnings),
    };
  } catch (err) {
    warnings.push(
      `dice-defaults.json 读取失败（${err instanceof Error ? err.message : String(err)}）：` +
        '请运行 `node scripts/import-dice-library.ts` 重建；本次退化为空内置词库',
    );
    return { messages: {}, entries: {} };
  }
}

// ---------------------------------------------------------------------------
// 外部词库：JSON + 最简 YAML（零依赖）
// ---------------------------------------------------------------------------

/** 剥掉行尾注释（只有 `#` 前是空白/行首才算注释，避免吃到值里的 `#`）。 */
function stripYamlComment(line: string): string {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquoteYamlScalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|n|r|t|"|\\)/g, (_, esc: string) => {
        if (esc === 'n') return '\n';
        if (esc === 'r') return '\r';
        if (esc === 't') return '\t';
        if (esc === '"') return '"';
        if (esc === '\\') return '\\';
        return String.fromCodePoint(parseInt(esc.slice(1), 16));
      });
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function yamlKey(raw: string): string {
  return unquoteYamlScalar(raw);
}

/**
 * 极简 YAML 子集：一层 `key: value`、引号标量、`|`/`>` 块标量、一层缩进映射。
 * 其余结构（列表、深层嵌套、锚点）记录 warning 后忽略。
 */
export function parseSimpleYaml(text: string, where: string, warnings: string[]): Record<string, unknown> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const out: Record<string, unknown> = {};

  const indentOf = (line: string): number => /^[ \t]*/.exec(line)?.[0].length ?? 0;
  const isBlank = (line: string): boolean => stripYamlComment(line).trim().length === 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isBlank(line)) continue;
    const content = stripYamlComment(line);
    const indent = indentOf(content);
    const trimmed = content.trim();
    if (indent > 0) {
      warnings.push(`${where}: 忽略意外缩进行「${trimmed.slice(0, 40)}」`);
      continue;
    }
    if (trimmed === '---' || trimmed === '...') continue;
    if (trimmed.startsWith('- ')) {
      warnings.push(`${where}: 不支持 YAML 列表，忽略「${trimmed.slice(0, 40)}」`);
      continue;
    }
    const match = /^([^:]+):[ \t]*(.*)$/.exec(trimmed);
    if (!match) {
      warnings.push(`${where}: 无法解析的行「${trimmed.slice(0, 40)}」，忽略`);
      continue;
    }
    const key = yamlKey(match[1]);
    const rest = match[2];

    // 收集后续缩进行：块标量或一层映射。
    const block: { indent: number; text: string }[] = [];
    let j = i + 1;
    while (j < lines.length) {
      if (isBlank(lines[j])) {
        block.push({ indent: 0, text: '' });
        j += 1;
        continue;
      }
      const current = stripYamlComment(lines[j]);
      const currentIndent = indentOf(current);
      if (currentIndent === 0) break;
      block.push({ indent: currentIndent, text: current });
      j += 1;
    }
    while (block.length > 0 && block[block.length - 1].text === '') block.pop();

    if (rest === '' && block.length > 0) {
      const baseIndent = Math.min(...block.filter((b) => b.text !== '').map((b) => b.indent));
      const body = block.map((b) => (b.text === '' ? '' : b.text.slice(baseIndent)));
      const nested = body.every((b) => b === '' || /^[^:]+:[ \t]*.*$/.test(b));
      if (nested && body.some((b) => b.trim() !== '')) {
        const map: Record<string, string> = {};
        for (const entry of body) {
          if (entry.trim() === '') continue;
          const pair = /^([^:]+):[ \t]*(.*)$/.exec(entry.trim());
          if (!pair) continue;
          map[yamlKey(pair[1])] = unquoteYamlScalar(pair[2]);
        }
        out[key] = map;
        i = j - 1;
        continue;
      }
      out[key] = body.join('\n').replace(/\n+$/, '');
      i = j - 1;
      continue;
    }

    if (/^[|>][+-]?$/.test(rest.trim())) {
      const folded = rest.trim()[0] === '>';
      let value = '';
      if (block.length > 0) {
        const baseIndent = Math.min(...block.filter((b) => b.text !== '').map((b) => b.indent));
        const body = block.map((b) => (b.text === '' ? '' : b.text.slice(baseIndent)));
        value = folded ? body.join(' ').replace(/\s+/g, ' ') : body.join('\n');
      }
      out[key] = value.replace(/\n+$/, '');
      i = j - 1;
      continue;
    }

    out[key] = unquoteYamlScalar(rest);
    i = j - 1;
  }

  return out;
}

const EXTERNAL_META_KEYS = new Set([
  'source',
  'generatedBy',
  'license',
  'upstream',
  'helpMessageKey',
  'counts',
  'notes',
  'duplicates',
]);

interface ExternalLoad {
  entries: Record<string, string>;
  messages: Record<string, string>;
  files: string[];
}

function normalizeExternalFile(
  raw: unknown,
  where: string,
  warnings: string[],
): { entries: Record<string, string>; messages: Record<string, string> } {
  if (!isPlainObject(raw)) {
    warnings.push(`${where}: 顶层不是映射，跳过`);
    return { entries: {}, messages: {} };
  }
  const hasSections = isPlainObject(raw.entries) || isPlainObject(raw.messages);
  if (!hasSections) {
    return { entries: stringMap(raw, where, warnings, (key) => !EXTERNAL_META_KEYS.has(key)), messages: {} };
  }
  const entries = isPlainObject(raw.entries)
    ? stringMap(raw.entries, `${where}/entries`, warnings)
    : {};
  const messages = isPlainObject(raw.messages)
    ? stringMap(raw.messages, `${where}/messages`, warnings)
    : {};
  for (const key of Object.keys(raw)) {
    if (key === 'entries' || key === 'messages' || EXTERNAL_META_KEYS.has(key)) continue;
    warnings.push(`${where}: 忽略未知顶层键「${key}」`);
  }
  return { entries, messages };
}

function loadExternalDir(dir: string, warnings: string[]): ExternalLoad {
  const entries: Record<string, string> = {};
  const messages: Record<string, string> = {};
  const files: string[] = [];
  const resolved = resolve(dir);

  let names: string[];
  try {
    if (!existsSync(resolved)) {
      warnings.push(`外部词库目录不存在：${resolved}（已忽略，DICE_LIBRARY_DIR 请指向目录）`);
      return { entries, messages, files };
    }
    if (!statSync(resolved).isDirectory()) {
      warnings.push(`外部词库路径不是目录：${resolved}（已忽略）`);
      return { entries, messages, files };
    }
    names = readdirSync(resolved).sort();
  } catch (err) {
    warnings.push(`外部词库目录读取失败：${resolved}（${err instanceof Error ? err.message : String(err)}）`);
    return { entries, messages, files };
  }

  for (const name of names) {
    const ext = extname(name).toLowerCase();
    if (ext !== '.json' && ext !== '.yaml' && ext !== '.yml') continue;
    const full = join(resolved, name);
    let text: string;
    try {
      text = readFileSync(full, 'utf8');
    } catch (err) {
      warnings.push(`外部词库 ${name}: 读取失败（${err instanceof Error ? err.message : String(err)}），跳过`);
      continue;
    }
    let raw: unknown;
    try {
      raw = ext === '.json' ? JSON.parse(text) : parseSimpleYaml(text, name, warnings);
    } catch (err) {
      warnings.push(`外部词库 ${name}: 解析失败（${err instanceof Error ? err.message : String(err)}），跳过`);
      continue;
    }
    const loaded = normalizeExternalFile(raw, name, warnings);
    Object.assign(entries, loaded.entries);
    Object.assign(messages, loaded.messages);
    files.push(name);
  }
  return { entries, messages, files };
}

// ---------------------------------------------------------------------------
// 词库实例
// ---------------------------------------------------------------------------

/** 跟随 Dice! 的 `&别名`（由 `get` 解析同表内的目标），带环保护。 */
function resolveAlias(text: string, get: (key: string) => string | undefined): string {
  let current = text;
  const seen = new Set<string>();
  while (current.startsWith('&')) {
    const target = current.slice(1);
    if (seen.has(target)) break;
    seen.add(target);
    const next = get(target);
    if (next === undefined) break;
    current = next;
  }
  return current;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

function suggestionScore(needle: string, key: string): number | null {
  const lower = key.toLowerCase();
  if (lower === needle) return null;
  if (lower.startsWith(needle)) return 0;
  if (lower.includes(needle)) return 1;
  if (needle.includes(lower)) return 2 + Math.max(0, needle.length - lower.length);
  const distance = levenshtein(needle, lower);
  const budget = needle.length >= 6 ? 2 : 1;
  if (distance > budget) return null;
  return 10 + distance;
}

/** 解析 `DICE_LIBRARY_DIR`（空白视为未设置）。 */
export function libraryDirFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.DICE_LIBRARY_DIR;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createLibrary(opts: LibraryOptions = {}): DiceLibrary {
  const warnings: string[] = [];
  const env = opts.env ?? process.env;
  const configured = opts.dir !== undefined ? opts.dir : libraryDirFromEnv(env);
  const dir = typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : null;

  const defaults = loadDefaults(warnings);
  const discord: Record<string, string> = { ...DISCORD_HELP_ENTRIES, ...DISCORD_RULE_ENTRIES };
  const external = dir ? loadExternalDir(dir, warnings) : { entries: {}, messages: {}, files: [] };

  // 词条：discord < dice < external
  // Dice! 的词条表 `dict_ci` 大小写不敏感，所以后写入的大小写变体要**顶掉**先写入的同名键
  // （否则外部的 `{"R": ...}` 不会覆盖内置的 `r`，两个键会同时存在）。
  const setCaseInsensitive = <T>(map: Map<string, T>, key: string, value: T): void => {
    const lower = key.toLowerCase();
    for (const existing of map.keys()) {
      if (existing !== key && existing.toLowerCase() === lower) {
        map.delete(existing);
        break;
      }
    }
    map.set(key, value);
  };

  const termMap = new Map<string, TermRecord>();
  for (const [key, text] of Object.entries(discord)) setCaseInsensitive(termMap, key, { text, source: 'discord' });
  for (const [key, text] of Object.entries(defaults.entries)) setCaseInsensitive(termMap, key, { text, source: 'dice' });
  for (const [key, text] of Object.entries(external.entries)) setCaseInsensitive(termMap, key, { text, source: 'external' });

  // 默认文案：dice < external
  const messageMap = new Map<string, string>();
  for (const [key, text] of Object.entries(defaults.messages)) setCaseInsensitive(messageMap, key, text);
  for (const [key, text] of Object.entries(external.messages)) setCaseInsensitive(messageMap, key, text);

  const sortedTerms = [...termMap.keys()].sort();

  // 各来源实际生效的条目数（被大小写变体顶掉的键不计入）
  const bySource = { discord: 0, dice: 0, external: 0 };
  for (const record of termMap.values()) bySource[record.source] += 1;

  // Dice! 的词条表 `dict_ci` 是大小写不敏感的；别名（`&key`）解析沿用同一口径。
  const lowerIndexOf = (keys: Iterable<string>): Map<string, string> => {
    const index = new Map<string, string>();
    for (const key of keys) {
      const lower = key.toLowerCase();
      if (!index.has(lower)) index.set(lower, key);
    }
    return index;
  };
  const termIndex = lowerIndexOf(termMap.keys());
  const messageIndex = lowerIndexOf(messageMap.keys());
  const termText = (name: string): string | undefined => {
    const key = termMap.has(name) ? name : termIndex.get(name.toLowerCase());
    return key === undefined ? undefined : termMap.get(key)?.text;
  };
  const messageText = (name: string): string | undefined => {
    const key = messageMap.has(name) ? name : messageIndex.get(name.toLowerCase());
    return key === undefined ? undefined : messageMap.get(key);
  };

  const lookup = (term: string): LibraryLookup | null => {
    const query = term.trim();
    if (query === '') return null;
    const exact = termMap.has(query) ? query : termIndex.get(query.toLowerCase());
    if (exact === undefined) return null;
    const hit = termMap.get(exact);
    if (!hit) return null;
    return { term: exact, text: displayText(resolveAlias(hit.text, termText)), source: hit.source };
  };

  const suggest = (term: string, limit = 8): string[] => {
    const needle = term.trim().toLowerCase();
    if (needle === '') return [];
    const scored: { term: string; score: number }[] = [];
    for (const key of sortedTerms) {
      const score = suggestionScore(needle, key);
      if (score === null) continue;
      scored.push({ term: key, score });
    }
    scored.sort(
      (a, b) =>
        a.score - b.score ||
        a.term.length - b.term.length ||
        (a.term < b.term ? -1 : a.term > b.term ? 1 : 0),
    );
    return scored.slice(0, Math.max(0, limit)).map((row) => row.term);
  };

  const message = (key: string): string | null => {
    const raw = messageText(key);
    if (raw === undefined) return null;
    const text = displayText(resolveAlias(raw, messageText));
    return text === '' ? null : text;
  };

  return {
    overview: () => {
      const raw = messageText('strHlpMsg');
      return raw === undefined ? '' : displayText(resolveAlias(raw, messageText));
    },
    message,
    lookup,
    suggest,
    terms: () => [...sortedTerms],
    stats: () => ({
      messages: messageMap.size,
      entries: bySource.dice + bySource.external,
      external: external.files.length > 0,
      externalFiles: external.files.length,
      discord: bySource.discord,
      terms: sortedTerms.length,
    }),
    warnings: () => [...warnings],
    dir: () => dir,
  };
}

// ---------------------------------------------------------------------------
// 模块级单例（handler 用；按目录缓存，避免每条命令读盘）
// ---------------------------------------------------------------------------

let cached: DiceLibrary | null = null;
let cachedKey: string | null = null;

/** 取进程级词库实例；`DICE_LIBRARY_DIR` 变化时自动重建。 */
export function getLibrary(): DiceLibrary {
  const dir = libraryDirFromEnv();
  if (cached === null || cachedKey !== dir) {
    cached = createLibrary({ dir });
    cachedKey = dir;
  }
  return cached;
}

/** 注入/清空单例（测试用）。 */
export function setLibrary(library: DiceLibrary | null): void {
  cached = library;
  cachedKey = library === null ? null : libraryDirFromEnv();
}

/** 丢弃缓存，下一次 `getLibrary()` 重新读盘（测试用）。 */
export function resetLibrary(): void {
  cached = null;
  cachedKey = null;
}
