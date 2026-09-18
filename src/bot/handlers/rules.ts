/**
 * `/rules` — 规则速查 (docs §3.2): `query` looks up the Dice! help/rule library,
 * `set` stores the guild's default rule set (via the optional `RuleSetStore` capability).
 *
 * Dice! 的 `.rules <词条>` 查的是**运行时下载**的规则书（`GetRule.cpp` POST
 * `http://api.kokona.tech:5555/rules`），上游仓库没有这份数据；离线时退回
 * `src/bot/library/` 的词库（Dice! 内置帮助词条 + 本机 COC7 术语 + 可选外部词库）。
 */
import type { CommandHandler } from '../../contracts/bot.ts';
import { getLibrary } from '../library/library.ts';
import { ruleSetStore } from './context.ts';
import { clamp, fail, ok, optionString, subcommand } from './options.ts';

export const rulesHandler: CommandHandler = async (ctx, deps) => {
  const sub = subcommand(ctx) ?? 'query';

  if (sub === 'set') {
    const rule = optionString(ctx, 'rule')?.trim() || null;
    const store = ruleSetStore(deps.store);
    if (!rule) {
      store.setDefaultRuleSet(ctx.guildId, null);
      return ok('已清空本服默认规则集。');
    }
    if (!['coc', 'coc7', 'dnd'].includes(rule.toLowerCase())) {
      return fail('默认规则集只能是 COC / COC7 / DND（留空表示清空）。');
    }
    store.setDefaultRuleSet(ctx.guildId, rule.toLowerCase());
    return ok(`已把本服默认规则集设为 ${rule.toUpperCase()}。`);
  }

  const query = optionString(ctx, 'query')?.trim();
  if (!query) return fail('请提供要查询的词条，例如 `/rules query:大失败`。');
  const ruleSet =
    optionString(ctx, 'rule')?.trim().toLowerCase() ||
    ruleSetStore(deps.store).getDefaultRuleSet(ctx.guildId) ||
    'coc7';

  const library = getLibrary();
  const hit = library.lookup(query);
  if (hit) return ok(clamp(`【${ruleSet.toUpperCase()}｜${query}】\n${hit.text}`));

  const near = library.suggest(query, 8);
  if (near.length > 0) {
    const preview = near
      .slice(0, 3)
      .map((name) => `【${name}】\n${library.lookup(name)?.text ?? ''}`)
      .join('\n\n');
    return ok(clamp(`规则库里没有「${query}」，你是不是想找：${near.join('、')}？\n\n${preview}`));
  }

  const terms = library.terms();
  return ok(
    clamp(
      `规则库里没有「${query}」，也没有相近的词条。\n` +
        '（Dice! 的规则书词条是运行时从官方服务器下载的规则集数据，本仓库只带内置帮助词库；' +
        '可用 `DICE_LIBRARY_DIR` 挂载外部词库目录补充。）\n' +
        `可用词条（共 ${terms.length} 个）：${terms.slice(0, 30).join('、')}…`,
    ),
  );
};
