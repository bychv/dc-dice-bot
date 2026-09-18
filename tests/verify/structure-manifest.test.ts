/**
 * T4 独立验证 · 命令清单 / registry / 分层结构
 *
 * 1) manifest.ts（打包的 spec）与权威 docs/discord-commands.json 深度相等（自研比较器，
 *    键顺序无关、数组顺序有关）；打包副本与 docs 副本也深度相等。
 * 2) §2/§3-§12 的 19 条命令逐条核对子命令 / 选项名 / 类型 / choices / channel_types / min-max / required。
 * 3) manifest ↔ registry 一一对应（无缺失 / 无多余）。
 * 4) 依赖方向：handlers / registry / router 不得 import discord.js；adapter.ts 必须 import。
 *
 * Run: node tests/verify/structure-manifest.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { COMMANDS, COMMAND_NAMES } from '../../src/bot/manifest.ts';
import { HANDLER_NAMES, HANDLERS, createRegistry, handlersWithoutCommand, missingHandlers } from '../../src/bot/registry.ts';
import { OPTION_TYPE, THREAD_CHANNEL_TYPES } from '../../src/contracts/manifest.ts';
import type { ApiCommand, ApiOption, CommandManifest } from '../../src/contracts/manifest.ts';

const REPO = fileURLToPath(new URL('../../..', import.meta.url)); // F:\Git\dcdice
const SRC = fileURLToPath(new URL('../../src', import.meta.url));

/** 独立实现的深度相等：递归按键排序后 JSON.stringify（数组顺序敏感）。 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[key] = (val as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return val;
  });
}

function readSpec(path: string): CommandManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as CommandManifest;
}

function command(name: string): ApiCommand {
  const found = COMMANDS.find((c) => c.name === name);
  if (!found) throw new Error(`manifest 缺少命令 /${name}`);
  return found;
}

function optionAt(name: string, path: string[]): ApiOption {
  let options: ApiOption[] | undefined = command(name).options;
  let current: ApiOption | undefined;
  for (const part of path) {
    current = options?.find((o) => o.name === part);
    if (!current) throw new Error(`/${name} 缺少选项 ${path.slice(0, path.indexOf(part) + 1).join(' ')}`);
    options = current.options;
  }
  if (!current) throw new Error(`/${name} 选项路径为空`);
  return current;
}

function subcommandNames(name: string): string[] {
  return (command(name).options ?? []).filter((o) => o.type === OPTION_TYPE.SUB_COMMAND).map((o) => o.name);
}

function threadOption(option: ApiOption, label: string): void {
  assert.equal(option.type, OPTION_TYPE.CHANNEL, `${label} 必须是 CHANNEL`);
  assert.deepEqual((option.channel_types ?? []).slice().sort((a, b) => a - b), [...THREAD_CHANNEL_TYPES].sort((a, b) => a - b), `${label} 只接受子区类型`);
}

describe('T4 · 命令清单与权威 JSON 一致性', () => {
  test('manifest（打包 spec）与 docs/discord-commands.json 深度相等', () => {
    const docs = readSpec(join(REPO, 'docs', 'discord-commands.json'));
    assert.equal(canonical(COMMANDS), canonical(docs), '打包 spec 与权威 JSON 必须完全一致');
  });

  test('打包副本 src/bot/spec/discord-commands.json 与 docs 副本深度相等', () => {
    const docs = readSpec(join(REPO, 'docs', 'discord-commands.json'));
    const bundled = readSpec(join(SRC, 'bot', 'spec', 'discord-commands.json'));
    assert.equal(canonical(bundled), canonical(docs));
  });

  test('恰好 19 条命令，名称/顺序与 §2 总览表一致且全为 ASCII 小写', () => {
    assert.deepEqual(
      COMMAND_NAMES,
      ['help', 'rules', 'r', 'rh', 'rs', 'game', 'pc', 'st', 'rc', 'ra', 'setcoc', 'sc', 'ti', 'li', 'en', 'log', 'nn', 'nnn', 'name'],
    );
    for (const name of COMMAND_NAMES) assert.match(name, /^[a-z]+$/, `命令名必须 ASCII 小写：${name}`);
  });

  test('每条命令都有 description 与 zh-CN 本地化', () => {
    for (const cmd of COMMANDS) {
      assert.ok(cmd.description && cmd.description.length > 0, `/${cmd.name} 缺 description`);
      assert.ok(cmd.description_localizations?.['zh-CN'], `/${cmd.name} 缺 description_localizations.zh-CN`);
      for (const opt of cmd.options ?? []) {
        assert.ok(opt.description && opt.description.length > 0, `/${cmd.name} 的 ${opt.name} 缺 description`);
      }
    }
  });
});

describe('T4 · 19 条命令选项逐条核对（对照 §3-§12 表格）', () => {
  test('/help：query STRING 选填', () => {
    const query = optionAt('help', ['query']);
    assert.equal(query.type, OPTION_TYPE.STRING);
    assert.notEqual(query.required, true);
  });

  test('/rules：query 子命令（query 必填 STRING + rule 选填 choices）与 set 子命令', () => {
    assert.deepEqual(subcommandNames('rules'), ['query', 'set']);
    const query = optionAt('rules', ['query', 'query']);
    assert.equal(query.type, OPTION_TYPE.STRING);
    assert.equal(query.required, true);
    const rule = optionAt('rules', ['query', 'rule']);
    assert.equal(rule.type, OPTION_TYPE.STRING);
    assert.notEqual(rule.required, true);
    assert.deepEqual((rule.choices ?? []).map((c) => c.value), ['coc', 'coc7', 'dnd']);

    const setRule = optionAt('rules', ['set', 'rule']);
    assert.equal(setRule.type, OPTION_TYPE.STRING);
    assert.notEqual(setRule.required, true);
    // 已知文档内部不一致（已写进 T4 报告）：§3.2 表格写 STRING(choices)，权威 JSON 无 choices。
    assert.equal(setRule.choices, undefined);
  });

  test('/r /rs /rh：text 选项与暗骰三件套', () => {
    const r = optionAt('r', ['text']);
    assert.equal(r.type, OPTION_TYPE.STRING);
    assert.notEqual(r.required, true, '§4.1：text 可省略（默认 d100）');
    assert.equal(optionAt('rs', ['text']).required, true, '§4.3：text 必填');

    assert.notEqual(optionAt('rh', ['text']).required, true);
    assert.equal(optionAt('rh', ['keeper']).type, OPTION_TYPE.USER);
    threadOption(optionAt('rh', ['thread']), '/rh thread');
    const reset = optionAt('rh', ['reset']);
    assert.equal(reset.type, OPTION_TYPE.BOOLEAN);
    assert.notEqual(reset.required, true);
  });

  test('/game：start / list / switch / state / end', () => {
    assert.deepEqual(subcommandNames('game'), ['start', 'list', 'switch', 'state', 'end']);
    assert.equal(optionAt('game', ['start', 'name']).type, OPTION_TYPE.STRING);
    assert.equal(optionAt('game', ['start', 'keeper']).type, OPTION_TYPE.USER);
    threadOption(optionAt('game', ['start', 'thread']), '/game start thread');
    assert.equal(optionAt('game', ['start', 'here']).type, OPTION_TYPE.BOOLEAN);
    assert.equal(optionAt('game', ['switch', 'game']).required, true, '§10.1：switch.game 必填');
    assert.notEqual(optionAt('game', ['end', 'game']).required, true);
    const archive = optionAt('game', ['end', 'archive']);
    assert.equal(archive.type, OPTION_TYPE.BOOLEAN);
    assert.notEqual(archive.required, true);
    assert.equal((command('game').options ?? []).find((o) => o.name === 'list')?.options, undefined);
    assert.equal((command('game').options ?? []).find((o) => o.name === 'state')?.options, undefined);
  });

  test('/pc：12 个子命令与 required 标记', () => {
    assert.deepEqual(subcommandNames('pc'), ['new', 'tag', 'show', 'rename', 'copy', 'del', 'list', 'grp', 'build', 'redo', 'clr', 'stat']);
    assert.notEqual(optionAt('pc', ['new', 'name']).required, true);
    assert.equal(optionAt('pc', ['new', 'template']).type, OPTION_TYPE.STRING);
    assert.equal(optionAt('pc', ['new', 'text']).type, OPTION_TYPE.STRING);
    assert.notEqual(optionAt('pc', ['tag', 'name']).required, true);
    assert.notEqual(optionAt('pc', ['show', 'name']).required, true);
    assert.equal(optionAt('pc', ['rename', 'name']).required, true);
    assert.equal(optionAt('pc', ['copy', 'from']).required, true);
    assert.equal(optionAt('pc', ['copy', 'to']).required, true);
    assert.equal(optionAt('pc', ['del', 'name']).required, true);
    assert.equal(optionAt('pc', ['build', 'name']).required, true);
    assert.equal(optionAt('pc', ['redo', 'name']).required, true);
    for (const bare of ['list', 'grp', 'clr', 'stat']) {
      assert.equal((command('pc').options ?? []).find((o) => o.name === bare)?.options, undefined, `/pc ${bare} 无选项`);
    }
  });

  test('/st /rc /ra /sc /en：唯一 text 必填；/ti /li 无选项', () => {
    for (const name of ['st', 'rc', 'ra', 'sc', 'en']) {
      const text = optionAt(name, ['text']);
      assert.equal(text.type, OPTION_TYPE.STRING, `/${name} text 必须是 STRING`);
      assert.equal(text.required, true, `/${name} text 必填`);
    }
    for (const name of ['ti', 'li']) {
      assert.equal(command(name).options, undefined, `/${name} 应无选项`);
    }
  });

  test('/setcoc：set.rule 必填 INTEGER choices 0-6；show / clr 无选项', () => {
    assert.deepEqual(subcommandNames('setcoc'), ['set', 'show', 'clr']);
    const rule = optionAt('setcoc', ['set', 'rule']);
    assert.equal(rule.type, OPTION_TYPE.INTEGER);
    assert.equal(rule.required, true);
    assert.deepEqual((rule.choices ?? []).map((c) => c.value), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal((command('setcoc').options ?? []).find((o) => o.name === 'show')?.options, undefined);
    assert.equal((command('setcoc').options ?? []).find((o) => o.name === 'clr')?.options, undefined);
  });

  test('/log：new(name,game) / list / on / off / end(name)', () => {
    assert.deepEqual(subcommandNames('log'), ['new', 'list', 'on', 'off', 'end']);
    assert.equal(optionAt('log', ['new', 'name']).type, OPTION_TYPE.STRING);
    assert.notEqual(optionAt('log', ['new', 'name']).required, true);
    assert.equal(optionAt('log', ['new', 'game']).type, OPTION_TYPE.STRING);
    assert.notEqual(optionAt('log', ['end', 'name']).required, true);
    for (const bare of ['list', 'on', 'off']) {
      assert.equal((command('log').options ?? []).find((o) => o.name === bare)?.options, undefined, `/log ${bare} 无选项`);
    }
  });

  test('/nn /nnn /name：称呼与随机姓名', () => {
    assert.deepEqual(subcommandNames('nn'), ['set', 'del', 'clr']);
    assert.equal(optionAt('nn', ['set', 'name']).required, true);
    assert.equal((command('nn').options ?? []).find((o) => o.name === 'del')?.options, undefined);

    assert.deepEqual((optionAt('nnn', ['lang']).choices ?? []).map((c) => c.value), ['cn', 'jp', 'en']);
    assert.deepEqual((optionAt('name', ['lang']).choices ?? []).map((c) => c.value), ['cn', 'jp', 'en']);
    const count = optionAt('name', ['count']);
    assert.equal(count.type, OPTION_TYPE.INTEGER);
    assert.equal(count.min_value, 1);
    assert.equal(count.max_value, 10);
    assert.notEqual(count.required, true);
  });

  test('所有 CHANNEL 选项都限制为子区类型（11/12/10）', () => {
    for (const cmd of COMMANDS) {
      const walk = (opts: ApiOption[] | undefined, path: string): void => {
        for (const opt of opts ?? []) {
          if (opt.type === OPTION_TYPE.CHANNEL) threadOption(opt, `${path} ${opt.name}`);
          walk(opt.options, `${path} ${opt.name}`);
        }
      };
      walk(cmd.options, `/${cmd.name}`);
    }
  });
});

describe('T4 · manifest ↔ registry 交叉检查', () => {
  test('19 条命令与 19 个 handler 一一对应（无缺失 / 无多余）', () => {
    assert.deepEqual(missingHandlers(), [], 'manifest 有命令但 registry 没有 handler');
    assert.deepEqual(handlersWithoutCommand(), [], 'registry 有 handler 但 manifest 没有命令');
    assert.equal(HANDLER_NAMES.length, 19);
    assert.deepEqual([...HANDLER_NAMES].sort(), [...COMMAND_NAMES].sort());
    assert.equal(Object.keys(createRegistry()).length, 19);
  });

  test('每个 handler 都是函数且 registry 不共享可变状态', () => {
    for (const name of COMMAND_NAMES) {
      assert.equal(typeof HANDLERS[name], 'function', `/${name} 的 handler 必须是函数`);
    }
    const a = createRegistry();
    const b = createRegistry();
    assert.notEqual(a, b);
    delete a['name'];
    assert.ok(b['name'], 'createRegistry 必须返回副本');
  });
});

describe('T4 · 分层依赖（discord.js 只能在 adapter）', () => {
  const IMPORT_RE = /from\s+['"]discord\.js['"]|require\(\s*['"]discord\.js['"]\s*\)|import\(\s*['"]discord\.js['"]\s*\)/;

  test('handlers/ 下没有任何 discord.js 依赖（连注释都没有）', () => {
    const dir = join(SRC, 'bot', 'handlers');
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      const content = readFileSync(join(dir, file), 'utf8');
      if (content.includes('discord.js')) offenders.push(file);
      if (IMPORT_RE.test(content)) offenders.push(`${file} (import)`);
    }
    assert.deepEqual(offenders, []);
  });

  test('registry.ts 不依赖 discord.js', () => {
    const content = readFileSync(join(SRC, 'bot', 'registry.ts'), 'utf8');
    assert.equal(content.includes('discord.js'), false);
    assert.equal(IMPORT_RE.test(content), false);
  });

  test('router.ts 不 import discord.js（任务清单的字面 grep 会命中注释，属误报）', () => {
    const content = readFileSync(join(SRC, 'bot', 'router.ts'), 'utf8');
    assert.equal(IMPORT_RE.test(content), false, 'router 绝不能 import discord.js');
    // 任务清单给的 `grep -r "discord.js" ... router.ts` 非空：唯一命中是第 4 行注释里的库名，
    // 不是依赖。此处把事实固定下来，避免后续误判为违规。
    assert.ok(content.includes('discord.js'), '唯一命中应为注释文字');
    const offendingLines = content
      .split(/\r?\n/)
      .filter((line) => line.includes('discord.js') && !/^\s*(?:\*|\/\/|\/\*)/.test(line));
    assert.deepEqual(offendingLines, [], `非注释行不得出现 discord.js：${offendingLines.join(' | ')}`);
  });

  test('adapter.ts 是唯一（必须）使用 discord.js 的适配层', () => {
    const content = readFileSync(join(SRC, 'bot', 'adapter.ts'), 'utf8');
    assert.equal(IMPORT_RE.test(content), true, 'adapter.ts 必须 import discord.js');
  });

  test('handlers 只通过契约与 router 交互（不 import adapter/main/deploy）', () => {
    const dir = join(SRC, 'bot', 'handlers');
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      const content = readFileSync(join(dir, file), 'utf8');
      for (const forbidden of ['adapter.ts', 'main.ts', 'deploy.ts']) {
        assert.ok(!content.includes(forbidden), `${file} 不得依赖 ${forbidden}`);
      }
    }
  });
});
