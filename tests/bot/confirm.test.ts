/**
 * 破坏性命令的按钮二次确认 (docs §16.6): `/pc clr`、`/st clr`。
 *
 * 覆盖 6 类场景：首次不改数据 / 确认后生效 / 取消不生效 / 他人点击被拒 / 过期或重复点击被拒 /
 * custom_id 前缀正确。Run: node tests/bot/confirm.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, type ButtonInteraction } from 'discord.js';

import { handleButtonInteraction } from '../../src/bot/adapter.ts';
import { route } from '../../src/bot/router.ts';
import {
  CANCELLED_MESSAGE,
  CANCEL_ID_PREFIX,
  CONFIRM_ID_PREFIX,
  CONFIRM_TTL_MS,
  EXPIRED_MESSAGE,
  NOT_OWNER_MESSAGE,
  askConfirm,
  createPendingActions,
  handleButtonClick,
  parseConfirmCustomId,
} from '../../src/bot/confirm.ts';
import { makeContext, makeEnv, type CtxSpec, type TestEnv } from './fakes.ts';
import type { ApiButton, InteractionContext, PendingAction, ReplyPayload } from '../../src/contracts/bot.ts';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pcCtx(
  env: TestEnv,
  sub: string,
  values: Record<string, string | number | boolean> = {},
  overrides: Partial<CtxSpec> = {},
): InteractionContext {
  return makeContext({ command: 'pc', sub, channelId: 'C1', userId: 'U1', values, ...overrides }, env.platform);
}

function stCtx(env: TestEnv, text: string, overrides: Partial<CtxSpec> = {}): InteractionContext {
  return makeContext({ command: 'st', channelId: 'C1', userId: 'U1', values: { text }, ...overrides }, env.platform);
}

/** 回执行里的两个按钮，顺带断言"确实带了一行组件"。 */
function buttons(payload: ReplyPayload): ApiButton[] {
  const row = payload.components?.[0];
  assert.ok(row, `回执应带一行按钮，实际：${payload.content}`);
  assert.equal(row.type, 1);
  return row.components;
}

function click(button: ApiButton, env: TestEnv, userId = 'U1'): Promise<ReplyPayload> {
  return handleButtonClick(button.custom_id, userId, env.deps);
}

/** 一张带 2 项属性的卡（首张卡自动绑定到场景 C1）。 */
async function seedCard(env: TestEnv, name = '卡特'): Promise<void> {
  await route(pcCtx(env, 'new', { name }), env.deps);
  await route(stCtx(env, '力量:50 体质:55'), env.deps);
}

function pending(id: string, userId: string, expiresAt: number, label = 'x'): PendingAction {
  return { id, userId, expiresAt, run: async () => ({ content: `ran ${label}` }) };
}

/** 只保留 adapter 按钮分支用到的三个成员。 */
function fakeButton(customId: string, userId: string): {
  interaction: ButtonInteraction;
  updates: Record<string, unknown>[];
  followUps: Record<string, unknown>[];
} {
  const updates: Record<string, unknown>[] = [];
  const followUps: Record<string, unknown>[] = [];
  const interaction = {
    customId,
    user: { id: userId },
    update: async (options: Record<string, unknown>) => {
      updates.push(options);
    },
    followUp: async (options: Record<string, unknown>) => {
      followUps.push(options);
    },
  } as unknown as ButtonInteraction;
  return { interaction, updates, followUps };
}

// ---------------------------------------------------------------------------
// adapter 按钮分支
// ---------------------------------------------------------------------------

describe('adapter 按钮分支', () => {
  test('确认成功：interaction.update 回写结果并清空按钮行', async () => {
    const env = makeEnv();
    await seedCard(env);
    const first = await route(pcCtx(env, 'clr'), env.deps);
    const [confirm] = buttons(first);

    const { interaction, updates, followUps } = fakeButton(confirm.custom_id, 'U1');
    await handleButtonInteraction(interaction, env.deps);

    assert.equal(updates.length, 1);
    assert.equal(followUps.length, 0);
    assert.ok(String(updates[0].content).includes('已销毁 1 张角色卡'));
    assert.deepEqual(updates[0].components, []);
    assert.equal(env.store.listSheets('U1').length, 0);
  });

  test('非发起者：ephemeral followUp，不 update、不消费登记项', async () => {
    const env = makeEnv();
    await seedCard(env);
    const first = await route(pcCtx(env, 'clr'), env.deps);
    const [confirm] = buttons(first);

    const { interaction, updates, followUps } = fakeButton(confirm.custom_id, 'U2');
    await handleButtonInteraction(interaction, env.deps);

    assert.equal(updates.length, 0);
    assert.equal(followUps.length, 1);
    assert.equal(followUps[0].content, NOT_OWNER_MESSAGE);
    assert.equal(followUps[0].flags, MessageFlags.Ephemeral);
    assert.equal(env.confirmations.size(), 1);
    assert.equal(env.store.listSheets('U1').length, 1);
  });

  test('过期按钮：update 成"已过期"并清空按钮行', async () => {
    let clock = 100;
    const confirmations = createPendingActions({ ttlMs: 5, now: () => clock });
    const env = makeEnv({ confirmations });
    await route(pcCtx(env, 'new', { name: '卡特' }), env.deps);
    const first = await route(pcCtx(env, 'clr'), env.deps);
    const [confirm] = buttons(first);

    clock += 6;
    const { interaction, updates, followUps } = fakeButton(confirm.custom_id, 'U1');
    await handleButtonInteraction(interaction, env.deps);

    assert.equal(followUps.length, 0);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].content, EXPIRED_MESSAGE);
    assert.deepEqual(updates[0].components, []);
  });
});

// ---------------------------------------------------------------------------
// PendingActions 登记表
// ---------------------------------------------------------------------------

describe('createPendingActions', () => {
  test('默认 TTL 5 分钟；put/peek/take 取出即删', () => {
    let clock = 1_000_000;
    const registry = createPendingActions({ now: () => clock });
    registry.put(pending('a', 'U1', clock + CONFIRM_TTL_MS));

    assert.equal(registry.size(), 1);
    assert.equal(registry.peek('a')?.id, 'a');
    assert.equal(registry.size(), 1, 'peek 不消费');

    const taken = registry.take('a');
    assert.equal(taken?.id, 'a');
    assert.equal(registry.size(), 0);
    assert.equal(registry.take('a'), null, 'take 是取出即删，重复取出落空');
    assert.equal(registry.peek('a'), null);
  });

  test('sweep 清理过期项；put 时也会顺手清理；take/peek 对过期项返回 null', () => {
    let clock = 1_000_000;
    const registry = createPendingActions({ ttlMs: 10, now: () => clock });
    registry.put(pending('a', 'U1', clock + 10));
    registry.put(pending('b', 'U1', clock + 1_000));
    assert.equal(registry.size(), 2);

    clock += 11;
    assert.equal(registry.peek('a'), null, '过期项 peek 落空');
    assert.equal(registry.size(), 1, '过期项被顺手删掉');

    clock += 1_000;
    registry.put(pending('c', 'U1', clock + 10));
    assert.equal(registry.size(), 1, 'put 时 sweep 掉已过期的 b');

    registry.sweep(clock + 100);
    assert.equal(registry.size(), 0);
  });

  test('askConfirm 用登记表自己的时钟与 TTL 生成 expiresAt，并带一行两按钮', () => {
    let clock = 5_000;
    const confirmations = createPendingActions({ ttlMs: 30, now: () => clock });
    const env = makeEnv({ confirmations });

    const payload = askConfirm(env.deps, pcCtx(env, 'clr'), {
      summary: '确认一下',
      onConfirm: async () => ({ content: 'done' }),
    });
    assert.equal(payload.content, '确认一下');
    const [confirm, cancel] = buttons(payload);
    const id = confirm.custom_id.slice(CONFIRM_ID_PREFIX.length);
    assert.equal(confirmations.peek(id)?.expiresAt, clock + 30);
    assert.equal(cancel.custom_id, `${CANCEL_ID_PREFIX}${id}`);
  });
});

// ---------------------------------------------------------------------------
// ① /pc clr 首次不改数据
// ---------------------------------------------------------------------------

describe('/pc clr 二次确认', () => {
  test('①首次调用只列出将销毁的范围与卡名，不改动任何数据', async () => {
    const env = makeEnv();
    await route(pcCtx(env, 'new', { name: '卡特' }), env.deps);
    await route(pcCtx(env, 'new', { name: '安娜' }), env.deps);

    const first = await route(pcCtx(env, 'clr'), env.deps);

    assert.equal(env.store.listSheets('U1').length, 2, '首次绝不改数据');
    assert.equal(env.store.getBinding('scene', 'C1', 'U1'), '卡特', '首次不动绑定');
    assert.equal(env.confirmations.size(), 1, '登记了一个待确认动作');
    assert.notEqual(first.ephemeral, true);
    assert.ok(first.content.includes('2 张角色卡'), first.content);
    assert.ok(first.content.includes('卡特'), first.content);
    assert.ok(first.content.includes('安娜'), first.content);

    const [confirm, cancel] = buttons(first);
    assert.equal(confirm.style, 4, '确认按钮是 danger');
    assert.equal(confirm.label, '确认执行');
    assert.equal(cancel.style, 2);
    assert.equal(cancel.label, '取消');
  });

  test('②确认后数据被清空，且同一个按钮不能再次使用', async () => {
    const env = makeEnv();
    await route(pcCtx(env, 'new', { name: '卡特' }), env.deps);
    await route(pcCtx(env, 'new', { name: '安娜' }), env.deps);
    const first = await route(pcCtx(env, 'clr'), env.deps);
    const [confirm, cancel] = buttons(first);

    const done = await click(confirm, env);
    assert.notEqual(done.ephemeral, true);
    assert.ok(done.content.includes('已销毁 2 张角色卡'), done.content);
    assert.equal(env.store.listSheets('U1').length, 0);
    assert.equal(env.store.getBinding('scene', 'C1', 'U1'), null);
    assert.equal(env.confirmations.size(), 0, '确认后登记项被消费');

    const again = await click(confirm, env);
    assert.equal(again.content, EXPIRED_MESSAGE);
    assert.equal(env.store.listSheets('U1').length, 0);
    const staleCancel = await click(cancel, env);
    assert.equal(staleCancel.content, EXPIRED_MESSAGE, '同一 id 的按钮一起失效');
  });

  test('③取消后数据完全不变', async () => {
    const env = makeEnv();
    await seedCard(env);
    const first = await route(pcCtx(env, 'clr'), env.deps);
    const [confirm, cancel] = buttons(first);

    const cancelled = await click(cancel, env);
    assert.equal(cancelled.content, CANCELLED_MESSAGE);
    assert.equal(env.store.listSheets('U1').length, 1);
    assert.equal(env.store.getBinding('scene', 'C1', 'U1'), '卡特');
    assert.equal(Object.keys(env.store.getSheet('U1', '卡特')!.attrs).length, 2, '卡内属性也不动');
    assert.equal(env.confirmations.size(), 0);

    const after = await click(confirm, env);
    assert.equal(after.content, EXPIRED_MESSAGE);
  });

  test('④他人点击被拒，且不消费发起者的确认（发起者仍可确认）', async () => {
    const env = makeEnv();
    await seedCard(env);
    const first = await route(pcCtx(env, 'clr'), env.deps);
    const [confirm, cancel] = buttons(first);

    const intruder = await click(confirm, env, 'U2');
    assert.equal(intruder.ephemeral, true);
    assert.equal(intruder.content, NOT_OWNER_MESSAGE);
    assert.equal(env.store.listSheets('U1').length, 1, '他人点击不改数据');
    assert.equal(env.confirmations.size(), 1, '他人点击不得消费登记项');

    const cancelIntruder = await click(cancel, env, 'U2');
    assert.equal(cancelIntruder.ephemeral, true);
    assert.equal(cancelIntruder.content, NOT_OWNER_MESSAGE);
    assert.equal(env.confirmations.size(), 1);

    const owner = await click(confirm, env);
    assert.ok(owner.content.includes('已销毁 1 张角色卡'), owner.content);
    assert.equal(env.store.listSheets('U1').length, 0);
  });

  test('⑤过期后点击被拒且不改数据', async () => {
    let clock = 1_000_000;
    const confirmations = createPendingActions({ ttlMs: CONFIRM_TTL_MS, now: () => clock });
    const env = makeEnv({ confirmations });
    await seedCard(env);

    const first = await route(pcCtx(env, 'clr'), env.deps);
    const [confirm] = buttons(first);

    clock += CONFIRM_TTL_MS + 1;
    const late = await click(confirm, env);
    assert.equal(late.content, EXPIRED_MESSAGE);
    assert.equal(env.store.listSheets('U1').length, 1, '过期确认绝不执行');
    assert.equal(env.confirmations.size(), 0);
  });

  test('⑥custom_id 前缀正确，两个按钮共用同一个 id；未知前缀被当成过期', async () => {
    const env = makeEnv();
    await seedCard(env);
    const first = await route(pcCtx(env, 'clr'), env.deps);
    const [confirm, cancel] = buttons(first);

    assert.equal(confirm.type, 2);
    assert.ok(confirm.custom_id.startsWith(CONFIRM_ID_PREFIX), confirm.custom_id);
    assert.ok(cancel.custom_id.startsWith(CANCEL_ID_PREFIX), cancel.custom_id);
    const id = confirm.custom_id.slice(CONFIRM_ID_PREFIX.length);
    assert.equal(cancel.custom_id.slice(CANCEL_ID_PREFIX.length), id);
    assert.deepEqual(parseConfirmCustomId(confirm.custom_id), { kind: 'confirm', id });
    assert.deepEqual(parseConfirmCustomId(cancel.custom_id), { kind: 'cancel', id });
    assert.equal(parseConfirmCustomId('bogus:1'), null);
    assert.equal(parseConfirmCustomId('confirm:'), null);
    assert.equal(parseConfirmCustomId(''), null);

    assert.equal((await handleButtonClick('bogus:1', 'U1', env.deps)).content, EXPIRED_MESSAGE);
    assert.equal((await handleButtonClick('confirm:', 'U1', env.deps)).content, EXPIRED_MESSAGE);
    assert.equal(env.store.listSheets('U1').length, 1);
  });

  test('没有角色卡时不登记确认，直接说明无可销毁', async () => {
    const env = makeEnv();
    const reply = await route(pcCtx(env, 'clr'), env.deps);
    assert.equal(reply.components, undefined);
    assert.ok(reply.content.includes('没有可销毁'), reply.content);
    assert.equal(env.confirmations.size(), 0);
  });
});

// ---------------------------------------------------------------------------
// /st clr
// ---------------------------------------------------------------------------

describe('/st clr 二次确认', () => {
  test('①首次调用列出卡名与属性条数，不改动数据', async () => {
    const env = makeEnv();
    await seedCard(env);

    const first = await route(stCtx(env, 'clr'), env.deps);

    assert.equal(Object.keys(env.store.getSheet('U1', '卡特')!.attrs).length, 2, '首次绝不改数据');
    assert.equal(env.confirmations.size(), 1);
    assert.notEqual(first.ephemeral, true);
    assert.ok(first.content.includes('卡特'), first.content);
    assert.ok(first.content.includes('属性（2 项）'), first.content);

    const [confirm, cancel] = buttons(first);
    assert.equal(confirm.style, 4);
    assert.equal(confirm.label, '确认执行');
    assert.equal(cancel.style, 2);
    assert.ok(confirm.custom_id.startsWith(CONFIRM_ID_PREFIX));
    assert.ok(cancel.custom_id.startsWith(CANCEL_ID_PREFIX));
  });

  test('②确认后属性与表达式被清空，按钮失效', async () => {
    const env = makeEnv();
    await seedCard(env);
    const first = await route(stCtx(env, 'clr'), env.deps);
    const [confirm] = buttons(first);

    const done = await click(confirm, env);
    assert.notEqual(done.ephemeral, true);
    assert.ok(done.content.includes('已清空角色卡'), done.content);
    const sheet = env.store.getSheet('U1', '卡特')!;
    assert.deepEqual(sheet.attrs, {});
    assert.deepEqual(sheet.exprs, {});
    assert.equal(env.confirmations.size(), 0);

    assert.equal((await click(confirm, env)).content, EXPIRED_MESSAGE);
  });

  test('③取消后属性不变', async () => {
    const env = makeEnv();
    await seedCard(env);
    const first = await route(stCtx(env, 'clr'), env.deps);
    const [confirm, cancel] = buttons(first);

    const cancelled = await click(cancel, env);
    assert.equal(cancelled.content, CANCELLED_MESSAGE);
    assert.equal(env.store.getSheet('U1', '卡特')!.attrs['力量'], '50');
    assert.equal(env.store.getSheet('U1', '卡特')!.attrs['体质'], '55');
    assert.equal((await click(confirm, env)).content, EXPIRED_MESSAGE);
  });

  test('④他人点击被拒，发起者仍可确认', async () => {
    const env = makeEnv();
    await seedCard(env);
    const first = await route(stCtx(env, 'clr'), env.deps);
    const [confirm] = buttons(first);

    const intruder = await click(confirm, env, 'U2');
    assert.equal(intruder.ephemeral, true);
    assert.equal(intruder.content, NOT_OWNER_MESSAGE);
    assert.equal(Object.keys(env.store.getSheet('U1', '卡特')!.attrs).length, 2);
    assert.equal(env.confirmations.size(), 1);

    const owner = await click(confirm, env);
    assert.ok(owner.content.includes('已清空角色卡'), owner.content);
    assert.deepEqual(env.store.getSheet('U1', '卡特')!.attrs, {});
  });

  test('⑤过期后点击被拒且属性不变', async () => {
    let clock = 10;
    const confirmations = createPendingActions({ ttlMs: 60, now: () => clock });
    const env = makeEnv({ confirmations });
    await seedCard(env);

    const first = await route(stCtx(env, 'clr'), env.deps);
    const [confirm] = buttons(first);

    clock += 61;
    const late = await click(confirm, env);
    assert.equal(late.content, EXPIRED_MESSAGE);
    assert.equal(Object.keys(env.store.getSheet('U1', '卡特')!.attrs).length, 2);
  });

  test('⑥无卡时直接提示无卡可清，不会顺手新建卡', async () => {
    const env = makeEnv();
    const reply = await route(stCtx(env, 'clr'), env.deps);
    assert.equal(reply.ephemeral, undefined);
    assert.equal(reply.components, undefined);
    assert.ok(reply.content.includes('没有可清空的属性'), reply.content);
    assert.equal(env.store.listSheets('U1').length, 0, '/st clr 不得触发 adoptSheet 建卡');
    assert.equal(env.confirmations.size(), 0);
  });

  test('单张未绑定卡也可确认清空，且首次不写入绑定', async () => {
    const env = makeEnv();
    await seedCard(env);
    await route(pcCtx(env, 'tag'), env.deps); // 解绑
    assert.equal(env.store.getBinding('scene', 'C1', 'U1'), null);

    const first = await route(stCtx(env, 'clr'), env.deps);
    assert.equal(env.store.getBinding('scene', 'C1', 'U1'), null, '首次不改绑定');
    const [confirm] = buttons(first);

    await click(confirm, env);
    assert.deepEqual(env.store.getSheet('U1', '卡特')!.attrs, {});
  });

  test('粘贴带前导 `.st` 的整行命令：`.st clr` 同样走二次确认，不会直接清卡', async () => {
    const env = makeEnv();
    await seedCard(env);

    const first = await route(stCtx(env, '.st clr'), env.deps);
    const [confirm] = buttons(first);
    assert.equal(confirm.style, 4, '必须仍然是「确认执行」按钮流程');
    assert.equal(env.confirmations.size(), 1);
    assert.equal(Object.keys(env.store.getSheet('U1', '卡特')!.attrs).length, 2, '首次绝不改数据');

    const done = await click(confirm, env);
    assert.ok(done.content.includes('已清空角色卡'), done.content);
    assert.deepEqual(env.store.getSheet('U1', '卡特')!.attrs, {});
  });

  test('粘贴带前导 `.st` 的录入命令：`.st 力量40体质55` 正常落卡', async () => {
    const env = makeEnv();
    await route(pcCtx(env, 'new', { name: '卡特' }), env.deps);
    const reply = await route(stCtx(env, '.st 力量:40 体质:55'), env.deps);
    assert.ok(!reply.content.includes('无法解析'), reply.content);
    assert.deepEqual(env.store.getSheet('U1', '卡特')!.attrs, { 力量: '40', 体质: '55' });
  });

  test('多张卡且无绑定时不猜卡，提示先 /pc tag', async () => {
    const env = makeEnv();
    await route(pcCtx(env, 'new', { name: '卡特' }), env.deps);
    await route(pcCtx(env, 'new', { name: '安娜' }), env.deps);
    await route(pcCtx(env, 'tag'), env.deps);

    const reply = await route(stCtx(env, 'clr'), env.deps);
    assert.equal(reply.ephemeral, true);
    assert.ok(reply.content.includes('/pc tag'), reply.content);
    assert.equal(env.store.listSheets('U1').length, 2);
    assert.equal(env.confirmations.size(), 0);
  });

  test('`clear` 不是 clr：仍走普通属性解析', async () => {
    const env = makeEnv();
    await seedCard(env);
    const reply = await route(stCtx(env, 'clear'), env.deps);
    assert.equal(reply.components, undefined);
    assert.equal(Object.keys(env.store.getSheet('U1', '卡特')!.attrs).length, 2);
  });
});
