/**
 * In-memory fakes for the bot-layer behaviour tests.
 *
 * `MemoryStore` mirrors `jsonStore` semantics but shares nothing with it, which is the point:
 * the handlers must only depend on the frozen `BotStore` / `Platform` / `DiceEngine` / `CocRules`
 * contracts (T1/T2 run in parallel, so the engines are stubs here).
 */
import type { InteractionContext, HandlerDeps, OptionReader, PendingActions, Platform } from '../../src/contracts/bot.ts';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPendingActions } from '../../src/bot/confirm.ts';
import type {
  BindingScope,
  CharacterSheet,
  GameRecord,
  HouseRule,
  LogRecord,
} from '../../src/contracts/model.ts';
import type { BindingEntry, BotStore } from '../../src/contracts/store.ts';

/** 沙箱不允许写系统临时目录（EPERM），测试数据一律放在包内 .tmp/. */
const TMP_ROOT = fileURLToPath(new URL('../.tmp/', import.meta.url));
mkdirSync(TMP_ROOT, { recursive: true });

/** 与 jsonStore 的 ruleKey 保持一致：局 id 只在服务器内唯一，跨服必须带 guildId。 */
function memoryRuleKey(gameId: string, guildId?: string): string {
  return guildId === undefined ? gameId : `${guildId}|${gameId}`;
}
import type { DiceEngine, PercentileResult, RollResult } from '../../src/contracts/dice.ts';
import type {
  CheckOptions,
  CheckResult,
  CocRules,
  ImproveOptions,
  ImproveResult,
  ParsedCheck,
  SanityOptions,
  SanityResult,
  StResult,
} from '../../src/contracts/coc.ts';
import type { Rng } from '../../src/contracts/rng.ts';
import type { LogLineReader, NickStore, RuleSetStore } from '../../src/store/extras.ts';

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export class MemoryStore implements BotStore, NickStore, RuleSetStore, LogLineReader {
  sheets = new Map<string, Map<string, CharacterSheet>>();
  bindings: Record<BindingScope, Map<string, Map<string, string>>> = {
    game: new Map(),
    scene: new Map(),
    global: new Map(),
  };
  games = new Map<string, Map<string, GameRecord>>();
  scenes = new Map<string, { guildId: string; gameId: string }>();
  gameRules = new Map<string, HouseRule>();
  sceneRules = new Map<string, HouseRule>();
  threads = new Map<string, string>();
  logs = new Map<string, LogRecord>();
  lines = new Map<string, string[]>();
  nicks = new Map<string, string>();
  ruleSets = new Map<string, string>();
  flushCount = 0;
  dir = mkdtempSync(join(TMP_ROOT, 'dcdice-mem-'));
  private logSeq = 0;

  listSheets(userId: string): CharacterSheet[] {
    return [...(this.sheets.get(userId)?.values() ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  }

  getSheet(userId: string, name: string): CharacterSheet | null {
    return this.sheets.get(userId)?.get(name) ?? null;
  }

  putSheet(userId: string, sheet: CharacterSheet): void {
    if (!this.sheets.has(userId)) this.sheets.set(userId, new Map());
    this.sheets.get(userId)!.set(sheet.name, sheet);
  }

  deleteSheet(userId: string, name: string): boolean {
    return this.sheets.get(userId)?.delete(name) ?? false;
  }

  clearSheets(userId: string): number {
    const count = this.sheets.get(userId)?.size ?? 0;
    this.sheets.delete(userId);
    return count;
  }

  getBinding(scope: BindingScope, key: string, userId: string): string | null {
    return this.bindings[scope].get(key)?.get(userId) ?? null;
  }

  setBinding(scope: BindingScope, key: string, userId: string, sheetName: string | null): void {
    const map = this.bindings[scope];
    if (sheetName === null) {
      map.get(key)?.delete(userId);
      return;
    }
    if (!map.has(key)) map.set(key, new Map());
    map.get(key)!.set(userId, sheetName);
  }

  listBindings(scope: BindingScope, key: string): BindingEntry[] {
    return [...(this.bindings[scope].get(key)?.entries() ?? [])]
      .map(([userId, sheetName]) => ({ userId, sheetName }))
      .sort((a, b) => a.userId.localeCompare(b.userId));
  }

  clearBindingsFor(key: string): void {
    for (const scope of ['game', 'scene', 'global'] as const) this.bindings[scope].delete(key);
  }

  listGames(guildId: string): GameRecord[] {
    return [...(this.games.get(guildId)?.values() ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  }

  getGame(guildId: string, id: string): GameRecord | null {
    return this.games.get(guildId)?.get(id) ?? null;
  }

  findGame(guildId: string, ref: string): GameRecord | null {
    const needle = ref.trim();
    if (!needle) return null;
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
    let max = 0;
    for (const id of this.games.get(guildId)?.keys() ?? []) {
      const match = /^#?(\d+)$/.exec(id);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return `#${max + 1}`;
  }

  putGame(game: GameRecord): void {
    if (!this.games.has(game.guildId)) this.games.set(game.guildId, new Map());
    this.games.get(game.guildId)!.set(game.id, game);
  }

  getSceneGame(channelId: string): string | null {
    return this.scenes.get(channelId)?.gameId ?? null;
  }

  setSceneGame(channelId: string, guildId: string, gameId: string | null): void {
    if (gameId === null) this.scenes.delete(channelId);
    else this.scenes.set(channelId, { guildId, gameId });
  }

  listScenesOfGame(gameId: string, guildId?: string): string[] {
    return [...this.scenes.entries()]
      .filter(([, row]) => row.gameId === gameId && (guildId === undefined || row.guildId === guildId))
      .map(([channelId]) => channelId)
      .sort();
  }

  clearScenesOfGame(gameId: string, guildId?: string): void {
    for (const [channelId, row] of [...this.scenes.entries()]) {
      if (row.gameId === gameId && (guildId === undefined || row.guildId === guildId)) {
        this.scenes.delete(channelId);
      }
    }
  }

  getGameRule(gameId: string, guildId?: string): HouseRule | null {
    return this.gameRules.get(memoryRuleKey(gameId, guildId)) ?? null;
  }

  setGameRule(gameId: string, rule: HouseRule | null, guildId?: string): void {
    const key = memoryRuleKey(gameId, guildId);
    if (rule === null) this.gameRules.delete(key);
    else this.gameRules.set(key, rule);
  }

  getSceneRule(channelId: string): HouseRule | null {
    return this.sceneRules.get(channelId) ?? null;
  }

  setSceneRule(channelId: string, rule: HouseRule | null): void {
    if (rule === null) this.sceneRules.delete(channelId);
    else this.sceneRules.set(channelId, rule);
  }

  getRegisteredThread(channelId: string): string | null {
    return this.threads.get(channelId) ?? null;
  }

  setRegisteredThread(channelId: string, threadId: string | null): void {
    if (threadId === null) this.threads.delete(channelId);
    else this.threads.set(channelId, threadId);
  }

  listLogs(scope: { gameId: string | null; channelId: string; guildId?: string }): LogRecord[] {
    return [...this.logs.values()]
      .filter((log) =>
        scope.gameId !== null
          ? log.gameId === scope.gameId &&
            (scope.guildId === undefined || log.guildId === scope.guildId)
          : log.gameId === null &&
            (scope.guildId === undefined || log.guildId === scope.guildId) &&
            (log.channelId === scope.channelId || log.sceneIds.includes(scope.channelId)),
      )
      .sort((a, b) => (a.startedAt === b.startedAt ? a.id.localeCompare(b.id) : a.startedAt.localeCompare(b.startedAt)));
  }

  getLog(id: string): LogRecord | null {
    return this.logs.get(id) ?? null;
  }

  putLog(log: LogRecord): void {
    if (!log.sceneIds.includes(log.channelId)) log.sceneIds.push(log.channelId);
    this.logs.set(log.id, log);
    if (!this.lines.has(log.id)) this.lines.set(log.id, []);
  }

  nextLogId(): string {
    this.logSeq += 1;
    return `L${this.logSeq}`;
  }

  logLines(logId: string): string[] {
    return [...(this.lines.get(logId) ?? [])];
  }

  listSceneLogs(channelId: string, guildId?: string): LogRecord[] {
    return [...this.logs.values()]
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
    const targets = [...this.logs.values()].filter(
      (log) =>
        log.state === 'on' && (log.channelId === channelId || log.sceneIds.includes(channelId)),
    );
    for (const log of targets) {
      const lines = this.lines.get(log.id) ?? [];
      lines.push(line);
      this.lines.set(log.id, lines);
    }
    return targets.length;
  }

  logFilePath(log: LogRecord): string {
    const dir = join(this.dir, 'logs');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, log.fileName ?? `${log.id}.txt`);
    writeFileSync(path, (this.lines.get(log.id) ?? []).join('\n'), 'utf8');
    return path;
  }

  async flush(): Promise<void> {
    this.flushCount += 1;
  }

  // extras
  private nickKey(guildId: string | null, channelId: string, userId: string): string {
    return `${guildId ?? '@dm'}|${channelId}|${userId}`;
  }

  getNick(guildId: string | null, channelId: string, userId: string): string | null {
    return this.nicks.get(this.nickKey(guildId, channelId, userId)) ?? null;
  }

  setNick(guildId: string | null, channelId: string, userId: string, name: string | null): void {
    const key = this.nickKey(guildId, channelId, userId);
    if (name === null) this.nicks.delete(key);
    else this.nicks.set(key, name);
  }

  getGlobalNick(guildId: string | null, userId: string): string | null {
    return this.nicks.get(`global|${guildId ?? '@dm'}|${userId}`) ?? null;
  }

  setGlobalNick(guildId: string | null, userId: string, name: string | null): void {
    const key = `global|${guildId ?? '@dm'}|${userId}`;
    if (name === null) this.nicks.delete(key);
    else this.nicks.set(key, name);
  }

  clearNicks(userId: string): number {
    let removed = 0;
    for (const key of [...this.nicks.keys()]) {
      if (key.endsWith(`|${userId}`)) {
        this.nicks.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  getDefaultRuleSet(guildId: string | null): string | null {
    return this.ruleSets.get(guildId ?? '@dm') ?? null;
  }

  setDefaultRuleSet(guildId: string | null, rule: string | null): void {
    const key = guildId ?? '@dm';
    if (rule === null) this.ruleSets.delete(key);
    else this.ruleSets.set(key, rule);
  }
}

// ---------------------------------------------------------------------------
// platform
// ---------------------------------------------------------------------------

export interface FakeThread {
  id: string;
  parentId: string;
  name: string;
  private: boolean;
}

export class FakePlatform implements Platform {
  threads = new Map<string, FakeThread>();
  channelNames = new Map<string, string>();
  messages: { channelId: string; content: string; ephemeral: boolean; fileNames: string[] }[] = [];
  members = new Map<string, string[]>();
  archived: string[] = [];
  canCreate = true;
  failCreate = false;
  private seq = 0;

  private make(parentId: string, name: string, isPrivate: boolean): string {
    if (!this.canCreate) throw new Error('missing thread permissions');
    if (this.failCreate) throw new Error('thread creation failed');
    this.seq += 1;
    const id = `${isPrivate ? 'H' : 'T'}${this.seq}`;
    this.threads.set(id, { id, parentId, name, private: isPrivate });
    return id;
  }

  async createPublicThread(channelId: string, name: string): Promise<string> {
    return this.make(channelId, name, false);
  }

  async createPrivateThread(channelId: string, name: string): Promise<string> {
    return this.make(channelId, name, true);
  }

  async addThreadMember(threadId: string, userId: string): Promise<void> {
    const list = this.members.get(threadId) ?? [];
    list.push(userId);
    this.members.set(threadId, list);
  }

  async archiveThread(threadId: string): Promise<void> {
    this.archived.push(threadId);
  }

  async sendMessage(channelId: string, payload: { content: string; files?: { name: string }[] }): Promise<string> {
    this.seq += 1;
    this.messages.push({
      channelId,
      content: payload.content,
      ephemeral: false,
      fileNames: (payload.files ?? []).map((f) => f.name),
    });
    return `M${this.seq}`;
  }

  async threadParent(threadId: string): Promise<string | null> {
    return this.threads.get(threadId)?.parentId ?? null;
  }

  async threadName(threadId: string): Promise<string | null> {
    return this.threads.get(threadId)?.name ?? this.channelNames.get(threadId) ?? null;
  }

  async canCreateThreads(): Promise<boolean> {
    return this.canCreate;
  }
}

// ---------------------------------------------------------------------------
// engines
// ---------------------------------------------------------------------------

export class FixedRng implements Rng {
  private index = 0;
  values: number[];

  constructor(values: number[] = []) {
    this.values = values;
  }

  int(min: number, max: number): number {
    const value = this.values.length > 0 ? this.values[this.index % this.values.length] : min;
    this.index += 1;
    return Math.max(min, Math.min(max, value));
  }
}

export class StubDice implements DiceEngine {
  rolls: string[] = [];
  total: number;
  failNext = false;

  constructor(total = 42) {
    this.total = total;
  }

  roll(expression: string, rng: Rng): RollResult {
    this.rolls.push(expression);
    if (this.failNext) return { ok: false, error: `无法解析的骰式：${expression}` };
    const values = [rng.int(1, 6), rng.int(1, 6)];
    return {
      ok: true,
      expression,
      rounds: 1,
      groups: [{ sides: 6, values }],
      modifier: 0,
      totals: [this.total],
      total: this.total,
      sorted: false,
    };
  }

  percentile(_opts: { bonus?: number; penalty?: number }, rng: Rng): PercentileResult {
    const value = rng.int(1, 100);
    return { ok: true, value, tens: Math.floor(value / 10), units: value % 10, candidates: [value], bonus: 0, penalty: 0 };
  }
}

export class StubCoc implements CocRules {
  stCalls: string[] = [];
  checkCalls: { text: string; sheet: CharacterSheet | null; rule: HouseRule }[] = [];
  sanityCalls: { text: string; sanOverride: number | null }[] = [];
  improveCalls: { text: string; valueOverride: number | null }[] = [];

  applySt(text: string, sheet: CharacterSheet | null): StResult {
    this.stCalls.push(text);
    if (!sheet) return { ok: false, error: '没有角色卡' };
    if (/^clr(?=\s|$)/i.test(text.trim())) {
      return {
        ok: true,
        op: 'clr',
        lines: ['已清空角色卡'],
        sheet: { ...sheet, attrs: {}, exprs: {}, updatedAt: '2026-01-01T01:00:00.000Z' },
      };
    }
    const attrs = { ...sheet.attrs };
    let changed = false;
    for (const token of text.split(/\s+/)) {
      const match = /^(.+?)[:=](.+)$/.exec(token);
      if (match) {
        attrs[match[1]] = match[2];
        changed = true;
      }
    }
    if (text.startsWith('show')) {
      return { ok: true, op: 'show', lines: [`属性：${JSON.stringify(attrs)}`] };
    }
    if (!changed) return { ok: true, op: 'set', lines: [`已处理 ${text}`] };
    return {
      ok: true,
      op: 'set',
      lines: [`已录入 ${Object.keys(attrs).length} 项属性`],
      sheet: { ...sheet, attrs, updatedAt: '2026-01-01T01:00:00.000Z' },
    };
  }

  check(text: string, opts: CheckOptions): CheckResult {
    this.checkCalls.push({ text, sheet: opts.sheet, rule: opts.rule });
    if (text === 'boom') return { ok: false, error: '未找到属性 boom' };
    return {
      ok: true,
      skillName: text,
      target: 50,
      rule: opts.rule,
      rounds: 1,
      details: [{ roll: 50, target: 50, level: '成功' }],
      lines: [`检定「${text}」：50/50 成功（房规 ${opts.rule}）`],
    };
  }

  sanity(text: string, opts: SanityOptions): SanityResult {
    this.sanityCalls.push({ text, sanOverride: opts.sanOverride ?? null });
    const sanBefore = opts.sheet ? Number(opts.sheet.attrs['理智'] ?? '70') : (opts.sanOverride ?? null);
    const sanAfter = sanBefore === null ? null : sanBefore - 1;
    return {
      ok: true,
      rule: opts.rule,
      rounds: 1,
      details: [{ roll: 50, level: '成功', loss: 1, sanAfter }],
      sanBefore,
      sanAfter,
      lines: [`理智检定「${text}」：成功，失去 1 点理智`],
      sheet: opts.sheet
        ? {
            ...opts.sheet,
            attrs: { ...opts.sheet.attrs, 理智: String(sanAfter ?? sanBefore) },
            updatedAt: '2026-01-01T01:00:00.000Z',
          }
        : undefined,
    };
  }

  improve(text: string, opts: ImproveOptions): ImproveResult {
    this.improveCalls.push({ text, valueOverride: opts.valueOverride ?? null });
    const before = opts.sheet ? Number(opts.sheet.attrs['教育'] ?? '60') : (opts.valueOverride ?? null);
    return {
      ok: true,
      skillName: text,
      before,
      roll: 10,
      gained: before === null ? 0 : 5,
      after: before === null ? null : before + 5,
      lines: [`成长检定「${text}」：${before ?? '?'} → ${before === null ? '?' : before + 5}`],
    };
  }

  parseCheck(text: string): ParsedCheck | { ok: false; error: string } {
    return {
      skillName: text,
      target: null,
      rounds: 1,
      bonus: 0,
      penalty: 0,
      difficulty: 'normal',
    };
  }

  resolveRollExpression(sheet: CharacterSheet | null, text: string): string | null {
    if (!sheet) return null;
    return sheet.exprs[text] ?? null;
  }

  canonicalAttr(name: string): string {
    return name;
  }
}

// ---------------------------------------------------------------------------
// contexts + deps
// ---------------------------------------------------------------------------

export type OptionValue = string | number | boolean;

export class FakeReader implements OptionReader {
  values: Record<string, OptionValue>;
  private subName: string | null;

  constructor(values: Record<string, OptionValue> = {}, subName: string | null = null) {
    this.values = values;
    this.subName = subName;
  }

  private raw(name: string): OptionValue | undefined {
    return this.values[name];
  }

  string(name: string): string | null {
    const value = this.raw(name);
    return typeof value === 'string' ? value : null;
  }

  integer(name: string): number | null {
    const value = this.raw(name);
    return typeof value === 'number' ? value : null;
  }

  boolean(name: string): boolean | null {
    const value = this.raw(name);
    return typeof value === 'boolean' ? value : null;
  }

  user(name: string): string | null {
    const value = this.raw(name);
    return typeof value === 'string' ? value : null;
  }

  channel(name: string): string | null {
    const value = this.raw(name);
    return typeof value === 'string' ? value : null;
  }

  subcommand(): string | null {
    return this.subName;
  }

  sub(): OptionReader | null {
    return this.subName === null ? null : new FakeReader(this.values, null);
  }
}

export interface CtxSpec {
  command: string;
  guildId?: string | null;
  channelId?: string;
  parentChannelId?: string | null;
  channelName?: string;
  userId?: string;
  displayName?: string;
  isAdmin?: boolean;
  sub?: string | null;
  values?: Record<string, OptionValue>;
}

export function makeContext(spec: CtxSpec, platform?: FakePlatform): InteractionContext {
  const channelId = spec.channelId ?? 'C1';
  if (platform) platform.channelNames.set(channelId, spec.channelName ?? channelId);
  return {
    commandName: spec.command,
    guildId: spec.guildId === undefined ? 'G1' : spec.guildId,
    channelId,
    parentChannelId: spec.parentChannelId ?? null,
    channelName: spec.channelName ?? channelId,
    userId: spec.userId ?? 'U1',
    displayName: spec.displayName ?? '甲',
    isAdmin: spec.isAdmin ?? false,
    options: new FakeReader(spec.values ?? {}, spec.sub ?? null),
  };
}

export interface TestEnv {
  deps: HandlerDeps;
  store: MemoryStore;
  platform: FakePlatform;
  dice: StubDice;
  coc: StubCoc;
  rng: FixedRng;
  now: Date;
  confirmations: PendingActions;
}

export function makeEnv(overrides: Partial<HandlerDeps> = {}): TestEnv {
  const store = new MemoryStore();
  const platform = new FakePlatform();
  const dice = new StubDice();
  const coc = new StubCoc();
  const rng = new FixedRng([3, 4, 5, 6, 7, 8, 9, 10]);
  const now = new Date('2026-01-05T21:30:00.000Z');
  const confirmations = overrides.confirmations ?? createPendingActions();
  const deps: HandlerDeps = {
    store,
    dice,
    coc,
    rng,
    platform,
    confirmations,
    now: () => now,
    ...overrides,
  };
  return { deps, store, platform, dice, coc, rng, now, confirmations };
}
