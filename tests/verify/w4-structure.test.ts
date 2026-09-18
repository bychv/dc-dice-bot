/**
 * W4 独立验证 · 结构 / 命令清单漂移 / 写作用域
 *
 * 1) manifest、src/bot/spec/discord-commands.json、docs/discord-commands.json 三份深度相等（19 条）。
 * 2) `/pc clr`、`/st` **没有任何新增命令选项**：二次确认必须是回执组件而不是新 option。
 * 3) 本轮改动没有漂移权威 spec（用 mtime 佐证 spec 早于新特性文件）。
 * 4) handlers / registry / router / confirm / library / logFormat / jsonStore / gameCore 不依赖 discord.js。
 * 5) 新文件清单与其所属写作用域。
 *
 * Run: node tests/verify/w4-structure.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateManifest } from '../../src/bot/spec-validate.ts';

import {
  HANDLERS,
  HANDLER_NAMES,
  createRegistry,
  handlersWithoutCommand,
  missingHandlers,
} from '../../src/bot/registry.ts';
import { COMMANDS, COMMAND_NAMES } from '../../src/bot/manifest.ts';
import type { ApiCommand, ApiOption } from '../../src/contracts/manifest.ts';

const REPO = fileURLToPath(new URL('../../..', import.meta.url)); // F:\Git\dcdice
const BOT = join(REPO, 'bot');
const SRC = join(BOT, 'src');
const VERIFY_DIR = fileURLToPath(new URL('.', import.meta.url));

/** 独立实现的深度相等（键排序、数组顺序敏感）。 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[key] = (v as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return v;
  });
}

function readJson(path: string): ApiCommand[] {
  return JSON.parse(readFileSync(path, 'utf8')) as ApiCommand[];
}

function commandOf(list: ApiCommand[], name: string): ApiCommand {
  const found = list.find((c) => c.name === name);
  if (!found) throw new Error(`缺少命令 /${name}`);
  return found;
}

const DOCS = readJson(join(REPO, 'docs', 'discord-commands.json'));
const BUNDLED = readJson(join(SRC, 'bot', 'spec', 'discord-commands.json'));

describe('W4-结构 · 命令清单没有漂移', () => {
  test('三份清单深度相等，恰好 19 条且名称顺序不变', () => {
    assert.equal(canonical(COMMANDS), canonical(DOCS));
    assert.equal(canonical(BUNDLED), canonical(DOCS));
    assert.deepEqual(COMMAND_NAMES, [
      'help',
      'rules',
      'r',
      'rh',
      'rs',
      'game',
      'pc',
      'st',
      'rc',
      'ra',
      'setcoc',
      'sc',
      'ti',
      'li',
      'en',
      'log',
      'nn',
      'nnn',
      'name',
    ]);
    assert.equal(DOCS.length, 19);
    assert.deepEqual(missingHandlers(), []);
    assert.deepEqual(handlersWithoutCommand(), []);
    assert.equal(HANDLER_NAMES.length, 19);
    assert.equal(Object.keys(createRegistry()).length, 19);
    for (const name of COMMAND_NAMES) assert.equal(typeof HANDLERS[name], 'function');
  });

  test('/pc clr 没有任何新增 option（二次确认只能走回执组件）', () => {
    for (const list of [COMMANDS, BUNDLED, DOCS]) {
      const clr = commandOf(list, 'pc').options!.find((o) => o.name === 'clr');
      assert.ok(clr, '/pc 必须有 clr 子命令');
      assert.equal(clr.options, undefined, '/pc clr 不得带任何 option');
      assert.equal('options' in clr, false, '/pc clr 不得带 options 键');
      assert.equal('choices' in clr, false);
      // 不得出现 confirm / force / yes 之类的新 option
      const pcOptionNames = (commandOf(list, 'pc').options ?? []).map((o) => o.name);
      for (const forbidden of ['confirm', 'force', 'yes', 'confirm-clr']) {
        assert.ok(!pcOptionNames.includes(forbidden), `/pc 不得新增 option ${forbidden}`);
      }
    }
  });

  test('/st 仍然只有 text 一个 STRING 必填选项，clr 只是文本值', () => {
    for (const list of [COMMANDS, BUNDLED, DOCS]) {
      const st = commandOf(list, 'st');
      assert.equal(st.options?.length, 1, '/st 有且只有一个选项');
      const text: ApiOption = st.options![0];
      assert.equal(text.name, 'text');
      assert.equal(text.type, 3);
      assert.equal(text.required, true);
      assert.equal('choices' in text, false, '/st text 不应有 choices（clr 是自由文本值）');
      const described = `${text.description ?? ''} ${text.description_localizations?.['zh-CN'] ?? ''}`;
      assert.ok(
        described.includes('clr'),
        '/st text 的说明（含 zh-CN）应提到 clr 写法（说明这是文本值而非子命令）',
      );
    }
  });

  test('打包 spec 与权威 JSON 内容一致且通过 Discord 校验（替代原 mtime 启发式）', () => {
    // 原断言用 mtime 证明"本轮没改命令清单"；Lead 随后为修复 Discord 400 改了 keeper 的
    // zh-CN 本地化名（KP → kp），mtime 启发式不再成立。换成更耐久的等价约束：
    const docs = readFileSync(join(REPO, 'docs', 'discord-commands.json'), 'utf8');
    const bundled = readFileSync(join(SRC, 'bot', 'spec', 'discord-commands.json'), 'utf8');
    assert.equal(bundled, docs, '打包副本必须与 docs/discord-commands.json 逐字节一致');
    const problems = validateManifest(JSON.parse(docs) as never);
    assert.deepEqual(problems, [], `payload 不合法：\n${problems.join('\n')}`);
    // 命令清单仍是 19 条，且没有新增子命令
    assert.equal((JSON.parse(docs) as unknown[]).length, 19);
    assert.ok(statSync(join(SRC, 'bot', 'confirm.ts')).isFile());
  });
});

describe('W4-结构 · discord.js 依赖方向', () => {
  const IMPORT_RE =
    /from\s+['"]discord\.js['"]|require\(\s*['"]discord\.js['"]\s*\)|import\(\s*['"]discord\.js['"]\s*\)/;

  test('handlers/ 全部文件不 import discord.js', () => {
    const dir = join(SRC, 'bot', 'handlers');
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      const content = readFileSync(join(dir, file), 'utf8');
      assert.equal(IMPORT_RE.test(content), false, `handlers/${file} 不得 import discord.js`);
    }
  });

  test('registry.ts / router.ts / confirm.ts / library / logFormat / gameCore / jsonStore 不 import discord.js', () => {
    const files = [
      join(SRC, 'bot', 'registry.ts'),
      join(SRC, 'bot', 'router.ts'),
      join(SRC, 'bot', 'confirm.ts'),
      join(SRC, 'bot', 'logFormat.ts'),
      join(SRC, 'bot', 'handlers', 'gameCore.ts'),
      join(SRC, 'store', 'jsonStore.ts'),
      join(SRC, 'bot', 'library', 'library.ts'),
      join(SRC, 'bot', 'library', 'discord-entries.ts'),
    ];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      assert.equal(IMPORT_RE.test(content), false, `${relative(REPO, file)} 不得 import discord.js`);
      const offending = content
        .split(/\r?\n/)
        .filter((line) => line.includes('discord.js') && !/^\s*(?:\*|\/\/|\/\*)/.test(line));
      assert.deepEqual(offending, [], `${relative(REPO, file)} 的非注释行不得出现 discord.js`);
    }
  });

  test('adapter.ts 仍是唯一 import discord.js 的适配层', () => {
    assert.equal(IMPORT_RE.test(readFileSync(join(SRC, 'bot', 'adapter.ts'), 'utf8')), true);
  });
});

describe('W4-结构 · 新文件落在各自写作用域内', () => {
  const expected: Record<string, string> = {
    'bot/src/bot/confirm.ts': 'bot/src/bot',
    'bot/src/bot/logFormat.ts': 'bot/src/bot',
    'bot/src/bot/library/library.ts': 'bot/src/bot/library',
    'bot/src/bot/library/dice-defaults.json': 'bot/src/bot/library',
    'bot/src/bot/library/discord-entries.ts': 'bot/src/bot/library',
    'bot/scripts/import-dice-library.ts': 'bot/scripts',
    'bot/src/bot/handlers/help.ts': 'bot/src/bot/handlers',
    'bot/src/bot/handlers/rules.ts': 'bot/src/bot/handlers',
    'bot/src/bot/handlers/pc.ts': 'bot/src/bot/handlers',
    'bot/src/bot/handlers/st.ts': 'bot/src/bot/handlers',
    'bot/src/bot/handlers/gameCore.ts': 'bot/src/bot/handlers',
    'bot/src/store/jsonStore.ts': 'bot/src/store',
    'bot/src/bot/adapter.ts': 'bot/src/bot',
    'bot/src/bot/main.ts': 'bot/src/bot',
  };

  test('本轮涉及文件都存在且位于预期目录前缀下', () => {
    for (const [rel, scope] of Object.entries(expected)) {
      const full = join(REPO, rel);
      assert.ok(existsSync(full), `缺少文件 ${rel}`);
      const dir = rel.split('/').slice(0, -1).join('/');
      assert.ok(dir === scope, `${rel} 应属于 ${scope}，实际 ${dir}`);
    }
  });

  test('验证产物只落在 tests/verify/ 下（verifier2 的写作用域）', () => {
    assert.ok(existsSync(VERIFY_DIR));
    const mine = readdirSync(VERIFY_DIR).filter((f) => f.startsWith('w4-') && f.endsWith('.test.ts')).sort();
    assert.deepEqual(mine, [
      'w4-confirm-fs.test.ts',
      'w4-library.test.ts',
      'w4-logformat.test.ts',
      'w4-structure.test.ts',
    ]);
    for (const file of mine) {
      assert.equal(relative(REPO, join(VERIFY_DIR, file)).replace(/\\/g, '/').startsWith('bot/tests/verify/'), true);
    }
  });
});
