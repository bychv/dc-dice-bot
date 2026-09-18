/**
 * `/sc` 理智检定 —— 对齐 docs §9.1（第 365-392 行）与
 * ref/Dice/Dice/DiceEvent.cpp 第 3843-3948 行。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createCocRules } from '../../src/coc/index.ts';
import { seqRng, stubDice, testSheet } from './helpers.ts';

const rules = createCocRules(stubDice());

describe('sanity', () => {
  test('0/1 成功：不扣 san，也不回写', () => {
    const result = rules.sanity('0/1 70', { sheet: null, rule: 0, rng: seqRng([50]) });
    assert.ok(result.ok);
    assert.equal(result.sanBefore, 70);
    assert.equal(result.sanAfter, 70);
    assert.equal(result.details[0].level, '成功');
    assert.equal(result.details[0].loss, 0);
    assert.equal(result.sheet, undefined, '无变化不回写');
    assert.ok(result.lines[0].includes('理智 70→70'));
  });

  test('大失败按房规失去最大 san（1d10 => 10）并回写', () => {
    const sheet = testSheet({ 理智: '70' });
    const result = rules.sanity('1/1d10 70', { sheet, rule: 0, rng: seqRng([100]) });
    assert.ok(result.ok);
    assert.equal(result.details[0].level, '大失败');
    assert.equal(result.details[0].loss, 10);
    assert.equal(result.sanAfter, 60);
    assert.ok(result.sheet);
    assert.equal(result.sheet.attrs.理智, '60');
    assert.equal(sheet.attrs.理智, '70', '原 sheet 不被修改');
  });

  test('失败扣失败损失（骰式），成功扣成功损失', () => {
    const success = rules.sanity('1d10/1d100 70', { sheet: null, rule: 0, rng: seqRng([50, 7]) });
    assert.ok(success.ok);
    assert.equal(success.details[0].level, '成功');
    assert.equal(success.details[0].loss, 7);
    assert.equal(success.sanAfter, 63);
    const failure = rules.sanity('1d10/1d100 70', { sheet: null, rule: 0, rng: seqRng([80, 55]) });
    assert.ok(failure.ok);
    assert.equal(failure.details[0].level, '失败');
    assert.equal(failure.details[0].loss, 55);
    assert.equal(failure.sanAfter, 15);
  });

  test('大失败损失与房规相关：房规 3 出 96 即大失败', () => {
    const result = rules.sanity('1d10/1d100 99', { sheet: null, rule: 3, rng: seqRng([96]) });
    assert.ok(result.ok);
    assert.equal(result.details[0].level, '大失败');
    assert.equal(result.details[0].loss, 100);
    assert.equal(result.sanAfter, 0, 'san 最低为 0');
  });

  test('-1d6 回复 san', () => {
    const result = rules.sanity('-1d6/-1d6 70', { sheet: null, rule: 0, rng: seqRng([50, 3]) });
    assert.ok(result.ok);
    assert.equal(result.details[0].loss, -3);
    assert.equal(result.sanAfter, 73);
    assert.ok(result.lines[0].includes('理智变化 +3'));
  });

  test('读卡 san 并回写剩余值', () => {
    const sheet = testSheet({ 理智: '50' });
    const success = rules.sanity('0/1', { sheet, rule: 0, rng: seqRng([30]) });
    assert.ok(success.ok);
    assert.equal(success.sanBefore, 50);
    assert.equal(success.sanAfter, 50);
    assert.equal(success.details[0].level, '成功');

    const failed = rules.sanity('0/1d6', { sheet, rule: 0, rng: seqRng([80, 4]) });
    assert.ok(failed.ok);
    assert.equal(failed.sanBefore, 50);
    assert.equal(failed.sanAfter, 46);
    assert.ok(failed.sheet);
    assert.equal(failed.sheet.attrs.理智, '46');
  });

  test('结尾非数字串作为理由', () => {
    const sheet = testSheet({ 理智: '60' });
    const result = rules.sanity('1d10/1d100 直面外神', { sheet, rule: 0, rng: seqRng([50, 5]) });
    assert.ok(result.ok);
    assert.equal(result.reason, '直面外神');
    assert.equal(result.sanBefore, 60);
    assert.ok(result.lines[0].includes('直面外神'));
  });

  test('sanOverride：无卡时由调用方给出当前 san', () => {
    const result = rules.sanity('0/1', { sheet: null, rule: 0, rng: seqRng([50]), sanOverride: 60 });
    assert.ok(result.ok);
    assert.equal(result.sanBefore, 60);
  });

  test('缺少 san / 格式非法时报错', () => {
    assert.equal(rules.sanity('0/1', { sheet: null, rule: 0, rng: seqRng([50]) }).ok, false);
    assert.equal(rules.sanity('1', { sheet: null, rule: 0, rng: seqRng([50]) }).ok, false);
    assert.equal(rules.sanity('1/', { sheet: null, rule: 0, rng: seqRng([50]) }).ok, false);
    assert.equal(rules.sanity('a/b 70', { sheet: null, rule: 0, rng: seqRng([50]) }).ok, false);
    assert.equal(rules.sanity('', { sheet: null, rule: 0, rng: seqRng([50]) }).ok, false);
  });
});
