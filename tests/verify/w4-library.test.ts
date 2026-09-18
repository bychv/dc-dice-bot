/**
 * W4 独立验证 · task-6 Dice! 词库
 *
 * 核心：**自研解析器**（不复用 `scripts/import-dice-library.ts`）重新解析
 * `ref/Dice/Dice/GlobalVar.cpp`，与 `src/bot/library/dice-defaults.json` 的
 * `messages`/`entries` **全量逐字符**比对，并对 6 个具名词条给出硬编码期望值
 * （含一条由 3 段 raw 串拼接的「指令」）。
 *
 * 另外覆盖：外部 `DICE_LIBRARY_DIR` 优先级、坏文件/空文件不崩、handler 输出确实来自词库、
 * 未命中时的「你是不是想找」来自 suggest。
 *
 * Run: node tests/verify/w4-library.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { route } from '../../src/bot/router.ts';
import {
  createLibrary,
  libraryDirFromEnv,
  resetLibrary,
  type DiceLibrary,
} from '../../src/bot/library/library.ts';
import { makeContext, makeEnv } from '../bot/fakes.ts';

const TMP_ROOT = fileURLToPath(new URL('../.tmp/', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const REF_PATH = join(REPO, 'ref', 'Dice', 'Dice', 'GlobalVar.cpp');
const JSON_PATH = fileURLToPath(new URL('../../src/bot/library/dice-defaults.json', import.meta.url));

const REF = readFileSync(REF_PATH, 'utf8');
const DEFAULTS = JSON.parse(readFileSync(JSON_PATH, 'utf8')) as {
  messages: Record<string, string>;
  entries: Record<string, string>;
  counts: { messages: number; entries: number; duplicates: number };
  helpMessageKey: string;
  source: string;
};

function tempDir(label: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TMP_ROOT, `w4-lib-${label}-`));
}

// ---------------------------------------------------------------------------
// 自研 C++ 字符串初始化列表解析器（独立实现，只面向本文件的两种目标字典）
// ---------------------------------------------------------------------------

const SIMPLE_ESCAPES: Record<string, string> = {
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

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

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
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    return i;
  }
}

function readQuoted(src: string, at: number): { value: string; end: number } {
  let out = '';
  let i = at + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      const code = src[i + 1] ?? '';
      if (code in SIMPLE_ESCAPES) {
        out += SIMPLE_ESCAPES[code];
        i += 2;
        continue;
      }
      if (code === 'x') {
        const hex = /^[0-9a-fA-F]{1,2}/.exec(src.slice(i + 2))?.[0];
        if (hex) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 2 + hex.length;
          continue;
        }
      }
      if (code === 'u' || code === 'U') {
        const width = code === 'u' ? 4 : 8;
        const hex = new RegExp(`^[0-9a-fA-F]{${width}}`).exec(src.slice(i + 2))?.[0];
        if (hex) {
          out += String.fromCodePoint(parseInt(hex, 16));
          i += 2 + width;
          continue;
        }
      }
      out += code;
      i += 2;
      continue;
    }
    if (ch === '"') return { value: out, end: i + 1 };
    out += ch;
    i += 1;
  }
  throw new Error(`未闭合的普通字符串（偏移 ${at}）`);
}

function readRaw(src: string, at: number): { value: string; end: number } {
  let i = at + 2;
  const delimStart = i;
  while (i < src.length && src[i] !== '(') {
    if (src[i] === ')' || src[i] === '"') throw new Error(`非法 raw 定界符（偏移 ${at}）`);
    i += 1;
  }
  if (i >= src.length) throw new Error(`未闭合的 raw 字符串（偏移 ${at}）`);
  const delimiter = src.slice(delimStart, i);
  i += 1;
  const terminator = `)${delimiter}"`;
  const close = src.indexOf(terminator, i);
  if (close === -1) throw new Error(`未找到 raw 串终止符（偏移 ${at}）`);
  return { value: src.slice(i, close), end: close + terminator.length };
}

function readToken(src: string, at: number): { value: string; end: number } | null {
  if (src[at] === '"') return readQuoted(src, at);
  if (src[at] === 'R' && src[at + 1] === '"' && !isIdentChar(src[at - 1])) return readRaw(src, at);
  return null;
}

/** 一个「项」= 一个或多个相邻字符串字面量（C++ 拼接规则）。 */
function readItem(src: string, at: number): { value: string; end: number; segments: number } | null {
  const first = readToken(src, at);
  if (!first) return null;
  let value = first.value;
  let segments = 1;
  let i = first.end;
  for (;;) {
    const next = skipTrivia(src, i);
    const token = readToken(src, next);
    if (!token) {
      i = next;
      break;
    }
    value += token.value;
    segments += 1;
    i = token.end;
  }
  return { value, end: i, segments };
}

/** 字符串感知的大括号匹配（跳过字符串/字符字面量/注释）。 */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      i = skipTrivia(src, i);
      continue;
    }
    if (ch === '"' || (ch === 'R' && src[i + 1] === '"' && !isIdentChar(src[i - 1]))) {
      i = readToken(src, i)!.end;
      continue;
    }
    if (ch === "'") {
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

interface DictBody {
  pairs: Array<[string, string]>;
  segments: number[];
}

/** 严格解析 `{ "key", "value" }, ...` 形式的字典体。 */
function parsePairBody(src: string, open: number): DictBody {
  const pairs: Array<[string, string]> = [];
  const segments: number[] = [];
  let i = skipTrivia(src, open + 1);
  for (;;) {
    if (src[i] === '}') return { pairs, segments };
    if (src[i] !== '{') throw new Error(`字典体里出现非初始izer项：${JSON.stringify(src.slice(i, i + 24))}`);
    i = skipTrivia(src, i + 1);
    const key = readItem(src, i);
    if (!key) throw new Error('字典体的 key 不是字符串字面量');
    i = skipTrivia(src, key.end);
    if (src[i] !== ',') throw new Error('字典体的 key 后面不是逗号');
    i = skipTrivia(src, i + 1);
    const value = readItem(src, i);
    if (!value) throw new Error('字典体的 value 不是字符串字面量');
    i = skipTrivia(src, value.end);
    if (src[i] !== '}') throw new Error('字典体的项没有以 } 结束');
    pairs.push([key.value, value.value]);
    segments.push(value.segments);
    i = skipTrivia(src, i + 1);
    if (src[i] === ',') i = skipTrivia(src, i + 1);
    if (i >= src.length) throw new Error('字典体没有闭合');
  }
}

interface ParsedRef {
  messages: Record<string, string>;
  entries: Record<string, string>;
  messageOccurrences: Map<string, number>;
  entriesSegments: Map<string, number>;
}

/** 全文件扫描：只在字符串外识别 `dict_ci<...> NAME = {`；只严格解析 PlainMsg / HelpDoc。 */
function parseRef(source: string): ParsedRef {
  const messages: Record<string, string> = {};
  const entries: Record<string, string> = {};
  const messageOccurrences = new Map<string, number>();
  const entriesSegments = new Map<string, number>();

  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '"') {
      i = readQuoted(source, i).end;
      continue;
    }
    if (ch === 'R' && source[i + 1] === '"' && !isIdentChar(source[i - 1])) {
      i = readRaw(source, i).end;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      if (source[j] === '\\') j += 2;
      else j += 1;
      if (source[j] === "'") j += 1;
      i = j;
      continue;
    }
    const keyword = source.startsWith('fifo_dict_ci', i)
      ? 'fifo_dict_ci'
      : source.startsWith('dict_ci', i)
        ? 'dict_ci'
        : null;
    if (!keyword || isIdentChar(source[i - 1])) {
      i += 1;
      continue;
    }
    let j = i + keyword.length;
    j = skipTrivia(source, j);
    if (source[j] !== '<') {
      i += 1;
      continue;
    }
    const closeAngle = source.indexOf('>', j);
    if (closeAngle === -1) {
      i += 1;
      continue;
    }
    j = skipTrivia(source, closeAngle + 1);
    const nameMatch = /^[A-Za-z_]\w*/.exec(source.slice(j));
    if (!nameMatch) {
      i += 1;
      continue;
    }
    const name = nameMatch[0];
    j = skipTrivia(source, j + name.length);
    if (source[j] === '=') j = skipTrivia(source, j + 1);
    if (source[j] !== '{') {
      i += 1;
      continue;
    }
    const bodyEnd = matchBrace(source, j);
    if (bodyEnd === -1) throw new Error(`字典 ${name} 的大括号没有闭合`);
    if (name === 'PlainMsg' || name === 'HelpDoc') {
      const body = parsePairBody(source, j);
      for (let k = 0; k < body.pairs.length; k += 1) {
        const [key, value] = body.pairs[k];
        if (name === 'PlainMsg') {
          messages[key] = value; // 同一字典内重复 key：以最后一次为准
          messageOccurrences.set(key, (messageOccurrences.get(key) ?? 0) + 1);
        } else {
          entries[key] = value;
          entriesSegments.set(key, body.segments[k]);
        }
      }
    }
    i = bodyEnd + 1;
  }
  return { messages, entries, messageOccurrences, entriesSegments };
}

const PARSED = parseRef(REF);

// ---------------------------------------------------------------------------
// ① 自研解析器 vs dice-defaults.json
// ---------------------------------------------------------------------------

describe('W4 · 自研解析器 vs dice-defaults.json（ref 逐字符）', () => {
  test('ref 文件按预期路径存在且来自 Dice! 上游', () => {
    assert.equal(DEFAULTS.source, 'ref/Dice/Dice/GlobalVar.cpp');
    assert.ok(REF.includes('dict_ci<string> PlainMsg'), 'ref 里必须有 PlainMsg');
    assert.ok(REF.includes('const dict_ci<> HelpDoc = {'), 'ref 里必须有 HelpDoc');
  });

  test('messages 全量（351 条）逐字符相等，含重复 key 的 last-wins 语义', () => {
    assert.deepEqual(PARSED.messages, DEFAULTS.messages, 'messages 必须与 ref 解析结果完全一致');
    assert.equal(Object.keys(DEFAULTS.messages).length, 351, '自称 351 messages 必须被独立计数确认');
    assert.equal(DEFAULTS.counts.messages, 351);
    // ref 里 PlainMsg 的 strDeckNotFound 出现两次 → 以最后一次为准
    assert.equal(PARSED.messageOccurrences.get('strDeckNotFound'), 2, '重复 key 应被独立发现');
    assert.equal(DEFAULTS.messages.strDeckNotFound, '是说{deck_name}？{self}没听说过的牌堆名呢……');
  });

  test('entries 全量（148 条）逐字符相等，且不含 GlobalComment / GlobalMsg 的别名项', () => {
    assert.deepEqual(PARSED.entries, DEFAULTS.entries, 'entries 必须与 ref 解析结果完全一致');
    assert.equal(Object.keys(DEFAULTS.entries).length, 148, '自称 148 entries 必须被独立计数确认');
    assert.equal(DEFAULTS.counts.entries, 148);
    assert.equal('self' in DEFAULTS.entries, false, 'GlobalComment 的项不得混入 entries');
    assert.equal('strGroupAuthorized' in DEFAULTS.entries, false);
  });

  test('6 个具名词条的硬编码期望值（含 3 段拼接的「指令」）', () => {
    const segInstruction0 =
      '指令前接at可以指定骰娘响应，如\n{at:self}.bot on\n请.help对应指令 获取详细信息，如.help r\n控制指令:\n.dismiss 退群\n.bot 版本信息\n.bot on/off 启用/停用指令\n.reply on/off 启用/禁用回复\n.group 群管\n.authorize 授权许可\n.send 向后台发送消息\n.mod 模块操作';
    const segInstruction1 =
      '跑团指令\n.game 游戏领域\n.rule 规则设置/速查\n.r 掷骰\n.log 日志记录\n.ob 旁观模式\n.set 设置默认骰\n.coc COC人物作成\n.dnd DND人物作成\n.st 属性记录\n.pc 角色卡记录\n.rc 检定\n.setcoc 设置rc房规\n.sc 理智检定\n.en 成长/增强检定\n.ri 先攻\n.init 先攻列表\n.ww 骰池';
    const segInstruction2 =
      '其他指令\n.nn 设置称呼\n.draw 抽牌\n.deck 牌堆实例\n.name 随机姓名\n.ak 安科/安价\n.jrrp 今日人品\n.welcome 入群欢迎\n为了避免未预料到的指令误判，请尽可能在参数之间使用空格\n更多个性化指令参见.help 扩展指令';

    // 硬编码片段必须确实出现在 ref 源码里（否则说明我抄错了）
    for (const seg of [segInstruction0, segInstruction1, segInstruction2]) {
      assert.ok(REF.includes(seg), `硬编码的「指令」片段必须逐字符出现在 GlobalVar.cpp：${seg.slice(0, 12)}…`);
    }
    assert.ok(REF.includes('{"指令",R"('), '「指令」必须是 3 段相邻 raw 串');

    const cases: Array<[string, string, string]> = [
      [
        'messages.strHlpMsg',
        '请使用.dismiss ID（或后四位） 使{self}退群退讨论组\n.bot on/off ID（或at或后四位） //开启或关闭指令\n.help协议 确认服务协议\n.help指令 查看指令列表\n.help群管 查看群管指令\n.help设定 确认骰娘设定\n.help链接 查看源码文档\n官方论坛: https://forum.kokona.tech/',
        'strHlpMsg',
      ],
      ['entries.指令', segInstruction0 + segInstruction1 + segInstruction2, '指令'],
      [
        'entries.master',
        '当前Master:{print:master}\nMaster拥有最高权限，且可以调整任意信任',
        'master',
      ],
      [
        'entries.mod',
        '模块指令.mod\n本指令限信任4使用\n`.mod list` 查看已加载mod列表\n`.mod on 模块名` 启用指定模块\n`.mod off 模块名` 停用指定模块\n`.mod del 模块名` 卸载指定模块\n`.mod info 模块名` 指定模块简介信息\n`.mod detail 模块名` 指定模块详细信息\nmod按序读取，且从后向前覆盖',
        'mod',
      ],
      [
        'entries.作者',
        'Copyright (C) 2018-2021 w4123溯洄\nCopyright (C) 2019-2024 String.Empty\nGithub@Dice-Developer-Team',
        '作者',
      ],
      ['entries.骰娘用户群', '【未设置】', '骰娘用户群'],
    ];

    for (const [label, expected, key] of cases) {
      const actual = label.startsWith('messages.') ? DEFAULTS.messages[key] : DEFAULTS.entries[key];
      assert.equal(actual, expected, `${label} 与硬编码 ref 原文不一致`);
      const fromParser = label.startsWith('messages.') ? PARSED.messages[key] : PARSED.entries[key];
      assert.equal(fromParser, expected, `${label} 自研解析器结果与硬编码 ref 原文不一致`);
    }
    // 多段拼接：3 段，不是 1 段
    assert.equal(PARSED.entriesSegments.get('指令'), 3, '「指令」必须是 3 个相邻字符串字面量拼接');
    assert.ok(REF.includes('.mod 模块操作)"\nR"(跑团指令'), '段与段之间没有分隔符（直接相邻拼接）');
  });

  test('产物可复现：用实现者的 buildDefaults 重新解析 ref，序列化后与已提交 JSON 字节一致', async () => {
    const mod = await import('../../scripts/import-dice-library.ts');
    const rebuilt = mod.serializeDefaults(mod.buildDefaults(REF));
    assert.equal(rebuilt, readFileSync(JSON_PATH, 'utf8'), 'dice-defaults.json 必须能从 ref 确定性重建');
  });
});

// ---------------------------------------------------------------------------
// ② 外部词库 DICE_LIBRARY_DIR 优先级
// ---------------------------------------------------------------------------

describe('W4 · 外部词库优先级（DICE_LIBRARY_DIR > Dice! 内置 > 本机 Discord）', () => {
  test('libraryDirFromEnv：空白视为未设置', () => {
    assert.equal(libraryDirFromEnv({}), null);
    assert.equal(libraryDirFromEnv({ DICE_LIBRARY_DIR: '' }), null);
    assert.equal(libraryDirFromEnv({ DICE_LIBRARY_DIR: '   ' }), null);
    assert.equal(libraryDirFromEnv({ DICE_LIBRARY_DIR: '  C:\\x  ' }), 'C:\\x');
  });

  test('外部条目覆盖内置与 Discord 词条；外部 messages 覆盖 strHlpMsg 总览', () => {
    const dir = tempDir('overlay');
    writeFileSync(
      join(dir, 'overlay.json'),
      JSON.stringify({
        entries: { 角色卡: '外部角色卡', 本机扩展: '外部本机扩展', 外部独有: '只在外部' },
        messages: { strHlpMsg: '【外部总览】' },
      }),
      'utf8',
    );

    const base = createLibrary({ dir: null, env: {} });
    assert.equal(base.lookup('角色卡')?.source, 'dice');
    assert.equal(base.lookup('本机扩展')?.source, 'discord');
    assert.ok(base.overview().startsWith('请使用.dismiss'));

    const external = createLibrary({ dir, env: {} });
    assert.equal(external.lookup('角色卡')?.source, 'external', '外部优先于 Dice! 内置');
    assert.equal(external.lookup('角色卡')?.text, '外部角色卡');
    assert.equal(external.lookup('本机扩展')?.source, 'external', '外部优先于 Discord 适配层');
    assert.equal(external.lookup('本机扩展')?.text, '外部本机扩展');
    assert.equal(external.lookup('外部独有')?.text, '只在外部');
    assert.equal(external.overview(), '【外部总览】');
    assert.equal(external.stats().external, true);
    assert.equal(external.stats().externalFiles, 1);
    assert.equal(external.dir(), join(dir));
  });

  test('未显式给 dir 时读取 DICE_LIBRARY_DIR（含空白回退）', () => {
    const dir = tempDir('envdir');
    writeFileSync(join(dir, 'x.json'), JSON.stringify({ 外部独有: 'v' }), 'utf8');

    const viaEnv = createLibrary({ env: { DICE_LIBRARY_DIR: dir } });
    assert.equal(viaEnv.dir(), dir);
    assert.equal(viaEnv.lookup('外部独有')?.source, 'external');

    const blank = createLibrary({ env: { DICE_LIBRARY_DIR: '   ' } });
    assert.equal(blank.dir(), null);
    assert.equal(blank.lookup('外部独有'), null);
  });

  test('目录里放坏文件 / 空文件 / 标量 / 数组 / 子目录.json 都不抛异常', () => {
    const dir = tempDir('badfiles');
    writeFileSync(join(dir, 'broken.json'), '{ nope', 'utf8');
    writeFileSync(join(dir, 'empty.json'), '', 'utf8');
    writeFileSync(join(dir, 'array.json'), '[1,2]', 'utf8');
    writeFileSync(join(dir, 'scalar.json'), '42', 'utf8');
    writeFileSync(join(dir, 'null.json'), 'null', 'utf8');
    writeFileSync(join(dir, 'badvalues.json'), JSON.stringify({ entries: { ok: 'v', bad: 123 } }), 'utf8');
    writeFileSync(join(dir, 'notes.yaml'), 'entries:\n  词条一: 外部YAML\n', 'utf8');
    writeFileSync(join(dir, 'flat.yaml'), '词条二: 外部平铺\n', 'utf8');
    mkdirSync(join(dir, 'subdir.json'));

    let library: DiceLibrary | null = null;
    assert.doesNotThrow(() => {
      library = createLibrary({ dir, env: {} });
    }, '坏文件绝不抛异常');
    assert.ok(library);
    const lib = library as DiceLibrary;

    assert.ok(lib.warnings().length > 0, '坏文件必须被记入 warnings');
    assert.equal(lib.lookup('ok')?.text, 'v', '同文件里的好条目仍要加载');
    assert.equal(lib.lookup('bad'), null, '非字符串值必须被跳过而不是变成字符串');
    assert.equal(lib.lookup('词条一')?.source, 'external');
    assert.equal(lib.lookup('词条一')?.text, '外部YAML');
    assert.equal(lib.lookup('词条二')?.text, '外部平铺');

    // 目录不存在 / 路径是文件
    const missing = createLibrary({ dir: join(dir, 'does-not-exist'), env: {} });
    assert.equal(missing.lookup('ok'), null);
    assert.ok(missing.warnings().some((w) => w.includes('不存在')));

    const notDir = createLibrary({ dir: join(dir, 'flat.yaml'), env: {} });
    assert.equal(notDir.stats().external, false);
    assert.ok(notDir.warnings().some((w) => w.includes('不是目录')));
  });
});

// ---------------------------------------------------------------------------
// ③ handler 输出确实来自词库
// ---------------------------------------------------------------------------

function ctxOf(command: string, values: Record<string, string | number | boolean> = {}, sub: string | null = null) {
  return makeContext({ command, sub, channelId: 'C1', userId: 'U1', values });
}

describe('W4 · /help 与 /rules 的输出来自 Dice! 词库', () => {
  test('/help 无参：正文是 strHlpMsg 原文（另附 Discord 记法注记，不改正文）', async () => {
    const env = makeEnv();
    const reply = await route(ctxOf('help'), env.deps);
    assert.notEqual(reply.ephemeral, true);
    assert.ok(reply.content.startsWith(DEFAULTS.messages.strHlpMsg), reply.content.slice(0, 80));
    assert.ok(reply.content.includes('.help群管 查看群管指令'), '必须含 Dice! 原文片段');
    assert.ok(reply.content.includes('.xxx'), '应附 Discord 记法注记');
  });

  test('/help query:指令：多段拼接后的全文进入回执', async () => {
    const env = makeEnv();
    const reply = await route(ctxOf('help', { query: '指令' }), env.deps);
    assert.ok(reply.content.startsWith('【指令】\n'), reply.content.slice(0, 40));
    assert.ok(reply.content.includes('指令前接at可以指定骰娘响应'), '含第 1 段');
    assert.ok(reply.content.includes('.mod 模块操作跑团指令'), '第 1/2 段的拼接边界可见');
    assert.ok(reply.content.includes('更多个性化指令参见.help 扩展指令'), '含第 3 段结尾');
  });

  test('/help query:r：命中 Dice! 的 .r 词条原文', async () => {
    const env = makeEnv();
    const reply = await route(ctxOf('help', { query: 'r' }), env.deps);
    assert.ok(reply.content.includes('掷骰：.r [掷骰表达式]'), reply.content.slice(0, 80));
    assert.ok(reply.content.includes('合法参数要求掷骰轮数1-10'));
  });

  test('/rules query:检定：走词库别名解析（检定 → rc/ra）', async () => {
    const env = makeEnv();
    const reply = await route(ctxOf('rules', { query: '检定' }, 'query'), env.deps);
    assert.ok(reply.content.startsWith('【COC7｜检定】'), reply.content.slice(0, 40));
    assert.ok(reply.content.includes('检定指令：.rc/ra'), reply.content);
    assert.equal(reply.content.includes('&rc/ra'), false, '别名必须被解析掉');
  });

  test('未命中：你是不是想找 = 词库 suggest() 的结果，且建议项都是真实词条', async () => {
    const env = makeEnv();
    const lib = createLibrary({ dir: null, env: {} });
    const near = lib.suggest('力量', 8);
    assert.ok(near.length > 0, '力量 应有近似词条');

    const reply = await route(ctxOf('help', { query: '力量' }), env.deps);
    assert.ok(reply.content.includes(`你是不是想找：${near.join('、')}`), reply.content.slice(0, 120));
    for (const name of near) {
      assert.ok(lib.lookup(name), `建议项「${name}」必须能查到`);
    }
    assert.ok(reply.content.includes(`【${near[0]}】`), '应给出前 3 条的预览');

    const nothing = await route(ctxOf('help', { query: 'zzzzz-不存在的词条' }), env.deps);
    assert.ok(nothing.content.includes('也没有相近的词条'), nothing.content.slice(0, 80));
  });
});

// ---------------------------------------------------------------------------
// ④ DICE_LIBRARY_DIR 端到端（handler 用进程环境变量）
// ---------------------------------------------------------------------------

describe('W4 · DICE_LIBRARY_DIR 端到端（getLibrary 单例 + handler）', () => {
  test('设置环境变量后 /help 与 /help query: 立即走外部词库；恢复后回落到内置', async () => {
    const dir = tempDir('e2e');
    writeFileSync(
      join(dir, 'overlay.json'),
      JSON.stringify({ entries: { 本机扩展: '【外部覆盖】' }, messages: { strHlpMsg: '【外部总览】' } }),
      'utf8',
    );
    const saved = process.env.DICE_LIBRARY_DIR;
    try {
      process.env.DICE_LIBRARY_DIR = dir;
      resetLibrary();
      const env = makeEnv();
      const overview = await route(ctxOf('help'), env.deps);
      assert.ok(overview.content.startsWith('【外部总览】'), overview.content.slice(0, 40));
      const hit = await route(ctxOf('help', { query: '本机扩展' }), env.deps);
      assert.ok(hit.content.includes('【外部覆盖】'), hit.content.slice(0, 60));
    } finally {
      if (saved === undefined) delete process.env.DICE_LIBRARY_DIR;
      else process.env.DICE_LIBRARY_DIR = saved;
      resetLibrary();
    }

    const env = makeEnv();
    const back = await route(ctxOf('help'), env.deps);
    assert.ok(back.content.startsWith(DEFAULTS.messages.strHlpMsg), '恢复环境后必须回落到内置词库');
    const backHit = await route(ctxOf('help', { query: '本机扩展' }), env.deps);
    assert.ok(backHit.content.includes('本机在 Dice! 词库之外提供的 Discord 指令'), backHit.content.slice(0, 60));
  });
});
