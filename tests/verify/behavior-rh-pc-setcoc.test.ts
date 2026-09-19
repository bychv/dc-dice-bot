/**
 * T4 独立验证 · `/rh` 四级优先级与登记持久化 · `/pc tag` 局优先 · `/setcoc` 局优先
 *              · 跨服隔离（MemoryStore 与 jsonStore 两侧）
 *
 * 规格：docs/Discord_CoC_Command_Set.md §4.2（186-206）、§1.4（60-65）、§10.2（522-532）、
 * §5.1（224-246）、§8.1（339-361）、§16.4（750）、§16.11（757）。
 *
 * Run: node tests/verify/behavior-rh-pc-setcoc.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { route } from '../../src/bot/router.ts';
import { createJsonStore } from '../../src/store/jsonStore.ts';
import type { BotStore } from '../../src/contracts/store.ts';
import type { InteractionContext } from '../../src/contracts/bot.ts';
import { makeContext, makeEnv, type CtxSpec, type TestEnv } from '../bot/fakes.ts';

const TMP_ROOT = fileURLToPath(new URL('../.tmp/', import.meta.url));

function rhCtx(env: TestEnv, values: Record<string, string | number | boolean>, over: Partial<CtxSpec> = {}): InteractionContext {
  return makeContext({ command: 'rh', channelId: 'C1', channelName: '跑团', userId: 'U1', displayName: '甲', values, ...over }, env.platform);
}

function lastChannel(env: TestEnv): string | undefined {
  return env.platform.messages.at(-1)?.channelId;
}

describe('T4 · /rh 投递优先级（显式 thread > 本局暗骰区 > 场景登记 > 自动子区）', () => {
  test('四级同时存在时逐级生效（显式 > 本局 > 登记 > 自动）', async () => {
    const env = makeEnv();
    env.platform.channelNames.set('C1', '跑团');
    await route(makeContext({ command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'KP1', values: { name: '阿卡姆', keeper: 'KP1' } }, env.platform), env.deps);
    const game = env.store.getGame('G1', '#1');
    assert.ok(game && game.sceneThreadId && game.hiddenThreadId);
    const scene = game.sceneThreadId;
    env.platform.threads.set('T9', { id: 'T9', parentId: 'C1', name: '临时暗骰区', private: true });

    // 场景级登记 T9
    await route(makeContext({ command: 'rh', channelId: scene, parentChannelId: 'C1', userId: 'U1', values: { thread: 'T9' } }, env.platform), env.deps);
    assert.equal(env.store.getRegisteredThread(scene), 'T9');

    // 1) 省略 thread → 本局暗骰子区压过场景登记（登记仍是 T9）
    await route(makeContext({ command: 'rh', channelId: scene, parentChannelId: 'C1', userId: 'U1', values: { text: '心理学' } }, env.platform), env.deps);
    assert.equal(lastChannel(env), game.hiddenThreadId);
    assert.equal(env.store.getRegisteredThread(scene), 'T9');

    // 2) 显式 thread 最优先（压过本局暗骰子区）
    const explicit = await route(makeContext({ command: 'rh', channelId: scene, parentChannelId: 'C1', userId: 'U1', values: { text: '心理学', thread: 'T9' } }, env.platform), env.deps);
    // 规格更新：暗骰的所有回执改为仅发起者可见（ephemeral），频道内不再出现暗骰提示
    assert.equal(explicit.ephemeral, true);
    assert.equal(lastChannel(env), 'T9');
  });

  test('无局时：场景登记压过自动子区，登记按场景（channel id）隔离', async () => {
    const env = makeEnv();
    env.platform.channelNames.set('C1', '跑团');
    env.platform.threads.set('T9', { id: 'T9', parentId: 'C1', name: 'C1 登记区', private: true });
    env.platform.threads.set('T8', { id: 'T8', parentId: 'C2', name: 'C2 登记区', private: true });

    await route(rhCtx(env, { thread: 'T9' }), env.deps);
    await route(rhCtx(env, { thread: 'T8' }, { channelId: 'C2' }), env.deps);
    assert.equal(env.store.getRegisteredThread('C1'), 'T9');
    assert.equal(env.store.getRegisteredThread('C2'), 'T8');

    await route(rhCtx(env, { text: '侦查' }), env.deps);
    assert.equal(lastChannel(env), 'T9');
    await route(rhCtx(env, { text: '侦查' }, { channelId: 'C2' }), env.deps);
    assert.equal(lastChannel(env), 'T8');
  });

  test('reset 只清场景级登记；有局时仍投本局暗骰子区', async () => {
    const env = makeEnv();
    await route(makeContext({ command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'KP1', values: { name: '阿卡姆', keeper: 'KP1' } }, env.platform), env.deps);
    const game = env.store.getGame('G1', '#1');
    assert.ok(game && game.sceneThreadId && game.hiddenThreadId);
    const scene = game.sceneThreadId;
    env.platform.threads.set('T9', { id: 'T9', parentId: 'C1', name: '临时', private: true });

    await route(makeContext({ command: 'rh', channelId: scene, parentChannelId: 'C1', userId: 'U1', values: { text: '聆听', thread: 'T9' } }, env.platform), env.deps);
    const reset = await route(makeContext({ command: 'rh', channelId: scene, parentChannelId: 'C1', userId: 'U1', values: { reset: true } }, env.platform), env.deps);
    assert.equal(reset.ephemeral, true, 'reset 确认也只给发起者');
    assert.equal(env.store.getRegisteredThread(scene), null);
    assert.ok(reset.content.includes(game.hiddenThreadId), 'reset 回执要指出本局暗骰子区仍在');

    await route(makeContext({ command: 'rh', channelId: scene, parentChannelId: 'C1', userId: 'U1', values: { text: '聆听' } }, env.platform), env.deps);
    assert.equal(lastChannel(env), game.hiddenThreadId);
  });

  test('无局无登记：自动子区建在父频道下（场景是子区也如此），且回执仅发起者可见', async () => {
    const env = makeEnv();
    env.platform.channelNames.set('C1', '跑团');
    const reply = await route(rhCtx(env, { text: '3#1d10 聆听' }, { channelId: 'T7', parentChannelId: 'C1', channelName: '某子区' }), env.deps);

    assert.equal(reply.ephemeral, true, '暗骰回执仅发起者可见');
    const auto = env.platform.threads.get(lastChannel(env) ?? '');
    assert.ok(auto);
    assert.equal(auto.name, '暗骰 · 某子区', '自动子区名 = 暗骰 · <场景名>');
    assert.equal(auto.parentId, 'C1', '子区不能内嵌：场景是子区时暗骰子区建在父频道');
    assert.equal(auto.private, true);
    assert.ok(reply.content.includes('42'), '无局时发起者本人进子区，回显仍带结果');
    assert.ok(reply.content.includes('<#' + auto.id + '>'));
  });

  test('不同子区各自开一个自动暗骰子区（不共用）', async () => {
    const env = makeEnv();
    env.platform.channelNames.set('C1', '跑团');
    await route(rhCtx(env, { text: '侦查' }, { channelId: 'T7', parentChannelId: 'C1', channelName: '甲团' }), env.deps);
    const first = lastChannel(env);
    await route(rhCtx(env, { text: '侦查' }, { channelId: 'T8', parentChannelId: 'C1', channelName: '乙团' }), env.deps);
    const second = lastChannel(env);
    assert.ok(first && second && first !== second, '两个子区必须各有一个暗骰子区');
    assert.equal(env.platform.threads.get(first ?? '')?.name, '暗骰 · 甲团');
    assert.equal(env.platform.threads.get(second ?? '')?.name, '暗骰 · 乙团');
    assert.equal([...env.platform.threads.values()].filter((t) => t.private).length, 2);
  });

  test('规格 §16.4：自动子区「之后一直复用」，第二次 /rh 不得再建新私密子区', async () => {
    const env = makeEnv();
    env.platform.channelNames.set('C1', '跑团');
    const first = await route(rhCtx(env, { text: '侦查' }), env.deps);
    assert.equal(first.ephemeral, true);
    const id1 = lastChannel(env);
    assert.ok(id1);
    assert.ok(first.content.includes('复用'), '回执声称之后会复用该子区');

    const second = await route(rhCtx(env, { text: '侦查' }), env.deps);
    assert.equal(second.ephemeral, true);
    const id2 = lastChannel(env);
    assert.equal(id2, id1, '第二次 /rh 必须复用同一个自动子区（规格 §4.2/§16.4）');
    assert.equal([...env.platform.threads.values()].filter((t) => t.private).length, 1, '不得重复创建私密子区');
  });

  test('非子区目标被拒（不静默改投）', async () => {
    const env = makeEnv();
    const reply = await route(rhCtx(env, { text: '聆听', thread: 'C2' }), env.deps);
    assert.equal(reply.ephemeral, true);
    assert.ok(reply.content.includes('不是子区'));
    assert.equal(env.platform.messages.length, 0);
  });

  test('缺权限：降级 ephemeral，回执仍带骰值且不落频道', async () => {
    const env = makeEnv();
    env.platform.canCreate = false;
    const reply = await route(rhCtx(env, { text: '心理学' }), env.deps);
    assert.equal(reply.ephemeral, true);
    assert.ok(reply.content.includes('权限') || reply.content.includes('降级'));
    assert.ok(reply.content.includes('42'), '降级回执仍应给出结果');
    assert.equal(env.platform.messages.length, 0);
    assert.equal([...env.platform.threads.values()].length, 0);
  });

  test('开局后只有 /game 指定的 KP 进私密子区；其他人只拿仅自己可见的回显', async () => {
    const env = makeEnv();
    await route(makeContext({ command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'KP1', values: { name: '阿卡姆', keeper: 'KP1' } }, env.platform), env.deps);
    const game = env.store.getGame('G1', '#1');
    const hidden = game?.hiddenThreadId ?? '';
    const scene = game?.sceneThreadId ?? 'C1';

    const reply = await route(rhCtx(env, { text: '心理学' }, { channelId: scene, parentChannelId: 'C1' }), env.deps);
    const members = env.platform.members.get(hidden) ?? [];
    assert.ok(members.includes('KP1'), '本局 KP 必须在子区里');
    assert.ok(!members.includes('U1'), '发起者（PL）不得进入私密子区');
    assert.equal(reply.ephemeral, true);
    assert.ok(reply.content.includes('42'), '非成员只能靠 ephemeral 回显看到结果');

    // 有局时 KP 只由 /game 指定，keeper: 不再改变成员
    await route(rhCtx(env, { text: '心理学', keeper: 'U9' }, { channelId: scene, parentChannelId: 'C1' }), env.deps);
    const after = env.platform.members.get(hidden) ?? [];
    assert.ok(!after.includes('U9'), '有局时 keeper: 不拉人进子区');
    assert.ok(!after.includes('U1'), '发起者始终不进子区');
  });

  test('本局暗骰子区被删除时应自动失效并回落（规格 §16.11）', async () => {
    const env = makeEnv();
    env.platform.channelNames.set('C1', '跑团');
    await route(makeContext({ command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'KP1', values: { name: '阿卡姆', keeper: 'KP1' } }, env.platform), env.deps);
    const game = env.store.getGame('G1', '#1');
    assert.ok(game && game.sceneThreadId && game.hiddenThreadId);
    // Bot 移出 / 子区被删除：threadParent 解析不到
    env.platform.threads.delete(game.hiddenThreadId);

    const reply = await route(makeContext({ command: 'rh', channelId: game.sceneThreadId, parentChannelId: 'C1', userId: 'U1', values: { text: '侦查' } }, env.platform), env.deps);
    assert.equal(reply.ephemeral, true, '失效子区应自动回落（回执仅发起者可见），而不是直接失败');
    const sent = lastChannel(env);
    assert.ok(sent && sent !== game.hiddenThreadId);
    assert.equal(env.platform.threads.get(sent)?.private, true, '回落目标应为自动创建的私密子区');
  });
});

describe('T4 · /pc tag 绑定解析链（局 > 场景 > 全局）', () => {
  function pcNew(env: TestEnv, name: string, over: Partial<CtxSpec>): Promise<{ content: string; ephemeral?: boolean }> {
    return route(makeContext({ command: 'pc', sub: 'new', channelId: 'C1', userId: 'U1', values: { name }, ...over }, env.platform), env.deps);
  }
  function pcTag(env: TestEnv, name: string | undefined, over: Partial<CtxSpec>): Promise<{ content: string; ephemeral?: boolean }> {
    return route(makeContext({ command: 'pc', sub: 'tag', channelId: 'C1', userId: 'U1', values: name ? { name } : {}, ...over }, env.platform), env.deps);
  }
  function readSheet(env: TestEnv, over: Partial<CtxSpec>): string | null | undefined {
    return env.coc.checkCalls.at(-1)?.sheet?.name;
  }

  test('三张卡绑定到全局 / 场景 / 局，读取顺序为 局 > 场景 > 用户级 > 全局', async () => {
    const env = makeEnv();
    // 1) DM → 全局默认卡
    await pcNew(env, '全局卡', { guildId: null, channelId: 'D1' });
    await pcTag(env, '全局卡', { guildId: null, channelId: 'D1' });
    assert.equal(env.store.getBinding('global', '@global', 'U1'), '全局卡');

    // 2) 无局场景 C2 → 场景绑定
    await pcNew(env, '场景卡', { channelId: 'C2', parentChannelId: null });
    await pcTag(env, '场景卡', { channelId: 'C2', parentChannelId: null });
    assert.equal(env.store.getBinding('scene', 'C2', 'U1'), '场景卡');

    // 3) 有局场景 C1（局 #1）→ 局绑定
    await route(makeContext({ command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'U1', values: { name: '一', keeper: 'U1' } }, env.platform), env.deps);
    const t1 = env.store.getGame('G1', '#1')?.sceneThreadId ?? 'C1';
    await pcNew(env, '局卡', { channelId: t1, parentChannelId: 'C1' });
    await pcTag(env, '局卡', { channelId: t1, parentChannelId: 'C1' });
    assert.equal(env.store.getBinding('game', '#1', 'U1'), '局卡');

    // 读取：局场景 → 局卡
    await route(makeContext({ command: 'rc', channelId: t1, parentChannelId: 'C1', userId: 'U1', values: { text: '力量' } }, env.platform), env.deps);
    assert.equal(readSheet(env, {}), '局卡');

    // 场景 C2（无局）→ 场景卡
    await route(makeContext({ command: 'rc', channelId: 'C2', userId: 'U1', values: { text: '力量' } }, env.platform), env.deps);
    assert.equal(readSheet(env, {}), '场景卡');

    // 新场景 C3（无局、无场景绑定）→ **用户级常用卡**（最近一次 tag 的「局卡」，跨子区/跨频道持续）
    await route(makeContext({ command: 'rc', channelId: 'C3', userId: 'U1', values: { text: '力量' } }, env.platform), env.deps);
    assert.equal(readSheet(env, {}), '局卡', '用户级常用卡 = 最近一次 tag 的卡');
    assert.equal(env.store.getBinding('user', 'G1', 'U1'), '局卡');

    // 解绑局卡：局绑定与用户级常用卡一起清掉 → 回落到全局默认卡
    await pcTag(env, undefined, { channelId: t1, parentChannelId: 'C1' });
    assert.equal(env.store.getBinding('game', '#1', 'U1'), null);
    assert.equal(env.store.getBinding('user', 'G1', 'U1'), null, '解绑同时清掉常用卡');
    await route(makeContext({ command: 'rc', channelId: t1, parentChannelId: 'C1', userId: 'U1', values: { text: '力量' } }, env.platform), env.deps);
    assert.equal(readSheet(env, {}), '全局卡');
    await route(makeContext({ command: 'rc', channelId: 'C3', userId: 'U1', values: { text: '力量' } }, env.platform), env.deps);
    assert.equal(readSheet(env, {}), '全局卡', '常用卡清掉后，新场景也回到全局默认卡');
  });

  test('DM 里 tag 写全局绑定；/pc del 同时清绑定', async () => {
    const env = makeEnv();
    await pcNew(env, '卡A', { guildId: null, channelId: 'D1' });
    await pcTag(env, '卡A', { guildId: null, channelId: 'D1' });
    assert.equal(env.store.getBinding('global', '@global', 'U1'), '卡A');

    await route(makeContext({ command: 'pc', sub: 'del', guildId: null, channelId: 'D1', userId: 'U1', values: { name: '卡A' } }, env.platform), env.deps);
    assert.equal(env.store.getSheet('U1', '卡A'), null);
    assert.equal(env.store.getBinding('global', '@global', 'U1'), null);
  });
});

describe('T4 · /setcoc 生效顺序（局 > 场景 > 默认）', () => {
  test('场景房规 → 本局房规 → clr 逐级回落', async () => {
    const env = makeEnv();
    // 先在 C1 设场景房规（此时无局）
    await route(makeContext({ command: 'setcoc', sub: 'set', channelId: 'C1', userId: 'U1', values: { rule: 5 } }, env.platform), env.deps);
    assert.equal(env.store.getSceneRule('C1'), 5);

    // 就地开局（here:true），本局场景就是 C1，便于观察 局 > 场景
    await route(makeContext({ command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'U1', values: { name: '一', keeper: 'U1', here: true } }, env.platform), env.deps);
    const game = env.store.getGame('G1', '#1');
    assert.ok(game);
    assert.equal(game.sceneThreadId, null);
    const t1 = 'C1';

    // 开局后尚未设本局房规 → 场景房规 5 生效
    await route(makeContext({ command: 'rc', channelId: t1, userId: 'U1', values: { text: '力量' } }, env.platform), env.deps);
    assert.equal(env.coc.checkCalls.at(-1)?.rule, 5, '本局房规未设时回落到场景房规');

    await route(makeContext({ command: 'setcoc', sub: 'set', channelId: t1, userId: 'U1', values: { rule: 3 } }, env.platform), env.deps);
    assert.equal(env.store.getGameRule('#1', 'G1'), 3);
    assert.equal(env.store.getSceneRule(t1), 5, '有局时设置必须写局，不改场景房规');

    await route(makeContext({ command: 'rc', channelId: t1, userId: 'U1', values: { text: '力量' } }, env.platform), env.deps);
    assert.equal(env.coc.checkCalls.at(-1)?.rule, 3, '本局房规压过场景房规');

    // clr 本局 → 回落到场景房规 5
    const cleared = await route(makeContext({ command: 'setcoc', sub: 'clr', channelId: t1, userId: 'U1' }, env.platform), env.deps);
    assert.equal(env.store.getGameRule('#1', 'G1'), null);
    assert.ok(cleared.content.includes('场景房规'), cleared.content);
    await route(makeContext({ command: 'rc', channelId: t1, userId: 'U1', values: { text: '力量' } }, env.platform), env.deps);
    assert.equal(env.coc.checkCalls.at(-1)?.rule, 5);

    // 无局场景 clr → 默认 0
    await route(makeContext({ command: 'setcoc', sub: 'clr', channelId: 'C2', userId: 'U1' }, env.platform), env.deps);
    await route(makeContext({ command: 'rc', channelId: 'C2', userId: 'U1', values: { text: '力量' } }, env.platform), env.deps);
    assert.equal(env.coc.checkCalls.at(-1)?.rule, 0);
  });

  test('show / 直接调用显示生效房规及来源；非法编号被拒', async () => {
    const env = makeEnv();
    const bare = await route(makeContext({ command: 'setcoc', channelId: 'C9', userId: 'U1' }, env.platform), env.deps);
    assert.ok(bare.content.includes('0'));
    assert.ok(bare.content.includes('骰主默认规则'));

    const bad = await route(makeContext({ command: 'setcoc', sub: 'set', channelId: 'C9', userId: 'U1', values: { rule: 7 } }, env.platform), env.deps);
    assert.equal(bad.ephemeral, true);
    const none = await route(makeContext({ command: 'setcoc', sub: 'set', channelId: 'C9', userId: 'U1' }, env.platform), env.deps);
    assert.equal(none.ephemeral, true);
  });

  test('权限：有局时只有本局 KP / 管理员能改；无局场景人人可设', async () => {
    const env = makeEnv();
    await route(makeContext({ command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'KP1', values: { name: '一', keeper: 'KP1' } }, env.platform), env.deps);
    const t1 = env.store.getGame('G1', '#1')?.sceneThreadId ?? '';

    const denied = await route(makeContext({ command: 'setcoc', sub: 'set', channelId: t1, parentChannelId: 'C1', userId: 'U9', values: { rule: 2 } }, env.platform), env.deps);
    assert.equal(denied.ephemeral, true);
    assert.equal(env.store.getGameRule('#1', 'G1'), null);

    const byKeeper = await route(makeContext({ command: 'setcoc', sub: 'set', channelId: t1, parentChannelId: 'C1', userId: 'KP1', values: { rule: 2 } }, env.platform), env.deps);
    assert.notEqual(byKeeper.ephemeral, true);
    assert.equal(env.store.getGameRule('#1', 'G1'), 2);

    const scene = await route(makeContext({ command: 'setcoc', sub: 'set', channelId: 'C2', userId: 'U9', values: { rule: 4 } }, env.platform), env.deps);
    assert.notEqual(scene.ephemeral, true, '无局场景无权限门槛');
    assert.equal(env.store.getSceneRule('C2'), 4);
  });
});

describe('T4 · 跨服隔离（同一 #1 在两服互不影响）', () => {
  test('MemoryStore：房规与日志按 guild 隔离（走 handler）', async () => {
    const env = makeEnv();
    await route(makeContext({ command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'U1', guildId: 'G1', values: { name: '甲桌', keeper: 'U1' } }, env.platform), env.deps);
    await route(makeContext({ command: 'game', sub: 'start', channelId: 'C2', channelName: '跑团', userId: 'U2', guildId: 'G2', values: { name: '乙桌', keeper: 'U2' } }, env.platform), env.deps);

    assert.equal(env.store.getGame('G1', '#1')?.name, '甲桌');
    assert.equal(env.store.getGame('G2', '#1')?.name, '乙桌');

    const t1 = env.store.getGame('G1', '#1')?.sceneThreadId ?? '';
    const t2 = env.store.getGame('G2', '#1')?.sceneThreadId ?? '';
    await route(makeContext({ command: 'setcoc', sub: 'set', channelId: t1, parentChannelId: 'C1', userId: 'U1', guildId: 'G1', values: { rule: 3 } }, env.platform), env.deps);

    await route(makeContext({ command: 'rc', channelId: t2, parentChannelId: 'C2', userId: 'U2', guildId: 'G2', values: { text: '力量' } }, env.platform), env.deps);
    assert.equal(env.coc.checkCalls.at(-1)?.rule, 0, 'G2 的 #1 不得读到 G1 的房规');
    await route(makeContext({ command: 'rc', channelId: t1, parentChannelId: 'C1', userId: 'U1', guildId: 'G1', values: { text: '力量' } }, env.platform), env.deps);
    assert.equal(env.coc.checkCalls.at(-1)?.rule, 3);

    assert.equal(env.store.getGameRule('#1', 'G1'), 3);
    assert.equal(env.store.getGameRule('#1', 'G2'), null);

    const list1 = await route(makeContext({ command: 'log', sub: 'list', channelId: t1, parentChannelId: 'C1', userId: 'U1', guildId: 'G1' }, env.platform), env.deps);
    const list2 = await route(makeContext({ command: 'log', sub: 'list', channelId: t2, parentChannelId: 'C2', userId: 'U2', guildId: 'G2' }, env.platform), env.deps);
    assert.ok(list1.content.includes('甲桌'), list1.content);
    assert.ok(!list1.content.includes('乙桌'), 'G1 不得看到 G2 的日志');
    assert.ok(list2.content.includes('乙桌'), list2.content);
    assert.ok(!list2.content.includes('甲桌'));
  });

  test('jsonStore：房规 / 日志 / 暗骰登记按 guild 落盘隔离且可跨实例重读', async () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    const dir = mkdtempSync(join(TMP_ROOT, 'dcdice-verify-'));
    try {
      const store = createJsonStore({ dir });
      const env = makeEnv({ store });
      assert.equal(env.deps.store, store);

      await route(makeContext({ command: 'game', sub: 'start', channelId: 'C1', channelName: '跑团', userId: 'U1', guildId: 'G1', values: { name: '甲桌', keeper: 'U1' } }, env.platform), env.deps);
      await route(makeContext({ command: 'game', sub: 'start', channelId: 'C2', channelName: '跑团', userId: 'U2', guildId: 'G2', values: { name: '乙桌', keeper: 'U2' } }, env.platform), env.deps);
      const t1 = store.getGame('G1', '#1')?.sceneThreadId ?? '';
      const t2 = store.getGame('G2', '#1')?.sceneThreadId ?? '';
      await route(makeContext({ command: 'setcoc', sub: 'set', channelId: t1, parentChannelId: 'C1', userId: 'U1', guildId: 'G1', values: { rule: 6 } }, env.platform), env.deps);
      await route(makeContext({ command: 'rh', channelId: t1, parentChannelId: 'C1', userId: 'U1', guildId: 'G1', values: { thread: 'T9' } }, env.platform), env.deps);
      env.platform.threads.set('T9', { id: 'T9', parentId: 'C1', name: '登记', private: true });

      await store.flush();

      const reread = createJsonStore({ dir });
      assert.equal(reread.getGameRule('#1', 'G1'), 6);
      assert.equal(reread.getGameRule('#1', 'G2'), null, 'G2 的 #1 房规必须与 G1 隔离');
      assert.equal(reread.getGame('G1', '#1')?.name, '甲桌');
      assert.equal(reread.getGame('G2', '#1')?.name, '乙桌');
      assert.equal(reread.getRegisteredThread(t1), 'T9', '暗骰子区登记必须持久化');
      assert.equal(reread.getRegisteredThread(t2), null);
      assert.deepEqual(
        reread.listLogs({ gameId: '#1', channelId: '', guildId: 'G1' }).map((l) => l.guildId),
        ['G1'],
      );
      assert.deepEqual(
        reread.listLogs({ gameId: '#1', channelId: '', guildId: 'G2' }).map((l) => l.guildId),
        ['G2'],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
