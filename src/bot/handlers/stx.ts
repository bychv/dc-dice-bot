/**
 * `/stx` — 查看某人（默认自己）的角色卡属性，供 KP 核对（docs §6.2）。
 *
 * 与 `/st` 的分工：`/st` 改**自己**的卡；`/stx` **只读**别人的卡。
 * - 省略 `name` 时用与检定完全相同的解析链（局 → 场景 → 父频道 → 用户级 → 全局），
 *   所以看到的就是"这个人在这个场景里掷骰会用的那张卡"；
 * - **回执 ephemeral**：属性表（技能 / SAN / 生命）比卡名私密，默认不贴进公共频道；
 * - 找不到卡时列出该用户名下的卡名，而不是只说"没有角色卡"。
 */
import type { CommandHandler, HandlerDeps, InteractionContext, ReplyPayload } from '../../contracts/bot.ts';
import type { CharacterSheet } from '../../contracts/model.ts';
import { resolveSheetFor, type SceneKey } from './context.ts';
import { mentionUser } from './format.ts';
import { clamp, fail, optionString, optionUser } from './options.ts';

/** 8 项主属性；其余按"状态"或"技能/自定义"归类。 */
const PRIMARY = ['力量', '体质', '体型', '敏捷', '外貌', '智力', '意志', '教育'];
const DERIVED = ['幸运', '理智', '生命', '魔法'];

function formatAttrs(sheet: CharacterSheet): string[] {
  const attrs = Object.entries(sheet.attrs);
  const primary = PRIMARY.filter((key) => sheet.attrs[key] !== undefined).map((key) => `${key} ${sheet.attrs[key]}`);
  const derived = DERIVED.filter((key) => sheet.attrs[key] !== undefined).map((key) => `${key} ${sheet.attrs[key]}`);
  const skills = attrs
    .filter(([key]) => !PRIMARY.includes(key) && !DERIVED.includes(key))
    .sort((a, b) => {
      const left = Number(a[1]);
      const right = Number(b[1]);
      if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return right - left;
      return a[0].localeCompare(b[0]);
    })
    .map(([key, value]) => `${key} ${value}`);

  const lines: string[] = [];
  if (primary.length > 0) lines.push(`主属性：${primary.join('　')}`);
  if (derived.length > 0) lines.push(`状态：${derived.join('　')}`);
  if (skills.length > 0) lines.push(`技能/自定义（${skills.length} 项，按值降序）：`, ...skills.map((skill) => `· ${skill}`));
  const exprs = Object.entries(sheet.exprs ?? {});
  if (exprs.length > 0) lines.push(`骰式：${exprs.map(([key, value]) => `${key}=${value}`).join('　')}`);
  lines.push(`更新于 ${sheet.updatedAt}`);
  return lines;
}

function block(sheet: CharacterSheet, userId: string): ReplyPayload {
  const lines = [`【${sheet.name}】${mentionUser(userId)}　模板 ${sheet.template}`, ...formatAttrs(sheet)];
  return { content: clamp(lines.join('\n')), ephemeral: true, ok: true };
}

export const stxHandler: CommandHandler = async (ctx, deps): Promise<ReplyPayload> => {
  const targetId = optionUser(ctx, 'user') ?? ctx.userId;
  const name = optionString(ctx, 'name')?.trim() || null;

  if (name) {
    const sheet = deps.store.getSheet(targetId, name);
    if (sheet) return block(sheet, targetId);
    const owned = deps.store.listSheets(targetId).map((sheet) => sheet.name);
    if (owned.length === 0) return fail(`${mentionUser(targetId)} 还没有角色卡。`);
    return fail(
      `${mentionUser(targetId)} 没有名为「${name}」的角色卡。\n` + `他名下的卡：${owned.join('、')}`,
    );
  }

  const key: SceneKey = {
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    parentChannelId: ctx.parentChannelId,
    userId: targetId,
  };
  const active = resolveSheetFor(deps.store, key);
  if (active) return block(active, targetId);

  const owned = deps.store.listSheets(targetId).map((sheet) => sheet.name);
  if (owned.length === 0) return fail(`${mentionUser(targetId)} 还没有角色卡。`);
  return fail(
    `${mentionUser(targetId)} 在当前场景没有生效的角色卡。\n` +
      `他名下的卡：${owned.join('、')}\n` +
      '用 `/stx name:<卡名>` 查看指定的一张。',
  );
};

/** `/st` 的说明里引用到的「查看他人」入口（保持文档与实现同源）。 */
export type { CharacterSheet };
export { formatAttrs };
