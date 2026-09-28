/**
 * 导出文件名碰撞的回归测试（`/log end` 路径）。
 *
 * 背景（截团时发现）：`exportLogRecord` 过去先把文件名算好再调 `store.logFilePath()`，
 * 而 `logFilePath` **只在 `fileName === null` 时**才做同名去重 → 两条算出同名的日志
 * （例如两个都叫「观音误我」的局、队名与日志名都相同）会写到同一个文件，**后导出的覆盖前一条**。
 * 现在改成以 `fileName = null` 落盘，去重交给 store（冲突加 `_<logId>`）。
 *
 * Run: node tests/spec/export-name-collision.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPendingActions } from '../../src/bot/confirm.ts';
import { route } from '../../src/bot/router.ts';
import { createCocRules } from '../../src/coc/index.ts';
import type { HandlerDeps, InteractionContext } from '../../src/contracts/bot.ts';
import type { BotStore } from '../../src/contracts/store.ts';
import { createDiceEngine, createMathRng } from '../../src/dice/index.ts';
import { createJsonStoreWithExtras } from '../../src/store/jsonStore.ts';
import { FakePlatform, makeContext, type CtxSpec } from '../bot/fakes.ts';

const TMP_ROOT = fileURLToPath(new URL('../.tmp/', import.meta.url));
const FROZEN_NOW = new Date('2026-01-05T21:30:00.000Z');

function makeEnv(): { deps: HandlerDeps; store: BotStore; dir: string; platform: FakePlatform } {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, 'export-collision-'));
  const store = createJsonStoreWithExtras({ dir });
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
    now: () => FROZEN_NOW,
  };
  return { deps, store, dir, platform };
}

function ctx(spec: Partial<CtxSpec> & { command: string }, platform: FakePlatform): InteractionContext {
  return makeContext({ guildId: 'G1', userId: 'KP1', displayName: 'KP', channelId: 'C1', channelName: '跑团', ...spec }, platform);
}

describe('同名日志导出不得互相覆盖', () => {
  test('两个同名局的两条同名日志：第二个文件名自动加 _<logId>，第一个文件内容保留', async () => {
    const env = makeEnv();
    const startGame = async (): Promise<void> => {
      const reply = await route(
        ctx({ command: 'game', sub: 'start', values: { name: '观音误我', keeper: 'KP1', here: true } }, env.platform),
        env.deps,
      );
      assert.notEqual(reply.ephemeral, true, reply.content);
    };

    // 第一局：自动开的日志名 = 桌名 = 「观音误我」，会话名也是局名 → 文件名 观音误我.txt
    await startGame();
    const log1 = env.store.listSceneLogs('C1', 'G1')[0]!;
    env.store.appendLogLine('C1', '甲(U1) 2026-01-01 00:00:00\n第一局的内容\n\n');
    await route(ctx({ command: 'log', sub: 'end' }, env.platform), env.deps);

    const ended1 = env.store.getLog(log1.id)!;
    assert.equal(ended1.state, 'ended');
    assert.equal(ended1.fileName, '观音误我.txt', '第一条导出用默认名');
    const file1 = join(env.dir, 'logs', '观音误我.txt');
    assert.ok(existsSync(file1));
    assert.match(readFileSync(file1, 'utf8'), /第一局的内容/);

    // 第二局：同名桌名、同名日志 → 默认名与第一条完全相同
    await startGame();
    const log2 = env.store.listSceneLogs('C1', 'G1').find((l) => l.id !== log1.id && l.state === 'on')!;
    env.store.appendLogLine('C1', '甲(U1) 2026-01-01 00:01:00\n第二局的内容\n\n');
    await route(ctx({ command: 'log', sub: 'end' }, env.platform), env.deps);

    const ended2 = env.store.getLog(log2.id)!;
    assert.equal(ended2.state, 'ended');
    assert.notEqual(ended2.fileName, ended1.fileName, `两条导出必须不同名：${ended1.fileName} / ${ended2.fileName}`);
    assert.equal(ended2.fileName, `观音误我_${log2.id}.txt`, '冲突时加 _<logId>');

    // 第一个文件没有被覆盖，第二个文件里是第二局的内容
    assert.match(readFileSync(file1, 'utf8'), /第一局的内容/, '前一条导出不得被覆盖');
    assert.doesNotMatch(readFileSync(file1, 'utf8'), /第二局的内容/);
    const file2 = join(env.dir, 'logs', ended2.fileName);
    assert.match(readFileSync(file2, 'utf8'), /第二局的内容/);
  });
});
