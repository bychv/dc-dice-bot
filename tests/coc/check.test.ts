/**
 * `/rc` `/ra` 解析与检定 —— 对齐 docs §7.1（第 295-333 行）与
 * ref/Dice/Dice/DiceEvent.cpp 第 3538-3783 行。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedCheck } from '../../src/contracts/coc.ts';
import type { DiceEngine } from '../../src/contracts/dice.ts';
import { createCocRules } from '../../src/coc/index.ts';
import { seqRng, stubDice, testSheet } from './helpers.ts';

const rules = createCocRules(stubDice());

function parsedOf(text: string): ParsedCheck {
  const result = rules.parseCheck(text);
  if ('error' in result) assert.fail(`parse failed: ${result.error}`);
  return result;
}

describe('parseCheck（不掷骰）', () => {
  test('技能名 + 显式成功率', () => {
    assert.deepEqual(parsedOf('力量 50'), {
      skillName: '力量',
      target: 50,
      rounds: 1,
      bonus: 0,
      penalty: 0,
      difficulty: 'normal',
    });
  });

  test('无显式成功率时 target 为 null（需读卡）', () => {
    const parsed = parsedOf('力量');
    assert.equal(parsed.target, null);
    assert.equal(parsed.skillName, '力量');
  });

  test('难度关键词', () => {
    const hard = parsedOf('困难智力 99');
    assert.deepEqual(
      { skillName: hard.skillName, target: hard.target, difficulty: hard.difficulty },
      { skillName: '智力', target: 99, difficulty: 'hard' },
    );
    assert.equal(parsedOf('极难智力 99').difficulty, 'extreme');
    const auto = parsedOf('自动成功爆破');
    assert.deepEqual(
      { skillName: auto.skillName, target: auto.target, difficulty: auto.difficulty },
      { skillName: '爆破', target: null, difficulty: 'auto' },
    );
  });

  test('轮数 # 前缀与奖惩骰 b/p', () => {
    const multi = parsedOf('3#p 手枪');
    assert.deepEqual(
      { rounds: multi.rounds, penalty: multi.penalty, bonus: multi.bonus, skillName: multi.skillName },
      { rounds: 3, penalty: 1, bonus: 0, skillName: '手枪' },
    );
    assert.equal(parsedOf('b2 手枪').bonus, 2);
    assert.equal(parsedOf('b 手枪').bonus, 1);
    assert.equal(parsedOf('9#力量 50').rounds, 9);
    assert.deepEqual(
      { rounds: parsedOf('#力量 50').rounds, skillName: parsedOf('#力量 50').skillName },
      { rounds: 1, skillName: '力量' },
      '只有 # 没有轮数时按 1 轮处理',
    );
  });

  test('乘加减除修正（顺序：乘法 > 加减 > 除法）', () => {
    assert.equal(parsedOf('体质*5').target, null, '无显式基础值时需读卡');
    assert.equal(parsedOf('敏捷-10 30').target, 20);
    assert.equal(parsedOf('力量/2 100').target, 50);
    assert.equal(parsedOf('力量*5-10/2 50').target, 120);
  });

  test('非法输入返回 CocFailure', () => {
    for (const bad of ['', '   ', '0#力量', '10#力量', '困难']) {
      const parsed = rules.parseCheck(bad);
      assert.ok('error' in parsed, `「${bad}」应解析失败`);
    }
  });
});

describe('check 检定', () => {
  test('省略成功率时读卡', () => {
    const result = rules.check('力量', { sheet: testSheet({ 力量: '60' }), rule: 0, rng: seqRng([30]) });
    assert.ok(result.ok);
    assert.equal(result.target, 60);
    assert.equal(result.details[0].roll, 30);
    assert.equal(result.details[0].level, '困难成功', '30 <= 60/2');
    assert.ok(result.lines[0].includes('房规0'));
    assert.ok(result.lines[0].includes('困难成功'));
  });

  test('无卡且无成功率时报错', () => {
    assert.equal(rules.check('力量', { sheet: null, rule: 0, rng: seqRng([1]) }).ok, false);
  });

  test('显式成功率优先于角色卡', () => {
    const result = rules.check('力量 50', { sheet: testSheet({ 力量: '99' }), rule: 0, rng: seqRng([50]) });
    assert.ok(result.ok);
    assert.equal(result.target, 50);
  });

  test('乘加减除：体质*5-10/2 => (50*5-10)/2 = 120', () => {
    const result = rules.check('体质*5-10/2 50', { sheet: null, rule: 0, rng: seqRng([1]) });
    assert.ok(result.ok);
    assert.equal(result.target, 120);
    assert.equal(result.details[0].level, '大成功');
  });

  test('困难档 = 成功率/2，极难档 = 成功率/5', () => {
    const hard = rules.check('困难智力 99', { sheet: null, rule: 0, rng: seqRng([49]) });
    assert.ok(hard.ok);
    assert.equal(hard.target, 49);
    const extreme = rules.check('极难智力 99', { sheet: null, rule: 0, rng: seqRng([19]) });
    assert.ok(extreme.ok);
    assert.equal(extreme.target, 19);
  });

  test('简单（ref 兼容）= 成功率翻倍', () => {
    const result = rules.check('简单智力 99', { sheet: null, rule: 0, rng: seqRng([100]) });
    assert.ok(result.ok);
    assert.equal(result.target, 198);
    assert.equal(result.details[0].level, '大失败', '198 满 50，出 100 仍是大失败');
  });

  test('自动成功：普通失败升为成功，大失败仍为大失败', () => {
    const upgraded = rules.check('自动成功爆破 50', { sheet: null, rule: 0, rng: seqRng([80]) });
    assert.ok(upgraded.ok);
    assert.equal(upgraded.details[0].level, '成功');
    const fumble = rules.check('自动成功爆破 50', { sheet: null, rule: 0, rng: seqRng([100]) });
    assert.ok(fumble.ok);
    assert.equal(fumble.details[0].level, '大失败');
  });

  test('修正后成功率必须 1-1000', () => {
    assert.equal(rules.check('力量 0', { sheet: null, rule: 0, rng: seqRng([1]) }).ok, false);
    assert.equal(rules.check('力量 1001', { sheet: null, rule: 0, rng: seqRng([1]) }).ok, false);
    assert.equal(rules.check('力量*21 50', { sheet: null, rule: 0, rng: seqRng([1]) }).ok, false, '1050 > 1000');
    const upper = rules.check('力量 1000', { sheet: null, rule: 0, rng: seqRng([1]) });
    assert.ok(upper.ok);
    assert.equal(upper.target, 1000);
    assert.equal(rules.check('力量/0 10', { sheet: null, rule: 0, rng: seqRng([1]) }).ok, false);
  });

  test('奖励骰/惩罚骰透传给 DiceEngine，并支持多轮', () => {
    const seen: { bonus?: number; penalty?: number }[] = [];
    const base = stubDice();
    const spy: DiceEngine = {
      percentile(opts, rng) {
        seen.push({ bonus: opts.bonus, penalty: opts.penalty });
        return base.percentile(opts, rng);
      },
      roll(expression, rng) {
        return base.roll(expression, rng);
      },
    };
    const spyRules = createCocRules(spy);
    const result = spyRules.check('3#p3 手枪 50', { sheet: null, rule: 0, rng: seqRng([70, 60, 50]) });
    assert.ok(result.ok);
    assert.equal(result.rounds, 3);
    assert.equal(seen.length, 3);
    assert.deepEqual(seen[0], { bonus: 0, penalty: 3 });
    assert.equal(result.details.length, 3);
    assert.equal(result.lines.length, 4, '多轮：表头 1 行 + 每轮 1 行');
  });

  test('理由：成功率之后的文本', () => {
    const result = rules.check('力量 50 因为恐惧', { sheet: null, rule: 0, rng: seqRng([50]) });
    assert.ok(result.ok);
    assert.equal(result.reason, '因为恐惧');
    assert.ok(result.lines[0].includes('因为恐惧'));
  });

  test('同义词与大小写缩写', () => {
    const san = rules.check('san 40', { sheet: null, rule: 0, rng: seqRng([1]) });
    assert.ok(san.ok);
    assert.equal(san.skillName, '理智');
    const hp = rules.check('HP 40', { sheet: null, rule: 0, rng: seqRng([1]) });
    assert.ok(hp.ok);
    assert.equal(hp.skillName, '生命');
    const scout = rules.check('侦察 40', { sheet: null, rule: 0, rng: seqRng([1]) });
    assert.ok(scout.ok);
    assert.equal(scout.skillName, '侦查');
  });
});

describe('resolveRollExpression / canonicalAttr', () => {
  test('表达式名 -> 表达式，属性名 -> 数值', () => {
    const sheet = testSheet({ 生命: '12' }, { 沙漠之鹰: '1D10+1D6+3' });
    assert.equal(rules.resolveRollExpression(sheet, '沙漠之鹰'), '1D10+1D6+3');
    assert.equal(rules.resolveRollExpression(sheet, 'hp'), '12');
    assert.equal(rules.resolveRollExpression(sheet, '生命 备注'), '12');
    assert.equal(rules.resolveRollExpression(sheet, '&沙漠之鹰'), '1D10+1D6+3');
  });

  test('原文本身是骰式时返回 null', () => {
    const sheet = testSheet({ 力量: '50' }, {});
    assert.equal(rules.resolveRollExpression(sheet, '1d6'), null);
    assert.equal(rules.resolveRollExpression(sheet, '3#1d6'), null);
    assert.equal(rules.resolveRollExpression(sheet, 'b2 手枪'), null);
    assert.equal(rules.resolveRollExpression(sheet, '50'), null);
    assert.equal(rules.resolveRollExpression(sheet, '不存在的名字'), null);
    assert.equal(rules.resolveRollExpression(null, '沙漠之鹰'), null);
  });

  test('canonicalAttr 同义词归一化', () => {
    assert.equal(rules.canonicalAttr('灵感'), '智力');
    assert.equal(rules.canonicalAttr('智力'), '智力');
    assert.equal(rules.canonicalAttr('san'), '理智');
    assert.equal(rules.canonicalAttr('SAN'), '理智');
    assert.equal(rules.canonicalAttr('侦察'), '侦查');
    assert.equal(rules.canonicalAttr('侦查'), '侦查');
    assert.equal(rules.canonicalAttr('hp'), '生命');
    assert.equal(rules.canonicalAttr('自定义'), '自定义');
  });
});
