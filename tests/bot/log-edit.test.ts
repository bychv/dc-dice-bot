/**
 * 编辑跟随（docs §11.1）：玩家改消息 → 日志里那一行原地改成新正文。
 *
 * 覆盖：recorder 记索引、editor 原地替换（行数/时间戳/行序不变）、
 * 预览类 `MessageUpdate`（正文没变）不重复写、partial 消息先 fetch、
 * 未记录的消息/bot 消息无动作、`off` 期间照改、`ended` 日志不改、索引落盘可重启定位。
 *
 * Run: node tests/bot/log-edit.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLogEditor, createLogRecorder } from '../../src/bot/adapter.ts';
import { route } from '../../src/bot/router.ts';
import type { LogRecord } from '../../src/contracts/model.ts';
import { createJsonStoreWithExtras } from '../../src/store/jsonStore.ts';
import { makeContext, makeEnv, type TestEnv } from './fakes.ts';

const UID = '100000000000000001';

const TMP_ROOT = fileURLToPath(new URL('../.tmp/', import.meta.url));

function sheet(name: string) {
  return {
    name,
    template: 'COC7',
    attrs: {},
    exprs: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** 造一条"玩家消息"的最小形状（recorder 只用到这些字段）。 */
function msg(content: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'M1',
    content,
    channelId: 'C1',
    guildId: 'G1',
    author: { id: UID, username: '甲', bot: false },
    member: { displayName: '甲' },
    channel: { isThread: () => false, parentId: null },
    attachments: { size: 0, values: () => [] },
    partial: false,
    ...overrides,
  };
}

const linesOf = (env: TestEnv, logId: string): string[] => env.store.lines.get(logId) ?? [];

/** 起一条正在记录的日志（无局场景日志即可）。 */
async function startLog(env: TestEnv): Promise<LogRecord> {
  await route(
    makeContext({ command: 'log', sub: 'new', channelId: 'C1', userId: UID, values: { name: '第一天' } }, env.platform),
    env.deps,
  );
  return env.store.listSceneLogs('C1', 'G1')[0]!;
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('编辑跟随：日志行原地更新', () => {
  test('编辑后仍是 1 行，正文变新、时间戳与行序不变', async () => {
    const env = makeEnv();
    env.store.putSheet(UID, sheet('陈寻川'));
    env.store.setBinding('scene', 'C1', UID, '陈寻川');
    const log = await startLog(env);

    const record = createLogRecorder(env.store);
    const edit = createLogEditor(env.store);
    const original = msg('我推开门');
    record(original as never);
    const before = linesOf(env, log.id);
    assert.equal(before.length, 1);
    assert.match(before[0]!, /^陈寻川\(100000000000000001\) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n我推开门\n\n$/);
    const header = before[0]!.slice(0, before[0]!.indexOf('\n'));

    edit(original as never, { ...original, content: '我小心翼翼地推开门' } as never);
    await flush();

    const after = linesOf(env, log.id);
    assert.equal(after.length, 1, '不能变成两行');
    assert.equal(after[0]!.slice(0, after[0]!.indexOf('\n')), header, '时间戳与名字必须保持不变');
    assert.equal(after[0], `${header}\n我小心翼翼地推开门\n\n`);
  });

  test('同一条消息连续编辑两次：仍只有 1 行，且是最新文本', async () => {
    const env = makeEnv();
    const log = await startLog(env);
    const record = createLogRecorder(env.store);
    const edit = createLogEditor(env.store);

    const first = msg('初稿');
    record(first as never);
    edit(first as never, { ...first, content: '二稿' } as never);
    await flush();
    edit(first as never, { ...first, content: '三稿' } as never);
    await flush();

    const lines = linesOf(env, log.id);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /\n三稿\n\n$/);
    assert.doesNotMatch(lines[0]!, /初稿|二稿/);
  });

  test('预览类事件（正文未变）不新增行、不改动', async () => {
    const env = makeEnv();
    const log = await startLog(env);
    const record = createLogRecorder(env.store);
    const edit = createLogEditor(env.store);

    const original = msg('看这个 https://example.com');
    record(original as never);
    const before = [...linesOf(env, log.id)];

    // Discord 在链接预览/embed 展开时会派发 messageUpdate，正文相同
    edit(original as never, { ...original } as never);
    await flush();

    assert.deepEqual(linesOf(env, log.id), before);
  });

  test('partial 消息：先 fetch 再改（fetch 失败则安静放弃）', async () => {
    const env = makeEnv();
    const log = await startLog(env);
    const record = createLogRecorder(env.store);
    const edit = createLogEditor(env.store);

    const original = msg('原文');
    record(original as never);

    const fetched = { ...original, content: '抓取后的新文', partial: false };
    const partialNew = {
      ...original,
      id: original.id,
      content: null,
      partial: true,
      fetch: async () => fetched,
    };
    edit(original as never, partialNew as never);
    await flush();
    assert.match(linesOf(env, log.id)[0]!, /\n抓取后的新文\n\n$/);

    // fetch 抛错：不崩、不改
    const broken = { ...original, content: null, partial: true, fetch: async () => { throw new Error('nope'); } };
    edit(fetched as never, broken as never);
    await flush();
    assert.match(linesOf(env, log.id)[0]!, /\n抓取后的新文\n\n$/);
  });

  test('没被记录过的消息、bot 消息：都没有动作', async () => {
    const env = makeEnv();
    const log = await startLog(env);
    const edit = createLogEditor(env.store);

    edit(msg('从未记录') as never, msg('从未记录', { id: 'M404' }) as never);
    await flush();
    assert.equal(linesOf(env, log.id).length, 0);

    const bot = msg('我是骰娘', { author: { id: 'B1', username: 'Dice', bot: true } });
    edit(bot as never, { ...bot, content: '改过的骰娘' } as never);
    await flush();
    assert.equal(linesOf(env, log.id).length, 0);
  });

  test('日志 off 期间也跟随编辑（续记后导出的就是新文本）', async () => {
    const env = makeEnv();
    const log = await startLog(env);
    const record = createLogRecorder(env.store);
    const edit = createLogEditor(env.store);

    const original = msg('暂停前的话');
    record(original as never);
    await route(
      makeContext({ command: 'log', sub: 'off', channelId: 'C1', userId: UID }, env.platform),
      env.deps,
    );
    edit(original as never, { ...original, content: '暂停后改的' } as never);
    await flush();

    assert.match(linesOf(env, log.id)[0]!, /\n暂停后改的\n\n$/);
  });

  test('已 ended 的日志不改（已导出的存档要保持一致）', async () => {
    const env = makeEnv();
    const log = await startLog(env);
    const record = createLogRecorder(env.store);
    const edit = createLogEditor(env.store);

    const original = msg('结束前的话');
    record(original as never);
    await route(
      makeContext({ command: 'log', sub: 'end', channelId: 'C1', userId: UID }, env.platform),
      env.deps,
    );
    assert.equal(env.store.getLog(log.id)!.state, 'ended');

    edit(original as never, { ...original, content: '结束后改的' } as never);
    await flush();
    assert.match(linesOf(env, log.id)[0]!, /\n结束前的话\n\n$/);
  });

  test('子区消息回投父频道时，编辑也回投父频道', async () => {
    const env = makeEnv();
    await route(
      makeContext({ command: 'log', sub: 'new', channelId: 'C1', userId: UID, values: { name: '父频道日志' } }, env.platform),
      env.deps,
    );
    const log = env.store.listSceneLogs('C1', 'G1')[0]!;

    const record = createLogRecorder(env.store);
    const edit = createLogEditor(env.store);
    const inThread = msg('子区里说的', {
      channelId: 'T9',
      channel: { isThread: () => true, parentId: 'C1' },
    });
    record(inThread as never);
    assert.equal(linesOf(env, log.id).length, 1, '子区消息应回投到父频道的日志');

    edit(inThread as never, { ...inThread, content: '子区里改过的话' } as never);
    await flush();
    assert.match(linesOf(env, log.id)[0]!, /\n子区里改过的话\n\n$/);
  });
});

describe('索引落盘（真实 jsonStore）', () => {
  test('重启后仍能按消息 id 定位并改写', async () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    const dir = mkdtempSync(join(TMP_ROOT, 'log-edit-'));

    const store1 = createJsonStoreWithExtras({ dir });
    const game = { guildId: 'G1', channelId: 'C1', parentChannelId: null, userId: UID };
    // 直接造一条 on 日志（避免依赖路由）
    store1.putLog({
      id: 'L1',
      gameId: null,
      channelId: 'C1',
      guildId: 'G1',
      name: '第一天',
      state: 'on',
      sceneIds: ['C1'],
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
      fileName: null,
    } as LogRecord);
    store1.appendLogLineForMessage('C1', 'M1', `甲(${UID}) 2026-01-01 00:00:00\n原文\n\n`);
    await store1.flush();
    void game;

    // 落盘里确实有索引
    const raw = JSON.parse(readFileSync(join(dir, 'logs.json'), 'utf8'));
    assert.equal(raw.msgIndex.L1.M1, 0, 'msgIndex 必须与 lines 一起落盘');

    // 模拟重启：新实例读同一目录
    const store2 = createJsonStoreWithExtras({ dir });
    const updated = store2.replaceLogLineForMessage('C1', 'M1', '重启后改的');
    assert.equal(updated, 1);
    assert.match(store2.logLines('L1')[0]!, /\n重启后改的\n\n$/);
  });

  test('索引漂移（行被手工改坏）时跳过而不是盲写', async () => {
    const dir = mkdtempSync(join(TMP_ROOT, 'log-edit-drift-'));
    const store = createJsonStoreWithExtras({ dir });
    store.putLog({
      id: 'L1',
      gameId: null,
      channelId: 'C1',
      guildId: 'G1',
      name: 'x',
      state: 'on',
      sceneIds: ['C1'],
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
      fileName: null,
    } as LogRecord);
    store.appendLogLineForMessage('C1', 'M1', `甲(${UID}) 2026-01-01 00:00:00\n原文\n\n`);
    await store.flush();

    // 模拟有人手工把那一行改成了不符合行格式的内容（索引因此指向"不是日志行"的位置）
    const file = join(dir, 'logs.json');
    const db = JSON.parse(readFileSync(file, 'utf8'));
    db.lines.L1[0] = '被人手改坏了';
    writeFileSync(file, JSON.stringify(db), 'utf8');

    const restarted = createJsonStoreWithExtras({ dir });
    assert.equal(restarted.replaceLogLineForMessage('C1', 'M1', '不该写进去'), 0, '形态不符必须跳过');
    assert.equal(restarted.logLines('L1')[0], '被人手改坏了', '坏行保持原样，不被盲写覆盖');
  });
});
