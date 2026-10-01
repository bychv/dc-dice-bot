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
import type { GameRecord } from '../../contracts/model.ts';
import { currentGame } from './context.ts';
import { mentionChannel, mentionUser } from './format.ts';
import { clamp, fail, optionBoolean, optionChannel, optionString, optionUser } from './options.ts';
import { performRoll, withActor } from './roll.ts';

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

/**
 * 当前场景**自己**绑定的局（**不含**父频道继承）：
 *   1. 场景指针（`/game start`/`switch` 写的那张表）；
 *   2. 这个频道/子区本身就是某局的**主场景子区**或**暗骰子区**（反查，防止指针被改走导致张冠李戴）。
 *
 * 为什么 `/rh` 要区分"自己的局"与"继承来的局"：开局一般在**单独子区**，几个局又常共用同一个父频道
 * （父频道指针只会指向其中某一个，且可能是很久以前的测试局）。若子区自己没有绑定局，
 * 按下面的策略改用"**最近开局的 active 局**"，而不是照着父频道指针走。
 */
function ownGame(ctx: InteractionContext, deps: HandlerDeps): GameRecord | null {
  if (!ctx.guildId) return null;
  const direct = deps.store.getSceneGame(ctx.channelId);
  if (direct) {
    const game = deps.store.getGame(ctx.guildId, direct);
    if (game && game.status === 'active') return game;
  }
  return (
    deps.store
      .listGames(ctx.guildId)
      .find(
        (candidate) =>
          candidate.status === 'active' &&
          (candidate.sceneThreadId === ctx.channelId || candidate.hiddenThreadId === ctx.channelId),
      ) ?? null
  );
}

/**
 * **最近开局的 active 局**的暗骰子区（docs §4.2 增补）。
 *
 * 判据只看"局"本身：`status === 'active'`、有暗骰子区、`startedAt` 最新（**不看日志开关状态**——
 * 日志中途 `/log off` 是常事，不代表这个团不在跑）。多个局共用父频道时，靠它挑出"现在在打的团"。
 */
/** 局的创建顺序（`#12` > `#5`）：`startedAt` 相同时（时钟被冻结 / 同一秒连开两局）用它排序。 */
function gameNumber(game: GameRecord): number {
  const parsed = Number(game.id.replace(/^#/, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** `a` 是否比 `b` 更晚开局。 */
function isNewerGame(a: GameRecord, b: GameRecord): boolean {
  if (a.startedAt !== b.startedAt) return a.startedAt > b.startedAt;
  return gameNumber(a) > gameNumber(b);
}

function newestActiveGame(ctx: InteractionContext, deps: HandlerDeps): GameRecord | null {
  if (!ctx.guildId) return null;
  const candidates = deps.store
    .listGames(ctx.guildId)
    .filter((candidate) => candidate.status === 'active' && candidate.hiddenThreadId);
  if (candidates.length === 0) return null;
  return candidates.reduce((newest, candidate) => (isNewerGame(candidate, newest) ? candidate : newest));
}

export const rhHandler: CommandHandler = async (ctx, deps) => {
  const text = optionString(ctx, 'text');
  const keeperId = optionUser(ctx, 'keeper');
  const explicitThread = optionChannel(ctx, 'thread');
  const reset = optionBoolean(ctx, 'reset') ?? false;

  /**
   * 目标局（docs §4.2 增补，2026-10-01 定稿）：
   *   1. 本场景**自己**绑定的局（场景指针 / 本身就是某局的主场景子区或暗骰子区）→ 直接用，不被覆盖；
   *   2. 否则用**最近开局的 active 局**——**覆盖**"子区继承父频道指针"那条老规则
   *      （几个局共用一个父频道时，父频道指针往往还停在很久以前的某个局上）；
   *   3. 都没有才退回父频道继承来的局。
   */
  const own = ownGame(ctx, deps);
  const newest = newestActiveGame(ctx, deps);
  const inherited = currentGame(ctx, deps);
  const game = own ?? newest ?? inherited;
  /** 是否属于"用了最近开局的局（而不是父频道继承来的）"这条路（回执里要说明）。 */
  const borrowedFromNewest = !own && newest !== null && newest.id !== inherited?.id;
  /** 非"自己的局"时，最终用来投递的局（最近开局的，其次父频道继承来的）。 */
  const fallbackGame = own ? null : newest ?? inherited;

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

  // 投递优先级：显式 thread > 本局暗骰子区（可能是"最近开局的局"，见上）> 场景级登记
  // > 自动子区缓存 > 新建。失效来源（子区被删除 / Bot 被移出）会清理该来源并继续回落（docs §16.11）。
  const candidates: Array<{ id: string; source: 'explicit' | 'game' | 'scene' | 'auto'; owner?: GameRecord }> = [];
  if (explicitThread) {
    candidates.push({ id: explicitThread, source: 'explicit' });
  } else {
    // ① 本场景**自己**绑的局（场景指针 / 本身就是该局的主场景子区或暗骰子区）
    if (own?.hiddenThreadId) candidates.push({ id: own.hiddenThreadId, source: 'game', owner: own });
    // ② 场景级登记（`/rh thread:` 显式指定过）——显式选择优先于下面的隐式规则
    const sceneRegistered = deps.store.getRegisteredThread(ctx.channelId);
    if (sceneRegistered) candidates.push({ id: sceneRegistered, source: 'scene' });
    // ③ 没有自己的局 → 最近开局的 active 局（覆盖"子区继承父频道指针"那条老规则）
    if (fallbackGame?.hiddenThreadId) {
      candidates.push({ id: fallbackGame.hiddenThreadId, source: 'game', owner: fallbackGame });
    }
    const cachedAuto = deps.store.getRegisteredThread(autoKey);
    if (cachedAuto) candidates.push({ id: cachedAuto, source: 'auto' });
  }

  const invalidated: string[] = [];
  let target: string | null = null;
  /** 最终用的暗骰子区是不是"某个局的"（回执里说明，免得以为投错团）。 */
  let usedGameHidden = false;
  for (const candidate of candidates) {
    const parent = await deps.platform.threadParent(candidate.id);
    if (parent) {
      target = candidate.id;
      usedGameHidden = candidate.source === 'game';
      break;
    }
    if (candidate.source === 'explicit') {
      // 显式指定绝不静默改投
      return fail(`目标 ${mentionChannel(candidate.id)} 不是子区（Thread），暗骰不会静默改投到别处。`);
    }
    if (candidate.source === 'game' && candidate.owner) {
      candidate.owner.hiddenThreadId = null;
      deps.store.putGame(candidate.owner);
      invalidated.push(
        `局 ${candidate.owner.id} ${candidate.owner.name} 的暗骰子区 ${mentionChannel(candidate.id)} 已失效`,
      );
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
  // 投递到私密子区的那一份自己带 `【使用者】`（这条路不经过 handler 回执的统加前缀）；
  // 回给发起者的 ephemeral 回执用不带前缀的 rawBody，由 adapter 统一加，避免叠两层。
  const rawBody = outcome.lines.join('\n');
  const body = withActor(ctx, deps, rawBody);

  // 降级时骰值无处投递：明说 KP 看不到，免得玩家以为 KP 已知情
  const degradationNotes = game
    ? [
        `本局 KP ${mentionUser(game.keeperId)} 看不到这次暗骰（没有可用的私密子区），需要时请自行告知。`,
        ...extraNotes,
      ]
    : [];
  const degradedExtra = [...invalidated, ...degradationNotes].join('\n');

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
    borrowedFromNewest && usedGameHidden && game
      ? `本场景没有开局，已按**最近开局的局**默认投到 ${game.id} ${game.name} 的暗骰子区（可用 \`/rh thread:<子区>\` 为本场景单独指定）。`
      : '',
    ...invalidated,
    insider ? '' : '你的结果只在本条回执里可见（其他人看不到）：',
    rawBody,
    keeperIgnored,
    autoCreated ? '该私密子区已自动创建并复用，之后 `/rh` 会继续投到这里。' : '',
    explicitThread || (!game?.hiddenThreadId && !autoCreated && !(borrowedFromNewest && usedGameHidden))
      ? '注意：若该子区是公开子区，其可见范围等于父频道——父频道对全服开放时不具备保密性。'
      : '',
  ].filter((line) => line.length > 0);
  return hiddenReceipt(clamp(lines.join('\n')));
};
