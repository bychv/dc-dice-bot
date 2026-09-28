/**
 * `/coc [count]` — 自动掷调查员卡（CoC 7e 标准掷法），**embed 展示**，供选卡参考。
 *
 * - 掷法（docs §5.4）：力量/体质/敏捷/外貌/意志 = 3D6×5；体型/智力/教育 = (2D6+6)×5；幸运 = 3D6×5；
 * - 每张卡给两个**总值**：① 8 项基础属性之和 ② 前者 + 幸运；
 * - `count > 1` 时**合并到同一个 embed**（每张一个 field），末尾附平均行；
 * - 只是"掷点参考"，**不落库**；要保存成角色卡用 `/pc new`。
 * - 回执的 `【使用者】` 前缀由适配层统一加（`actorEcho`），这里不重复。
 */
import type { ApiEmbed, CommandHandler, ReplyPayload } from '../../contracts/bot.ts';
import { clamp, optionInteger } from './options.ts';
import { rollCoc7Card, type Coc7RolledCard } from './sheets.ts';

/** 一次最多掷几张（Discord embed 单条 25 个 field，留一个位置给合计行）。 */
export const MAX_COC_CARDS = 10;
export const COC_EMBED_COLOR = 0x6b46c1;
const ATTR_ORDER = ['力量', '体质', '体型', '敏捷', '外貌', '智力', '意志', '教育'] as const;

/** 一张卡的正文：8 项属性两行 + 幸运 + 两个总值。 */
export function renderCardLines(card: Coc7RolledCard): string {
  const pairs = ATTR_ORDER.map((attr) => `${attr} ${card.attrs[attr] ?? '?'}`);
  return [
    pairs.slice(0, 4).join('　'),
    pairs.slice(4).join('　'),
    `幸运 ${card.luck}`,
    `**8 项总值 ${card.baseTotal}**　｜　**含幸运 ${card.totalWithLuck}**`,
  ].join('\n');
}

/** 多张卡合并成一个 embed：每张一个 field（竖向排布），多于一张时附平均行。 */
export function buildCocEmbed(cards: Coc7RolledCard[]): ApiEmbed {
  const fields = cards.map((card, index) => ({
    name: cards.length === 1 ? '调查员卡' : `调查员 ${index + 1}`,
    value: renderCardLines(card),
    inline: false,
  }));

  if (cards.length > 1) {
    const average = (pick: (card: Coc7RolledCard) => number): number =>
      Math.round(cards.reduce((sum, card) => sum + pick(card), 0) / cards.length);
    fields.push({
      name: `合计（${cards.length} 张）`,
      value: `平均 8 项总值 **${average((card) => card.baseTotal)}**　｜　平均含幸运 **${average((card) => card.totalWithLuck)}**`,
      inline: false,
    });
  }

  return {
    title: cards.length === 1 ? 'CoC7 调查员卡' : `CoC7 调查员卡 ×${cards.length}`,
    color: COC_EMBED_COLOR,
    fields,
    footer: { text: 'coc7e' },
  };
}

export const cocHandler: CommandHandler = async (ctx, deps): Promise<ReplyPayload> => {
  const requested = optionInteger(ctx, 'count') ?? 1;
  const count = Math.min(Math.max(1, Math.trunc(requested)), MAX_COC_CARDS);
  const cards: Coc7RolledCard[] = [];
  for (let i = 0; i < count; i += 1) cards.push(rollCoc7Card(deps.rng));

  const head = count === 1 ? '掷了 1 张调查员卡：' : `掷了 ${count} 张调查员卡（合并显示）：`;
  const note = requested > MAX_COC_CARDS ? `\n一次最多 ${MAX_COC_CARDS} 张，已按 ${MAX_COC_CARDS} 张掷。` : '';

  // 卡面数据都在 embed 里；content 只留一句说明（适配层会加 `【使用者】` 前缀，并把它写进日志）
  return { content: clamp(`${head}${note}`), embeds: [buildCocEmbed(cards)], ok: true };
};
