/**
 * `/help`, `/rules`, `/nn`, `/nnn`, `/name`, `/ti`, `/li` behaviour + registry/router coverage.
 * Run: node tests/bot/misc.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { route } from '../../src/bot/router.ts';
import { HANDLER_NAMES, handlersWithoutCommand, missingHandlers } from '../../src/bot/registry.ts';
import { COMMAND_NAMES } from '../../src/bot/manifest.ts';
import { FixedRng, makeContext, makeEnv, type CtxSpec, type TestEnv } from './fakes.ts';
import type { InteractionContext } from '../../src/contracts/bot.ts';
import type { MemoryStore } from './fakes.ts';

function cmd(
  env: TestEnv,
  command: string,
  values: Record<string, string | number | boolean> = {},
  overrides: Partial<CtxSpec> = {},
): InteractionContext {
  return makeContext({ command, channelId: 'C1', userId: 'U1', displayName: '甲', values, ...overrides }, env.platform);
}

describe('registry + router', () => {
  test('every documented command has exactly one handler', () => {
    assert.deepEqual(missingHandlers(), []);
    assert.deepEqual(handlersWithoutCommand(), []);
    assert.equal(HANDLER_NAMES.length, 19);
    assert.equal(COMMAND_NAMES.length, 19);
    assert.deepEqual([...HANDLER_NAMES].sort(), [...COMMAND_NAMES].sort());
  });

  test('an unknown command is refused', async () => {
    const env = makeEnv();
    const reply = await route(cmd(env, 'nope'), env.deps);
    assert.equal(reply.ephemeral, true);
    assert.ok(reply.content.includes('未知命令'));
  });

  test('a throwing handler never escapes as an exception', async () => {
    const env = makeEnv();
    const broken = Object.create(env.store) as MemoryStore;
    broken.listGames = () => {
      throw new Error('store exploded');
    };
    const reply = await route(cmd(env, 'game', {}, { sub: 'list' }), { ...env.deps, store: broken });
    assert.equal(reply.ephemeral, true);
    assert.ok(reply.content.includes('store exploded'));
  });
});

describe('/help and /rules', () => {
  test('/help without a query shows the overview', async () => {
    const env = makeEnv();
    const reply = await route(cmd(env, 'help'), env.deps);
    assert.ok(reply.content.includes('/game'));
    assert.ok(reply.content.includes('/log'));
  });

  test('/help with a known query answers and with an unknown one suggests entries', async () => {
    const env = makeEnv();
    const known = await route(cmd(env, 'help', { query: '开局' }), env.deps);
    assert.ok(known.content.includes('主场景'));

    const near = await route(cmd(env, 'help', { query: '暗骰子' }), env.deps);
    assert.ok(near.content.includes('你是不是想找'));
    assert.ok(near.content.includes('暗骰子区'));

    const far = await route(cmd(env, 'help', { query: 'zzz' }), env.deps);
    assert.ok(far.content.includes('没有'));
  });

  test('/rules query looks up COC7 entries and /rules set stores the default rule set', async () => {
    const env = makeEnv();
    const query = await route(cmd(env, 'rules', { query: '大失败' }, { sub: 'query' }), env.deps);
    assert.ok(query.content.includes('96'));
    assert.ok(query.content.includes('房规'));

    const unknown = await route(cmd(env, 'rules', { query: '不存在的词' }, { sub: 'query' }), env.deps);
    assert.ok(unknown.content.includes('没有'));

    const set = await route(cmd(env, 'rules', { rule: 'COC7' }, { sub: 'set' }), env.deps);
    assert.notEqual(set.ephemeral, true);
    assert.equal(env.store.getDefaultRuleSet('G1'), 'coc7');

    const cleared = await route(cmd(env, 'rules', {}, { sub: 'set' }), env.deps);
    assert.notEqual(cleared.ephemeral, true);
    assert.equal(env.store.getDefaultRuleSet('G1'), null);

    const bad = await route(cmd(env, 'rules', { rule: 'nope' }, { sub: 'set' }), env.deps);
    assert.equal(bad.ephemeral, true);
  });
});

describe('/nn, /nnn, /name', () => {
  test('/nn set shows up as the 【称呼】 prefix on rolls; del removes it', async () => {
    const env = makeEnv();
    const set = await route(cmd(env, 'nn', { name: 'kp' }, { sub: 'set' }), env.deps);
    assert.notEqual(set.ephemeral, true);
    assert.equal(env.store.getNick('G1', 'C1', 'U1'), 'kp');

    const roll = await route(cmd(env, 'r', { text: '1d100' }), env.deps);
    assert.ok(roll.content.includes('【kp】'), roll.content);

    await route(cmd(env, 'nn', {}, { sub: 'del' }), env.deps);
    assert.equal(env.store.getNick('G1', 'C1', 'U1'), null);

    await route(cmd(env, 'nn', { name: 'kp' }, { sub: 'set' }), env.deps);
    const clr = await route(cmd(env, 'nn', {}, { sub: 'clr' }), env.deps);
    assert.ok(clr.content.includes('1'));
    assert.equal(env.store.getNick('G1', 'C1', 'U1'), null);
  });

  test('/nnn rolls a random name from the deck and stores it as the channel nickname', async () => {
    const env = makeEnv();
    const reply = await route(cmd(env, 'nnn', { lang: 'cn' }), env.deps);
    assert.notEqual(reply.ephemeral, true);
    assert.ok(env.store.getNick('G1', 'C1', 'U1'));
  });

  test('/name generates the requested number of names', async () => {
    const env = makeEnv();
    const reply = await route(cmd(env, 'name', { lang: 'en', count: 3 }), env.deps);
    const lines = reply.content.split('\n').filter((line) => /^\d\./.test(line));
    assert.equal(lines.length, 3);
    assert.ok(reply.content.includes('en'));
  });
});

describe('/ti and /li', () => {
  test('/ti rolls on the symptom table and expands phobias/manias', async () => {
    const env = makeEnv();
    env.deps.rng = new FixedRng([3]);
    const reply = await route(cmd(env, 'ti'), env.deps);
    assert.ok(reply.content.includes('1d10=3'));
    assert.ok(reply.content.includes('暴力倾向'));

    env.deps.rng = new FixedRng([9, 50]);
    const fear = await route(cmd(env, 'ti'), env.deps);
    assert.ok(fear.content.includes('1d100=50'));
    assert.ok(fear.content.includes('恐惧症'));
  });

  test('/li rolls the summary madness table and states its storage limitation', async () => {
    const env = makeEnv();
    env.deps.rng = new FixedRng([2, 4]);
    const reply = await route(cmd(env, 'li'), env.deps);
    assert.ok(reply.content.includes('总结'));
    assert.ok(reply.content.includes('1d10=2'));
    assert.ok(reply.content.includes('没有') || reply.content.includes('不累计'));
  });
});
