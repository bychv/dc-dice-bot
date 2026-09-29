/**
 * Optional store capabilities the bot layer uses on top of the frozen `BotStore` contract.
 *
 * `src/contracts/store.ts` is frozen and has no slot for 称呼 (`/nn`, docs §12.1) or the
 * 骰主默认规则 (`/rules set`, docs §3.2). `jsonStore` implements these two interfaces, and the
 * handlers fall back to an in-process map when a store does not (e.g. a minimal fake).
 */
import type { NickSyncState } from '../contracts/model.ts';

/** `/nn` 称呼登记（频道级 + 全局级），docs §12. 显示优先级：频道称呼 > 全局称呼 > 服务器昵称. */
export interface NickStore {
  /** channel-scoped nickname (guildId null = DM) */
  getNick(guildId: string | null, channelId: string, userId: string): string | null;
  setNick(guildId: string | null, channelId: string, userId: string, name: string | null): void;
  /** global (cross-channel) nickname for a user */
  getGlobalNick(guildId: string | null, userId: string): string | null;
  setGlobalNick(guildId: string | null, userId: string, name: string | null): void;
  /** delete every recorded nickname of a user; returns how many rows were removed */
  clearNicks(userId: string): number;
}

/** `/rules set` 默认规则集（guild 级；null = 未设置）. */
export interface RuleSetStore {
  getDefaultRuleSet(guildId: string | null): string | null;
  setDefaultRuleSet(guildId: string | null, rule: string | null): void;
}

/**
 * `/sn` 统计昵称同步的状态（服务器级，docs §12.4）：
 * 开 log 时把成员的服务器昵称改成 `角色名 |DEX70 HP12/12 SAN70`，log off 时改回 `original`。
 * 与 `NickStore`（日志里显示的称呼）是两件事，故单独一张表。
 */
export interface NickSyncStore {
  getNickSync(guildId: string, userId: string): NickSyncState | null;
  /** `null` 删除登记（解绑/关闭并已改回原名时） */
  setNickSync(guildId: string, userId: string, state: NickSyncState | null): void;
  /** 该服务器所有登记项（按 userId 排序），`/log on` 时据此批量改名 */
  listNickSync(guildId: string): Array<{ userId: string; state: NickSyncState }>;
}

export function isNickStore(store: object): store is NickStore {
  const candidate = store as Partial<NickStore>;
  return (
    typeof candidate.getNick === 'function' &&
    typeof candidate.setNick === 'function' &&
    typeof candidate.clearNicks === 'function'
  );
}

export function isRuleSetStore(store: object): store is RuleSetStore {
  const candidate = store as Partial<RuleSetStore>;
  return (
    typeof candidate.getDefaultRuleSet === 'function' &&
    typeof candidate.setDefaultRuleSet === 'function'
  );
}

export function isNickSyncStore(store: object): store is NickSyncStore {
  const candidate = store as Partial<NickSyncStore>;
  return (
    typeof candidate.getNickSync === 'function' &&
    typeof candidate.setNickSync === 'function' &&
    typeof candidate.listNickSync === 'function'
  );
}

/** Read the raw lines recorded in a log without touching the exported file. */
export interface LogLineReader {
  logLines(logId: string): string[];
}

export function isLogLineReader(store: object): store is LogLineReader {
  return typeof (store as Partial<LogLineReader>).logLines === 'function';
}
