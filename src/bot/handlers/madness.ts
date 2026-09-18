/**
 * `/ti` (临时疯狂症状) and `/li` (总结疯狂症状) — docs §9.2, COC7 tables.
 *
 * The frozen contracts expose no sanity-state store, so these commands are table-driven rolls
 * rather than a running tally: they roll the symptom, and for 恐惧症/躁狂症 they roll on the
 * (abridged) tables below. Abridgement is stated in the reply, never hidden.
 */
import type { CommandHandler, HandlerDeps } from '../../contracts/bot.ts';
import { clamp, fail, ok } from './options.ts';

const TEMPORARY_SYMPTOMS: readonly string[] = [
  '失忆：忘记过去 N 小时发生的事情',
  '假性残疾：失明 / 失聪 / 肢体瘫痪',
  '暴力倾向：攻击最近的人或物',
  '偏执：认为所有人都在害自己',
  '重要之人：把在场某人误认成重要之人',
  '昏厥：当场昏迷',
  '逃避行为：拼命逃离现场',
  '歇斯底里：狂笑 / 痛哭 / 尖叫',
  '恐惧症：转为 1d100 恐惧症',
  '躁狂症：转为 1d100 躁狂症',
];

const PHOBIAS: readonly string[] = [
  '黑暗恐惧症', '高处恐惧症', '幽闭恐惧症', '水恐惧症', '血恐惧症',
  '蜘蛛恐惧症', '蛇恐惧症', '人群恐惧症', '孤独恐惧症', '火焰恐惧症',
  '雷声恐惧症', '镜面恐惧症', '尸体恐惧症', '夜间恐惧症', '尖锐物恐惧症',
];

const MANIAS: readonly string[] = [
  '纵火癖', '盗窃癖', '撒谎癖', '暴食癖', '酗酒癖',
  '赌博癖', '洁癖', '计数癖', '收集癖', '自残癖',
  '冒险癖', '窥探癖', '指挥癖', '挥霍癖', '沉默癖',
];

function d10(deps: HandlerDeps): number {
  return deps.rng.int(1, 10);
}

function d100(deps: HandlerDeps): number {
  return deps.rng.int(1, 100);
}

function convert(value: number, table: readonly string[]): string {
  const index = Math.min(table.length - 1, Math.max(0, Math.ceil((value / 100) * table.length) - 1));
  return `${table[index]}（1d100=${value}，表为节选 ${table.length} 条）`;
}

export const tiHandler: CommandHandler = async (ctx, deps) => {
  const roll = d10(deps);
  const symptom = TEMPORARY_SYMPTOMS[roll - 1];
  const lines = [`临时疯狂症状（1d10=${roll}）：${symptom}`];
  if (roll === 9) lines.push(convert(d100(deps), PHOBIAS));
  if (roll === 10) lines.push(convert(d100(deps), MANIAS));
  lines.push(`持续时间：${d10(deps)} 小时（或按 KP 判定；疯狂发作由 /setcoc 房规裁定投骰）。`);
  return ok(clamp(lines.join('\n')));
};

export const liHandler: CommandHandler = async (ctx, deps) => {
  const roll = d10(deps);
  const symptom = TEMPORARY_SYMPTOMS[roll - 1];
  const hours = d10(deps);
  const lines = [
    '总结（长期）疯狂：本次疯狂结束时做一次智力检定——成功则「意识到自己疯了」，永久失去 1d3 点理智。',
    `发作表现（1d10=${roll}）：${symptom}`,
    `持续时间：${hours} 小时 × 10（总结性疯狂为 1d10 × 10 小时，按 KP 裁定）。`,
  ];
  lines.push('注：契约未提供理智/疯狂状态存储，`/li` 只做症状总结投骰，不累计玩家历史症状。');
  return ok(clamp(lines.join('\n')));
};

export function madnessTableSize(): number {
  return TEMPORARY_SYMPTOMS.length;
}
