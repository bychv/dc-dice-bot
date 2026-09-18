/**
 * 日志说话人名字（`src/bot/logSpeaker.ts`）——对齐 Dice! `idx_pc`
 * （`ref/Dice/Dice/CharacterCard.cpp:737`）：角色卡名 → 称呼 → Discord 显示名。
 *
 * 重点：
 *   - 卡名「有设定就用，没有就回退」；
 *   - **设定会切换名字**：中途改卡名 / 改称呼，只有之后的行换新名字，已写入的行不变；
 *   - 子区继承父频道（与 /rc 同一解析链），骰娘那行用服务器昵称。
 *
 * Run: node tests/bot/log-speaker.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatInputCommandInteraction, Message } from 'discord.js';

import { createLogRecorder, respond } from '../../src/bot/adapter.ts';
import { botSpeakerName, speakerName } from '../../src/bot/logSpeaker.ts';
import { route } from '../../src/bot/router.ts';
import type { CharacterSheet } from '../../src/contracts/model.ts';
import { makeContext, makeEnv, type TestEnv } from './fakes.ts';

function sheet(name: string): CharacterSheet {
  return {
    name,
    template: 'COC7',
    attrs: { 闪避: '50' },
    exprs: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function fakeMessage(spec: { content: string; channelId?: string; parentChannelId?: string; userId?: string; displayName?: string }): Message {
  const parentId = spec.parentChannelId ?? null;
  return {
    author: { bot: false, username: spec.displayName ?? '甲', id: spec.userId ?? 'U1' },
    member: { displayName: spec.displayName ?? '甲' },
    guildId: 'G1',
    channelId: spec.channelId ?? 'C1',
    content: spec.content,
    attachments: { size: 0, values: () => new Map().values() },
    channel: { isThread: (): boolean => parentId !== null, parentId },
  } as unknown as Message;
}

async function openLogOnC1(env: TestEnv): Promise<string> {
  await route(
    makeContext(
      { command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'KP1', values: { name: '阿卡姆', keeper: 'KP1', here: true } },
      env.platform,
    ),
    env.deps,
  );
  return env.store.listLogs({ gameId: '#1', channelId: 'C1' })[0]!.id;
}

describe('speakerName：角色卡名 → 称呼 → 显示名', () => {
  test('有卡就用卡名（场景绑定）', () => {
    const env = makeEnv();
    env.store.putSheet('U1', sheet('陈寻川'));
    env.store.setBinding('scene', 'C1', 'U1', '陈寻川');
    assert.equal(speakerName(env.store, { guildId: 'G1', channelId: 'C1', userId: 'U1' }, '甲'), '陈寻川');
  });

  test('子区继承父频道的卡（与 /rc 同一条链）', () => {
    const env = makeEnv();
    env.store.putSheet('U1', sheet('陈寻川'));
    env.store.setBinding('scene', 'C1', 'U1', '陈寻川');
    assert.equal(
      speakerName(env.store, { guildId: 'G1', channelId: 'T7', parentChannelId: 'C1', userId: 'U1' }, '甲'),
      '陈寻川',
    );
  });

  test('局绑定的卡优先于场景绑定（换局就换名字）', () => {
    const env = makeEnv();
    env.store.putSheet('U1', sheet('阿卡姆的卡'));
    env.store.putSheet('U1', sheet('奈亚的卡'));
    env.store.setBinding('scene', 'C1', 'U1', '阿卡姆的卡');
    env.store.setBinding('game', '#2', 'U1', '奈亚的卡');
    env.store.setSceneGame('C1', 'G1', '#2');
    env.store.putGame({
      id: '#1', guildId: 'G1', name: '一', keeperId: 'KP1', status: 'active', sceneThreadId: null,
      parentChannelId: 'C1', sceneThreadCreatedByBot: false, hiddenThreadId: null, rule: null,
      currentLogId: null, startedAt: '2026-01-01T00:00:00.000Z', endedAt: null,
    });
    env.store.putGame({
      id: '#2', guildId: 'G1', name: '二', keeperId: 'KP1', status: 'active', sceneThreadId: null,
      parentChannelId: 'C1', sceneThreadCreatedByBot: false, hiddenThreadId: null, rule: null,
      currentLogId: null, startedAt: '2026-01-01T00:00:00.000Z', endedAt: null,
    });
    assert.equal(speakerName(env.store, { guildId: 'G1', channelId: 'C1', userId: 'U1' }, '甲'), '奈亚的卡');
  });

  test('没卡时用 /nn 设定的称呼（本场景 > 全局）', () => {
    const env = makeEnv();
    env.store.setGlobalNick('G1', 'U1', '全局老王');
    assert.equal(speakerName(env.store, { guildId: 'G1', channelId: 'C1', userId: 'U1' }, '甲'), '全局老王');
    env.store.setNick('G1', 'C1', 'U1', '本场老王');
    assert.equal(speakerName(env.store, { guildId: 'G1', channelId: 'C1', userId: 'U1' }, '甲'), '本场老王');
  });

  test('都没设定才回退 Discord 显示名；连显示名都没有时用「未知」', () => {
    const env = makeEnv();
    assert.equal(speakerName(env.store, { guildId: 'G1', channelId: 'C1', userId: 'U1' }, '甲'), '甲');
    assert.equal(speakerName(env.store, { guildId: 'G1', channelId: 'C1', userId: 'U1' }, ''), '未知');
  });

  test('占位卡名（默认卡/未命名）不算「设定」，继续往下回退', () => {
    const env = makeEnv();
    env.store.putSheet('U1', sheet('默认卡'));
    env.store.setBinding('scene', 'C1', 'U1', '默认卡');
    env.store.setNick('G1', 'C1', 'U1', '老王');
    assert.equal(speakerName(env.store, { guildId: 'G1', channelId: 'C1', userId: 'U1' }, '甲'), '老王');
  });

  test('名字被绑到不存在的卡（卡被删）时回退，不会炸', () => {
    const env = makeEnv();
    env.store.setBinding('scene', 'C1', 'U1', '已经不存在的卡');
    assert.equal(speakerName(env.store, { guildId: 'G1', channelId: 'C1', userId: 'U1' }, '甲'), '甲');
  });
});

describe('名字会随设定切换（已写入的行不变）', () => {
  test('中途 /pc rename 之后，新行用新名字、旧行保持旧名字', async () => {
    const env = makeEnv();
    const logId = await openLogOnC1(env);
    env.store.putSheet('U1', sheet('陈寻川'));
    env.store.setBinding('game', '#1', 'U1', '陈寻川');
    const record = createLogRecorder(env.store);

    record(fakeMessage({ content: '第一句' }));
    // 改名：删旧卡、建新卡、改绑定（等价 /pc rename）
    env.store.deleteSheet('U1', '陈寻川');
    env.store.putSheet('U1', sheet('陈寻川·二'));
    env.store.setBinding('game', '#1', 'U1', '陈寻川·二');
    record(fakeMessage({ content: '第二句' }));

    const lines = env.store.logLines(logId);
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? '', /^陈寻川\(U1\) /);
    assert.match(lines[1] ?? '', /^陈寻川·二\(U1\) /);
  });

  test('中途改称呼（/nn）：没有卡时新行跟着换', async () => {
    const env = makeEnv();
    const logId = await openLogOnC1(env);
    const record = createLogRecorder(env.store);

    record(fakeMessage({ content: '第一句' }));
    env.store.setNick('G1', 'C1', 'U1', '老王');
    record(fakeMessage({ content: '第二句' }));

    const lines = env.store.logLines(logId);
    assert.match(lines[0] ?? '', /^甲\(U1\) /, '没设定时用显示名');
    assert.match(lines[1] ?? '', /^老王\(U1\) /, '设定后就切换');
  });

  test('子区里说话时用父频道继承来的卡名', async () => {
    const env = makeEnv();
    const logId = await openLogOnC1(env);
    env.store.putSheet('U1', sheet('陈寻川'));
    env.store.setBinding('scene', 'C1', 'U1', '陈寻川');
    createLogRecorder(env.store)(fakeMessage({ content: '在子区说话', channelId: 'T7', parentChannelId: 'C1' }));
    assert.match(env.store.logLines(logId)[0] ?? '', /^陈寻川\(U1\) /);
  });
});

describe('骰娘那行的名字', () => {
  test('服务器昵称优先，没设回退用户名，都没有用 Dice', () => {
    assert.equal(botSpeakerName('骰娘·阿卡姆', 'Dice!'), '骰娘·阿卡姆');
    assert.equal(botSpeakerName(null, 'Dice!'), 'Dice!');
    assert.equal(botSpeakerName('   ', 'Dice!'), 'Dice!');
    assert.equal(botSpeakerName(null, null), 'Dice');
  });

  test('respond 写日志时用 guild 里的昵称', async () => {
    const env = makeEnv();
    const logId = await openLogOnC1(env);
    const interaction = {
      commandName: 'r',
      channelId: 'C1',
      deferred: false,
      replied: false,
      channel: { isThread: () => false },
      guild: { members: { me: { nickname: '骰娘·阿卡姆' } } },
      client: { user: { id: '9000', username: 'Dice!' } },
      reply: async () => undefined,
      editReply: async () => undefined,
    } as unknown as ChatInputCommandInteraction;

    await respond(interaction, { content: '1d6=4' }, env.deps);
    assert.match(env.store.logLines(logId)[0] ?? '', /^骰娘·阿卡姆\(9000\) /);
  });
});
