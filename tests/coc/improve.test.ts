/**
 * `/en` 成长检定 —— 对齐 docs §9.3（第 403-429 行）与
 * ref/Dice/Dice/DiceEvent.cpp 第 3097-3178 行。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createCocRules } from '../../src/coc/index.ts';
import { seqRng, stubDice, testSheet } from './helpers.ts';

const rules = createCocRules(stubDice());

describe('improve', () => {
  test('成功成长并回写技能值', () => {
    const sheet = testSheet({ 教育: '60' });
    const result = rules.improve('教育 60 教育增强', { sheet, rule: 0, rng: seqRng([97, 6]) });
    assert.ok(result.ok);
    assert.equal(result.skillName, '教育');
    assert.equal(result.before, 60);
    assert.equal(result.roll, 97);
    assert.equal(result.gained, 6);
    assert.equal(result.after, 66);
    assert.equal(result.reason, '教育增强');
    assert.ok(result.sheet);
    assert.equal(result.sheet.attrs.教育, '66');
    assert.equal(sheet.attrs.教育, '60', '原 sheet 不被修改');
  });

  test('失败不成长（默认表达式只在成功时生效）', () => {
    const sheet = testSheet({ 教育: '60' });
    const result = rules.improve('教育 60', { sheet, rule: 0, rng: seqRng([30]) });
    assert.ok(result.ok);
    assert.equal(result.gained, 0);
    assert.equal(result.after, 60);
    assert.ok(result.lines[0].includes('失败'));
    assert.ok(result.lines[0].includes('本次不成长'));
  });

  test('骰值 96+ 必定成长（ref: roll <= val && roll <= 95 才算失败）', () => {
    const result = rules.improve('教育 99', { sheet: testSheet({ 教育: '99' }), rule: 0, rng: seqRng([96, 5]) });
    assert.ok(result.ok);
    assert.equal(result.before, 99);
    assert.equal(result.gained, 5);
    assert.equal(result.after, 104);
  });

  test('自定义成长表达式 +1D3/1D10（前段失败成长，后段成功成长）', () => {
    const sheet = testSheet({ 幸运: '40' });
    const success = rules.improve('幸运 +1D3/1D10 幸运成长', { sheet, rule: 0, rng: seqRng([80, 9]) });
    assert.ok(success.ok);
    assert.equal(success.gained, 9);
    assert.equal(success.after, 49);
    assert.equal(success.reason, '幸运成长');

    const failure = rules.improve('幸运 +1D3/1D10 幸运成长', { sheet, rule: 0, rng: seqRng([10, 2]) });
    assert.ok(failure.ok);
    assert.equal(failure.gained, 2);
    assert.equal(failure.after, 42);
  });

  test('只写 `+1D6` 时失败不成长、成功 +1D6', () => {
    const sheet = testSheet({ 侦查: '40' });
    const fail = rules.improve('侦查 +1D6', { sheet, rule: 0, rng: seqRng([20]) });
    assert.ok(fail.ok);
    assert.equal(fail.gained, 0);
    const success = rules.improve('侦查 +1D6', { sheet, rule: 0, rng: seqRng([60, 4]) });
    assert.ok(success.ok);
    assert.equal(success.gained, 4);
    assert.equal(success.after, 44);
  });

  test('省略技能值时读卡', () => {
    const result = rules.improve('侦查', { sheet: testSheet({ 侦查: '40' }), rule: 0, rng: seqRng([50, 7]) });
    assert.ok(result.ok);
    assert.equal(result.skillName, '侦查');
    assert.equal(result.before, 40);
    assert.equal(result.after, 47);
  });

  test('技能值 3 位以内', () => {
    assert.equal(
      rules.improve('教育 1000', { sheet: null, rule: 0, rng: seqRng([1]) }).ok,
      false,
    );
  });

  test('同义词：san 归一化为理智', () => {
    const sheet = testSheet({ 理智: '50' });
    const result = rules.improve('san', { sheet, rule: 0, rng: seqRng([97, 4]) });
    assert.ok(result.ok);
    assert.equal(result.skillName, '理智');
    assert.equal(result.before, 50);
    assert.equal(result.after, 54);
    assert.ok(result.sheet);
    assert.equal(result.sheet.attrs.理智, '54');
  });

  test('valueOverride：无卡时由调用方给出技能值', () => {
    const result = rules.improve('教育', {
      sheet: null,
      rule: 0,
      rng: seqRng([97, 6]),
      valueOverride: 60,
    });
    assert.ok(result.ok);
    assert.equal(result.before, 60);
    assert.equal(result.after, 66);
    assert.equal(result.sheet, undefined);
  });

  test('缺少技能值时报错', () => {
    assert.equal(rules.improve('侦查', { sheet: testSheet({}), rule: 0, rng: seqRng([1]) }).ok, false);
    assert.equal(rules.improve('', { sheet: null, rule: 0, rng: seqRng([1]) }).ok, false);
  });
});
