/**
 * Dice! 词库（`/help` `/rules`）与导入脚本解析器。
 *
 * - 解析器：转义 / 原始字符串 / 相邻拼接 / 跳过非字符串·注释·条件编译 / 重复 key 去重；
 * - 词库：`overview` / `lookup`（精确→大小写不敏感→别名）/ `suggest` / `terms` / `stats`；
 * - 外部词库目录（`DICE_LIBRARY_DIR`）：优先级 + 坏文件容错；
 * - handler：`/help` `/rules` 的输出确实来自 Dice! 原文。
 *
 * 临时目录一律用包内 `tests/.tmp/`（系统 TEMP 会被沙箱拒绝）。
 * Run: node tests/bot/library.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SOURCE_LABEL,
  buildDefaults,
  parseGlobalVar,
  serializeDefaults,
} from '../../scripts/import-dice-library.ts';
import { createLibrary, getLibrary, resetLibrary } from '../../src/bot/library/library.ts';
import { route } from '../../src/bot/router.ts';
import { makeContext, makeEnv, type CtxSpec, type TestEnv } from './fakes.ts';
import type { InteractionContext } from '../../src/contracts/bot.ts';

const TMP_ROOT = fileURLToPath(new URL('../.tmp/', import.meta.url));
mkdirSync(TMP_ROOT, { recursive: true });

const GLOBAL_VAR = fileURLToPath(new URL('../../../ref/Dice/Dice/GlobalVar.cpp', import.meta.url));
const DEFAULTS_JSON = fileURLToPath(new URL('../../src/bot/library/dice-defaults.json', import.meta.url));

/** 手写 fixture：覆盖转义、原始串、自定义定界符、相邻拼接、注释、条件编译、重复 key。 */
const FIXTURE = String.raw`// fixture：模仿 GlobalVar.cpp 的初始化列表
const dict_ci<string> PlainMsg
{
	{"strSimple","普通\"引号\"与反斜杠\\结束"},
	{"strTabs","制表\t换行\n结束"},
	{"strMulti", R"(第一段
第二段)"},
	{"strConcat", R"(A)" R"(B)" R"(C)"},
	{"strMixedConcat", "head-" R"(tail)"},
	{"strDelim", R"xy(内部 )" 与 )xy 都安全)xy"},
	{"strSkipNumber", 42},
	{"strSkipCall", someFunc(1, 2)},
	{"strCommented", "保留"}, // {"strCommentedOut","丢弃"}
	/* {"strBlockCommented","丢弃"} */
#if 0
	{"strIfdefZero","丢弃"},
#endif
	{"strDup","第一版"},
	{"strDup","第二版"},
};
const dict_ci<> HelpDoc = {
	{"log", R"(跑团日志记录.log
.log new 日志名 新开日志)"},
	{"退群", "&dismiss"},
	{"dismiss", "该指令需要群管理员权限，使用后即退出群聊"},
	{"奖励骰", "&奖励/惩罚骰"},
	{"奖励/惩罚骰", "COC中奖励/惩罚骰是额外投掷的十位骰"},
};
const dict_ci<string> GlobalComment{
	{"self", "自称"},
};
`;

describe('import-dice-library：解析器', () => {
  const parsed = parseGlobalVar(FIXTURE);

  test('普通字符串的转义（\\" 与 \\\\ 与 \\t \\n）', () => {
    assert.equal(parsed.messages.strSimple, '普通"引号"与反斜杠\\结束');
    assert.equal(parsed.messages.strTabs, '制表\t换行\n结束');
  });

  test('原始字符串 R"(...)" 保留换行、不处理转义', () => {
    assert.equal(parsed.messages.strMulti, '第一段\n第二段');
  });

  test('自定义定界符 R"xy(...)xy" 内部 )" 不提前结束', () => {
    assert.equal(parsed.messages.strDelim, '内部 )" 与 )xy 都安全');
  });

  test('相邻拼接的多段原始串/普通串按 C++ 规则拼接', () => {
    assert.equal(parsed.messages.strConcat, 'ABC');
    assert.equal(parsed.messages.strMixedConcat, 'head-tail');
  });

  test('跳过非字符串项、注释、块注释与条件编译块', () => {
    assert.equal(parsed.messages.strSkipNumber, undefined, '数字项应跳过');
    assert.equal(parsed.messages.strSkipCall, undefined, '函数调用应跳过');
    assert.equal(parsed.messages.strCommented, '保留');
    assert.equal(parsed.messages.strCommentedOut, undefined, '行注释内的项应跳过');
    assert.equal(parsed.messages.strBlockCommented, undefined, '块注释内的项应跳过');
    assert.equal(parsed.messages.strIfdefZero, undefined, '#if 0 块应整块跳过');
    const plain = parsed.dicts.find((dict) => dict.name === 'PlainMsg');
    assert.equal(plain?.skippedItems, 2);
  });

  test('帮助词条进 entries，非导出字典被记录', () => {
    assert.ok(parsed.entries.log.includes('跑团日志记录.log'));
    assert.equal(parsed.entries['退群'], '&dismiss');
    assert.equal(parsed.entries.dismiss, '该指令需要群管理员权限，使用后即退出群聊');
    assert.equal(parsed.dicts.find((dict) => dict.name === 'HelpDoc')?.exportedAs, 'entries');
    assert.equal(parsed.dicts.find((dict) => dict.name === 'GlobalComment')?.exportedAs, 'skipped');
    assert.ok(parsed.notes.some((note) => note.includes('GlobalComment')));
  });

  test('同一字典内重复 key 以最后一次为准并记录', () => {
    assert.equal(parsed.messages.strDup, '第二版');
    assert.deepEqual(parsed.duplicates, [{ dict: 'PlainMsg', key: 'strDup', count: 2 }]);
  });

  test('序列化稳定：重复构建字节一致且键有序', () => {
    const first = serializeDefaults(buildDefaults(FIXTURE, 'fixture.cpp'));
    const second = serializeDefaults(buildDefaults(FIXTURE, 'fixture.cpp'));
    assert.equal(first, second);
    assert.ok(first.endsWith('\n'));
    const json = JSON.parse(first) as { messages: Record<string, string>; entries: Record<string, string> };
    assert.deepEqual(Object.keys(json.messages), [...Object.keys(json.messages)].sort());
    assert.deepEqual(Object.keys(json.entries), [...Object.keys(json.entries)].sort());
  });

  test(
    '产物 dice-defaults.json 与 GlobalVar.cpp 的抽取结果一致（脚本可重复运行）',
    { skip: !existsSync(GLOBAL_VAR) },
    () => {
      const expected = serializeDefaults(buildDefaults(readFileSync(GLOBAL_VAR, 'utf8'), DEFAULT_SOURCE_LABEL));
      assert.equal(readFileSync(DEFAULTS_JSON, 'utf8'), expected);
    },
  );
});

describe('Dice! 词库：内置内容与查询', () => {
  test('overview() 是 Dice! 的 strHlpMsg 原文', () => {
    const library = createLibrary();
    assert.ok(library.overview().includes('.help协议 确认服务协议'));
    assert.ok(library.overview().includes('官方论坛: https://forum.kokona.tech/'));
  });

  test('stats() 反映 Dice! 内置表规模，无外部词库', () => {
    const stats = createLibrary().stats();
    assert.ok(stats.messages >= 300, `messages=${stats.messages}`);
    assert.ok(stats.entries >= 140, `entries=${stats.entries}`);
    assert.equal(stats.external, false);
    assert.equal(stats.externalFiles, 0);
    assert.ok(stats.terms >= stats.entries);
  });

  test('lookup()：精确 → 大小写不敏感 → 别名链', () => {
    const library = createLibrary();
    assert.ok(library.lookup('r')?.text.includes('.r [掷骰表达式]'));
    assert.equal(library.lookup('LOG')?.term, 'log');
    assert.ok(library.lookup('LOG')?.text.includes('.log new 日志名'));
    // `&dismiss` / `&奖励/惩罚骰` 是 Dice! 的别名写法，应解析到目标词条
    assert.equal(library.lookup('退群')?.text, library.lookup('dismiss')?.text);
    assert.equal(library.lookup('奖励骰')?.text, library.lookup('奖励/惩罚骰')?.text);
    assert.equal(library.lookup('  '), null);
    assert.equal(library.lookup('绝对不存在的词条'), null);
  });

  test('suggest()：前缀/子串/编辑距离，且给不出就是空', () => {
    const library = createLibrary();
    assert.deepEqual(library.suggest('暗骰子').slice(0, 2), ['暗骰子区', '暗骰']);
    assert.ok(library.suggest('setco').includes('setcoc'));
    assert.deepEqual(library.suggest('zzz'), []);
    assert.deepEqual(library.suggest('不存在的词'), []);
  });

  test('terms() 有序且覆盖 Dice! 词条与本机适配词条', () => {
    const library = createLibrary();
    const terms = library.terms();
    assert.deepEqual(terms, [...terms].sort());
    for (const name of ['r', 'log', 'setcoc', '规则', '本机扩展', '暗骰子区', '大失败']) {
      assert.ok(terms.includes(name), `缺少词条 ${name}`);
    }
  });

  test('内置文案可直接取用（strHelpNotFound 等）', () => {
    const library = createLibrary();
    assert.equal(library.message('strHelpNotFound'), '{self}未找到「{help_word}」相关的词条×');
    assert.equal(library.message('完全没有的key'), null);
  });
});

/** 造一个外部词库目录（调用方负责在 finally 里 rmSync）。 */
function makeLibraryDir(): string {
  const dir = mkdtempSync(join(TMP_ROOT, 'dcdice-lib-'));
  writeFileSync(join(dir, '10-dice-style.json'), JSON.stringify({
    entries: { 自定义词条: '来自外部 entries' },
    messages: { strHlpMsg: '外部总览' },
  }));
  writeFileSync(join(dir, '20-flat.json'), JSON.stringify({
    开局: '外部覆盖：开局说明',
    数字项: 42,
    布尔项: true,
  }));
  writeFileSync(join(dir, '30-block.yaml'), '外部词条: |\n  第一行\n  第二行\n引号词条: "带\\n换行"\n');
  writeFileSync(join(dir, '40-sections.yaml'), 'entries:\n  嵌套词条: 来自 yaml entries\n');
  writeFileSync(join(dir, '90-broken.json'), '{ 这不是 JSON');
  writeFileSync(join(dir, 'notes.txt'), '不是词库文件');
  return dir;
}

describe('外部词库目录', () => {
  test('json/yaml 均加载，且优先于 Dice! 内置与本机适配词条', () => {
    const dir = makeLibraryDir();
    try {
      const library = createLibrary({ dir });
      const stats = library.stats();
      assert.equal(stats.external, true);
      assert.equal(stats.externalFiles, 4, '坏文件与 .txt 不计入');
      assert.equal(library.dir(), dir);

      // 外部 entries 覆盖本机适配词条（`开局` 内置表里没有）
      assert.equal(library.lookup('开局')?.text, '外部覆盖：开局说明');
      assert.equal(library.lookup('开局')?.source, 'external');
      assert.equal(library.lookup('自定义词条')?.text, '来自外部 entries');
      assert.equal(library.lookup('嵌套词条')?.text, '来自 yaml entries');
      // 块标量 / 引号里的 \n
      assert.equal(library.lookup('外部词条')?.text, '第一行\n第二行');
      assert.equal(library.lookup('引号词条')?.text, '带\n换行');
      // 外部 messages 覆盖 Dice! 的 strHlpMsg
      assert.equal(library.overview(), '外部总览');
      // 内置词条仍在
      assert.ok(library.lookup('r')?.text.includes('.r [掷骰表达式]'));

      // 非字符串项与坏文件：跳过并记录，不抛异常
      assert.equal(library.lookup('数字项'), null);
      const warnings = library.warnings().join('\n');
      assert.ok(warnings.includes('数字项'), warnings);
      assert.ok(warnings.includes('90-broken.json'), warnings);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('目录不存在 / 不是目录 / 未配置：一律容错，内置词库照常可用', () => {
    const root = mkdtempSync(join(TMP_ROOT, 'dcdice-lib-'));
    try {
      const missing = createLibrary({ dir: join(root, 'not-here') });
      assert.equal(missing.stats().external, false);
      assert.ok(missing.warnings().some((line) => line.includes('不存在')));
      assert.ok(missing.lookup('r')?.text.includes('.r [掷骰表达式]'));

      const file = join(root, 'a-file.json');
      writeFileSync(file, '{}');
      const notDir = createLibrary({ dir: file });
      assert.equal(notDir.stats().external, false);

      const none = createLibrary({ dir: null, env: {} });
      assert.equal(none.stats().external, false);
      assert.equal(none.dir(), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('DICE_LIBRARY_DIR 环境变量：getLibrary() 单例按目录缓存并在变化后重建', () => {
    const dir = makeLibraryDir();
    const previous = process.env.DICE_LIBRARY_DIR;
    process.env.DICE_LIBRARY_DIR = dir;
    try {
      resetLibrary();
      const first = getLibrary();
      assert.equal(first.lookup('自定义词条')?.text, '来自外部 entries');
      assert.equal(first.stats().external, true);
      assert.equal(getLibrary(), first, '同一个目录应复用缓存实例');

      delete process.env.DICE_LIBRARY_DIR;
      const second = getLibrary();
      assert.equal(second.stats().external, false);
      assert.equal(second.lookup('自定义词条'), null);
    } finally {
      if (previous === undefined) delete process.env.DICE_LIBRARY_DIR;
      else process.env.DICE_LIBRARY_DIR = previous;
      resetLibrary();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// handler 接线
// ---------------------------------------------------------------------------

function cmd(
  env: TestEnv,
  command: string,
  values: Record<string, string | number | boolean> = {},
  overrides: Partial<CtxSpec> = {},
): InteractionContext {
  return makeContext({ command, channelId: 'C1', userId: 'U1', displayName: '甲', values, ...overrides }, env.platform);
}

describe('/help 与 /rules 走 Dice! 词库', () => {
  test('/help 无参 = Dice! strHlpMsg 原文 + Discord 记法注记（不篡改正文）', async () => {
    resetLibrary();
    const env = makeEnv();
    const reply = await route(cmd(env, 'help'), env.deps);
    assert.ok(reply.content.includes('.help协议 确认服务协议'), reply.content);
    assert.ok(reply.content.includes('官方论坛: https://forum.kokona.tech/'));
    assert.ok(reply.content.includes('`.xxx`'), '应提示 Dice! 的 .xxx ↔ /xxx 记法');
    assert.ok(reply.content.includes('/game'));
    assert.ok(reply.content.includes('/log'));
  });

  test('/help query:<Dice! 词条> 回原文；本机词条回本机说明', async () => {
    const env = makeEnv();
    const log = await route(cmd(env, 'help', { query: 'log' }), env.deps);
    assert.ok(log.content.includes('跑团日志记录.log'), log.content);
    assert.ok(log.content.includes('.log new 日志名'));

    const game = await route(cmd(env, 'help', { query: 'game' }), env.deps);
    assert.ok(game.content.includes('.game new 桌名'));

    const open = await route(cmd(env, 'help', { query: '开局' }), env.deps);
    assert.ok(open.content.includes('主场景'));
  });

  test('/help 未命中给出「你是不是想找」，完全没有则说明没有', async () => {
    const env = makeEnv();
    const near = await route(cmd(env, 'help', { query: '暗骰子' }), env.deps);
    assert.ok(near.content.includes('你是不是想找'));
    assert.ok(near.content.includes('暗骰子区'));

    const far = await route(cmd(env, 'help', { query: 'zzz' }), env.deps);
    assert.ok(far.content.includes('没有'));
  });

  test('/rules query 走同一词库：Dice! setcoc 原文 + 本机 COC7 术语', async () => {
    const env = makeEnv();
    const setcoc = await route(cmd(env, 'rules', { query: 'setcoc' }, { sub: 'query' }), env.deps);
    assert.ok(setcoc.content.includes('0 规则书'), setcoc.content);
    assert.ok(setcoc.content.includes('绿色三角洲'), 'Dice! 房规 6 的原文');

    const alias = await route(cmd(env, 'rules', { query: '规则' }, { sub: 'query' }), env.deps);
    assert.ok(alias.content.includes('.ruleset dnd'));

    const fumble = await route(cmd(env, 'rules', { query: '大失败' }, { sub: 'query' }), env.deps);
    assert.ok(fumble.content.includes('96'));
    assert.ok(fumble.content.includes('房规'));

    const unknown = await route(cmd(env, 'rules', { query: '不存在的词' }, { sub: 'query' }), env.deps);
    assert.ok(unknown.content.includes('没有'));
  });

  test('/rules set 行为保持（记录/清空/校验默认规则集）', async () => {
    const env = makeEnv();
    const set = await route(cmd(env, 'rules', { rule: 'COC7' }, { sub: 'set' }), env.deps);
    assert.notEqual(set.ephemeral, true);
    assert.equal(env.store.getDefaultRuleSet('G1'), 'coc7');

    const bad = await route(cmd(env, 'rules', { rule: 'nope' }, { sub: 'set' }), env.deps);
    assert.equal(bad.ephemeral, true);

    const cleared = await route(cmd(env, 'rules', {}, { sub: 'set' }), env.deps);
    assert.notEqual(cleared.ephemeral, true);
    assert.equal(env.store.getDefaultRuleSet('G1'), null);
  });
});
