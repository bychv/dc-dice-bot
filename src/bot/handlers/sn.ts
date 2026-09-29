/**
 * `/sn` — 统计昵称同步开关（docs §12.4）。
 *
 *   /sn on   开启：当前场景正在记录时**立刻**把昵称改成 `角色名 |DEX70 HP12/12 SAN70`；
 *            没在记录则等下次开 log（`/log new`、`/log on`、`/game start`）时自动改。
 *   /sn off  关闭并**立刻改回原名**。
 *   /sn show 查看状态 + 当前场景卡对应的目标昵称预览。
 *
 * 昵称是**服务器级**的，所以只支持在服务器里用；改名失败（缺「管理昵称」权限 / 服主 /
 * bot 角色层位不够）会把 Discord 的报错原样带回来，便于排查。
 */
import type { CommandHandler, HandlerDeps, InteractionContext, ReplyPayload } from '../../contracts/bot.ts';
import type { NickSyncState } from '../../contracts/model.ts';
import { ok, fail, subcommand } from './options.ts';
import { nickSyncStore, type SceneKey } from './context.ts';
import {
  NICK_LIMIT,
  applySceneNicknames,
  describeOutcome,
  sceneStillRecording,
  targetNicknameFor,
} from './nickSync.ts';

function sceneKey(ctx: InteractionContext): SceneKey {
  return {
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    parentChannelId: ctx.parentChannelId,
    userId: ctx.userId,
  };
}

async function snOn(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const store = nickSyncStore(deps.store);
  const guildId = ctx.guildId as string;
  const existing: NickSyncState | null = store.getNickSync(guildId, ctx.userId);
  const next: NickSyncState =
    existing?.original === undefined ? { enabled: true } : { enabled: true, original: existing.original };
  store.setNickSync(guildId, ctx.userId, next);

  const preview = targetNicknameFor(deps.store, sceneKey(ctx));
  const lines = ['已开启统计昵称同步。'];
  if (preview) {
    lines.push(`目标昵称：\`${preview}\``);
  } else {
    lines.push('当前场景没有生效的角色卡，先 `/pc tag` 绑定卡片；改名会在下次开 log 时进行。');
  }

  if (sceneStillRecording(ctx, deps)) {
    const outcome = await applySceneNicknames(ctx, deps);
    const note = describeOutcome(outcome, '同步');
    if (outcome.failed > 0 && outcome.changed === 0) {
      return fail(`${lines.join('\n')}\n改名失败：${outcome.failures.join('；')}`);
    }
    if (note) lines.push(note);
    else if (preview) lines.push('当前昵称已经是目标值，无需改动。');
  } else {
    lines.push('当前场景没有在记录的日志；`/log new`、`/log on` 或 `/game start` 时会自动改，`/log off`、`/log end` 时改回。');
  }
  return ok(lines.join('\n'));
}

async function snOff(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const store = nickSyncStore(deps.store);
  const guildId = ctx.guildId as string;
  const state = store.getNickSync(guildId, ctx.userId);
  if (!state) return fail('你还没有开启过统计昵称同步。');

  const lines: string[] = [];
  if (state.original !== undefined) {
    try {
      await deps.platform.setMemberNickname(guildId, ctx.userId, state.original);
      lines.push(state.original === null ? '已把昵称改回默认用户名。' : `已把昵称改回原名「${state.original}」。`);
    } catch (error) {
      return fail(`关闭失败：改回原名时 Discord 报错 —— ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  store.setNickSync(guildId, ctx.userId, null);
  lines.push('已关闭统计昵称同步（之后开 log 不再改你的昵称）。');
  return ok(lines.join('\n'));
}

function snShow(ctx: InteractionContext, deps: HandlerDeps): ReplyPayload {
  const store = nickSyncStore(deps.store);
  const guildId = ctx.guildId as string;
  const state = store.getNickSync(guildId, ctx.userId);
  const preview = targetNicknameFor(deps.store, sceneKey(ctx));
  const lines = [
    state?.enabled ? '统计昵称同步：**已开启**' : '统计昵称同步：**未开启**（用 `/sn on` 开启）',
  ];
  if (state?.original !== undefined) {
    lines.push(`改名前的昵称已记下：${state.original === null ? '（原本没有自定义昵称）' : `「${state.original}」`}，log off 时改回。`);
  }
  lines.push(
    preview
      ? `当前场景生效卡对应的昵称：\`${preview}\``
      : '当前场景没有生效的角色卡（`/pc tag` 绑定后才会改名）。',
  );
  lines.push(`格式：\`角色名 |DEX敏捷 HP生命/上限 SAN理智\`，上限按 (体质+体型)/10；昵称最长 ${NICK_LIMIT} 字符。`);
  lines.push('开 log 时自动改，`/log off`、`/log end` 时改回原名。');
  return ok(lines.join('\n'));
}

export const snHandler: CommandHandler = async (ctx, deps) => {
  if (!ctx.guildId) return fail('`/sn` 只能在服务器里使用：服务器昵称是每个服务器各自的。');
  const sub = subcommand(ctx) ?? 'show';
  if (sub === 'on') return snOn(ctx, deps);
  if (sub === 'off') return snOff(ctx, deps);
  return snShow(ctx, deps);
};
