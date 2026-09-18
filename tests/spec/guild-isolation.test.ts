/**
 * Lead-owned regression test: 局 id (`#1`) 只在服务器内唯一，跨服必须隔离
 * (docs §10.1 多局并存 / §16.11 数据模型). 这是 T3 报告里指出的契约缺口，已用可选 guildId 修好。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createJsonStore } from '../../src/store/jsonStore.ts';
import type { LogRecord } from '../../src/contracts/model.ts';

const TMP_ROOT = fileURLToPath(new URL('../.tmp/', import.meta.url));

function tempDir(): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TMP_ROOT, 'dcdice-guild-'));
}

function logRecord(id: string, gameId: string, guildId: string, channelId: string): LogRecord {
  return {
    id,
    gameId,
    channelId,
    guildId,
    name: id,
    state: 'on',
    sceneIds: [channelId],
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    fileName: null,
  };
}

describe('跨服隔离', () => {
  test('同一 `#1` 在两个服务器里的房规互不影响', () => {
    const dir = tempDir();
    try {
      const store = createJsonStore({ dir });
      store.setGameRule('#1', 3, 'G1');
      store.setGameRule('#1', 5, 'G2');

      assert.equal(store.getGameRule('#1', 'G1'), 3);
      assert.equal(store.getGameRule('#1', 'G2'), 5);
      // 清掉其中一个不影响另一个
      store.setGameRule('#1', null, 'G2');
      assert.equal(store.getGameRule('#1', 'G2'), null);
      assert.equal(store.getGameRule('#1', 'G1'), 3);
      // 历史键（不带 guildId）仍然可用
      store.setGameRule('#9', 2);
      assert.equal(store.getGameRule('#9'), 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('同一 `#1` 的局日志在两个服务器里互不串', () => {
    const dir = tempDir();
    try {
      const store = createJsonStore({ dir });
      store.putLog(logRecord('L1', '#1', 'G1', 'C1'));
      store.putLog(logRecord('L2', '#1', 'G2', 'C2'));

      assert.deepEqual(
        store.listLogs({ gameId: '#1', channelId: '', guildId: 'G1' }).map((l) => l.id),
        ['L1'],
      );
      assert.deepEqual(
        store.listLogs({ gameId: '#1', channelId: '', guildId: 'G2' }).map((l) => l.id),
        ['L2'],
      );
      // 不带 guildId 时保持旧行为（看到全部），避免破坏既有调用
      assert.deepEqual(
        store.listLogs({ gameId: '#1', channelId: '' }).map((l) => l.id).sort(),
        ['L1', 'L2'],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('场景日志按 channelId 隔离（无局场景）', () => {
    const dir = tempDir();
    try {
      const store = createJsonStore({ dir });
      const sceneLog: LogRecord = { ...logRecord('S1', '', '', 'C1'), gameId: null };
      store.putLog(sceneLog);
      assert.deepEqual(
        store.listLogs({ gameId: null, channelId: 'C1' }).map((l) => l.id),
        ['S1'],
      );
      assert.deepEqual(store.listLogs({ gameId: null, channelId: 'C2' }), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
