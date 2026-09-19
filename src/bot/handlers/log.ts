/**
 * `/log` — 日志记录与导出 (docs §11.1, §16.12).
 *
 * Invariants implemented here:
 * - one `on` log per **scene** (channel or thread); `/log new` is refused only while the current
 *   scene already records — other channels/threads may record concurrently;
 * - a log's scope is the scene it was opened in: it never follows `/game switch`;
 * - paused (`off`) logs are never touched automatically — `/log new` opens a new stream and the
 *   old one stays paused until `/log end name:<旧名>`;
 * - **不再自动开局**：`/log new` 在当前场景没有局时只开**场景日志**（gameId = null）；
 *   要挂到局上必须显式 `/game start` 或 `/log new game:<桌名|#N>`。
 */
import type { CommandHandler, HandlerDeps, InteractionContext, ReplyPayload } from '../../contracts/bot.ts';
import type { GameRecord, LogRecord } from '../../contracts/model.ts';
import { activeLog, currentGame, findLogByName, scopedLogs } from './context.ts';
import { fmtDateTime, fmtLogLine, fmtStamp, mentionChannel } from './format.ts';
import { createLog, exportLogRecord, pauseAbandonedLogs } from './gameCore.ts';
import { clamp, fail, ok, optionString, subcommand } from './options.ts';

function refusal(recording: LogRecord): ReplyPayload {
  return fail(
    `当前生效日志「${recording.name}」仍在记录中，不能再开新日志。\n` +
      '请先 `/log end`（结束并导出）或 `/log off`（暂停，日志保留）后再 `/log new`。',
  );
}

async function logNew(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const logName = optionString(ctx, 'name')?.trim() || fmtStamp(deps.now());
  const gameRef = optionString(ctx, 'game')?.trim() || null;
  const notes: string[] = [];

  // 本场景（频道或子区）自己的日志；日志按场景隔离，不同场景可各自同时开
  const sceneLogs = deps.store.listSceneLogs(ctx.channelId, ctx.guildId ?? undefined);

  let game: GameRecord | null = null;
  if (gameRef) {
    if (!ctx.guildId) {
      return fail('DM 内不建局，不能指定 `game:`；日志将记录在当前会话。');
    }
    game = deps.store.findGame(ctx.guildId, gameRef);
    if (!game) return fail(`找不到局「${gameRef}」。`);
    if (game.status === 'ended') return fail(`局 ${game.id} ${game.name} 已结束，不能挂新日志。`);
  } else {
    game = currentGame(ctx, deps);
    // 已结束的局不再是记录目标（/game end 会清指针；这是防御性兜底）
    if (game && game.status === 'ended') game = null;
  }

  // 唯一性规则：**本场景**仍有 on 的日志 → 拒绝；不同频道/子区可以各自同时开 (docs §11.1)
  const recording = sceneLogs.find((l) => l.state === 'on');
  if (recording) return refusal(recording);

  // 不再自动开局：没有局时就是**场景日志**（gameId = null）。
  // 要挂到局上必须显式：先 `/game start`，或 `/log new game:<桌名|#N>`。
  if (!game && ctx.guildId) {
    notes.push(
      '当前场景没有所属局，已开为**场景日志**（只记录本场景；不建局）。要开团/挂到局上请用 `/game start`，或 `/log new game:<桌名|#N>`。',
    );
  }

  // 指定 game: 时同时把本场景切到该局 (docs §11.1)
  if (game && gameRef && ctx.guildId) {
    const previous = deps.store.getSceneGame(ctx.channelId);
    deps.store.setSceneGame(ctx.channelId, ctx.guildId, game.id);
    if (previous && previous !== game.id) pauseAbandonedLogs(deps, ctx.guildId, previous);
  }

  const sceneIds = [ctx.channelId];
  const log = createLog(deps, {
    name: logName,
    gameId: game ? game.id : null,
    guildId: ctx.guildId ?? '@dm',
    channelId: ctx.channelId,
    sceneIds,
    state: 'on',
  });

  if (game) {
    game.currentLogId = log.id;
    deps.store.putGame(game);
  }

  const kept = (game
    ? deps.store.listLogs({ gameId: game.id, channelId: ctx.channelId, guildId: ctx.guildId ?? undefined })
    : deps.store.listLogs({ gameId: null, channelId: ctx.channelId, guildId: ctx.guildId ?? undefined })
  ).filter((l) => l.id !== log.id && l.state !== 'ended');

  const lines = [
    `已开启日志「${log.name}」${game ? `（局 ${game.id} ${game.name}）` : '（场景日志）'}，开始记录。`,
    ...notes,
  ];
  if (kept.length > 0) {
    lines.push(
      `暂停中的旧日志原样保留：${kept.map((l) => `「${l.name}」`).join('、')}（不自动结束、不导出；需要时 \`/log end name:<旧日志名>\`）。`,
    );
  }
  return ok(clamp(lines.join('\n')));
}

async function logList(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const game = currentGame(ctx, deps);
  const logs = scopedLogs(ctx, deps);
  if (logs.length === 0) {
    return ok(
      `当前上下文${game ? `（局 ${game.id} ${game.name}）` : `（场景 ${mentionChannel(ctx.channelId)}）`}没有日志。\n` +
        '用 `/log new` 开一条。',
    );
  }
  const current = activeLog(ctx, deps);
  const lines = logs.map((log) => fmtLogLine(log, current?.id === log.id));
  return ok(clamp(lines.join('\n')));
}

async function logOn(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const log = activeLog(ctx, deps);
  if (!log) return fail('当前没有日志；用 `/log new` 开一条。');
  if (log.state === 'ended') return fail(`日志「${log.name}」已结束，请用 \`/log new\` 开新日志。`);

  const others = scopedLogs(ctx, deps).filter((l) => l.state === 'on' && l.id !== log.id);
  for (const other of others) deps.store.putLog({ ...other, state: 'off' });
  deps.store.putLog({ ...log, state: 'on' });

  const game = currentGame(ctx, deps);
  if (game) {
    game.currentLogId = log.id;
    deps.store.putGame(game);
  }
  const lines = [`已继续记录日志「${log.name}」。`];
  if (others.length > 0) {
    lines.push(`为保持唯一性，已暂停：${others.map((l) => `「${l.name}」`).join('、')}`);
  }
  return ok(lines.join('\n'));
}

async function logOff(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const log = activeLog(ctx, deps);
  if (!log) return fail('当前没有日志；用 `/log new` 开一条。');
  if (log.state === 'ended') return fail(`日志「${log.name}」已结束。`);
  deps.store.putLog({ ...log, state: 'off' });
  return ok(`已暂停日志「${log.name}」。日志保留，可 \`/log on\` 继续或 \`/log end\` 导出。`);
}

async function logEnd(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const name = optionString(ctx, 'name')?.trim() || null;
  const log = name ? findLogByName(ctx, deps, name) : activeLog(ctx, deps);
  if (!log) {
    return fail(
      name
        ? `当前上下文里找不到日志「${name}」。用 \`/log list\` 查看名称。`
        : '当前没有可结束的日志；用 `name:` 指定历史日志，或先 `/log new`。',
    );
  }
  if (log.state === 'ended') return fail(`日志「${log.name}」已经结束了。`);

  const { log: ended, file } = exportLogRecord(deps, log, deps.now());
  const empty = file.data.length === 0;
  const game = currentGame(ctx, deps);
  if (game && game.currentLogId === ended.id) {
    // 结束的日志不再是「当前生效」；悬空指针会让 /log list 把已结束的日志标成当前
    game.currentLogId = null;
    deps.store.putGame(game);
  }
  if (empty) {
    // 0 字节附件会被 Discord 拒绝，这里直接说明（Dice! 的 strLogEndEmpty 语义）
    return ok(`已结束日志「${ended.name}」√\n本次无日志产生（没有记录到任何消息）。`);
  }

  // 配了对象存储（Cloudflare R2）就上传并发链接：Discord 附件上传会超时/被拒，链接也更耐存
  const header =
    `已结束日志「${ended.name}」并导出为 \`${ended.fileName}\`` +
    `（开始于 ${fmtDateTime(ended.startedAt)}）。`;
  if (deps.logUpload) {
    const uploaded = await deps.logUpload.upload(file);
    if (uploaded.ok) {
      const expiry = uploaded.presigned ? '（链接有有效期，过期后请重新导出）' : '';
      return ok(`${header}\n📎 下载：${uploaded.url}${expiry}`);
    }
    return ok(`${header}\n⚠️ 上传到对象存储失败，改用附件：${uploaded.error}`, [file]);
  }
  return ok(header, [file]);
}

export const logHandler: CommandHandler = async (ctx, deps) => {
  switch (subcommand(ctx)) {
    case 'new':
      return logNew(ctx, deps);
    case 'list':
      return logList(ctx, deps);
    case 'on':
      return logOn(ctx, deps);
    case 'off':
      return logOff(ctx, deps);
    case 'end':
      return logEnd(ctx, deps);
    default:
      return fail('未知的 `/log` 子命令，可用：new / list / on / off / end。');
  }
};
