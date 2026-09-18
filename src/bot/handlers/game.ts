/**
 * `/game` — 对局管理 (docs §10.1): start / list / switch / state / end.
 *
 * A session carries KP, main scene, 暗骰子区, sheet bindings, house rule and the log stream;
 * `/game switch` only moves the scene pointer because every other lookup goes through
 * `handlers/context.ts` (局优先于场景).
 */
import type { CommandHandler, HandlerDeps, InteractionContext, OutgoingFile, ReplyPayload } from '../../contracts/bot.ts';
import type { GameRecord } from '../../contracts/model.ts';
import { activeLog, currentGame, resolveRule } from './context.ts';
import {
  fmtGameLine,
  fmtLogLine,
  fmtRule,
  fmtStamp,
  mentionChannel,
  mentionUser,
  sceneKind,
} from './format.ts';
import { exportLogRecord, pauseAbandonedLogs, startGame } from './gameCore.ts';
import {
  clamp,
  fail,
  ok,
  optionBoolean,
  optionChannel,
  optionString,
  optionUser,
  subcommand,
} from './options.ts';

function mayManage(ctx: InteractionContext, game: GameRecord): boolean {
  return ctx.isAdmin || ctx.userId === game.keeperId;
}

async function gameStart(
  ctx: InteractionContext,
  deps: HandlerDeps,
): Promise<ReplyPayload> {
  if (!ctx.guildId) {
    return fail('对局是服务器级概念，DM 中不能使用 `/game start`（可直接用 `/log new` 建场景日志）。');
  }
  const name = optionString(ctx, 'name')?.trim() || `${ctx.channelName} · ${fmtStamp(deps.now())}`;
  const keeperId = optionUser(ctx, 'keeper') ?? ctx.userId;
  const threadId = optionChannel(ctx, 'thread');
  const here = optionBoolean(ctx, 'here') ?? false;
  const notes: string[] = [];
  if (threadId && here) notes.push('同时给出 thread 与 here 时以 `thread` 为准。');

  const result = await startGame(ctx, deps, { name, keeperId, threadId, here });

  const lines = [
    `已开局 ${result.game.id} ${result.game.name}（KP:${mentionUser(keeperId)}）`,
    `主场景：${mentionChannel(result.sceneId)}${
      result.game.sceneThreadCreatedByBot
        ? '（新建公开子区）'
        : threadId
          ? '（复用已有子区）'
          : '（就地使用当前场景）'
    }`,
    `暗骰子区：${mentionChannel(result.game.hiddenThreadId)}`,
    `日志：${result.log ? `「${result.log.name}」已开始记录` : '未开启'}`,
    `当前场景 ${mentionChannel(ctx.channelId)} 已切到本局；其他局不受影响。`,
    ...notes,
    ...result.notes.map((note) => `注意：${note}`),
  ];
  return ok(clamp(lines.join('\n')));
}

async function gameList(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  if (!ctx.guildId) return fail('对局是服务器级概念，DM 中没有局列表。');
  const games = deps.store.listGames(ctx.guildId);
  if (games.length === 0) return ok('本服还没有任何局。用 `/game start` 开一局吧。');
  return ok(clamp(games.map(fmtGameLine).join('\n')));
}

async function gameState(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const game = currentGame(ctx, deps);
  if (!game) {
    return ok(
      `当前场景 ${mentionChannel(ctx.channelId)}（${sceneKind(ctx)}）未绑定任何局。\n` +
        '`/game start` 开局，或在 `/log new` 时自动建局。',
    );
  }
  const rule = resolveRule(ctx, deps);
  const log = activeLog(ctx, deps);
  const lines = [
    `场景：${mentionChannel(ctx.channelId)}（${sceneKind(ctx)}）`,
    `所属局：${fmtGameLine(game)}`,
    `房规：${fmtRule(rule.rule, rule.source)}`,
    `日志：${log ? fmtLogLine(log, true) : '没有正在记录的日志（用 `/log new` 开一条）'}`,
  ];
  return ok(clamp(lines.join('\n')));
}

async function gameSwitch(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  if (!ctx.guildId) return fail('对局是服务器级概念，DM 中不能切换局。');
  const ref = optionString(ctx, 'game')?.trim();
  if (!ref) return fail('请指定要切换到的局，例如 `/game switch game:#1` 或 `game:阿卡姆`。');

  const target = deps.store.findGame(ctx.guildId, ref);
  if (!target) return fail(`找不到局「${ref}」。可用 \`/game list\` 查看本服的局。`);
  if (target.status === 'ended') return fail(`局 ${target.id} ${target.name} 已结束，不能切换。`);
  if (!mayManage(ctx, target)) return fail('只有服务器管理员或该局 KP 可以切换局。');

  const previous = deps.store.getSceneGame(ctx.channelId);
  deps.store.setSceneGame(ctx.channelId, ctx.guildId, target.id);
  const paused = previous && previous !== target.id ? pauseAbandonedLogs(deps, ctx.guildId, previous) : [];

  const rule = resolveRule(ctx, deps);
  const log = activeLog(ctx, deps);
  const lines = [
    `已把当前场景 ${mentionChannel(ctx.channelId)} 切换到 ${target.id} ${target.name}。`,
    `KP：${mentionUser(target.keeperId)}`,
    `暗骰子区：${mentionChannel(target.hiddenThreadId)}`,
    `房规：${fmtRule(rule.rule, rule.source)}`,
    `日志：${log ? fmtLogLine(log, true) : '本局没有正在记录的日志，请先 `/log new`'}`,
  ];
  if (paused.length > 0) {
    lines.push(`旧局已无场景，其日志已自动暂停：${paused.map((l) => `「${l.name}」`).join('、')}`);
  }
  return ok(clamp(lines.join('\n')));
}

async function gameEnd(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  if (!ctx.guildId) return fail('对局是服务器级概念，DM 中不能结束局。');
  const ref = optionString(ctx, 'game')?.trim();
  const target = ref ? deps.store.findGame(ctx.guildId, ref) : currentGame(ctx, deps);
  if (!target) {
    return fail(ref ? `找不到局「${ref}」。` : '当前场景没有绑定任何局；用 `game:` 指定要结束的局。');
  }
  if (target.status === 'ended') return fail(`局 ${target.id} ${target.name} 已经结束了。`);
  if (!mayManage(ctx, target)) return fail('只有该局 KP 或服务器管理员可以结束这一局。');

  const archive = optionBoolean(ctx, 'archive') ?? false;

  // 自动收尾：本局所有未结束的日志（含暂停中的）逐条结束并导出。
  // 配了对象存储（R2）就上传发链接；未配或上传失败时把文件作为附件发出去。
  const logs = deps.store
    .listLogs({ gameId: target.id, channelId: '', guildId: ctx.guildId ?? undefined })
    .filter((log) => log.state !== 'ended');
  const files: OutgoingFile[] = [];
  const exported: string[] = [];
  const emptyLogs: string[] = [];
  const uploadFailures: string[] = [];
  for (const log of logs) {
    const { log: ended, file } = exportLogRecord(deps, log, deps.now());
    if (file.data.length === 0) {
      // 0 字节附件会被 Discord 拒绝：只报告，不附带
      emptyLogs.push(`「${ended.name}」（无内容）`);
      continue;
    }
    if (deps.logUpload) {
      const uploaded = await deps.logUpload.upload(file);
      if (uploaded.ok) {
        exported.push(`「${ended.name}」→ ${uploaded.url}${uploaded.presigned ? '（链接有有效期）' : ''}`);
        continue;
      }
      uploadFailures.push(`「${ended.name}」：${uploaded.error}`);
    }
    files.push(file);
    exported.push(`「${ended.name}」→ ${ended.fileName}`);
  }
  exported.push(...emptyLogs);

  deps.store.clearScenesOfGame(target.id, ctx.guildId ?? undefined);
  target.status = 'ended';
  target.endedAt = deps.now().toISOString();
  deps.store.putGame(target);

  const archived: string[] = [];
  if (archive) {
    if (target.sceneThreadId && target.sceneThreadCreatedByBot) {
      try {
        await deps.platform.archiveThread(target.sceneThreadId);
        archived.push(`主场景 ${mentionChannel(target.sceneThreadId)}`);
      } catch {
        // archive failures must not block 结束
      }
    }
    if (target.hiddenThreadId) {
      try {
        await deps.platform.archiveThread(target.hiddenThreadId);
        archived.push(`暗骰区 ${mentionChannel(target.hiddenThreadId)}`);
      } catch {
        // ignore
      }
    }
  }

  const lines = [
    `已结束 ${target.id} ${target.name}（KP:${mentionUser(target.keeperId)}）。`,
    exported.length > 0 ? `导出日志：\n${exported.map((e) => `· ${e}`).join('\n')}` : '本局没有未结束的日志。',
    uploadFailures.length > 0
      ? `⚠️ 以下日志上传对象存储失败，已改用附件：${uploadFailures.join('；')}`
      : '',
    archive
      ? archived.length > 0
        ? `已归档本局自建子区：${archived.join('、')}（可在客户端手动取消归档）`
        : '要求归档，但本局没有 Bot 自建的主场景子区；`thread:` 指定的外部子区一律不动。'
      : '子区保持原样（未归档）。',
    '本局场景已解绑；角色卡数据与其他局不受影响。',
  ];
  return ok(clamp(lines.join('\n')), files);
}

export const gameHandler: CommandHandler = async (ctx, deps) => {
  switch (subcommand(ctx)) {
    case 'start':
      return gameStart(ctx, deps);
    case 'list':
      return gameList(ctx, deps);
    case 'switch':
      return gameSwitch(ctx, deps);
    case 'state':
      return gameState(ctx, deps);
    case 'end':
      return gameEnd(ctx, deps);
    default:
      return fail('未知的 `/game` 子命令，可用：start / list / switch / state / end。');
  }
};
