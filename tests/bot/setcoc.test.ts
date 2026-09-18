/**
 * `/setcoc` behaviour: session vs scene scope, effective order 局 > 场景 > 骰主默认, permissions.
 * Run: node tests/bot/setcoc.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { route } from '../../src/bot/router.ts';
import { makeContext, makeEnv, type CtxSpec, type TestEnv } from './fakes.ts';
import type { InteractionContext } from '../../src/contracts/bot.ts';

function setcocCtx(
  env: TestEnv,
  sub: string,
  values: Record<string, string | number | boolean> = {},
  overrides: Partial<CtxSpec> = {},
): InteractionContext {
  return makeContext({ command: 'setcoc', sub, channelId: 'C1', userId: 'U1', values, ...overrides }, env.platform);
}

async function roll(env: TestEnv, channelId: string, parentChannelId: string | null = null, userId = 'U1') {
  const ctx = makeContext({ command: 'rc', channelId, parentChannelId, userId, values: { text: '力量' } }, env.platform);
  return route(ctx, env.deps);
}

describe('/setcoc', () => {
  test('without a session it sets and clears the scene rule', async () => {
    const env = makeEnv();
    const set = await route(setcocCtx(env, 'set', { rule: 2 }), env.deps);
    assert.notEqual(set.ephemeral, true);
    assert.equal(env.store.getSceneRule('C1'), 2);

    const show = await route(setcocCtx(env, 'show'), env.deps);
    assert.ok(show.content.includes('2'));
    assert.ok(show.content.includes('场景房规'));

    await roll(env, 'C1');
    assert.equal(env.coc.checkCalls.at(-1)?.rule, 2);

    const clr = await route(setcocCtx(env, 'clr'), env.deps);
    assert.notEqual(clr.ephemeral, true);
    assert.equal(env.store.getSceneRule('C1'), null);
    assert.ok(clr.content.includes('骰主默认'));
    await roll(env, 'C1');
    assert.equal(env.coc.checkCalls.at(-1)?.rule, 0);
  });

  test('with a session it sets the session rule (session KP or admin only)', async () => {
    const env = makeEnv();
    await route(
      makeContext({ command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'KP1', values: { name: '阿卡姆', keeper: 'KP1' } }, env.platform),
      env.deps,
    );
    const scene = env.store.getGame('G1', '#1')!.sceneThreadId!;

    // a random player cannot set the session rule
    const denied = await route(setcocCtx(env, 'set', { rule: 3 }, { channelId: scene, parentChannelId: 'C1', userId: 'U9' }), env.deps);
    assert.equal(denied.ephemeral, true);
    assert.equal(env.store.getGameRule('#1', 'G1'), null);

    // the KP can
    const allowed = await route(setcocCtx(env, 'set', { rule: 3 }, { channelId: scene, parentChannelId: 'C1', userId: 'KP1' }), env.deps);
    assert.notEqual(allowed.ephemeral, true);
    assert.equal(env.store.getGameRule('#1', 'G1'), 3);
    assert.equal(env.store.getGame('G1', '#1')?.rule, 3);
    assert.ok(allowed.content.includes('本局'));

    // an admin can too
    const byAdmin = await route(
      setcocCtx(env, 'set', { rule: 6 }, { channelId: scene, parentChannelId: 'C1', userId: 'ADMIN', isAdmin: true }),
      env.deps,
    );
    assert.notEqual(byAdmin.ephemeral, true);
    assert.equal(env.store.getGameRule('#1', 'G1'), 6);

    await roll(env, scene, 'C1', 'U1');
    assert.equal(env.coc.checkCalls.at(-1)?.rule, 6);
  });

  test('effective order: 本局房规 → 场景房规 → 骰主默认', async () => {
    const env = makeEnv();
    // scene rule exists first
    await route(setcocCtx(env, 'set', { rule: 1 }, { channelId: 'C1' }), env.deps);
    assert.equal(env.store.getSceneRule('C1'), 1);

    await route(
      makeContext({ command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'KP1', values: { name: '阿卡姆', keeper: 'KP1', here: true } }, env.platform),
      env.deps,
    );
    // still the scene rule while the session has none
    await roll(env, 'C1', null, 'U1');
    assert.equal(env.coc.checkCalls.at(-1)?.rule, 1);

    await route(setcocCtx(env, 'set', { rule: 5 }, { channelId: 'C1', userId: 'KP1' }), env.deps);
    await roll(env, 'C1', null, 'U1');
    assert.equal(env.coc.checkCalls.at(-1)?.rule, 5);

    const show = await route(setcocCtx(env, 'show', {}, { channelId: 'C1' }), env.deps);
    assert.ok(show.content.includes('本局房规'));

    // clearing the session rule falls back to the scene rule, not the default
    await route(setcocCtx(env, 'clr', {}, { channelId: 'C1', userId: 'KP1' }), env.deps);
    assert.equal(env.store.getGameRule('#1', 'G1'), null);
    await roll(env, 'C1', null, 'U1');
    assert.equal(env.coc.checkCalls.at(-1)?.rule, 1);
  });

  test('invalid rule numbers are refused', async () => {
    const env = makeEnv();
    const reply = await route(setcocCtx(env, 'set', { rule: 7 }), env.deps);
    assert.equal(reply.ephemeral, true);
    assert.equal(env.store.getSceneRule('C1'), null);
  });

  test('showing with no rule at all reports the 骰主默认 rule', async () => {
    const env = makeEnv();
    const show = await route(setcocCtx(env, 'show'), env.deps);
    assert.ok(show.content.includes('骰主默认规则'));
  });
});
