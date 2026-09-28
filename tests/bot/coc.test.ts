/**
 * `/coc` 自动掷调查员卡（`src/bot/handlers/coc.ts` + `rollCoc7Card`）。
 *
 * 覆盖：7e 标准掷法（3D6×5 / (2D6+6)×5）、两个总值、embed 结构、多张合并、数量边界、
 * 以及多轮 rng 的调用次数（保证 3 颗骰子真的各掷一次）。
 *
 * Run: node tests/bot/coc.test.ts
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MAX_COC_CARDS, buildCocEmbed, renderCardLines } from '../../src/bot/handlers/coc.ts';
import { rollCoc7Card } from '../../src/bot/handlers/sheets.ts';
import { route } from '../../src/bot/router.ts';
import { makeContext, makeEnv, type TestEnv } from './fakes.ts';

/** 记录调用次数的固定 rng。 */
function fixedRng(value: number): { int(min: number, max: number): number; calls: number } {
  return {
    calls: 0,
    int(): number {
      this.calls += 1;
      return value;
    },
  };
}

async function runCoc(env: TestEnv, count?: number): Promise<Awaited<ReturnType<typeof route>>> {
  return route(
    makeContext(
      { command: 'coc', channelId: 'C1', userId: 'U1', values: count === undefined ? {} : { count } },
      env.platform,
    ),
    { ...env.deps, rng: env.deps.rng },
  );
}

describe('rollCoc7Card：CoC 7e 标准掷法', () => {
  test('3D6×5 与 (2D6+6)×5 分别折算，幸运 3D6×5', () => {
    const rng = fixedRng(3);
    const card = rollCoc7Card(rng);
    // 3D6 类：(3+3+3)×5 = 45；(2D6+6) 类：(3+3+6)×5 = 60；幸运同 3D6 → 45
    assert.deepEqual(card.attrs, {
      力量: '45',
      体质: '45',
      体型: '60',
      敏捷: '45',
      外貌: '45',
      智力: '60',
      意志: '45',
      教育: '60',
    });
    assert.equal(card.luck, 45);
    assert.equal(card.baseTotal, 45 * 5 + 60 * 3, '8 项基础属性总值');
    assert.equal(card.totalWithLuck, card.baseTotal + 45, '含幸运总值');
    // 5 个 3D6 属性 ×3 + 3 个 (2D6+6) ×2 + 幸运 ×3 = 15+6+3 = 24 次掷骰
    assert.equal(rng.calls, 24);
  });

  test('总值等于 8 项之和，且含幸运 = 前者 + 幸运', () => {
    const card = rollCoc7Card({ int: (min, max) => (min === 1 && max === 6 ? 4 : min) });
    const sum = Object.values(card.attrs).reduce((total, value) => total + Number(value), 0);
    assert.equal(card.baseTotal, sum);
    assert.equal(card.totalWithLuck, sum + card.luck);
  });
});

describe('/coc 回执（embed）', () => {
  test('默认 1 张：一个 embed、一个「调查员卡」field，含两个总值', async () => {
    const env = makeEnv();
    env.deps.rng = fixedRng(3) as never;
    const reply = await runCoc(env);

    assert.notEqual(reply.ephemeral, true);
    assert.equal(reply.embeds?.length, 1);
    const embed = reply.embeds![0]!;
    assert.equal(embed.title, 'CoC7 调查员卡');
    assert.equal(embed.color, 0x6b46c1);
    assert.equal(embed.fields?.length, 1);
    const field = embed.fields![0]!;
    assert.equal(field.name, '调查员卡');
    assert.match(field.value, /力量 45/);
    assert.match(field.value, /体型 60/);
    assert.match(field.value, /幸运 45/);
    assert.match(field.value, /8 项总值 405/);
    assert.match(field.value, /含幸运 450/);
    assert.match(reply.content, /1 张调查员卡/);
    assert.ok(embed.footer?.text.includes('2D6+6'), embed.footer?.text);
  });

  test('多张合并到同一个 embed，并附合计（平均）行', async () => {
    const env = makeEnv();
    env.deps.rng = fixedRng(3) as never;
    const reply = await runCoc(env, 3);

    assert.equal(reply.embeds?.length, 1, '多张也必须只有一个 embed');
    const embed = reply.embeds![0]!;
    assert.equal(embed.title, 'CoC7 调查员卡 ×3');
    assert.equal(embed.fields?.length, 4, '3 张卡 + 1 行合计');
    assert.equal(embed.fields![0]!.name, '调查员 1');
    assert.equal(embed.fields![2]!.name, '调查员 3');
    assert.equal(embed.fields![3]!.name, '合计（3 张）');
    assert.match(embed.fields![3]!.value, /平均 8 项总值 \*\*405\*\*/);
    assert.match(embed.fields![3]!.value, /平均含幸运 \*\*450\*\*/);
    assert.match(reply.content, /3 张调查员卡（合并显示）/);
  });

  test('数量边界：0/负数按 1 张，超过上限按上限并在回执里说明', async () => {
    const env = makeEnv();
    env.deps.rng = fixedRng(3) as never;
    const zero = await runCoc(env, 0);
    assert.equal(zero.embeds![0]!.fields?.length, 1);

    const huge = await runCoc(env, 999);
    assert.equal(huge.embeds![0]!.fields?.length, MAX_COC_CARDS + 1, 'N 张卡 + 合计行');
    assert.match(huge.content, new RegExp(`一次最多 ${MAX_COC_CARDS} 张`));
  });

  test('renderCardLines：8 项分两行 + 幸运 + 两个总值', () => {
    const lines = renderCardLines({
      attrs: { 力量: '45', 体质: '45', 体型: '60', 敏捷: '45', 外貌: '45', 智力: '60', 意志: '45', 教育: '60' },
      luck: 45,
      baseTotal: 405,
      totalWithLuck: 450,
    }).split('\n');
    assert.equal(lines.length, 4);
    assert.match(lines[0]!, /力量 45.*体质 45.*体型 60.*敏捷 45/);
    assert.match(lines[1]!, /外貌 45.*智力 60.*意志 45.*教育 60/);
    assert.equal(lines[2], '幸运 45');
    assert.equal(lines[3], '**8 项总值 405**　｜　**含幸运 450**');
  });

  test('buildCocEmbed：单张时标题不带 ×N', () => {
    const card = { attrs: { 力量: '50' }, luck: 50, baseTotal: 100, totalWithLuck: 150 };
    const embed = buildCocEmbed([card]);
    assert.equal(embed.title, 'CoC7 调查员卡');
    assert.equal(embed.fields?.length, 1);
  });
});
