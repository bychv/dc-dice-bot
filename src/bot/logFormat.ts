/**
 * Dice!-compatible log line format and export naming — owner: this file.
 *
 * 参数来源（ref/ 里的 Dice! 原实现，逐条对应）：
 * - 行格式 `DiceEvent.cpp:188/222/239`（玩家消息 `fwdMsg`、骰娘回执 `logEcho`、暗骰回执 `replyHidden`）：
 *     `<名字>(<uid>) <YYYY-MM-DD HH:MM:SS>\n<内容>\n\n`
 *   玩家名 = `idx_pc(*this).to_str()`（该局的卡/称呼），骰娘名 = `getMsg("strSelfName")`，
 *   uid = `fromChat.uid` / `console.DiceMaid`。玩家消息与骰娘回执都进同一条日志；
 *   `.log` 指令本身被 `strLowerMessage.find(".log") != 0` 排除。
 * - 时间 `DiceSchedule.cpp:319` `printTTime`：`localtime_s`/`localtime_r` + `strftime("%Y-%m-%d %H:%M:%S")`
 *   → 本地时间、逐字段零填充。
 * - 落盘 `DiceSession.cpp:30` `LogInfo::append`：`ofstream(..., ios::app) << s` —— 原样追加，行与行之间
 *   不再补分隔（分隔符已经在线内的 `\n\n` 里）。
 * - 文件名 `DiceSession.cpp:200` `DiceSession::log_new`：`name + "_" + nameLog + ".txt"`
 *   （`name` = 会话名，`nameLog` = `readFileName()`，空则回退时间戳字符串）。
 *
 * 与 Dice! 的已知差异（有意保留，记录在此以便核对）：
 * - Dice! 在写日志前会跑 `filter_CQcode` / `forward_filter`（CQ 码与转发前缀过滤）；本移植直接
 *   使用已由适配层整理过的消息正文，不做 CQ 码过滤（Discord 侧没有 CQ 码概念）。
 * - Dice! 的文件名不做非法字符清洗（依赖 `UTF8toPath` 与 `readFileName()` 的约束）；这里额外把
 *   `\/:*?"<>|` 与控制字符替换为 `_`，并按 UTF-8 字节截断，保证任何平台上都能落盘。
 */

/** 接收「已格式化整行」的最小 sink —— `BotStore` 结构化兼容。返回写入的日志条数。 */
export interface DiceLogAppendSink {
  appendLogLine(channelId: string, line: string): number;
}

export interface DiceLogLineInput {
  /** 玩家在该局的称呼（Dice! `idx_pc().to_str()`）；骰娘回执时为骰娘名 */
  name: string;
  /** Discord 用户 id（Dice! 里是数值 uid） */
  uid: string;
  /** 消息时间；按**本地时间**输出，与 Dice! `printTTime` 的 localtime 一致 */
  at: Date;
  /** 正文；原样写入，不做转义/裁剪 */
  text: string;
}

/** 骰娘回执的入参（与玩家消息同形，供 `respond` 调用，字段顺序按 task-7 约定）。 */
export interface DiceLogReplyInput {
  uid: string;
  name: string;
  at: Date;
  text: string;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Dice! `printTTime` 的等价实现：`YYYY-MM-DD HH:MM:SS`，本地时间、零填充。
 * 用 `getFullYear/getMonth/...`（本地时间读数）而不是 `toISOString()`（UTC）。
 */
export function formatDiceTimestamp(at: Date): string {
  return (
    `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ` +
    `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`
  );
}

/** `<名字>(<uid>) <时间>\n<正文>\n\n` —— 玩家消息与骰娘回执共用的 Dice! 日志行。 */
export function formatDiceLogLine(input: DiceLogLineInput): string {
  return `${input.name}(${input.uid}) ${formatDiceTimestamp(input.at)}\n${input.text}\n\n`;
}

/** 把玩家消息按 Dice! 格式追加到频道当前 `on` 日志；返回写入的日志条数（0 = 该场景没有生效日志）。 */
export function appendUserLogLine(
  store: DiceLogAppendSink,
  channelId: string,
  input: DiceLogLineInput,
): number {
  return store.appendLogLine(channelId, formatDiceLogLine(input));
}

/** 把骰娘回执按 Dice! 格式追加到频道当前 `on` 日志（`respond` 集成时调用）。 */
export function appendBotReplyLine(
  store: DiceLogAppendSink,
  channelId: string,
  input: DiceLogReplyInput,
): number {
  return store.appendLogLine(
    channelId,
    formatDiceLogLine({ name: input.name, uid: input.uid, at: input.at, text: input.text }),
  );
}

/** Windows/POSIX 都不安全的文件名字符 + 控制字符。 */
const ILLEGAL_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * 单个文件名片段的安全长度（UTF-8 字节）。`ext4` 的单个文件名上限是 255 字节，
 * 两个片段 + `_` + `.txt` 要留在一起，80 字节给每个片段是安全余量。
 */
const MAX_PART_BYTES = 80;

function sanitizeFilePart(value: string, fallback: string): string {
  // 空 / 纯空白 / 纯非法字符（替换后只剩 `_`）都视作「没有可用名字」
  if (!/[^\\/:*?"<>|\u0000-\u001f\s.]/.test(value)) return fallback;

  const cleaned = value
    .replace(ILLEGAL_FILE_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (cleaned.length === 0) return fallback;

  // 按 UTF-8 字节截断，且不切开代理对/多字节字符
  let bytes = 0;
  let out = '';
  for (const ch of cleaned) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > MAX_PART_BYTES) break;
    bytes += size;
    out += ch;
  }
  out = out.replace(/[. ]+$/, '');
  return out.length > 0 ? out : fallback;
}

/**
 * Dice! `DiceSession::log_new` 的文件名：`<会话名>_<日志名>.txt`。
 * 空值分别回退 `session` / `log`；非法字符替换为 `_`，超长按 UTF-8 字节截断。
 * **两段相同时省略重复段**（`/game start` 自动开的日志名就是桌名）：
 * `阿卡姆_阿卡姆.txt` → `阿卡姆.txt`；显式命名（`/log new name:第一夜`）仍为 `阿卡姆_第一夜.txt`。
 */
export function diceLogFileName(sessionName: string, logName: string): string {
  const session = sanitizeFilePart(sessionName, 'session');
  const log = sanitizeFilePart(logName, 'log');
  return session === log ? `${session}.txt` : `${session}_${log}.txt`;
}

/**
 * 摊开在场发言（PL/OOC）：Discord 里玩家用括号说场外话，这类行**不进日志**。
 * 全角 `（）` 与半角 `()` 一视同仁；只看**开头**（`（图）` 会被跳过，但 `（笑）你好` 也会——
 * 与 logPainter 的「过滤 () 发言」开关同口径：以括号开头的整条消息视为场外）。
 */
export function isOutOfCharacterText(text: string): boolean {
  const trimmed = (text ?? '').trimStart();
  return trimmed.startsWith('(') || trimmed.startsWith('（');
}

/**
 * 会话名：有局时取局名（Dice! 的 `DiceSession.name`），局查不到或场景日志回退日志名。
 * `getGame` 传入 `store.getGame.bind(store)` 即可。
 */
export function diceLogSessionName(
  log: { gameId: string | null; guildId: string; name: string },
  getGame: (guildId: string, gameId: string) => { name: string } | null,
): string {
  if (log.gameId === null) return log.name;
  return getGame(log.guildId, log.gameId)?.name ?? log.name;
}
