/**
 * `/sn` 统计昵称同步（docs §12.4）。
 *
 * 规则：
 *   - **开 log** 时（`/log new`、`/log on`、`/game start`）把**开启了 `/sn`** 的成员的服务器昵称
 *     改成 `角色名 |DEX70 HP12/12 SAN70`；
 *   - **log off / log end**（本场景不再有在记录的日志）时**改回原名**。
 *
 * 细节：
 *   - 角色名/数值都来自该成员在**当前场景**解析到的角色卡（局 → 场景 → 父频道 → 用户级 → 全局）；
 *   - 生命显示 `当前/上限`，上限按 CoC 7e `(体质+体型)/10` 取整；算不出上限就只显示当前值；
 *   - 第一次改名前的昵称记进 `NickSyncStore.original`（`null` = 原本没有自定义昵称），改名失败时保持原状；
 *   - 昵称上限 **32 字符**（Discord 限制），超出时截断角色名、保留统计段；
 *   - 单个人失败（无「管理昵称」权限 / 是服主 / bot 角色层位低于对方）只记进结果，不影响其他人。
 */
import type { InteractionContext, HandlerDeps } from '../../contracts/bot.ts';
import type { CharacterSheet, NickSyncState } from '../../contracts/model.ts';
import { nickSyncStore, resolveSheetFor, type SceneKey } from './context.ts';

/** Discord 昵称上限。 */
export const NICK_LIMIT = 32;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** CoC 7e 生命上限：`(体质+体型)/10` 向下取整；缺一项就算不出来。 */
export function maxHpOf(attrs: Record<string, string>): number | null {
  const con = Number(attrs['体质']);
  const siz = Number(attrs['体型']);
  if (!Number.isFinite(con) || !Number.isFinite(siz) || con <= 0 || siz <= 0) return null;
  return Math.floor((con + siz) / 10);
}

/**
 * 生成统计昵称：`角色名 |DEX70 HP12/12 SAN70`。
 * 缺哪一项就省哪一段（全缺时只留角色名，不带 `|`）。
 */
export function statNickname(cardName: string, attrs: Record<string, string>): string {
  const parts: string[] = [];
  const dex = attrs['敏捷']?.trim();
  if (dex) parts.push(`DEX${dex}`);
  const hp = attrs['生命']?.trim();
  if (hp) {
    const max = maxHpOf(attrs);
    parts.push(max === null ? `HP${hp}` : `HP${hp}/${max}`);
  }
  const san = attrs['理智']?.trim();
  if (san) parts.push(`SAN${san}`);

  const name = cardName.trim() || '调查员';
  const suffix = parts.length > 0 ? ` |${parts.join(' ')}` : '';
  const room = NICK_LIMIT - suffix.length;
  if (room <= 0) return suffix.trim().slice(0, NICK_LIMIT);
  const trimmed = name.length <= room ? name : `${name.slice(0, Math.max(1, room - 1))}…`;
  return `${trimmed}${suffix}`;
}

/** 按成员当前场景的卡算出目标昵称（没有卡时 null）。 */
export function targetNicknameFor(store: HandlerDeps['store'], key: SceneKey): string | null {
  const sheet: CharacterSheet | null = resolveSheetFor(store, key);
  return sheet ? statNickname(sheet.name, sheet.attrs) : null;
}

export interface NickSyncOutcome {
  changed: number;
  failed: number;
  skipped: number;
  failures: string[];
}

function emptyOutcome(): NickSyncOutcome {
  return { changed: 0, failed: 0, skipped: 0, failures: [] };
}

/**
 * 开 log：给本服所有"开启 `/sn`"且**当前场景能解析到角色卡**的成员改名。
 * 已经等于目标昵称的跳过（幂等，重复开 log 不会重复写）。
 */
export async function applySceneNicknames(
  ctx: InteractionContext,
  deps: HandlerDeps,
): Promise<NickSyncOutcome> {
  const outcome = emptyOutcome();
  if (!ctx.guildId) return outcome;
  const store = nickSyncStore(deps.store);

  for (const { userId, state } of store.listNickSync(ctx.guildId)) {
    if (!state.enabled) {
      outcome.skipped += 1;
      continue;
    }
    const key: SceneKey = {
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      parentChannelId: ctx.parentChannelId,
      userId,
    };
    const target = targetNicknameFor(deps.store, key);
    if (!target) {
      outcome.skipped += 1;
      continue;
    }
    try {
      const current = await deps.platform.memberNickname(ctx.guildId, userId);
      if (current === target) continue;
      // 只在**第一次**改名时记原名；之后再次同步（换卡/改属性）不要用统计昵称覆盖它
      if (state.original === undefined) {
        store.setNickSync(ctx.guildId, userId, { enabled: true, original: current });
      }
      await deps.platform.setMemberNickname(ctx.guildId, userId, target);
      outcome.changed += 1;
    } catch (error) {
      outcome.failed += 1;
      outcome.failures.push(`${userId}: ${messageOf(error)}`);
    }
  }
  return outcome;
}

/** log off / log end：把"我们改过名"的成员改回原名（开关保留）。 */
export async function restoreSceneNicknames(
  ctx: InteractionContext,
  deps: HandlerDeps,
): Promise<NickSyncOutcome> {
  const outcome = emptyOutcome();
  if (!ctx.guildId) return outcome;
  const store = nickSyncStore(deps.store);

  for (const { userId, state } of store.listNickSync(ctx.guildId)) {
    if (state.original === undefined) {
      outcome.skipped += 1;
      continue;
    }
    try {
      await deps.platform.setMemberNickname(ctx.guildId, userId, state.original);
      store.setNickSync(ctx.guildId, userId, { enabled: state.enabled });
      outcome.changed += 1;
    } catch (error) {
      outcome.failed += 1;
      outcome.failures.push(`${userId}: ${messageOf(error)}`);
    }
  }
  return outcome;
}

/** 本场景是否仍有在记录的日志——有的话 log off/end 不该把昵称改回去。 */
export function sceneStillRecording(ctx: InteractionContext, deps: HandlerDeps): boolean {
  if (!ctx.guildId) return false;
  return deps.store
    .listSceneLogs(ctx.channelId, ctx.guildId)
    .some((log) => log.state === 'on');
}

/** 回执里附带的一行说明（没有变化时返回空串）。 */
export function describeOutcome(outcome: NickSyncOutcome, verb: string): string {
  if (outcome.changed === 0 && outcome.failed === 0) return '';
  const parts = [`已${verb} ${outcome.changed} 位成员的统计昵称`];
  if (outcome.failed > 0) parts.push(`${outcome.failed} 位失败（多半缺「管理昵称」权限）`);
  return parts.join('，') + '。';
}
