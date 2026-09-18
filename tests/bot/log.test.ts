/**
 * `/log` behaviour: on/off/end, uniqueness refusal, paused logs are preserved, `game:` attach,
 * automatic session creation (the reverse entry point of `/game start`).
 * Run: node tests/bot/log.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { route } from '../../src/bot/router.ts';
import { diceLogFileName } from '../../src/bot/logFormat.ts';
import { makeContext, makeEnv, type TestEnv } from './fakes.ts';
import type { InteractionContext } from '../../src/contracts/bot.ts';

function startCtx(env: TestEnv, values: Record<string, string | number | boolean>): InteractionContext {
  return makeContext(
    { command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'KP1', values },
    env.platform,
  );
}

function logCtx(
  env: TestEnv,
  sub: string,
  values: Record<string, string | number | boolean> = {},
  overrides: Partial<Parameters<typeof makeContext>[0]> = {},
): InteractionContext {
  return makeContext(
    { command: 'log', sub, channelId: 'C1', userId: 'KP1', values, ...overrides },
    env.platform,
  );
}

describe('/log new', () => {
  test('is refused while the active log is still recording', async () => {
    const env = makeEnv();
    await route(startCtx(env, { name: '阿卡姆', keeper: 'KP1' }), env.deps);
    const scene = env.store.getGame('G1', '#1')!.sceneThreadId!;

    const reply = await route(
      makeContext({ command: 'log', sub: 'new', channelId: scene, parentChannelId: 'C1', userId: 'KP1', values: { name: '第二夜' } }, env.platform),
      env.deps,
    );
    assert.equal(reply.ephemeral, true);
    assert.ok(reply.content.includes('仍在记录中'));
    assert.ok(reply.content.includes('/log end') && reply.content.includes('/log off'));
    assert.equal(env.store.listLogs({ gameId: '#1', channelId: scene }).length, 1);
  });

  test('after /log off it opens a new log and leaves the paused one untouched (no end, no export)', async () => {
    const env = makeEnv();
    await route(startCtx(env, { name: '阿卡姆', keeper: 'KP1' }), env.deps);
    const scene = env.store.getGame('G1', '#1')!.sceneThreadId!;
    const ctxFor = (sub: string, values: Record<string, string | number | boolean> = {}): InteractionContext =>
      makeContext({ command: 'log', sub, channelId: scene, parentChannelId: 'C1', userId: 'KP1', values }, env.platform);

    await route(ctxFor('off'), env.deps);
    const first = env.store.listLogs({ gameId: '#1', channelId: scene })[0];
    assert.equal(first.state, 'off');

    const reply = await route(ctxFor('new', { name: '第二夜' }), env.deps);
    assert.notEqual(reply.ephemeral, true);

    const logs = env.store.listLogs({ gameId: '#1', channelId: scene });
    assert.equal(logs.length, 2);
    const paused = logs.find((l) => l.id === first.id)!;
    assert.equal(paused.state, 'off');
    assert.equal(paused.endedAt, null);
    assert.equal(paused.fileName, null);
    const fresh = logs.find((l) => l.id !== first.id)!;
    assert.equal(fresh.state, 'on');
    assert.equal(fresh.name, '第二夜');
    assert.equal(env.store.getGame('G1', '#1')?.currentLogId, fresh.id);
    assert.ok(reply.content.includes('原样保留'));

    // /log list shows both
    const list = await route(ctxFor('list'), env.deps);
    assert.ok(list.content.includes(first.name));
    assert.ok(list.content.includes('第二夜'));
    assert.ok(list.content.includes('已暂停'));
    assert.ok(list.content.includes('记录中'));
    assert.ok(list.content.includes('← 当前生效'));
  });

  test('with no session at all it creates one in place (等价 /game start here:true, 桌名取日志名)', async () => {
    const env = makeEnv();
    const reply = await route(logCtx(env, 'new', { name: '第一夜' }), env.deps);

    assert.notEqual(reply.ephemeral, true);
    assert.ok(reply.content.includes('自动开局'));
    const games = env.store.listGames('G1');
    assert.equal(games.length, 1);
    const game = games[0];
    assert.equal(game.name, '第一夜');
    assert.equal(game.keeperId, 'KP1');
    assert.equal(game.sceneThreadId, null, 'here:true must not create a scene thread');
    assert.equal(env.store.getSceneGame('C1'), game.id);
    assert.ok(game.hiddenThreadId);
    assert.equal(env.platform.threads.get(game.hiddenThreadId)?.name, '暗骰 · 第一夜');
    assert.equal(env.platform.threads.get(game.hiddenThreadId)?.private, true);

    const logs = env.store.listLogs({ gameId: game.id, channelId: 'C1' });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].name, '第一夜');
    assert.equal(logs[0].state, 'on');
    assert.equal(game.currentLogId, logs[0].id);
  });

  test('in DM no session is created; only a scene log', async () => {
    const env = makeEnv();
    const reply = await route(logCtx(env, 'new', { name: '侦查' }, { guildId: null }), env.deps);
    assert.notEqual(reply.ephemeral, true);
    assert.equal(env.store.listGames('G1').length, 0);
    const logs = env.store.listLogs({ gameId: null, channelId: 'C1' });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].state, 'on');
    assert.equal(logs[0].gameId, null);
  });

  test('game: 不同场景可以各自同时开日志；同一场景才拒绝', async () => {
    const env = makeEnv();
    await route(startCtx(env, { name: '阿卡姆', keeper: 'KP1' }), env.deps);
    const scene = env.store.getGame('G1', '#1')!.sceneThreadId!;

    // C2 与开局的主场景不是同一个场景 → 允许同时记录（日志按场景隔离）
    const reply = await route(logCtx(env, 'new', { name: '第二夜', game: '#1' }, { channelId: 'C2' }), env.deps);
    assert.notEqual(reply.ephemeral, true);
    assert.equal(env.store.getSceneGame('C2'), '#1');
    const logs = env.store.listSceneLogs('C2', 'G1');
    assert.equal(logs.length, 1, 'C2 只有自己新开的一条');
    const second = logs[0];
    assert.equal(second.name, '第二夜');
    assert.equal(second.state, 'on');
    assert.equal(second.gameId, '#1');

    // 主场景那条依旧在记录（两条同时 on）
    const sceneLog = env.store.listSceneLogs(scene, 'G1').find((l) => l.state === 'on');
    assert.ok(sceneLog, '主场景日志仍在记录');

    // 同一场景再开 → 拒绝
    const refused = await route(logCtx(env, 'new', { name: '第三夜' }, { channelId: 'C2' }), env.deps);
    assert.equal(refused.ephemeral, true);
  });

  test('duplicate log names inside one session are auto-numbered', async () => {
    const env = makeEnv();
    await route(logCtx(env, 'new', { name: '第一夜' }), env.deps);
    const game = env.store.listGames('G1')[0];
    const scene = 'C1';

    await route(makeContext({ command: 'log', sub: 'off', channelId: scene, userId: 'KP1' }, env.platform), env.deps);
    await route(makeContext({ command: 'log', sub: 'new', channelId: scene, userId: 'KP1', values: { name: '第一夜' } }, env.platform), env.deps);

    const names = env.store.listLogs({ gameId: game.id, channelId: scene }).map((l) => l.name).sort();
    assert.deepEqual(names, ['第一夜', '第一夜 (2)'].sort());
  });
});

describe('/log on / off / end', () => {
  test('off then on resumes the same log; an ended log cannot be resumed', async () => {
    const env = makeEnv();
    await route(startCtx(env, { name: '阿卡姆', keeper: 'KP1' }), env.deps);
    const scene = env.store.getGame('G1', '#1')!.sceneThreadId!;
    const ctxFor = (sub: string, values: Record<string, string | number | boolean> = {}): InteractionContext =>
      makeContext({ command: 'log', sub, channelId: scene, parentChannelId: 'C1', userId: 'KP1', values }, env.platform);

    await route(ctxFor('off'), env.deps);
    await route(ctxFor('on'), env.deps);
    assert.equal(env.store.listLogs({ gameId: '#1', channelId: scene })[0].state, 'on');

    await route(ctxFor('end'), env.deps);
    const ended = env.store.listLogs({ gameId: '#1', channelId: scene })[0];
    assert.equal(ended.state, 'ended');

    const refused = await route(ctxFor('on'), env.deps);
    assert.equal(refused.ephemeral, true);
    assert.ok(refused.content.includes('/log new'));
  });

  test('/log end name: exports a specific paused log and attaches the file', async () => {
    const env = makeEnv();
    await route(startCtx(env, { name: '阿卡姆', keeper: 'KP1' }), env.deps);
    const scene = env.store.getGame('G1', '#1')!.sceneThreadId!;
    const ctxFor = (values: Record<string, string | number | boolean> = {}): InteractionContext =>
      makeContext({ command: 'log', sub: 'end', channelId: scene, parentChannelId: 'C1', userId: 'KP1', values }, env.platform);

    // 先给「第一夜」写一行内容（0 字节附件会被 Discord 拒绝），再暂停它
    env.store.appendLogLine(scene, '甲(U1) 2026-01-01 00:00:00\n你好\n\n');
    await route(makeContext({ command: 'log', sub: 'off', channelId: scene, parentChannelId: 'C1', userId: 'KP1' }, env.platform), env.deps);
    await route(makeContext({ command: 'log', sub: 'new', channelId: scene, parentChannelId: 'C1', userId: 'KP1', values: { name: '第二夜' } }, env.platform), env.deps);
    const first = env.store.listLogs({ gameId: '#1', channelId: scene }).find((l) => l.name !== '第二夜')!;

    const reply = await route(ctxFor({ name: first.name }), env.deps);
    assert.notEqual(reply.ephemeral, true);
    assert.equal(reply.files?.length, 1);
    assert.ok(reply.content.includes(first.name));
    const ended = env.store.getLog(first.id)!;
    assert.equal(ended.state, 'ended');
    assert.ok(ended.fileName);
    // Dice! 命名：`<局名>_<日志名>.txt`，附件名与落盘名一致
    assert.equal(ended.fileName, diceLogFileName('阿卡姆', first.name));
    assert.equal(reply.files?.[0]?.name, ended.fileName);
    // the still-recording log is untouched
    const stillOn = env.store.listLogs({ gameId: '#1', channelId: scene }).find((l) => l.name === '第二夜')!;
    assert.equal(stillOn.state, 'on');
  });

  test('unknown log name is reported instead of silently doing nothing', async () => {
    const env = makeEnv();
    await route(startCtx(env, { name: '阿卡姆', keeper: 'KP1' }), env.deps);
    const scene = env.store.getGame('G1', '#1')!.sceneThreadId!;
    const reply = await route(
      makeContext({ command: 'log', sub: 'end', channelId: scene, parentChannelId: 'C1', userId: 'KP1', values: { name: '不存在' } }, env.platform),
      env.deps,
    );
    assert.equal(reply.ephemeral, true);
    assert.ok(reply.content.includes('找不到'));
  });

  test('/log list with no log at all explains how to start one', async () => {
    const env = makeEnv();
    const reply = await route(makeContext({ command: 'log', sub: 'list', channelId: 'CX' }, env.platform), env.deps);
    assert.ok(reply.content.includes('没有日志'));
  });
});
