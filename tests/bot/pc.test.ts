/**
 * `/pc` behaviour: creation, tag scope (局 > 场景 > 全局), rename/copy/del/clr, grp.
 * Run: node tests/bot/pc.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { route } from '../../src/bot/router.ts';
import { handleButtonClick } from '../../src/bot/confirm.ts';
import { GLOBAL_BINDING_KEY } from '../../src/bot/handlers/context.ts';
import { makeContext, makeEnv, type CtxSpec, type TestEnv } from './fakes.ts';
import type { InteractionContext } from '../../src/contracts/bot.ts';

function pcCtx(
  env: TestEnv,
  sub: string,
  values: Record<string, string | number | boolean> = {},
  overrides: Partial<CtxSpec> = {},
): InteractionContext {
  return makeContext({ command: 'pc', sub, channelId: 'C1', userId: 'U1', values, ...overrides }, env.platform);
}

async function startSession(env: TestEnv, name = '阿卡姆', channelId = 'C1') {
  await route(
    makeContext({ command: 'game', sub: 'start', channelId, channelName: '跑团', userId: 'U1', values: { name, keeper: 'U1' } }, env.platform),
    env.deps,
  );
  return env.store.listGames('G1').at(-1)!;
}

describe('/pc basics', () => {
  test('new + list + show; the first card is auto-bound where there was none', async () => {
    const env = makeEnv();
    const created = await route(pcCtx(env, 'new', { name: '卡特' }), env.deps);
    assert.notEqual(created.ephemeral, true);
    assert.ok(created.content.includes('卡特'));
    assert.equal(env.store.getBinding('scene', 'C1', 'U1'), '卡特');

    const list = await route(pcCtx(env, 'list'), env.deps);
    assert.ok(list.content.includes('卡特'));
    assert.ok(list.content.includes('← 当前'));

    const show = await route(pcCtx(env, 'show'), env.deps);
    assert.ok(show.content.includes('【卡特】'));
  });

  test('duplicate names are refused; a second card does not steal the active binding', async () => {
    const env = makeEnv();
    await route(pcCtx(env, 'new', { name: '卡特' }), env.deps);
    const dup = await route(pcCtx(env, 'new', { name: '卡特' }), env.deps);
    assert.equal(dup.ephemeral, true);

    await route(pcCtx(env, 'new', { name: '安娜' }), env.deps);
    assert.equal(env.store.getBinding('scene', 'C1', 'U1'), '卡特');
    assert.equal(env.store.listSheets('U1').length, 2);
  });

  test('with several unbound cards /st refuses instead of guessing', async () => {
    const env = makeEnv();
    await route(pcCtx(env, 'new', { name: '卡特' }), env.deps);
    await route(pcCtx(env, 'new', { name: '安娜' }), env.deps);
    await route(pcCtx(env, 'tag'), env.deps); // unbind

    const reply = await route(makeContext({ command: 'st', channelId: 'C1', userId: 'U1', values: { text: '力量:50' } }, env.platform), env.deps);
    assert.equal(reply.ephemeral, true);
    assert.ok(reply.content.includes('/pc tag'));
  });
});

describe('/pc tag scope', () => {
  test('with a session the binding is on the session and is shared by its scenes', async () => {
    const env = makeEnv();
    const game = await startSession(env);
    const scene = game.sceneThreadId!;

    await route(pcCtx(env, 'new', { name: '卡特' }, { channelId: scene, parentChannelId: 'C1' }), env.deps);
    await route(pcCtx(env, 'tag', { name: '卡特' }, { channelId: scene, parentChannelId: 'C1' }), env.deps);
    assert.equal(env.store.getBinding('game', game.id, 'U1'), '卡特');
    assert.equal(env.store.getBinding('scene', scene, 'U1'), null);

    // a second scene of the same session sees the same card
    await route(
      makeContext({ command: 'game', sub: 'switch', channelId: 'C2', userId: 'ADMIN', isAdmin: true, values: { game: game.id } }, env.platform),
      env.deps,
    );
    const show = await route(pcCtx(env, 'show', {}, { channelId: 'C2' }), env.deps);
    assert.ok(show.content.includes('【卡特】'));
  });

  test('without a session the binding covers the scene AND the user-level 常用卡（跨频道/子区持续）', async () => {
    const env = makeEnv();
    await route(pcCtx(env, 'new', { name: '卡特' }, { channelId: 'C5' }), env.deps);
    await route(pcCtx(env, 'tag', { name: '卡特' }, { channelId: 'C5' }), env.deps);
    assert.equal(env.store.getBinding('scene', 'C5', 'U1'), '卡特');
    assert.equal(env.store.getBinding('user', 'G1', 'U1'), '卡特', '同时记为本服常用卡');

    // 别的频道没有单独绑定 → 用用户级常用卡（这就是"跨子区持续"）
    const other = await route(pcCtx(env, 'show', {}, { channelId: 'C6' }), env.deps);
    assert.notEqual(other.ephemeral, true);
    assert.ok(other.content.includes('卡特'), other.content);

    // 但不会跨服务器串卡
    const otherGuild = await route(pcCtx(env, 'show', {}, { channelId: 'C6', guildId: 'G2' }), env.deps);
    assert.equal(otherGuild.ephemeral, true);
    assert.ok(otherGuild.content.includes('没有生效的角色卡'), otherGuild.content);
  });

  test('resolution order is 局 > 场景 > 全局默认卡, and omitting name unbinds one level', async () => {
    const env = makeEnv();
    // global default, set from DM (docs §5.1)
    await route(pcCtx(env, 'new', { name: '全局卡' }, { guildId: null, channelId: 'DM1' }), env.deps);
    await route(pcCtx(env, 'tag', { name: '全局卡' }, { guildId: null, channelId: 'DM1' }), env.deps);
    assert.equal(env.store.getBinding('global', GLOBAL_BINDING_KEY, 'U1'), '全局卡');

    // scene card in C5
    await route(pcCtx(env, 'new', { name: '场景卡' }, { channelId: 'C5' }), env.deps);
    await route(pcCtx(env, 'tag', { name: '场景卡' }, { channelId: 'C5' }), env.deps);

    // session card: start a session in C5 then tag
    const started = await route(
      makeContext({ command: 'game', sub: 'start', channelId: 'C5', userId: 'U1', values: { name: '局卡', here: true } }, env.platform),
      env.deps,
    );
    assert.notEqual(started.ephemeral, true);
    const game = env.store.getSceneGame('C5')!;
    await route(pcCtx(env, 'new', { name: '局卡' }, { channelId: 'C5' }), env.deps);
    await route(pcCtx(env, 'tag', { name: '局卡' }, { channelId: 'C5' }), env.deps);

    let show = await route(pcCtx(env, 'show', {}, { channelId: 'C5' }), env.deps);
    assert.ok(show.content.includes('【局卡】'), show.content);

    // unbind the session level → scene card
    await route(pcCtx(env, 'tag', {}, { channelId: 'C5' }), env.deps);
    show = await route(pcCtx(env, 'show', {}, { channelId: 'C5' }), env.deps);
    assert.ok(show.content.includes('【场景卡】'), show.content);

    // unbind the scene level → global default card
    // (the scene level is only reachable once the session no longer claims this scene)
    await route(
      makeContext({ command: 'game', sub: 'end', channelId: 'C5', userId: 'U1' }, env.platform),
      env.deps,
    );
    await route(pcCtx(env, 'tag', {}, { channelId: 'C5' }), env.deps);
    show = await route(pcCtx(env, 'show', {}, { channelId: 'C5' }), env.deps);
    assert.ok(show.content.includes('【全局卡】'), show.content);
    assert.equal(env.store.getSceneGame('C5'), null);
    assert.equal(env.store.getGame('G1', game)?.status, 'ended');
  });

  test('grp lists session bindings and the current scene binding', async () => {
    const env = makeEnv();
    const game = await startSession(env);
    const scene = game.sceneThreadId!;
    await route(pcCtx(env, 'new', { name: '卡特' }, { channelId: scene, parentChannelId: 'C1' }), env.deps);
    await route(pcCtx(env, 'tag', { name: '卡特' }, { channelId: scene, parentChannelId: 'C1' }), env.deps);

    const grp = await route(pcCtx(env, 'grp', {}, { channelId: scene, parentChannelId: 'C1' }), env.deps);
    assert.ok(grp.content.includes(`局 ${game.id}`));
    assert.ok(grp.content.includes('卡特'));
    assert.ok(grp.content.includes('场景'));
  });
});

describe('/pc maintenance', () => {
  test('rename moves the binding, copy duplicates attributes, del clears bindings', async () => {
    const env = makeEnv();
    await route(pcCtx(env, 'new', { name: '卡特' }), env.deps);
    await route(
      makeContext({ command: 'st', channelId: 'C1', userId: 'U1', values: { text: '力量:50' } }, env.platform),
      env.deps,
    );

    const renamed = await route(pcCtx(env, 'rename', { name: '卡特2' }), env.deps);
    assert.notEqual(renamed.ephemeral, true);
    assert.equal(env.store.getSheet('U1', '卡特'), null);
    assert.equal(env.store.getSheet('U1', '卡特2')?.attrs['力量'], '50');
    assert.equal(env.store.getBinding('scene', 'C1', 'U1'), '卡特2');

    await route(pcCtx(env, 'copy', { from: '卡特2', to: '卡特3' }), env.deps);
    assert.equal(env.store.getSheet('U1', '卡特3')?.attrs['力量'], '50');

    await route(pcCtx(env, 'del', { name: '卡特3' }), env.deps);
    assert.equal(env.store.getSheet('U1', '卡特3'), null);

    // docs §16.6: /pc clr 首次只给确认按钮，点确认后才执行原清空逻辑
    const prompt = await route(pcCtx(env, 'clr'), env.deps);
    assert.equal(env.store.listSheets('U1').length, 1, '首次不得改动数据');
    assert.equal(env.store.getBinding('scene', 'C1', 'U1'), '卡特2');
    const row = prompt.components?.[0];
    assert.ok(row, `首次回执应带一行确认组件：${prompt.content}`);
    assert.equal(row.type, 1);
    assert.equal(row.components.length, 2, '确认 + 取消两个按钮');
    assert.ok(row.components[0].custom_id.startsWith('confirm:'), prompt.content);
    assert.ok(row.components[1].custom_id.startsWith('cancel:'), prompt.content);
    await handleButtonClick(row.components[0].custom_id, 'U1', env.deps);
    assert.equal(env.store.listSheets('U1').length, 0);
    assert.equal(env.store.getBinding('scene', 'C1', 'U1'), null);
  });

  test('build generates the COC7 primary attributes; redo clears then regenerates', async () => {
    const env = makeEnv();
    await route(pcCtx(env, 'new', { name: '卡特' }), env.deps);
    const built = await route(pcCtx(env, 'build', { name: '卡特', text: 'normal' }), env.deps);
    assert.notEqual(built.ephemeral, true);
    const attrs = env.store.getSheet('U1', '卡特')?.attrs ?? {};
    assert.equal(Object.keys(attrs).length, 9);
    assert.ok(built.content.includes('力量'));

    const redone = await route(pcCtx(env, 'redo', { name: '卡特' }), env.deps);
    assert.notEqual(redone.ephemeral, true);
    assert.equal(Object.keys(env.store.getSheet('U1', '卡特')?.attrs ?? {}).length, 9);
  });

  test('stat reports card scope instead of inventing roll history', async () => {
    const env = makeEnv();
    await route(pcCtx(env, 'new', { name: '卡特' }), env.deps);
    const stat = await route(pcCtx(env, 'stat'), env.deps);
    assert.ok(stat.content.includes('角色卡'));
    assert.ok(stat.content.includes('没有掷骰统计存储'));
  });
});
