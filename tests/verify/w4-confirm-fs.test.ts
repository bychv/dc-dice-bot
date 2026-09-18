/**
 * W4 独立验证 · task-5 二次确认（**真实 jsonStore 落盘对比**）
 *
 * 与实现者的 tests/bot/confirm.test.ts 不同，这里全程使用**真实** jsonStore / CoC 引擎 / Dice 引擎，
 * 直接对比 `sheets.json`、`bindings.json` 在 `/pc clr`、`/st clr` 首次调用前后的**磁盘字节**，
 * 而不是只看回执或内存对象。另附 adapter 按钮分支的 fake interaction 断言，以及 main.ts /
 * fakes.ts 的 `HandlerDeps.confirmations` 注入核对。
 *
 * Run: node tests/verify/w4-confirm-fs.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ButtonInteraction } from 'discord.js';

import {
  CANCEL_ID_PREFIX,
  CANCELLED_MESSAGE,
  CONFIRM_ID_PREFIX,
  EXPIRED_MESSAGE,
  NOT_OWNER_MESSAGE,
  askConfirm,
  createPendingActions,
  handleButtonClick,
} from '../../src/bot/confirm.ts';
import { handleButtonInteraction } from '../../src/bot/adapter.ts';
import { route } from '../../src/bot/router.ts';
import { createCocRules } from '../../src/coc/index.ts';
import type { HandlerDeps, InteractionContext, PendingActions, ReplyPayload } from '../../src/contracts/bot.ts';
import type { BotStore } from '../../src/contracts/store.ts';
import { createDiceEngine, createMathRng } from '../../src/dice/index.ts';
import { createJsonStoreWithExtras } from '../../src/store/jsonStore.ts';
import { FakePlatform, makeContext } from '../bot/fakes.ts';

const TMP_ROOT = fileURLToPath(new URL('../.tmp/', import.meta.url));
const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const TESTS = fileURLToPath(new URL('..', import.meta.url));

function tempDir(label: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TMP_ROOT, `w4-confirm-${label}-`));
}

interface RealEnv {
  deps: HandlerDeps;
  store: BotStore;
  dir: string;
  confirmations: PendingActions;
}

const FROZEN_NOW = new Date('2026-01-05T21:30:00.000Z');

/** 真实 store + 真实 coc/dice 引擎；只有 Platform 是 fake（按钮确认不碰平台）。 */
function realEnv(label: string, confirmations?: PendingActions): RealEnv {
  const dir = tempDir(label);
  const store = createJsonStoreWithExtras({ dir });
  const dice = createDiceEngine();
  const registry = confirmations ?? createPendingActions();
  const deps: HandlerDeps = {
    store,
    dice,
    coc: createCocRules(dice),
    rng: createMathRng(),
    platform: new FakePlatform(),
    confirmations: registry,
    now: () => FROZEN_NOW,
  };
  return { deps, store, dir, confirmations: registry };
}

function pcCtx(
  command: string,
  values: Record<string, string | number | boolean> = {},
  overrides: Partial<{ userId: string; sub: string | null; channelId: string }> = {},
): InteractionContext {
  return makeContext({
    command,
    sub: overrides.sub === undefined ? (command === 'pc' ? 'clr' : null) : overrides.sub,
    channelId: overrides.channelId ?? 'C1',
    userId: overrides.userId ?? 'U1',
    values,
  });
}

/** 目录内容快照（含 .tmp 残留），用于证明"一个字节都没动"。 */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    out[name] = readFileSync(join(dir, name), 'utf8');
  }
  return out;
}

async function flush(store: BotStore): Promise<void> {
  await store.flush();
}

/** 用同一目录重开一个 store，证明"磁盘上的持久数据"没变（而不是只有内存对象没变）。 */
function reopen(dir: string): BotStore {
  return createJsonStoreWithExtras({ dir });
}

function buttons(payload: ReplyPayload) {
  const row = payload.components?.[0];
  assert.ok(row, `回执应带一行组件：${payload.content}`);
  assert.equal(row.type, 1);
  assert.equal(row.components.length, 2);
  return { row, confirm: row.components[0], cancel: row.components[1] };
}

async function seedTwoCards(env: RealEnv): Promise<void> {
  await route(pcCtx('pc', { name: '卡特' }, { sub: 'new' }), env.deps);
  await route(pcCtx('pc', { name: '安娜' }, { sub: 'new' }), env.deps);
  assert.equal(env.store.listSheets('U1').length, 2);
}

async function seedSt(env: RealEnv): Promise<void> {
  await route(pcCtx('pc', { name: '卡特' }, { sub: 'new' }), env.deps);
  const st = await route(pcCtx('st', { text: '力量:50 体质:55' }, { sub: null }), env.deps);
  assert.notEqual(st.ephemeral, true, `真实 coc 应接受 /st：${st.content}`);
}

// ---------------------------------------------------------------------------
// ① 首次调用：真实磁盘字节不变
// ---------------------------------------------------------------------------

describe('W4 · /pc clr 首次调用不落盘（真实 jsonStore）', () => {
  test('磁盘快照逐字节相等，重开 store 仍见 2 张卡与场景绑定', async () => {
    const env = realEnv('pc-first');
    await seedTwoCards(env);
    await flush(env.store);
    const before = snapshot(env.dir);
    assert.ok(Object.keys(before).includes('sheets.json'), '前置条件：sheets.json 已落盘');
    assert.ok(Object.keys(before).includes('bindings.json'), '前置条件：bindings.json 已落盘');

    const reply = await route(pcCtx('pc', {}, { sub: 'clr' }), env.deps);

    await flush(env.store);
    assert.deepEqual(snapshot(env.dir), before, '/pc clr 首次调用不得改动任何磁盘字节');

    const reopened = reopen(env.dir);
    assert.equal(reopened.listSheets('U1').length, 2, '重开后仍是 2 张卡');
    assert.equal(reopened.getBinding('scene', 'C1', 'U1'), '卡特', '场景绑定不动');
    assert.equal(env.confirmations.size(), 1, '登记了一个待确认动作');
    assert.ok(reply.content.includes('2 张角色卡'), reply.content);
  });

  test('回执组件结构：type=1 行 / 两个 type=2 按钮 / confirm: 与 cancel: 前缀 / danger 样式', async () => {
    const env = realEnv('pc-components');
    await seedTwoCards(env);
    const reply = await route(pcCtx('pc', {}, { sub: 'clr' }), env.deps);

    const { confirm, cancel } = buttons(reply);
    assert.equal(confirm.type, 2);
    assert.equal(confirm.style, 4, '确认按钮必须是 danger(4)');
    assert.equal(cancel.type, 2);
    assert.equal(cancel.style, 2, '取消按钮必须是 secondary(2)');
    assert.ok(confirm.custom_id.startsWith(CONFIRM_ID_PREFIX), confirm.custom_id);
    assert.ok(cancel.custom_id.startsWith(CANCEL_ID_PREFIX), cancel.custom_id);
    const id = confirm.custom_id.slice(CONFIRM_ID_PREFIX.length);
    assert.equal(cancel.custom_id.slice(CANCEL_ID_PREFIX.length), id, '两个按钮共用同一个一次性 id');
    assert.ok(id.length > 0);
  });
});

describe('W4 · /st clr 首次调用不落盘（真实 jsonStore）', () => {
  test('磁盘快照逐字节相等，属性 2 项原样保留', async () => {
    const env = realEnv('st-first');
    await seedSt(env);
    await flush(env.store);
    const before = snapshot(env.dir);

    const reply = await route(pcCtx('st', { text: 'clr' }, { sub: null }), env.deps);

    await flush(env.store);
    assert.deepEqual(snapshot(env.dir), before, '/st clr 首次调用不得改动任何磁盘字节');

    const card = reopen(env.dir).getSheet('U1', '卡特');
    assert.ok(card, '重开后卡还在');
    assert.deepEqual(card.attrs, { 力量: '50', 体质: '55' });
    assert.equal(env.confirmations.size(), 1);
    assert.ok(reply.content.includes('将清空角色卡「卡特」'), reply.content);
    buttons(reply);
  });
});

// ---------------------------------------------------------------------------
// ② 确认 / 取消 / 重复点击 / 过期 / 他人
// ---------------------------------------------------------------------------

describe('W4 · 确认与取消的真实落盘效果', () => {
  test('确认后恰好执行一次：磁盘上 0 张卡、绑定被清、同一按钮第二次落空', async () => {
    const env = realEnv('pc-confirm');
    await seedTwoCards(env);
    const reply = await route(pcCtx('pc', {}, { sub: 'clr' }), env.deps);
    const { confirm, cancel } = buttons(reply);

    const done = await handleButtonClick(confirm.custom_id, 'U1', env.deps);
    assert.ok(done.content.includes('已销毁 2 张角色卡'), done.content);
    assert.equal(env.confirmations.size(), 0, '确认后登记项被消费');
    await flush(env.store);
    assert.equal(reopen(env.dir).listSheets('U1').length, 0, '磁盘上确实清空');
    assert.equal(reopen(env.dir).getBinding('scene', 'C1', 'U1'), null, '磁盘上绑定被清');

    const again = await handleButtonClick(confirm.custom_id, 'U1', env.deps);
    assert.equal(again.content, EXPIRED_MESSAGE, '重复点击同一确认按钮必须落空');
    assert.equal(env.confirmations.size(), 0);
    assert.equal(reopen(env.dir).listSheets('U1').length, 0, '重复点击不得造成第二次执行');

    const staleCancel = await handleButtonClick(cancel.custom_id, 'U1', env.deps);
    assert.equal(staleCancel.content, EXPIRED_MESSAGE, '同一 id 的取消按钮也一起失效');
  });

  test('并发双点击只执行一次（take 同步消费）', async () => {
    const env = realEnv('pc-race');
    let runs = 0;
    const payload = askConfirm(env.deps, pcCtx('pc', {}, { sub: 'clr' }), {
      summary: '并发确认',
      onConfirm: async () => {
        runs += 1;
        return { content: `run#${runs}` };
      },
    });
    const { confirm } = buttons(payload);

    const [a, b] = await Promise.all([
      handleButtonClick(confirm.custom_id, 'U1', env.deps),
      handleButtonClick(confirm.custom_id, 'U1', env.deps),
    ]);
    assert.equal(runs, 1, '并发双点击必须只跑一次 onConfirm');
    const contents = [a.content, b.content].sort();
    assert.equal(contents[0], 'run#1');
    assert.equal(contents[1], EXPIRED_MESSAGE);
  });

  test('取消：磁盘字节不变，之后确认按钮也失效', async () => {
    const env = realEnv('pc-cancel');
    await seedSt(env);
    await flush(env.store);
    const before = snapshot(env.dir);

    const first = await route(pcCtx('pc', {}, { sub: 'clr' }), env.deps);
    const { confirm, cancel } = buttons(first);
    const cancelled = await handleButtonClick(cancel.custom_id, 'U1', env.deps);
    assert.equal(cancelled.content, CANCELLED_MESSAGE);

    await flush(env.store);
    assert.deepEqual(snapshot(env.dir), before, '取消不得改动磁盘');
    assert.equal(env.confirmations.size(), 0, '取消消费掉登记项');
    assert.equal((await handleButtonClick(confirm.custom_id, 'U1', env.deps)).content, EXPIRED_MESSAGE);
  });

  test('非发起者被拒：ephemeral、不落盘、不消费登记项，发起者仍可确认', async () => {
    const env = realEnv('pc-owner');
    await seedTwoCards(env);
    await flush(env.store);
    const before = snapshot(env.dir);

    const first = await route(pcCtx('pc', {}, { sub: 'clr' }), env.deps);
    const { confirm, cancel } = buttons(first);

    const intruder = await handleButtonClick(confirm.custom_id, 'U2', env.deps);
    assert.equal(intruder.ephemeral, true);
    assert.equal(intruder.content, NOT_OWNER_MESSAGE);
    assert.equal((await handleButtonClick(cancel.custom_id, 'U2', env.deps)).content, NOT_OWNER_MESSAGE);

    await flush(env.store);
    assert.deepEqual(snapshot(env.dir), before, '他人点击不得改动磁盘');
    assert.equal(env.confirmations.size(), 1, '他人点击不得消费登记项');

    const owner = await handleButtonClick(confirm.custom_id, 'U1', env.deps);
    assert.ok(owner.content.includes('已销毁 2 张角色卡'), owner.content);
    await flush(env.store);
    assert.equal(reopen(env.dir).listSheets('U1').length, 0);
  });

  test('超过 5 分钟（注入时钟）被拒且不落盘', async () => {
    let clock = 1_700_000_000_000;
    const registry = createPendingActions({ ttlMs: 5 * 60 * 1000, now: () => clock });
    const env = realEnv('pc-expire', registry);
    await seedSt(env);
    await flush(env.store);
    const before = snapshot(env.dir);

    const first = await route(pcCtx('pc', {}, { sub: 'clr' }), env.deps);
    const { confirm } = buttons(first);

    clock += 5 * 60 * 1000 + 1;
    const late = await handleButtonClick(confirm.custom_id, 'U1', env.deps);
    assert.equal(late.content, EXPIRED_MESSAGE);
    await flush(env.store);
    assert.deepEqual(snapshot(env.dir), before, '过期确认不得落盘');
    assert.equal(env.confirmations.size(), 0, '过期项被顺手清掉');
  });

  test('/st clr 确认：真实 coc 引擎清空 attrs/exprs 并落盘', async () => {
    const env = realEnv('st-confirm');
    await seedSt(env);
    const first = await route(pcCtx('st', { text: 'clr' }, { sub: null }), env.deps);
    const { confirm } = buttons(first);

    const done = await handleButtonClick(confirm.custom_id, 'U1', env.deps);
    assert.notEqual(done.ephemeral, true, done.content);
    await flush(env.store);
    const card = reopen(env.dir).getSheet('U1', '卡特');
    assert.ok(card);
    assert.deepEqual(card.attrs, {}, '磁盘上属性被清空');
    assert.deepEqual(card.exprs, {});
    assert.equal(env.confirmations.size(), 0);
  });
});

// ---------------------------------------------------------------------------
// ③ adapter 按钮分支真的接线
// ---------------------------------------------------------------------------

interface FakeButton {
  interaction: ButtonInteraction;
  updates: Record<string, unknown>[];
  followUps: Record<string, unknown>[];
}

function fakeButton(customId: string, userId: string): FakeButton {
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

describe('W4 · adapter 按钮分支（fake interaction + 源码接线）', () => {
  test('确认：interaction.update 回写结果并清空按钮行，真实 store 生效', async () => {
    const env = realEnv('adapter-confirm');
    await seedTwoCards(env);
    const first = await route(pcCtx('pc', {}, { sub: 'clr' }), env.deps);
    const { confirm } = buttons(first);

    const { interaction, updates, followUps } = fakeButton(confirm.custom_id, 'U1');
    await handleButtonInteraction(interaction, env.deps);

    assert.equal(updates.length, 1);
    assert.equal(followUps.length, 0);
    assert.deepEqual(updates[0].components, [], '按钮行必须清空');
    assert.ok(String(updates[0].content).includes('已销毁 2 张角色卡'));
    assert.equal(reopen(env.dir).listSheets('U1').length, 0);
  });

  test('非发起者：ephemeral followUp，原按钮行不动', async () => {
    const env = realEnv('adapter-owner');
    await seedTwoCards(env);
    const first = await route(pcCtx('pc', {}, { sub: 'clr' }), env.deps);
    const { confirm } = buttons(first);

    const { interaction, updates, followUps } = fakeButton(confirm.custom_id, 'U2');
    await handleButtonInteraction(interaction, env.deps);

    assert.equal(updates.length, 0, '不得 update 原回执（否则发起者就没法确认了）');
    assert.equal(followUps.length, 1);
    assert.equal(followUps[0].content, NOT_OWNER_MESSAGE);
    assert.equal(env.confirmations.size(), 1);
  });

  test('main.ts 真的把 interaction.isButton() 接到 handleButtonInteraction 并注入 confirmations', () => {
    const main = readFileSync(join(SRC, 'bot', 'main.ts'), 'utf8');
    assert.match(main, /interaction\.isButton\(\)/, 'main.ts 必须有 isButton 分支');
    assert.match(main, /handleButtonInteraction\(interaction, deps\)/, '按钮分支必须调用 adapter 的按钮处理');
    assert.match(main, /confirmations:\s*createPendingActions\(\)/, 'main.ts 必须注入 confirmations');
    assert.match(main, /from '\.\/confirm\.ts'/, 'createPendingActions 必须来自 confirm.ts');
    // 分支必须排在 chat input 分支之前（否则按钮会被 isChatInputCommand 挡掉）
    assert.ok(
      main.indexOf('interaction.isButton()') < main.indexOf('interaction.isChatInputCommand()'),
      'isButton 分支必须在 isChatInputCommand 之前 return',
    );
  });

  test('tests/bot/fakes.ts 的 HandlerDeps 也注入了 confirmations', () => {
    const fakes = readFileSync(join(TESTS, 'bot', 'fakes.ts'), 'utf8');
    assert.match(fakes, /platform,\s*\n\s*confirmations,/, 'makeEnv 的 deps 字面量必须包含 confirmations');
    assert.match(fakes, /overrides\.confirmations \?\? createPendingActions\(\)/);
  });
});
