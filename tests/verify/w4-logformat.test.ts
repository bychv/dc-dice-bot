/**
 * W4 独立验证 · task-7 Dice! 日志格式
 *
 * 全部断言都从 `ref/Dice/Dice/**` 原位推导（并用行号钉住 DiceEvent.cpp:188/222/239、
 * DiceSchedule.cpp:319、DiceSession.cpp:30/200），再与实现逐字符对照；日志落盘用**真实
 * jsonStore**，adapter 接线用 fake interaction 直接跑 `respond` / `createLogRecorder`。
 *
 * Run: node tests/verify/w4-logformat.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  ChatInputCommandInteraction,
  InteractionEditReplyOptions,
  InteractionReplyOptions,
  Message,
} from 'discord.js';

import { createLogRecorder, respond } from '../../src/bot/adapter.ts';
import { createLog, exportLogRecord } from '../../src/bot/handlers/gameCore.ts';
import { route } from '../../src/bot/router.ts';
import {
  appendBotReplyLine,
  appendUserLogLine,
  diceLogFileName,
  diceLogSessionName,
  formatDiceLogLine,
  formatDiceTimestamp,
} from '../../src/bot/logFormat.ts';
import { createPendingActions } from '../../src/bot/confirm.ts';
import type { HandlerDeps } from '../../src/contracts/bot.ts';
import type { GameRecord, LogRecord } from '../../src/contracts/model.ts';
import { createCocRules } from '../../src/coc/index.ts';
import { createDiceEngine, createMathRng } from '../../src/dice/index.ts';
import { createJsonStore, createJsonStoreWithExtras } from '../../src/store/jsonStore.ts';
import { FakePlatform, makeContext } from '../bot/fakes.ts';

const TMP_ROOT = fileURLToPath(new URL('../.tmp/', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const DICE = join(REPO, 'ref', 'Dice', 'Dice');

const EVENT_CPP = readFileSync(join(DICE, 'DiceEvent.cpp'), 'utf8');
const SCHEDULE_CPP = readFileSync(join(DICE, 'DiceSchedule.cpp'), 'utf8');
const SESSION_CPP = readFileSync(join(DICE, 'DiceSession.cpp'), 'utf8');

function tempDir(label: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TMP_ROOT, `w4-log-${label}-`));
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// —— 冻结时钟构造：用**本地分量**建 Date，断言与时区无关 ——
const AT = new Date(2026, 2, 9, 4, 5, 6);
const STAMP = '2026-03-09 04:05:06';

function game(name: string, id = '#1', guildId = 'G1'): GameRecord {
  return {
    id,
    guildId,
    name,
    keeperId: 'U1',
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

interface LogEnv {
  deps: HandlerDeps;
  store: ReturnType<typeof createJsonStoreWithExtras>;
  dir: string;
}

function logEnv(label: string): LogEnv {
  const dir = tempDir(label);
  const store = createJsonStoreWithExtras({ dir });
  const dice = createDiceEngine();
  const deps: HandlerDeps = {
    store,
    dice,
    coc: createCocRules(dice),
    rng: createMathRng(),
    platform: new FakePlatform(),
    confirmations: createPendingActions(),
    now: () => AT,
  };
  return { deps, store, dir };
}

function seedGameLog(env: LogEnv, logName = '第一夜'): LogRecord {
  const record = game('阿卡姆');
  env.store.putGame(record);
  env.store.setSceneGame('T1', 'G1', '#1');
  const log = createLog(env.deps, {
    name: logName,
    gameId: '#1',
    guildId: 'G1',
    channelId: 'T1',
    sceneIds: ['T1'],
    state: 'on',
  });
  record.currentLogId = log.id;
  env.store.putGame(record);
  return log;
}

// ---------------------------------------------------------------------------
// ① 行格式：从 ref 推导
// ---------------------------------------------------------------------------

describe('W4 · formatDiceLogLine vs ref（逐字符）', () => {
  test('DiceEvent.cpp:188/222/239 的行号与表达式原文', () => {
    const lines = EVENT_CPP.split(/\r?\n/);
    assert.ok(lines[187].includes('log_app(getMsg("strSelfName")'), `188 行应为 replyHidden 的 log_app：${lines[187]}`);
    assert.ok(lines[221].includes('log_app(getMsg("strSelfName")'), `222 行应为 logEcho 的 log_app：${lines[221]}`);
    assert.ok(lines[238].includes('log_app(idx_pc(*this).to_str()'), `239 行应为 fwdMsg 的 log_app：${lines[238]}`);

    // 骰娘行：strSelfName + "(" + DiceMaid + ") " + printTTime + "\n" + 正文 + "\n\n"
    assert.match(
      EVENT_CPP,
      /getMsg\("strSelfName"\) \+ "\(" \+ std::to_string\(console\.DiceMaid\) \+ "\) " \+ printTTime\(\(time_t\)get_ll\("time"\)\)\s*\n?\s*\+ "\\n" \+ filter_CQcode\(strReply, fromChat\.gid\) \+ "\\n\\n"/,
    );
    // 玩家行：idx_pc().to_str() + "(" + fromChat.uid + ") " + printTTime + "\n" + 正文 + "\n\n"
    assert.match(
      EVENT_CPP,
      /idx_pc\(\*this\)\.to_str\(\) \+ "\(" \+ std::to_string\(fromChat\.uid\) \+ "\) " \+ printTTime\(\(time_t\)get_ll\("time"\)\)\s*\n?\s*\+ "\\n" \+ filter_CQcode\(strMsg, fromChat\.gid\) \+ "\\n\\n"/,
    );
    // `/log` 指令自身不入日志（logEcho 的排除条件）
    assert.match(EVENT_CPP, /strLowerMessage\.find\("\.log"\) != 0/);
  });

  test('DiceSchedule.cpp:319 printTTime = localtime + strftime("%Y-%m-%d %H:%M:%S")', () => {
    const lines = SCHEDULE_CPP.split(/\r?\n/);
    assert.ok(lines[318].includes('printTTime(time_t tt)'), `319 行应为 printTTime：${lines[318]}`);
    assert.match(SCHEDULE_CPP, /localtime_s\(&t, &tt\)|localtime_r\(&tt, &t\)/);
    assert.match(SCHEDULE_CPP, /strftime\(tm_buffer, 20, "%Y-%m-%d %H:%M:%S", &t\)/);
  });

  test('拼出的整行 = `<名字>(<uid>) <YYYY-MM-DD HH:MM:SS>\\n<正文>\\n\\n`', () => {
    const player = formatDiceLogLine({ name: '甲', uid: 'U1', at: AT, text: '我们进入地窖' });
    assert.equal(player, '甲(U1) 2026-03-09 04:05:06\n我们进入地窖\n\n');

    const dice = formatDiceLogLine({ name: '骰娘', uid: '9000', at: AT, text: '甲 进行 侦查 检定：D100=42/60 成功' });
    assert.equal(dice, '骰娘(9000) 2026-03-09 04:05:06\n甲 进行 侦查 检定：D100=42/60 成功\n\n');

    // 正文原样：内部换行/前后空格都不动，只在末尾追加 \n\n
    const raw = formatDiceLogLine({ name: 'A', uid: '2', at: AT, text: ' 多行\n内容 ' });
    assert.equal(raw, 'A(2) 2026-03-09 04:05:06\n 多行\n内容 \n\n');
  });

  test('时间用本地分量（localtime 语义），不是 UTC / toISOString', () => {
    assert.equal(formatDiceTimestamp(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02 03:04:05');
    const at = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    const local = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`;
    const utc = `${at.getUTCFullYear()}-${pad2(at.getUTCMonth() + 1)}-${pad2(at.getUTCDate())} ${pad2(at.getUTCHours())}:${pad2(at.getUTCMinutes())}:${pad2(at.getUTCSeconds())}`;
    assert.equal(formatDiceTimestamp(at), local, '必须逐字段等于本地 getter');
    if (at.getTimezoneOffset() !== 0) {
      assert.notEqual(formatDiceTimestamp(at), utc, '本机有偏移时必须明显不是 UTC（当前 TZ 偏移分钟数）');
    }
    assert.match(formatDiceTimestamp(new Date(2026, 10, 20, 9, 8, 7)), /^2026-11-20 09:08:07$/);
  });
});

// ---------------------------------------------------------------------------
// ② 文件名：DiceSession.cpp:200
// ---------------------------------------------------------------------------

describe('W4 · 导出文件名 vs DiceSession.cpp:200', () => {
  test('ref 原文 `name + "_" + nameLog + ".txt"` 且 append 原样写', () => {
    const lines = SESSION_CPP.split(/\r?\n/);
    assert.ok(lines[199].includes('logger.fileLog = name + "_" + nameLog + ".txt";'), `200 行：${lines[199]}`);
    assert.ok(lines[29].includes('void LogInfo::append'), `30 行：${lines[29]}`);
    assert.match(SESSION_CPP, /logout << s;/);
  });

  test('diceLogFileName：<局名>_<日志名>.txt；非法字符替换；空白回退', () => {
    assert.equal(diceLogFileName('阿卡姆', '第一夜'), '阿卡姆_第一夜.txt');
    assert.equal(diceLogFileName('第一/夜', 'log:1'), '第一_夜_log_1.txt');
    assert.equal(diceLogFileName('a\\b:c*d?e"f<g>h|i', 'x'), 'a_b_c_d_e_f_g_h_i_x.txt');
    assert.equal(diceLogFileName('', ''), 'session_log.txt');
    assert.equal(diceLogFileName('桌名. ', 'log..'), '桌名_log.txt');
  });

  test('会话名：有局取局名，局查不到/无局回退日志名', () => {
    const base = { gameId: null as string | null, guildId: 'G1', name: '散场' };
    assert.equal(diceLogSessionName(base, () => null), '散场');
    assert.equal(diceLogSessionName({ ...base, gameId: '#1' }, () => null), '散场');
    assert.equal(diceLogSessionName({ ...base, gameId: '#1' }, () => ({ name: '阿卡姆' })), '阿卡姆');
  });
});

// ---------------------------------------------------------------------------
// ③ 真实落盘：用户行 + 骰娘行入同一条 on 日志，导出正文原样拼接
// ---------------------------------------------------------------------------

describe('W4 · 真实 jsonStore 落盘', () => {
  test('appendUserLogLine / appendBotReplyLine 写同一条 on 日志；off 日志不接收', () => {
    const env = logEnv('append');
    seedGameLog(env);
    env.store.putLog({ ...env.store.getLog('L1')!, id: 'L2', name: '暂停中', state: 'off' });

    const userLine = '甲(U1) 2026-03-09 04:05:06\n我们进入地窖\n\n';
    const botLine = '骰娘(9000) 2026-03-09 04:05:06\n甲 进行 侦查 检定：D100=42/60 成功\n\n';
    appendUserLogLine(env.store, 'T1', { name: '甲', uid: 'U1', at: AT, text: '我们进入地窖' });
    appendBotReplyLine(env.store, 'T1', {
      uid: '9000',
      name: '骰娘',
      at: AT,
      text: '甲 进行 侦查 检定：D100=42/60 成功',
    });

    assert.deepEqual(env.store.logLines('L1'), [userLine, botLine]);
    assert.deepEqual(env.store.logLines('L2'), [], 'off 日志不得接收任何行');
    // 每行都以 \n\n 结尾 → 任意两行之间恰好一个空行，不出现 3 连换行
    assert.equal(env.store.logLines('L1').join('').includes('\n\n\n'), false);
  });

  test('导出正文 = 各行原样拼接（无额外换行），磁盘名 = <局名>_<日志名>.txt', () => {
    const env = logEnv('export');
    seedGameLog(env);
    appendUserLogLine(env.store, 'T1', { name: '甲', uid: 'U1', at: AT, text: '我们进入地窖' });
    appendBotReplyLine(env.store, 'T1', { uid: '9000', name: '骰娘', at: AT, text: '（回执）' });

    const expected = '甲(U1) 2026-03-09 04:05:06\n我们进入地窖\n\n骰娘(9000) 2026-03-09 04:05:06\n（回执）\n\n';
    const path = env.store.logFilePath(env.store.getLog('L1')!);
    assert.equal(basename(path), '阿卡姆_第一夜.txt');
    assert.equal(readFileSync(path, 'utf8'), expected, '必须逐字符等于行拼接，不得多/少换行');
    assert.equal(readFileSync(path, 'utf8').endsWith('\n\n'), true);
  });

  test('日志名非法字符在导出时被替换，附件名与磁盘名一致', () => {
    const env = logEnv('illegal');
    const log = seedGameLog(env, '第一/夜');
    const { log: ended, file } = exportLogRecord(env.deps, log, AT);
    assert.equal(ended.fileName, '阿卡姆_第一_夜.txt');
    assert.equal(file.name, ended.fileName);
    const onDisk = readdirSync(join(env.dir, 'logs'));
    assert.ok(onDisk.includes(file.name), `磁盘上应有同名文件：${onDisk.join(', ')}`);
    assert.equal(basename(join(env.dir, 'logs', file.name)), file.name);
  });

  test('未绑定局的场景日志回退成 <日志名>_<日志名>.txt', () => {
    const dir = tempDir('scenelog');
    const store = createJsonStore({ dir });
    store.putLog({
      id: 'L1',
      gameId: null,
      channelId: 'C1',
      guildId: 'G1',
      name: '单人团',
      state: 'on',
      sceneIds: ['C1'],
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
      fileName: null,
    });
    assert.equal(basename(store.logFilePath(store.getLog('L1')!)), '单人团_单人团.txt');
  });
});

// ---------------------------------------------------------------------------
// ④ adapter 接线：messageCreate + respond
// ---------------------------------------------------------------------------

interface FakeCommand {
  interaction: ChatInputCommandInteraction;
  replies: InteractionReplyOptions[];
  edits: InteractionEditReplyOptions[];
}

function fakeCommand(commandName: string, channelId: string, opts: { deferred?: boolean; replied?: boolean; botId?: string; threadParentId?: string } = {}): FakeCommand {
  const replies: InteractionReplyOptions[] = [];
  const edits: InteractionEditReplyOptions[] = [];
  const interaction = {
    commandName,
    channelId,
    deferred: opts.deferred ?? false,
    replied: opts.replied ?? false,
    channel: opts.threadParentId
      ? { isThread: () => true, parentId: opts.threadParentId }
      : undefined,
    client: { user: { id: opts.botId ?? '9000', username: 'Dice' } },
    reply: async (options: InteractionReplyOptions) => {
      replies.push(options);
    },
    editReply: async (options: InteractionEditReplyOptions) => {
      edits.push(options);
    },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, replies, edits };
}

function fakeMessage(spec: {
  content: string;
  channelId?: string;
  bot?: boolean;
  displayName?: string;
  attachments?: string[];
  threadParentId?: string;
}): Message {
  const names = spec.attachments ?? [];
  return {
    channelId: spec.channelId ?? 'T1',
    content: spec.content,
    channel: spec.threadParentId ? { isThread: () => true, parentId: spec.threadParentId } : undefined,
    author: { bot: spec.bot ?? false, id: 'U1', username: 'u1' },
    member: { displayName: spec.displayName ?? '甲' },
    attachments: {
      size: names.length,
      values: () => names.map((name) => ({ name })),
    },
  } as unknown as Message;
}

describe('W4 · adapter 真的把用户消息与骰娘回执接进日志', () => {
  test('createLogRecorder：玩家消息按 Dice! 行格式入日志（冻结时钟不可用，用正则校验时间位）', () => {
    const env = logEnv('recorder');
    seedGameLog(env);
    const recorder = createLogRecorder(env.store);

    recorder(fakeMessage({ content: '我们进入地窖' }));
    const lines = env.store.logLines('L1');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^甲\(U1\) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n我们进入地窖\n\n$/);

    // Bot 自己的消息、空消息、空白消息都不记录
    recorder(fakeMessage({ content: '机器人说话', bot: true }));
    recorder(fakeMessage({ content: '   ' }));
    assert.equal(env.store.logLines('L1').length, 1);

    // 附件以 `[附件 名]` 追加
    recorder(fakeMessage({ content: '看这个', attachments: ['map.png', 'hand.png'] }));
    assert.match(env.store.logLines('L1')[1], /\n看这个 \[附件 map\.png\] \[附件 hand\.png\]\n\n$/);
  });

  test('respond：普通指令的骰娘回执按同一格式入同一条 on 日志', () => {
    const env = logEnv('respond');
    seedGameLog(env);
    appendUserLogLine(env.store, 'T1', { name: '甲', uid: 'U1', at: AT, text: '我们进入地窖' });

    const { interaction, replies } = fakeCommand('r', 'T1');
    return respond(interaction, { content: '甲 进行 侦查 检定：D100=42/60 成功' }, env.deps).then(() => {
      assert.equal(replies.length, 1);
      assert.deepEqual(env.store.logLines('L1'), [
        '甲(U1) 2026-03-09 04:05:06\n我们进入地窖\n\n',
        'Dice(9000) 2026-03-09 04:05:06\n甲 进行 侦查 检定：D100=42/60 成功\n\n',
      ], '玩家行与骰娘行必须在同一条日志里，且时间来自 deps.now()');
    });
  });

  test('子区没有生效日志时：玩家消息与骰娘回执都回落到父频道日志', async () => {
    const env = logEnv('parent-fallback');
    seedGameLog(env); // 生效日志 L1 挂在天道 T1 上

    createLogRecorder(env.store)(fakeMessage({ content: '在子区说话', channelId: 'T7', threadParentId: 'T1' }));
    const { interaction } = fakeCommand('r', 'T7', { threadParentId: 'T1' });
    await respond(interaction, { content: '在子区回执' }, env.deps);

    const lines = env.store.logLines('L1');
    assert.equal(lines.length, 2, '子区里的玩家消息与骰娘回执都要落进父频道日志');
    assert.match(lines[0], /\n在子区说话\n\n$/);
    assert.match(lines[1], /^Dice\(9000\) .*\n在子区回执\n\n$/);
  });

  test('respond：ephemeral 回执与 /log 自身回执都不入日志', () => {
    const env = logEnv('respond-skip');
    seedGameLog(env);

    const ephemeral = fakeCommand('r', 'T1');
    const logCmd = fakeCommand('log', 'T1');
    const deferred = fakeCommand('r', 'T1', { deferred: true });
    return (async () => {
      await respond(ephemeral.interaction, { content: '只有我能看到', ephemeral: true }, env.deps);
      await respond(logCmd.interaction, { content: '已开启日志…' }, env.deps);
      await respond(deferred.interaction, { content: 'defer 后的回执' }, env.deps);
      assert.equal(ephemeral.replies[0].flags !== undefined, true, 'ephemeral 必须带 flags');
      assert.equal(deferred.edits.length, 1, 'deferred 走 editReply');
      assert.deepEqual(env.store.logLines('L1'), [
        'Dice(9000) 2026-03-09 04:05:06\ndefer 后的回执\n\n',
      ], 'ephemeral 与 /log 被跳过，只有 deferred 的普通回执入日志');
    })();
  });

  test('respond 不传 deps 时不写日志（单元测试路径安全）', async () => {
    const env = logEnv('respond-nodeps');
    seedGameLog(env);
    const { interaction, replies } = fakeCommand('r', 'T1');
    await respond(interaction, { content: 'x' });
    assert.equal(replies.length, 1);
    assert.deepEqual(env.store.logLines('L1'), []);
  });
});

// ---------------------------------------------------------------------------
// ⑤ /log end 与 /game end 的附件名 == 磁盘文件名
// ---------------------------------------------------------------------------

describe('W4 · /log end、/game end 的附件名与磁盘名', () => {
  test('/log end：附件名 = <局名>_<日志名>.txt，且与 logs/ 下真实文件同名同内容', async () => {
    const env = logEnv('log-end');
    seedGameLog(env);
    appendUserLogLine(env.store, 'T1', { name: '甲', uid: 'U1', at: AT, text: '我们进入地窖' });
    appendBotReplyLine(env.store, 'T1', { uid: '9000', name: '骰娘', at: AT, text: '（回执）' });

    const ctx = makeContext({ command: 'log', sub: 'end', channelId: 'T1', userId: 'U1', values: {} });
    const reply = await route(ctx, env.deps);

    assert.notEqual(reply.ephemeral, true, reply.content);
    assert.equal(reply.files?.length, 1, reply.content);
    const file = reply.files![0];
    assert.equal(file.name, '阿卡姆_第一夜.txt');
    assert.ok(reply.content.includes('阿卡姆_第一夜.txt'), reply.content);

    const onDisk = readdirSync(join(env.dir, 'logs'));
    assert.deepEqual(onDisk, [file.name], `logs/ 下应恰好这一个文件：${onDisk.join(', ')}`);
    assert.equal(
      readFileSync(join(env.dir, 'logs', file.name), 'utf8'),
      '甲(U1) 2026-03-09 04:05:06\n我们进入地窖\n\n骰娘(9000) 2026-03-09 04:05:06\n（回执）\n\n',
    );
    assert.equal(file.data.toString('utf8'), readFileSync(join(env.dir, 'logs', file.name), 'utf8'));
  });

  test('/game end：逐条导出附件，附件名都能在 logs/ 下找到同名文件', async () => {
    const env = logEnv('game-end');
    seedGameLog(env, '第一夜');
    const second = createLog(env.deps, {
      name: '第二夜',
      gameId: '#1',
      guildId: 'G1',
      channelId: 'T1',
      sceneIds: ['T1'],
      state: 'on',
    });
    appendUserLogLine(env.store, 'T1', { name: '甲', uid: 'U1', at: AT, text: '夜里' });
    // 写进内容后再置为暂停：暂停日志同样要有正文（0 字节附件会被 Discord 拒绝）
    env.store.putLog({ ...env.store.getLog(second.id)!, state: 'off' });

    const ctx = makeContext({ command: 'game', sub: 'end', channelId: 'T1', userId: 'U1', values: {} });
    const reply = await route(ctx, env.deps);

    assert.notEqual(reply.ephemeral, true, reply.content);
    assert.equal(reply.files?.length, 2, `本局两条未结束日志都应导出：${reply.content}`);
    const names = reply.files!.map((f) => f.name).sort();
    assert.deepEqual(names, ['阿卡姆_第一夜.txt', '阿卡姆_第二夜.txt']);
    const onDisk = readdirSync(join(env.dir, 'logs')).sort();
    assert.deepEqual(onDisk, names, '附件名必须与磁盘文件名一一对应');
    const night1 = reply.files!.find((f) => f.name === '阿卡姆_第一夜.txt')!;
    const night2 = reply.files!.find((f) => f.name === '阿卡姆_第二夜.txt')!;
    assert.ok(night1.data.length > 0);
    assert.ok(night2.data.length > 0, '第二夜也写了内容，不再是 0 字节');
    assert.ok(readFileSync(join(env.dir, 'logs', '阿卡姆_第二夜.txt'), 'utf8').includes('夜里'));
    assert.equal(env.store.getLog(second.id)?.state, 'ended');
  });

  test('/log end：空日志不附 0 字节附件，改为说明「本次无日志产生」', async () => {
    const env = logEnv('log-end-empty');
    const log = seedGameLog(env, '空日志');
    // 让它成为唯一生效日志：把那条种子日志置空
    env.store.putLog({ ...env.store.getLog(log.id)!, name: '空日志' });

    const ctx = makeContext({ command: 'log', sub: 'end', channelId: 'T1', userId: 'U1', values: {} });
    const reply = await route(ctx, env.deps);

    assert.notEqual(reply.ephemeral, true, reply.content);
    assert.equal(reply.files, undefined, '0 字节附件会被 Discord 拒绝，不能发');
    assert.ok(reply.content.includes('无日志产生'), reply.content);
    assert.equal(env.store.getLog(log.id)?.state, 'ended');
  });
});
