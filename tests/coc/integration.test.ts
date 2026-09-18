/**
 * 与 T1 真实 DiceEngine（`src/dice`）的集成测试。
 *
 * 契约测试用 stub 保证完全确定；这里额外验证真实引擎的表达式（含前导 +/-、常量、
 * 奖惩骰百分骰）能被本模块正确驱动。随机源仍是确定性假 Rng。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createDiceEngine } from '../../src/dice/index.ts';
import { createCocRules, runApplySt } from '../../src/coc/index.ts';
import { seqRng, testSheet } from './helpers.ts';

const dice = createDiceEngine();
const rules = createCocRules(dice);
const NOW = '2024-03-03T00:00:00.000Z';

describe('与真实 DiceEngine 集成', () => {
  test('/st 相对修改驱动真实骰式', () => {
    const result = runApplySt(dice, 'hp-1D6', testSheet({ 生命: '10' }), NOW, seqRng([2]));
    assert.ok(result.ok);
    assert.ok(result.sheet);
    assert.equal(result.sheet.attrs.生命, '8');
  });

  test('/rc 用真实 percentile 掷骰', () => {
    const result = rules.check('b2 手枪 50', { sheet: null, rule: 0, rng: seqRng([30]) });
    assert.ok(result.ok);
    assert.equal(result.rounds, 1);
    assert.equal(result.details[0].roll, 30);
    assert.equal(result.details[0].level, '成功');
  });

  test('/sc 成功损失与失败损失使用真实引擎', () => {
    const success = rules.sanity('1d10/1d100 70', { sheet: null, rule: 0, rng: seqRng([50, 7]) });
    assert.ok(success.ok);
    assert.equal(success.details[0].loss, 7);
    assert.equal(success.sanAfter, 63);
    const failure = rules.sanity('1d10/1d100 70', { sheet: null, rule: 0, rng: seqRng([80, 55]) });
    assert.ok(failure.ok);
    assert.equal(failure.details[0].loss, 55);
  });

  test('/sc 大失败取真实表达式的最大值', () => {
    const simple = rules.sanity('1/1d10 70', { sheet: null, rule: 0, rng: seqRng([100]) });
    assert.ok(simple.ok);
    assert.equal(simple.details[0].loss, 10);
    const compound = rules.sanity('1/2d6+1 70', { sheet: null, rule: 0, rng: seqRng([100]) });
    assert.ok(compound.ok);
    assert.equal(compound.details[0].loss, 13);
  });

  test('/en 成长使用真实引擎并回写', () => {
    const sheet = testSheet({ 教育: '60' });
    const result = rules.improve('教育 60 教育增强', { sheet, rule: 0, rng: seqRng([97, 6]) });
    assert.ok(result.ok);
    assert.equal(result.gained, 6);
    assert.ok(result.sheet);
    assert.equal(result.sheet.attrs.教育, '66');
  });

  test('/en 自定义成长表达式 +1D3/1D10', () => {
    const result = rules.improve('幸运 +1D3/1D10 幸运成长', {
      sheet: testSheet({ 幸运: '40' }),
      rule: 0,
      rng: seqRng([10, 2]),
    });
    assert.ok(result.ok);
    assert.equal(result.gained, 2);
    assert.equal(result.after, 42);
  });

  test('resolveRollExpression 与真实掷骰串起来', () => {
    const sheet = testSheet({ 力量: '50' }, { 沙漠之鹰: '1D10+1D6+3' });
    const expression = rules.resolveRollExpression(sheet, '沙漠之鹰');
    assert.equal(expression, '1D10+1D6+3');
    const rolled = dice.roll(expression ?? '', seqRng([5]));
    assert.ok(rolled.ok);
    assert.equal(rolled.total, 5 + 5 + 3);
  });
});
