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

describe('/rh 无局子区：回落到"正在记录中的局"的暗骰子区', () => {
  /**
   * 开一局（自动带暗骰子区 + 自动开日志）。
   * 注意：`/game start` 会把**父频道**也算进本局场景，所以"没有局的子区"必须挂在**另一个父频道**下
   * （父频道有局的子区会直接继承那个局，走 `game` 而不是 `borrowed` 分支）。
   */
  async function startGame(
    env: TestEnv,
    name: string,
    channelId = 'C9',
    keeper = 'KP1',
  ): Promise<{ scene: string; hidden: string; id: string }> {
    await route(
      makeContext({ command: 'game', sub: 'start', channelId, channelName: '跑团', userId: keeper, values: { name, keeper } }, env.platform),
      env.deps,
    );
    const game = env.store.listGames('G1').find((g) => g.name === name)!;
    return { scene: game.sceneThreadId!, hidden: game.hiddenThreadId!, id: game.id };
  }

  /** 一个父频道 C1 下、没有绑定任何局的子区 T20。 */
  function orphanThread(env: TestEnv, id = 'T20'): string {
    env.platform.threads.set(id, { id, parentId: 'C1', name: '临时小场景', private: false });
    return id;
  }

  const rhIn = (env: TestEnv, channelId: string) =>
    route(
      makeContext({ command: 'rh', channelId, parentChannelId: 'C1', userId: 'U2', displayName: '乙', values: { text: '心理学' } }, env.platform),
      env.deps,
    );

  test('没有局的子区：投到正在进行（日志记录中）的局的暗骰子区，不再另建', async () => {
    const env = makeEnv();
    const game = await startGame(env, '阿卡姆'); // 开在 C9
    const thread = orphanThread(env);

    const reply = await rhIn(env, thread);

    assert.equal(lastMessage(env)?.channelId, game.hidden, '应投到该局的暗骰子区');
    assert.equal(reply.ephemeral, true);
    assert.match(reply.content, /本场景没有开局/);
    assert.match(reply.content, new RegExp(`${game.id} 阿卡姆`));
    // 没有为这个子区另建私密子区，也没有登记到它身上
    assert.equal(env.store.getRegisteredThread(thread), null);
    assert.equal(
      [...env.platform.threads.values()].filter((t) => t.private).length,
      1,
      '只应有该局自带的那一个私密子区',
    );
  });

  test('日志暂停（off）也照样借用：判据只看局是否 active + 最近开局', async () => {
    const env = makeEnv();
    const game = await startGame(env, '阿卡姆');
    await route(
      makeContext({ command: 'log', sub: 'off', channelId: game.scene, parentChannelId: 'C9', userId: 'KP1' }, env.platform),
      env.deps,
    );
    const thread = orphanThread(env);

    const reply = await rhIn(env, thread);
    assert.equal(lastMessage(env)?.channelId, game.hidden, '日志 off 只说明这个场景暂停了，不代表团不在跑');
    assert.equal(
      [...env.platform.threads.values()].filter((t) => t.private).length,
      1,
      '仍然不另建私密子区',
    );
  });

  test('子区没有自己的局时：用"最近开局的局"覆盖父频道指针（本次改动的核心）', async () => {
    const env = makeEnv();
    const oldGame = await startGame(env, '旧团', 'C1'); // 开在父频道 C1 → C1 的指针指向它
    const newGame = await startGame(env, '新团', 'C9'); // 之后新开的团
    const thread = orphanThread(env); // C1 下的子区：会继承 C1 的指针（旧团）

    assert.equal(env.store.getSceneGame('C1'), oldGame.id, '父频道指针确实还停在旧团上');

    const reply = await rhIn(env, thread);
    assert.equal(lastMessage(env)?.channelId, newGame.hidden, '应覆盖继承，用最近开局的新团');
    assert.match(reply.content, /最近开局的局/);
    assert.match(reply.content, new RegExp(`${newGame.id} 新团`));
  });

  test('局已结束（/game end）时不借用', async () => {
    const env = makeEnv();
    const game = await startGame(env, '阿卡姆');
    await route(
      makeContext({ command: 'game', sub: 'end', channelId: game.scene, parentChannelId: 'C9', userId: 'KP1', values: {} }, env.platform),
      env.deps,
    );
    const thread = orphanThread(env);

    await rhIn(env, thread);
    assert.equal(env.store.getGame('G1', game.id)?.status, 'ended');
    assert.notEqual(lastMessage(env)?.channelId, game.hidden, '结束的局不作为兜底来源');
  });

  test('多个候选（都不同父频道）时取最近有记录的局', async () => {
    const env = makeEnv();
    const older = await startGame(env, '旧团', 'C8', 'KP8');
    await route(makeContext({ command: 'log', sub: 'off', channelId: older.scene, parentChannelId: 'C8', userId: 'KP8' }, env.platform), env.deps);
    const active = await startGame(env, '新团', 'C9', 'KP9'); // 后开：日志新
    const thread = orphanThread(env);

    await rhIn(env, thread);
    assert.equal(lastMessage(env)?.channelId, active.hidden, '取最近有记录的局');
  });

  test('借用的目标失效时：清掉该局的登记并回落', async () => {
    const env = makeEnv();
    const game = await startGame(env, '阿卡姆');
    env.platform.threads.delete(game.hidden); // 私密子区被删 / bot 被移出
    const thread = orphanThread(env);

    const reply = await rhIn(env, thread);
    assert.equal(env.store.getGame('G1', game.id)?.hiddenThreadId, null, '失效来源要从局记录里清掉');
    assert.match(reply.content, /已失效/);
    assert.match(reply.content, /自动创建并复用/, '继续回落到自动子区');
  });

  test('场景级登记仍优先于"借来的"暗骰子区（显式选择不被隐式规则盖掉）', async () => {
    const env = makeEnv();
    const game = await startGame(env, '阿卡姆');
    const thread = orphanThread(env);
    env.platform.threads.set('T21', { id: 'T21', parentId: 'C1', name: '本场景专用暗骰区', private: true });
    env.store.setRegisteredThread(thread, 'T21');

    await rhIn(env, thread);
    assert.equal(lastMessage(env)?.channelId, 'T21', '本场景登记的暗骰区优先');
    assert.notEqual(lastMessage(env)?.channelId, game.hidden);
  });
});
