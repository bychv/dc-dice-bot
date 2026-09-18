/**
 * `/rh` behaviour: delivery priority, scene-level registration persistence, reset, the
 * parent-channel rule for thread scenes and the ephemeral degradation path.
 * Run: node tests/bot/rh.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { route } from '../../src/bot/router.ts';
import { makeContext, makeEnv, type CtxSpec, type TestEnv } from './fakes.ts';
import type { InteractionContext } from '../../src/contracts/bot.ts';

function rhCtx(env: TestEnv, values: Record<string, string | number | boolean>, overrides: Partial<CtxSpec> = {}): InteractionContext {
  return makeContext({ command: 'rh', channelId: 'C1', channelName: '跑团', userId: 'U1', values, ...overrides }, env.platform);
}

function lastMessage(env: TestEnv): { channelId: string; content: string } | undefined {
  return env.platform.messages.at(-1);
}

describe('/rh delivery', () => {
  test('inside a session it delivers to the session hidden thread and only leaves a link behind', async () => {
    const env = makeEnv();
    await route(
      makeContext({ command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'KP1', values: { name: '阿卡姆', keeper: 'KP1' } }, env.platform),
      env.deps,
    );
    const game = env.store.getGame('G1', '#1')!;
    const scene = game.sceneThreadId!;

    const reply = await route(
      makeContext({ command: 'rh', channelId: scene, parentChannelId: 'C1', userId: 'U1', displayName: '甲', values: { text: '心理学' } }, env.platform),
      env.deps,
    );

    assert.equal(lastMessage(env)?.channelId, game.hiddenThreadId);
    assert.ok(lastMessage(env)?.content.includes('心理学'));
    assert.ok(lastMessage(env)?.content.includes('42'), 'the dice value goes to the private thread');
    // 回执只给发起者（ephemeral）：频道里不出现任何暗骰消息 → 不会有全体通知
    assert.equal(reply.ephemeral, true, '暗骰回执必须仅发起者可见');
    assert.ok(!env.platform.messages.some((m) => m.channelId === scene), '不得在原场景发公开消息');
    assert.ok(reply.content.includes(game.hiddenThreadId!));
    assert.ok(reply.content.includes('42'), 'ephemeral 回显里带上发起者自己的结果（仅他可见）');
    assert.ok(reply.content.includes('KP1'), '非 KP 的发起者只能靠回显，需写明只投给 KP');
  });

  test('an explicit thread wins for that call and is persisted as the scene default', async () => {
    const env = makeEnv();
    await route(
      makeContext({ command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'KP1', values: { name: '阿卡姆', keeper: 'KP1' } }, env.platform),
      env.deps,
    );
    const game = env.store.getGame('G1', '#1')!;
    const scene = game.sceneThreadId!;
    env.platform.threads.set('T9', { id: 'T9', parentId: 'C1', name: '临时暗骰区', private: true });

    await route(
      makeContext({ command: 'rh', channelId: scene, parentChannelId: 'C1', userId: 'U1', values: { text: '聆听', thread: 'T9' } }, env.platform),
      env.deps,
    );
    assert.equal(lastMessage(env)?.channelId, 'T9');
    assert.equal(env.store.getRegisteredThread(scene), 'T9');

    // the session hidden thread still outranks the registration (docs §4.2 priority)
    await route(
      makeContext({ command: 'rh', channelId: scene, parentChannelId: 'C1', userId: 'U1', values: { text: '聆听' } }, env.platform),
      env.deps,
    );
    assert.equal(lastMessage(env)?.channelId, game.hiddenThreadId);
  });

  test('without a session, the scene registration outranks the automatic thread', async () => {
    const env = makeEnv();
    env.platform.threads.set('T9', { id: 'T9', parentId: 'C1', name: '登记区', private: true });

    await route(rhCtx(env, { text: '侦查', thread: 'T9' }), env.deps);
    assert.equal(lastMessage(env)?.channelId, 'T9');
    assert.equal(env.store.getRegisteredThread('C1'), 'T9');

    await route(rhCtx(env, { text: '侦查' }), env.deps);
    assert.equal(lastMessage(env)?.channelId, 'T9', 'registration is reused without thread:');

    // reset only clears the scene-level registration → back to the automatic thread
    const reset = await route(rhCtx(env, { reset: true }), env.deps);
    assert.equal(env.store.getRegisteredThread('C1'), null);
    assert.ok(reset.content.includes('自动创建'));

    await route(rhCtx(env, { text: '侦查' }), env.deps);
    const auto = env.platform.threads.get(lastMessage(env)!.channelId);
    assert.equal(auto?.name, '暗骰 · 跑团');
    assert.equal(auto?.parentId, 'C1');
    assert.equal(auto?.private, true);
  });

  test('reset inside a session keeps the session hidden thread', async () => {
    const env = makeEnv();
    await route(
      makeContext({ command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'KP1', values: { name: '阿卡姆', keeper: 'KP1' } }, env.platform),
      env.deps,
    );
    const game = env.store.getGame('G1', '#1')!;
    const scene = game.sceneThreadId!;
    env.platform.threads.set('T9', { id: 'T9', parentId: 'C1', name: '临时暗骰区', private: true });
    await route(
      makeContext({ command: 'rh', channelId: scene, parentChannelId: 'C1', userId: 'U1', values: { text: '聆听', thread: 'T9' } }, env.platform),
      env.deps,
    );
    const reset = await route(
      makeContext({ command: 'rh', channelId: scene, parentChannelId: 'C1', userId: 'U1', values: { reset: true } }, env.platform),
      env.deps,
    );
    assert.equal(env.store.getRegisteredThread(scene), null);
    assert.ok(reset.content.includes(game.hiddenThreadId!));
  });

  test('inside a thread without a session the automatic thread is built under the parent channel', async () => {
    const env = makeEnv();
    env.platform.channelNames.set('C1', '跑团');
    const reply = await route(
      makeContext({ command: 'rh', channelId: 'T7', parentChannelId: 'C1', channelName: '某子区', userId: 'U1', values: { text: '3#1d10 聆听' } }, env.platform),
      env.deps,
    );
    assert.equal(reply.ephemeral, true, '暗骰回执必须仅发起者可见');
    const created = env.platform.threads.get(lastMessage(env)!.channelId)!;
    assert.equal(created.name, '暗骰 · 某子区', '自动暗骰区按场景命名');
    assert.equal(created.parentId, 'C1');
    assert.equal(created.private, true);
    // the roll is multi-round: parseRollText strips `3#`, the bot layer re-attaches it
    assert.deepEqual(env.dice.rolls, ['3#1d10']);
  });

  test('different sibling threads get different automatic hidden threads', async () => {
    const env = makeEnv();
    env.platform.channelNames.set('C1', '跑团');

    const a = await route(
      makeContext({ command: 'rh', channelId: 'T7', parentChannelId: 'C1', channelName: '甲团', userId: 'U1', values: { text: '侦查' } }, env.platform),
      env.deps,
    );
    const firstId = lastMessage(env)!.channelId;
    const b = await route(
      makeContext({ command: 'rh', channelId: 'T8', parentChannelId: 'C1', channelName: '乙团', userId: 'U1', values: { text: '侦查' } }, env.platform),
      env.deps,
    );
    const secondId = lastMessage(env)!.channelId;

    assert.notEqual(firstId, secondId, '不同子区必须各开一个暗骰子区');
    assert.equal(env.platform.threads.get(firstId)?.name, '暗骰 · 甲团');
    assert.equal(env.platform.threads.get(secondId)?.name, '暗骰 · 乙团');
    assert.equal(a.ephemeral, true);
    assert.equal(b.ephemeral, true);

    // 各自复用，不会串投
    await route(
      makeContext({ command: 'rh', channelId: 'T7', parentChannelId: 'C1', channelName: '甲团', userId: 'U1', values: { text: '侦查' } }, env.platform),
      env.deps,
    );
    assert.equal(lastMessage(env)!.channelId, firstId);
  });
});

describe('/rh edge cases', () => {
  test('thread: registration only (no text) rolls nothing', async () => {
    const env = makeEnv();
    env.platform.threads.set('T9', { id: 'T9', parentId: 'C1', name: '登记区', private: true });
    const reply = await route(rhCtx(env, { thread: 'T9' }), env.deps);
    assert.equal(reply.ephemeral, true, '登记确认同样只给发起者');
    assert.equal(env.store.getRegisteredThread('C1'), 'T9');
    assert.equal(env.platform.messages.length, 0);
    assert.deepEqual(env.dice.rolls, []);
  });

  test('a non-thread target is refused instead of silently rerouted', async () => {
    const env = makeEnv();
    const reply = await route(rhCtx(env, { text: '聆听', thread: 'C2' }), env.deps);
    assert.equal(reply.ephemeral, true);
    assert.ok(reply.content.includes('不是子区'));
    assert.equal(env.platform.messages.length, 0);
  });

  test('missing thread permission degrades to an ephemeral receipt with the reason', async () => {
    const env = makeEnv();
    env.platform.canCreate = false;
    const reply = await route(rhCtx(env, { text: '心理学' }), env.deps);
    assert.equal(reply.ephemeral, true);
    assert.ok(reply.content.includes('权限'));
    assert.ok(reply.content.includes('42'), 'the degraded receipt still carries the roll');
    assert.equal(env.platform.messages.length, 0);
  });

  test('after a game starts only the game KP joins the hidden thread', async () => {
    const env = makeEnv();
    await route(
      makeContext({ command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'KP1', values: { name: '阿卡姆', keeper: 'KP1' } }, env.platform),
      env.deps,
    );
    const hidden = env.store.getGame('G1', '#1')!.hiddenThreadId!;

    // 非 KP（U1）掷暗骰：不拉进子区，只拿到含骰值的 ephemeral 回显
    const reply = await route(rhCtx(env, { text: '心理学', thread: hidden }), env.deps);
    let members = env.platform.members.get(hidden) ?? [];
    assert.ok(members.includes('KP1'), '本局 KP 必须在子区里');
    assert.ok(!members.includes('U1'), '发起者本人不得被拉进私密子区');
    assert.equal(reply.ephemeral, true);
    assert.ok(reply.content.includes('42'), '非成员只能靠这条回显看到结果');
    assert.ok(reply.content.includes('KP1'), '回执要写明只有本局 KP 能看到');

    // 有局时 KP 只由 /game 指定：keeper: 不再改变成员
    const withKeeper = await route(rhCtx(env, { text: '心理学', keeper: 'U9', thread: hidden }), env.deps);
    members = env.platform.members.get(hidden) ?? [];
    assert.ok(!members.includes('U9'), '有局时 keeper: 不拉人进子区');
    assert.ok(!members.includes('U1'), '发起者始终不进子区');
    assert.ok(withKeeper.content.includes('由 `/game` 指定'), '要明确说明 keeper: 被忽略');
  });

  test('without a game the keeper option still grants access to the thread', async () => {
    const env = makeEnv();
    env.platform.threads.set('T9', { id: 'T9', parentId: 'C1', name: '登记区', private: true });
    await route(rhCtx(env, { text: '侦查', keeper: 'U9', thread: 'T9' }), env.deps);
    const members = env.platform.members.get('T9') ?? [];
    assert.ok(members.includes('U1'), '无局时掷骰者本人进子区');
    assert.ok(members.includes('U9'), '无局时 keeper: 指定者进子区');
  });

  test('every receipt path says keeper: is ignored while a game is active', async () => {
    const env = makeEnv();
    await route(
      makeContext({ command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'KP1', values: { name: '阿卡姆', keeper: 'KP1' } }, env.platform),
      env.deps,
    );
    const hidden = env.store.getGame('G1', '#1')!.hiddenThreadId!;
    env.platform.threads.set('T9', { id: 'T9', parentId: 'C1', name: '登记区', private: true });
    const notice = '由 `/game` 指定';

    // 掷骰路径：即便 keeper: 写的就是本局 KP，也要说明它不改变知情范围
    const same = await route(rhCtx(env, { text: '心理学', keeper: 'KP1', thread: hidden }), env.deps);
    assert.ok(same.content.includes(notice), 'keeper: == 本局 KP 时也要说明');

    // reset 路径
    const reset = await route(rhCtx(env, { reset: true, keeper: 'U9' }), env.deps);
    assert.ok(reset.content.includes(notice), 'reset 回执也要说明');

    // 仅登记路径
    const reg = await route(rhCtx(env, { thread: 'T9', keeper: 'U9' }), env.deps);
    assert.ok(reg.content.includes(notice), '仅登记回执也要说明');

    // 降级路径（本局暗骰子区失效且 Bot 无建子区权限）
    env.store.setRegisteredThread('C1', null);
    env.platform.threads.delete(hidden);
    env.platform.canCreate = false;
    const degraded = await route(rhCtx(env, { text: '心理学', keeper: 'U9' }), env.deps);
    assert.equal(degraded.ephemeral, true);
    assert.ok(degraded.content.includes('降级'), '应走降级路径');
    assert.ok(degraded.content.includes(notice), '降级回执也要说明');
  });

  test('an unparsable roll fails before any thread is created or used', async () => {
    const env = makeEnv();
    env.dice.failNext = true;
    const reply = await route(rhCtx(env, { text: '坏骰式' }), env.deps);
    assert.equal(reply.ephemeral, true);
    assert.ok(reply.content.includes('掷骰失败'));
    assert.equal(env.platform.messages.length, 0);
    assert.equal([...env.platform.threads.values()].filter((t) => t.private).length, 0);
  });
});
