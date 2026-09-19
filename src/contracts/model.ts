/**
 * Shared domain records — owner: Lead (`src/contracts/**`). Frozen: ask the Lead before changing.
 */

/** COC 检定房规 0-6, see docs/Discord_CoC_Command_Set.md §8.1 */
export type HouseRule = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const HOUSE_RULES: readonly HouseRule[] = [0, 1, 2, 3, 4, 5, 6];

export type SuccessLevel = '大成功' | '极难成功' | '困难成功' | '成功' | '失败' | '大失败';

/** A player-owned character sheet (`/pc`, `/st`). */
export interface CharacterSheet {
  /** unique per user */
  name: string;
  /** e.g. `COC7` */
  template: string;
  /** 属性名 -> 原始值（数字字符串或骰式字符串） */
  attrs: Record<string, string>;
  /** `/st &名称=表达式` 保存的掷骰表达式 */
  exprs: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Binding scope: 局 > 当前场景 > 父频道 > **用户（本服常用卡）** > 全局 (docs §10.2)。
 * `user` 是"持久绑定到用户"的那一层：`/pc tag` 会把它记在服务器级，没写 tag 的频道/子区都默认用它。
 */
export type BindingScope = 'game' | 'scene' | 'user' | 'global';

export type GameStatus = 'active' | 'ended';

/** 一局 = 携带 KP / 主场景 / 暗骰子区 / 卡绑定 / 房规 / 日志 的上下文. */
export interface GameRecord {
  /** per-guild display id, e.g. `#1` */
  id: string;
  guildId: string;
  name: string;
  keeperId: string;
  status: GameStatus;
  /** 主场景子区（`thread:` / 自动新建）；`here:true` 就地开在频道时为 null */
  sceneThreadId: string | null;
  /** 父频道 id（暗骰子区与主场景子区的共同父级） */
  parentChannelId: string | null;
  /** 主场景子区是否由 bot 创建（`/game end archive:true` 只归档自建的） */
  sceneThreadCreatedByBot: boolean;
  /** 本局暗骰子区（私密子区） */
  hiddenThreadId: string | null;
  rule: HouseRule | null;
  /** 当前生效日志 id（`/log new` 产生；off 后仍指向它直到新日志开启） */
  currentLogId: string | null;
  startedAt: string;
  endedAt: string | null;
}

export type LogState = 'on' | 'off' | 'ended';

/** 一条日志流；同一局（或同一无局场景）同时最多一条 `on`. */
export interface LogRecord {
  id: string;
  /** 所属局；无局场景日志为 null */
  gameId: string | null;
  /** 建立日志的场景（频道或子区） */
  channelId: string;
  guildId: string;
  name: string;
  state: LogState;
  /** 记录到的所有场景（一局可绑多个场景） */
  sceneIds: string[];
  startedAt: string;
  endedAt: string | null;
  /** 导出文件名（end 时生成） */
  fileName: string | null;
}

/** 场景（频道或子区）-> 局 的当前指针；thread 也是 channel，共用一张表. */
export interface ScenePointer {
  channelId: string;
  guildId: string;
  gameId: string;
}

export const COC7_DEFAULT_TEMPLATE = 'COC7';
