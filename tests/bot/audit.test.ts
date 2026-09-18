/**
 * 运行日志（`src/bot/audit.ts`）：上下文一行 + 回执摘要一行。
 * 重点是「跨子区读不到卡」这类问题事后能查：行里要有场景（子区←父频道）、局、解析到的角色卡。
 * Run: node tests/bot/audit.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createAuditLogger, describeContext, describeResult } from '../../src/bot/audit.ts';
import { currentGame, resolveRule, resolveSheet } from '../../src/bot/handlers/context.ts';
import type { GameRecord, CharacterSheet } from '../../src/contracts/model.ts';
import { makeContext, makeEnv } from './fakes.ts';

const NOW = new Date('2026-09-18T13:02:11.000Z');

function sheet(name: string, attrs: Record<string, string> = {}): CharacterSheet {
  return {
    name,
    template: 'COC7',
    attrs,
    exprs: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function game(name: string, keeper = 'KP1', rule: GameRecord['rule'] = 1): GameRecord {
  return {
    id: '#1',
    guildId: 'G1',
    name,
    keeperId: keeper,
    status: 'active',
    sceneThreadId: null,
    parentChannelId: 'C1',
    sceneThreadCreatedByBot: false,
    hiddenThreadId: null,
    rule,
    currentLogId: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
  };
}

describe('describeContext', () => {
  test('子区继承父频道：局 / 角色卡 / 房规 都能解析出来，并标出 ←父频道', () => {
    const env = makeEnv();
    env.store.putGame(game('阿卡姆'));
    env.store.setSceneGame('C1', 'G1', '#1');
    env.store.putSheet('U1', sheet('甲卡'));
    env.store.setBinding('game', '#1', 'U1', '甲卡');

    const ctx = makeContext(
      {
        command: 'rc',
        channelId: 'T7',
        parentChannelId: 'C1',
        channelName: '某子区',
        userId: 'U1',
        displayName: '甲',
        values: { text: '闪避' },
      },
      env.platform,
    );

    const line = describeContext(ctx, env.deps);
    assert.match(line, /^\/rc /);
    assert.match(line, /user=甲\(U1\)/);
    assert.match(line, /scene=T7←C1/, line);
    assert.match(line, /game=#1 阿卡姆/, line);
    assert.match(line, /sheet=甲卡/, line);
    assert.match(line, /rule=1\(局\)/, line);
    assert.match(line, /text="闪避"/, line);
  });

  test('没有卡 / 没有局时显式写「无」，便于一眼看出解析失败的原因', () => {
    const env = makeEnv();
    const ctx = makeContext(
      { command: 'rc', channelId: 'T9', parentChannelId: 'C8', userId: 'U1', values: { text: '闪避' } },
      env.platform,
    );
    const line = describeContext(ctx, env.deps);
    assert.match(line, /game=无/);
    assert.match(line, /sheet=无/);
    assert.match(line, /rule=0\(默认\)/);
    assert.equal(currentGame(ctx, env.deps), null);
    assert.equal(resolveSheet(ctx, env.deps), null);
    assert.equal(resolveRule(ctx, env.deps).rule, 0);
  });

  test('多行/超长参数被压成单行并截断', () => {
    const env = makeEnv();
    const ctx = makeContext(
      { command: 'st', channelId: 'C1', userId: 'U1', values: { text: `力量:50\n${'x'.repeat(200)}` } },
      env.platform,
    );
    const line = describeContext(ctx, env.deps);
    assert.equal(line.includes('\n'), false, '日志必须一行一条');
    assert.ok(line.length < 200, line);
    assert.match(line, /text="力量:50 x+…?"/);
  });
});

describe('describeResult', () => {
  test('成功 / 失败 / ephemeral / 附件数都体现在摘要里，正文压成单行', () => {
    assert.equal(describeResult({ content: '闪避 检定 D100=31/70 → 困难成功', ok: true }), 'OK(public) 闪避 检定 D100=31/70 → 困难成功');
    assert.equal(
      describeResult({ content: '当前场景没有生效的角色卡', ok: false, ephemeral: true }),
      'FAIL(ephemeral) 当前场景没有生效的角色卡',
    );
    assert.equal(describeResult({ content: '已结束日志', files: [{ name: 'a.txt', data: Buffer.alloc(1) }] }), 'OK(public files=1) 已结束日志');
  });

  test('超长回执截断到 200 字以内', () => {
    const line = describeResult({ content: 'x'.repeat(500), ok: true });
    assert.ok(line.length <= 220, String(line.length));
    assert.ok(line.endsWith('…'));
  });

  test('多行回执被压平（日志一条一行）', () => {
    assert.equal(describeResult({ content: '第一行\n第二行', ok: true }), 'OK(public) 第一行 第二行');
  });
});

describe('createAuditLogger', () => {
  function capture(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    };
    return { lines, restore: () => { console.log = original; } };
  }

  test('开启时输出两行（上下文 + 结果），第一行带时间戳', () => {
    const env = makeEnv({ now: () => NOW });
    const ctx = makeContext({ command: 'r', channelId: 'C1', userId: 'U1', values: { text: '1d6' } }, env.platform);
    const out = capture();
    try {
      const audit = createAuditLogger(env.deps, { DCDICE_AUDIT_LOG: '1' });
      audit.context(ctx);
      audit.result({ content: '1d6=4', ok: true });
    } finally {
      out.restore();
    }
    assert.equal(out.lines.length, 2);
    assert.match(out.lines[0] ?? '', /^\[2026-09-18 \d{2}:\d{2}:\d{2}\] \/r /);
    assert.match(out.lines[1] ?? '', /^ {4}↳ OK\(public\) 1d6=4$/);
  });

  test('DCDICE_AUDIT_LOG=0 时完全静默', () => {
    const env = makeEnv();
    const ctx = makeContext({ command: 'r', channelId: 'C1', userId: 'U1', values: { text: '1d6' } }, env.platform);
    const out = capture();
    try {
      const audit = createAuditLogger(env.deps, { DCDICE_AUDIT_LOG: '0' });
      audit.context(ctx);
      audit.result({ content: '1d6=4', ok: true });
      audit.button('confirm:abc', 'U1');
    } finally {
      out.restore();
    }
    assert.deepEqual(out.lines, []);
  });

  test('按钮点击也留痕（custom_id 前缀 + 用户）', () => {
    const env = makeEnv({ now: () => NOW });
    const out = capture();
    try {
      createAuditLogger(env.deps, {}).button('confirm:abc123', 'U9');
    } finally {
      out.restore();
    }
    assert.equal(out.lines.length, 1);
    assert.match(out.lines[0] ?? '', /button confirm user=U9$/);
  });
});
