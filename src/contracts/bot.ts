/**
 * Discord-facing seams — owner: `src/bot/**`.
 * Handlers never import discord.js: they take an `InteractionContext` + `HandlerDeps`
 * and return a `ReplyPayload`. The discord.js adapter (`src/bot/adapter.ts`) is the only
 * place that knows about the library, which keeps every handler unit-testable without a token.
 */
import type { CocRules } from './coc';
import type { DiceEngine } from './dice';
import type { Rng } from './rng';
import type { BotStore } from './store';

/** Reads slash-command options (subcommand aware). */
export interface OptionReader {
  string(name: string): string | null;
  integer(name: string): number | null;
  boolean(name: string): boolean | null;
  user(name: string): string | null;
  channel(name: string): string | null;
  /** invoked subcommand name, or null for top-level commands */
  subcommand(): string | null;
  /** option reader scoped to the invoked subcommand */
  sub(): OptionReader | null;
}

export interface InteractionContext {
  commandName: string;
  guildId: string | null;
  /** channel **or thread** the command was used in */
  channelId: string;
  /** parent channel when used inside a thread; null otherwise */
  parentChannelId: string | null;
  channelName: string;
  userId: string;
  displayName: string;
  /** server admin (Manage Server / admin permission) */
  isAdmin: boolean;
  options: OptionReader;
}

export interface OutgoingFile {
  name: string;
  data: Buffer;
}

/** Minimal button component (Discord API shape) for 破坏性操作的二次确认. */
export interface ApiButton {
  type: 2;
  /** 1 primary / 2 secondary / 3 success / 4 danger */
  style: 1 | 2 | 3 | 4;
  label: string;
  custom_id: string;
  disabled?: boolean;
}

export interface ApiActionRow {
  type: 1;
  components: ApiButton[];
}

export interface ReplyPayload {
  content: string;
  /** ephemeral replies are only visible to the invoker */
  ephemeral?: boolean;
  files?: OutgoingFile[];
  /** 一次确认/取消按钮行（docs §16.6 破坏性操作的二次确认） */
  components?: ApiActionRow[];
}

/** 待确认动作：由 `/pc clr`、`/st clr` 之类的破坏性命令登记，按钮点击后执行。 */
export interface PendingAction {
  id: string;
  /** 只有发起者能确认 */
  userId: string;
  /** 确认后真正执行，返回最终回执 */
  run(): Promise<ReplyPayload>;
  /** 取消时的回执（缺省为一句"已取消"） */
  cancel?(): ReplyPayload;
  /** 过期时间（毫秒时间戳） */
  expiresAt: number;
}

export interface PendingActions {
  put(action: PendingAction): void;
  /** 取出并删除（防止重复点击） */
  take(id: string): PendingAction | null;
  peek(id: string): PendingAction | null;
  /** 清理过期项 */
  sweep(now: number): void;
  /** 尚未确认的数量（测试/观测用） */
  size(): number;
}

/** Side effects the handlers need from Discord; implemented by the adapter, faked in tests. */
export interface Platform {
  createPublicThread(channelId: string, name: string): Promise<string>;
  createPrivateThread(channelId: string, name: string): Promise<string>;
  addThreadMember(threadId: string, userId: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  sendMessage(channelId: string, payload: ReplyPayload): Promise<string>;
  /** parent channel of a thread (null if the id is not a thread) */
  threadParent(threadId: string): Promise<string | null>;
  threadName(threadId: string): Promise<string | null>;
  /** whether the bot may create threads in this channel */
  canCreateThreads(channelId: string): Promise<boolean>;
}

export interface HandlerDeps {
  store: BotStore;
  dice: DiceEngine;
  coc: CocRules;
  rng: Rng;
  platform: Platform;
  /** 破坏性命令的二次确认登记表 */
  confirmations: PendingActions;
  /** 注入时钟（测试冻结它） */
  now(): Date;
}

export type CommandHandler = (ctx: InteractionContext, deps: HandlerDeps) => Promise<ReplyPayload>;

export interface CommandDefinition {
  name: string;
  handler: CommandHandler;
}
