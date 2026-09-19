/**
 * 跨子区的角色卡 / 房规继承（真实 jsonStore + 真实 CoC / Dice 引擎）。
 *
 * 用户报告：卡里明明有「闪避」，在**子区**里 `/rc 闪避` 却报「无法确定成功率」。
 * 原因：角色卡解析链原本只看 `ctx.channelId` 这一个键，子区是独立的 channel id，
 * 于是「在频道里开的局 / 绑的卡」进了子区就查不到 → 解析成"没有卡"。
 * 现在子区在没有自己设置时**继承父频道**（局指针 > 场景绑定 > 场景房规）。
 *
 * Run: node tests/spec/thread-inheritance.test.ts
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
  return mkdtempSync(join(TMP_ROOT, `thread-inherit-${label}-`));
}

interface Env {
  deps: HandlerDeps;
  store: BotStore;
  platform: FakePlatform;
}

/** 真实 jsonStore + 真实 coc/dice；Platform 只用于建子区/取名。 */
function makeRealEnv(label: string): Env {
  const store = createJsonStoreWithExtras({ dir: tempDir(label) });
  const dice = createDiceEngine();
  const platform = new FakePlatform();
  const deps: HandlerDeps = {
    store,
    dice,
    coc: createCocRules(dice),
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

function thread(env: Env, id: string, parentId: string, name: string): void {
  env.platform.threads.set(id, { id, parentId, name, private: false });
}

async function startGame(
  env: Env,
  scene: { channelId: string; parentChannelId?: string },
  name: string,
  threadId: string,
): Promise<void> {
  const reply = await route(
    ctx(env, {
      command: 'game',
      sub: 'start',
      channelId: scene.channelId,
      parentChannelId: scene.parentChannelId ?? null,
      values: { name, keeper: 'U1', thread: threadId },
    }),
    env.deps,
  );
  assert.ok(!reply.content.includes('找不到') && !reply.content.includes('失败'), reply.content);
}

describe('跨子区继承上级场景（频道）', () => {
  test('在频道里开局 + 录卡：进子区 `/rc 闪避` 仍能读到卡（局绑定）', async () => {
    const env = makeRealEnv('game-binding');
    // 频道 C1 就地开局（局 #1 绑在 C1）
    await route(
      ctx(env, { command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', values: { name: '阿卡姆', keeper: 'U1', here: true } }),
      env.deps,
    );
    // 在频道里录卡 → 写入**局**的卡绑定
    await route(ctx(env, { command: 'pc', sub: 'new', channelId: 'C1', channelName: '跑团', values: { name: '甲卡' } }), env.deps);
    await route(ctx(env, { command: 'st', channelId: 'C1', channelName: '跑团', values: { text: '敏捷:60 闪避:30' } }), env.deps);

    // 在频道下的子区里检定：子区自己既没有局指针也没有卡绑定 → 必须继承 C1
    const reply = await route(
      ctx(env, { command: 'rc', channelId: 'T7', parentChannelId: 'C1', channelName: '某子区', values: { text: '闪避' } }),
      env.deps,
    );
    assert.ok(!reply.content.includes('无法确定'), `子区里必须能读到卡：${reply.content}`);
    assert.match(reply.content, /闪避 检定 D100=\d+\/30/, reply.content);
  });

  test('没有局、只在频道里绑卡：子区同样继承频道级绑定', async () => {
    const env = makeRealEnv('scene-binding');
    await route(ctx(env, { command: 'pc', sub: 'new', channelId: 'C1', channelName: '跑团', values: { name: '甲卡' } }), env.deps);
    await route(ctx(env, { command: 'st', channelId: 'C1', channelName: '跑团', values: { text: '敏捷:60 闪避:30' } }), env.deps);

    const reply = await route(
      ctx(env, { command: 'rc', channelId: 'T7', parentChannelId: 'C1', channelName: '某子区', values: { text: '闪避' } }),
      env.deps,
    );
    assert.match(reply.content, /D100=\d+\/30/, reply.content);
  });

  test('子区自己的设置优先：子区里绑的卡不会被频道的卡顶掉', async () => {
    const env = makeRealEnv('thread-wins');
    await route(ctx(env, { command: 'pc', sub: 'new', channelId: 'C1', channelName: '跑团', values: { name: '频道卡' } }), env.deps);
    await route(ctx(env, { command: 'st', channelId: 'C1', channelName: '跑团', values: { text: '闪避:30' } }), env.deps);

    // 子区里另建一张卡并**显式**绑定到子区（子区无局 → 场景级；
    // 注意：此时已能继承频道卡，所以 /pc new 不会自动绑定，需要 /pc tag）
    await route(ctx(env, { command: 'pc', sub: 'new', channelId: 'T7', parentChannelId: 'C1', channelName: '某子区', values: { name: '子区卡' } }), env.deps);
    await route(ctx(env, { command: 'pc', sub: 'tag', channelId: 'T7', parentChannelId: 'C1', channelName: '某子区', values: { name: '子区卡' } }), env.deps);
    await route(ctx(env, { command: 'st', channelId: 'T7', parentChannelId: 'C1', channelName: '某子区', values: { text: '闪避:70' } }), env.deps);

    const inThread = await route(
      ctx(env, { command: 'rc', channelId: 'T7', parentChannelId: 'C1', channelName: '某子区', values: { text: '闪避' } }),
      env.deps,
    );
    const inChannel = await route(
      ctx(env, { command: 'rc', channelId: 'C1', channelName: '跑团', values: { text: '闪避' } }),
      env.deps,
    );
    assert.match(inThread.content, /D100=\d+\/70/, '子区用自己的卡');
    assert.match(inChannel.content, /D100=\d+\/30/, '频道仍用自己的卡，不被子区影响');
  });

  test('兄弟子区各自的局互不串（两桌并行）', async () => {
    const env = makeRealEnv('two-tables');
    thread(env, 'T1', 'C1', '第一桌');
    thread(env, 'T2', 'C1', '第二桌');

    await startGame(env, { channelId: 'T1', parentChannelId: 'C1' }, '阿卡姆', 'T1');
    await route(ctx(env, { command: 'pc', sub: 'new', channelId: 'T1', parentChannelId: 'C1', values: { name: '甲卡' } }), env.deps);
    await route(ctx(env, { command: 'st', channelId: 'T1', parentChannelId: 'C1', values: { text: '闪避:30' } }), env.deps);

    await startGame(env, { channelId: 'T2', parentChannelId: 'C1' }, '奈亚', 'T2');
    await route(ctx(env, { command: 'pc', sub: 'new', channelId: 'T2', parentChannelId: 'C1', values: { name: '乙卡' } }), env.deps);
    // 此时"甲卡"已经通过**用户级常用卡**生效，所以新建的卡要显式 tag 才算当前卡
    await route(ctx(env, { command: 'pc', sub: 'tag', channelId: 'T2', parentChannelId: 'C1', values: { name: '乙卡' } }), env.deps);
    await route(ctx(env, { command: 'st', channelId: 'T2', parentChannelId: 'C1', values: { text: '闪避:70' } }), env.deps);

    const first = await route(ctx(env, { command: 'rc', channelId: 'T1', parentChannelId: 'C1', values: { text: '闪避' } }), env.deps);
    const second = await route(ctx(env, { command: 'rc', channelId: 'T2', parentChannelId: 'C1', values: { text: '闪避' } }), env.deps);
    assert.match(first.content, /D100=\d+\/30/, first.content);
    assert.match(second.content, /D100=\d+\/70/, second.content);
  });

  test('场景房规同样继承父频道', async () => {
    const env = makeRealEnv('rule');
    await route(ctx(env, { command: 'setcoc', sub: 'set', channelId: 'C1', channelName: '跑团', values: { rule: 3 } }), env.deps);
    const reply = await route(
      ctx(env, { command: 'rc', channelId: 'T7', parentChannelId: 'C1', channelName: '某子区', values: { text: '闪避 50' } }),
      env.deps,
    );
    assert.ok(reply.content.includes('房规3'), reply.content);
  });
});

describe('检定的报错要能分清「没卡」和「卡里没这项」', () => {  test('没有任何生效卡：明确说当前场景没有卡，而不是「卡里没该属性」', async () => {
    const env = makeRealEnv('no-card');
    const reply = await route(ctx(env, { command: 'rc', channelId: 'T9', parentChannelId: 'C8', values: { text: '闪避' } }), env.deps);
    assert.equal(reply.ephemeral, true);
    assert.ok(reply.content.includes('当前场景没有生效的角色卡'), reply.content);
    assert.match(reply.content, /\/rc 闪避 50/);
  });

  test('有卡但确实没录入：报出卡名并给出录入/直接给值两种做法', async () => {
    const env = makeRealEnv('missing-attr');
    await route(ctx(env, { command: 'pc', sub: 'new', channelId: 'C1', channelName: '跑团', values: { name: '甲卡' } }), env.deps);
    await route(ctx(env, { command: 'st', channelId: 'C1', channelName: '跑团', values: { text: '敏捷:60' } }), env.deps);

    const reply = await route(ctx(env, { command: 'rc', channelId: 'C1', channelName: '跑团', values: { text: '闪避' } }), env.deps);
    assert.ok(reply.content.includes('角色卡「甲卡」里没有「闪避」这一项'), reply.content);
    assert.match(reply.content, /\/st 闪避:60/);
  });

  test('显式给成功率时不需要卡（跨子区也不会报错）', async () => {
    const env = makeRealEnv('explicit-value');
    const reply = await route(ctx(env, { command: 'rc', channelId: 'T9', parentChannelId: 'C8', values: { text: '闪避 45' } }), env.deps);
    assert.match(reply.content, /D100=\d+\/45/, reply.content);
  });
});
