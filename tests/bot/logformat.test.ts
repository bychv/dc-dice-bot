/**
 * Dice! 日志格式与命名（`src/bot/logFormat.ts` + `src/store/jsonStore.ts` 导出）。
 *
 * 断言逐字符对照 `ref/Dice/Dice/DiceEvent.cpp:188/222/239`、`DiceSchedule.cpp:319`（printTTime）、
 * `DiceSession.cpp:30`（LogInfo::append）、`DiceSession.cpp:200`（log_new 文件名）。
 *
 * Run: node tests/bot/logformat.test.ts   (or node scripts/run-tests.ts)
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { HandlerDeps } from '../../src/contracts/bot.ts';
import type { GameRecord, LogRecord } from '../../src/contracts/model.ts';
import { exportLogRecord } from '../../src/bot/handlers/gameCore.ts';
import {
  appendBotReplyLine,
  appendUserLogLine,
  diceLogFileName,
  diceLogSessionName,
  formatDiceLogLine,
  formatDiceTimestamp,
} from '../../src/bot/logFormat.ts';
import { createJsonStore, createJsonStoreWithExtras } from '../../src/store/jsonStore.ts';

/** 沙箱不允许写系统临时目录（EPERM），测试数据一律放在包内 .tmp/. */
const TMP_ROOT = fileURLToPath(new URL('../.tmp/', import.meta.url));

function tempDir(): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TMP_ROOT, 'dcdice-logformat-'));
}

function game(name: string, id = '#1', guildId = 'G1'): GameRecord {
  return {
    id,
    guildId,
    name,
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
  };
}

function logRecord(
  name: string,
  gameId: string | null,
  channelId = 'T1',
  overrides: Partial<LogRecord> = {},
): LogRecord {
  return {
    id: 'L1',
    gameId,
    channelId,
    guildId: 'G1',
    name,
    state: 'on',
    sceneIds: [channelId],
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    fileName: null,
    ...overrides,
  };
}

describe('Dice! 日志行格式', () => {
  test('时间 = 本地时间 + 零填充（printTTime 的 strftime "%Y-%m-%d %H:%M:%S"）', () => {
    // 用本地分量构造 Date：断言与时区无关，且 getFullYear/getH… 读的就是本地时间
    const at = new Date(2026, 0, 2, 3, 4, 5);
    assert.equal(formatDiceTimestamp(at), '2026-01-02 03:04:05');

    // 本地时间语义：逐字段等于本地 getter（不是 UTC / toISOString）
    const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
    assert.equal(
      formatDiceTimestamp(at),
      `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`,
    );

    // 零填充边界：个位/双位数都必须是 2 位
    assert.equal(formatDiceTimestamp(new Date(2026, 10, 20, 9, 8, 7)), '2026-11-20 09:08:07');
    assert.equal(formatDiceTimestamp(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31 23:59:59');
  });

  test('玩家消息：`<名字>(<uid>) <时间>\\n<正文>\\n\\n` 逐字符一致（DiceEvent.cpp:239 fwdMsg）', () => {
    const line = formatDiceLogLine({
      name: '甲',
      uid: 'U1',
      at: new Date(2026, 2, 9, 4, 5, 6),
      text: '我们进入地窖',
    });
    assert.equal(line, '甲(U1) 2026-03-09 04:05:06\n我们进入地窖\n\n');
  });

  test('骰娘回执同格式（DiceEvent.cpp:222 logEcho / :188 replyHidden）', () => {
    const line = formatDiceLogLine({
      name: '骰娘',
      uid: '9000',
      at: new Date(2026, 2, 9, 4, 5, 7),
      text: '甲 进行 侦查 检定：D100=42/60 成功',
    });
    assert.equal(line, '骰娘(9000) 2026-03-09 04:05:07\n甲 进行 侦查 检定：D100=42/60 成功\n\n');
  });

  test('正文原样写入：不裁剪、不转义、内部换行保留', () => {
    const line = formatDiceLogLine({
      name: 'A',
      uid: '2',
      at: new Date(2026, 0, 1, 0, 0, 0),
      text: ' 多行\n内容 ',
    });
    assert.equal(line, 'A(2) 2026-01-01 00:00:00\n 多行\n内容 \n\n');
  });
});

describe('Dice! 导出文件名', () => {
  test('`<会话名>_<日志名>.txt`（DiceSession.cpp:200）', () => {
    assert.equal(diceLogFileName('阿卡姆', '第一夜'), '阿卡姆_第一夜.txt');
  });

  test('非法文件名字符替换为 `_`（/、\\、: 等）', () => {
    assert.equal(diceLogFileName('第一夜/序章', 'log:1'), '第一夜_序章_log_1.txt');
    assert.equal(diceLogFileName('a\\b:c*d?e"f<g>h|i', 'x'), 'a_b_c_d_e_f_g_h_i_x.txt');
    assert.equal(diceLogFileName('a\u0000b', 'c\u001fd'), 'a_b_c_d.txt');
  });

  test('空白折叠并去掉首尾空白/尾点', () => {
    assert.equal(diceLogFileName('  阿  卡姆  ', ' x '), '阿 卡姆_x.txt');
    assert.equal(diceLogFileName('桌名. ', 'log..'), '桌名_log.txt');
  });

  test('空值回退 `session` / `log`', () => {
    assert.equal(diceLogFileName('', ''), 'session_log.txt');
    assert.equal(diceLogFileName('   ', '\u0000'), 'session_log.txt');
  });

  test('超长按 UTF-8 字节截断，且不切开多字节/代理对字符', () => {
    const cjk = '甲'.repeat(200);
    const cjkName = diceLogFileName(cjk, cjk);
    const [cjkSession, cjkLog] = cjkName.replace(/\.txt$/, '').split('_');
    assert.equal(Buffer.byteLength(cjkSession, 'utf8'), 78, '80 字节上限内最多 26 个 3 字节汉字');
    assert.equal(Array.from(cjkSession).length, 26);
    assert.equal(Buffer.byteLength(cjkLog, 'utf8'), 78);
    assert.ok(Buffer.byteLength(cjkName, 'utf8') < 255, '单个文件名必须远低于 ext4 的 255 字节上限');

    const astral = '𝔻'.repeat(30); // 每个 4 字节
    const astralName = diceLogFileName(astral, astral);
    const part = astralName.slice(0, astralName.indexOf('_'));
    assert.equal(Buffer.byteLength(part, 'utf8'), 80);
    assert.equal(Array.from(part).length, 20, '代理对应完整，不出现半个字符');
    assert.ok(astralName.endsWith('.txt'));
  });
});

describe('Dice! 日志追加', () => {
  test('appendUserLogLine / appendBotReplyLine 写入同一条 on 日志，内容与 Dice! 一致', () => {
    const store = createJsonStoreWithExtras({ dir: tempDir() });
    store.putGame(game('阿卡姆'));
    store.setSceneGame('T1', 'G1', '#1');
    store.putLog(logRecord('第一夜', '#1'));
    store.putLog(logRecord('暂停中', '#1', 'T1', { id: 'L2', state: 'off' }));

    const at = new Date(2026, 2, 9, 4, 5, 6);
    const userLine = '甲(U1) 2026-03-09 04:05:06\n我们进入地窖\n\n';
    const botLine = '骰娘(9000) 2026-03-09 04:05:06\n甲 进行 侦查 检定：D100=42/60 成功\n\n';

    appendUserLogLine(store, 'T1', { name: '甲', uid: 'U1', at, text: '我们进入地窖' });
    appendBotReplyLine(store, 'T1', { uid: '9000', name: '骰娘', at, text: '甲 进行 侦查 检定：D100=42/60 成功' });

    assert.deepEqual(store.logLines('L1'), [userLine, botLine], '玩家消息与骰娘回执都进同一条 on 日志');
    assert.deepEqual(store.logLines('L2'), [], '暂停（off）日志不接收');
  });

  test('store.appendLogLine 原样追加整行，不再自己拼前缀（LogInfo::append）', () => {
    const store = createJsonStoreWithExtras({ dir: tempDir() });
    store.setSceneGame('T1', 'G1', '#1');
    store.putLog(logRecord('第一夜', '#1'));

    store.appendLogLine('T1', '自定义(uid) 2026-01-01 00:00:00\n正文\n\n');
    assert.deepEqual(store.logLines('L1'), ['自定义(uid) 2026-01-01 00:00:00\n正文\n\n']);
  });
});

describe('Dice! 日志导出', () => {
  test('文件正文 = 各行原样拼接（行自带 \\n\\n，不再补换行）', () => {
    const store = createJsonStore({ dir: tempDir() });
    store.putGame(game('阿卡姆'));
    store.setSceneGame('T1', 'G1', '#1');
    store.putLog(logRecord('第一夜', '#1'));

    const at = new Date(2026, 2, 9, 4, 5, 6);
    appendUserLogLine(store, 'T1', { name: '甲', uid: 'U1', at, text: '我们进入地窖' });
    appendBotReplyLine(store, 'T1', { uid: '9000', name: '骰娘', at, text: '（回执）' });

    const log = store.getLog('L1')!;
    const path = store.logFilePath(log);
    assert.equal(basename(path), '阿卡姆_第一夜.txt', '磁盘名 = <局名>_<日志名>.txt');
    assert.equal(
      readFileSync(path, 'utf8'),
      '甲(U1) 2026-03-09 04:05:06\n我们进入地窖\n\n骰娘(9000) 2026-03-09 04:05:06\n（回执）\n\n',
    );
  });

  test('无局场景日志回退日志名；局不存在也回退日志名', () => {
    const store = createJsonStore({ dir: tempDir() });
    store.setSceneGame('C1', 'G1', null);
    store.putLog(logRecord('单人团', null, 'C1'));
    const scenePath = store.logFilePath(store.getLog('L1')!);
    assert.equal(basename(scenePath), '单人团_单人团.txt');

    // gameId 指向不存在的局 → 回退日志名
    assert.equal(diceLogSessionName(logRecord('散场', '#9'), () => null), '散场');
    assert.equal(diceLogSessionName(logRecord('散场', null), () => null), '散场');
    assert.equal(diceLogSessionName(logRecord('散场', '#1'), () => game('阿卡姆')), '阿卡姆');
  });

  test('exportLogRecord：附件名与磁盘名一致，且为 Dice! 命名', () => {
    const store = createJsonStore({ dir: tempDir() });
    store.putGame(game('阿卡姆'));
    store.setSceneGame('T1', 'G1', '#1');
    store.putLog(logRecord('第一夜', '#1'));
    appendUserLogLine(store, 'T1', {
      name: '甲',
      uid: 'U1',
      at: new Date(2026, 2, 9, 4, 5, 6),
      text: '我们进入地窖',
    });

    const deps = { store, now: () => new Date(2026, 2, 9, 4, 5, 6) } as unknown as HandlerDeps;
    const log = store.getLog('L1')!;
    const { log: ended, file } = exportLogRecord(deps, log, new Date(2026, 2, 9, 4, 5, 7));

    assert.equal(ended.state, 'ended');
    assert.equal(ended.fileName, '阿卡姆_第一夜.txt');
    assert.equal(file.name, '阿卡姆_第一夜.txt');
    assert.equal(file.data.toString('utf8'), '甲(U1) 2026-03-09 04:05:06\n我们进入地窖\n\n');
    assert.equal(store.getLog('L1')?.fileName, '阿卡姆_第一夜.txt');
  });
});
