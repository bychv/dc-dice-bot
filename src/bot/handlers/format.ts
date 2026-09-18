/**
 * Human-readable formatting for replies (plain text; the adapter may wrap it in an embed).
 */
import type { InteractionContext } from '../../contracts/bot.ts';
import type { GameRecord, LogRecord } from '../../contracts/model.ts';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `MMDD-HHmm`, used for default table / log names (docs §10.1). */
export function fmtStamp(date: Date): string {
  return `${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}

/** `MM-DD HH:mm`, used when listing logs (docs §11.1). */
export function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function mentionChannel(channelId: string | null): string {
  return channelId ? `<#${channelId}>` : '未设置';
}

export function mentionUser(userId: string | null): string {
  return userId ? `<@${userId}>` : '未设置';
}

export function sceneKind(ctx: InteractionContext): string {
  return ctx.parentChannelId ? '子区' : '频道';
}

export function gameStatusLabel(game: GameRecord): string {
  return game.status === 'ended' ? '已结束' : '进行中';
}

/** `#1 阿卡姆（KP:@甲，进行中，主场景 #阿卡姆，暗骰区 #amk-roll）` — docs §10.1 `list`. */
export function fmtGameLine(game: GameRecord): string {
  const scene = game.sceneThreadId ?? game.parentChannelId;
  return `${game.id} ${game.name}（KP:${mentionUser(game.keeperId)}，${gameStatusLabel(game)}，主场景 ${mentionChannel(scene)}，暗骰区 ${mentionChannel(game.hiddenThreadId)}）`;
}

export function logStateLabel(state: LogRecord['state']): string {
  switch (state) {
    case 'on':
      return '记录中';
    case 'off':
      return '已暂停';
    case 'ended':
      return '已结束';
  }
}

/** `「第一夜」 记录中 · 开始于 01-05 21:30` — docs §11.1 `list`. */
export function fmtLogLine(log: LogRecord, isCurrent = false): string {
  return `「${log.name}」 ${logStateLabel(log.state)} · 开始于 ${fmtDateTime(log.startedAt)}${isCurrent ? ' ← 当前生效' : ''}`;
}

export const RULE_SOURCE_LABEL: Record<'game' | 'scene' | 'default', string> = {
  game: '本局房规',
  scene: '场景房规',
  default: '骰主默认规则',
};

export function fmtRule(rule: number, source: 'game' | 'scene' | 'default'): string {
  return `${rule}（来源：${RULE_SOURCE_LABEL[source]}）`;
}
