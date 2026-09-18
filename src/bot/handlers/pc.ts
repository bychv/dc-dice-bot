/**
 * `/pc` — 多角色卡管理 (docs §5.1).
 *
 * `tag` writes to the **session** when the scene belongs to one (局内所有场景共享、切局自动跟随),
 * otherwise to the scene, and in DM to the global default. Reads walk 局 > 场景 > 全局.
 */
import type { CommandHandler, HandlerDeps, InteractionContext, ReplyPayload } from '../../contracts/bot.ts';
import type { CharacterSheet } from '../../contracts/model.ts';
import { COC7_DEFAULT_TEMPLATE } from '../../contracts/model.ts';
import { askConfirm } from '../confirm.ts';
import {
  GLOBAL_BINDING_KEY,
  bindingCandidates,
  currentGame,
  resolveSheet,
  sheetBindingScope,
} from './context.ts';
import { fmtDateTime, mentionChannel } from './format.ts';
import { randomName } from './names.ts';
import { clamp, fail, ok, optionString, requireText, subcommand } from './options.ts';
import {
  MAX_SHEETS_PER_USER,
  createSheet,
  renderSheet,
  rollCoc7Attrs,
  uniqueSheetName,
} from './sheets.ts';

function bindSheet(
  ctx: InteractionContext,
  deps: HandlerDeps,
  name: string | null,
): { label: string; shared: boolean } {
  const target = sheetBindingScope(ctx, deps);
  deps.store.setBinding(target.scope, target.key, ctx.userId, name);
  const label =
    target.scope === 'game'
      ? `本局 ${target.key}`
      : target.scope === 'scene'
        ? `场景 ${mentionChannel(target.key)}`
        : '全局默认（DM）';
  return { label, shared: target.scope === 'game' };
}

/** Clear every binding of this user that points at `name` (only the keys we can enumerate). */
function unbindName(ctx: InteractionContext, deps: HandlerDeps, name: string): void {
  const keys = bindingCandidates(ctx, deps);
  for (const target of keys) {
    if (deps.store.getBinding(target.scope, target.key, ctx.userId) === name) {
      deps.store.setBinding(target.scope, target.key, ctx.userId, null);
    }
  }
  if (ctx.guildId) {
    for (const game of deps.store.listGames(ctx.guildId)) {
      if (deps.store.getBinding('game', game.id, ctx.userId) === name) {
        deps.store.setBinding('game', game.id, ctx.userId, null);
      }
    }
  }
}

async function pcNew(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const requested = optionString(ctx, 'name')?.trim() || null;
  const template = optionString(ctx, 'template')?.trim() || COC7_DEFAULT_TEMPLATE;
  const text = optionString(ctx, 'text')?.trim() || null;
  const owned = deps.store.listSheets(ctx.userId);
  if (owned.length >= MAX_SHEETS_PER_USER) {
    return fail(`每人最多保存 ${MAX_SHEETS_PER_USER} 张角色卡；请先用 /pc del 删除旧卡。`);
  }

  let name = requested ?? randomName(deps.rng, 'cn');
  if (deps.store.getSheet(ctx.userId, name)) {
    if (requested) return fail(`已存在同名角色卡「${name}」。`);
    name = uniqueSheetName(deps.store, ctx.userId, name);
  }

  let sheet = createSheet(name, template, deps.now());
  const lines = [`已新建角色卡「${sheet.name}」（模板 ${sheet.template}）。`];
  if (text) {
    const applied = deps.coc.applySt(text, sheet);
    if (!applied.ok) lines.push(`text 参数未生效：${applied.error}`);
    else {
      if (applied.sheet) sheet = applied.sheet;
      lines.push(...applied.lines);
    }
  }
  deps.store.putSheet(ctx.userId, sheet);

  // 之前没有任何生效卡时顺手绑定当前作用域，之后可随时 /pc tag 改
  if (!resolveSheet(ctx, deps)) {
    const { label, shared } = bindSheet(ctx, deps, sheet.name);
    lines.push(`已自动绑定到${label}${shared ? '（局内所有场景共享）' : ''}。`);
  }
  return ok(clamp(lines.join('\n')));
}

async function pcTag(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const name = optionString(ctx, 'name')?.trim() || null;
  const game = currentGame(ctx, deps);

  if (!name) {
    const { label } = bindSheet(ctx, deps, null);
    const fallback = resolveSheet(ctx, deps);
    return ok(
      `已解绑${label}的角色卡绑定，回落到${
        fallback ? `「${fallback.name}」` : '无（可用 /pc tag name:卡名 绑定，或 /pc new 新建）'
      }。`,
    );
  }

  const sheet = deps.store.getSheet(ctx.userId, name);
  if (!sheet) {
    return fail(`没有名为「${name}」的角色卡。用 \`/pc list\` 查看，或 \`/pc new name:${name}\` 新建。`);
  }
  const { label, shared } = bindSheet(ctx, deps, sheet.name);
  const lines = [`已把角色卡「${sheet.name}」绑定到${label}${shared ? '（局内所有场景共享，切局自动跟随）' : ''}。`];
  if (game) lines.push(`切换局（/game switch）时角色卡会自动跟着换，不需要重新 tag。`);
  return ok(lines.join('\n'));
}

async function pcShow(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const name = optionString(ctx, 'name')?.trim() || null;
  const sheet = name ? deps.store.getSheet(ctx.userId, name) : resolveSheet(ctx, deps);
  if (!sheet) {
    return fail(
      name
        ? `没有名为「${name}」的角色卡。`
        : '当前没有生效的角色卡；用 `/pc new` 新建或 `/pc tag name:卡名` 绑定。',
    );
  }
  return ok(clamp(renderSheet(sheet).join('\n')));
}

async function pcRename(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const name = requireText(ctx, 'name');
  if (!name) return fail('请提供新卡名，例如 `/pc rename name:卡特`。');
  const active = resolveSheet(ctx, deps);
  if (!active) return fail('当前没有生效的角色卡。');
  if (active.name === name) return ok(`角色卡已经叫「${name}」了。`);
  if (deps.store.getSheet(ctx.userId, name)) return fail(`已存在同名角色卡「${name}」。`);

  const renamed: CharacterSheet = { ...active, name, updatedAt: deps.now().toISOString() };
  deps.store.putSheet(ctx.userId, renamed);
  deps.store.deleteSheet(ctx.userId, active.name);
  unbindName(ctx, deps, active.name);
  bindSheet(ctx, deps, name);
  return ok(`已把角色卡「${active.name}」重命名为「${name}」。`);
}

async function pcCopy(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const from = requireText(ctx, 'from');
  const to = requireText(ctx, 'to');
  if (!from || !to) return fail('请提供源卡与目标卡，例如 `/pc copy from:卡特 to:卡特2`。');
  const source = deps.store.getSheet(ctx.userId, from);
  if (!source) return fail(`没有名为「${from}」的角色卡。`);
  const existing = deps.store.getSheet(ctx.userId, to);
  if (!existing && deps.store.listSheets(ctx.userId).length >= MAX_SHEETS_PER_USER) {
    return fail(`每人最多保存 ${MAX_SHEETS_PER_USER} 张角色卡。`);
  }
  const base = existing ?? createSheet(to, source.template, deps.now());
  const copied: CharacterSheet = {
    ...base,
    template: source.template,
    attrs: { ...source.attrs },
    exprs: { ...source.exprs },
    updatedAt: deps.now().toISOString(),
  };
  deps.store.putSheet(ctx.userId, copied);
  return ok(`已把「${source.name}」的属性复制给「${copied.name}」${existing ? '（覆盖原有属性）' : '（新建）'}。`);
}

async function pcDel(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const name = requireText(ctx, 'name');
  if (!name) return fail('请提供要删除的卡名，例如 `/pc del name:卡特`。');
  if (!deps.store.deleteSheet(ctx.userId, name)) return fail(`没有名为「${name}」的角色卡。`);
  unbindName(ctx, deps, name);
  return ok(`已删除角色卡「${name}」及其绑定。`);
}

async function pcList(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const sheets = deps.store.listSheets(ctx.userId);
  if (sheets.length === 0) return ok('你还没有角色卡。用 `/pc new` 新建一张吧。');
  const active = resolveSheet(ctx, deps);
  const lines = sheets.map(
    (sheet) =>
      `· ${sheet.name}${active?.name === sheet.name ? ' ← 当前' : ''}（${sheet.template}，属性 ${
        Object.keys(sheet.attrs).length
      } 项，更新于 ${fmtDateTime(sheet.updatedAt)}）`,
  );
  return ok(clamp(`共 ${sheets.length}/${MAX_SHEETS_PER_USER} 张：\n${lines.join('\n')}`));
}

async function pcGrp(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const lines: string[] = [];
  if (ctx.guildId) {
    for (const game of deps.store.listGames(ctx.guildId)) {
      const entries = deps.store.listBindings('game', game.id);
      lines.push(
        `局 ${game.id} ${game.name}：${
          entries.length > 0
            ? entries.map((e) => `${e.userId === ctx.userId ? '你' : `<@${e.userId}>`} → ${e.sheetName}`).join('、')
            : '（无绑定）'
        }`,
      );
    }
  }
  const sceneEntries = deps.store.listBindings('scene', ctx.channelId);
  lines.push(
    `场景 ${mentionChannel(ctx.channelId)}：${
      sceneEntries.length > 0
        ? sceneEntries.map((e) => `${e.userId === ctx.userId ? '你' : `<@${e.userId}>`} → ${e.sheetName}`).join('、')
        : '（无绑定）'
    }`,
  );
  const globalEntry = deps.store.getBinding('global', GLOBAL_BINDING_KEY, ctx.userId);
  lines.push(`全局默认（你）：${globalEntry ?? '（无）'}`);
  lines.push('注：场景绑定只列出当前场景（契约按 channel id 存储，无法枚举全部场景）。');
  return ok(clamp(lines.join('\n')));
}

async function pcBuild(
  ctx: InteractionContext,
  deps: HandlerDeps,
  mode: 'build' | 'redo',
): Promise<ReplyPayload> {
  const name = requireText(ctx, 'name');
  if (!name) return fail(`请提供卡名，例如 \`/pc ${mode} name:卡特\`。`);
  let sheet = deps.store.getSheet(ctx.userId, name);
  if (!sheet) {
    if (deps.store.listSheets(ctx.userId).length >= MAX_SHEETS_PER_USER) {
      return fail(`每人最多保存 ${MAX_SHEETS_PER_USER} 张角色卡。`);
    }
    sheet = createSheet(name, COC7_DEFAULT_TEMPLATE, deps.now());
  }
  const attrs = mode === 'redo'
    ? rollCoc7Attrs(deps.rng)
    : { ...sheet.attrs, ...rollCoc7Attrs(deps.rng) };
  const next: CharacterSheet = { ...sheet, attrs, updatedAt: deps.now().toISOString() };
  deps.store.putSheet(ctx.userId, next);
  return ok(
    `${mode === 'redo' ? '已清空并重作' : '已填充'}角色卡「${next.name}」的 COC7 主属性：\n` +
      Object.entries(next.attrs).map(([k, v]) => `${k}:${v}`).join('  '),
  );
}

async function pcClr(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const sheets = deps.store.listSheets(ctx.userId);
  if (sheets.length === 0) {
    return ok('你还没有角色卡，没有可销毁的记录。');
  }

  // docs §16.6：首次执行只列出将销毁的范围 + 按钮，绝不改动数据；确认后才走下面的原清空逻辑。
  const summary = clamp(
    [
      `⚠️ 危险操作：即将销毁你的 ${sheets.length} 张角色卡记录及其全部绑定。`,
      `将销毁：${sheets.map((sheet) => `「${sheet.name}」`).join('、')}`,
      '其他玩家与本局的日志不受影响；确认后不可撤销。请点击下方「确认执行」（5 分钟内有效，仅你本人可确认）。',
    ].join('\n'),
  );

  return askConfirm(deps, ctx, {
    summary,
    onConfirm: async () => {
      const count = deps.store.clearSheets(ctx.userId);
      for (const target of bindingCandidates(ctx, deps)) {
        deps.store.setBinding(target.scope, target.key, ctx.userId, null);
      }
      if (ctx.guildId) {
        for (const game of deps.store.listGames(ctx.guildId)) {
          deps.store.setBinding('game', game.id, ctx.userId, null);
        }
      }
      return ok(`已销毁 ${count} 张角色卡记录及其绑定（其他玩家与本局的日志不受影响）。`);
    },
  });
}

async function pcStat(ctx: InteractionContext, deps: HandlerDeps): Promise<ReplyPayload> {
  const sheets = deps.store.listSheets(ctx.userId);
  const active = resolveSheet(ctx, deps);
  const lines = [`角色卡：${sheets.length}/${MAX_SHEETS_PER_USER} 张`];
  if (active) {
    lines.push(`当前生效：「${active.name}」属性 ${Object.keys(active.attrs).length} 项、表达式 ${Object.keys(active.exprs).length} 项`);
    lines.push(`创建于 ${fmtDateTime(active.createdAt)}，最近更新 ${fmtDateTime(active.updatedAt)}`);
  } else {
    lines.push('当前没有生效的角色卡。');
  }
  lines.push('注：冻结契约没有掷骰统计存储，`/pc stat` 只展示角色卡规模，不伪造历史掷骰数据。');
  return ok(clamp(lines.join('\n')));
}

export const pcHandler: CommandHandler = async (ctx, deps) => {
  switch (subcommand(ctx)) {
    case 'new':
      return pcNew(ctx, deps);
    case 'tag':
      return pcTag(ctx, deps);
    case 'show':
      return pcShow(ctx, deps);
    case 'rename':
      return pcRename(ctx, deps);
    case 'copy':
      return pcCopy(ctx, deps);
    case 'del':
      return pcDel(ctx, deps);
    case 'list':
      return pcList(ctx, deps);
    case 'grp':
      return pcGrp(ctx, deps);
    case 'build':
      return pcBuild(ctx, deps, 'build');
    case 'redo':
      return pcBuild(ctx, deps, 'redo');
    case 'clr':
      return pcClr(ctx, deps);
    case 'stat':
      return pcStat(ctx, deps);
    default:
      return fail('未知的 `/pc` 子命令，可用：new / tag / show / rename / copy / del / list / grp / build / redo / clr / stat。');
  }
};
