/**
 * `/rcx`、`/rax` 代投检定（docs §7.2）：
 *   - 用**被代投者**在当前场景的角色卡算检定（不是发起者的卡）；
 *   - 回执以**被代投者的角色卡名**开头，适配层不再叠 `【发起人】`；
 *   - 代投时末尾补一行"由谁代投"；省略 `user` 等同 `/rc`（给自己投）。
 *
 * 两个环境：
 *   - `makeEnv()`（stub 引擎）：观察传进引擎的 sheet / rule；
 *   - `makeLiveEnv()`（真实 coc 引擎 + FixedRng）：验证真的取了被代投者的属性值。
 *
 * Run: node tests/bot/check-proxy.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPendingActions } from '../../src/bot/confirm.ts';
import { route } from '../../src/bot/router.ts';
import { createCocRules } from '../../src/coc/index.ts';
import type { HandlerDeps } from '../../src/contracts/bot.ts';
import type { CharacterSheet } from '../../src/contracts/model.ts';
import { createDiceEngine } from '../../src/dice/index.ts';
import { createJsonStoreWithExtras } from '../../src/store/jsonStore.ts';
import { FakePlatform, FixedRng, makeContext, makeEnv, type TestEnv } from './fakes.ts';

const TMP_ROOT = fileURLToPath(new URL('../.tmp/', import.meta.url));

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

const MINE = sheet('卡特', { 力量: '60', 敏捷: '70' });
const THEIRS = sheet('二宫友梨', { 力量: '30', 敏捷: '45' });

function bind(env: TestEnv, userId: string, card: CharacterSheet): void {
  env.store.putSheet(userId, card);
  env.store.setBinding('scene', 'C1', userId, card.name);
}

const cmd = (
  env: TestEnv,
  command: string,
  values: Record<string, string | number | boolean>,
  userId = 'KP',
): ReturnType<typeof route> =>
  route(makeContext({ command, channelId: 'C1', userId, values }, env.platform), env.deps);

describe('/rcx 代投：算在被代投者头上', () => {
  test('用被代投者的卡，回执以他的卡名开头，并注明谁代投', async () => {
    const env = makeEnv();
    bind(env, 'KP', MINE);
    bind(env, 'U2', THEIRS);

    const reply = await cmd(env, 'rcx', { text: '力量', user: 'U2' });

    assert.notEqual(reply.ephemeral, true);
    assert.equal(env.coc.checkCalls.at(-1)?.sheet?.name, '二宫友梨', '必须用被代投者的卡');
    assert.equal(env.coc.checkCalls.at(-1)?.text, '力量');
    assert.ok(reply.content.startsWith('【二宫友梨】'), reply.content);
    assert.match(reply.content, /（由 <@KP> 代投）/);
    assert.doesNotMatch(reply.content, /【卡特】/, '不能显示代投者的卡名');
  });

  test('/rax 与 /rcx 行为一致（同义命令）', async () => {
    const env = makeEnv();
    bind(env, 'U2', THEIRS);
    const reply = await cmd(env, 'rax', { text: '敏捷', user: 'U2' });
    assert.equal(env.coc.checkCalls.at(-1)?.sheet?.name, '二宫友梨');
    assert.ok(reply.content.startsWith('【二宫友梨】'), reply.content);
  });

  test('省略 user 就是给自己投：不加"代投"行', async () => {
    const env = makeEnv();
    bind(env, 'U1', MINE);
    const reply = await cmd(env, 'rcx', { text: '力量' }, 'U1');
    assert.equal(env.coc.checkCalls.at(-1)?.sheet?.name, '卡特');
    assert.ok(reply.content.startsWith('【卡特】'), reply.content);
    assert.doesNotMatch(reply.content, /代投/);
  });

  test('被代投者没有卡时用 @他 兜底，不会张冠李戴', async () => {
    const env = makeEnv();
    bind(env, 'KP', MINE);
    const reply = await cmd(env, 'rcx', { text: '力量 40', user: 'U9' });
    assert.ok(reply.content.startsWith('【<@U9>】'), reply.content);
  });

  test('引擎报错也带被代投者前缀（便于看出是谁的卡有问题）', async () => {
    const env = makeEnv();
    bind(env, 'U2', THEIRS);
    const reply = await cmd(env, 'rcx', { text: 'boom', user: 'U2' });
    assert.equal(reply.ephemeral, true);
    assert.match(reply.content, /^【二宫友梨】/);
    assert.match(reply.content, /未找到属性 boom/);
  });

  test('房规跟发起者所在场景一致（用 stub 观察 rule）', async () => {
    const env = makeEnv();
    bind(env, 'U2', THEIRS);
    env.store.setSceneRule('C1', 3); // `/setcoc` 写给场景的房规
    await cmd(env, 'rcx', { text: '力量', user: 'U2' });
    assert.equal(env.coc.checkCalls.at(-1)?.rule, 3);
  });
});

describe('真实引擎：数值确实取自被代投者的卡', () => {
  function makeLiveEnv(): { deps: HandlerDeps; store: ReturnType<typeof createJsonStoreWithExtras>; platform: FakePlatform } {
    mkdirSync(TMP_ROOT, { recursive: true });
    const dir = mkdtempSync(join(TMP_ROOT, 'check-proxy-'));
    const store = createJsonStoreWithExtras({ dir });
    const dice = createDiceEngine();
    const rng = new FixedRng([40]); // D100 = 40，方便断言成功率
    const platform = new FakePlatform();
    const deps: HandlerDeps = {
      store,
      dice,
      coc: createCocRules(dice, rng),
      rng,
      platform,
      confirmations: createPendingActions(),
      now: () => new Date('2026-01-05T21:30:00.000Z'),
    };
    return { deps, store, platform };
  }

  test('目标值来自被代投者：U1 力量 60 / U2 力量 30', async () => {
    const env = makeLiveEnv();
    for (const [userId, card] of [['U1', MINE], ['U2', THEIRS]] as const) {
      env.store.putSheet(userId, card);
      env.store.setBinding('scene', 'C1', userId, card.name);
    }
    const run = (command: string, values: Record<string, string | number | boolean>, userId: string) =>
      route(makeContext({ command, channelId: 'C1', userId, values }, env.platform), env.deps);

    const mine = await run('rc', { text: '力量' }, 'U1');
    assert.match(mine.content, /\/60/, mine.content);

    const theirs = await run('rcx', { text: '力量', user: 'U2' }, 'U1');
    assert.match(theirs.content, /【二宫友梨】/);
    assert.match(theirs.content, /\/30/, theirs.content);
    assert.doesNotMatch(theirs.content, /\/60/);
    assert.match(theirs.content, /（由 <@U1> 代投）/);
  });
});

describe('/scx 代骰：理智扣在被代骰者的卡上', () => {
  function makeLiveEnv(): { deps: HandlerDeps; store: ReturnType<typeof createJsonStoreWithExtras>; platform: FakePlatform } {
    mkdirSync(TMP_ROOT, { recursive: true });
    const dir = mkdtempSync(join(TMP_ROOT, 'scx-'));
    const store = createJsonStoreWithExtras({ dir });
    const dice = createDiceEngine();
    const rng = new FixedRng([50, 4]); // 检定骰 50、损失骰 4
    const platform = new FakePlatform();
    const deps: HandlerDeps = {
      store,
      dice,
      coc: createCocRules(dice, rng),
      rng,
      platform,
      confirmations: createPendingActions(),
      now: () => new Date('2026-01-05T21:30:00.000Z'),
    };
    return { deps, store, platform };
  }

  const san = (store: { getSheet: (u: string, n: string) => CharacterSheet | null }, userId: string, name: string): number =>
    Number(store.getSheet(userId, name)?.attrs['理智'] ?? NaN);

  test('用被代骰者的卡算，理智写回他的卡，发起者的卡不变', async () => {
    const env = makeLiveEnv();
    env.store.putSheet('U1', MINE);
    env.store.setBinding('scene', 'C1', 'U1', MINE.name);
    // 理智检定要求卡上有理智值（否则引擎会要求指令里给出）
    const theirs = { ...THEIRS, attrs: { ...THEIRS.attrs, 理智: '60' } };
    env.store.putSheet('U2', theirs);
    env.store.setBinding('scene', 'C1', 'U2', theirs.name);

    const beforeMine = san(env.store, 'U1', MINE.name);
    const beforeTheirs = san(env.store, 'U2', theirs.name);

    const reply = await route(
      makeContext({ command: 'scx', channelId: 'C1', userId: 'U1', values: { text: '1/1D6', user: 'U2' } }, env.platform),
      env.deps,
    );

    assert.notEqual(reply.ephemeral, true, reply.content);
    assert.match(reply.content, /^【二宫友梨】/, reply.content);
    assert.match(reply.content, /（由 <@U1> 代骰）/);
    assert.ok(san(env.store, 'U2', THEIRS.name) < beforeTheirs, '理智必须扣在被代骰者卡上');
    assert.equal(san(env.store, 'U1', MINE.name), beforeMine, '发起者的卡必须原封不动');
  });

  test('省略 user 等同 /sc：以自己卡名开头，无代骰行', async () => {
    const env = makeLiveEnv();
    env.store.putSheet('U1', MINE);
    env.store.setBinding('scene', 'C1', 'U1', MINE.name);

    const reply = await route(
      makeContext({ command: 'scx', channelId: 'C1', userId: 'U1', values: { text: '1/1D6' } }, env.platform),
      env.deps,
    );
    assert.match(reply.content, /^【卡特】/, reply.content);
    assert.doesNotMatch(reply.content, /代骰/);
  });

  test('被代骰者没有卡时用 @他 兜底', async () => {
    const env = makeLiveEnv();
    const reply = await route(
      makeContext({ command: 'scx', channelId: 'C1', userId: 'U1', values: { text: '0/1 70', user: 'U9' } }, env.platform),
      env.deps,
    );
    assert.match(reply.content, /^【<@U9>】/, reply.content);
    assert.match(reply.content, /（由 <@U1> 代骰）/);
  });

  test('开了 /sn 且正在记录：代骰后昵称里的 SAN 同步刷新', async () => {
    const env = makeLiveEnv();
    env.store.putSheet('U2', { ...THEIRS, attrs: { 力量: '30', 敏捷: '45', 体质: '50', 体型: '70', 理智: '70' } });
    env.store.setBinding('scene', 'C1', 'U2', THEIRS.name);
    env.platform.nicknames.set('G1:U2', '老王');
    const snOn = (sub: string, userId: string) =>
      route(makeContext({ command: 'sn', sub, channelId: 'C1', userId, values: {} }, env.platform), env.deps);
    await snOn('on', 'U2');
    await route(makeContext({ command: 'log', sub: 'new', channelId: 'C1', userId: 'U2', values: { name: '第一天' } }, env.platform), env.deps);
    assert.match(env.platform.nicknames.get('G1:U2') ?? '', /SAN70/);

    const reply = await route(
      makeContext({ command: 'scx', channelId: 'C1', userId: 'KP', values: { text: '1/1D6', user: 'U2' } }, env.platform),
      env.deps,
    );
    assert.match(reply.content, /已更新统计昵称/);
    assert.doesNotMatch(env.platform.nicknames.get('G1:U2') ?? '', /SAN70/, '昵称里的 SAN 必须跟着掉');
  });
});
