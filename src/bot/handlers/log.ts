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
import { createLog, exportLogFile, exportLogRecord, pauseAbandonedLogs } from './gameCore.ts';
import { clamp, fail, ok, optionString, subcommand } from './options.ts';
import {
  applySceneNicknames,
  describeOutcome,
  restoreSceneNicknames,
  sceneStillRecording,
} from './nickSync.ts';

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
  // `/sn`：开 log → 给开启了统计昵称同步的成员改名（docs §12.4）
  const syncNote = describeOutcome(await applySceneNicknames(ctx, deps), '同步');
  if (syncNote) lines.push(syncNote);
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
  // 没有日志在记录时，恢复本场景**最近的一条**（`off` 暂停的、或**已 `end` 结束的**）。
  // （`activeLog` 只看 state==='on' 和局指针，无局的场景日志暂停后会两边都落空 → 这里兜底；
  //   `end` 只是"导出结束"，不再是一道单向门：接着 `/log on` 就继续往同一条日志里记。）
  const log =
    activeLog(ctx, deps) ??
    scopedLogs(ctx, deps)
      .filter((l) => l.state !== 'on')
      .sort((a, b) => (a.startedAt === b.startedAt ? 0 : a.startedAt < b.startedAt ? 1 : -1))[0] ??
    null;
  if (!log) return fail('本场景没有可继续的日志；用 `/log new` 开一条。');

  const resumedEnded = log.state === 'ended';
  const others = scopedLogs(ctx, deps).filter((l) => l.state === 'on' && l.id !== log.id);
  for (const other of others) deps.store.putLog({ ...other, state: 'off' });
  // 继续记录：endedAt 清掉（"还在记"与"有结束时间"不能同时成立），fileName 保留 → 再次 end 会覆盖导出同一条文件
  deps.store.putLog({ ...log, state: 'on', endedAt: null });

  const game = currentGame(ctx, deps);
  if (game) {
    game.currentLogId = log.id;
    deps.store.putGame(game);
  }
  const lines = [
    resumedEnded
      ? `已重新开启已结束的日志「${log.name}」，继续记录。`
      : `已继续记录日志「${log.name}」。`,
  ];
  if (resumedEnded) {
    lines.push(
      log.fileName
        ? `导出文件仍是 \`${log.fileName}\`；再次 \`/log end\` 会重新导出并覆盖它，中途想看就 \`/log export\`。`
        : '本场景还有别的结束日志时，`/log export` 可随时导出当前内容。',
    );
  }
  if (others.length > 0) {
    lines.push(`为保持唯一性，已暂停：${others.map((l) => `「${l.name}」`).join('、')}`);
  }
  // `/sn`：开 log → 给开启了统计昵称同步的成员改名（docs §12.4）
  const syncNote = describeOutcome(await applySceneNicknames(ctx, deps), '同步');
  if (syncNote) lines.push(syncNote);
  return ok(lines.join('\n'));
}

async function logOff(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const log = activeLog(ctx, deps);
  if (!log) return fail('当前没有日志；用 `/log new` 开一条。');
  if (log.state === 'ended') return fail(`日志「${log.name}」已结束。`);
  deps.store.putLog({ ...log, state: 'off' });
  const lines = [`已暂停日志「${log.name}」。日志保留，可 \`/log on\` 继续或 \`/log end\` 导出。`];
  // `/sn`：本场景不再有在记录的日志 → 把统计昵称改回原名
  if (!sceneStillRecording(ctx, deps)) {
    const note = describeOutcome(await restoreSceneNicknames(ctx, deps), '还原');
    if (note) lines.push(note);
  }
  return ok(lines.join('\n'));
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
  // `/sn`：本场景不再有在记录的日志 → 还原统计昵称（先算好，拼到各条回执里）
  const syncNote = !sceneStillRecording(ctx, deps)
    ? describeOutcome(await restoreSceneNicknames(ctx, deps), '还原')
    : '';
  const tail = syncNote ? `\n${syncNote}` : '';
  if (empty) {
    // 0 字节附件会被 Discord 拒绝，这里直接说明（Dice! 的 strLogEndEmpty 语义）
    return ok(`已结束日志「${ended.name}」√\n本次无日志产生（没有记录到任何消息）。${tail}`);
  }

  // 配了对象存储（Cloudflare R2）就上传并发链接：Discord 附件上传会超时/被拒，链接也更耐存
  const header =
    `已结束日志「${ended.name}」并导出为 \`${ended.fileName}\`` +
    `（开始于 ${fmtDateTime(ended.startedAt)}）。`;
  if (deps.logUpload) {
    const uploaded = await deps.logUpload.upload(file);
    if (uploaded.ok) {
      const expiry = uploaded.presigned ? '（链接有有效期，过期后请重新导出）' : '';
      return ok(`${header}\n📎 下载：${uploaded.url}${expiry}${tail}`);
    }
    return ok(`${header}\n⚠️ 上传到对象存储失败，改用附件：${uploaded.error}${tail}`, [file]);
  }
  return ok(`${header}${tail}`, [file]);
}

/**
 * `/log export [name]` — **导出但不结束**：把日志当前内容写盘并交出去（配了 R2 就发链接），
 * 状态、`currentLogId`、`endedAt` 一律不动，记录继续。
 *
 * 用途：长团中途想要一份快照/发给别人；已 `end` 过的日志也可以用它重新导出一次
 * （`/log on` 续记之后尤其有用：不用真的再 `end` 一次就能拿到新内容）。
 */
async function logExport(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const name = optionString(ctx, 'name')?.trim() || null;
  const log = name ? findLogByName(ctx, deps, name) : activeLog(ctx, deps);
  if (!log) {
    return fail(
      name
        ? `当前上下文里找不到日志「${name}」。用 \`/log list\` 查看名称。`
        : '当前没有可导出的日志；用 `name:` 指定历史日志，或先 `/log new`。',
    );
  }

  const { file, log: exported } = exportLogFile(deps, log);
  const stateLabel = log.state === 'on' ? '记录中' : log.state === 'off' ? '已暂停' : '已结束';
  const header = `已导出日志「${exported.name}」（${stateLabel}）到 \`${exported.fileName}\`，日志状态不变。`;
  if (file.data.length === 0) {
    return ok(`${header}\n（当前没有任何内容，导出的文件是空的。）`);
  }
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
    case 'export':
      return logExport(ctx, deps);
    default:
      return fail('未知的 `/log` 子命令，可用：new / list / on / off / end / export。');
  }
};
