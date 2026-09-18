/**
 * Slash-command router: `InteractionContext` + `HandlerDeps` → `ReplyPayload`.
 *
 * Used by the discord.js adapter in production and directly by the behaviour tests. A handler
 * throwing never breaks the interaction: the error is turned into an ephemeral reply.
 */
import type { CommandHandler, HandlerDeps, InteractionContext, ReplyPayload } from '../contracts/bot.ts';
import { handlerFor } from './registry.ts';

export async function route(
  ctx: InteractionContext,
  deps: HandlerDeps,
): Promise<ReplyPayload> {
  const handler: CommandHandler | undefined = handlerFor(ctx.commandName);
  if (!handler) {
    return { content: `未知命令 \`/${ctx.commandName}\`（未注册处理器）。`, ephemeral: true };
  }
  try {
    return await handler(ctx, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: `执行 \`/${ctx.commandName}\` 时出错：${message}`, ephemeral: true };
  }
}
