/**
 * `/game` behaviour: start (three ways), multi-session coexistence, switch follow + permissions,
 * state/list, end (archive switch, log export).
 * Run: node tests/bot/game.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { route } from '../../src/bot/router.ts';
import { makeContext, makeEnv, type TestEnv } from './fakes.ts';
import type { InteractionContext } from '../../src/contracts/bot.ts';

function gameCtx(env: TestEnv, values: Record<string, string | number | boolean>, overrides: Partial<Parameters<typeof makeContext>[0]> = {}): InteractionContext {
  return makeContext(
    { command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'KP1', values, ...overrides },
    env.platform,
  );
}

describe('/game start', () => {
  test('default: public scene thread + private 暗骰 thread under the parent channel + auto log + scene pointer', async () => {
    const env = makeEnv();
    const reply = await route(gameCtx(env, { name: '阿卡姆', keeper: 'KP1' }), env.deps);

    assert.notEqual(reply.ephemeral, true);
    const game = env.store.getGame('G1', '#1');
    assert.ok(game, 'session #1 must be registered');
    assert.equal(game.name, '阿卡姆');
    assert.equal(game.keeperId, 'KP1');
    assert.equal(game.status, 'active');
    assert.equal(game.sceneThreadCreatedByBot, true);

    // main scene: a public thread created in the invoking channel
    assert.ok(game.sceneThreadId);
    const scene = env.platform.threads.get(game.sceneThreadId);
    assert.ok(scene);
    assert.equal(scene.name, '阿卡姆');
    assert.equal(scene.parentId, 'C1');
    assert.equal(scene.private, false);

    // hidden thread: private, named 暗骰 · <桌名>, under the same parent channel, KP added
    assert.ok(game.hiddenThreadId);
    const hidden = env.platform.threads.get(game.hiddenThreadId);
    assert.ok(hidden);
    assert.equal(hidden.name, '暗骰 · 阿卡姆');
    assert.equal(hidden.parentId, 'C1');
    assert.equal(hidden.private, true);
    assert.ok(env.platform.members.get(game.hiddenThreadId)?.includes('KP1'));

    // 发起者所在场景 + 主场景 both point at the session
    assert.equal(env.store.getSceneGame('C1'), '#1');
    assert.equal(env.store.getSceneGame(game.sceneThreadId), '#1');

    // automatic log
    const logs = env.store.listLogs({ gameId: '#1', channelId: 'C1' });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].state, 'on');
    assert.equal(logs[0].name, '阿卡姆', '自动开的日志名 = 桌名（设定名优先，未设定才是带日期的回退名）');
    assert.equal(env.store.getGame('G1', '#1')?.currentLogId, logs[0].id);

    assert.ok(reply.content.includes('#1'));
    assert.ok(reply.content.includes('阿卡姆'));
  });

  test('two sessions coexist in one channel and are numbered #1/#2', async () => {
    const env = makeEnv();
    await route(gameCtx(env, { name: '阿卡姆', keeper: 'KP1' }), env.deps);
    const first = env.store.getGame('G1', '#1');
    await route(gameCtx(env, { name: '奈亚', keeper: 'KP2' }), env.deps);
    const second = env.store.getGame('G1', '#2');

    assert.ok(first && second);
    assert.deepEqual(env.store.listGames('G1').map((g) => g.id), ['#1', '#2']);
    // each session has its own scene + hidden thread
    assert.notEqual(first.sceneThreadId, second.sceneThreadId);
    assert.notEqual(first.hiddenThreadId, second.hiddenThreadId);
    assert.equal(env.platform.threads.get(second.hiddenThreadId!)?.name, '暗骰 · 奈亚');
    // the first session's context is untouched
    assert.equal(env.store.getSceneGame(first.sceneThreadId!), '#1');
    const firstLog = env.store.listLogs({ gameId: '#1', channelId: 'C1' });
    assert.equal(firstLog.length, 1);
    assert.equal(firstLog[0].state, 'on');
  });

  test('default start inside a thread creates the scene thread as a sibling in the parent channel', async () => {
    const env = makeEnv();
    const ctx = makeContext(
      { command: 'game', sub: 'start', channelId: 'T7', parentChannelId: 'C1', channelName: '某子区', userId: 'KP1', values: { name: '阿卡姆', keeper: 'KP1' } },
      env.platform,
    );
    await route(ctx, env.deps);

    const game = env.store.getGame('G1', '#1')!;
    const scene = env.platform.threads.get(game.sceneThreadId!)!;
    assert.equal(scene.parentId, 'C1', '子区不能内嵌子区，主场景子区建在父频道下');
    assert.equal(scene.private, false);
    assert.equal(scene.name, '阿卡姆');
    assert.equal(env.platform.threads.get(game.hiddenThreadId!)?.parentId, 'C1');
    assert.equal(env.store.getSceneGame('T7'), '#1');
    // the parent channel is only a container here; the initiator's scene (T7) and the new
    // main scene carry the pointer
    assert.equal(env.store.getSceneGame('C1'), null);
  });

  test('thread: reuses an existing thread as the main scene (nothing new created for it)', async () => {
    const env = makeEnv();
    env.platform.threads.set('T9', { id: 'T9', parentId: 'C1', name: '已有子区', private: false });
    await route(gameCtx(env, { name: '复用', keeper: 'KP1', thread: 'T9' }), env.deps);

    const game = env.store.getGame('G1', '#1')!;
    assert.equal(game.sceneThreadId, 'T9');
    assert.equal(game.sceneThreadCreatedByBot, false);
    assert.equal(game.parentChannelId, 'C1');
    assert.ok(game.hiddenThreadId);
    assert.equal(env.platform.threads.get(game.hiddenThreadId!)?.parentId, 'C1');
    assert.equal(env.store.getSceneGame('T9'), '#1');
    assert.equal(env.store.getSceneGame('C1'), '#1');
  });

  test('here:true uses the current channel and creates the hidden thread there', async () => {
    const env = makeEnv();
    await route(gameCtx(env, { name: '就地', keeper: 'KP1', here: true }), env.deps);

    const game = env.store.getGame('G1', '#1')!;
    assert.equal(game.sceneThreadId, null);
    assert.equal(game.parentChannelId, 'C1');
    assert.equal(env.store.getSceneGame('C1'), '#1');
    assert.ok(game.hiddenThreadId);
    assert.equal(env.platform.threads.get(game.hiddenThreadId!)?.parentId, 'C1');
    // no public scene thread was created
    assert.equal([...env.platform.threads.values()].filter((t) => !t.private).length, 0);
  });

  test('here:true inside a thread binds that thread and builds the hidden thread under its parent', async () => {
    const env = makeEnv();
    env.platform.channelNames.set('C1', '跑团');
    const ctx = makeContext(
      { command: 'game', sub: 'start', channelId: 'T7', parentChannelId: 'C1', values: { name: '就地子区', here: true } },
      env.platform,
    );
    await route(ctx, env.deps);

    const game = env.store.getGame('G1', '#1')!;
    assert.equal(game.sceneThreadId, 'T7');
    assert.equal(game.parentChannelId, 'C1');
    assert.equal(env.platform.threads.get(game.hiddenThreadId!)?.parentId, 'C1');
  });

  test('thread wins over here when both are given', async () => {
    const env = makeEnv();
    env.platform.threads.set('T9', { id: 'T9', parentId: 'C1', name: '已有子区', private: false });
    const reply = await route(gameCtx(env, { name: '冲突', thread: 'T9', here: true }), env.deps);
    assert.equal(env.store.getGame('G1', '#1')?.sceneThreadId, 'T9');
    assert.ok(reply.content.includes('thread'));
  });

  test('DM is refused (sessions are a guild concept)', async () => {
    const env = makeEnv();
    const ctx = makeContext({ command: 'game', sub: 'start', guildId: null, values: { name: 'x' } }, env.platform);
    const reply = await route(ctx, env.deps);
    assert.equal(reply.ephemeral, true);
    assert.ok(reply.content.includes('DM'));
    assert.equal(env.store.listGames('G1').length, 0);
  });

  test('missing thread permission degrades to 就地 and says so', async () => {
    const env = makeEnv();
    env.platform.canCreate = false;
    const reply = await route(gameCtx(env, { name: '无权限', here: false }), env.deps);

    const game = env.store.getGame('G1', '#1')!;
    assert.equal(game.sceneThreadId, null);
    assert.equal(env.store.getSceneGame('C1'), '#1');
    assert.equal(game.hiddenThreadId, null);
    assert.ok(reply.content.includes('无法在该频道创建公开子区'));
    assert.ok(reply.content.includes('暗骰'));
  });
});

describe('/game list + state', () => {
  test('list shows id / name / KP / status / scenes, state reports the current context', async () => {
    const env = makeEnv();
    await route(gameCtx(env, { name: '阿卡姆', keeper: 'KP1' }), env.deps);
    const scene = env.store.getGame('G1', '#1')!.sceneThreadId!;

    const list = await route(makeContext({ command: 'game', sub: 'list' }, env.platform), env.deps);
    assert.ok(list.content.includes('#1'));
    assert.ok(list.content.includes('阿卡姆'));
    assert.ok(list.content.includes('KP1'));
    assert.ok(list.content.includes('进行中'));

    const state = await route(
      makeContext({ command: 'game', sub: 'state', channelId: scene, parentChannelId: 'C1' }, env.platform),
      env.deps,
    );
    assert.ok(state.content.includes('#1'));
    assert.ok(state.content.includes('子区'));
    assert.ok(state.content.includes('暗骰'));
  });

  test('state on an unbound scene says so explicitly', async () => {
    const env = makeEnv();
    const reply = await route(makeContext({ command: 'game', sub: 'state', channelId: 'CX' }, env.platform), env.deps);
    assert.ok(reply.content.includes('未绑定任何局'));
  });
});

describe('/game switch', () => {
  test('permissions: only admin or the target session KP', async () => {
    const env = makeEnv();
    await route(gameCtx(env, { name: '阿卡姆', keeper: 'KP1' }), env.deps);
    await route(gameCtx(env, { name: '奈亚', keeper: 'KP2' }), env.deps);
    const scene1 = env.store.getGame('G1', '#1')!.sceneThreadId!;

    // a plain player (not admin, not #2's KP) cannot switch
    const denied = await route(
      makeContext(
        { command: 'game', sub: 'switch', channelId: scene1, parentChannelId: 'C1', userId: 'U3', values: { game: '#2' } },
        env.platform,
      ),
      env.deps,
    );
    assert.equal(denied.ephemeral, true);
    assert.ok(denied.content.includes('管理员') || denied.content.includes('KP'));
    assert.equal(env.store.getSceneGame(scene1), '#1');

    // the target session's KP can
    const allowed = await route(
      makeContext(
        { command: 'game', sub: 'switch', channelId: scene1, parentChannelId: 'C1', userId: 'KP2', values: { game: '奈亚' } },
        env.platform,
      ),
      env.deps,
    );
    assert.notEqual(allowed.ephemeral, true);
    assert.equal(env.store.getSceneGame(scene1), '#2');

    // unknown / ended sessions are refused
    const missing = await route(
      makeContext({ command: 'game', sub: 'switch', channelId: scene1, userId: 'ADMIN', isAdmin: true, values: { game: '#9' } }, env.platform),
      env.deps,
    );
    assert.equal(missing.ephemeral, true);
  });

  test('after switching, sheet binding / house rule / hidden thread / log all follow the target session', async () => {
    const env = makeEnv();
    await route(gameCtx(env, { name: '阿卡姆', keeper: 'U1', userId: 'U1' }), env.deps);
    const scene1 = env.store.getGame('G1', '#1')!.sceneThreadId!;
    await route(gameCtx(env, { name: '奈亚', keeper: 'U1', userId: 'U1' }), env.deps);
    const scene2 = env.store.getGame('G1', '#2')!.sceneThreadId!;

    const sceneCtx = (channelId: string): InteractionContext =>
      makeContext(
        { command: 'rc', channelId, parentChannelId: 'C1', userId: 'U1', values: { text: '力量' } },
        env.platform,
      );

    // tag + rule inside session #1
    await route(makeContext({ command: 'pc', sub: 'new', channelId: scene1, parentChannelId: 'C1', userId: 'U1', values: { name: '卡特' } }, env.platform), env.deps);
    await route(makeContext({ command: 'pc', sub: 'tag', channelId: scene1, parentChannelId: 'C1', userId: 'U1', values: { name: '卡特' } }, env.platform), env.deps);
    await route(makeContext({ command: 'setcoc', sub: 'set', channelId: scene1, parentChannelId: 'C1', userId: 'U1', values: { rule: 3 } }, env.platform), env.deps);
    assert.equal(env.store.getBinding('game', '#1', 'U1'), '卡特');
    assert.equal(env.store.getGameRule('#1', 'G1'), 3);

    await route(sceneCtx(scene1), env.deps);
    assert.equal(env.coc.checkCalls.at(-1)?.sheet?.name, '卡特');
    assert.equal(env.coc.checkCalls.at(-1)?.rule, 3);

    // switch scene1 → #2 as admin
    await route(
      makeContext({ command: 'game', sub: 'switch', channelId: scene1, parentChannelId: 'C1', userId: 'ADMIN', isAdmin: true, values: { game: '#2' } }, env.platform),
      env.deps,
    );
    assert.equal(env.store.getSceneGame(scene1), '#2');
    await route(sceneCtx(scene1), env.deps);
    assert.equal(env.coc.checkCalls.at(-1)?.sheet, null);
    assert.equal(env.coc.checkCalls.at(-1)?.rule, 0);

    // 日志按场景隔离：切局不会把日志换走，本场景自己的日志继续记录
    const list2 = await route(makeContext({ command: 'log', sub: 'list', channelId: scene1, parentChannelId: 'C1', userId: 'U1' }, env.platform), env.deps);
    assert.ok(list2.content.includes('阿卡姆'), list2.content);

    // …and switching back restores everything
    await route(
      makeContext({ command: 'game', sub: 'switch', channelId: scene1, parentChannelId: 'C1', userId: 'ADMIN', isAdmin: true, values: { game: '#1' } }, env.platform),
      env.deps,
    );
    await route(sceneCtx(scene1), env.deps);
    assert.equal(env.coc.checkCalls.at(-1)?.sheet?.name, '卡特');
    assert.equal(env.coc.checkCalls.at(-1)?.rule, 3);
    assert.equal(env.store.getSceneGame(scene2), '#2');
  });
});

describe('/game end', () => {
  test('default: exports every unfinished log, unbinds scenes, archives nothing', async () => {
    const env = makeEnv();
    await route(gameCtx(env, { name: '阿卡姆', keeper: 'KP1' }), env.deps);
    const game = env.store.getGame('G1', '#1')!;
    const scene = game.sceneThreadId!;
    const hidden = game.hiddenThreadId!;

    // a paused second log must be exported as well
    env.store.appendLogLine(scene, '甲(U1) 2026-01-01 00:00:00\n第一夜的内容\n\n');
    await route(makeContext({ command: 'log', sub: 'off', channelId: scene, parentChannelId: 'C1', userId: 'KP1' }, env.platform), env.deps);
    await route(makeContext({ command: 'log', sub: 'new', channelId: scene, parentChannelId: 'C1', userId: 'KP1', values: { name: '第二夜' } }, env.platform), env.deps);
    env.store.appendLogLine(scene, '甲(U1) 2026-01-01 00:00:01\n第二夜的内容\n\n');
    assert.equal(env.store.listLogs({ gameId: '#1', channelId: scene }).length, 2);

    const reply = await route(
      makeContext({ command: 'game', sub: 'end', channelId: scene, parentChannelId: 'C1', userId: 'KP1' }, env.platform),
      env.deps,
    );

    assert.notEqual(reply.ephemeral, true);
    assert.deepEqual(env.platform.archived, []);
    assert.equal(env.store.getGame('G1', '#1')?.status, 'ended');
    assert.equal(env.store.listScenesOfGame('#1').length, 0);
    assert.equal(env.store.getSceneGame(scene), null);

    const logs = env.store.listLogs({ gameId: '#1', channelId: scene });
    assert.equal(logs.length, 2);
    assert.ok(logs.every((log) => log.state === 'ended' && log.endedAt !== null));
    assert.ok(logs.every((log) => log.fileName !== null));
    assert.equal(reply.files?.length, 2);
    assert.ok(reply.content.includes('导出日志'));
    assert.ok(!reply.content.includes('已归档'));
    // the hidden thread is untouched by default
    assert.equal(env.platform.threads.has(hidden), true);
  });

  test('archive:true archives only bot-created threads; an external thread: scene is never archived', async () => {
    const env = makeEnv();
    env.platform.threads.set('T9', { id: 'T9', parentId: 'C1', name: '玩家自建', private: false });
    await route(gameCtx(env, { name: '外部', keeper: 'KP1', thread: 'T9' }), env.deps);
    const game = env.store.getGame('G1', '#1')!;

    await route(
      makeContext({ command: 'game', sub: 'end', channelId: 'T9', parentChannelId: 'C1', userId: 'KP1', values: { archive: true } }, env.platform),
      env.deps,
    );
    assert.ok(!env.platform.archived.includes('T9'));
    assert.deepEqual(env.platform.archived, [game.hiddenThreadId]);

    // …whereas a bot-created default scene is archived together with the hidden thread
    const env2 = makeEnv();
    await route(gameCtx(env2, { name: '自建', keeper: 'KP1' }), env2.deps);
    const created = env2.store.getGame('G1', '#1')!;
    await route(
      makeContext({ command: 'game', sub: 'end', channelId: created.sceneThreadId!, parentChannelId: 'C1', userId: 'KP1', values: { archive: true } }, env2.platform),
      env2.deps,
    );
    assert.deepEqual(env2.platform.archived.sort(), [created.sceneThreadId!, created.hiddenThreadId!].sort());
  });

  test('end is limited to the session KP or an admin', async () => {
    const env = makeEnv();
    await route(gameCtx(env, { name: '阿卡姆', keeper: 'KP1' }), env.deps);
    const scene = env.store.getGame('G1', '#1')!.sceneThreadId!;

    const denied = await route(
      makeContext({ command: 'game', sub: 'end', channelId: scene, parentChannelId: 'C1', userId: 'U9' }, env.platform),
      env.deps,
    );
    assert.equal(denied.ephemeral, true);
    assert.equal(env.store.getGame('G1', '#1')?.status, 'active');

    const byAdmin = await route(
      makeContext({ command: 'game', sub: 'end', channelId: scene, parentChannelId: 'C1', userId: 'ADMIN', isAdmin: true }, env.platform),
      env.deps,
    );
    assert.notEqual(byAdmin.ephemeral, true);
    assert.equal(env.store.getGame('G1', '#1')?.status, 'ended');
  });
});
