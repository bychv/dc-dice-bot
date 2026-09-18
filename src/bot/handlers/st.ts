/**
 * `/st` — 属性录入与修改，整行原文解析 (docs §6.1).
 *
 * The line is handed to `deps.coc`; a mutated sheet is written back through the store. When the
 * user has no active card yet the manual's "default COC7 card" is adopted/created (see
 * `context.adoptSheet`) so `/st` works without a prior `/pc tag`.
 *
 * `clr` 是唯一会整卡清空的写法，属破坏性操作 (docs §16.6)：首次只列出范围并要求按钮确认。
 *
 * 粘贴进来的整行命令可能带前导 `.st` / `/st`（外部骰娘导出），`stripStPrefix` 先剥掉再判分支；
 * 这一步必须在 `clr` 判定**之前**，否则 `.st clr` 会绕过二次确认。
 */
import type { CommandHandler, HandlerDeps, InteractionContext, ReplyPayload } from '../../contracts/bot.ts';
import { stripStPrefix } from '../../coc/st.ts';
import { askConfirm } from '../confirm.ts';
import { adoptSheet, resolveSheet } from './context.ts';
import { clamp, fail, ok, optionString } from './options.ts';

/** 与 `src/coc/st.ts` 的前缀判定保持一致：`clr`、`clr ` 都算，`clear` 不算。 */
const CLR_PREFIX = /^clr(?=\s|$)/i;

/**
 * `/st clr`：清空当前角色卡的属性与表达式 (docs §6.1)。
 *
 * 用 `resolveSheet` 而不是 `adoptSheet`：后者在"一张卡都没有"时会**新建并绑定**一张卡，
 * 那本身就是改动数据，会让"首次调用绝不改动数据"落空。
 */
async function stClear(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const active = resolveSheet(ctx, deps);
  const owned = deps.store.listSheets(ctx.userId);
  const target = active ?? (owned.length === 1 ? owned[0] : null);

  if (!target) {
    if (owned.length === 0) {
      return ok('你还没有角色卡，没有可清空的属性。用 `/pc new` 新建一张吧。');
    }
    return fail('你有多个角色卡，但当前场景没有生效的绑定；请先用 `/pc tag name:卡名` 选择要清空的卡。');
  }

  const attrCount = Object.keys(target.attrs).length;
  const exprCount = Object.keys(target.exprs).length;
  const summary = clamp(
    [
      `⚠️ 危险操作：即将清空角色卡「${target.name}」的全部属性（${attrCount} 项）与表达式（${exprCount} 项）。`,
      '确认后不可撤销。请点击下方「确认执行」（5 分钟内有效，仅你本人可确认）。',
    ].join('\n'),
  );

  return askConfirm(deps, ctx, {
    summary,
    onConfirm: async () => {
      const current = deps.store.getSheet(ctx.userId, target.name);
      if (!current) return fail(`角色卡「${target.name}」已不存在，无需清空。`);
      const result = deps.coc.applySt('clr', current);
      if (!result.ok) return fail(result.error);
      const sheet = result.sheet ?? current;
      deps.store.putSheet(ctx.userId, sheet);
      const lines = result.lines.length > 0 ? result.lines : [`已清空角色卡「${sheet.name}」。`];
      return ok(clamp(lines.join('\n')));
    },
  });
}

export const stHandler: CommandHandler = async (ctx, deps) => {
  const text = optionString(ctx, 'text');
  // 粘贴进来的整行命令可能带 `.st` / `/st` 前缀（外部骰娘导出），先剥掉再判分支；
  // 注意必须在 `clr` 判定之前剥，否则 `.st clr` 会绕过二次确认。
  const raw = stripStPrefix(text ?? '');
  if (raw.length === 0) {
    return fail('请提供要录入的属性文本，例如 `/st 力量:50 体质:55`、`/st hp-1`、`/st &沙漠之鹰=1D10+1D6+3`。');
  }
  if (CLR_PREFIX.test(raw)) return stClear(ctx, deps);

  const adopted = adoptSheet(ctx, deps);
  if (!adopted) {
    return fail('你有多个角色卡，但当前场景没有生效的绑定；请先用 `/pc tag name:卡名` 选择要录入的卡。');
  }

  const result = deps.coc.applySt(raw, adopted.sheet);
  if (!result.ok) return fail(result.error);

  const sheet = result.sheet ?? adopted.sheet;
  deps.store.putSheet(ctx.userId, sheet);

  const lines: string[] = [];
  if (adopted.created) lines.push(`（当前场景没有角色卡，已自动新建并绑定「${sheet.name}」）`);
  lines.push(...(result.lines.length > 0 ? result.lines : [`已更新角色卡「${sheet.name}」。`]));
  return ok(clamp(lines.join('\n')));
};
