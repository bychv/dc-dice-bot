/**
 * 运行日志（写 stdout，由 systemd 收进 journald）。
 *
 * 目的：**事后能查**。系统的报错日志（`处理 /xxx 失败`）只覆盖抛异常的情况，像
 * 「无法确定『闪避』的成功率」这种**正常返回的回执**原来一条都不留，出问题时无从对照。
 * 现在每条命令记两行：
 *
 *   [2026-09-18 13:02:11] /rc user=甲(123…) scene=T7←C1 game=#1 阿卡姆 sheet=甲卡 rule=1(局) text="闪避"
 *       ↳ FAIL(ephemeral) 当前场景没有生效的角色卡，无法确定「闪避」的成功率。…
 *
 * 上下文里的 `scene=T7←C1` 表示"子区 T7，父频道 C1"，`sheet=无` 即该场景解析不到角色卡——
 * 跨子区、跨频道、绑错卡这类问题一眼能看出来。
 *
 * 关闭：`DCDICE_AUDIT_LOG=0`（默认开）。
 */
import type { HandlerDeps, InteractionContext, ReplyPayload } from '../contracts/bot.ts';
import { currentGame, resolveRule, resolveSheet } from './handlers/context.ts';

/** 单行、限长：日志一行一条，避免把整段回执灌进 journal。 */
function oneLine(text: string, limit: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function stamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

export interface AuditLogger {
  /** 派发前：记录命令 + 解析到的上下文（局 / 角色卡 / 房规 / 原始参数）。 */
  context(ctx: InteractionContext): void;
  /** 回执生成后：记录成功/失败与回执首行。 */
  result(payload: ReplyPayload): void;
  /** 按钮点击（二次确认）。 */
  button(customId: string, userId: string): void;
}

export function auditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DCDICE_AUDIT_LOG !== '0';
}

/** 一行式上下文：命令、用户、场景（子区标注父频道）、局、角色卡、房规、参数。 */
export function describeContext(ctx: InteractionContext, deps: HandlerDeps): string {
  const game = currentGame(ctx, deps);
  const sheet = resolveSheet(ctx, deps);
  const { rule, source } = resolveRule(ctx, deps);
  const scene = ctx.parentChannelId ? `${ctx.channelId}←${ctx.parentChannelId}` : ctx.channelId;
  const sub = ctx.options.subcommand();
  const text = ctx.options.string('text');
  const name = ctx.options.string('name');
  const args = [
    text && text.trim().length > 0 ? `text="${oneLine(text, 60)}"` : '',
    name ? `name="${oneLine(name, 30)}"` : '',
  ].filter((part) => part.length > 0);
  return [
    `/${ctx.commandName}${sub ? ` ${sub}` : ''}`,
    `user=${ctx.displayName}(${ctx.userId})`,
    `scene=${scene}`,
    `game=${game ? `${game.id} ${game.name}` : '无'}`,
    `sheet=${sheet ? sheet.name : '无'}`,
    `rule=${rule}(${source === 'game' ? '局' : source === 'scene' ? '场景' : '默认'})`,
    ...args,
  ].join(' ');
}

/** 回执摘要：`OK/FAIL` + 是否 ephemeral + 截断后的首行。 */
export function describeResult(payload: ReplyPayload): string {
  const verdict = payload.ok === false ? 'FAIL' : 'OK';
  const scope = payload.ephemeral ? 'ephemeral' : 'public';
  const files = payload.files && payload.files.length > 0 ? ` files=${payload.files.length}` : '';
  return `${verdict}(${scope}${files}) ${oneLine(payload.content, 200)}`;
}

export function createAuditLogger(deps: HandlerDeps, env: NodeJS.ProcessEnv = process.env): AuditLogger {
  const enabled = auditEnabled(env);
  const now = (): Date => deps.now();
  return {
    context(ctx: InteractionContext): void {
      if (!enabled) return;
      try {
        console.log(`[${stamp(now())}] ${describeContext(ctx, deps)}`);
      } catch (error) {
        console.error('运行日志（context）写入失败：', error);
      }
    },
    result(payload: ReplyPayload): void {
      if (!enabled) return;
      try {
        console.log(`    ↳ ${describeResult(payload)}`);
      } catch (error) {
        console.error('运行日志（result）写入失败：', error);
      }
    },
    button(customId: string, userId: string): void {
      if (!enabled) return;
      console.log(`[${stamp(now())}] button ${customId.split(':')[0] ?? customId} user=${userId}`);
    },
  };
}
