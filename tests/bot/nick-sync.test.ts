/**
 * `/sn` 统计昵称同步（docs §12.4）：
 *   - `statNickname` 的格式与截断；
 *   - `/sn on|off|show` 的行为；
 *   - 生命周期：`/log new`（以及 `/log on`）改名、`/log off`、`/log end` 改回原名；
 *   - 幂等（已在目标值不重复写）、失败隔离（无权限/服主）、原名不会记成统计昵称。
 *
 * Run: node tests/bot/nick-sync.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPendingActions } from '../../src/bot/confirm.ts';
import { NICK_LIMIT, maxHpOf, statNickname } from '../../src/bot/handlers/nickSync.ts';
import { route } from '../../src/bot/router.ts';
import { createCocRules } from '../../src/coc/index.ts';
import type { HandlerDeps } from '../../src/contracts/bot.ts';
import type { CharacterSheet } from '../../src/contracts/model.ts';
import type { BotStore } from '../../src/contracts/store.ts';
import { createDiceEngine, createMathRng } from '../../src/dice/index.ts';
import { createJsonStoreWithExtras } from '../../src/store/jsonStore.ts';
import { FakePlatform, makeContext, makeEnv, type TestEnv } from './fakes.ts';

const TMP_ROOT = fileURLToPath(new URL('../.tmp/', import.meta.url));

/**
 * `/st` 用例需要**真实**的 coc 引擎（`makeEnv()` 里的 coc 是 T1/T2 的 stub，只回"已处理 …"，
 * 不会真的改属性），所以这一组用真实 jsonStore + 真实 `createCocRules`。
 */
interface LiveEnv {
  deps: HandlerDeps;
  store: BotStore;
  platform: FakePlatform;
}

function makeLiveEnv(): LiveEnv {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, 'nick-sync-'));
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
    now: () => new Date('2026-01-05T21:30:00.000Z'),
  };
  return { deps, store, platform };
}

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

const CARD: CharacterSheet = sheet('卡特', {
  力量: '60',
  体质: '50',
  体型: '70',
  敏捷: '70',
  外貌: '50',
  智力: '65',
  意志: '55',
  教育: '70',
  生命: '12',
  理智: '70',
});

/** 给 U1 绑上卡特这张卡（场景级，够 resolveSheetFor 用）。 */
function bindCard(env: TestEnv, userId = 'U1', card = CARD): void {
  env.store.putSheet(userId, card);
  env.store.setBinding('scene', 'C1', userId, card.name);
}

const sn = (env: TestEnv, sub: string, userId = 'U1'): ReturnType<typeof route> =>
  route(
    makeContext({ command: 'sn', sub, channelId: 'C1', userId, values: {} }, env.platform),
    env.deps,
  );

const runLog = (env: TestEnv, sub: string, userId = 'U1'): ReturnType<typeof route> =>
  route(
    makeContext({ command: 'log', sub, channelId: 'C1', userId, values: { name: '第一天' } }, env.platform),
    env.deps,
  );

describe('statNickname：角色名 |DEX HP SAN', () => {
  test('完整卡：DEX + 生命/上限 + SAN（上限 =(体质+体型)/10）', () => {
    assert.equal(maxHpOf(CARD.attrs), 12);
    assert.equal(statNickname('卡特', CARD.attrs), '卡特 |DEX70 HP12/12 SAN70');
  });

  test('生命低于上限时显示当前/上限', () => {
    const hurt = { ...CARD.attrs, 生命: '5' };
    assert.equal(statNickname('卡特', hurt), '卡特 |DEX70 HP5/12 SAN70');
  });

  test('算不出上限（缺体质/体型）时只显示当前生命', () => {
    assert.equal(maxHpOf({ 生命: '9' }), null);
    assert.equal(statNickname('卡特', { 敏捷: '70', 生命: '9' }), '卡特 |DEX70 HP9');
  });

  test('缺项就省段：没有统计项时只有角色名（不带竖线）', () => {
    assert.equal(statNickname('卡特', {}), '卡特');
    assert.equal(statNickname('卡特', { 理智: '55' }), '卡特 |SAN55');
  });

  test('超过 32 字符时截断角色名、保留统计段', () => {
    const long = '一二三四五六七八九十一二三四五六七八九十';
    const nick = statNickname(long, CARD.attrs);
    assert.ok(nick.length <= NICK_LIMIT, `${nick.length} > ${NICK_LIMIT}`);
    assert.ok(nick.endsWith('|DEX70 HP12/12 SAN70'), nick);
    assert.ok(nick.includes('…'), nick);
  });
});

describe('`/sn` 开关', () => {
  test('未开启时 show 提示未开启；on 之后变为已开启', async () => {
    const env = makeEnv();
    bindCard(env);
    const before = await sn(env, 'show');
    assert.match(before.content, /未开启/);

    const on = await sn(env, 'on');
    assert.match(on.content, /已开启统计昵称同步/);
    assert.match(on.content, /卡特 \|DEX70 HP12\/12 SAN70/);
    // 没有在记录的日志 → 不立即改名
    assert.equal(env.platform.nicknameCalls.length, 0);
    assert.match(on.content, /没有在记录的日志/);

    const after = await sn(env, 'show');
    assert.match(after.content, /已开启/);
  });

  test('当前场景正在记录时，on 立即改名', async () => {
    const env = makeEnv();
    bindCard(env);
    await runLog(env, 'new');
    const on = await sn(env, 'on');
    assert.equal(env.platform.nicknameCalls.length, 1);
    assert.equal(env.platform.nicknameCalls[0]!.nickname, '卡特 |DEX70 HP12/12 SAN70');
    assert.match(on.content, /已同步 1 位成员/);
  });

  test('off 把昵称改回原名并清掉登记', async () => {
    const env = makeEnv();
    bindCard(env);
    env.platform.nicknames.set('G1:U1', '老王');
    await sn(env, 'on');
    await runLog(env, 'new');
    assert.equal(env.platform.nicknames.get('G1:U1'), '卡特 |DEX70 HP12/12 SAN70');

    const off = await sn(env, 'off');
    assert.match(off.content, /改回原名「老王」/);
    assert.equal(env.platform.nicknames.get('G1:U1'), '老王');
    assert.equal(env.store.getNickSync('G1', 'U1'), null);
  });

  test('原本没有自定义昵称时，off 改回默认用户名（null）', async () => {
    const env = makeEnv();
    bindCard(env);
    await runLog(env, 'new', 'U1');
    await sn(env, 'on', 'U1');
    await sn(env, 'off', 'U1');
    assert.equal(env.platform.nicknames.get('G1:U1'), undefined);
    assert.equal(env.platform.nicknameCalls.at(-1)!.nickname, null);
  });

  test('DM 里拒绝使用（昵称是服务器级的）', async () => {
    const env = makeEnv();
    const reply = await route(
      makeContext({ command: 'sn', sub: 'on', guildId: null, channelId: 'D1', userId: 'U1', values: {} }, env.platform),
      env.deps,
    );
    assert.equal(reply.ephemeral, true);
    assert.match(reply.content, /只能在服务器里使用/);
  });
});

describe('生命周期：开 log 改名、log off / end 改回', () => {
  test('/log new 自动改名，/log off 自动还原', async () => {
    const env = makeEnv();
    bindCard(env);
    env.platform.nicknames.set('G1:U1', '老王');
    await sn(env, 'on');

    const started = await runLog(env, 'new');
    assert.match(started.content, /已同步 1 位成员的统计昵称/);
    assert.equal(env.platform.nicknames.get('G1:U1'), '卡特 |DEX70 HP12/12 SAN70');

    const off = await runLog(env, 'off');
    assert.match(off.content, /已还原 1 位成员的统计昵称/);
    assert.equal(env.platform.nicknames.get('G1:U1'), '老王');
    // 开关保留：下次开 log 还会自动改
    assert.equal(env.store.getNickSync('G1', 'U1')?.enabled, true);
  });

  test('/log on 续记时也会改名（幂等：已在目标值不重复写）', async () => {
    const env = makeEnv();
    bindCard(env);
    await sn(env, 'on');
    await runLog(env, 'new');
    await runLog(env, 'off');
    const callsAfterOff = env.platform.nicknameCalls.length;

    const on = await runLog(env, 'on');
    assert.match(on.content, /已继续记录日志/);
    assert.equal(env.platform.nicknameCalls.length, callsAfterOff + 1);
    assert.match(on.content, /已同步 1 位成员/);

    // 重复一次 `/log on`：昵称已经在目标值 → 不产生新的改名调用
    await runLog(env, 'on');
    assert.equal(env.platform.nicknameCalls.length, callsAfterOff + 1);
    assert.equal(env.platform.nicknames.get('G1:U1'), '卡特 |DEX70 HP12/12 SAN70');
  });

  test('/log end 导出日志后还原昵称', async () => {
    const env = makeEnv();
    bindCard(env);
    env.platform.nicknames.set('G1:U1', '老王');
    await sn(env, 'on');
    await runLog(env, 'new');
    const ended = await runLog(env, 'end');
    assert.match(ended.content, /已结束日志/);
    assert.match(ended.content, /已还原 1 位成员的统计昵称/);
    assert.equal(env.platform.nicknames.get('G1:U1'), '老王');
  });

  test('原名记一次：后续改卡重同步不会把统计昵称当成“原名”', async () => {
    const env = makeEnv();
    bindCard(env);
    env.platform.nicknames.set('G1:U1', '老王');
    await sn(env, 'on');
    await runLog(env, 'new');
    assert.equal(env.store.getNickSync('G1', 'U1')?.original, '老王');

    // 换一张卡（改名目标变了）→ 暂停再续记，昵称跟着换新卡，但 original 必须还是「老王」
    await runLog(env, 'off');
    bindCard(env, 'U1', sheet('奈亚', { 敏捷: '40', 体质: '40', 体型: '60', 生命: '10', 理智: '50' }));
    await runLog(env, 'on');
    assert.equal(env.platform.nicknames.get('G1:U1'), '奈亚 |DEX40 HP10/10 SAN50');
    assert.equal(env.store.getNickSync('G1', 'U1')?.original, '老王');

    await runLog(env, 'off');
    assert.equal(env.platform.nicknames.get('G1:U1'), '老王');
  });

  test('没卡 / 没开启的成员不动', async () => {
    const env = makeEnv();
    bindCard(env);
    const started = await runLog(env, 'new');
    assert.equal(env.platform.nicknameCalls.length, 0);
    assert.doesNotMatch(started.content, /统计昵称/);
  });

  test('改名失败只报告，不影响其他人', async () => {
    const env = makeEnv();
    bindCard(env, 'U1');
    bindCard(env, 'U2', sheet('奈亚', { 敏捷: '40', 体质: '40', 体型: '60', 生命: '10', 理智: '50' }));
    env.store.setBinding('scene', 'C1', 'U2', '奈亚');
    await sn(env, 'on', 'U1');
    await sn(env, 'on', 'U2');
    env.platform.nicknameErrors.add('U1'); // 模拟无「管理昵称」权限

    const started = await runLog(env, 'new');
    assert.match(started.content, /1 位失败/);
    assert.equal(env.platform.nicknames.get('G1:U2'), '奈亚 |DEX40 HP10/10 SAN50');
    assert.equal(env.platform.nicknames.get('G1:U1'), undefined);
  });
});

describe('`/st` 改属性后自动刷新昵称（真实 coc 引擎）', () => {
  const st = (env: LiveEnv, text: string, userId = 'U1'): ReturnType<typeof route> =>
    route(
      makeContext({ command: 'st', channelId: 'C1', userId, values: { text } }, env.platform),
      env.deps,
    );
  const snOn = (env: LiveEnv, sub: string, userId = 'U1'): ReturnType<typeof route> =>
    route(
      makeContext({ command: 'sn', sub, channelId: 'C1', userId, values: {} }, env.platform),
      env.deps,
    );
  const logCmd = (env: LiveEnv, sub: string): ReturnType<typeof route> =>
    route(
      makeContext({ command: 'log', sub, channelId: 'C1', userId: 'U1', values: { name: '第一天' } }, env.platform),
      env.deps,
    );
  const liveBind = (env: LiveEnv, card: CharacterSheet = CARD, userId = 'U1'): void => {
    env.store.putSheet(userId, card);
    env.store.setBinding('scene', 'C1', userId, card.name);
  };

  test('正在记录时：/st 掉血后昵称里的 HP 立刻更新', async () => {
    const env = makeLiveEnv();
    liveBind(env);
    await snOn(env, 'on');
    await logCmd(env, 'new');
    assert.equal(env.platform.nicknames.get('G1:U1'), '卡特 |DEX70 HP12/12 SAN70');

    const hurt = await st(env, 'hp-5');
    assert.match(hurt.content, /已更新统计昵称/);
    assert.equal(env.platform.nicknames.get('G1:U1'), '卡特 |DEX70 HP7/12 SAN70');
  });

  test('改敏感属性：DEX 与 SAN 也会跟着变', async () => {
    const env = makeLiveEnv();
    liveBind(env);
    await snOn(env, 'on');
    await logCmd(env, 'new');

    await st(env, '敏捷:50');
    assert.equal(env.platform.nicknames.get('G1:U1'), '卡特 |DEX50 HP12/12 SAN70');
    await st(env, '理智-10');
    assert.equal(env.platform.nicknames.get('G1:U1'), '卡特 |DEX50 HP12/12 SAN60');
  });

  test('没开 /sn 或没有在记录：/st 照常生效但不动昵称', async () => {
    const env = makeLiveEnv();
    liveBind(env);
    const plain = await st(env, 'hp-1');
    assert.match(plain.content, /生命: 12->11/);
    assert.equal(env.platform.nicknameCalls.length, 0);

    await snOn(env, 'on'); // 开了 /sn，但本场景没有在记录的日志
    const noLog = await st(env, 'hp-1');
    assert.match(noLog.content, /生命: 11->10/);
    assert.doesNotMatch(noLog.content, /统计昵称/);
    assert.equal(env.platform.nicknameCalls.length, 0);
  });

  test('改名失败时 /st 仍然成功，只附一行警告', async () => {
    const env = makeLiveEnv();
    liveBind(env);
    await snOn(env, 'on');
    await logCmd(env, 'new');
    env.platform.nicknameErrors.add('U1');

    const hurt = await st(env, 'hp-3');
    assert.match(hurt.content, /统计昵称更新失败/);
    assert.notEqual(hurt.ephemeral, true);
    assert.equal(env.store.getSheet('U1', '卡特')?.attrs['生命'], '9', '属性必须已落库');
  });
});
