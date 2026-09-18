/**
 * Session lifecycle primitives shared by `/game start`, `/game end`, `/game switch` and the
 * `/log new` reverse entry point (docs §10.1, §11.1, §16.11/§16.12).
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import type { HandlerDeps, InteractionContext, OutgoingFile } from '../../contracts/bot.ts';
import type { GameRecord, LogRecord, LogState } from '../../contracts/model.ts';
import { diceLogFileName, diceLogSessionName } from '../logFormat.ts';
import { fmtStamp } from './format.ts';

export interface StartGameInput {
  name: string;
  keeperId: string;
  /** existing thread to use as the main scene */
  threadId?: string | null;
  /** use the current channel/thread in place */
  here?: boolean;
  /** `false` skips the automatic `<桌名> · <MMDD-HHmm>` log (used by `/log new`) */
  openLog?: boolean;
  /** override for the automatic log name */
  logName?: string | null;
}

export interface StartGameResult {
  game: GameRecord;
  log: LogRecord | null;
  /** main scene: the created/reused thread, or the current channel when 就地 */
  sceneId: string;
  notes: string[];
}

/** Log names must be unique inside their session/scene (docs §16.12: 日志名冲突自动加序号). */
export function uniqueLogName(existing: LogRecord[], base: string): string {
  const names = new Set(existing.map((log) => log.name));
  if (!names.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} (${i})`;
    if (!names.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}

export interface CreateLogInput {
  name: string;
  gameId: string | null;
  guildId: string;
  channelId: string;
  sceneIds: string[];
  state?: LogState;
}

export function createLog(deps: HandlerDeps, input: CreateLogInput): LogRecord {
  const existing = deps.store.listLogs({
    gameId: input.gameId,
    channelId: input.channelId,
    guildId: input.guildId,
  });
  const log: LogRecord = {
    id: deps.store.nextLogId(),
    gameId: input.gameId,
    channelId: input.channelId,
    guildId: input.guildId,
    name: uniqueLogName(existing, input.name),
    state: input.state ?? 'on',
    sceneIds: [...new Set(input.sceneIds)],
    startedAt: deps.now().toISOString(),
    endedAt: null,
    fileName: null,
  };
  deps.store.putLog(log);
  return log;
}

/**
 * `/game start` steps 1–5 (docs §10.1): register the session, build the main scene, create the
 * 暗骰 private thread under its parent channel, bind the scenes and open the log.
 */
export async function startGame(
  ctx: InteractionContext,
  deps: HandlerDeps,
  input: StartGameInput,
): Promise<StartGameResult> {
  const guildId = ctx.guildId;
  if (!guildId) throw new Error('startGame requires a guild');
  const notes: string[] = [];

  let sceneThreadId: string | null = null;
  let sceneCreatedByBot = false;
  let parentChannelId: string;

  if (input.threadId) {
    // 复用已有子区（thread 优先于 here）
    sceneThreadId = input.threadId;
    parentChannelId =
      (await deps.platform.threadParent(input.threadId)) ?? ctx.parentChannelId ?? ctx.channelId;
  } else if (input.here) {
    // 就地使用当前场景：频道 → 绑频道；子区 → 绑该子区
    if (ctx.parentChannelId) {
      sceneThreadId = ctx.channelId;
      parentChannelId = ctx.parentChannelId;
    } else {
      sceneThreadId = null;
      parentChannelId = ctx.channelId;
    }
  } else {
    // 默认：在当前频道下新建公开子区作主场景
    const target = ctx.parentChannelId ?? ctx.channelId;
    parentChannelId = target;
    let created: string | null = null;
    if (await deps.platform.canCreateThreads(target)) {
      try {
        created = await deps.platform.createPublicThread(target, input.name);
      } catch {
        created = null;
      }
    }
    if (created) {
      sceneThreadId = created;
      sceneCreatedByBot = true;
    } else {
      // 降级：就地开在当前场景（docs §10.1 前置权限）
      notes.push('Bot 无法在该频道创建公开子区，已就地在当前场景开局。');
      sceneThreadId = ctx.parentChannelId ? ctx.channelId : null;
    }
  }

  const game: GameRecord = {
    id: deps.store.nextGameId(guildId),
    guildId,
    name: input.name,
    keeperId: input.keeperId,
    status: 'active',
    sceneThreadId,
    parentChannelId,
    sceneThreadCreatedByBot: sceneCreatedByBot,
    hiddenThreadId: null,
    rule: null,
    currentLogId: null,
    startedAt: deps.now().toISOString(),
    endedAt: null,
  };

  // 本局暗骰子区：建在主场景的父频道下（子区不能内嵌子区）
  if (await deps.platform.canCreateThreads(parentChannelId)) {
    try {
      const hidden = await deps.platform.createPrivateThread(parentChannelId, `暗骰 · ${input.name}`);
      await deps.platform.addThreadMember(hidden, input.keeperId);
      game.hiddenThreadId = hidden;
    } catch {
      notes.push('创建暗骰子区失败，/rh 将降级为 ephemeral 回执。');
    }
  } else {
    notes.push('Bot 缺少创建私密子区的权限，/rh 将降级为 ephemeral 回执。');
  }

  deps.store.putGame(game);

  // 绑定发起者所在场景 + 主场景；旧局若因此不再有任何场景，其仍在记录的日志自动暂停
  const sceneId = sceneThreadId ?? ctx.channelId;
  const scenes = [...new Set([sceneId, ctx.channelId])];
  const previousGames = new Set<string>();
  for (const channelId of scenes) {
    const previous = deps.store.getSceneGame(channelId);
    if (previous && previous !== game.id) previousGames.add(previous);
    deps.store.setSceneGame(channelId, guildId, game.id);
  }
  for (const previous of previousGames) {
    pauseAbandonedLogs(deps, guildId, previous);
  }

  let log: LogRecord | null = null;
  if (input.openLog !== false) {
    // 日志名：优先 `/log new name:` 传进来的设定名；没设定就回退**桌名**
    // （桌名本身要么是设定的名字，要么是带完整日期的 `<频道名> · <YYYY-MM-DD HHMM>`）。
    const base = input.logName && input.logName.trim().length > 0 ? input.logName.trim() : input.name;
    log = createLog(deps, {
      name: base,
      gameId: game.id,
      guildId,
      channelId: sceneId,
      // 日志按场景隔离：开局自动开的日志只记主场景（子区）的发言；
      // 其他频道/子区各自 /log new，互不影响。
      sceneIds: [sceneId],
      state: 'on',
    });
    game.currentLogId = log.id;
    deps.store.putGame(game);
  }

  return { game, log, sceneId, notes };
}

/**
 * 切局收尾 (docs §11.1): a session that lost its last scene while logs were still recording gets
 * its logs paused (never exported, never deleted).
 */
export function pauseAbandonedLogs(
  deps: HandlerDeps,
  guildId: string,
  gameId: string,
): LogRecord[] {
  if (deps.store.listScenesOfGame(gameId, guildId).length > 0) return [];
  const paused: LogRecord[] = [];
  for (const log of deps.store.listLogs({ gameId, channelId: '', guildId })) {
    if (log.state !== 'on') continue;
    const next: LogRecord = { ...log, state: 'off' };
    deps.store.putLog(next);
    paused.push(next);
  }
  if (paused.length > 0) {
    const game = deps.store.getGame(guildId, gameId);
    if (game) deps.store.putGame(game);
  }
  return paused;
}

/** `/log end` + `/game end`: end the log, export the file and hand back the attachment. */
export function exportLogRecord(
  deps: HandlerDeps,
  log: LogRecord,
  endedAt: Date,
): { log: LogRecord; file: OutgoingFile } {
  // 附件名与磁盘名一致：Dice! `<会话名>_<日志名>.txt`（会话名 = 局名，查不到回退日志名）
  const fileName = diceLogFileName(
    diceLogSessionName(log, (guildId, gameId) => deps.store.getGame(guildId, gameId)),
    log.name,
  );
  const ended: LogRecord = {
    ...log,
    state: 'ended',
    endedAt: endedAt.toISOString(),
    fileName,
  };
  const path = deps.store.logFilePath(ended);
  ended.fileName = basename(path);
  deps.store.putLog(ended);
  const data = readFileSync(path);
  return { log: ended, file: { name: ended.fileName, data } };
}
