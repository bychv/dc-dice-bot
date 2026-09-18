/**
 * Spec conformance: the command manifest the bot registers must be exactly the documented set.
 * Owner: Lead (tests/spec is not owned by any implementation stream).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import { COMMANDS, COMMAND_NAMES, OPTION_TYPE, optionNames } from '../../src/bot/manifest.ts';
import { validateManifest } from '../../src/bot/spec-validate.ts';

const docsPath = fileURLToPath(new URL('../../../docs/discord-commands.json', import.meta.url));

interface JsonCommand {
  name: string;
  description: string;
  description_localizations?: Record<string, string>;
  options?: JsonOption[];
}
interface JsonOption {
  type: number;
  name: string;
  description: string;
  name_localizations?: Record<string, string>;
  description_localizations?: Record<string, string>;
  required?: boolean;
  options?: JsonOption[];
  choices?: { name: string; value: string | number }[];
  channel_types?: number[];
  autocomplete?: boolean;
  min_value?: number;
  max_value?: number;
}

const documented = JSON.parse(readFileSync(docsPath, 'utf8')) as JsonCommand[];
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('command manifest vs docs/discord-commands.json', () => {
  test('has the same commands in the same order', () => {
    assert.deepEqual([...COMMAND_NAMES], documented.map((c) => c.name));
  });

  test('deep-equals the documented spec', () => {
    assert.deepEqual(clone(COMMANDS), clone(documented));
  });

  test('exposes 19 commands', () => {
    assert.equal(COMMANDS.length, 19);
  });

  test('uses only lowercase ASCII command names', () => {
    for (const name of COMMAND_NAMES) {
      assert.match(name, /^[a-z0-9_-]{1,32}$/);
    }
  });

  test('passes the Discord-side validation rules (含 name_localizations 大小写)', () => {
    const problems = validateManifest(COMMANDS);
    assert.deepEqual(problems, [], `payload 不合法：\n${problems.join('\n')}`);
  });
});

describe('option tree spot checks (docs §1.2 / §10 / §11)', () => {
  test('/game start carries name, keeper, thread and here', () => {
    const paths = optionNames('game');
    for (const p of ['start', 'start.name', 'start.keeper', 'start.thread', 'start.here']) {
      assert.ok(paths.includes(p), `missing ${p}`);
    }
  });

  test('/game end exposes the archive switch', () => {
    assert.ok(optionNames('game').includes('end.archive'));
  });

  test('/log has new, list, on, off and end(name)', () => {
    const paths = optionNames('log');
    for (const p of ['new', 'list', 'on', 'off', 'end', 'end.name']) {
      assert.ok(paths.includes(p), `missing ${p}`);
    }
  });

  test('/rh carries the hidden-roll thread controls', () => {
    const paths = optionNames('rh');
    for (const p of ['text', 'keeper', 'thread', 'reset']) {
      assert.ok(paths.includes(p), `missing ${p}`);
    }
  });

  test('thread options only accept thread channel types', () => {
    const threadTypes = [10, 11, 12];
    const rh = COMMANDS.find((c) => c.name === 'rh');
    const rhThread = rh?.options?.find((o) => o.name === 'thread');
    assert.equal(rhThread?.type, OPTION_TYPE.CHANNEL);
    assert.ok(rhThread?.channel_types?.every((t) => threadTypes.includes(t)));

    const game = COMMANDS.find((c) => c.name === 'game');
    const start = game?.options?.find((o) => o.name === 'start');
    const startThread = start?.options?.find((o) => o.name === 'thread');
    assert.equal(startThread?.type, OPTION_TYPE.CHANNEL);
    assert.ok(startThread?.channel_types?.every((t) => threadTypes.includes(t)));
  });

  test('text-parsed commands expose a string text option', () => {
    for (const name of ['st', 'r', 'rh', 'rs', 'rc', 'ra', 'sc', 'en']) {
      const cmd = COMMANDS.find((c) => c.name === name);
      assert.ok(cmd, `${name} missing`);
      const text = cmd?.options?.find((o) => o.name === 'text');
      assert.equal(text?.type, OPTION_TYPE.STRING, `${name}.text`);
    }
  });
});
