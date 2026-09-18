/**
 * `/name` — 随机姓名 (docs §12.3): `lang` (cn/jp/en) + `count` (1-10).
 */
import type { CommandHandler } from '../../contracts/bot.ts';
import { normalizeLang, randomNames } from './names.ts';
import { ok, optionInteger, optionString } from './options.ts';

export const nameHandler: CommandHandler = async (ctx, deps) => {
  const lang = normalizeLang(optionString(ctx, 'lang'));
  const rawCount = optionInteger(ctx, 'count');
  const count = rawCount === null ? 1 : Math.max(1, Math.min(10, rawCount));
  const names = randomNames(deps.rng, lang, count);
  const label = lang ? `（${lang}）` : '（三类名称随机）';
  return ok(`随机姓名${label}：\n${names.map((name, index) => `${index + 1}. ${name}`).join('\n')}`);
};
