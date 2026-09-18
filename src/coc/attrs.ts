/**
 * 属性名归一化（同义词）。
 *
 * 依据：
 * - docs/Discord_CoC_Command_Set.md §6：`同义词沿用原文：智力/灵感、理智/san、侦查/侦察`
 * - docs/User_Manual.md 235 行同样表述
 * - ref/Dice/Dice/RDConstant.h `SkillNameReplace`（第 56-121 行）提供完整别名表
 *
 * 本实现把「别名 → 规范名」压平成一张表；查询时同时兼容原样名与规范名，
 * 写入角色卡时统一使用规范名（与 ref `CharaCard::set` 内部调用 `standard()` 一致）。
 */
import type { CharacterSheet } from '../contracts/model.ts';

const SYNONYMS: Readonly<Record<string, string>> = {
  // —— 手册明列的三组同义词 ——
  灵感: '智力',
  idea: '智力',
  san: '理智',
  侦察: '侦查',
  // —— RDConstant.h SkillNameReplace 其余条目 ——
  str: '力量',
  dex: '敏捷',
  pow: '意志',
  siz: '体型',
  app: '外貌',
  luck: '幸运',
  luk: '幸运',
  con: '体质',
  int: '智力',
  edu: '教育',
  mov: '移动力',
  hp: '生命',
  体力: '生命',
  mp: '魔法',
  计算机: '计算机使用',
  电脑: '计算机使用',
  电脑使用: '计算机使用',
  cr: '信用评级',
  信誉: '信用评级',
  信誉度: '信用评级',
  信用度: '信用评级',
  信用: '信用评级',
  驾驶: '汽车驾驶',
  驾驶汽车: '汽车驾驶',
  '驾驶(汽车)': '汽车驾驶',
  '驾驶：汽车': '汽车驾驶',
  快速交谈: '话术',
  绞具: '绞索',
  链枷: '连枷',
  步枪: '步枪/霰弹枪',
  霰弹枪: '步枪/霰弹枪',
  散弹枪: '步枪/霰弹枪',
  步霰: '步枪/霰弹枪',
  '步/霰': '步枪/霰弹枪',
  步散: '步枪/霰弹枪',
  '步/散': '步枪/霰弹枪',
  图书馆: '图书馆使用',
  机修: '机械维修',
  重型操作: '操作重型机械',
  重型机械: '操作重型机械',
  重型: '操作重型机械',
  电器维修: '电气维修',
  cm: '克苏鲁神话',
  克苏鲁: '克苏鲁神话',
  唱歌: '歌唱',
  做画: '作画',
  耕做: '耕作',
  机枪: '机关枪',
  自然学: '博物学',
  自然史: '博物学',
  领航: '导航',
  骑术: '骑乘',
  船: '船驾驶',
  驾驶船: '船驾驶',
  '驾驶(船)': '船驾驶',
  '驾驶：船': '船驾驶',
  飞行器: '飞行器驾驶',
  驾驶飞行器: '飞行器驾驶',
  '驾驶：飞行器': '飞行器驾驶',
  '驾驶(飞行器)': '飞行器驾驶',
  // —— 连写卡片串（外部骰娘导出）里出现的补充写法 ——
  // 主属性：理智/san/san值/理智值、幸运/运气
  san值: '理智',
  理智值: '理智',
  运气: '幸运',
  // 技能别名（样本写法）
  汽车: '汽车驾驶',
  开锁: '锁匠',
  撬锁: '锁匠',
  取悦: '魅惑',
};

/** 属性同义词归一化：`灵感 -> 智力`、`san -> 理智`、`侦察 -> 侦查`… */
export function canonicalAttr(name: string): string {
  const key = (name ?? '').trim();
  if (!key) return key;
  return SYNONYMS[key.toLowerCase()] ?? SYNONYMS[key] ?? key;
}

/** 去掉 `/r`、`.st` 里可选的「卡名::」前缀（本集不做多卡联动，语义由调用方决定）。 */
export function stripCardPrefix(token: string): string {
  const at = token.lastIndexOf('::');
  return at >= 0 ? token.slice(at + 2) : token;
}

function hasOwn(record: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** 读卡：先原样名、再规范名。返回实际命中的键，便于回写时保持键不变。 */
export function findAttrValue(
  sheet: CharacterSheet | null,
  name: string,
): { key: string; value: string } | null {
  if (!sheet) return null;
  const raw = (name ?? '').trim();
  const canonical = canonicalAttr(raw);
  for (const key of raw === canonical ? [raw] : [raw, canonical]) {
    if (hasOwn(sheet.attrs, key)) return { key, value: sheet.attrs[key] };
  }
  return null;
}

/** 读卡：`&名称=表达式` 保存的表达式，兼容带 / 不带 `&` 两种键。 */
export function findExpr(
  sheet: CharacterSheet | null,
  name: string,
): { key: string; expr: string } | null {
  if (!sheet) return null;
  const raw = (name ?? '').trim();
  const base = raw.startsWith('&') ? raw.slice(1) : raw;
  const canonical = canonicalAttr(base);
  for (const key of base === canonical ? [base] : [base, canonical]) {
    for (const candidate of [key, `&${key}`]) {
      if (hasOwn(sheet.exprs, candidate)) {
        return { key: candidate, expr: sheet.exprs[candidate] };
      }
    }
  }
  return null;
}

/**
 * 连写模式字典里「没有别名可归」的 COC7 规范技能名（会计/人类学/…）。
 * 其余规范名（力量、生命、理智、汽车驾驶、图书馆使用…）已由 SYNONYMS 的值提供，
 * 这里不重复列举。
 */
const KNOWN_SKILL_NAMES: readonly string[] = [
  '会计',
  '人类学',
  '估价',
  '考古学',
  '攀爬',
  '乔装',
  '闪避',
  '电子学',
  '斗殴',
  '枪',
  '急救',
  '历史',
  '恐吓',
  '跳跃',
  '母语',
  '法律',
  '聆听',
  '医学',
  '神秘学',
  '说服',
  '精神分析',
  '心理学',
  '生物学',
  '妙手',
  '潜行',
  '生存',
  '游泳',
  '投掷',
  '追踪',
  '驯兽',
  '潜水',
  '爆破',
  '读唇',
  '催眠',
  '炮术',
  '魅惑',
  '锁匠',
];

/**
 * 连写模式（无分隔符卡片串）的识别字典：同义词表的键 + 规范名 + 无别名的技能名。
 * 键统一小写，匹配时对候选片段做同样的小写处理（`STR40` 也能识别）。
 */
const DICTIONARY: ReadonlySet<string> = new Set(
  [...Object.keys(SYNONYMS), ...Object.values(SYNONYMS), ...KNOWN_SKILL_NAMES].map((name) =>
    name.toLowerCase(),
  ),
);

const MAX_NAME_LENGTH: number = [...DICTIONARY].reduce((max, name) => Math.max(max, name.length), 0);

/**
 * 把一段非数字文本按字典做**最长匹配**切分（线性扫描：每个位置从最长候选长度往下试，
 * 不回退，因此不会回溯爆炸）。
 *
 * 返回切出的名字，以及每个名字是否来自字典（false = 字典外的自定义技能名，
 * 例如样本里的 `猫语`）。连续未命中的字符会合并成一个自定义名。
 */
export function splitConcatenatedNames(segment: string): { names: string[]; known: boolean[] } {
  const names: string[] = [];
  const known: boolean[] = [];
  let pending = '';
  let index = 0;
  while (index < segment.length) {
    let matched: string | null = null;
    const longest = Math.min(MAX_NAME_LENGTH, segment.length - index);
    for (let length = longest; length >= 1; length--) {
      const candidate = segment.slice(index, index + length);
      if (DICTIONARY.has(candidate.toLowerCase())) {
        matched = candidate;
        break;
      }
    }
    if (matched) {
      if (pending) {
        names.push(pending);
        known.push(false);
        pending = '';
      }
      names.push(matched);
      known.push(true);
      index += matched.length;
    } else {
      pending += segment[index];
      index += 1;
    }
  }
  if (pending) {
    names.push(pending);
    known.push(false);
  }
  return { names, known };
}

/** 该片段能否被字典**完整**切分（连写模式判定：至少看起来由已知卡名连写而成）。 */
export function isKnownNameRun(segment: string): boolean {
  const { known } = splitConcatenatedNames(segment);
  return known.length > 0 && known.every(Boolean);
}