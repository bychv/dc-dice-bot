/**
 * JSON-file `BotStore` implementation — owner: `src/store/**`.
 *
 * Design (docs §16.11 / §11.1):
 * - every collection lives in its own JSON file inside `options.dir`;
 * - the whole dataset is loaded once into memory, all reads are served from the cache;
 * - writes go through `tmp + rename` so a crash never leaves a half-written file;
 * - `flush()` forces pending writes to disk, and a cheap debounced timer also flushes
 *   automatically so a long-running bot does not lose data.
 *
 * The store is deliberately Discord-free and synchronous (the frozen `BotStore` contract is
 * synchronous apart from `flush()`), which keeps handlers testable in-process.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type {
  BindingScope,
  CharacterSheet,
  GameRecord,
  HouseRule,
  LogRecord,
} from '../contracts/model.ts';
import type { BindingEntry, BotStore, StoreOptions } from '../contracts/store.ts';
// pure formatter (no Discord dependency): the export file name follows Dice! `DiceSession::log_new`
import { diceLogFileName, diceLogSessionName } from '../bot/logFormat.ts';
import type { LogLineReader, NickStore, RuleSetStore } from './extras.ts';

type SheetsDb = Record<string, Record<string, CharacterSheet>>;
type BindingMap = Record<string, Record<string, string>>;
type BindingsDb = {
  game: BindingMap;
  scene: BindingMap;
  global: BindingMap;
};
type GamesDb = Record<string, Record<string, GameRecord>>;
type SceneRow = { guildId: string; gameId: string };
type ScenesDb = Record<string, SceneRow>;
type RulesDb = { game: Record<string, HouseRule>; scene: Record<string, HouseRule> };
type ThreadsDb = Record<string, string>;
type LogsDb = { logs: Record<string, LogRecord>; lines: Record<string, string[]>; nextId: number };
type MiscDb = { nicks: Record<string, string>; ruleSets: Record<string, string> };

const FILES = {
  sheets: 'sheets.json',
  bindings: 'bindings.json',
  games: 'games.json',
  scenes: 'scenes.json',
  rules: 'rules.json',
  threads: 'threads.json',
  logs: 'logs.json',
  misc: 'misc.json',
} as const;

type Collection = keyof typeof FILES;

function readJson<T>(path: string, fallback: T): T {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

/** Keep a log name usable as a file name (docs §11.1: 日志名必须可作为文件名). */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : 'log';
}

function touch(dirty: Set<Collection>, key: Collection): void {
  dirty.add(key);
}

function gameNumber(id: string): number {
  const m = /^#?(\d+)$/.exec(id.trim());
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

/**
 * 局 id（`#1`）只在服务器内唯一，跨服必须带 guildId 才不会串键。
 * 不传 guildId 时沿用历史键（兼容旧数据与既有测试）。
 */
function ruleKey(gameId: string, guildId?: string): string {
  return guildId === undefined ? gameId : `${guildId}|${gameId}`;
}

class JsonStore implements BotStore, NickStore, RuleSetStore, LogLineReader {
  readonly dir: string;

  private sheets: SheetsDb;
  private bindings: BindingsDb;
  private games: GamesDb;
  private scenes: ScenesDb;
  private rules: RulesDb;
  private threads: ThreadsDb;
  private logs: LogsDb;
  private misc: MiscDb;

  private dirty = new Set<Collection>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: StoreOptions) {
    this.dir = resolve(options.dir);
    mkdirSync(this.dir, { recursive: true });

    this.sheets = readJson<SheetsDb>(join(this.dir, FILES.sheets), {});
    this.bindings = readJson<BindingsDb>(join(this.dir, FILES.bindings), {
      game: {},
      scene: {},
      global: {},
    });
    this.games = readJson<GamesDb>(join(this.dir, FILES.games), {});
    this.scenes = readJson<ScenesDb>(join(this.dir, FILES.scenes), {});
    this.rules = readJson<RulesDb>(join(this.dir, FILES.rules), { game: {}, scene: {} });
    this.threads = readJson<ThreadsDb>(join(this.dir, FILES.threads), {});
    this.logs = readJson<LogsDb>(join(this.dir, FILES.logs), { logs: {}, lines: {}, nextId: 0 });
    this.misc = readJson<MiscDb>(join(this.dir, FILES.misc), { nicks: {}, ruleSets: {} });

    // normalise a partially written / hand-edited file
    if (!this.bindings.game) this.bindings = { game: {}, scene: {}, global: {} };
    if (!this.rules.game) this.rules = { game: {}, scene: {} };
    if (!this.logs.logs) this.logs = { logs: {}, lines: {}, nextId: 0 };
    if (!this.logs.lines) this.logs.lines = {};
    if (!this.misc.nicks) this.misc = { nicks: {}, ruleSets: {} };
  }

  // ---- persistence ------------------------------------------------------

  private payload(key: Collection): unknown {
    switch (key) {
      case 'sheets':
        return this.sheets;
      case 'bindings':
        return this.bindings;
      case 'games':
        return this.games;
      case 'scenes':
        return this.scenes;
      case 'rules':
        return this.rules;
      case 'threads':
        return this.threads;
      case 'logs':
        return this.logs;
      case 'misc':
        return this.misc;
    }
  }

  /** tmp + rename so a crash can never truncate an existing file. */
  private writeCollection(key: Collection): void {
    // 目录被删（测试清理 / 人工误删）时重建：内存里的状态才是真相，写不进去等于丢数据
    mkdirSync(this.dir, { recursive: true });
    const target = join(this.dir, FILES[key]);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.payload(key), null, 2)}\n`, 'utf8');
    renameSync(tmp, target);
  }

  private markDirty(key: Collection): void {
    touch(this.dirty, key);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // 定时器里**绝不抛**：抛出去就是 uncaughtException，会把整只 bot 打崩
      this.writeDirty(false);
    }, 250);
    this.timer.unref?.();
  }

  /**
   * 写盘。`strict=false`（debounce 定时器路径）时失败只报告、保留 dirty 等下次再写；
   * `strict=true`（显式 `flush()`）时照旧抛出，调用方要能知道"没写成功"。
   */
  private writeDirty(strict: boolean): void {
    for (const key of [...this.dirty]) {
      try {
        this.writeCollection(key);
        this.dirty.delete(key);
      } catch (error) {
        if (strict) throw error;
        console.error(`写入 ${key}.json 失败（保留待写，下次 flush 再试）：`, error);
      }
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.writeDirty(true);
  }

  // ---- character sheets --------------------------------------------------

  listSheets(userId: string): CharacterSheet[] {
    const owned = this.sheets[userId] ?? {};
    return Object.values(owned).sort((a, b) => a.name.localeCompare(b.name));
  }

  getSheet(userId: string, name: string): CharacterSheet | null {
    return this.sheets[userId]?.[name] ?? null;
  }

  putSheet(userId: string, sheet: CharacterSheet): void {
    if (!this.sheets[userId]) this.sheets[userId] = {};
    this.sheets[userId][sheet.name] = sheet;
    this.markDirty('sheets');
  }

  deleteSheet(userId: string, name: string): boolean {
    const owned = this.sheets[userId];
    if (!owned || !(name in owned)) return false;
    delete owned[name];
    if (Object.keys(owned).length === 0) delete this.sheets[userId];
    this.markDirty('sheets');
    return true;
  }

  clearSheets(userId: string): number {
    const owned = this.sheets[userId];
    if (!owned) return 0;
    const count = Object.keys(owned).length;
    delete this.sheets[userId];
    this.markDirty('sheets');
    return count;
  }

  // ---- sheet bindings (局 > 场景 > 全局) --------------------------------

  getBinding(scope: BindingScope, key: string, userId: string): string | null {
    return this.bindings[scope][key]?.[userId] ?? null;
  }

  setBinding(scope: BindingScope, key: string, userId: string, sheetName: string | null): void {
    const map = this.bindings[scope];
    if (sheetName === null) {
      if (map[key]) {
        delete map[key][userId];
        if (Object.keys(map[key]).length === 0) delete map[key];
      }
    } else {
      if (!map[key]) map[key] = {};
      map[key][userId] = sheetName;
    }
    this.markDirty('bindings');
  }

  listBindings(scope: BindingScope, key: string): BindingEntry[] {
    const row = this.bindings[scope][key] ?? {};
    return Object.entries(row)
      .map(([userId, sheetName]) => ({ userId, sheetName }))
      .sort((a, b) => a.userId.localeCompare(b.userId));
  }

  clearBindingsFor(key: string): void {
    for (const scope of ['game', 'scene', 'global'] as const) {
      delete this.bindings[scope][key];
    }
    this.markDirty('bindings');
  }

  // ---- games ------------------------------------------------------------

  listGames(guildId: string): GameRecord[] {
    const rows = Object.values(this.games[guildId] ?? {});
    return rows.sort((a, b) => {
      const na = gameNumber(a.id);
      const nb = gameNumber(b.id);
      if (na !== nb) return na - nb;
      return a.id.localeCompare(b.id);
    });
  }

  getGame(guildId: string, id: string): GameRecord | null {
    return this.games[guildId]?.[id] ?? null;
  }

  findGame(guildId: string, ref: string): GameRecord | null {
    const needle = ref.trim();
    if (needle.length === 0) return null;
    if (needle.startsWith('#')) return this.getGame(guildId, needle);
    if (/^\d+$/.test(needle)) return this.getGame(guildId, `#${needle}`);
    const games = this.listGames(guildId);
    return (
      games.find((g) => g.name === needle) ??
      games.find((g) => g.name.toLowerCase() === needle.toLowerCase()) ??
      null
    );
  }

  nextGameId(guildId: string): string {
    const rows = Object.keys(this.games[guildId] ?? {});
    let max = 0;
    for (const id of rows) {
      const n = gameNumber(id);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `#${max + 1}`;
  }

  putGame(game: GameRecord): void {
    if (!this.games[game.guildId]) this.games[game.guildId] = {};
    this.games[game.guildId][game.id] = game;
    this.markDirty('games');
  }

  // ---- scene pointers ---------------------------------------------------

  getSceneGame(channelId: string): string | null {
    return this.scenes[channelId]?.gameId ?? null;
  }

  setSceneGame(channelId: string, guildId: string, gameId: string | null): void {
    if (gameId === null) {
      delete this.scenes[channelId];
    } else {
      this.scenes[channelId] = { guildId, gameId };
    }
    this.markDirty('scenes');
  }

  listScenesOfGame(gameId: string, guildId?: string): string[] {
    return Object.entries(this.scenes)
      .filter(([, row]) => row.gameId === gameId && (guildId === undefined || row.guildId === guildId))
      .map(([channelId]) => channelId)
      .sort();
  }

  clearScenesOfGame(gameId: string, guildId?: string): void {
    for (const [channelId, row] of Object.entries(this.scenes)) {
      if (row.gameId === gameId && (guildId === undefined || row.guildId === guildId)) {
        delete this.scenes[channelId];
      }
    }
    this.markDirty('scenes');
  }

  // ---- house rules ------------------------------------------------------

  getGameRule(gameId: string, guildId?: string): HouseRule | null {
    return this.rules.game[ruleKey(gameId, guildId)] ?? null;
  }

  setGameRule(gameId: string, rule: HouseRule | null, guildId?: string): void {
    const key = ruleKey(gameId, guildId);
    if (rule === null) delete this.rules.game[key];
    else this.rules.game[key] = rule;
    this.markDirty('rules');
  }

  getSceneRule(channelId: string): HouseRule | null {
    return this.rules.scene[channelId] ?? null;
  }

  setSceneRule(channelId: string, rule: HouseRule | null): void {
    if (rule === null) delete this.rules.scene[channelId];
    else this.rules.scene[channelId] = rule;
    this.markDirty('rules');
  }

  // ---- hidden-roll thread registration ----------------------------------

  getRegisteredThread(channelId: string): string | null {
    return this.threads[channelId] ?? null;
  }

  setRegisteredThread(channelId: string, threadId: string | null): void {
    if (threadId === null) delete this.threads[channelId];
    else this.threads[channelId] = threadId;
    this.markDirty('threads');
  }

  // ---- logs -------------------------------------------------------------

  listLogs(scope: { gameId: string | null; channelId: string; guildId?: string }): LogRecord[] {
    const all = Object.values(this.logs.logs);
    const rows =
      scope.gameId !== null
        ? all.filter(
            (log) =>
              log.gameId === scope.gameId &&
              (scope.guildId === undefined || log.guildId === scope.guildId),
          )
        : all.filter(
            (log) =>
              log.gameId === null &&
              (scope.guildId === undefined || log.guildId === scope.guildId) &&
              (log.channelId === scope.channelId || log.sceneIds.includes(scope.channelId)),
          );
    return rows.sort((a, b) => {
      if (a.startedAt !== b.startedAt) return a.startedAt.localeCompare(b.startedAt);
      return a.id.localeCompare(b.id);
    });
  }

  getLog(id: string): LogRecord | null {
    return this.logs.logs[id] ?? null;
  }

  putLog(log: LogRecord): void {
    this.logs.logs[log.id] = log;
    if (!this.logs.lines[log.id]) this.logs.lines[log.id] = [];
    if (!log.sceneIds.includes(log.channelId)) log.sceneIds.push(log.channelId);
    this.markDirty('logs');
  }

  nextLogId(): string {
    let n = this.logs.nextId;
    let id = '';
    do {
      n += 1;
      id = `L${n}`;
    } while (this.logs.logs[id]);
    this.logs.nextId = n;
    this.markDirty('logs');
    return id;
  }

  /** lines already recorded for a log (not part of the frozen contract; used by exports). */
  logLines(logId: string): string[] {
    return [...(this.logs.lines[logId] ?? [])];
  }

  /**
   * 追加**一行已格式化的日志**（Dice! `LogInfo::append`：原样追加，不再补分隔符）。
   * 行格式由 `src/bot/logFormat.ts` 决定（`<名字>(<uid>) <时间>\n<正文>\n\n`）；
   * store 只负责按场景/局路由，不拼任何前缀。
   */
  listSceneLogs(channelId: string, guildId?: string): LogRecord[] {
    return Object.values(this.logs.logs)
      .filter(
        (log) =>
          (log.channelId === channelId || log.sceneIds.includes(channelId)) &&
          (guildId === undefined || log.guildId === guildId),
      )
      .sort((a, b) =>
        a.startedAt === b.startedAt ? a.id.localeCompare(b.id) : a.startedAt.localeCompare(b.startedAt),
      );
  }

  appendLogLine(channelId: string, line: string): number {
    // 按场景匹配：谁开的日志就记谁的发言（同一场景最多一条 on，不同子区互不影响）
    const targets = Object.values(this.logs.logs).filter(
      (log) =>
        log.state === 'on' && (log.channelId === channelId || log.sceneIds.includes(channelId)),
    );
    if (targets.length === 0) return 0;
    for (const log of targets) {
      const lines = this.logs.lines[log.id] ?? (this.logs.lines[log.id] = []);
      lines.push(line);
    }
    this.markDirty('logs');
    return targets.length;
  }

  logFilePath(log: LogRecord): string {
    const dir = join(this.dir, 'logs');
    mkdirSync(dir, { recursive: true });
    let fileName = log.fileName ?? this.defaultLogFileName(log);
    if (log.fileName === null) {
      // 两条日志名只有非法字符不同时会映射到同一个文件名（如 `第一/夜` 与 `第一_夜`），
      // 那样后导出的一条会覆盖前一条。这里用已记录的 `fileName` 做去重，冲突则加日志 id。
      const taken = new Set(
        Object.values(this.logs.logs)
          .filter((other) => other.id !== log.id && other.guildId === log.guildId)
          .map((other) => other.fileName ?? this.defaultLogFileName(other)),
      );
      if (taken.has(fileName)) {
        fileName = `${fileName.replace(/\.txt$/i, '')}_${log.id}.txt`;
      }
    }
    const path = resolve(dir, fileName);
    writeFileSync(path, this.exportBody(log.id), 'utf8');
    return path;
  }

  /** Dice! `DiceSession::log_new` 的默认文件名：`<会话名>_<日志名>.txt`。 */
  private defaultLogFileName(log: LogRecord): string {
    return diceLogFileName(
      diceLogSessionName(log, (guildId, gameId) => this.getGame(guildId, gameId)),
      log.name,
    );
  }

  /**
   * Dice! `LogInfo::append` 的正文语义：行本身已以 `\n\n` 结尾，导出时**逐行原样拼接**，
   * 不再插入额外换行。
   */
  private exportBody(logId: string): string {
    const lines = this.logs.lines[logId] ?? [];
    return lines.join('');
  }

  // ---- extras: 称呼 / 默认规则集 ----------------------------------------

  private static nickChannelKey(guildId: string | null, channelId: string, userId: string): string {
    return `c\u0000${guildId ?? '@dm'}\u0000${channelId}\u0000${userId}`;
  }

  private static nickGlobalKey(guildId: string | null, userId: string): string {
    return `g\u0000${guildId ?? '@dm'}\u0000${userId}`;
  }

  getNick(guildId: string | null, channelId: string, userId: string): string | null {
    return this.misc.nicks[JsonStore.nickChannelKey(guildId, channelId, userId)] ?? null;
  }

  setNick(guildId: string | null, channelId: string, userId: string, name: string | null): void {
    const key = JsonStore.nickChannelKey(guildId, channelId, userId);
    if (name === null) delete this.misc.nicks[key];
    else this.misc.nicks[key] = name;
    this.markDirty('misc');
  }

  getGlobalNick(guildId: string | null, userId: string): string | null {
    return this.misc.nicks[JsonStore.nickGlobalKey(guildId, userId)] ?? null;
  }

  setGlobalNick(guildId: string | null, userId: string, name: string | null): void {
    const key = JsonStore.nickGlobalKey(guildId, userId);
    if (name === null) delete this.misc.nicks[key];
    else this.misc.nicks[key] = name;
    this.markDirty('misc');
  }

  clearNicks(userId: string): number {
    let removed = 0;
    for (const key of Object.keys(this.misc.nicks)) {
      if (key.endsWith(`\u0000${userId}`)) {
        delete this.misc.nicks[key];
        removed += 1;
      }
    }
    if (removed > 0) this.markDirty('misc');
    return removed;
  }

  getDefaultRuleSet(guildId: string | null): string | null {
    return this.misc.ruleSets[guildId ?? '@dm'] ?? null;
  }

  setDefaultRuleSet(guildId: string | null, rule: string | null): void {
    const key = guildId ?? '@dm';
    if (rule === null) delete this.misc.ruleSets[key];
    else this.misc.ruleSets[key] = rule;
    this.markDirty('misc');
  }

  // ---- maintenance ------------------------------------------------------

  /** drop leftover tmp files (defensive: a killed process may leave one behind) */
  cleanTmpFiles(): void {
    for (const file of Object.values(FILES)) {
      try {
        rmSync(join(this.dir, `${file}.tmp`), { force: true });
      } catch {
        // ignore
      }
    }
  }
}

/** Create a JSON-backed store rooted at `options.dir` (created when missing). */
export function createJsonStore(options: StoreOptions): BotStore {
  return new JsonStore(options);
}

/** Same as `createJsonStore`, but with the bot-layer extras (`/nn`, `/rules set`) visible. */
export function createJsonStoreWithExtras(
  options: StoreOptions,
): BotStore & NickStore & RuleSetStore & LogLineReader {
  return new JsonStore(options);
}
