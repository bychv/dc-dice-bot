/**
 * `/rc`, `/ra`, `/sc`, `/en` — 整行原文解析的检定命令 (docs §7.1, §9.1, §9.3).
 *
 * Everything rule-specific lives behind `deps.coc`; this module only resolves the context
 * (角色卡 + 房规, 局优先于场景) and persists any sheet the engine mutated.
 */
import type { CommandHandler, InteractionContext, ReplyPayload } from '../../contracts/bot.ts';
import { resolveRule, resolveSheet, resolveSheetFor } from './context.ts';
import { speakerName } from '../logSpeaker.ts';
import { clamp, fail, ok, optionString, optionUser } from './options.ts';

/** First plain integer after the skill/spec token — `san` for /sc, 技能值 for /en. */
export function parseTrailingNumber(text: string, skipFirstToken: boolean): number | null {
  const tokens = text.trim().split(/\s+/);
  for (let i = skipFirstToken ? 1 : 0; i < tokens.length; i += 1) {
    if (/^\d+$/.test(tokens[i])) return Number(tokens[i]);
  }
  return null;
}

function requireTextArgument(ctx: InteractionContext, name: string): string | ReplyPayload {
  const text = optionString(ctx, 'text');
  if (!text || text.trim().length === 0) {
    return fail(`请提供检定文本，例如 \`/${name} 力量\`、\`/${name} 困难智力 99\`。`);
  }
  return text.trim();
}

function makeCheckHandler(name: string): CommandHandler {
  return async (ctx, deps) => {
    const text = requireTextArgument(ctx, name);
    if (typeof text !== 'string') return text;
    const sheet = resolveSheet(ctx, deps);
    const { rule } = resolveRule(ctx, deps);
    const result = deps.coc.check(text, { sheet, rule, rng: deps.rng });
    if (!result.ok) return fail(result.error);
    return ok(clamp(result.lines.join('\n')));
  };
}

export const rcHandler = makeCheckHandler('rc');
export const raHandler = makeCheckHandler('ra');

/**
 * `/rcx`、`/rax` — **代投**：用 `user` 选项指定的人**在当前场景的角色卡**替他检定，
 * 回执以**被代投者的角色卡名**开头（`【卡名】…`）。
 *
 * - 省略 `user` 就是给自己投，行为等同 `/rc`（回执仍以卡名开头，与适配层的 `【使用者】` 一致）；
 * - 标签解析与日志说话人同一套（角色卡名 → 称呼 `/nn` → `<@id>` 兜底），所以被代投者没卡时
 *   回执里会直接 @ 到他，不会张冠李戴；
 * - 代投时在末尾补一行"由谁代投"：Discord 的斜杠命令**不进日志**，只记骰娘回执，
 *   不写这一行日志里就看不出是谁替他投的。
 * - 由于回执已以 `【` 开头，适配层的 `actorEcho`（幂等）不会再叠一层发起人的名字。
 */
function makeProxyCheckHandler(name: string): CommandHandler {
  return async (ctx, deps) => {
    const text = requireTextArgument(ctx, name);
    if (typeof text !== 'string') return text;
    const targetId = optionUser(ctx, 'user') ?? ctx.userId;
    const targetKey = {
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      parentChannelId: ctx.parentChannelId,
      userId: targetId,
    };
    const sheet = resolveSheetFor(deps.store, targetKey);
    const { rule } = resolveRule(ctx, deps);
    const result = deps.coc.check(text, { sheet, rule, rng: deps.rng });

    const label = speakerName(deps.store, targetKey, `<@${targetId}>`);
    const prefix = `【${label}】`;
    if (!result.ok) return fail(`${prefix}${result.error}`);

    const note = targetId === ctx.userId ? '' : `\n（由 <@${ctx.userId}> 代投）`;
    return ok(clamp(`${prefix}${result.lines.join('\n')}${note}`));
  };
}

export const rcxHandler = makeProxyCheckHandler('rcx');
export const raxHandler = makeProxyCheckHandler('rax');

export const scHandler: CommandHandler = async (ctx, deps) => {
  const text = requireTextArgument(ctx, 'sc');
  if (typeof text !== 'string') return text;
  const sheet = resolveSheet(ctx, deps);
  const { rule } = resolveRule(ctx, deps);
  const result = deps.coc.sanity(text, {
    sheet,
    rule,
    rng: deps.rng,
    sanOverride: parseTrailingNumber(text, true),
  });
  if (!result.ok) return fail(result.error);
  if (result.sheet) deps.store.putSheet(ctx.userId, result.sheet);
  return ok(clamp(result.lines.join('\n')));
};

export const enHandler: CommandHandler = async (ctx, deps) => {
  const text = requireTextArgument(ctx, 'en');
  if (typeof text !== 'string') return text;
  const sheet = resolveSheet(ctx, deps);
  const { rule } = resolveRule(ctx, deps);
  const result = deps.coc.improve(text, {
    sheet,
    rule,
    rng: deps.rng,
    valueOverride: parseTrailingNumber(text, true),
  });
  if (!result.ok) return fail(result.error);
  if (result.sheet) deps.store.putSheet(ctx.userId, result.sheet);
  return ok(clamp(result.lines.join('\n')));
};
