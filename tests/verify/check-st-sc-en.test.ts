/**
 * T4 独立验证 · `/st` `/rc` `/ra` `/sc` `/en` 文本解析
 *
 * 规格：docs/Discord_CoC_Command_Set.md §6.1（第 252-289 行）、§7.1（295-333）、
 * §9.1（367-394）、§9.3（405-431）。全部用固定 Rng 断言到具体数值，
 * 不从实现注释反推预期。
 *
 * Run: node tests/verify/check-st-sc-en.test.ts
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseCheck, parseCheckText, runCheck } from '../../src/coc/check.ts';
import { runImprove } from '../../src/coc/improve.ts';
import { runSanity } from '../../src/coc/sanity.ts';
import { runApplySt } from '../../src/coc/st.ts';
import { createDiceEngine } from '../../src/dice/engine.ts';
import { sequenceRng } from '../dice/helpers.ts';
import { testSheet } from '../coc/helpers.ts';

const dice = createDiceEngine();
const NOW = '2026-01-05T21:30:00.000Z';

// ---------------------------------------------------------------------------
// /rc · /ra
// ---------------------------------------------------------------------------

describe('T4 · /rc 文本解析（§7.1）', () => {
  test('3#p 手枪：轮数 3 + 惩罚骰 1 + 读卡技能名', () => {
    const parsed = parseCheckText('3#p 手枪');
    assert.ok(parsed.ok);
    assert.equal(parsed.rounds, 3);
    assert.equal(parsed.penalty, 1);
    assert.equal(parsed.bonus, 0);
    assert.equal(parsed.skillName, '手枪');
    assert.equal(parsed.base, null);
    assert.equal(parsed.difficulty, 'normal');
    assert.equal(parsed.reason, '');
  });

  test('体质*5：乘法修正 + 读卡', () => {
    const parsed = parseCheckText('体质*5');
    assert.ok(parsed.ok);
    assert.equal(parsed.skillName, '体质');
    assert.equal(parsed.multiplier, 5);
    assert.equal(parsed.base, null);

    const result = runCheck(dice, '体质*5', { sheet: testSheet({ 体质: '55' }), rule: 0, rng: sequenceRng([40]) });
    assert.ok(result.ok);
    assert.equal(result.target, 275, '55*5');
    assert.equal(result.details[0].roll, 40);
    assert.equal(result.details[0].level, '极难成功', '275/5 = 55');
  });

  test('敏捷-10：加减修正 + 读卡', () => {
    const parsed = parseCheckText('敏捷-10');
    assert.ok(parsed.ok);
    assert.equal(parsed.skillName, '敏捷');
    assert.equal(parsed.addend, -10);

    const result = runCheck(dice, '敏捷-10', { sheet: testSheet({ 敏捷: '55' }), rule: 0, rng: sequenceRng([20]) });
    assert.ok(result.ok);
    assert.equal(result.target, 45);
    assert.equal(result.details[0].level, '困难成功', '45/2 = 22，45/5 = 9');
  });

  test('困难智力 99：难度关键词 + 显式成功率（困难 = 成功率/2）', () => {
    const parsed = parseCheckText('困难智力 99');
    assert.ok(parsed.ok);
    assert.equal(parsed.difficulty, 'hard');
    assert.equal(parsed.skillName, '智力');
    assert.equal(parsed.base, 99);

    const result = runCheck(dice, '困难智力 99', { sheet: null, rule: 0, rng: sequenceRng([30]) });
    assert.ok(result.ok);
    assert.equal(result.target, 49, 'floor(99/2)');
    assert.equal(result.details[0].level, '成功');
    assert.ok(result.lines[0].includes('困难'));
  });

  test('极难智力 99：极难 = 成功率/5', () => {
    const parsed = parseCheckText('极难智力 99');
    assert.ok(parsed.ok);
    assert.equal(parsed.difficulty, 'extreme');
    const result = runCheck(dice, '极难智力 99', { sheet: null, rule: 0, rng: sequenceRng([3]) });
    assert.ok(result.ok);
    assert.equal(result.target, 19, 'floor(99/5)');
    assert.equal(result.details[0].level, '极难成功');
  });

  test('自动成功爆破：读卡 + 失败被抬成成功（大失败不抬）', () => {
    const parsed = parseCheckText('自动成功爆破');
    assert.ok(parsed.ok);
    assert.equal(parsed.difficulty, 'auto');
    assert.equal(parsed.skillName, '爆破');

    const ok = runCheck(dice, '自动成功爆破', { sheet: testSheet({ 爆破: '20' }), rule: 0, rng: sequenceRng([90]) });
    assert.ok(ok.ok);
    assert.equal(ok.details[0].level, '成功', '自动成功把「失败」抬成成功');
    assert.equal(ok.target, 20);

    const fumble = runCheck(dice, '自动成功爆破', { sheet: testSheet({ 爆破: '20' }), rule: 0, rng: sequenceRng([97]) });
    assert.ok(fumble.ok);
    assert.equal(fumble.details[0].level, '大失败', '§7.1 只承诺自动成功，未承诺免疫大失败');
  });

  test('无成功率时读卡；卡里没有则报错', () => {
    const onCard = runCheck(dice, '侦查', { sheet: testSheet({ 侦查: '45' }), rule: 0, rng: sequenceRng([20]) });
    assert.ok(onCard.ok);
    assert.equal(onCard.target, 45);

    const missing = runCheck(dice, '侦查', { sheet: testSheet({}), rule: 0, rng: sequenceRng([20]) });
    assert.equal(missing.ok, false);
    assert.ok(!missing.ok && missing.error.includes('侦查'));
  });

  test('同义词：灵感 → 智力（读卡命中规范名）', () => {
    const result = runCheck(dice, '灵感', { sheet: testSheet({ 智力: '75' }), rule: 0, rng: sequenceRng([10]) });
    assert.ok(result.ok);
    assert.equal(result.skillName, '智力');
    assert.equal(result.target, 75);
  });

  test('修正顺序：乘法 > 加减 > 除法', () => {
    // 99*5 + 10 = 505，再 /5 = 101
    const result = runCheck(dice, '力量*5+10/5', { sheet: testSheet({ 力量: '99' }), rule: 0, rng: sequenceRng([1]) });
    assert.ok(result.ok);
    assert.equal(result.target, 101);
  });

  test('修正后成功率必须 1-1000（含难度除法之后）', () => {
    const tooBig = runCheck(dice, '力量 1001', { sheet: null, rule: 0, rng: sequenceRng([1]) });
    assert.equal(tooBig.ok, false);
    assert.ok(!tooBig.ok && tooBig.error.includes('1-1000'));

    const zero = runCheck(dice, '力量 0', { sheet: null, rule: 0, rng: sequenceRng([1]) });
    assert.equal(zero.ok, false);

    const diffZero = runCheck(dice, '困难力量 1', { sheet: null, rule: 0, rng: sequenceRng([1]) });
    assert.equal(diffZero.ok, false, 'floor(1/2)=0 也要拒绝');

    const top = runCheck(dice, '力量 1000', { sheet: null, rule: 0, rng: sequenceRng([1]) });
    assert.ok(top.ok);
    assert.equal(top.target, 1000);

    const low = runCheck(dice, '力量 1', { sheet: null, rule: 0, rng: sequenceRng([1]) });
    assert.ok(low.ok);
    assert.equal(low.target, 1);
  });

  test('轮数与奖惩骰上界（1-9 / ≤9）', () => {
    assert.equal(parseCheckText('10#力量').ok, false);
    assert.equal(parseCheckText('0#力量').ok, false);
    assert.equal(parseCheckText('b10 力量').ok, false);
    assert.equal(parseCheckText('p10 力量').ok, false);
    assert.equal(parseCheckText('1d100b10').ok, false);

    const nine = parseCheckText('9#b9 力量');
    assert.ok(nine.ok);
    assert.equal(nine.rounds, 9);
    assert.equal(nine.bonus, 9);
  });

  test('多轮检定逐轮掷骰、每轮一行', () => {
    const result = runCheck(dice, '3#力量 50', { sheet: null, rule: 0, rng: sequenceRng([10, 50, 99]) });
    assert.ok(result.ok);
    assert.equal(result.rounds, 3);
    assert.deepEqual(result.details.map((d) => d.roll), [10, 50, 99]);
    assert.deepEqual(result.details.map((d) => d.target), [50, 50, 50]);
    assert.equal(result.details[0].level, '极难成功');
    assert.equal(result.details[1].level, '成功');
    assert.equal(result.details[2].level, '失败');
  });

  test('文本奖惩骰参与 percentile：b2 取最小候选', () => {
    const result = runCheck(dice, 'b2 力量 50', { sheet: null, rule: 0, rng: sequenceRng([50, 8, 2]) });
    assert.ok(result.ok);
    assert.equal(result.details[0].roll, 20, '候选 50/80/20 取最小');
    assert.equal(result.details[0].level, '困难成功', '50/2 = 25');
  });

  test('parseCheck 与 runCheck 的 target 语义差异（字符化断言，非规格违背）', () => {
    const parsed = parseCheck('困难智力 99');
    assert.ok('skillName' in parsed);
    // parseCheck 只回"文本里的成功率"，不下难度除数；runCheck 回生效目标值。
    assert.equal(parsed.target, 99);
    const ran = runCheck(dice, '困难智力 99', { sheet: null, rule: 0, rng: sequenceRng([30]) });
    assert.ok(ran.ok);
    assert.equal(ran.target, 49);
  });
});

// ---------------------------------------------------------------------------
// /st
// ---------------------------------------------------------------------------

describe('T4 · /st 文本解析（§6.1）', () => {
  test('名称:值 / 名称=值，多组空格分隔', () => {
    const result = runApplySt(dice, '力量:50 体质=55 体型:65', null, NOW, sequenceRng([]));
    assert.ok(result.ok);
    assert.equal(result.sheet?.attrs['力量'], '50');
    assert.equal(result.sheet?.attrs['体质'], '55');
    assert.equal(result.sheet?.attrs['体型'], '65');
  });

  test('值以 + / - 开头按原值修改（可含骰式）', () => {
    const sheet = testSheet({ 力量: '50', 理智: '60' });
    const plus = runApplySt(dice, 'san+1D6', sheet, NOW, sequenceRng([4]));
    assert.ok(plus.ok);
    assert.equal(plus.sheet?.attrs['理智'], '64', 'san 归一化为理智后 +4');

    const minus = runApplySt(dice, 'hp-1', testSheet({ 生命: '10' }), NOW, sequenceRng([]));
    assert.ok(minus.ok);
    assert.equal(minus.sheet?.attrs['生命'], '9');
  });

  test('同一行内后一组能看到前一组（力量:50 力量+1 → 51）', () => {
    const result = runApplySt(dice, '力量:50 力量+1', null, NOW, sequenceRng([]));
    assert.ok(result.ok);
    assert.equal(result.sheet?.attrs['力量'], '51');
  });

  test('&名称=表达式 存入 exprs', () => {
    const result = runApplySt(dice, '&沙漠之鹰=1D10+1D6+3', null, NOW, sequenceRng([]));
    assert.ok(result.ok);
    assert.equal(result.sheet?.exprs['沙漠之鹰'], '1D10+1D6+3');
    assert.equal(result.op, 'expr');
  });

  test('同义词：灵感 → 智力、san → 理智、侦察 → 侦查', () => {
    const result = runApplySt(dice, '灵感:70 san:60 侦察:45', null, NOW, sequenceRng([]));
    assert.ok(result.ok);
    assert.equal(result.sheet?.attrs['智力'], '70');
    assert.equal(result.sheet?.attrs['理智'], '60');
    assert.equal(result.sheet?.attrs['侦查'], '45');
    assert.equal(result.sheet?.attrs['灵感'], undefined, '写入必须用规范名');
  });

  test('show：不带参数列全部（压缩成行）；带属性名支持同义词', () => {
    const sheet = testSheet({ 智力: '75', 侦查: '45' }, { 沙漠之鹰: '1D10' });
    const all = runApplySt(dice, 'show', sheet, NOW, sequenceRng([]));
    assert.ok(all.ok);
    // 需求变更：全量列表不再逐条换行，改为「标题 + 按宽度打包的行」
    assert.deepEqual(all.lines, ['【测试卡】2 项属性，1 条表达式', '智力:75 侦查:45 沙漠之鹰=1D10']);
    assert.equal(all.sheet, undefined, 'show 不应改卡');

    const one = runApplySt(dice, 'show 灵感', sheet, NOW, sequenceRng([]));
    assert.ok(one.ok);
    assert.deepEqual(one.lines, ['智力: 75']);

    const expr = runApplySt(dice, 'show 沙漠之鹰', sheet, NOW, sequenceRng([]));
    assert.ok(expr.ok);
    assert.deepEqual(expr.lines, ['沙漠之鹰=1D10']);

    const miss = runApplySt(dice, 'show 不存在', sheet, NOW, sequenceRng([]));
    assert.ok(miss.ok);
    assert.ok(miss.lines[0].includes('未找到'));
  });

  test('del：删除属性与表达式；不存在时明确回执', () => {
    const sheet = testSheet({ 智力: '75' }, { 沙漠之鹰: '1D10' });
    const del = runApplySt(dice, 'del 灵感 沙漠之鹰', sheet, NOW, sequenceRng([]));
    assert.ok(del.ok);
    assert.equal(del.sheet?.attrs['智力'], undefined);
    assert.equal(del.sheet?.exprs['沙漠之鹰'], undefined);
    assert.ok(del.lines.every((l) => l.startsWith('已删除')));

    const none = runApplySt(dice, 'del kp裁决', sheet, NOW, sequenceRng([]));
    assert.ok(none.ok);
    assert.deepEqual(none.lines, ['kp裁决≠ 未找到']);
    assert.equal(none.sheet, undefined, '无删除时不产生新卡');

    const noArg = runApplySt(dice, 'del', sheet, NOW, sequenceRng([]));
    assert.equal(noArg.ok, false);
  });

  test('clr：清空属性与表达式', () => {
    const result = runApplySt(dice, 'clr', testSheet({ 力量: '50' }, { 枪: '1D10' }), NOW, sequenceRng([]));
    assert.ok(result.ok);
    assert.deepEqual(result.sheet?.attrs, {});
    assert.deepEqual(result.sheet?.exprs, {});
    assert.equal(result.op, 'clr');
  });

  test('不可变更新：原 sheet 不被修改', () => {
    const sheet = testSheet({ 力量: '50' });
    const result = runApplySt(dice, '力量+10', sheet, NOW, sequenceRng([]));
    assert.ok(result.ok);
    assert.equal(sheet.attrs['力量'], '50', '原对象必须保持 50');
    assert.equal(result.sheet?.attrs['力量'], '60');
  });

  test('卡特::san+1D6 的卡名前缀被剥离（原样透传 :: 语义）', () => {
    const result = runApplySt(dice, '卡特::san+1D6', testSheet({ 理智: '50' }), NOW, sequenceRng([6]));
    assert.ok(result.ok);
    assert.equal(result.sheet?.attrs['理智'], '56');
  });

  test('空文本 / 无法解析的片段', () => {
    assert.equal(runApplySt(dice, '', null, NOW, sequenceRng([])).ok, false);
    assert.equal(runApplySt(dice, '   ', null, NOW, sequenceRng([])).ok, false);
  });
});

// ---------------------------------------------------------------------------
// /sc
// ---------------------------------------------------------------------------

describe('T4 · /sc 文本解析（§9.1）', () => {
  test('0/1 70：成功不扣，失败扣 1', () => {
    const success = runSanity(dice, '0/1 70', { sheet: null, rule: 0, rng: sequenceRng([70]) });
    assert.ok(success.ok);
    assert.equal(success.details[0].roll, 70);
    assert.equal(success.details[0].level, '成功');
    assert.equal(success.details[0].loss, 0);
    assert.equal(success.sanBefore, 70);
    assert.equal(success.sanAfter, 70);

    const fail = runSanity(dice, '0/1 70', { sheet: null, rule: 0, rng: sequenceRng([71]) });
    assert.ok(fail.ok);
    assert.equal(fail.details[0].level, '失败');
    assert.equal(fail.details[0].loss, 1);
    assert.equal(fail.sanAfter, 69);
  });

  test('1d10/1d100 直面外神：成功损失走表达式，理由被解析', () => {
    const result = runSanity(dice, '1d10/1d100 直面外神', {
      sheet: testSheet({ 理智: '70' }),
      rule: 0,
      rng: sequenceRng([40, 6]),
    });
    assert.ok(result.ok);
    assert.equal(result.details[0].level, '成功');
    assert.equal(result.details[0].loss, 6, '40 是检定骰、6 是 1d10');
    assert.equal(result.sanAfter, 64);
    assert.equal(result.reason, '直面外神');
    assert.ok(result.lines[0].includes('直面外神'));
  });

  test('大失败自动失去最大 san（1d100 → 100）', () => {
    const result = runSanity(dice, '1d10/1d100 30', { sheet: null, rule: 0, rng: sequenceRng([96]) });
    assert.ok(result.ok);
    assert.equal(result.details[0].level, '大失败');
    assert.equal(result.details[0].loss, 100, '大失败取失败损失的最大值 1d100=100');
    assert.equal(result.sanAfter, 0, '不能为负');
  });

  test('san 回写角色卡（不可变更新，键保持不变）', () => {
    const sheet = testSheet({ 理智: '70' });
    const result = runSanity(dice, '0/1', { sheet, rule: 0, rng: sequenceRng([90]) });
    assert.ok(result.ok);
    assert.equal(result.details[0].loss, 1);
    assert.equal(result.sheet?.attrs['理智'], '69');
    assert.equal(sheet.attrs['理智'], '70', '原卡必须不变');
  });

  test('无 san 回写时不返回 sheet（本次损失为 0）', () => {
    const result = runSanity(dice, '0/1 70', { sheet: testSheet({ 理智: '70' }), rule: 0, rng: sequenceRng([10]) });
    assert.ok(result.ok);
    assert.equal(result.details[0].loss, 0);
    assert.equal(result.sheet, undefined);
  });

  test('缺少当前 san → 明确报错（无卡无数值时）', () => {
    const result = runSanity(dice, '1d10/1d100 直面外神', { sheet: null, rule: 0, rng: sequenceRng([40]) });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes('理智'));
  });

  test('非法输入：缺少 /、空式子、非骰式字符、san<=0', () => {
    for (const text of ['1/1/1 70', '/1 70', '1/ 70', 'abc/1 70', '0/1 0', '0/1 -5']) {
      const result = runSanity(dice, text, { sheet: null, rule: 0, rng: sequenceRng([50]) });
      assert.equal(result.ok, false, `${text} 必须被拒绝`);
    }
  });

  test('允许回复 san 的 -1d6/-1d6 写法（规格明确允许但建议避免）', () => {
    const result = runSanity(dice, '-1d6/-1d6 30', { sheet: null, rule: 0, rng: sequenceRng([10, 6]) });
    assert.ok(result.ok);
    assert.equal(result.details[0].loss, -6);
    assert.equal(result.sanAfter, 36);
  });

  test('房规影响大失败判定：房规 3 下 96 即大失败', () => {
    const rule3 = runSanity(dice, '0/1d100 80', { sheet: null, rule: 3, rng: sequenceRng([96]) });
    assert.ok(rule3.ok);
    assert.equal(rule3.details[0].level, '大失败');
    assert.equal(rule3.details[0].loss, 100);
  });
});

// ---------------------------------------------------------------------------
// /en
// ---------------------------------------------------------------------------

describe('T4 · /en 文本解析（§9.3）', () => {
  test('教育 60 教育增强：96+ 必定成长（默认 1D10）', () => {
    const result = runImprove(dice, '教育 60 教育增强', { sheet: null, rule: 0, rng: sequenceRng([96, 7]) });
    assert.ok(result.ok);
    assert.equal(result.skillName, '教育');
    assert.equal(result.before, 60);
    assert.equal(result.roll, 96);
    assert.equal(result.gained, 7);
    assert.equal(result.after, 67);
    assert.equal(result.reason, '教育增强');
  });

  test('教育 60：掷出 <= 技能值 则失败、不成长', () => {
    const result = runImprove(dice, '教育 60', { sheet: null, rule: 0, rng: sequenceRng([10]) });
    assert.ok(result.ok);
    assert.equal(result.gained, 0);
    assert.equal(result.after, 60);
    assert.ok(result.lines[0].includes('失败'));
  });

  test('幸运 +1D3/1D10 幸运成长：失败段/成功段分别生效', () => {
    const success = runImprove(dice, '幸运 +1D3/1D10 幸运成长', {
      sheet: null,
      rule: 0,
      rng: sequenceRng([60, 5]),
      valueOverride: 50,
    });
    assert.ok(success.ok);
    assert.equal(success.before, 50);
    assert.equal(success.gained, 5, '60 > 50 → 成长检定成功 → 1D10');
    assert.equal(success.after, 55);
    assert.equal(success.reason, '幸运成长');

    const failed = runImprove(dice, '幸运 +1D3/1D10 幸运成长', {
      sheet: null,
      rule: 0,
      rng: sequenceRng([30, 2]),
      valueOverride: 50,
    });
    assert.ok(failed.ok);
    assert.equal(failed.gained, 2, '30 <= 50 → 失败 → 1D3');
  });

  test('读卡：省略技能值时用角色卡（并回写）', () => {
    const sheet = testSheet({ 侦查: '30' });
    const result = runImprove(dice, '侦查', { sheet, rule: 0, rng: sequenceRng([97, 10]) });
    assert.ok(result.ok);
    assert.equal(result.before, 30);
    assert.equal(result.after, 40);
    assert.equal(result.sheet?.attrs['侦查'], '40');
    assert.equal(sheet.attrs['侦查'], '30', '原卡不变');
  });

  test('缺少技能值 → 报错；技能值超过 3 位 → 报错', () => {
    const missing = runImprove(dice, '侦查', { sheet: null, rule: 0, rng: sequenceRng([50]) });
    assert.equal(missing.ok, false);
    const tooBig = runImprove(dice, '教育 1234', { sheet: null, rule: 0, rng: sequenceRng([50]) });
    assert.equal(tooBig.ok, false);
  });
});
