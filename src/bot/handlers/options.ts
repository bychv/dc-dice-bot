/**
 * Option reading + reply helpers shared by every handler.
 *
 * Discord nests subcommand options under the subcommand, so every read tries the invoked
 * subcommand first and then falls back to the top level (this also lets tests use a flat reader).
 */
import type { InteractionContext, OptionReader, ReplyPayload } from '../../contracts/bot.ts';

function read<T>(
  ctx: InteractionContext,
  pick: (reader: OptionReader) => T | null | undefined,
): T | null {
  const sub = ctx.options.sub();
  if (sub) {
    const scoped = pick(sub);
    if (scoped !== null && scoped !== undefined) return scoped;
  }
  const top = pick(ctx.options);
  return top === null || top === undefined ? null : top;
}

export function optionString(ctx: InteractionContext, name: string): string | null {
  return read(ctx, (r) => r.string(name));
}

/** Trimmed string that must be non-empty. */
export function requireText(ctx: InteractionContext, name: string): string | null {
  const value = optionString(ctx, name);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function optionInteger(ctx: InteractionContext, name: string): number | null {
  return read(ctx, (r) => r.integer(name));
}

export function optionBoolean(ctx: InteractionContext, name: string): boolean | null {
  return read(ctx, (r) => r.boolean(name));
}

export function optionUser(ctx: InteractionContext, name: string): string | null {
  return read(ctx, (r) => r.user(name));
}

export function optionChannel(ctx: InteractionContext, name: string): string | null {
  return read(ctx, (r) => r.channel(name));
}

export function subcommand(ctx: InteractionContext): string | null {
  return ctx.options.subcommand();
}

export function ok(content: string, files?: ReplyPayload['files']): ReplyPayload {
  const payload: ReplyPayload = { content, ok: true };
  if (files && files.length > 0) payload.files = files;
  return payload;
}

/** Errors / permission refusals are ephemeral so they do not spam the scene (docs §1.4/§16.6). */
export function fail(content: string): ReplyPayload {
  return { content, ephemeral: true, ok: false };
}

/** Discord caps a message at 2000 chars; keep replies inside the limit (docs §1.5). */
export function clamp(content: string, limit = 1900): string {
  if (content.length <= limit) return content;
  return `${content.slice(0, limit - 20)}\n…（输出过长已截断）`;
}
