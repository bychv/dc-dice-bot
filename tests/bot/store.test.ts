/**
 * `jsonStore` behaviour: CRUD, atomic persistence, log appending and export files.
 * Run: node tests/bot/store.test.ts   (or node scripts/run-tests.ts)
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createJsonStore, createJsonStoreWithExtras, sanitizeFileName } from '../../src/store/jsonStore.ts';
import { formatDiceLogLine } from '../../src/bot/logFormat.ts';
import type { BotStore } from '../../src/contracts/store.ts';
import type { CharacterSheet, GameRecord, LogRecord } from '../../src/contracts/model.ts';

/** 沙箱不允许写系统临时目录（EPERM），测试数据一律放在包内 .tmp/. */
const TMP_ROOT = fileURLToPath(new URL('../.tmp/', import.meta.url));

function tempDir(): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TMP_ROOT, 'dcdice-store-'));
}

function sheet(name: string, overrides: Partial<CharacterSheet> = {}): CharacterSheet {
  return {
    name,
    template: 'COC7',
    attrs: { 力量: '50' },
    exprs: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function game(id: string, guildId = 'G1', overrides: Partial<GameRecord> = {}): GameRecord {
  return {
    id,
    guildId,
    name: `桌${id}`,
    keeperId: 'kp',
    status: 'active',
    sceneThreadId: null,
    parentChannelId: 'C1',
    sceneThreadCreatedByBot: false,
    hiddenThreadId: null,
    rule: null,
    currentLogId: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    ...overrides,
  };
}

function logRecord(id: string, gameId: string | null, channelId: string): LogRecord {
  return {
    id,
    gameId,
    channelId,
    guildId: 'G1',
    name: `日志${id}`,
    state: 'on',
    sceneIds: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    fileName: null,
  };
}

describe('jsonStore: sheets', () => {
  test('put/get/list/delete/clear', () => {
    const store = createJsonStore({ dir: tempDir() });
    assert.deepEqual(store.listSheets('u1'), []);
    assert.equal(store.getSheet('u1', '卡特'), null);

    store.putSheet('u1', sheet('卡特'));
    store.putSheet('u1', sheet('安娜'));
    assert.deepEqual(store.listSheets('u1').map((s) => s.name).sort(), ['卡特', '安娜']);
    assert.equal(store.getSheet('u1', '卡特')?.template, 'COC7');

    assert.equal(store.deleteSheet('u1', '卡特'), true);
    assert.equal(store.deleteSheet('u1', '卡特'), false);
    assert.equal(store.clearSheets('u1'), 1);
    assert.equal(store.clearSheets('u1'), 0);
    assert.deepEqual(store.listSheets('u1'), []);
  });
});

describe('jsonStore: bindings', () => {
  test('scoped get/set/list/clear', () => {
    const store = createJsonStore({ dir: tempDir() });
    store.setBinding('game', '#1', 'u1', '卡特');
    store.setBinding('scene', 'C9', 'u1', '安娜');
    store.setBinding('global', 'G1', 'u1', '默认');

    assert.equal(store.getBinding('game', '#1', 'u1'), '卡特');
    assert.equal(store.getBinding('scene', 'C9', 'u1'), '安娜');
    assert.deepEqual(store.listBindings('game', '#1'), [{ userId: 'u1', sheetName: '卡特' }]);

    // unbinding removes the row
    store.setBinding('scene', 'C9', 'u1', null);
    assert.equal(store.getBinding('scene', 'C9', 'u1'), null);
    assert.deepEqual(store.listBindings('scene', 'C9'), []);

    // clearBindingsFor wipes every scope that uses that key
    store.setBinding('game', '#1', 'u2', 'x');
    store.clearBindingsFor('#1');
    assert.equal(store.getBinding('game', '#1', 'u1'), null);
    assert.equal(store.getBinding('game', '#1', 'u2'), null);
  });
});

describe('jsonStore: games', () => {
  test('nextGameId / findGame / listGames', () => {
    const store = createJsonStore({ dir: tempDir() });
    assert.equal(store.nextGameId('G1'), '#1');
    store.putGame(game('#1'));
    assert.equal(store.nextGameId('G1'), '#2');
    store.putGame(game('#2', 'G1', { name: '奈亚' }));

    assert.equal(store.getGame('G1', '#1')?.id, '#1');
    assert.equal(store.getGame('G2', '#1'), null);
    assert.deepEqual(store.listGames('G1').map((g) => g.id), ['#1', '#2']);

    // findGame accepts #1 / 1 / table name
    assert.equal(store.findGame('G1', '#1')?.id, '#1');
    assert.equal(store.findGame('G1', '1')?.id, '#1');
    assert.equal(store.findGame('G1', '#2')?.name, '奈亚');
    assert.equal(store.findGame('G1', '奈亚')?.id, '#2');
    assert.equal(store.findGame('G1', '不存在'), null);
  });
});

describe('jsonStore: scene pointers', () => {
  test('set/get/list/clear', () => {
    const store = createJsonStore({ dir: tempDir() });
    store.setSceneGame('T1', 'G1', '#1');
    store.setSceneGame('C1', 'G1', '#1');
    store.setSceneGame('T2', 'G1', '#2');

    assert.equal(store.getSceneGame('T1'), '#1');
    assert.deepEqual(store.listScenesOfGame('#1'), ['C1', 'T1']);

    store.setSceneGame('T1', 'G1', null);
    assert.equal(store.getSceneGame('T1'), null);
    assert.deepEqual(store.listScenesOfGame('#1'), ['C1']);

    store.clearScenesOfGame('#1');
    assert.deepEqual(store.listScenesOfGame('#1'), []);
    assert.equal(store.getSceneGame('T2'), '#2');
  });

  test('跨服同名局 id（两个服的 #1）的场景指针互不影响', () => {
    const store = createJsonStore({ dir: tempDir() });
    store.setSceneGame('A1', 'G1', '#1');
    store.setSceneGame('B1', 'G2', '#1');

    // 不带 guildId 的历史口径：两边都能看到
    assert.deepEqual(store.listScenesOfGame('#1'), ['A1', 'B1']);
    // 带 guildId：只看到本服的场景
    assert.deepEqual(store.listScenesOfGame('#1', 'G1'), ['A1']);
    assert.deepEqual(store.listScenesOfGame('#1', 'G2'), ['B1']);

    store.clearScenesOfGame('#1', 'G1');
    assert.equal(store.getSceneGame('A1'), null, '只清本服 #1 的场景指针');
    assert.equal(store.getSceneGame('B1'), '#1', '另一服的 #1 必须保留');
  });
});

describe('jsonStore: rules + registered threads', () => {
  test('game and scene rules are independent; clearing returns null', () => {
    const store = createJsonStore({ dir: tempDir() });
    store.setGameRule('#1', 3);
    store.setSceneRule('C1', 1);

    assert.equal(store.getGameRule('#1'), 3);
    assert.equal(store.getSceneRule('C1'), 1);
    assert.equal(store.getGameRule('#2'), null);

    store.setGameRule('#1', null);
    assert.equal(store.getGameRule('#1'), null);
    assert.equal(store.getSceneRule('C1'), 1);
  });

  test('registered hidden-roll thread', () => {
    const store = createJsonStore({ dir: tempDir() });
    assert.equal(store.getRegisteredThread('C1'), null);
    store.setRegisteredThread('C1', 'H1');
    assert.equal(store.getRegisteredThread('C1'), 'H1');
    store.setRegisteredThread('C1', null);
    assert.equal(store.getRegisteredThread('C1'), null);
  });
});

describe('jsonStore: logs', () => {
  test('nextLogId is unique and monotonic', () => {
    const store = createJsonStore({ dir: tempDir() });
    const a = store.nextLogId();
    const b = store.nextLogId();
    assert.notEqual(a, b);
    store.putLog(logRecord(a, null, 'C1'));
    assert.notEqual(store.nextLogId(), a);
  });

  test('listLogs scopes by game, and by scene when there is no game', () => {
    const store = createJsonStore({ dir: tempDir() });
    store.putLog(logRecord('L1', '#1', 'T1'));
    store.putLog(logRecord('L2', '#2', 'T2'));
    store.putLog(logRecord('L3', null, 'C1'));

    assert.deepEqual(store.listLogs({ gameId: '#1', channelId: 'T1' }).map((l) => l.id), ['L1']);
    assert.deepEqual(store.listLogs({ gameId: '#2', channelId: 'T2' }).map((l) => l.id), ['L2']);
    assert.deepEqual(store.listLogs({ gameId: null, channelId: 'C1' }).map((l) => l.id), ['L3']);
    assert.deepEqual(store.listLogs({ gameId: null, channelId: 'CX' }), []);
  });

  test('appendLogLine writes to the on-logs of the scene game', () => {
    const store = createJsonStoreWithExtras({ dir: tempDir() });
    store.setSceneGame('T1', 'G1', '#1');
    store.putLog(logRecord('L1', '#1', 'T1'));
    store.putLog({ ...logRecord('L2', '#1', 'T1'), state: 'off' });

    store.appendLogLine('T1', '甲: 你好');
    const on = store.getLog('L1');
    assert.deepEqual(store.logLines('L1'), ['甲: 你好']);
    assert.deepEqual(store.logLines('L2'), []);
    assert.deepEqual(on?.sceneIds, ['T1']);

    // a scene with no bound game falls back to scene-level logs
    store.putLog(logRecord('L3', null, 'C1'));
    store.appendLogLine('C1', '乙: 你在哪');
    assert.deepEqual(store.logLines('L3'), ['乙: 你在哪']);

    // unknown scene: nothing happens, no throw
    store.appendLogLine('CX', '丙: ？');
  });

  test('logFilePath writes the export file on demand with a Dice! name/body', () => {
    const store = createJsonStoreWithExtras({ dir: tempDir() });
    const log = logRecord('L1', '#1', 'T1');
    store.putLog(log);
    // 日志按场景隔离：不需要局指针，开日志的那个频道自己的发言就会被记录
    store.appendLogLine('T1', '第一行');
    assert.deepEqual(store.logLines('L1'), ['第一行']);
    // 别的频道不受影响
    store.appendLogLine('T2', '不该出现');
    assert.deepEqual(store.logLines('L1'), ['第一行']);

    store.putGame(game('#1')); // 局名「桌#1」
    store.setSceneGame('T1', 'G1', '#1');
    const line = formatDiceLogLine({
      name: '甲',
      uid: 'U1',
      at: new Date(2026, 0, 2, 3, 4, 5),
      text: '你好',
    });
    store.appendLogLine('T1', line);

    const path = store.logFilePath(log);
    assert.ok(existsSync(path));
    // Dice! `DiceSession::log_new`: `<会话名(局名)>_<日志名>.txt`
    assert.equal(basename(path), '桌#1_日志L1.txt');
    // 行自带 `\n\n`，导出正文原样拼接
    assert.equal(readFileSync(path, 'utf8'), `第一行${line}`);
  });

  test('sanitizeFileName keeps log names usable as file names', () => {
    assert.equal(sanitizeFileName('第一夜/序章'), '第一夜_序章');
    assert.equal(sanitizeFileName('   '), 'log');
  });
});

describe('jsonStore: persistence', () => {
  test('flush + reopen preserves every collection', async () => {
    const dir = tempDir();
    const store = createJsonStore({ dir });
    store.putSheet('u1', sheet('卡特'));
    store.setBinding('scene', 'C1', 'u1', '卡特');
    store.putGame(game('#1'));
    store.setSceneGame('T1', 'G1', '#1');
    store.setGameRule('#1', 4);
    store.setSceneRule('C1', 2);
    store.setRegisteredThread('C1', 'H1');
    store.putLog(logRecord('L1', '#1', 'T1'));
    store.appendLogLine('T1', '甲: hi');
    await store.flush();

    const reopened: BotStore = createJsonStore({ dir });
    assert.equal(reopened.getSheet('u1', '卡特')?.name, '卡特');
    assert.equal(reopened.getBinding('scene', 'C1', 'u1'), '卡特');
    assert.equal(reopened.getGame('G1', '#1')?.name, '桌#1');
    assert.equal(reopened.getSceneGame('T1'), '#1');
    assert.equal(reopened.getGameRule('#1'), 4);
    assert.equal(reopened.getSceneRule('C1'), 2);
    assert.equal(reopened.getRegisteredThread('C1'), 'H1');
    assert.deepEqual(reopened.listLogs({ gameId: '#1', channelId: 'T1' }).map((l) => l.id), ['L1']);
  });

  test('writes are atomic: tmp+rename leaves no .tmp behind', async () => {
    const dir = tempDir();
    const store = createJsonStore({ dir });
    store.putSheet('u1', sheet('卡特'));
    await store.flush();

    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
    assert.deepEqual(readdirSync(dir).sort(), ['sheets.json']);
  });

  test('a corrupted file degrades to an empty collection instead of throwing', async () => {
    const dir = tempDir();
    const first = createJsonStore({ dir });
    first.putSheet('u1', sheet('卡特'));
    await first.flush();

    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'sheets.json'), '{ not json', 'utf8');

    const reopened = createJsonStore({ dir });
    assert.deepEqual(reopened.listSheets('u1'), []);
  });
});

describe('jsonStore: extras (称呼 / 默认规则集)', () => {
  test('nicknames are channel- and global-scoped, clearNicks removes all rows', async () => {
    const dir = tempDir();
    const store = createJsonStoreWithExtras({ dir });
    store.setNick('G1', 'C1', 'u1', 'kp');
    store.setGlobalNick('G1', 'u1', '全局称呼');
    assert.equal(store.getNick('G1', 'C1', 'u1'), 'kp');
    assert.equal(store.getNick('G1', 'C2', 'u1'), null);
    assert.equal(store.getGlobalNick('G1', 'u1'), '全局称呼');

    await store.flush();
    const reopened = createJsonStoreWithExtras({ dir });
    assert.equal(reopened.getNick('G1', 'C1', 'u1'), 'kp');

    assert.equal(reopened.clearNicks('u1'), 2);
    assert.equal(reopened.getNick('G1', 'C1', 'u1'), null);
  });

  test('default rule set round-trips', async () => {
    const dir = tempDir();
    const store = createJsonStoreWithExtras({ dir });
    assert.equal(store.getDefaultRuleSet('G1'), null);
    store.setDefaultRuleSet('G1', 'coc7');
    await store.flush();
    const reopened = createJsonStoreWithExtras({ dir });
    assert.equal(reopened.getDefaultRuleSet('G1'), 'coc7');
    reopened.setDefaultRuleSet('G1', null);
    assert.equal(reopened.getDefaultRuleSet('G1'), null);
  });
});

test('cleanup temp dirs', () => {
  // nothing to assert: keeps the helper imported in one place
  const dir = tempDir();
  rmSync(dir, { recursive: true, force: true });
  assert.equal(existsSync(dir), false);
});
