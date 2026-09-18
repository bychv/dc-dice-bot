import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiceEngine, renderRoll } from '../../src/dice/index.ts';
import type { RollResult } from '../../src/dice/index.ts';
import { descendingValues, sequenceRng } from './helpers.ts';

const engine = createDiceEngine();

function roll(expression: string, values: number[]): RollResult {
  const result = engine.roll(expression, sequenceRng(values));
  if (!result.ok) assert.fail(`unexpected failure: ${result.error}`);
  return result;
}

describe('renderRoll: compact=false（/r 式）', () => {
  test('单个骰子只输出表达式与结果', () => {
    assert.equal(renderRoll(roll('1d100', [45])), '1d100=45');
  });

  test('多骰式展开每个点数', () => {
    assert.equal(renderRoll(roll('3d6', [3, 4, 5])), '3d6=3+4+5=12');
  });

  test('常量项也出现', () => {
    assert.equal(renderRoll(roll('1d4+2', [3])), '1d4+2=3+2=5');
    assert.equal(renderRoll(roll('1d10+1d6+3', [7, 3])), '1d10+1d6+3=7+3+3=13');
  });

  test('k 取大后只展示保留的点数', () => {
    assert.equal(renderRoll(roll('3d6k2', [2, 5, 4])), '3d6k2=4+5=9');
  });

  test('乘号与除号按参考实现展示', () => {
    assert.equal(renderRoll(roll('3d6X5', [3, 4, 5])), '3d6X5=(3+4+5)×5=60');
    assert.equal(renderRoll(roll('3d6/2', [3, 4, 5])), '3d6/2=(3+4+5)/2=6');
  });

  test('奖惩骰展示参考实现的 [奖励骰:..] / [惩罚骰:..]', () => {
    assert.equal(renderRoll(roll('b2', [45, 3, 7])), 'b2=45[奖励骰:2 6]=25');
    assert.equal(renderRoll(roll('p2', [45, 3, 7])), 'p2=45[惩罚骰:2 6]=65');
    assert.equal(renderRoll(roll('b0', [45])), 'b0=45');
  });

  test('非百面骰的额外奖惩骰：保留值 + 被丢掉的骰写进方括号', () => {
    assert.equal(renderRoll(roll('1d10b2', [3, 8, 2])), '1d10b2=8[奖励骰:3 2]=8');
    assert.equal(renderRoll(roll('1d10p2', [3, 8, 2])), '1d10p2=2[惩罚骰:3 8]=2');
    assert.equal(renderRoll(roll('2d6b1', [1, 5, 3])), '2d6b1=(5+3)[奖励骰:1]=8');
    assert.equal(renderRoll(roll('2#1d10b1', [1, 5, 2, 9])), '2#1d10b1={ 5[奖励骰:1]=5; 9[奖励骰:2]=9 }=14');
  });

  test('多轮逐轮渲染', () => {
    assert.equal(renderRoll(roll('3#1d6', [1, 2, 3])), '3#1d6={ 1; 2; 3 }=6');
    assert.equal(renderRoll(roll('2#1d4+1', [3, 1])), '2#1d4+1={ 3+1=4; 1+1=2 }=6');
  });

  test('多轮奖惩骰按轮切片渲染', () => {
    const text = renderRoll(roll('3#p', [45, 4, 60, 8, 20, 5]));
    assert.equal(text, '3#p1={ 45[惩罚骰:3]=45; 60[惩罚骰:8]=80; 20[惩罚骰:5]=50 }=175');
  });

  test('超过 20 个骰子展示排序后的点数', () => {
    const text = renderRoll(roll('21d21', descendingValues(21)));
    assert.equal(text, `21d21=${Array.from({ length: 21 }, (_, index) => index + 1).join('+')}=231`);
  });
});

describe('renderRoll: compact=true（/rs 式）', () => {
  test('单轮只给结果', () => {
    assert.equal(renderRoll(roll('3d6', [3, 4, 5]), { compact: true }), '3d6=12');
    assert.equal(renderRoll(roll('1d4+2', [3]), { compact: true }), '1d4+2=5');
    assert.equal(renderRoll(roll('1d100', [45]), { compact: true }), '1d100=45');
  });

  test('多轮给出每轮点数与总和', () => {
    assert.equal(renderRoll(roll('3#1d6', [1, 2, 3]), { compact: true }), '3#1d6=1+2+3=6');
    assert.equal(renderRoll(roll('2#1d4+1', [3, 1]), { compact: true }), '2#1d4+1=4+2=6');
  });

  test('compact 与缺省（false）的差异只在于是否展开单骰点数', () => {
    const result = roll('1d10+1d6+3', [7, 3]);
    assert.equal(renderRoll(result), '1d10+1d6+3=7+3+3=13');
    assert.equal(renderRoll(result, { compact: true }), '1d10+1d6+3=13');
  });
});

describe('renderRoll: 失败与兜底', () => {
  test('失败结果直接返回错误文本', () => {
    const result = engine.roll('abc', sequenceRng([]));
    assert.equal(result.ok, false);
    if (result.ok) assert.fail('expected failure');
    assert.equal(renderRoll(result), result.error);
  });

  test('与表达式结构不匹配的手工结果退化为 表达式=总和', () => {
    const handmade: RollResult = {
      ok: true,
      expression: '1d6',
      rounds: 1,
      groups: [],
      modifier: 0,
      totals: [3],
      total: 3,
      sorted: false,
    };
    assert.equal(renderRoll(handmade), '1d6=3');
  });
});
