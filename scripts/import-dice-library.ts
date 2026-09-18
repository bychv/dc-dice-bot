/**
 * import-dice-library — 从 Dice! 源码的全局字典里抽取**离线可得**的内置词库。
 *
 *   node scripts/import-dice-library.ts [GlobalVar.cpp] [out.json]
 *
 * 默认读取 `ref/Dice/Dice/GlobalVar.cpp`（上游 Dice! 源码），产出
 * `src/bot/library/dice-defaults.json`：
 *
 *   {
 *     "source": "ref/Dice/Dice/GlobalVar.cpp",
 *     "messages": { "strHlpMsg": "...", ... },   // PlainMsg：内置默认文案
 *     "entries":  { "log": "...", "r": "...", ... } // HelpDoc：`.help <词条>` 帮助词条
 *   }
 *
 * 解析口径（针对该文件的 C++ 初始化列表）：
 *   - `{"key","value"}`，含 `\"` `\\` `\n` `\f` `\xNN` `\uNNNN` 等转义；
 *   - `R"(...)"` 原始字符串（含自定义定界符 `R"xy(...)xy"`），内部不处理转义；
 *   - **相邻拼接**的多段字符串（`R"(A)" R"(B)"` 或 `"A" "B"`）按 C++ 规则拼接；
 *   - 注释（`//` 行注释与块注释）、`#if/#ifdef...#endif` 条件编译块整块跳过；
 *   - 非字符串项（数字、函数调用、嵌套字典…）跳过并计数，不抛异常；
 *   - 同一字典内重复 key：**以最后一次为准**，重复记录进 `duplicates`。
 *
 * 产物是确定性的：所有字典键按码元排序，重复运行字节一致（键排序 + 2 空格缩进 + 末尾换行）。
 *
 * **离线不可得**：Dice! 的规则书（`.rules` 词条）与牌堆（`.deck`）是运行时从
 * `api.kokona.tech` 下载的规则集/牌堆数据（见 MsgFormat/DiceMod `getRule`、
 * `CustomHelp.json`），上游仓库不含这些数据文件，本脚本无法也不应伪造它们。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `source` 字段用的仓库相对路径（跨机器稳定）。 */
export const DEFAULT_SOURCE_LABEL = 'ref/Dice/Dice/GlobalVar.cpp';

/** 默认输入：仓库根的 `ref/Dice/Dice/GlobalVar.cpp`（脚本在 `bot/scripts/`）。 */
export const DEFAULT_SOURCE_PATH = fileURLToPath(
  new URL('../../ref/Dice/Dice/GlobalVar.cpp', import.meta.url),
);

/** 默认输出：`bot/src/bot/library/dice-defaults.json`。 */
export const DEFAULT_OUT_PATH = fileURLToPath(
  new URL('../src/bot/library/dice-defaults.json', import.meta.url),
);

/** 承载帮助词条的字典（`.help <词条>`）。 */
const ENTRY_DICTS = new Set(['HelpDoc']);
/** 承载默认文案的字典（`getMsg(key)`）。 */
const MESSAGE_DICTS = new Set(['PlainMsg', 'GlobalMsg']);

export interface DictEntryDuplicate {
  dict: string;
  key: string;
  /** 该 key 在字典里出现的总次数（>= 2）。 */
  count: number;
}

export interface DictSummary {
  name: string;
  /** 初始izer 里成功解析出的 `{key, value}` 项数。 */
  items: number;
  /** 导出目的：`entries` / `messages` / `skipped`。 */
  exportedAs: 'entries' | 'messages' | 'skipped';
  /** 跳过的非字符串/畸形初始izer 项数。 */
  skippedItems: number;
}

export interface ParsedLibrary {
  messages: Record<string, string>;
  entries: Record<string, string>;
  duplicates: DictEntryDuplicate[];
  notes: string[];
  dicts: DictSummary[];
}

/** 落盘结构（比 `parseGlobalVar` 多一层元信息；`dicts` 只用于诊断，不入产物）。 */
export interface DefaultsFile {
  source: string;
  generatedBy: string;
  license: string;
  upstream: string;
  /** 无参 `.help` 用的文案 key。 */
  helpMessageKey: string;
  counts: { messages: number; entries: number; duplicates: number };
  messages: Record<string, string>;
  entries: Record<string, string>;
  duplicates: DictEntryDuplicate[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// C++ 词法小工具
// ---------------------------------------------------------------------------

/**
 * 把 `#if/#ifdef/#ifndef ... #endif` 整块替换成等长空白（保留换行与下标）。
 *
 * 该文件里条件编译只出现在版本字符串附近，这里仍按通用行级规则处理，保证块内的
 * 词条不会被误抽取。字符串里以 `#if` 开头的行会被当成指令——对这个固定输入不构成问题。
 */
function maskConditionalBlocks(source: string): { masked: string; maskedLines: number } {
  const lines = source.split('\n');
  let maskedLines = 0;
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const directive = trimmed.startsWith('#') ? (/^#\s*(\w+)/.exec(trimmed)?.[1] ?? '') : '';
    const opens = directive === 'if' || directive === 'ifdef' || directive === 'ifndef';
    if (depth > 0 || opens) {
      lines[i] = ' '.repeat(line.length);
      maskedLines += 1;
      if (opens) depth += 1;
      else if (directive === 'endif') depth = Math.max(0, depth - 1);
    }
  }
  return { masked: lines.join('\n'), maskedLines };
}

/** 跳过空白、`//` 行注释与 `/*...*\/` 块注释。 */
function skipTrivia(src: string, from: number): number {
  let i = from;
  for (;;) {
    const ch = src[i];
    if (ch === undefined) return i;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      return end === -1 ? skipTrivia(src, src.length) : skipTrivia(src, end + 2);
    }
    return i;
  }
}

function isRawStringStart(src: string, i: number): boolean {
  if (src[i] !== 'R' || src[i + 1] !== '"') return false;
  const prev = i > 0 ? src[i - 1] : '';
  return !/[A-Za-z0-9_$]/.test(prev);
}

function decodeEscape(src: string, at: number): { value: string; end: number } {
  const code = src[at + 1] ?? '';
  const simple: Record<string, string> = {
    n: '\n',
    t: '\t',
    r: '\r',
    '0': '\0',
    a: '\x07',
    b: '\b',
    f: '\f',
    v: '\v',
    '\\': '\\',
    '"': '"',
    "'": "'",
    '?': '?',
  };
  if (code in simple) return { value: simple[code], end: at + 2 };
  if (code === 'x') {
    const hex = /^[0-9a-fA-F]{1,2}/.exec(src.slice(at + 2))?.[0] ?? '';
    if (hex) return { value: String.fromCharCode(parseInt(hex, 16)), end: at + 2 + hex.length };
  }
  if (code === 'u' || code === 'U') {
    const width = code === 'u' ? 4 : 8;
    const hex = new RegExp(`^[0-9a-fA-F]{${width}}`).exec(src.slice(at + 2))?.[0];
    if (hex) return { value: String.fromCodePoint(parseInt(hex, 16)), end: at + 2 + width };
  }
  // 未知转义：C++ 编译器只报警告并按原字符处理。
  return { value: code, end: at + 2 };
}

/** 读一个普通字符串字面量（`"..."`），返回解码后的值与结束下标。 */
function readQuotedString(src: string, at: number): { value: string; end: number } | null {
  let out = '';
  let i = at + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      const esc = decodeEscape(src, i);
      out += esc.value;
      i = esc.end;
      continue;
    }
    if (ch === '"') return { value: out, end: i + 1 };
    out += ch;
    i += 1;
  }
  return null;
}

/** 读一个原始字符串字面量（`R"delim(...)delim"`），内部不做转义处理。 */
function readRawString(src: string, at: number): { value: string; end: number } | null {
  let i = at + 2; // 跳过 R"
  const delimStart = i;
  while (i < src.length && src[i] !== '(') {
    if (src[i] === ')' || src[i] === '"') return null;
    i += 1;
  }
  if (i >= src.length) return null;
  const delim = src.slice(delimStart, i);
  i += 1; // 跳过 '('
  const terminator = `)${delim}"`;
  const close = src.indexOf(terminator, i);
  if (close === -1) return null;
  return { value: src.slice(i, close), end: close + terminator.length };
}

function readStringToken(src: string, at: number): { value: string; end: number } | null {
  if (src[at] === '"') return readQuotedString(src, at);
  if (isRawStringStart(src, at)) return readRawString(src, at);
  return null;
}

/** 读一个「项」：一个或多个相邻字符串字面量，按 C++ 规则拼接。 */
function readStringItem(src: string, at: number): { value: string; end: number } | null {
  const first = readStringToken(src, at);
  if (!first) return null;
  let value = first.value;
  let i = first.end;
  for (;;) {
    const next = readStringToken(src, skipTrivia(src, i));
    if (!next) break;
    value += next.value;
    i = next.end;
  }
  return { value, end: i };
}

/** 从 `{` 找到匹配的 `}`（跳过字符串/字符字面量与注释）。 */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      i = skipTrivia(src, i);
      continue;
    }
    if (ch === '"' || isRawStringStart(src, i)) {
      const token = readStringToken(src, i);
      if (!token) return -1;
      i = token.end;
      continue;
    }
    if (ch === "'") {
      // 字符字面量：'x' / '\n' / '\'' —— 只用于跳过，不产出内容。
      let j = i + 1;
      if (src[j] === '\\') j += 2;
      else j += 1;
      if (src[j] === "'") j += 1;
      i = j;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** 解析一个初始izer 组 `{ "key", "value" }`；非字符串/畸形 → null。 */
function parseItemGroup(inner: string): string[] | null {
  const items: string[] = [];
  let i = 0;
  for (;;) {
    i = skipTrivia(inner, i);
    if (i >= inner.length) break;
    const item = readStringItem(inner, i);
    if (!item) return null;
    items.push(item.value);
    i = skipTrivia(inner, item.end);
    if (i >= inner.length) break;
    if (inner[i] === ',') {
      i += 1;
      continue;
    }
    return null; // 尾巴上有非字符串内容
  }
  return items;
}

interface DictBody {
  pairs: Array<[string, string]>;
  skippedItems: number;
}

function parseDictBody(src: string, open: number): DictBody {
  const pairs: Array<[string, string]> = [];
  let skippedItems = 0;
  let i = open + 1;
  while (i < src.length) {
    i = skipTrivia(src, i);
    const ch = src[i];
    if (ch === undefined || ch === '}') break;
    if (ch === '{') {
      const close = matchBrace(src, i);
      if (close === -1) break;
      const items = parseItemGroup(src.slice(i + 1, close));
      if (items && items.length >= 2) pairs.push([items[0], items.slice(1).join('')]);
      else skippedItems += 1;
      i = close + 1;
      continue;
    }
    // 其它 token（`GlobalMsg{ PlainMsg }` 这种别名、宏…）：跳到下一个分隔符。
    let j = i;
    while (j < src.length && src[j] !== ',' && src[j] !== '}' && src[j] !== '{') j += 1;
    if (j === i) j += 1;
    i = j;
    if (src[i] === ',') i += 1;
  }
  return { pairs, skippedItems };
}

// ---------------------------------------------------------------------------
// 抽取
// ---------------------------------------------------------------------------

const DICT_DECL = /(?:^|\n)[ \t]*(?:const\s+)?(?:dict_ci|fifo_dict_ci)\s*<[^<>\n]*>\s*([A-Za-z_]\w*)\s*(?:=\s*)?\{/g;

/** 解析 `GlobalVar.cpp` 源码里的字符串字典。 */
export function parseGlobalVar(source: string): ParsedLibrary {
  const stripped = source.replace(/^\uFEFF/, '');
  const { masked } = maskConditionalBlocks(stripped);

  const messages: Record<string, string> = {};
  const entries: Record<string, string> = {};
  const dicts: DictSummary[] = [];
  const duplicates: DictEntryDuplicate[] = [];
  const notes: string[] = [];
  const counts = new Map<string, number>();
  let conditional = stripped !== masked;

  DICT_DECL.lastIndex = 0;
  for (let match = DICT_DECL.exec(masked); match !== null; match = DICT_DECL.exec(masked)) {
    const name = match[1];
    const open = match.index + match[0].length - 1;
    const close = matchBrace(masked, open);
    if (close === -1) {
      notes.push(`字典 ${name}: 大括号不匹配，整块跳过`);
      continue;
    }
    const body = parseDictBody(masked, open);
    const exportedAs = ENTRY_DICTS.has(name)
      ? 'entries'
      : MESSAGE_DICTS.has(name)
        ? 'messages'
        : 'skipped';
    const target = exportedAs === 'entries' ? entries : exportedAs === 'messages' ? messages : null;
    for (const [key, value] of body.pairs) {
      const seen = (counts.get(`${name}\u0000${key}`) ?? 0) + 1;
      counts.set(`${name}\u0000${key}`, seen);
      if (target) target[key] = value; // 重复 key：后写覆盖先写 → 最后一次为准
    }
    dicts.push({ name, items: body.pairs.length, exportedAs, skippedItems: body.skippedItems });
    if (body.skippedItems > 0) {
      notes.push(`字典 ${name}: 跳过非字符串/畸形初始izer项 ${body.skippedItems} 个`);
    }
    DICT_DECL.lastIndex = close + 1;
  }

  for (const dict of dicts) {
    if (dict.exportedAs === 'skipped') {
      notes.push(`未导出字典 ${dict.name}（${dict.items} 项）：不是 messages/entries 来源`);
    }
  }

  for (const [composite, count] of counts) {
    if (count < 2) continue;
    const [dict, key] = composite.split('\u0000');
    duplicates.push({ dict, key, count });
  }
  duplicates.sort((a, b) =>
    a.dict === b.dict ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.dict < b.dict ? -1 : 1,
  );
  if (duplicates.length > 0) {
    notes.push(`重复 key ${duplicates.length} 个：同一字典内以最后一次为准（见 duplicates）`);
  }
  if (conditional) {
    notes.push('条件编译块（#if/#ifdef/#ifndef…#endif）整块跳过');
  }

  return { messages, entries, duplicates, notes, dicts };
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key];
  return out;
}

/** 组装落盘对象（键序固定：先元信息，再 messages/entries 的已排序键）。 */
export function buildDefaults(sourceText: string, sourceLabel = DEFAULT_SOURCE_LABEL): DefaultsFile {
  const parsed = parseGlobalVar(sourceText);
  const messages = sortedRecord(parsed.messages);
  const entries = sortedRecord(parsed.entries);
  return {
    source: sourceLabel,
    generatedBy: 'bot/scripts/import-dice-library.ts',
    license: 'AGPL-3.0-only',
    upstream: 'Dice! built-in GlobalVar.cpp tables (w4123溯洄 / String.Empty)',
    helpMessageKey: 'strHlpMsg',
    counts: {
      messages: Object.keys(messages).length,
      entries: Object.keys(entries).length,
      duplicates: parsed.duplicates.length,
    },
    messages,
    entries,
    duplicates: parsed.duplicates,
    notes: parsed.notes,
  };
}

/** 稳定序列化：2 空格缩进 + 末尾换行。 */
export function serializeDefaults(defaults: DefaultsFile): string {
  return `${JSON.stringify(defaults, null, 2)}\n`;
}

export interface ImportRun {
  outPath: string;
  changed: boolean;
  bytes: number;
  result: DefaultsFile;
}

export function runImport(sourcePath = DEFAULT_SOURCE_PATH, outPath = DEFAULT_OUT_PATH): ImportRun {
  if (!existsSync(sourcePath)) {
    throw new Error(`找不到 Dice! 源码：${sourcePath}（ref/ 未随仓库检出时无法重建内置词库）`);
  }
  const defaults = buildDefaults(readFileSync(sourcePath, 'utf8'));
  const json = serializeDefaults(defaults);
  const before = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null;
  if (before !== json) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, json, 'utf8');
  }
  return {
    outPath,
    changed: before !== json,
    bytes: Buffer.byteLength(json, 'utf8'),
    result: defaults,
  };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return norm(entry) === norm(self);
}

if (isMainModule()) {
  const [sourceArg, outArg] = process.argv.slice(2);
  try {
    const run = runImport(sourceArg ?? DEFAULT_SOURCE_PATH, outArg ?? DEFAULT_OUT_PATH);
    const { counts } = run.result;
    console.log(`source     ${sourceArg ?? DEFAULT_SOURCE_PATH}`);
    console.log(`output     ${run.outPath} (${run.changed ? '已更新' : '无变化'}，${run.bytes} bytes)`);
    console.log(`messages   ${counts.messages}`);
    console.log(`entries    ${counts.entries}`);
    console.log(`duplicates ${counts.duplicates}`);
    for (const note of run.result.notes) console.log(`note       ${note}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
