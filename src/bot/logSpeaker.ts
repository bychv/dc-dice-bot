/**
 * 日志里的**说话人名字**。
 *
 * 对齐 Dice! `idx_pc`（`ref/Dice/Dice/CharacterCard.cpp:737`）：
 *   1. 该玩家在**当前上下文**里生效的角色卡名（局 → 本场景 → 父频道 → 全局，与 `/rc` 同一解析链）；
 *   2. 没卡（或卡名是占位名）时回退**称呼**（`/nn`：本场景 → 全局）；
 *   3. 都没有 → Discord 显示名（服务器昵称 > 全局显示名 > 用户名），即 `fallback`。
 *
 * **每写一行都重新解析**：中途改卡名（`/pc rename`）、改称呼（`/nn`）、切局（`/game switch`）
 * 或换场景，之后的行会跟着换成新名字；已经写进日志的行保持不变。
 */
import type { BotStore } from '../contracts/store.ts';
import { resolveNickFor, resolveSheetFor, type SceneKey } from './handlers/context.ts';

/** Dice! 里被当作「没名字」的占位卡名（`idx_pc` 跳过 `"角色卡"`；本移植的占位名如下）。 */
const PLACEHOLDER_SHEET_NAMES = new Set(['', '角色卡', '默认卡', '未命名']);

/** 日志行里的说话人名字；任何解析异常都回退到 `fallback`，绝不影响记录。 */
export function speakerName(store: BotStore, key: SceneKey, fallback: string): string {
  const fallbackName = fallback?.trim();
  try {
    const cardName = resolveSheetFor(store, key)?.name?.trim() ?? '';
    if (cardName.length > 0 && !PLACEHOLDER_SHEET_NAMES.has(cardName)) return cardName;
    const nick = resolveNickFor(store, key)?.trim() ?? '';
    if (nick.length > 0) return nick;
  } catch {
    // 取名失败只影响日志里的名字，回退显示名
  }
  return fallbackName && fallbackName.length > 0 ? fallbackName : '未知';
}

/** 骰娘自己那行的名字：服务器昵称（在群里「设定的名字」）> Discord 用户名。 */
export function botSpeakerName(
  nickname: string | null | undefined,
  username: string | null | undefined,
): string {
  const nick = nickname?.trim();
  if (nick && nick.length > 0) return nick;
  const name = username?.trim();
  return name && name.length > 0 ? name : 'Dice';
}
