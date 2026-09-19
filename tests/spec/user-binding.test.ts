/**
 * 角色卡绑定的**用户级**（本服常用卡）：绑定跟着用户走、跨子区/跨频道持续。
 *
 * 需求（用户）："改一下角色卡绑定，持续绑定到用户允许跨子区"。
 * 语义：
 *   - 解析顺序：局 > 当前场景 > 父频道 > **用户级** > 全局默认卡（DM 设置）；
 *   - `/pc tag` 同时写主作用域（本局 / 本场景 / DM 的全局）与用户级；
 *   - 用户级 key = guildId（用户维度由 store 的 userId 承担）→ 跨子区但不跨服务器。
 *
 * Run: node tests/spec/user-binding.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPendingActions } from '../../src/bot/confirm.ts';
import { route } from '../../src/bot/router.ts';
import { createCocRules } from '../../src/coc/index.ts';
import type { HandlerDeps, InteractionContext } from '../../src/contracts/bot.ts';
import type { BotStore } from '../../src/contracts/store.ts';
import { createDiceEngine, createMathRng } from '../../src/dice/index.ts';
import { createJsonStoreWithExtras } from '../../src/store/jsonStore.ts';
import { FakePlatform, makeContext, type CtxSpec } from '../bot/fakes.ts';

const TMP_ROOT = fileURLToPath(new URL('../.tmp/', import.meta.url));
const FROZEN_NOW = new Date('2026-01-05T21:30:00.000Z');

function tempDir(label: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TMP_ROOT, `user-binding-${label}-`));
}

interface Env {
  deps: HandlerDeps;
  store: BotStore;
  platform: FakePlatform;
}

function makeEnv(label: string): Env {
  const store = createJsonStoreWithExtras({ dir: tempDir(label) });
  const dice = createDiceEngine();
  const platform = new FakePlatform();
  const deps: HandlerDeps = {
    store,
    dice,
    coc: createCocRules(dice, createMathRng()),
    rng: createMathRng(),
    platform,
    confirmations: createPendingActions(),
    now: () => FROZEN_NOW,
  };
  return { deps, store, platform };
}

function ctx(env: Env, spec: Partial<CtxSpec> & { command: string }): InteractionContext {
  return makeContext({ guildId: 'G1', userId: 'U1', displayName: '甲', ...spec }, env.platform);
}

/** 真实 store：`/st` 写卡，`/rc` 读卡；返回 /rc 里解析到的卡名。 */
async function rcSheet(env: Env, spec: Partial<CtxSpec> & { command?: string }): Promise<string | null> {
  await route(ctx(env, { command: 'rc', values: { text: '闪避' }, ...spec }), env.deps);
  const store = env.store as BotStore & {
    listSheets(userId: string): { name: string; attrs: Record<string, string> }[];
  };
  // 用 /rc 的回执判断解析到哪张卡：卡名会出现在回执里（含闪避目标值）
  return store.listSheets('U1')[0]?.name ?? null;
}

describe('用户级绑定：跨子区/跨频道持续', () => {
  test('无局：tag 写「本场景 + 用户级」，其他频道照样能用', async () => {
    const env = makeEnv('scene-user');
    await route(ctx(env, { command: 'pc', sub: 'new', channelId: 'C1', values: { name: '卡特' } }), env.deps);
    await route(ctx(env, { command: 'pc', sub: 'tag', channelId: 'C1', values: { name: '卡特' } }), env.deps);
    assert.equal(env.store.getBinding('scene', 'C1', 'U1'), '卡特');
    assert.equal(env.store.getBinding('user', 'G1', 'U1'), '卡特');

    // 另一个频道（没有任何单独绑定）→ 用用户级常用卡
    const elsewhere = await route(ctx(env, { command: 'pc', sub: 'show', channelId: 'C9' }), env.deps);
    assert.notEqual(elsewhere.ephemeral, true, elsewhere.content);
    assert.ok(elsewhere.content.includes('卡特'), elsewhere.content);

    // 另一个服务器 → 不串卡
    const otherGuild = await route(
      ctx(env, { command: 'pc', sub: 'show', channelId: 'C9', guildId: 'G2' }),
      env.deps,
    );
    assert.equal(otherGuild.ephemeral, true);
    assert.ok(otherGuild.content.includes('没有生效的角色卡'), otherGuild.content);
  });

  test('子区里 tag → 父频道与兄弟子区都可见（跨子区）', async () => {
    const env = makeEnv('thread');
    const parent = env.platform.threads;
    parent.set('T1', { id: 'T1', name: '第一桌', parentId: 'C1', private: false });
    parent.set('T2', { id: 'T2', name: '第二桌', parentId: 'C1', private: false });

    await route(ctx(env, { command: 'pc', sub: 'new', channelId: 'T1', parentChannelId: 'C1', values: { name: '甲卡' } }), env.deps);
    await route(ctx(env, { command: 'pc', sub: 'tag', channelId: 'T1', parentChannelId: 'C1', values: { name: '甲卡' } }), env.deps);

    for (const channelId of ['T1', 'T2', 'C1']) {
      const reply = await route(ctx(env, { command: 'pc', sub: 'show', channelId, parentChannelId: 'C1' }), env.deps);
      assert.ok(reply.content.includes('甲卡'), `${channelId} 应能用甲卡：${reply.content}`);
    }
  });

  test('有局：局绑定优先，没绑的局回落到用户级常用卡', async () => {
    const env = makeEnv('games');
    const start = async (name: string): Promise<string> => {
      const reply = await route(
        ctx(env, { command: 'game', sub: 'start', channelName: '跑团', values: { name, keeper: 'U1' } }),
        env.deps,
      );
      assert.notEqual(reply.ephemeral, true, reply.content);
      const game = env.store.listGames('G1').at(-1)!;
      return game.sceneThreadId ?? 'C1';
    };

    const t1 = await start('阿卡姆');
    await route(ctx(env, { command: 'pc', sub: 'new', channelId: t1, parentChannelId: 'C1', values: { name: '一号卡' } }), env.deps);
    await route(ctx(env, { command: 'pc', sub: 'tag', channelId: t1, parentChannelId: 'C1', values: { name: '一号卡' } }), env.deps);
    assert.equal(env.store.getBinding('game', '#1', 'U1'), '一号卡');
    assert.equal(env.store.getBinding('user', 'G1', 'U1'), '一号卡');

    const t2 = await start('奈亚');
    // #2 没有单独 tag → 用户级常用卡生效（不再"无卡"）
    const inT2 = await route(ctx(env, { command: 'pc', sub: 'show', channelId: t2, parentChannelId: 'C1' }), env.deps);
    assert.ok(inT2.content.includes('一号卡'), inT2.content);

    // 给 #2 单独 tag 二号卡 → 局绑定压过用户级
    await route(ctx(env, { command: 'pc', sub: 'new', channelId: t2, parentChannelId: 'C1', values: { name: '二号卡' } }), env.deps);
    await route(ctx(env, { command: 'pc', sub: 'tag', channelId: t2, parentChannelId: 'C1', values: { name: '二号卡' } }), env.deps);
    assert.equal(env.store.getBinding('game', '#2', 'U1'), '二号卡');
    assert.equal(env.store.getBinding('user', 'G1', 'U1'), '二号卡', '常用卡 = 最近一次 tag');

    const t2Again = await route(ctx(env, { command: 'pc', sub: 'show', channelId: t2, parentChannelId: 'C1' }), env.deps);
    assert.ok(t2Again.content.includes('二号卡'), t2Again.content);
    const t1Again = await route(ctx(env, { command: 'pc', sub: 'show', channelId: t1, parentChannelId: 'C1' }), env.deps);
    assert.ok(t1Again.content.includes('一号卡'), `#1 自己的局绑定不受影响：${t1Again.content}`);
  });

  test('解绑（/pc tag 不带 name）清掉主作用域与用户级；/pc del 也清', async () => {
    const env = makeEnv('unbind');
    await route(ctx(env, { command: 'pc', sub: 'new', channelId: 'C1', values: { name: '卡特' } }), env.deps);
    await route(ctx(env, { command: 'pc', sub: 'tag', channelId: 'C1', values: { name: '卡特' } }), env.deps);

    await route(ctx(env, { command: 'pc', sub: 'tag', channelId: 'C1' }), env.deps);
    assert.equal(env.store.getBinding('scene', 'C1', 'U1'), null);
    assert.equal(env.store.getBinding('user', 'G1', 'U1'), null);
    const afterUnbind = await route(ctx(env, { command: 'pc', sub: 'show', channelId: 'C9' }), env.deps);
    assert.equal(afterUnbind.ephemeral, true);
    assert.ok(afterUnbind.content.includes('没有生效的角色卡'), afterUnbind.content);

    // 重新 tag 后用 /pc del 删卡：用户级绑定也要清掉
    await route(ctx(env, { command: 'pc', sub: 'tag', channelId: 'C1', values: { name: '卡特' } }), env.deps);
    await route(ctx(env, { command: 'pc', sub: 'del', channelId: 'C1', values: { name: '卡特' } }), env.deps);
    const confirmed = await route(
      ctx(env, { command: 'pc', sub: 'del', channelId: 'C1', values: { name: '卡特' } }),
      env.deps,
    );
    assert.ok(confirmed.content.length > 0);
    assert.equal(env.store.getBinding('user', 'G1', 'U1'), null, '/pc del 后用户级绑定应为空');
  });

  test('已有常用卡时 /pc new 不抢绑定，但提示怎么切卡', async () => {
    const env = makeEnv('newhint');
    await route(ctx(env, { command: 'pc', sub: 'new', channelId: 'C1', values: { name: '卡特' } }), env.deps);
    await route(ctx(env, { command: 'pc', sub: 'tag', channelId: 'C1', values: { name: '卡特' } }), env.deps);

    const reply = await route(ctx(env, { command: 'pc', sub: 'new', channelId: 'C2', values: { name: '新卡' } }), env.deps);
    assert.ok(reply.content.includes('卡特'), `应说明当前生效卡：${reply.content}`);
    assert.ok(reply.content.includes('/pc tag name:新卡'), `应提示怎么切：${reply.content}`);
    assert.equal(env.store.getBinding('scene', 'C2', 'U1'), null, '不自动抢绑定');
    assert.equal(env.store.getBinding('user', 'G1', 'U1'), '卡特', '常用卡保持不变');
  });
});
