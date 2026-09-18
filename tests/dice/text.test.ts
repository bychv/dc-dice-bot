import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRollText } from '../../src/dice/index.ts';

describe('parseRollText: 表达式 / 理由 / 轮数', () => {
  test('空文本返回空表达式与 1 轮', () => {
    const parsed = parseRollText('');
    assert.equal(parsed.expression, '');
    assert.equal(parsed.reason, undefined);
    assert.equal(parsed.rounds, 1);
  });

  test('表达式 + 理由', () => {
    const parsed = parseRollText('1d4+2 中型刀伤害');
    assert.equal(parsed.expression, '1d4+2');
    assert.equal(parsed.reason, '中型刀伤害');
    assert.equal(parsed.rounds, 1);
  });

  test('N# 轮数被拆出表达式', () => {
    const parsed = parseRollText('3#1d6 3发.22伤害');
    assert.equal(parsed.expression, '1d6');
    assert.equal(parsed.reason, '3发.22伤害');
    assert.equal(parsed.rounds, 3);
  });

  test('3#p 手枪连射', () => {
    const parsed = parseRollText('3#p 手枪连射');
    assert.equal(parsed.expression, 'p');
    assert.equal(parsed.reason, '手枪连射');
    assert.equal(parsed.rounds, 3);
  });

  test('只有理由时整个文本都是表达式（交由角色卡解析）', () => {
    const parsed = parseRollText('沙漠之鹰');
    assert.equal(parsed.expression, '沙漠之鹰');
    assert.equal(parsed.reason, undefined);
    assert.equal(parsed.rounds, 1);
  });

  test('前后空白被去掉，理由内部保留', () => {
    const parsed = parseRollText('  1d100 力量 ');
    assert.equal(parsed.expression, '1d100');
    assert.equal(parsed.reason, '力量');
  });

  test('10#1d10 是轮数上界', () => {
    assert.equal(parseRollText('10#1d10 聆听').rounds, 10);
  });

  test('越界或非数字轮数不拆分，留给 roll() 报错', () => {
    const tooBig = parseRollText('11#1d6 理由');
    assert.equal(tooBig.rounds, 1);
    assert.equal(tooBig.expression, '11#1d6');
    assert.equal(tooBig.reason, '理由');

    const zero = parseRollText('0#1d6');
    assert.equal(zero.rounds, 1);
    assert.equal(zero.expression, '0#1d6');
  });

  test('手册里 `1d10#` 的特殊写法保持原样（Discord 版应写 次数#表达式）', () => {
    const parsed = parseRollText('1d10# 乌波·萨斯拉的子嗣');
    assert.equal(parsed.expression, '1d10#');
    assert.equal(parsed.reason, '乌波·萨斯拉的子嗣');
    assert.equal(parsed.rounds, 1);
  });

  test('#1d6 前缀无轮数时保持原样', () => {
    const parsed = parseRollText('#1d6 理由');
    assert.equal(parsed.expression, '#1d6');
    assert.equal(parsed.reason, '理由');
    assert.equal(parsed.rounds, 1);
  });

  test('空理由不会被返回', () => {
    const parsed = parseRollText('1d6   ');
    assert.equal(parsed.expression, '1d6');
    assert.equal(parsed.reason, undefined);
  });

  test('任意输入都不会抛异常', () => {
    const samples = ['', '   ', '#', '3#', '1d6#', '3#1d6', '沙鹰 伤害', '1d6+2 理由 带空格'];
    for (const sample of samples) {
      assert.doesNotThrow(() => parseRollText(sample));
    }
  });
});
