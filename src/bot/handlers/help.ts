/**
 * `/help` — Dice! 内置帮助词库 (docs §3.1).
 *
 * 词条来自 `src/bot/library/`（Dice! `GlobalVar.cpp` 的 `HelpDoc` 内置词条 + 本机 Discord
 * 适配词条 + 可选外部词库），无参时给出 Dice! 的 `strHlpMsg` 原文，再附一行 Discord 记法注记
 * （原文用 `.xxx`，本机器人写作 `/xxx`）——**不改正文**。
 */
import type { CommandHandler } from '../../contracts/bot.ts';
import { getLibrary, type DiceLibrary } from '../library/library.ts';
import { clamp, ok, optionString } from './options.ts';

/** Dice! 原文的指令记法提示（原文用 `.xxx`，Discord 端写作 `/xxx`）。 */
const NOTATION_NOTE =
  '（注：Dice! 原文里的 `.xxx` 指令在本机器人写作 `/xxx`；`/help query:本机扩展` 可查本机新增的指令，含 `/game` 对局、`/log` 日志等。）';

const FALLBACK_OVERVIEW =
  'Dice! 内置帮助词库为空（`src/bot/library/dice-defaults.json` 缺失？可运行 `node scripts/import-dice-library.ts` 重建）。\n用 `/help query:<词条>` 查询词条。';

function overviewText(library: DiceLibrary): string {
  const body = library.overview();
  return `${body || FALLBACK_OVERVIEW}\n\n${NOTATION_NOTE}`;
}

export const helpHandler: CommandHandler = async (ctx) => {
  const library = getLibrary();
  const query = optionString(ctx, 'query')?.trim();
  if (!query) return ok(clamp(overviewText(library)));

  const hit = library.lookup(query);
  if (hit) return ok(clamp(`【${query}】\n${hit.text}`));

  const near = library.suggest(query, 8);
  if (near.length > 0) {
    const preview = near
      .slice(0, 3)
      .map((name) => `【${name}】\n${library.lookup(name)?.text ?? ''}`)
      .join('\n\n');
    return ok(clamp(`词库里没有「${query}」，你是不是想找：${near.join('、')}？\n\n${preview}`));
  }
  return ok(clamp(`词库里没有「${query}」，也没有相近的词条。\n\n${overviewText(library)}`));
};

/** 词条名列表（观测/测试用）。 */
export function helpEntryNames(): string[] {
  return getLibrary().terms();
}
