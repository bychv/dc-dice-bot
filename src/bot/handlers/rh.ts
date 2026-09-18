/**
 * `/rh` — 暗骰 (docs §4.2, §16.4).
 *
 * Delivery priority: 本次显式 thread > 本局暗骰子区 > 场景级登记 thread > 自动子区
 * `暗骰 · <场景名>`. Threads cannot nest, so the auto hidden thread is created under the
 * scene's **parent channel**; 每个子区场景各有一个自己的自动暗骰子区（不共用）。
 *
 * Membership (docs §4.2): 开局后**只把指定的 KP 拉进私密子区**；其他发起者不进入子区，
 * 只拿到一条仅自己可见（ephemeral）的回显。无局时才退回「掷骰者 + keeper」的口径。
 */
import type { CommandHandler, HandlerDeps, InteractionContext, ReplyPayload } from '../../contracts/bot.ts';
import { currentGame } from './context.ts';
import { mentionChannel, mentionUser } from './format.ts';
import { clamp, fail, optionBoolean, optionChannel, optionString, optionUser } from './options.ts';
import { performRoll } from './roll.ts';

function degraded(reason: string, body: string, extra?: string): ReplyPayload {
  return {
    content: `暗骰降级为仅你可见的回执：${reason}\n\n${body}${extra ? `\n${extra}` : ''}`,
    ephemeral: true,
  };
}

/**
 * 暗骰的所有回执都**只给发起者**（ephemeral）：频道里不出现任何暗骰相关消息，
 * 也就不会给全体成员造成通知/刷屏；真正的骰值只落在私密子区里。
 */
function hiddenReceipt(content: string): ReplyPayload {
  return { content, ephemeral: true };
}

async function sceneName(ctx: InteractionContext, deps: HandlerDeps, parentId: string): Promise<string> {
  // 子区场景用**子区自己的名字**（不同子区各自一个暗骰区），频道场景就是频道名。
  // adapter 在拿不到名字时会回填字面量 `unknown`，那种占位值不能当场景名用。
  const own = ctx.channelName?.trim();
  if (own && own !== 'unknown') return own;
  const parent = await deps.platform.threadName(parentId);
  return parent && parent.trim().length > 0 ? parent : ctx.channelId;
}

/**
 * 自动子区按**场景**（频道或子区）缓存复用，名字取场景名 `暗骰 · <场景名>`：
 * 不同子区各自开各自的暗骰子区（docs §4.2「首次创建，之后一直复用」）。
 * 场景 id 是雪花号，不会与 `auto:` 前缀冲突。
 */
function autoThreadKey(sceneId: string): string {
  return `auto:${sceneId}`;
}

export const rhHandler: CommandHandler = async (ctx, deps) => {
  const text = optionString(ctx, 'text');
  const keeperId = optionUser(ctx, 'keeper');
  const explicitThread = optionChannel(ctx, 'thread');
  const reset = optionBoolean(ctx, 'reset') ?? false;
  const game = currentGame(ctx, deps);

  // 场景是子区时，父频道才是暗骰子区的落点（子区不能内嵌子区）
  const parentId = ctx.parentChannelId ?? ctx.channelId;
  const autoKey = autoThreadKey(ctx.channelId);

  // 有局时 KP 只认 `/game`：`keeper:` 不再改变成员。给了就在**每一条**回执路径里说明，
  // 否则玩家会以为对方能看到这次暗骰（docs §4.2）。
  const keeperIgnored =
    game && keeperId
      ? `本局 KP 由 \`/game\` 指定为 ${mentionUser(game.keeperId)}，\`keeper:\` 在有局时不改变知情范围。`
      : '';
  /** 降级路径要额外说明的提示（无子区可投时 KP 也看不到）。 */
  const extraNotes = [keeperIgnored].filter((note) => note.length > 0);

  // reset 只清场景级登记（含自动子区缓存），本局暗骰子区不受影响
  if (reset) {
    deps.store.setRegisteredThread(ctx.channelId, null);
    deps.store.setRegisteredThread(autoKey, null);
    const lines = [`已取消本场景 ${mentionChannel(ctx.channelId)} 的暗骰子区登记。`];
    lines.push(
      game?.hiddenThreadId
        ? `本局 ${game.id} 的暗骰子区仍为 ${mentionChannel(game.hiddenThreadId)}，\`/rh\` 会继续投递到那里。`
        : '之后 `/rh` 会回到自动创建的 `暗骰 · <场景名>` 私密子区。',
    );
    lines.push(...extraNotes);
    return hiddenReceipt(lines.join('\n'));
  }

  // 给出 thread 即持久化登记为本场景默认
  if (explicitThread) deps.store.setRegisteredThread(ctx.channelId, explicitThread);

  // 投递优先级：显式 thread > 本局暗骰子区 > 场景级登记 > 自动子区缓存 > 新建
  // 失效来源（子区被删除 / Bot 被移出）会清理该来源并继续回落（docs §16.11）。
  const candidates: Array<{ id: string; source: 'explicit' | 'game' | 'scene' | 'auto' }> = [];
  if (explicitThread) {
    candidates.push({ id: explicitThread, source: 'explicit' });
  } else {
    if (game?.hiddenThreadId) candidates.push({ id: game.hiddenThreadId, source: 'game' });
    const sceneRegistered = deps.store.getRegisteredThread(ctx.channelId);
    if (sceneRegistered) candidates.push({ id: sceneRegistered, source: 'scene' });
    const cachedAuto = deps.store.getRegisteredThread(autoKey);
    if (cachedAuto) candidates.push({ id: cachedAuto, source: 'auto' });
  }

  const invalidated: string[] = [];
  let target: string | null = null;
  for (const candidate of candidates) {
    const parent = await deps.platform.threadParent(candidate.id);
    if (parent) {
      target = candidate.id;
      break;
    }
    if (candidate.source === 'explicit') {
      // 显式指定绝不静默改投
      return fail(`目标 ${mentionChannel(candidate.id)} 不是子区（Thread），暗骰不会静默改投到别处。`);
    }
    if (candidate.source === 'game' && game) {
      game.hiddenThreadId = null;
      deps.store.putGame(game);
      invalidated.push(`本局暗骰子区 ${mentionChannel(candidate.id)} 已失效`);
    } else if (candidate.source === 'scene') {
      deps.store.setRegisteredThread(ctx.channelId, null);
      invalidated.push(`场景登记的暗骰子区 ${mentionChannel(candidate.id)} 已失效`);
    } else {
      deps.store.setRegisteredThread(autoKey, null);
      invalidated.push(`自动暗骰子区 ${mentionChannel(candidate.id)} 已失效`);
    }
  }

  // 只登记不掷骰（docs §4.2：`/rh thread:#暗骰区` 不带 text）
  if (explicitThread && (!text || text.trim().length === 0)) {
    if (target === null) {
      return fail(`目标 ${mentionChannel(explicitThread)} 不是子区（Thread），无法登记。`);
    }
    return hiddenReceipt(
      [
        `已把本场景 ${mentionChannel(ctx.channelId)} 的暗骰子区登记为 ${mentionChannel(target)}。`,
        '之后 `/rh <原文>` 会投递到这里；`/rh reset:true` 可取消登记。',
        ...extraNotes,
      ].join('\n'),
    );
  }

  const outcome = performRoll(ctx, deps, text, { compact: false });
  if (!outcome.ok) return fail(`掷骰失败：${outcome.error ?? '无法解析的骰式'}`);
  const body = `【${ctx.displayName}】${outcome.lines.join('\n')}`;

  // 降级时骰值无处投递：明说 KP 看不到，免得玩家以为 KP 已知情
  const degradationNotes = game
    ? [
        `本局 KP ${mentionUser(game.keeperId)} 看不到这次暗骰（没有可用的私密子区），需要时请自行告知。`,
        ...extraNotes,
      ]
    : [];
  const degradedExtra = degradationNotes.join('\n');

  let autoCreated = false;
  if (target === null) {
    // 兜底：父频道下的 `暗骰 · <场景名>`（每个场景一个，子区之间不共用），创建后缓存复用
    if (!(await deps.platform.canCreateThreads(parentId))) {
      return degraded('Bot 在该频道没有创建私密子区的权限（或该场景不支持子区）。', body, degradedExtra);
    }
    try {
      const name = await sceneName(ctx, deps, parentId);
      target = await deps.platform.createPrivateThread(parentId, `暗骰 · ${name}`);
      deps.store.setRegisteredThread(autoKey, target);
      autoCreated = true;
    } catch {
      return degraded('创建私密子区失败（或该场景不支持子区）。', body, degradedExtra);
    }
  }

  // 成员规则（docs §4.2）：本局 KP 由 `/game start keeper:` 指定，开局后 `/rh` **只拉入这个 KP**；
  // 发起者若不是 KP 就不进子区，只靠下面的 ephemeral 回显看结果（不回显给任何其他人）。
  // `keeper:` 选项只在**无局**时生效（场景级暗骰）。
  const members = new Set<string>();
  if (game) {
    members.add(game.keeperId);
  } else {
    members.add(ctx.userId);
    if (keeperId) members.add(keeperId);
  }
  const insider = members.has(ctx.userId);
  /** 回执文案用的「本局 KP」；无局时退回 `keeper:` 选项（可能为空）。 */
  const designated: string | null = game ? game.keeperId : keeperId;
  for (const member of members) {
    try {
      await deps.platform.addThreadMember(target, member);
    } catch {
      // a member add failure must not lose the roll
    }
  }

  await deps.platform.sendMessage(target, { content: body });

  // 只有发起者能看到这条回执（ephemeral）；频道里不出现任何暗骰消息，因此不会有全体通知。
  // 不是子区成员的人（非 KP）在频道里也看不到骰值，所以结果必须带在这条回显里。
  const lines = [
    insider
      ? `✅ 暗骰已投递到 ${mentionChannel(target)}（仅你与知情者可见，频道内未发任何提示）。`
      : `✅ 暗骰已投递到 ${mentionChannel(target)}（私密子区，仅本局 KP ${mentionUser(
          designated,
        )} 可见；频道内未发任何提示）。`,
    insider ? '' : '你的结果只在本条回执里可见（其他人看不到）：',
    body,
    keeperIgnored,
    autoCreated ? '该私密子区已自动创建并复用，之后 `/rh` 会继续投到这里。' : '',
    explicitThread || (!game?.hiddenThreadId && !autoCreated)
      ? '注意：若该子区是公开子区，其可见范围等于父频道——父频道对全服开放时不具备保密性。'
      : '',
  ].filter((line) => line.length > 0);
  return hiddenReceipt(clamp(lines.join('\n')));
};
