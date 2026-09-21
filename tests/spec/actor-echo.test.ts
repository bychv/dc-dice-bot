/**
 * 回执统一回显使用者（`【角色卡名/称呼/显示名】`）——所有指令 + 按钮。
 *
 * 需求：斜杠命令**不在频道里留下玩家发言**，日志里只有骰娘回执；回执带上使用者后，
 * 日志（以及频道里的读者）都能看出"这条是谁发的"。
 *
 * 落点：前缀在**回执出口**（`adapter.ts` 的 `handleInteraction` / `handleButtonInteraction`）统一加，
 * 所以 handler 自己的 `route()` 输出是**不带前缀**的原文（测试直接调 route 时不会看到前缀）。
 *
 * Run: node tests/spec/actor-echo.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { actorEcho, actorLabel } from '../../src/bot/handlers/context.ts';
import { route } from '../../src/bot/router.ts';
import { createPendingActions } from '../../src/bot/confirm.ts';
import { createCocRules } from '../../src/coc/index.ts';
import type { HandlerDeps, InteractionContext } from '../../src/contracts/bot.ts';
import type { BotStore } from '../../src/contracts/store.ts';
import { createDiceEngine, createMathRng } from '../../src/dice/index.ts';
import { createJsonStoreWithExtras } from '../../src/store/jsonStore.ts';
import { FakePlatform, makeContext, type CtxSpec } from '../bot/fakes.ts';

const TMP_ROOT = fileURLToPath(new URL('../.tmp/', import.meta.url));
const FIXED_NOW = () => new Date('2026-09-20T01:30:00.000Z');

interface Env {
  deps: HandlerDeps;
  store: BotStore;
  platform: FakePlatform;
}

function makeEnv(label: string): Env {
  mkdirSync(TMP_ROOT, { recursive: true });
  const store = createJsonStoreWithExtras({ dir: mkdtempSync(join(TMP_ROOT, `scope-echo-${label}-`)) });
  const dice = createDiceEngine();
  const rng = createMathRng();
  const platform = new FakePlatform();
  const deps: HandlerDeps = {
    store,
    dice,
    coc: createCocRules(dice, rng),
    rng,
    platform,
    confirmations: createPendingActions(),
    now: FIXED_NOW,
  };
  return { deps, store, platform };
}

function ctx(env: Env, spec: Partial<CtxSpec> & { command: string }): InteractionContext {
  return makeContext({ guildId: 'G1', channelId: 'C1', userId: 'U1', displayName: '甲', ...spec }, env.platform);
}

/** 模拟回执出口：route 之后统一加前缀（真实实现见 adapter）。 */
function echoed(env: Env, context: InteractionContext, content: string): string {
  return actorEcho(env.store, context, context.displayName, content);
}

describe('回执统一回显使用者', () => {
  test('没绑卡 → 用 Discord 显示名；绑卡后 → 用角色卡名', async () => {
    const env = makeEnv('label');
    const before = ctx(env, { command: 'pc', sub: 'list' });
    const plain = await route(before, env.deps);
    assert.equal(echoed(env, before, plain.content).startsWith('【甲】'), true, plain.content);

    // 建卡并绑定 → 之后用卡名
    await route(ctx(env, { command: 'pc', sub: 'new', values: { name: '卡特' } }), env.deps);
    await route(ctx(env, { command: 'pc', sub: 'tag', values: { name: '卡特' } }), env.deps);
    const after = ctx(env, { command: 'pc', sub: 'list' });
    const listed = await route(after, env.deps);
    assert.equal(actorLabel(after, env.deps), '卡特');
    assert.equal(echoed(env, after, listed.content).startsWith('【卡特】'), true, listed.content);
  });

  test('常见指令的回执都会带上前缀（且只带一层）', async () => {
    const env = makeEnv('commands');
    await route(ctx(env, { command: 'pc', sub: 'new', values: { name: '卡特' } }), env.deps);
    await route(ctx(env, { command: 'pc', sub: 'tag', values: { name: '卡特' } }), env.deps);

    const cases: Array<{ command: string; spec?: Partial<CtxSpec>; values?: Record<string, string> }> = [
      { command: 'pc', spec: { sub: 'list' } },
      { command: 'pc', spec: { sub: 'show' } },
      { command: 'st', values: { text: '闪避:50' } },
      { command: 'rc', values: { text: '闪避' } },
      { command: 'ra', values: { text: 'p1 闪避' } },
      { command: 'r', values: { text: '1d100' } },
      { command: 'sc', values: { text: '0/1 60' } },
      { command: 'en', values: { text: '闪避 50' } },
      { command: 'log', spec: { sub: 'list' } },
      { command: 'game', spec: { sub: 'list' } },
      { command: 'setcoc' },
      { command: 'ti' },
      { command: 'help' },
    ];
    for (const item of cases) {
      const context = ctx(env, {
        command: item.command,
        ...(item.spec ?? {}),
        values: item.values ?? {},
      } as Partial<CtxSpec> & { command: string });
      const payload = await route(context, env.deps);
      const content = echoed(env, context, payload.content);
      assert.ok(content.startsWith('【卡特】'), `${item.command} 回执应带使用者：${content.slice(0, 60)}`);
      // 只允许开头那一个前缀（handler 自己不能再加，否则会叠两层）
      assert.equal(content.indexOf('【', 1) === content.indexOf('【') || !content.slice(1).startsWith('【'), true,
        `${item.command} 前缀叠加了：${content.slice(0, 60)}`);
    }
  });

  test('幂等：已经带【】的内容不再叠加', () => {
    const env = makeEnv('idempotent');
    const context = ctx(env, { command: 'rc' });
    assert.equal(actorEcho(env.store, context, '甲', '【已有】正文'), '【已有】正文');
    assert.equal(actorEcho(env.store, context, '甲', '正文'), '【甲】正文');
  });
});
