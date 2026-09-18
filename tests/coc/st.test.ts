/**
 * `/st` 属性录入 —— 对齐 docs §6.1（第 252-289 行）与
 * ref/Dice/Dice/DiceEvent.cpp 第 3950-4228 行。
 * 六种操作：set / modify / expr / show / del / clr（同义词另测）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createCocRules, runApplySt } from '../../src/coc/index.ts';
import { seqRng, stubDice, testSheet } from './helpers.ts';

const rules = createCocRules(stubDice());
const NOW = '2024-02-02T00:00:00.000Z';

describe('applySt', () => {
  test('set：名称:值 / 名称=值，多组空格分隔', () => {
    const result = rules.applySt('力量:50 体质=55 体型:65', null);
    assert.ok(result.ok);
    assert.equal(result.op, 'set');
    assert.ok(result.sheet);
    assert.deepEqual(result.sheet.attrs, { 力量: '50', 体质: '55', 体型: '65' });
    assert.deepEqual(result.lines, ['力量: 50', '体质: 55', '体型: 65']);
  });

  test('modify：值以 +/- 开头时基于原值修改', () => {
    const sheet = testSheet({ 生命: '10' });
    const result = rules.applySt('hp-1 hp+2', sheet);
    assert.ok(result.ok);
    assert.equal(result.op, 'modify');
    assert.ok(result.sheet);
    assert.equal(result.sheet.attrs.生命, '11', '-1 再 +2');
    assert.equal(sheet.attrs.生命, '10', '原 sheet 不被修改（不可变更新）');
  });

  test('modify：相对修改里可以带骰式（假 Rng 精确构造）', () => {
    const dice = stubDice();
    const sheet = testSheet({ 生命: '10' });
    const result = runApplySt(dice, 'hp-1D6', sheet, NOW, seqRng([4]));
    assert.ok(result.ok);
    assert.ok(result.sheet);
    assert.equal(result.sheet.attrs.生命, '6');
    assert.deepEqual(result.lines, ['生命: 10->6']);
  });

  test('expr：&名称=表达式', () => {
    const result = rules.applySt('&沙漠之鹰=1D10+1D6+3', null);
    assert.ok(result.ok);
    assert.equal(result.op, 'expr');
    assert.ok(result.sheet);
    assert.deepEqual(result.sheet.exprs, { 沙漠之鹰: '1D10+1D6+3' });
    assert.deepEqual(result.lines, ['沙漠之鹰=1D10+1D6+3']);
  });

  test('卡名前缀 ::（只剥离卡名，不改变语义）', () => {
    const dice = stubDice();
    const sheet = testSheet({ 理智: '50' });
    const result = runApplySt(dice, '卡特::san+1D6', sheet, NOW, seqRng([3]));
    assert.ok(result.ok);
    assert.ok(result.sheet);
    assert.equal(result.sheet.attrs.理智, '53');
  });

  test('show：指定属性 / 全部属性', () => {
    const sheet = testSheet({ 智力: '75' }, { 沙漠之鹰: '1D10' });
    const one = rules.applySt('show 灵感', sheet);
    assert.ok(one.ok);
    assert.equal(one.op, 'show');
    assert.deepEqual(one.lines, ['智力: 75']);
    assert.equal(one.sheet, undefined, 'show 不改卡');
    const all = rules.applySt('show', sheet);
    assert.ok(all.ok);
    assert.deepEqual(all.lines, ['【测试卡】1 项属性，1 条表达式', '智力:75 沙漠之鹰=1D10']);
    const missing = rules.applySt('show 不存在', sheet);
    assert.ok(missing.ok);
    assert.deepEqual(missing.lines, ['不存在≠ 未找到']);
  });

  test('show 全量列表：同一条目只出现一次、按宽度换行、不逐条换行', () => {
    const attrs: Record<string, string> = {};
    const names = Array.from({ length: 40 }, (_, i) => `技能${String(i).padStart(2, '0')}`);
    for (const [i, name] of names.entries()) attrs[name] = String(10 + i);
    const all = rules.applySt('show', testSheet(attrs));
    assert.ok(all.ok);
    assert.equal(all.lines[0], '【测试卡】40 项属性');
    assert.equal(all.lines.length, 5, '40 项应压到 4 行 + 1 行标题（每行 ≤ 90 字）');

    for (const row of all.lines.slice(1)) {
      assert.ok(row.length <= 90, `每行不得超过 90 字：${row.length}`);
      assert.ok(!row.includes('\n'));
    }
    const packed = all.lines.slice(1).join(' ').split(' ');
    assert.deepEqual(packed, names.map((name) => `${name}:${attrs[name]}`), '条目顺序与内容不变');
    assert.equal(new Set(packed).size, 40, '不得重复条目');
  });

  test('show 全量列表：超过字符预算时截断并提示单查', () => {
    const attrs: Record<string, string> = {};
    for (let i = 0; i < 400; i += 1) attrs[`测试技能${String(i).padStart(3, '0')}`] = '100';
    const all = rules.applySt('show', testSheet(attrs));
    assert.ok(all.ok);
    assert.equal(all.lines[0], '【测试卡】400 项属性');
    const total = all.lines.join('\n').length;
    assert.ok(total <= 1600, `截断后总长应受控，实际 ${total}`);
    assert.match(all.lines.at(-1) ?? '', /^…还有 \d+ 项未显示；用 `\/st show <属性名>` 查单个属性。$/);
  });

  test('show 全量列表：空卡给出占位文案', () => {
    const all = rules.applySt('show', testSheet());
    assert.ok(all.ok);
    assert.deepEqual(all.lines, ['（角色卡为空）']);
  });

  test('del：删除已保存属性', () => {
    const sheet = testSheet({ 力量: '50', 体质: '55' });
    const result = rules.applySt('del 力量', sheet);
    assert.ok(result.ok);
    assert.equal(result.op, 'del');
    assert.ok(result.sheet);
    assert.deepEqual(result.sheet.attrs, { 体质: '55' });
    assert.deepEqual(result.lines, ['已删除 力量']);
    assert.deepEqual(sheet.attrs, { 力量: '50', 体质: '55' });
    const missing = rules.applySt('del 不存在', sheet);
    assert.ok(missing.ok);
    assert.deepEqual(missing.lines, ['不存在≠ 未找到']);
    assert.equal(missing.sheet, undefined);
    assert.equal(rules.applySt('del', sheet).ok, false);
  });

  test('clr：清空角色卡', () => {
    const sheet = testSheet({ 力量: '50' }, { 沙漠之鹰: '1D10' });
    const result = rules.applySt('clr', sheet);
    assert.ok(result.ok);
    assert.equal(result.op, 'clr');
    assert.ok(result.sheet);
    assert.deepEqual(result.sheet.attrs, {});
    assert.deepEqual(result.sheet.exprs, {});
    assert.deepEqual(result.lines, ['已清空角色卡']);
  });

  test('同义词：智力/灵感、理智/san、侦查/侦察', () => {
    const result = rules.applySt('灵感:80 san:70 侦察:60', null);
    assert.ok(result.ok);
    assert.ok(result.sheet);
    assert.deepEqual(result.sheet.attrs, { 智力: '80', 理智: '70', 侦查: '60' });
  });

  test('空输入与非法分组', () => {
    assert.equal(rules.applySt('', null).ok, false);
    assert.equal(rules.applySt('   ', null).ok, false);
    const bad = rules.applySt('姓名', null);
    assert.ok(bad.ok, '无值分组按 ref 记一行解析失败，不中断整行');
    assert.deepEqual(bad.lines, ['姓名≠ 无法解析']);
  });
});
