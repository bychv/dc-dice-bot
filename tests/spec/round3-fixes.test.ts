/**
 * Lead 回归测试：锁住 round-3 独立验证（verifier2 / task-8）发现的三个真问题。
 *  A) 按钮确认/取消的结果也要按 Dice! 格式入日志（handleButtonInteraction 绕过 respond）
 *  B) 两条日志名只有非法字符不同时，导出文件名必须去重，不能互相覆盖
 *  C) Dice! `dict_ci` 大小写不敏感：外部词库的大小写变体要顶掉内置同名键
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import { handleButtonInteraction } from '../../src/bot/adapter.ts';
import { askConfirm, createPendingActions } from '../../src/bot/confirm.ts';
import { createLibrary } from '../../src/bot/library/library.ts';
import type { ButtonInteraction } from 'discord.js';
import { createJsonStore } from '../../src/store/jsonStore.ts';
import type { HandlerDeps } from '../../src/contracts/bot.ts';
import type { GameRecord, LogRecord } from '../../src/contracts/model.ts';

const TMP_ROOT = fileURLToPath(new URL('../.tmp/', import.meta.url));

/** `logLines` 是 jsonStore 的额外方法（不在冻结的 BotStore 契约里），测试里显式声明。 */
type StoreWithLines = ReturnType<typeof createJsonStore> & { logLines(id: string): string[] };
const asStoreWithLines = (store: ReturnType<typeof createJsonStore>): StoreWithLines =>
  store as StoreWithLines;

function tempDir(prefix: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TMP_ROOT, prefix));
}

// ---------------------------------------------------------------------------
// A) 按钮结果入日志
// ---------------------------------------------------------------------------

describe('A) 按钮确认结果入日志', () => {
  test('handleButtonInteraction 把最终回执按 Dice! 格式写进 on 日志', async () => {
    const dir = tempDir('dcdice-btn-');
    try {
      const store = createJsonStore({ dir });
      store.putGame({
        id: '#1',
        guildId: 'G1',
        name: '阿卡姆',
        keeperId: 'KP1',
        status: 'active',
        sceneThreadId: null,
        parentChannelId: 'C1',
        sceneThreadCreatedByBot: false,
        hiddenThreadId: null,
        rule: null,
        currentLogId: 'L1',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: null,
      } satisfies GameRecord);
      store.setSceneGame('C1', 'G1', '#1');
      store.putLog({
        id: 'L1',
        gameId: '#1',
        channelId: 'C1',
        guildId: 'G1',
        name: '第一夜',
        state: 'on',
        sceneIds: ['C1'],
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: null,
        fileName: null,
      } satisfies LogRecord);

      const deps = {
        store,
        confirmations: createPendingActions(),
        now: () => new Date(2026, 0, 2, 3, 4, 5),
      } as unknown as HandlerDeps;

      // 登记一个确认动作，拿到按钮上的 custom_id
      const prompt = askConfirm(deps, { userId: 'U1' } as never, {
        summary: '⚠️ 危险操作：即将销毁 1 张角色卡',
        onConfirm: async () => ({ content: '✅ 已销毁 1 张角色卡。' }),
      });
      const confirmId = prompt.components?.[0]?.components?.[0]?.custom_id ?? '';
      assert.match(confirmId, /^confirm:/);

      const updates: { content: string }[] = [];
      const interaction = {
        customId: confirmId,
        user: { id: 'U1' },
        channelId: 'C1',
        client: { user: { id: 'BOT1', username: 'Dice' } },
        update: async (options: { content: string }) => {
          updates.push(options);
        },
        followUp: async () => undefined,
      } as unknown as ButtonInteraction;

      await handleButtonInteraction(interaction, deps);

      assert.equal(updates.length, 1);
      const lines = asStoreWithLines(store).logLines('L1');
      assert.equal(lines.length, 1, `按钮结果应入日志，实际 ${JSON.stringify(lines)}`);
      assert.match(lines[0] ?? '', /^Dice\(BOT1\) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n✅ 已销毁 1 张角色卡。\n\n$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// B) 导出文件名去重
// ---------------------------------------------------------------------------

describe('B) 导出文件名去重', () => {
  test('只有非法字符不同的两条日志不会映射到同一个文件', () => {
    const dir = tempDir('dcdice-name-');
    try {
      const store = createJsonStore({ dir });
      store.putGame({
        id: '#1',
        guildId: 'G1',
        name: '阿卡姆',
        keeperId: 'KP1',
        status: 'active',
        sceneThreadId: null,
        parentChannelId: 'C1',
        sceneThreadCreatedByBot: false,
        hiddenThreadId: null,
        rule: null,
        currentLogId: null,
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: null,
      } satisfies GameRecord);
      // 场景指针必须存在，appendLogLine 才会把这条场景的消息投进局日志
      store.setSceneGame('C1', 'G1', '#1');

      const makeLog = (id: string, name: string): LogRecord => ({
        id,
        gameId: '#1',
        channelId: 'C1',
        guildId: 'G1',
        name,
        state: 'on',
        sceneIds: ['C1'],
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: null,
        fileName: null,
      });

      const first = makeLog('L1', '第一/夜');
      const second = makeLog('L2', '第一_夜');
      store.putLog(first);
      store.putLog(second);
      store.appendLogLine('C1', 'L1 的内容');

      const pathA = store.logFilePath(first);
      const pathB = store.logFilePath(second);
      assert.notEqual(pathA, pathB, '两个日志不能导出到同一个文件');
      assert.equal(readFileSync(pathA, 'utf8'), 'L1 的内容');
      assert.equal(readFileSync(pathB, 'utf8'), 'L1 的内容');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// C) 外部词库大小写变体覆盖内置
// ---------------------------------------------------------------------------

describe('C) 词库大小写不敏感（dict_ci 语义）', () => {
  test('外部 {"R": ...} 顶掉内置 r，且 stats 口径一致', () => {
    const dir = tempDir('dcdice-lib-');
    try {
      writeFileSync(
        join(dir, 'override.json'),
        JSON.stringify({
          entries: { R: '外部覆盖的 r' },
          messages: { strhlpmsg: '外部总览' },
        }),
        'utf8',
      );

      const builtin = createLibrary();
      const overridden = createLibrary({ dir });

      assert.notEqual(builtin.lookup('r')?.text, '外部覆盖的 r');
      assert.equal(overridden.lookup('r')?.text, '外部覆盖的 r');
      assert.equal(overridden.lookup('R')?.text, '外部覆盖的 r', '大小写变体应指向同一条');
      assert.equal(overridden.overview(), '外部总览');

      const stats = overridden.stats();
      assert.equal(stats.external, true);
      // 外部只顶掉两个键，条目总数不应因为大小写变体而膨胀
      assert.equal(stats.terms, builtin.stats().terms, '大小写变体不应新增 term');
      assert.equal(stats.entries, builtin.stats().entries, '外部覆盖同名键不改变条目数');
      assert.equal(stats.discord, builtin.stats().discord);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
