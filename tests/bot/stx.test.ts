/**
 * `/stx` 查看他人角色卡（docs §6.2）。
 *
 * 覆盖：默认看自己、看别人当前场景生效的卡、`name:` 指定卡、
 * 没生效卡时列卡名、完全没有卡时的提示、ephemeral、只读（不改任何数据）。
 *
 * Run: node tests/bot/stx.test.ts
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { route } from '../../src/bot/router.ts';
import type { CharacterSheet } from '../../src/contracts/model.ts';
import { makeContext, makeEnv, type TestEnv } from './fakes.ts';

function sheet(name: string, attrs: Record<string, string>): CharacterSheet {
  return {
    name,
    template: 'COC7',
    attrs,
    exprs: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const CAT = sheet('卡特', { 力量: '50', 体质: '60', 体型: '50', 敏捷: '60', 外貌: '75', 智力: '60', 意志: '60', 教育: '65', 幸运: '70', 理智: '61', 生命: '11', 闪避: '90', 魅惑: '80', 会计: '20' });
const U2 = '100000000000000002';

const stx = (env: TestEnv, values: Record<string, string | number | boolean> = {}, userId = 'KP') =>
  route(makeContext({ command: 'stx', channelId: 'C1', userId, values }, env.platform), env.deps);

function bind(env: TestEnv, userId: string, card: CharacterSheet): void {
  env.store.putSheet(userId, card);
  env.store.setBinding('scene', 'C1', userId, card.name);
}

describe('/stx 查看他人角色卡', () => {
  test('查看别人当前场景生效的卡：ephemeral、含主属性/状态/技能', async () => {
    const env = makeEnv();
    bind(env, U2, CAT);

    const reply = await stx(env, { user: U2 });
    assert.equal(reply.ephemeral, true, '属性表必须仅发起者可见');
    assert.match(reply.content, /【卡特】/);
    assert.match(reply.content, new RegExp(`<@${U2}>`));
    assert.match(reply.content, /主属性：力量 50/);
    assert.match(reply.content, /状态：幸运 70　理智 61　生命 11/);
    assert.match(reply.content, /闪避 90/);
    // 技能按值降序
    const order = [...reply.content.matchAll(/· (\S+) (\d+)/g)].map((m) => Number(m[2]));
    assert.deepEqual(order, [...order].sort((a, b) => b - a));
  });

  test('省略 user：看自己的卡', async () => {
    const env = makeEnv();
    bind(env, 'U1', CAT);
    const reply = await stx(env, {}, 'U1');
    assert.match(reply.content, /【卡特】<@U1>/);
  });

  test('name: 指定卡名（不受当前场景绑定影响）', async () => {
    const env = makeEnv();
    env.store.putSheet(U2, sheet('旧卡', { 力量: '30' }));
    env.store.putSheet(U2, CAT);
    bind(env, U2, CAT);
    const reply = await stx(env, { user: U2, name: '旧卡' });
    assert.match(reply.content, /【旧卡】/);
    assert.match(reply.content, /主属性：力量 30/);
  });

  test('当前场景没生效卡：列出名下卡名并提示 name:', async () => {
    const env = makeEnv();
    env.store.putSheet(U2, CAT); // 有卡但没绑定
    const reply = await stx(env, { user: U2 });
    assert.equal(reply.ephemeral, true);
    assert.match(reply.content, /当前场景没有生效的角色卡/);
    assert.match(reply.content, /卡特/);
    assert.match(reply.content, /\/stx name:/);
  });

  test('一张卡都没有：明确说还没有角色卡', async () => {
    const env = makeEnv();
    const reply = await stx(env, { user: U2 });
    assert.match(reply.content, new RegExp(`<@${U2}> 还没有角色卡`));
  });

  test('卡名不存在时列出他名下实际的卡', async () => {
    const env = makeEnv();
    env.store.putSheet(U2, CAT);
    const reply = await stx(env, { user: U2, name: '不存在的卡' });
    assert.match(reply.content, /没有名为「不存在的卡」的角色卡/);
    assert.match(reply.content, /他名下的卡：卡特/);
  });

  test('只读：不改变卡、绑定，也不触发昵称同步', async () => {
    const env = makeEnv();
    bind(env, U2, CAT);
    const before = JSON.stringify(env.store.getSheet(U2, '卡特'));
    const callsBefore = env.platform.nicknameCalls.length;

    await stx(env, { user: U2 });

    assert.equal(JSON.stringify(env.store.getSheet(U2, '卡特')), before);
    assert.equal(env.platform.nicknameCalls.length, callsBefore);
    assert.equal(env.store.getBinding('scene', 'C1', U2), '卡特');
  });
});
