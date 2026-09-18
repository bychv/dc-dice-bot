/**
 * Random name decks for `/name`, `/nnn` and `/pc new` without arguments (docs §12.2/§12.3).
 * Deterministic through the injected `Rng`, so tests can freeze it.
 */
export type NameLang = 'cn' | 'jp' | 'en';

const LANGS: readonly NameLang[] = ['cn', 'jp', 'en'];

interface IntRng {
  int(min: number, max: number): number;
}

const CN_SURNAMES = [
  '李', '王', '张', '刘', '陈', '杨', '黄', '赵', '周', '吴',
  '徐', '孙', '马', '朱', '胡', '林', '郭', '何', '高', '罗',
];

const CN_GIVEN = [
  '明', '伟', '芳', '静', '强', '磊', '洋', '勇', '艳', '杰',
  '娟', '涛', '超', '霞', '平', '刚', '桂英', '文轩', '子墨', '雨欣',
];

const JP_SURNAMES = [
  '佐藤', '铃木', '高桥', '田中', '渡边', '伊藤', '山本', '中村', '小林', '加藤',
  '吉田', '山田', '佐佐木', '山口', '松本', '井上', '木村', '林', '清水', '斋藤',
];

const JP_GIVEN = [
  '太郎', '花子', '一郎', '美咲', '健太', '结衣', '翔太', '樱', '大辅', '直子',
  '悠斗', '葵', '陆', '阳菜', '莲', '凛', '树', '诗织', '海斗', '千夏',
];

const EN_GIVEN = [
  'James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda',
  'William', 'Elizabeth', 'David', 'Barbara', 'Richard', 'Susan', 'Joseph', 'Jessica',
  'Thomas', 'Sarah', 'Charles', 'Karen',
];

const EN_SURNAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Wilson', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Jackson', 'Martin', 'Lee',
  'Thompson', 'White', 'Harris', 'Clark',
];

function pick(rng: IntRng, values: readonly string[]): string {
  return values[rng.int(0, values.length - 1)];
}

export function normalizeLang(value: string | null | undefined): NameLang | null {
  if (!value) return null;
  const lower = value.trim().toLowerCase();
  return (LANGS as readonly string[]).includes(lower) ? (lower as NameLang) : null;
}

export function randomName(rng: IntRng, lang: NameLang | null): string {
  const chosen: NameLang = lang ?? LANGS[rng.int(0, LANGS.length - 1)];
  switch (chosen) {
    case 'cn':
      return `${pick(rng, CN_SURNAMES)}${pick(rng, CN_GIVEN)}`;
    case 'jp':
      return `${pick(rng, JP_SURNAMES)} ${pick(rng, JP_GIVEN)}`;
    case 'en':
      return `${pick(rng, EN_GIVEN)} ${pick(rng, EN_SURNAMES)}`;
  }
}

export function randomNames(rng: IntRng, lang: NameLang | null, count: number): string[] {
  const safe = Math.max(1, Math.min(10, Math.trunc(count)));
  const out: string[] = [];
  for (let i = 0; i < safe; i += 1) out.push(randomName(rng, lang));
  return out;
}

export function deckSize(lang: NameLang): number {
  switch (lang) {
    case 'cn':
      return CN_SURNAMES.length * CN_GIVEN.length;
    case 'jp':
      return JP_SURNAMES.length * JP_GIVEN.length;
    case 'en':
      return EN_GIVEN.length * EN_SURNAMES.length;
  }
}
