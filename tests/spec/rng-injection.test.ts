/**
 * 随机数注入的回归测试：**所有随机路径都必须走注入的 `Rng`**。
 *
 * 背景（本轮审计发现）：`createCocRules()` 以前内部自建了一个 `Math.random` 的 Rng 给 `runApplySt` 用，
 * 于是 `/st hp-1D6` 这类骰式**绕过**了 `HandlerDeps.rng` —— 随机性没问题，但测试无法确定化、
 * 也违反契约「每个随机路径都接收 Rng」。现在改为工厂注入，`main.ts` 传 `deps.rng`。
 *
 * Run: node tests/spec/rng-injection.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { route } from '../../src/bot/router.ts';
import { createCocRules } from '../../src/coc/index.ts';
import type { HandlerDeps, InteractionContext } from '../../src/contracts/bot.ts';
import type { Rng } from '../../src/contracts/rng.ts';
import { createDiceEngine } from '../../src/dice/index.ts';
import { createJsonStoreWithExtras } from '../../src/store/jsonStore.ts';
import { createPendingActions } from '../../src/bot/confirm.ts';
import { FakePlatform, makeContext } from '../bot/fakes.ts';

const TMP_ROOT = fileURLToPath(new URL('../.tmp/', import.meta.url));

function tempDir(label: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TMP_ROOT, `rng-inject-${label}-`));
}

/** 固定 RNG：`int()` 永远返回同一个值，用来证明"注入的 Rng 真的被用到了"。 */
function fixedRng(value: number): Rng {
  return { int: () => value };
}

interface Env {
  deps: HandlerDeps;
  store: ReturnType<typeof createJsonStoreWithExtras>;
  platform: FakePlatform;
}

function makeEnv(label: string, rng: Rng): Env {
  const store = createJsonStoreWithExtras({ dir: tempDir(label) });
  const dice = createDiceEngine();
  const platform = new FakePlatform();
  const deps: HandlerDeps = {
    store,
    dice,
    coc: createCocRules(dice, rng),
    rng,
    platform,
    confirmations: createPendingActions(),
    now: () => new Date('2026-09-19T00:00:00.000Z'),
  };
  return { deps, store, platform };
}

function stCtx(env: Env, text: string): InteractionContext {
  return makeContext({ command: 'st', channelId: 'C1', userId: 'U1', values: { text } }, env.platform);
}

function cardName(env: Env): string {
  return env.store.listSheets('U1')[0]!.name;
}

describe('/st 里的骰式必须走注入的 Rng', () => {
  test('固定 Rng 时 `hp-1D6` 每次减同一个值', async () => {
    const env = makeEnv('hp', fixedRng(4));
    await route(stCtx(env, 'hp:10'), env.deps);

    const results: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      await route(stCtx(env, 'hp-1D6'), env.deps);
      results.push(env.store.getSheet('U1', cardName(env))!.attrs['生命']!);
    }
    assert.deepEqual(results, ['6', '2', '-2', '-6', '-10'], `每次应固定减 4，实际 ${results.join(',')}`);
  });

  test('`+` 方向的骰式同理（san+1D6 用注入值）', async () => {
    const env = makeEnv('san', fixedRng(3));
    await route(stCtx(env, '理智:50'), env.deps);
    await route(stCtx(env, 'san+1D6'), env.deps);
    assert.equal(env.store.getSheet('U1', cardName(env))!.attrs['理智'], '53');
  });

  test('不注入 rng 时退回 Math.random，仍然能掷（兼容旧调用方）', async () => {
    const store = createJsonStoreWithExtras({ dir: tempDir('fallback') });
    const dice = createDiceEngine();
    const platform = new FakePlatform();
    const deps: HandlerDeps = {
      store,
      dice,
      coc: createCocRules(dice), // 不传 rng
      rng: fixedRng(4), // 故意给一个固定值，证明 /st 用的是内部回退而不是它
      platform,
      confirmations: createPendingActions(),
      now: () => new Date('2026-09-19T00:00:00.000Z'),
    };
    await route(makeContext({ command: 'st', channelId: 'C1', userId: 'U1', values: { text: 'hp:100' } }, platform), deps);
    const seen = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      await route(makeContext({ command: 'st', channelId: 'C1', userId: 'U1', values: { text: 'hp:100' } }, platform), deps);
      await route(makeContext({ command: 'st', channelId: 'C1', userId: 'U1', values: { text: 'hp-1D6' } }, platform), deps);
      seen.add(store.getSheet('U1', store.listSheets('U1')[0]!.name)!.attrs['生命']!);
    }
    assert.ok(seen.size > 1, `回退路径应当真的在掷骰，实际只出现 ${[...seen].join(',')}`);
  });
});

describe('检定路径本来就吃注入 Rng', () => {
  test('/rc 的 D100 来自注入 Rng（固定值 → 每次同一结果）', async () => {
    const env = makeEnv('rc', fixedRng(42));
    await route(stCtx(env, '力量:60'), env.deps);
    const first = await route(
      makeContext({ command: 'rc', channelId: 'C1', userId: 'U1', values: { text: '力量' } }, env.platform),
      env.deps,
    );
    const second = await route(
      makeContext({ command: 'rc', channelId: 'C1', userId: 'U1', values: { text: '力量' } }, env.platform),
      env.deps,
    );
    assert.match(first.content, /D100=42\/60/, first.content);
    assert.equal(first.content, second.content);
  });
});
