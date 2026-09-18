/**
 * T4 独立验证 · `/game` 与 `/log` 行为（§10.1 / §11.1 / §16.11 / §16.12）
 *
 * 全部从规格表格出发自行构造场景；不复用 tests/bot/game.test.ts 的断言。
 *
 * Run: node tests/verify/behavior-game-log.test.ts
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { route } from '../../src/bot/router.ts';
import type { InteractionContext } from '../../src/contracts/bot.ts';
import { makeContext, makeEnv, type CtxSpec, type TestEnv } from '../bot/fakes.ts';

function ctx(env: TestEnv, spec: CtxSpec): InteractionContext {
  return makeContext(spec, env.platform);
}

function start(env: TestEnv, values: Record<string, string | number | boolean>, over: Partial<CtxSpec> = {}): Promise<{ content: string; ephemeral?: boolean }> {
  return route(ctx(env, { command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'KP1', values, ...over }), env.deps);
}

describe('T4 · /game start', () => {
  test('默认开法：公开主场景子区 + 父频道下私密暗骰子区 + 自动日志 + 场景指针', async () => {
    const env = makeEnv();
    const reply = await start(env, { name: '阿卡姆', keeper: 'KP1' });

    assert.notEqual(reply.ephemeral, true);
    const game = env.store.getGame('G1', '#1');
    assert.ok(game, '必须注册 #1');
    assert.equal(game.name, '阿卡姆');
    assert.equal(game.keeperId, 'KP1');
    assert.equal(game.status, 'active');
    assert.equal(game.sceneThreadCreatedByBot, true, '主场景必须是 Bot 自建');
    assert.equal(game.parentChannelId, 'C1');

    const scene = env.platform.threads.get(game.sceneThreadId ?? '');
    assert.ok(scene, '主场景子区必须存在');
    assert.equal(scene.private, false, '主场景是公开子区（GUILD_PUBLIC_THREAD）');
    assert.equal(scene.parentId, 'C1');
    assert.equal(scene.name, '阿卡姆');

    const hidden = env.platform.threads.get(game.hiddenThreadId ?? '');
    assert.ok(hidden, '暗骰子区必须存在');
    assert.equal(hidden.private, true, '暗骰子区是私密子区');
    assert.equal(hidden.parentId, 'C1', '暗骰子区建在主场景的父频道下');
    assert.equal(hidden.name, '暗骰 · 阿卡姆');
    assert.ok(env.platform.members.get(game.hiddenThreadId ?? '')?.includes('KP1'), 'KP 必须加入暗骰子区');

    assert.equal(env.store.getSceneGame('C1'), '#1');
    assert.equal(env.store.getSceneGame(game.sceneThreadId ?? ''), '#1');

    const logs = env.store.listLogs({ gameId: '#1', channelId: 'C1', guildId: 'G1' });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].state, 'on');
    assert.ok(logs[0].name.startsWith('阿卡姆 · '), `日志名应为 <桌名> · <MMDD-HHmm>，实际 ${logs[0].name}`);
    assert.equal(game.currentLogId, logs[0].id);
  });

  test('多局并存：#1/#2 编号递增且资源互不干扰', async () => {
    const env = makeEnv();
    await start(env, { name: '一', keeper: 'KP1' });
    await start(env, { name: '二', keeper: 'KP2' });

    assert.deepEqual(env.store.listGames('G1').map((g) => g.id), ['#1', '#2']);
    const one = env.store.getGame('G1', '#1');
    const two = env.store.getGame('G1', '#2');
    assert.ok(one && two && one.sceneThreadId && two.sceneThreadId);
    assert.notEqual(one.sceneThreadId, two.sceneThreadId);
    assert.notEqual(one.hiddenThreadId, two.hiddenThreadId);
    assert.equal(env.platform.threads.get(two.hiddenThreadId ?? '')?.name, '暗骰 · 二');
    // 第二次 start 把 C1 切到 #2，但 #1 仍保有自己的主场景子区
    assert.equal(env.store.getSceneGame('C1'), '#2');
    assert.equal(env.store.getSceneGame(one.sceneThreadId ?? ''), '#1');
    assert.equal(env.store.listScenesOfGame('#1').length, 1);
  });

  test('场景本身是子区：主场景子区与暗骰子区都建在父频道下（子区不能内嵌）', async () => {
    const env = makeEnv();
    env.platform.channelNames.set('C1', '跑团');
    await start(env, { name: '阿卡姆', keeper: 'KP1' }, { channelId: 'T7', parentChannelId: 'C1', channelName: '某子区' });

    const game = env.store.getGame('G1', '#1');
    assert.ok(game);
    assert.equal(env.platform.threads.get(game.sceneThreadId ?? '')?.parentId, 'C1');
    assert.equal(env.platform.threads.get(game.hiddenThreadId ?? '')?.parentId, 'C1');
    assert.equal(env.store.getSceneGame('T7'), '#1', '发起者所在子区被绑定');
    assert.equal(env.store.getSceneGame('C1'), null, '父频道只是容器，不应被绑定');
  });

  test('here:true 就地开局：不新建公开子区，暗骰子区建在当前频道', async () => {
    const env = makeEnv();
    await start(env, { name: '就地', keeper: 'KP1', here: true });

    const game = env.store.getGame('G1', '#1');
    assert.ok(game);
    assert.equal(game.sceneThreadId, null);
    assert.equal(game.sceneThreadCreatedByBot, false);
    assert.equal(env.store.getSceneGame('C1'), '#1');
    assert.equal([...env.platform.threads.values()].filter((t) => !t.private).length, 0, '不应有公开子区');
    assert.equal(env.platform.threads.get(game.hiddenThreadId ?? '')?.parentId, 'C1');
  });

  test('DM 中 /game start 被拒（局是服务器级概念）', async () => {
    const env = makeEnv();
    const reply = await route(ctx(env, { command: 'game', sub: 'start', guildId: null, values: { name: 'x' } }), env.deps);
    assert.equal(reply.ephemeral, true);
    assert.equal(env.store.listGames('G1').length, 0);
  });

  test('缺权限：降级为就地开局并在回执说明', async () => {
    const env = makeEnv();
    env.platform.canCreate = false;
    const reply = await start(env, { name: '无权限' });
    const game = env.store.getGame('G1', '#1');
    assert.ok(game);
    assert.equal(game.sceneThreadId, null);
    assert.equal(game.hiddenThreadId, null);
    assert.equal(env.store.getSceneGame('C1'), '#1');
    assert.ok(reply.content.includes('就地'));
  });
});

describe('T4 · /game switch 与上下文跟随', () => {
  test('权限：普通玩家被拒；目标局 KP / 管理员可切；未知局被拒', async () => {
    const env = makeEnv();
    await start(env, { name: '一', keeper: 'KP1' });
    const t1 = env.store.getGame('G1', '#1')?.sceneThreadId ?? '';
    await start(env, { name: '二', keeper: 'KP2' }, { userId: 'KP2' });
    const t2 = env.store.getGame('G1', '#2')?.sceneThreadId ?? '';

    const denied = await route(ctx(env, { command: 'game', sub: 'switch', channelId: t2, parentChannelId: 'C1', userId: 'U9', values: { game: '#1' } }), env.deps);
    assert.equal(denied.ephemeral, true);
    assert.equal(env.store.getSceneGame(t2), '#2', '被拒时不得改指针');

    const byKeeper = await route(ctx(env, { command: 'game', sub: 'switch', channelId: t2, parentChannelId: 'C1', userId: 'KP1', values: { game: '#1' } }), env.deps);
    assert.notEqual(byKeeper.ephemeral, true, '目标局 KP 可以切');
    assert.equal(env.store.getSceneGame(t2), '#1');

    const byAdmin = await route(ctx(env, { command: 'game', sub: 'switch', channelId: t1, parentChannelId: 'C1', userId: 'ADMIN', isAdmin: true, values: { game: '#2' } }), env.deps);
    assert.notEqual(byAdmin.ephemeral, true);
    assert.equal(env.store.getSceneGame(t1), '#2');

    const missing = await route(ctx(env, { command: 'game', sub: 'switch', channelId: t1, userId: 'ADMIN', isAdmin: true, values: { game: '#9' } }), env.deps);
    assert.equal(missing.ephemeral, true);
  });

  test('切换后：角色卡 / 暗骰子区 / 房规 跟随；日志按场景隔离不跟随', async () => {
    const env = makeEnv();
    await start(env, { name: '一', keeper: 'U1' }, { userId: 'U1' });
    await start(env, { name: '二', keeper: 'U1' }, { userId: 'U1' });
    const one = env.store.getGame('G1', '#1');
    const two = env.store.getGame('G1', '#2');
    assert.ok(one && two && one.sceneThreadId && two.sceneThreadId);
    const t1 = one.sceneThreadId;
    const inT1 = (spec: Partial<CtxSpec> & { command: string; sub?: string }): InteractionContext =>
      ctx(env, { channelId: t1, parentChannelId: 'C1', userId: 'U1', ...spec });

    // 在 #1 里建卡、绑卡、设房规
    await route(inT1({ command: 'pc', sub: 'new', values: { name: '卡特' } }), env.deps);
    await route(inT1({ command: 'pc', sub: 'tag', values: { name: '卡特' } }), env.deps);
    await route(inT1({ command: 'setcoc', sub: 'set', values: { rule: 3 } }), env.deps);
    assert.equal(env.store.getBinding('game', '#1', 'U1'), '卡特');
    assert.equal(env.store.getGameRule('#1', 'G1'), 3);
    assert.equal(env.store.getSceneRule(t1), null, '有局时不得写场景房规');

    await route(inT1({ command: 'rc', values: { text: '力量' } }), env.deps);
    assert.equal(env.coc.checkCalls.at(-1)?.sheet?.name, '卡特');
    assert.equal(env.coc.checkCalls.at(-1)?.rule, 3);

    // 切到 #2
    await route(inT1({ command: 'game', sub: 'switch', values: { game: '#2' } }), env.deps);
    await route(inT1({ command: 'rc', values: { text: '力量' } }), env.deps);
    assert.equal(env.coc.checkCalls.at(-1)?.sheet, null, '#2 没有角色卡绑定');
    assert.equal(env.coc.checkCalls.at(-1)?.rule, 0, '#2 房规回落默认');

    const rh = await route(inT1({ command: 'rh', values: { text: '心理学' } }), env.deps);
    // 规格更新：暗骰回执改为仅发起者可见（ephemeral），频道内不再有公开提示
    assert.equal(rh.ephemeral, true);
    assert.equal(env.platform.messages.at(-1)?.channelId, two.hiddenThreadId, '暗骰子区跟随 #2');

    const list2 = await route(inT1({ command: 'log', sub: 'list' }), env.deps);
    // 规格更新：日志按场景隔离（谁开的日志记谁的发言），不随局切换而被换走
    assert.ok(list2.content.includes('一 · '), `日志不得随局切换：${list2.content}`);

    // 切回 #1
    await route(inT1({ command: 'game', sub: 'switch', values: { game: '#1' } }), env.deps);
    await route(inT1({ command: 'rc', values: { text: '力量' } }), env.deps);
    assert.equal(env.coc.checkCalls.at(-1)?.sheet?.name, '卡特');
    assert.equal(env.coc.checkCalls.at(-1)?.rule, 3);
    const rhBack = await route(inT1({ command: 'rh', values: { text: '心理学' } }), env.deps);
    assert.equal(rhBack.ephemeral, true);
    assert.equal(env.platform.messages.at(-1)?.channelId, one.hiddenThreadId);
  });

  test('切局导致旧局不再有任何场景时，旧局 on 日志自动暂停（不导出）', async () => {
    const env = makeEnv();
    await start(env, { name: '一', keeper: 'KP1', here: true });
    const log1 = env.store.listLogs({ gameId: '#1', channelId: 'C1', guildId: 'G1' })[0];
    assert.equal(log1.state, 'on');

    // 在同一个频道再开一局（默认会新建子区 T2），#1 失去它唯一的场景 C1
    await start(env, { name: '二', keeper: 'KP1' });
    assert.equal(env.store.listScenesOfGame('#1').length, 0);
    const after = env.store.getLog(log1.id);
    assert.equal(after?.state, 'off', '旧局日志必须自动 /log off');
    assert.equal(after?.endedAt, null, '暂停不得结束日志');
    assert.equal(after?.fileName, null, '暂停不得导出');
    assert.equal(env.store.listLogs({ gameId: '#2', channelId: 'C1', guildId: 'G1' })[0].state, 'on');
  });

  test('旧局仍保有其他场景时其日志继续记录（不得误暂停）', async () => {
    const env = makeEnv();
    await start(env, { name: '一', keeper: 'KP1' });
    const t1 = env.store.getGame('G1', '#1')?.sceneThreadId ?? '';
    const log1 = env.store.listLogs({ gameId: '#1', channelId: t1, guildId: 'G1' })[0];
    // 再开一局：只夺走 C1 指针，#1 仍有主场景子区 T1
    await start(env, { name: '二', keeper: 'KP1' });
    assert.equal(env.store.listScenesOfGame('#1').length, 1);
    assert.equal(env.store.getLog(log1.id)?.state, 'on');
  });
});

describe('T4 · /game end', () => {
  test('默认收官：逐条导出所有未结束日志、解绑场景、绝不归档', async () => {
    const env = makeEnv();
    await start(env, { name: '一', keeper: 'KP1' });
    const game = env.store.getGame('G1', '#1');
    assert.ok(game && game.sceneThreadId && game.hiddenThreadId);
    const t1 = game.sceneThreadId;

    // 一条 off + 一条 on 的日志（都要有内容，0 字节附件会被 Discord 拒绝）
    env.store.appendLogLine(t1, '甲(U1) 2026-01-01 00:00:00\n第一夜的内容\n\n');
    await route(ctx(env, { command: 'log', sub: 'off', channelId: t1, parentChannelId: 'C1', userId: 'KP1' }), env.deps);
    await route(ctx(env, { command: 'log', sub: 'new', channelId: t1, parentChannelId: 'C1', userId: 'KP1', values: { name: '第二夜' } }), env.deps);
    env.store.appendLogLine(t1, '甲(U1) 2026-01-01 00:00:01\n第二夜的内容\n\n');
    const before = env.store.listLogs({ gameId: '#1', channelId: t1, guildId: 'G1' });
    assert.equal(before.length, 2);

    const reply = await route(ctx(env, { command: 'game', sub: 'end', channelId: t1, parentChannelId: 'C1', userId: 'KP1' }), env.deps);
    assert.notEqual(reply.ephemeral, true);
    assert.deepEqual(env.platform.archived, [], '默认不动子区');
    assert.equal(env.store.getGame('G1', '#1')?.status, 'ended');
    assert.equal(env.store.getGame('G1', '#1')?.endedAt !== null, true);
    assert.equal(env.store.listScenesOfGame('#1').length, 0);
    assert.equal(env.store.getSceneGame(t1), null);
    assert.equal(env.store.getSceneGame('C1'), null);

    const after = env.store.listLogs({ gameId: '#1', channelId: t1, guildId: 'G1' });
    assert.equal(after.length, 2);
    assert.ok(after.every((l) => l.state === 'ended' && l.endedAt !== null && l.fileName !== null));
    assert.equal(reply.files?.length, 2, '两条未结束日志都要以附件导出');
    assert.equal(env.platform.threads.has(game.hiddenThreadId), true, '默认不归档=子区仍在');
    assert.ok(reply.content.includes('未归档') || reply.content.includes('保持原样'));
  });

  test('archive:true 只归档 Bot 自建子区；thread: 指定的外部子区不动', async () => {
    const env = makeEnv();
    env.platform.threads.set('T9', { id: 'T9', parentId: 'C1', name: '玩家自建', private: false });
    await start(env, { name: '外部', keeper: 'KP1', thread: 'T9' });
    const game = env.store.getGame('G1', '#1');
    assert.ok(game);

    await route(ctx(env, { command: 'game', sub: 'end', channelId: 'T9', parentChannelId: 'C1', userId: 'KP1', values: { archive: true } }), env.deps);
    assert.deepEqual(env.platform.archived, [game.hiddenThreadId], '只归档 Bot 自建的暗骰子区');
    assert.ok(!env.platform.archived.includes('T9'));

    const env2 = makeEnv();
    await start(env2, { name: '自建', keeper: 'KP1' });
    const g2 = env2.store.getGame('G1', '#1');
    assert.ok(g2 && g2.sceneThreadId);
    await route(ctx(env2, { command: 'game', sub: 'end', channelId: g2.sceneThreadId, parentChannelId: 'C1', userId: 'KP1', values: { archive: true } }), env2.deps);
    assert.deepEqual(env2.platform.archived.slice().sort(), [g2.sceneThreadId, g2.hiddenThreadId ?? ''].sort());
  });

  test('结束权限：非 KP 非管理员被拒；管理员可结束；结束后的局不能 switch', async () => {
    const env = makeEnv();
    await start(env, { name: '一', keeper: 'KP1' });
    const t1 = env.store.getGame('G1', '#1')?.sceneThreadId ?? '';

    const denied = await route(ctx(env, { command: 'game', sub: 'end', channelId: t1, parentChannelId: 'C1', userId: 'U9' }), env.deps);
    assert.equal(denied.ephemeral, true);
    assert.equal(env.store.getGame('G1', '#1')?.status, 'active');

    const ended = await route(ctx(env, { command: 'game', sub: 'end', channelId: t1, parentChannelId: 'C1', userId: 'ADMIN', isAdmin: true }), env.deps);
    assert.notEqual(ended.ephemeral, true);
    assert.equal(env.store.getGame('G1', '#1')?.status, 'ended');

    const again = await route(ctx(env, { command: 'game', sub: 'switch', channelId: t1, userId: 'ADMIN', isAdmin: true, values: { game: '#1' } }), env.deps);
    assert.equal(again.ephemeral, true, '已结束的局不能切换');
  });
});

describe('T4 · /log 生命周期', () => {
  test('on 时 /log new 被拒；off 后旧日志保持 off、不结束不导出', async () => {
    const env = makeEnv();
    await start(env, { name: '一', keeper: 'KP1' });
    const t1 = env.store.getGame('G1', '#1')?.sceneThreadId ?? '';
    const base = (spec: { command: string; sub?: string; values?: Record<string, string | number | boolean> }): InteractionContext =>
      ctx(env, { channelId: t1, parentChannelId: 'C1', userId: 'KP1', ...spec });

    const refused = await route(base({ command: 'log', sub: 'new', values: { name: '第二夜' } }), env.deps);
    assert.equal(refused.ephemeral, true);
    assert.ok(refused.content.includes('仍在记录'));
    assert.equal(env.store.listLogs({ gameId: '#1', channelId: t1, guildId: 'G1' }).length, 1);

    env.store.appendLogLine(t1, '甲(U1) 2026-01-01 00:00:00\n第一夜的内容\n\n');
    await route(base({ command: 'log', sub: 'off' }), env.deps);
    const opened = await route(base({ command: 'log', sub: 'new', values: { name: '第二夜' } }), env.deps);
    assert.notEqual(opened.ephemeral, true);
    assert.equal(opened.files, undefined, '开新日志不得导出旧日志');

    const logs = env.store.listLogs({ gameId: '#1', channelId: t1, guildId: 'G1' });
    assert.equal(logs.length, 2);
    const first = logs.find((l) => l.name.startsWith('一 · '));
    const second = logs.find((l) => l.name === '第二夜');
    assert.equal(first?.state, 'off');
    assert.equal(first?.endedAt, null, '暂停日志不得被自动结束');
    assert.equal(first?.fileName, null, '暂停日志不得被自动导出');
    assert.equal(second?.state, 'on');
    assert.equal(env.store.getGame('G1', '#1')?.currentLogId, second?.id);

    // /log list 能同时看到状态
    const list = await route(base({ command: 'log', sub: 'list' }), env.deps);
    assert.ok(list.content.includes('第二夜'));
    assert.ok(list.content.includes('记录中'));
    assert.ok(list.content.includes('暂停'));

    // 单独导出旧日志
    const ended = await route(base({ command: 'log', sub: 'end', values: { name: first?.name ?? '' } }), env.deps);
    assert.notEqual(ended.ephemeral, true);
    assert.equal(ended.files?.length, 1);
    assert.equal(env.store.getLog(first?.id ?? '')?.state, 'ended');
    assert.equal(env.store.getLog(second?.id ?? '')?.state, 'on', '导出旧日志不得动新的 on 日志');

    // end 当前生效日志后可以继续 /log new
    const endedCurrent = await route(base({ command: 'log', sub: 'end' }), env.deps);
    assert.notEqual(endedCurrent.ephemeral, true);
    assert.equal(env.store.getLog(second?.id ?? '')?.state, 'ended');
    const third = await route(base({ command: 'log', sub: 'new', values: { name: '第三夜' } }), env.deps);
    assert.notEqual(third.ephemeral, true);
    assert.equal(env.store.listLogs({ gameId: '#1', channelId: t1, guildId: 'G1' }).length, 3);
  });

  test('无局无日志：/log new 自动建局（就地绑定、KP=发起者、建暗骰子区）', async () => {
    const env = makeEnv();
    const reply = await route(ctx(env, { command: 'log', sub: 'new', channelId: 'C1', channelName: '跑团', userId: 'U1', values: { name: '第一夜' } }), env.deps);

    assert.notEqual(reply.ephemeral, true);
    const games = env.store.listGames('G1');
    assert.equal(games.length, 1);
    assert.equal(games[0].id, '#1');
    assert.equal(games[0].name, '第一夜');
    assert.equal(games[0].keeperId, 'U1');
    assert.equal(games[0].sceneThreadId, null, 'here:true → 不新建子区');
    assert.equal(env.store.getSceneGame('C1'), '#1');
    assert.ok(games[0].hiddenThreadId, '自动建局也要建暗骰子区');
    const log = env.store.listLogs({ gameId: '#1', channelId: 'C1', guildId: 'G1' })[0];
    assert.equal(log.name, '第一夜');
    assert.equal(log.state, 'on');
    assert.ok(reply.content.includes('自动开局'));
  });

  test('已有局：/log new 只加日志不建新局', async () => {
    const env = makeEnv();
    await start(env, { name: '一', keeper: 'KP1' });
    const t1 = env.store.getGame('G1', '#1')?.sceneThreadId ?? '';

    await route(ctx(env, { command: 'log', sub: 'off', channelId: t1, parentChannelId: 'C1', userId: 'KP1' }), env.deps);
    await route(ctx(env, { command: 'log', sub: 'new', channelId: t1, parentChannelId: 'C1', userId: 'KP1', values: { name: '第二章' } }), env.deps);
    assert.equal(env.store.listGames('G1').length, 1, '不得新建局');
    assert.equal(env.store.listLogs({ gameId: '#1', channelId: t1, guildId: 'G1' }).length, 2);
  });

  test('/log new game:<局>：把当前场景切到该局并挂日志', async () => {
    const env = makeEnv();
    await start(env, { name: '一', keeper: 'U1' }, { userId: 'U1' });
    const t1 = env.store.getGame('G1', '#1')?.sceneThreadId ?? '';
    await route(ctx(env, { command: 'log', sub: 'off', channelId: t1, parentChannelId: 'C1', userId: 'U1' }), env.deps);
    await start(env, { name: '二', keeper: 'U1' }, { userId: 'U1' });
    const t2 = env.store.getGame('G1', '#2')?.sceneThreadId ?? '';

    // 在 T2 里把 #1 的日志挂到 T2，同时 T2 切到 #1
    await route(ctx(env, { command: 'log', sub: 'off', channelId: t2, parentChannelId: 'C1', userId: 'U1' }), env.deps);
    await route(ctx(env, { command: 'log', sub: 'new', channelId: t2, parentChannelId: 'C1', userId: 'U1', values: { name: '回切', game: '#1' } }), env.deps);
    assert.equal(env.store.getSceneGame(t2), '#1');
    const logs = env.store.listLogs({ gameId: '#1', channelId: t2, guildId: 'G1' });
    assert.equal(logs.length, 2);
    assert.equal(logs.at(-1)?.name, '回切');
  });

  test('DM：/log new 不建局，只建场景日志；game: 被拒', async () => {
    const env = makeEnv();
    const dm = (spec: Partial<CtxSpec>): InteractionContext =>
      ctx(env, { command: 'log', sub: 'new', guildId: null, channelId: 'D1', userId: 'U1', ...spec });

    const reply = await route(dm({ values: { name: '单人团' } }), env.deps);
    assert.notEqual(reply.ephemeral, true);
    assert.equal(env.store.listGames('G1').length, 0, 'DM 不建局');
    const log = env.store.listLogs({ gameId: null, channelId: 'D1' })[0];
    assert.ok(log);
    assert.equal(log.name, '单人团');
    assert.equal(log.gameId, null);

    const withGame = await route(dm({ values: { name: 'x', game: '#1' } }), env.deps);
    assert.equal(withGame.ephemeral, true);
  });

  test('/game start 之后 /log new 拒绝、/log off + /log new 允许（反向入口回归）', async () => {
    const env = makeEnv();
    await start(env, { name: '一', keeper: 'KP1' });
    const t1 = env.store.getGame('G1', '#1')?.sceneThreadId ?? '';
    const refused = await route(ctx(env, { command: 'log', sub: 'new', channelId: t1, parentChannelId: 'C1', userId: 'KP1', values: { name: 'x' } }), env.deps);
    assert.equal(refused.ephemeral, true);
  });
});
