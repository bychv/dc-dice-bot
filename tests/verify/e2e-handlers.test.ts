/**
 * T4 独立验证 · handler ↔ 真实引擎端到端接线
 *
 * tests/bot/* 用 StubCoc/StubDice 验证行为，这里换成真实 `createCocRules(createDiceEngine())`，
 * 用固定序列 Rng 走 `/st` `/rc` `/sc` `/en` `/r` `/rs` 全链路，验证：
 * - 角色卡创建/自动绑定、读卡、回写；
 * - 房规从 /setcoc 流到 /rc、/sc；
 * - `/r` 调用 `/st &表达式` 保存的名字。
 *
 * Run: node tests/verify/e2e-handlers.test.ts
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { route } from '../../src/bot/router.ts';
import { createCocRules } from '../../src/coc/index.ts';
import { createDiceEngine } from '../../src/dice/engine.ts';
import type { InteractionContext } from '../../src/contracts/bot.ts';
import { seqRng } from '../coc/helpers.ts';
import { makeContext, makeEnv, type CtxSpec, type TestEnv } from '../bot/fakes.ts';

/** 真实引擎 + 固定序列 Rng 的环境。 */
function e2eEnv(values: number[]): TestEnv {
  const dice = createDiceEngine();
  const env = makeEnv({ dice, coc: createCocRules(dice), rng: seqRng(values) });
  return env;
}

function ctx(env: TestEnv, spec: CtxSpec): InteractionContext {
  return makeContext({ channelId: 'C1', channelName: '跑团', userId: 'U1', ...spec }, env.platform);
}

describe('T4 · 端到端：/st + /rc + /sc + /en + /r', () => {
  test('/st 自动建卡并录入，之后 /rc 读卡并按房规判定', async () => {
    const env = e2eEnv([30]);
    const st = await route(ctx(env, { command: 'st', values: { text: '力量:50 侦查:45' } }), env.deps);
    assert.notEqual(st.ephemeral, true);
    const sheet = env.store.listSheets('U1')[0];
    assert.ok(sheet, '/st 必须自动建卡');
    assert.equal(sheet.attrs['力量'], '50');

    const rc = await route(ctx(env, { command: 'rc', values: { text: '力量' } }), env.deps);
    assert.notEqual(rc.ephemeral, true);
    assert.ok(rc.content.includes('D100=30/50'), rc.content);
    assert.ok(rc.content.includes('成功'), rc.content);
    assert.ok(rc.content.includes('房规0'), rc.content);
  });

  test('/setcoc 设定房规后 /rc 使用该房规（并体现在回执里）', async () => {
    const env = e2eEnv([96]);
    await route(ctx(env, { command: 'st', values: { text: '力量:50' } }), env.deps);
    await route(ctx(env, { command: 'setcoc', sub: 'set', values: { rule: 3 } }), env.deps);
    const rc = await route(ctx(env, { command: 'rc', values: { text: '力量' } }), env.deps);
    assert.ok(rc.content.includes('房规3'), rc.content);
    assert.ok(rc.content.includes('大失败'), `房规 3 下 96 应大失败：${rc.content}`);
  });

  test('/sc 走真实引擎：成功不扣、san 回写角色卡', async () => {
    const env = e2eEnv([90, 0]);
    await route(ctx(env, { command: 'st', values: { text: '理智:70' } }), env.deps);
    const sc = await route(ctx(env, { command: 'sc', values: { text: '0/1' } }), env.deps);
    assert.notEqual(sc.ephemeral, true);
    assert.ok(sc.content.includes('D100=90/70'), sc.content);
    assert.ok(sc.content.includes('失败'), sc.content);
    assert.equal(env.store.listSheets('U1')[0].attrs['理智'], '69', 'san 必须回写');
  });

  test('/sc 大失败失去最大 san（走房规）', async () => {
    const env = e2eEnv([100]);
    await route(ctx(env, { command: 'st', values: { text: '理智:70' } }), env.deps);
    const sc = await route(ctx(env, { command: 'sc', values: { text: '1d10/1d100' } }), env.deps);
    assert.notEqual(sc.ephemeral, true);
    assert.ok(sc.content.includes('大失败'), sc.content);
    assert.equal(env.store.listSheets('U1')[0].attrs['理智'], '0');
  });

  test('/en 走真实引擎并回写成长值', async () => {
    const env = e2eEnv([96, 7]);
    await route(ctx(env, { command: 'st', values: { text: '教育:60' } }), env.deps);
    const en = await route(ctx(env, { command: 'en', values: { text: '教育' } }), env.deps);
    assert.notEqual(en.ephemeral, true);
    assert.ok(en.content.includes('成长'), en.content);
    assert.equal(env.store.listSheets('U1')[0].attrs['教育'], '67', '96 → 成长 1D10=7');
  });

  test('/r 直接掷骰（含理由）与 /rs 只给结果', async () => {
    const env = e2eEnv([3]);
    const r = await route(ctx(env, { command: 'r', values: { text: '1d4+2 中型刀伤害' } }), env.deps);
    assert.notEqual(r.ephemeral, true);
    assert.ok(r.content.includes('1d4+2'), r.content);
    assert.ok(r.content.includes('=5'), r.content);
    assert.ok(r.content.includes('中型刀伤害'), r.content);

    const rs = await route(ctx(env, { command: 'rs', values: { text: '1d4+2' } }), env.deps);
    assert.notEqual(rs.ephemeral, true);
    assert.equal(rs.content.trim(), '1d4+2=5');
  });

  test('/st &表达式 之后 /rs 名字可调用', async () => {
    const env = e2eEnv([10, 6, 0]);
    await route(ctx(env, { command: 'st', values: { text: '&沙漠之鹰=1D10+1D6+3' } }), env.deps);
    const rs = await route(ctx(env, { command: 'rs', values: { text: '沙漠之鹰' } }), env.deps);
    assert.notEqual(rs.ephemeral, true);
    assert.ok(rs.content.includes('1d10+1d6+3'), rs.content);
    assert.ok(rs.content.includes('19'), `10+6+3=19，实际 ${rs.content}`);
  });

  test('/pc tag 后 /rc 读的是被绑定的卡（真实引擎按卡名取值）', async () => {
    const env = e2eEnv([1]);
    await route(ctx(env, { command: 'st', values: { text: '力量:50' } }), env.deps);
    await route(ctx(env, { command: 'pc', sub: 'new', values: { name: '卡特' } }), env.deps);
    await route(ctx(env, { command: 'pc', sub: 'tag', values: { name: '卡特' } }), env.deps);
    await route(ctx(env, { command: 'st', values: { text: '力量:80' } }), env.deps);

    const rc = await route(ctx(env, { command: 'rc', values: { text: '力量' } }), env.deps);
    assert.ok(rc.content.includes('/80'), `应读被 tag 的卡（80），实际 ${rc.content}`);
  });
});
