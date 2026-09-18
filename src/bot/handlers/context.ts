/**
 * Context resolution chain — docs §10.2: 局优先于场景，场景优先于全局/骰主默认.
 *
 * Everything a command needs (sheet / hidden-roll thread / house rule / log) is resolved
 * through this module so `/game switch` really does make the whole context follow the session.
 */
import type { HandlerDeps, InteractionContext } from '../../contracts/bot.ts';
import type {
  BindingScope,
  CharacterSheet,
  GameRecord,
  HouseRule,
  LogRecord,
} from '../../contracts/model.ts';
import { HOUSE_RULES } from '../../contracts/model.ts';
import type { BotStore } from '../../contracts/store.ts';
import {
  isLogLineReader,
  isNickStore,
  isRuleSetStore,
  type LogLineReader,
  type NickStore,
  type RuleSetStore,
} from '../../store/extras.ts';
import { createSheet, uniqueSheetName } from './sheets.ts';

/** 骰主默认房规（contract has no config slot for it; the analyser chose the rulebook rule, docs §8.1). */
export const DEFAULT_HOUSE_RULE: HouseRule = 0;

/**
 * Key of the 全局默认卡 row. The manual promises one default card shared by **every** group
 * (docs §5.1: "所有群默认使用同一张初始 COC7 卡"), so this key is intentionally guild-less.
 */
export const GLOBAL_BINDING_KEY = '@global';

// ---- scene / game -------------------------------------------------------

/**
 * 场景（频道或子区）绑定的局；**子区没有自己的指针时继承父频道的**——
 * 子区是父频道的子区域，在 #频道 里开的局/绑的卡，进它的子区说话理应继续生效
 * （否则「跨子区使用」会忽然找不到角色卡）。
 */
function sceneGameId(ctx: InteractionContext, deps: HandlerDeps): string | null {
  const own = deps.store.getSceneGame(ctx.channelId);
  if (own) return own;
  if (ctx.parentChannelId && ctx.parentChannelId !== ctx.channelId) {
    return deps.store.getSceneGame(ctx.parentChannelId);
  }
  return null;
}

/** The session the current scene (channel **or** thread) points at, if any. */
export function currentGame(ctx: InteractionContext, deps: HandlerDeps): GameRecord | null {
  if (!ctx.guildId) return null;
  const id = sceneGameId(ctx, deps);
  if (!id) return null;
  return deps.store.getGame(ctx.guildId, id);
}

export function requireGuild(ctx: InteractionContext): string | null {
  return ctx.guildId;
}

// ---- sheets -------------------------------------------------------------

export interface BindingTarget {
  scope: BindingScope;
  key: string;
}

/** 解析角色卡 / 称呼所需的最小上下文（`InteractionContext` 与 `messageCreate` 都能提供）。 */
export interface SceneKey {
  guildId: string | null;
  channelId: string;
  parentChannelId?: string | null;
  userId: string;
}

/**
 * 局 > 场景 > 全局 default card (docs §10.2)。
 * 场景这一层按「当前场景 → 父频道」两级查：子区里没单独绑卡时继承父频道的绑定，
 * 这样在频道里 tag 的卡进子区照样能用（写入口径不变，仍是当前场景，见 `sheetBindingScope`）。
 */
export function bindingCandidatesFor(store: BotStore, key: SceneKey): BindingTarget[] {
  const targets: BindingTarget[] = [];
  const gameId =
    store.getSceneGame(key.channelId) ??
    (key.parentChannelId && key.parentChannelId !== key.channelId
      ? store.getSceneGame(key.parentChannelId)
      : null);
  const game = key.guildId && gameId ? store.getGame(key.guildId, gameId) : null;
  if (game) targets.push({ scope: 'game', key: game.id });
  if (key.guildId) {
    targets.push({ scope: 'scene', key: key.channelId });
    if (key.parentChannelId && key.parentChannelId !== key.channelId) {
      targets.push({ scope: 'scene', key: key.parentChannelId });
    }
  }
  targets.push({ scope: 'global', key: GLOBAL_BINDING_KEY });
  return targets;
}

/** `InteractionContext` 版本（`/rc` 等处理器用）。 */
export function bindingCandidates(ctx: InteractionContext, deps: HandlerDeps): BindingTarget[] {
  return bindingCandidatesFor(deps.store, ctx);
}

/** 只按 store + 场景解析角色卡（`/log` 记录消息时也要用，但没有完整 deps）。 */
export function resolveSheetFor(store: BotStore, key: SceneKey): CharacterSheet | null {
  for (const target of bindingCandidatesFor(store, key)) {
    const name = store.getBinding(target.scope, target.key, key.userId);
    if (!name) continue;
    const sheet = store.getSheet(key.userId, name);
    if (sheet) return sheet;
  }
  return null;
}

/** 称呼（`/nn`）：本场景 > 全局，与 `resolveNick` 同一口径。 */
export function resolveNickFor(store: BotStore, key: SceneKey): string | null {
  const nicks = nickStore(store);
  return (
    nicks.getNick(key.guildId, key.channelId, key.userId) ??
    nicks.getGlobalNick(key.guildId, key.userId)
  );
}

/** Where `/pc tag` writes: the session when there is one, otherwise the scene / global default. */
export function sheetBindingScope(ctx: InteractionContext, deps: HandlerDeps): BindingTarget {
  const game = currentGame(ctx, deps);
  if (game) return { scope: 'game', key: game.id };
  if (ctx.guildId) return { scope: 'scene', key: ctx.channelId };
  return { scope: 'global', key: GLOBAL_BINDING_KEY };
}

export function resolveSheet(ctx: InteractionContext, deps: HandlerDeps): CharacterSheet | null {
  return resolveSheetFor(deps.store, ctx);
}

/**
 * `/st` and friends need a card even when the player never tagged one. The manual promises a
 * default COC7 card per user, so: adopt the single unbound card when exactly one exists, create
 * a default card when none exists, and stay ambiguous (null → caller explains) when several do.
 */
export function adoptSheet(
  ctx: InteractionContext,
  deps: HandlerDeps,
): { sheet: CharacterSheet; created: boolean; adopted: boolean } | null {
  const active = resolveSheet(ctx, deps);
  if (active) return { sheet: active, created: false, adopted: false };

  const owned = deps.store.listSheets(ctx.userId);
  const target = sheetBindingScope(ctx, deps);
  if (owned.length === 1) {
    deps.store.setBinding(target.scope, target.key, ctx.userId, owned[0].name);
    return { sheet: owned[0], created: false, adopted: true };
  }
  if (owned.length === 0) {
    const base = ctx.displayName && ctx.displayName.trim().length > 0 ? ctx.displayName.trim() : '默认卡';
    const sheet = createSheet(uniqueSheetName(deps.store, ctx.userId, base), 'COC7', deps.now());
    deps.store.putSheet(ctx.userId, sheet);
    deps.store.setBinding(target.scope, target.key, ctx.userId, sheet.name);
    return { sheet, created: true, adopted: true };
  }
  return null;
}

// ---- house rules --------------------------------------------------------

export interface ResolvedRule {
  rule: HouseRule;
  source: 'game' | 'scene' | 'default';
}

/** 本局房规 → 场景房规 → 骰主默认 (docs §8.1/§10.2)；场景房规同样支持子区继承父频道。 */
export function resolveRule(ctx: InteractionContext, deps: HandlerDeps): ResolvedRule {
  const game = currentGame(ctx, deps);
  if (game) {
    const gameRule = deps.store.getGameRule(game.id, ctx.guildId ?? undefined) ?? game.rule;
    if (gameRule !== null && HOUSE_RULES.includes(gameRule)) {
      return { rule: gameRule, source: 'game' };
    }
  }
  const sceneRule = deps.store.getSceneRule(ctx.channelId);
  if (sceneRule !== null && HOUSE_RULES.includes(sceneRule)) {
    return { rule: sceneRule, source: 'scene' };
  }
  if (ctx.parentChannelId && ctx.parentChannelId !== ctx.channelId) {
    const parentRule = deps.store.getSceneRule(ctx.parentChannelId);
    if (parentRule !== null && HOUSE_RULES.includes(parentRule)) {
      return { rule: parentRule, source: 'scene' };
    }
  }
  return { rule: DEFAULT_HOUSE_RULE, source: 'default' };
}

// ---- logs ---------------------------------------------------------------

/**
 * 当前**场景**（频道或子区）自己的日志。
 * 日志按场景隔离：谁开的日志就记谁的发言，不同子区可以各自同时开 (docs §11.1)。
 */
export function scopedLogs(ctx: InteractionContext, deps: HandlerDeps): LogRecord[] {
  return deps.store.listSceneLogs(ctx.channelId, ctx.guildId ?? undefined);
}

/** The log that is currently "在记录" for this scene (`/log on|off|end` default target). */
export function activeLog(ctx: InteractionContext, deps: HandlerDeps): LogRecord | null {
  const logs = scopedLogs(ctx, deps);
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    if (logs[i].state === 'on') return logs[i];
  }
  // 兜底：局指针指向本场景的日志时也认
  const game = currentGame(ctx, deps);
  if (game?.currentLogId) {
    const pointed = deps.store.getLog(game.currentLogId);
    if (pointed && scopedLogs(ctx, deps).some((log) => log.id === pointed.id)) return pointed;
    if (pointed && (pointed.channelId === ctx.channelId || pointed.sceneIds.includes(ctx.channelId))) {
      return pointed;
    }
  }
  return null;
}

/** The log that is recording right now (uniqueness invariant, docs §11.1). */
export function recordingLog(ctx: InteractionContext, deps: HandlerDeps): LogRecord | null {
  return scopedLogs(ctx, deps).find((log) => log.state === 'on') ?? null;
}

export function findLogByName(
  ctx: InteractionContext,
  deps: HandlerDeps,
  name: string,
): LogRecord | null {
  const needle = name.trim();
  return scopedLogs(ctx, deps).find((log) => log.name === needle) ?? null;
}

export function logLineReader(store: BotStore): LogLineReader | null {
  return isLogLineReader(store) ? store : null;
}

// ---- 称呼 (/nn) + 默认规则集 (/rules set) — optional store extras --------

class MemoryNickStore implements NickStore {
  private channel = new Map<string, string>();
  private global = new Map<string, string>();

  private channelKey(guildId: string | null, channelId: string, userId: string): string {
    return `${guildId ?? '@dm'}|${channelId}|${userId}`;
  }

  private globalKey(guildId: string | null, userId: string): string {
    return `${guildId ?? '@dm'}|${userId}`;
  }

  getNick(guildId: string | null, channelId: string, userId: string): string | null {
    return this.channel.get(this.channelKey(guildId, channelId, userId)) ?? null;
  }

  setNick(guildId: string | null, channelId: string, userId: string, name: string | null): void {
    const key = this.channelKey(guildId, channelId, userId);
    if (name === null) this.channel.delete(key);
    else this.channel.set(key, name);
  }

  getGlobalNick(guildId: string | null, userId: string): string | null {
    return this.global.get(this.globalKey(guildId, userId)) ?? null;
  }

  setGlobalNick(guildId: string | null, userId: string, name: string | null): void {
    const key = this.globalKey(guildId, userId);
    if (name === null) this.global.delete(key);
    else this.global.set(key, name);
  }

  clearNicks(userId: string): number {
    let removed = 0;
    for (const [key] of this.channel) {
      if (key.endsWith(`|${userId}`)) {
        this.channel.delete(key);
        removed += 1;
      }
    }
    for (const [key] of this.global) {
      if (key.endsWith(`|${userId}`)) {
        this.global.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

const fallbackNicks = new MemoryNickStore();

export function nickStore(store: BotStore): NickStore {
  return isNickStore(store) ? store : fallbackNicks;
}

class MemoryRuleSetStore implements RuleSetStore {
  private rows = new Map<string, string>();

  getDefaultRuleSet(guildId: string | null): string | null {
    return this.rows.get(guildId ?? '@dm') ?? null;
  }

  setDefaultRuleSet(guildId: string | null, rule: string | null): void {
    const key = guildId ?? '@dm';
    if (rule === null) this.rows.delete(key);
    else this.rows.set(key, rule);
  }
}

const fallbackRuleSets = new MemoryRuleSetStore();

export function ruleSetStore(store: BotStore): RuleSetStore {
  return isRuleSetStore(store) ? store : fallbackRuleSets;
}

/** Display nickname: 频道称呼 > 全局称呼 (docs §12.1). */
export function resolveNick(ctx: InteractionContext, deps: HandlerDeps): string | null {
  return resolveNickFor(deps.store, ctx);
}
