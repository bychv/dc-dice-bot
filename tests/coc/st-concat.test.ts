/**
 * `/st` 无分隔符连写卡片串（外部骰娘导出）导入测试。
 *
 * 样本 `tests/fixtures/st-concat-sample.txt`：383 字符、无空格、无冒号/等号，
 * 形如 `力量40str40敏捷80dex80…炮术10`。
 *
 * 期望属性条数 = 60，推导：
 * - 样本里带值的主属性槽 9 个：力量、敏捷、意志、体质、外貌、教育、体型、智力、幸运
 *   （理智/san/san值/理智值 与 生命/hp/体力、魔法/mp 在样本里没有数字 → 跳过，不占槽）；
 * - 带值的技能槽 51 个（同义词合并后），其中 `猫语` 是字典外的自定义技能；
 * - 9 + 51 = 60。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCocRules } from '../../src/coc/index.ts';
import { stubDice, testSheet } from './helpers.ts';

const SAMPLE = readFileSync(new URL('../fixtures/st-concat-sample.txt', import.meta.url), 'utf8').trim();
const rules = createCocRules(stubDice());

describe('连写模式：样本 fixture', () => {
  test('样本形态：383 字符、无空白、无分隔符', () => {
    assert.equal(SAMPLE.length, 383);
    assert.equal(/\s/.test(SAMPLE), false);
    assert.equal(/[:=&]/.test(SAMPLE), false);
  });

  test('关键属性落到正确槽位', () => {
    const result = rules.applySt(SAMPLE, null);
    assert.ok(result.ok);
    assert.equal(result.op, 'set');
    assert.ok(result.sheet);
    const attrs = result.sheet.attrs;
    // 主属性 + 同义写法（力量/str、敏捷/dex、教育/edu、体型/siz、智力/灵感/int）
    assert.equal(attrs['力量'], '40');
    assert.equal(attrs['敏捷'], '80');
    assert.equal(attrs['意志'], '60');
    assert.equal(attrs['体质'], '60');
    assert.equal(attrs['外貌'], '45');
    assert.equal(attrs['教育'], '85');
    assert.equal(attrs['体型'], '60');
    assert.equal(attrs['智力'], '90');
    assert.equal(attrs['幸运'], '70');
    // 技能（含别名合并与自定义技能）
    assert.equal(attrs['会计'], '5');
    assert.equal(attrs['母语'], '85');
    assert.equal(attrs['侦查'], '65');
    assert.equal(attrs['炮术'], '10');
    assert.equal(attrs['猫语'], '70');
    // 别名同槽
    assert.equal(attrs['计算机使用'], '5');
    assert.equal(attrs['信用评级'], '10');
    assert.equal(attrs['克苏鲁神话'], '0');
    assert.equal(attrs['汽车驾驶'], '20');
    assert.equal(attrs['图书馆使用'], '50');
    assert.equal(attrs['锁匠'], '1');
    assert.equal(attrs['导航'], '10');
    assert.equal(attrs['操作重型机械'], '1');
    assert.equal(attrs['魅惑'], '15');
    assert.equal(attrs['博物学'], '10');
    assert.equal(attrs['骑乘'], '5');
    // 别名键不应残留
    assert.equal(attrs['str'], undefined);
    assert.equal(attrs['dex'], undefined);
    assert.equal(attrs['灵感'], undefined);
    assert.equal(attrs['运气'], undefined);
    assert.equal(attrs['san'], undefined);
    assert.equal(attrs['开锁'], undefined);
    assert.equal(attrs['克苏鲁'], undefined);
  });

  test('条数为 60', () => {
    const result = rules.applySt(SAMPLE, null);
    assert.ok(result.ok);
    assert.ok(result.sheet);
    const keys = Object.keys(result.sheet.attrs);
    assert.equal(keys.length, 60);
    assert.equal(new Set(keys).size, 60);
  });

  test('无值名字被跳过并写进回执；不臆造数值', () => {
    const result = rules.applySt(SAMPLE, null);
    assert.ok(result.ok);
    assert.ok(result.sheet);
    assert.deepEqual(
      result.sheet.attrs['san'] ?? null,
      null,
      'san 在样本里没有数字，不得写入',
    );
    assert.equal(result.sheet.attrs['理智'], undefined, '理智在样本里没有数字，不得写入');
    assert.equal(result.sheet.attrs['理智值'], undefined);
    assert.equal(result.sheet.attrs['生命'], undefined, 'hp/体力 没有数字');
    assert.equal(result.sheet.attrs['魔法'], undefined, 'mp 没有数字');
    const skippedLine = result.lines.find((line) => line.startsWith('跳过'));
    assert.equal(skippedLine, '跳过无值/重复：san、san值、理智、理智值、mp、魔法、hp、体力');
  });

  test('字典外片段作为自定义技能写入并报告', () => {
    const result = rules.applySt(SAMPLE, null);
    assert.ok(result.ok);
    assert.ok(result.sheet);
    assert.equal(result.sheet.attrs['猫语'], '70');
    assert.deepEqual(
      result.lines.filter((line) => line.startsWith('自定义技能')),
      ['自定义技能：猫语'],
    );
  });

  test('回执给出条数与写入清单', () => {
    const result = rules.applySt(SAMPLE, null);
    assert.ok(result.ok);
    assert.equal(result.lines[0], '连写识别：共写入 60 条属性。');
    const written = result.lines[result.lines.length - 1];
    assert.ok(written.includes('力量=40'));
    assert.ok(written.includes('幸运=70'));
    assert.ok(written.includes('猫语=70'));
    assert.ok(written.includes('炮术=10'));
    assert.equal(written.split('、').length, 60);
  });

  test('在已有角色卡上导入：其余属性保留，不可变更新', () => {
    const sheet = testSheet({ 备注: '旧卡' });
    const result = rules.applySt(SAMPLE, sheet);
    assert.ok(result.ok);
    assert.ok(result.sheet);
    assert.equal(result.sheet.attrs['备注'], '旧卡');
    assert.equal(result.sheet.attrs['力量'], '40');
    assert.equal(Object.keys(result.sheet.attrs).length, 61);
    assert.deepEqual(sheet.attrs, { 备注: '旧卡' }, '原 sheet 不被修改');
  });
});

describe('连写模式：规则边界', () => {
  test('同槽重复写取最后一次（力量40str50 => 力量=50）', () => {
    const result = rules.applySt('力量40str50', null);
    assert.ok(result.ok);
    assert.ok(result.sheet);
    assert.deepEqual(result.sheet.attrs, { 力量: '50' });
  });

  test('单值但名字段由多个已知名连写：值给最后一个，其余跳过', () => {
    const result = rules.applySt('sansan值理智理智值幸运70', null);
    assert.ok(result.ok);
    assert.ok(result.sheet);
    assert.deepEqual(result.sheet.attrs, { 幸运: '70' });
    assert.equal(result.lines[1], '跳过无值/重复：san、san值、理智、理智值');
    const result2 = rules.applySt('mp魔法hp体力会计5', null);
    assert.ok(result2.ok);
    assert.ok(result2.sheet);
    assert.deepEqual(result2.sheet.attrs, { 会计: '5' });
  });

  test('多位数值（85/90/100）完整读取', () => {
    const result = rules.applySt('教育85智力90幸运100', null);
    assert.ok(result.ok);
    assert.ok(result.sheet);
    assert.deepEqual(result.sheet.attrs, { 教育: '85', 智力: '90', 幸运: '100' });
  });

  test('大小写不敏感（STR40DEX80）', () => {
    const result = rules.applySt('STR40DEX80', null);
    assert.ok(result.ok);
    assert.ok(result.sheet);
    assert.deepEqual(result.sheet.attrs, { 力量: '40', 敏捷: '80' });
  });

  test('字典外自定义技能夹在已知名之间', () => {
    const result = rules.applySt('力量40猫语70敏捷80', null);
    assert.ok(result.ok);
    assert.ok(result.sheet);
    assert.deepEqual(result.sheet.attrs, { 力量: '40', 猫语: '70', 敏捷: '80' });
    assert.deepEqual(
      result.lines.filter((line) => line.startsWith('自定义技能')),
      ['自定义技能：猫语'],
    );
  });
});

describe('连写模式：既有语法不回归', () => {
  test('名称:值 / 名称=值 仍走既有路径', () => {
    const result = rules.applySt('力量:50 体质=55', null);
    assert.ok(result.ok);
    assert.ok(result.sheet);
    assert.deepEqual(result.sheet.attrs, { 力量: '50', 体质: '55' });
    assert.equal(result.lines[0], '力量: 50');
  });

  test('相对修改 / 表达式 / show / del / clr 仍走既有路径', () => {
    const sheet = testSheet({ 生命: '10' }, { 沙漠之鹰: '1D10' });
    const modified = rules.applySt('hp-1', sheet);
    assert.ok(modified.ok);
    assert.equal(modified.op, 'modify');
    assert.ok(modified.sheet);
    assert.equal(modified.sheet.attrs.生命, '9');

    const expression = rules.applySt('&短刀=1D4+2', sheet);
    assert.ok(expression.ok);
    assert.equal(expression.op, 'expr');
    assert.ok(expression.sheet);
    assert.equal(expression.sheet.exprs['短刀'], '1D4+2');

    const shown = rules.applySt('show 生命', sheet);
    assert.ok(shown.ok);
    assert.equal(shown.op, 'show');
    assert.deepEqual(shown.lines, ['生命: 10']);

    const deleted = rules.applySt('del 生命', sheet);
    assert.ok(deleted.ok);
    assert.equal(deleted.op, 'del');

    const cleared = rules.applySt('clr', sheet);
    assert.ok(cleared.ok);
    assert.equal(cleared.op, 'clr');
    assert.ok(cleared.sheet);
    assert.deepEqual(cleared.sheet.attrs, {});
  });

  test('单个 名称+数字 不触发连写（力量40 / 猫语70）', () => {
    const simple = rules.applySt('力量40', null);
    assert.ok(simple.ok);
    assert.ok(simple.sheet);
    assert.deepEqual(simple.sheet.attrs, { 力量: '40' });
    const custom = rules.applySt('猫语70', null);
    assert.ok(custom.ok);
    assert.ok(custom.sheet);
    assert.deepEqual(custom.sheet.attrs, { 猫语: '70' });
  });

  test('含多个数字段的普通文本值不被误判为连写', () => {
    const result = rules.applySt('电话12345678分机01', null);
    assert.ok(result.ok);
    assert.ok(result.sheet);
    assert.deepEqual(result.sheet.attrs, { 电话: '12345678分机01' });
  });

  test('1d6+2 之类骰式输入仍按既有逻辑处理，不做连写', () => {
    const result = rules.applySt('1d6+2', null);
    assert.ok(result.ok);
    assert.deepEqual(result.lines, ['1d6+2≠ 无法解析']);
    assert.equal(result.sheet, undefined);
  });
});

describe('前导指令名兼容（从骰娘复制整行命令）', () => {
  const prefixForms = [
    `.st ${SAMPLE}`,
    `.st${SAMPLE}`,
    `/st ${SAMPLE}`,
    `。st ${SAMPLE}`,
    `！st ${SAMPLE}`,
    `  .st ${SAMPLE}  `,
  ];

  for (const [index, input] of prefixForms.entries()) {
    test(`形式 ${index + 1}：连写卡片串带前缀仍能完整导入`, () => {
      const bare = rules.applySt(SAMPLE, null);
      const prefixed = rules.applySt(input, null);
      assert.ok(bare.ok && prefixed.ok);
      assert.ok(bare.sheet && prefixed.sheet);
      assert.deepEqual(prefixed.sheet.attrs, bare.sheet.attrs);
      assert.equal(Object.keys(prefixed.sheet.attrs).length, 60);
    });
  }

  test('普通语法与前缀组合：`.st 力量:50 体质:55`、`.st hp-1`、`.st &短刀=1D4+2`', () => {
    const set = rules.applySt('.st 力量:50 体质:55 hp:10', null);
    assert.ok(set.ok && set.sheet);
    assert.deepEqual(set.sheet.attrs, { 力量: '50', 体质: '55', 生命: '10' });

    const modify = rules.applySt('.st hp-1', set.sheet);
    assert.ok(modify.ok && modify.sheet);
    assert.equal(modify.sheet.attrs['生命'], '9', '前缀剥离后相对修改仍生效（hp 归一化为 生命）');

    const expr = rules.applySt('.st &短刀=1D4+2', modify.sheet);
    assert.ok(expr.ok && expr.sheet);
    assert.equal(expr.sheet.exprs['短刀'], '1D4+2');
  });

  test('前缀剥离只作用于开头（卡内文本不动），`show` / `del` / `clr` 也认前缀', () => {
    const withSheet = rules.applySt('.st 力量:50 备注:st是前缀', null);
    assert.ok(withSheet.ok && withSheet.sheet);
    assert.equal(withSheet.sheet.attrs['力量'], '50');
    assert.equal(withSheet.sheet.attrs['备注'], 'st是前缀', '卡内出现的前缀字符不受影响');

    const shown = rules.applySt('.st show 力量', withSheet.sheet);
    assert.ok(shown.ok);
    assert.equal(shown.op, 'show');
    assert.deepEqual(shown.lines, ['力量: 50']);

    const deleted = rules.applySt('.st del 力量', withSheet.sheet);
    assert.ok(deleted.ok);
    assert.equal(deleted.op, 'del');

    const cleared = rules.applySt('.st clr', withSheet.sheet);
    assert.ok(cleared.ok);
    assert.equal(cleared.op, 'clr');
    assert.deepEqual(cleared.sheet?.attrs, {});
  });

  test('没有前缀时行为不变（`力量40` 不会被当成前缀）', () => {
    const result = rules.applySt('力量40', null);
    assert.ok(result.ok && result.sheet);
    assert.deepEqual(result.sheet.attrs, { 力量: '40' });
  });
});
