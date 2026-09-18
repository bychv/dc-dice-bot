/**
 * Adapter behaviour that is testable without a gateway connection: option reading, context
 * conversion, log recording. Run: node tests/bot/adapter.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, type ChatInputCommandInteraction, type Message } from 'discord.js';

import { createLogRecorder, toInteractionContext } from '../../src/bot/adapter.ts';
import { route } from '../../src/bot/router.ts';
import { makeContext, makeEnv, type TestEnv } from './fakes.ts';

interface FakeInteractionSpec {
  guildId?: string | null;
  channelId?: string;
  thread?: boolean;
  parentId?: string | null;
  channelName?: string;
  userId?: string;
  displayName?: string;
  admin?: boolean;
  subcommand?: string | null;
  group?: string | null;
  data?: unknown[];
}

function fakeInteraction(spec: FakeInteractionSpec = {}): ChatInputCommandInteraction {
  const permissions = new PermissionsBitField(
    spec.admin ? [PermissionsBitField.Flags.Administrator] : [],
  );
  return {
    commandName: 'game',
    guildId: spec.guildId === undefined ? 'G1' : spec.guildId,
    channelId: spec.channelId ?? 'C1',
    channel: spec.thread
      ? { isThread: () => true, parentId: spec.parentId ?? 'C1', name: spec.channelName ?? '阿卡姆' }
      : { isThread: () => false, name: spec.channelName ?? '跑团' },
    member: { displayName: spec.displayName ?? '甲', permissions },
    user: { id: spec.userId ?? 'U1', username: 'u1' },
    options: {
      data: spec.data ?? [],
      getSubcommand: () => spec.subcommand ?? null,
      getSubcommandGroup: () => spec.group ?? null,
    },
  } as unknown as ChatInputCommandInteraction;
}

describe('toInteractionContext', () => {
  test('channel vs thread, display name, admin detection', async () => {
    const plain = await toInteractionContext(fakeInteraction({ admin: true }));
    assert.equal(plain.guildId, 'G1');
    assert.equal(plain.channelId, 'C1');
    assert.equal(plain.parentChannelId, null);
    assert.equal(plain.channelName, '跑团');
    assert.equal(plain.isAdmin, true);
    assert.equal(plain.displayName, '甲');

    const threaded = await toInteractionContext(
      fakeInteraction({ thread: true, channelId: 'T1', channelName: '阿卡姆' }),
    );
    assert.equal(threaded.parentChannelId, 'C1');
    assert.equal(threaded.channelName, '阿卡姆');
    assert.equal(threaded.isAdmin, false);

    const dm = await toInteractionContext(fakeInteraction({ guildId: null }));
    assert.equal(dm.guildId, null);
  });

  test('reads nested subcommand options and the flat top level', async () => {
    const interaction = fakeInteraction({
      subcommand: 'start',
      data: [
        {
          name: 'start',
          type: 1,
          options: [
            { name: 'name', type: 3, value: '阿卡姆' },
            { name: 'keeper', type: 6, user: { id: 'KP1' } },
            { name: 'here', type: 5, value: true },
            { name: 'thread', type: 7, channel: { id: 'T9' } },
          ],
        },
      ],
    });
    const ctx = await toInteractionContext(interaction);
    assert.equal(ctx.options.subcommand(), 'start');
    assert.equal(ctx.options.string('name'), '阿卡姆');
    assert.equal(ctx.options.user('keeper'), 'KP1');
    assert.equal(ctx.options.boolean('here'), true);
    assert.equal(ctx.options.channel('thread'), 'T9');
    assert.equal(ctx.options.sub()?.string('name'), '阿卡姆');
    assert.equal(ctx.options.integer('name'), null);
  });

  test('adapter context drives the handlers end to end', async () => {
    const env = makeEnv();
    const ctx = await toInteractionContext(
      fakeInteraction({
        subcommand: 'start',
        data: [{ name: 'start', type: 1, options: [{ name: 'name', type: 3, value: '阿卡姆' }] }],
      }),
    );
    const reply = await route(ctx, env.deps);
    assert.notEqual(reply.ephemeral, true);
    const game = env.store.getGame('G1', '#1')!;
    assert.equal(game.name, '阿卡姆');
    assert.equal(game.keeperId, 'U1', 'the caller defaults to KP');
    assert.ok(game.sceneThreadId);
  });
});

describe('createLogRecorder', () => {
  function fakeMessage(env: TestEnv, overrides: { bot?: boolean; content?: string; channelId?: string; attachments?: number; threadParentId?: string } = {}): Message {
    const attachments = new Map<string, { name: string }>();
    for (let i = 0; i < (overrides.attachments ?? 0); i += 1) {
      attachments.set(String(i), { name: `file${i}.png` });
    }
    const threadParentId = overrides.threadParentId ?? null;
    return {
      author: { bot: overrides.bot ?? false, username: '甲', id: 'U1' },
      member: { displayName: '甲' },
      channelId: overrides.channelId ?? 'C1',
      content: overrides.content ?? '我们进入地窖',
      attachments: { size: attachments.size, values: () => attachments.values() },
      channel: { isThread: (): boolean => threadParentId !== null, parentId: threadParentId },
      client: env,
    } as unknown as Message;
  }

  /** Dice! 行格式：`<名字>(<uid>) <YYYY-MM-DD HH:MM:SS>\n<内容>\n\n`（见 src/bot/logFormat.ts） */
  const diceLine = (text: string): RegExp =>
    new RegExp(`^甲\\(U1\\) \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\n${text}\\n\\n$`);

  test('appends human messages to the active log of the scene', async () => {
    const env = makeEnv();
    await route(
      makeContext({ command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'KP1', values: { name: '阿卡姆', keeper: 'KP1', here: true } }, env.platform),
      env.deps,
    );
    const log = env.store.listLogs({ gameId: '#1', channelId: 'C1' })[0];
    const record = createLogRecorder(env.store);

    record(fakeMessage(env));
    record(fakeMessage(env, { content: '（这是 KP 的暗骰记录）' }));
    const lines = env.store.logLines(log.id);
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? '', diceLine('我们进入地窖'));
    assert.match(lines[1] ?? '', diceLine('（这是 KP 的暗骰记录）'));

    record(fakeMessage(env, { bot: true, content: '我是骰娘' }));
    assert.equal(env.store.logLines(log.id).length, 2, 'bot messages are not logged');

    record(fakeMessage(env, { channelId: 'CX' }));
    assert.equal(env.store.logLines(log.id).length, 2, 'other scenes are not logged');
  });

  test('records attachments and ignores empty messages', async () => {    const env = makeEnv();
    await route(
      makeContext({ command: 'log', sub: 'new', channelId: 'C1', userId: 'U1', values: { name: '第一夜' } }, env.platform),
      env.deps,
    );
    const log = env.store.listLogs({ gameId: '#1', channelId: 'C1' })[0];
    const record = createLogRecorder(env.store);
    record(fakeMessage(env, { content: '', attachments: 2 }));
    assert.equal(env.store.logLines(log.id).length, 1);
    assert.match(env.store.logLines(log.id)[0] ?? '', diceLine('\\[附件 file0\\.png\\] \\[附件 file1\\.png\\]'));
  });

  test('a paused log receives nothing', async () => {
    const env = makeEnv();
    await route(
      makeContext({ command: 'log', sub: 'new', channelId: 'C1', userId: 'U1', values: { name: '第一夜' } }, env.platform),
      env.deps,
    );
    const log = env.store.listLogs({ gameId: '#1', channelId: 'C1' })[0];
    await route(makeContext({ command: 'log', sub: 'off', channelId: 'C1', userId: 'U1' }, env.platform), env.deps);
    createLogRecorder(env.store)(fakeMessage(env));
    assert.deepEqual(env.store.logLines(log.id), []);
  });
});
