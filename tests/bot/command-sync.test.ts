/**
 * 多服务器命令同步（`src/bot/command-sync.ts`）：
 * guild id 解析、路由形状、逐服务器 PUT、失败汇总。
 * Run: node tests/bot/command-sync.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  globalCommandRoute,
  guildCommandRoute,
  parseGuildIds,
  registerGuildCommands,
} from '../../src/bot/command-sync.ts';

const APP = '900000000000000001';
const G1 = '900000000000000002';
const G2 = '900000000000000003';

describe('parseGuildIds', () => {
  test('逗号 / 空格 / 分号分隔都支持，并去重', () => {
    assert.deepEqual(parseGuildIds(`${G1},${G2}`), [G1, G2]);
    assert.deepEqual(parseGuildIds(`${G1} ${G2}\n${G1}`), [G1, G2]);
    assert.deepEqual(parseGuildIds(`${G1};${G2}`), [G1, G2]);
  });

  test('多个来源合并后去重（DISCORD_GUILD_ID + DISCORD_GUILD_IDS）', () => {
    assert.deepEqual(parseGuildIds(G1, `${G1},${G2}`, undefined, null), [G1, G2]);
  });

  test('非雪花号（空、太短、带字母、前后空白）被丢弃', () => {
    assert.deepEqual(parseGuildIds('', '   ', 'abc', '123', '12345678901234567 '), ['12345678901234567']);
  });

  test('全部为空时返回空数组（调用方据此走全局注册）', () => {
    assert.deepEqual(parseGuildIds(undefined, null, ''), []);
  });
});

describe('命令路由', () => {
  test('guild / 全局路由与 discord.js Routes 同形', () => {
    assert.equal(guildCommandRoute(APP, G1), `/applications/${APP}/guilds/${G1}/commands`);
    assert.equal(globalCommandRoute(APP), `/applications/${APP}/commands`);
  });
});

describe('registerGuildCommands', () => {
  function fakeRest(failing: string[] = []): { rest: { put: (route: `/${string}`, options: { body: unknown }) => Promise<unknown> }; calls: { route: string; body: unknown }[] } {
    const calls: { route: string; body: unknown }[] = [];
    return {
      calls,
      rest: {
        async put(route: `/${string}`, options: { body: unknown }) {
          calls.push({ route, body: options.body });
          const guildId = route.split('/')[4] ?? '';
          if (failing.includes(guildId)) throw new Error(`boom ${guildId}`);
          return {};
        },
      },
    };
  }

  test('每个服务器各 PUT 一次，返回写入列表，body 就是传入的命令清单', async () => {
    const { rest, calls } = fakeRest();
    const body = [{ name: 'r' }];
    const done = await registerGuildCommands(rest, APP, [G1, G2], body);
    assert.deepEqual(done, [G1, G2]);
    assert.deepEqual(
      calls.map((call) => call.route),
      [guildCommandRoute(APP, G1), guildCommandRoute(APP, G2)],
    );
    assert.ok(calls.every((call) => call.body === body));
  });

  test('空列表不产生任何请求', async () => {
    const { rest, calls } = fakeRest();
    assert.deepEqual(await registerGuildCommands(rest, APP, [], []), []);
    assert.equal(calls.length, 0);
  });

  test('单个服务器失败会汇总抛出，且不阻断其它服务器', async () => {
    const { rest, calls } = fakeRest([G1]);
    await assert.rejects(
      () => registerGuildCommands(rest, APP, [G1, G2], []),
      /注册失败：900000000000000002.*已成功：900000000000000003/,
    );
    assert.equal(calls.length, 2, '第一个失败后仍要继续尝试其它服务器');
  });
});
