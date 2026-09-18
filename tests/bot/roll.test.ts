/**
 * `/r`, `/rs`, `/st`, `/rc`, `/ra`, `/sc`, `/en` behaviour (整行原文解析 + 落库).
 * Run: node tests/bot/roll.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { route } from '../../src/bot/router.ts';
import { makeContext, makeEnv, type CtxSpec, type TestEnv } from './fakes.ts';
import type { InteractionContext } from '../../src/contracts/bot.ts';

function cmd(
  env: TestEnv,
  command: string,
  values: Record<string, string | number | boolean> = {},
  overrides: Partial<CtxSpec> = {},
): InteractionContext {
  return makeContext({ command, channelId: 'C1', userId: 'U1', displayName: '甲', values, ...overrides }, env.platform);
}

describe('/r and /rs', () => {
  test('/r passes the leading expression to the engine and keeps the reason', async () => {
    const env = makeEnv();
    const reply = await route(cmd(env, 'r', { text: '1d4+2 中型刀伤害' }), env.deps);
    assert.notEqual(reply.ephemeral, true);
    assert.deepEqual(env.dice.rolls, ['1d4+2']);
    assert.ok(reply.content.includes('中型刀伤害'));
    assert.ok(reply.content.includes('42'));
  });

  test('/r with no text rolls the COC default d100 once', async () => {
    const env = makeEnv();
    await route(cmd(env, 'r'), env.deps);
    assert.deepEqual(env.dice.rolls, ['1d100']);
  });

  test('/r re-attaches the N# round count that parseRollText strips', async () => {
    const env = makeEnv();
    await route(cmd(env, 'r', { text: '3#1d6 3发.22伤害' }), env.deps);
    assert.deepEqual(env.dice.rolls, ['3#1d6']);
  });

  test('/r resolves a card expression by name', async () => {
    const env = makeEnv();
    await route(cmd(env, 'pc', { name: '卡特' }, { sub: 'new' }), env.deps);
    const sheet = env.store.getSheet('U1', '卡特')!;
    env.store.putSheet('U1', { ...sheet, exprs: { 沙漠之鹰: '1D10+1D6+3' } });

    await route(cmd(env, 'r', { text: '沙漠之鹰' }), env.deps);
    assert.deepEqual(env.dice.rolls, ['1D10+1D6+3']);
  });

  test('/r falls back to "the whole line is the reason" for a default d100', async () => {
    const env = makeEnv();
    const reply = await route(cmd(env, 'r', { text: '心理学' }), env.deps);
    assert.deepEqual(env.dice.rolls, ['1d100']);
    assert.ok(reply.content.includes('心理学'));
  });

  test('/rs renders the compact form and requires text', async () => {
    const env = makeEnv();
    const reply = await route(cmd(env, 'rs', { text: '1D10+1D6+3 沙鹰伤害' }), env.deps);
    assert.deepEqual(env.dice.rolls, ['1D10+1D6+3']);
    assert.ok(reply.content.includes('沙鹰伤害'));
    assert.ok(reply.content.includes('42'));

    const missing = await route(cmd(env, 'rs'), env.deps);
    assert.equal(missing.ephemeral, true);
  });

  test('engine failures become an ephemeral error message', async () => {
    const env = makeEnv();
    env.dice.failNext = true;
    const reply = await route(cmd(env, 'r', { text: '99d999' }), env.deps);
    assert.equal(reply.ephemeral, true);
    assert.ok(reply.content.includes('掷骰失败'));
  });
});

describe('/st', () => {
  test('records attributes and persists the mutated sheet', async () => {
    const env = makeEnv();
    const reply = await route(cmd(env, 'st', { text: '力量:50 体质:55' }), env.deps);
    assert.notEqual(reply.ephemeral, true);
    const sheet = env.store.listSheets('U1')[0];
    assert.ok(sheet, 'a default card is created when the user has none');
    assert.equal(sheet.name, '甲');
    assert.equal(sheet.attrs['力量'], '50');
    assert.ok(reply.content.includes('力量:50') || reply.content.includes('已录入'));
  });

  test('the same default card is reused on the next /st', async () => {
    const env = makeEnv();
    await route(cmd(env, 'st', { text: '力量:50' }), env.deps);
    await route(cmd(env, 'st', { text: '体质:55' }), env.deps);
    assert.equal(env.store.listSheets('U1').length, 1);
    const sheet = env.store.getSheet('U1', '甲')!;
    assert.equal(sheet.attrs['力量'], '50');
    assert.equal(sheet.attrs['体质'], '55');
  });

  test('missing text is rejected', async () => {
    const env = makeEnv();
    const reply = await route(cmd(env, 'st'), env.deps);
    assert.equal(reply.ephemeral, true);
  });
});

describe('/rc, /ra, /sc, /en', () => {
  test('/rc and /ra share the same check path with the resolved sheet and rule', async () => {
    const env = makeEnv();
    await route(cmd(env, 'pc', { name: '卡特' }, { sub: 'new' }), env.deps);
    await route(cmd(env, 'setcoc', { rule: 4 }, { sub: 'set' }), env.deps);

    const rc = await route(cmd(env, 'rc', { text: '困难智力 99' }), env.deps);
    assert.notEqual(rc.ephemeral, true);
    assert.equal(env.coc.checkCalls[0].text, '困难智力 99');
    assert.equal(env.coc.checkCalls[0].sheet?.name, '卡特');
    assert.equal(env.coc.checkCalls[0].rule, 4);
    assert.ok(rc.content.includes('检定'));

    const ra = await route(cmd(env, 'ra', { text: '力量' }), env.deps);
    assert.notEqual(ra.ephemeral, true);
    assert.equal(env.coc.checkCalls[1].text, '力量');
  });

  test('/rc without text and engine failures are reported', async () => {
    const env = makeEnv();
    const missing = await route(cmd(env, 'rc'), env.deps);
    assert.equal(missing.ephemeral, true);

    const failed = await route(cmd(env, 'rc', { text: 'boom' }), env.deps);
    assert.equal(failed.ephemeral, true);
    assert.ok(failed.content.includes('boom'));
  });

  test('/sc forwards the trailing san value and writes the updated san back', async () => {
    const env = makeEnv();
    await route(cmd(env, 'st', { text: '理智:70' }), env.deps);
    const reply = await route(cmd(env, 'sc', { text: '0/1 70 见到深潜者' }), env.deps);
    assert.notEqual(reply.ephemeral, true);
    assert.equal(env.coc.sanityCalls[0].text, '0/1 70 见到深潜者');
    assert.equal(env.coc.sanityCalls[0].sanOverride, 70);
    assert.equal(env.store.getSheet('U1', '甲')?.attrs['理智'], '69');
    assert.ok(reply.content.includes('理智'));
  });

  test('/sc without a sheet still passes the san override', async () => {
    const env = makeEnv();
    await route(cmd(env, 'sc', { text: '1d10/1d100 70' }), env.deps);
    assert.equal(env.coc.sanityCalls[0].sanOverride, 70);
  });

  test('/en forwards the trailing skill value', async () => {
    const env = makeEnv();
    const reply = await route(cmd(env, 'en', { text: '教育 60 教育增强' }), env.deps);
    assert.notEqual(reply.ephemeral, true);
    assert.equal(env.coc.improveCalls[0].text, '教育 60 教育增强');
    assert.equal(env.coc.improveCalls[0].valueOverride, 60);
    assert.ok(reply.content.includes('教育'));
  });

  test('/en with a dice-shaped growth expression does not treat it as a plain number', async () => {
    const env = makeEnv();
    await route(cmd(env, 'en', { text: '幸运 +1D3/1D10 幸运成长' }), env.deps);
    assert.equal(env.coc.improveCalls[0].valueOverride, null);
  });
});
