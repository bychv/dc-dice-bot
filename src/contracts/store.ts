/**
 * Persistence contract — owner: `src/store/**` (JSON file store, atomic writes).
 * Everything is keyed by ids the bot layer supplies; no Discord types allowed here.
 */
import type {
  BindingScope,
  CharacterSheet,
  GameRecord,
  HouseRule,
  LogRecord,
} from './model';

export interface BindingEntry {
  userId: string;
  sheetName: string;
}

export interface BotStore {
  // ---- character sheets -------------------------------------------------
  listSheets(userId: string): CharacterSheet[];
  getSheet(userId: string, name: string): CharacterSheet | null;
  putSheet(userId: string, sheet: CharacterSheet): void;
  deleteSheet(userId: string, name: string): boolean;
  clearSheets(userId: string): number;

  // ---- sheet bindings (局 > 场景 > 全局) --------------------------------
  getBinding(scope: BindingScope, key: string, userId: string): string | null;
  setBinding(scope: BindingScope, key: string, userId: string, sheetName: string | null): void;
  listBindings(scope: BindingScope, key: string): BindingEntry[];
  clearBindingsFor(key: string): void;

  // ---- games ------------------------------------------------------------
  listGames(guildId: string): GameRecord[];
  getGame(guildId: string, id: string): GameRecord | null;
  /** accepts `#1`, `1`, or a table name */
  findGame(guildId: string, ref: string): GameRecord | null;
  nextGameId(guildId: string): string;
  putGame(game: GameRecord): void;

  // ---- scene pointers (频道 或 子区 -> 局) ------------------------------
  getSceneGame(channelId: string): string | null;
  setSceneGame(channelId: string, guildId: string, gameId: string | null): void;
  /** `guildId` 必须传：局 id 形如 `#1`、只在服务器内唯一，否则两个服的 `#1` 会互相枚举到。 */
  listScenesOfGame(gameId: string, guildId?: string): string[];
  clearScenesOfGame(gameId: string, guildId?: string): void;

  // ---- house rules (局 > 场景 > 骰主默认) -------------------------------
  /**
   * `guildId` makes the lookup guild-scoped. 局 id 形如 `#1`、只在服务器内唯一，
   * 所以跨服必须传 guildId，否则两个服务器的 `#1` 会串房规（历史遗留键，故意保留可选参数）。
   */
  getGameRule(gameId: string, guildId?: string): HouseRule | null;
  setGameRule(gameId: string, rule: HouseRule | null, guildId?: string): void;
  getSceneRule(channelId: string): HouseRule | null;
  setSceneRule(channelId: string, rule: HouseRule | null): void;

  // ---- hidden-roll thread registration (场景级) -------------------------
  getRegisteredThread(channelId: string): string | null;
  setRegisteredThread(channelId: string, threadId: string | null): void;

  // ---- logs -------------------------------------------------------------
  /** `guildId` (可选) 会把「局日志」的查询限制在该服务器内；`gameId: null` 的场景日志按 channelId 隔离。 */
  listLogs(scope: { gameId: string | null; channelId: string; guildId?: string }): LogRecord[];
  /**
   * 某个**场景**（频道或子区）自己的日志，不论它属于哪个局。
   * 日志按场景隔离：谁开的日志就记谁的发言，不同子区可以各自同时开。
   */
  listSceneLogs(channelId: string, guildId?: string): LogRecord[];
  getLog(id: string): LogRecord | null;
  putLog(log: LogRecord): void;
  nextLogId(): string;

  // ---- misc -------------------------------------------------------------
  /** append a message line to every `on` log of the given scene (game-aware); returns how many logs got it */
  appendLogLine(channelId: string, line: string): number;
  /** absolute path of a log's exported file (created on demand) */
  logFilePath(log: LogRecord): string;
  flush(): Promise<void>;
}

export interface StoreOptions {
  /** directory for the JSON data files; created when missing */
  dir: string;
}
