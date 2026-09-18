/**
 * T4 独立验证汇总入口。
 *
 *   node tests/verify/all.test.ts
 *
 * 会加载 tests/verify/ 下的全部验证用例（node:test 在同一进程内依次执行）；
 * `scripts/run-tests.ts` 也会自动收集这些文件，因此汇总入口与全量测试结果一致。
 */
import './rules-spec.test.ts';
import './dice-spec.test.ts';
import './structure-manifest.test.ts';
import './check-st-sc-en.test.ts';
import './behavior-game-log.test.ts';
import './behavior-rh-pc-setcoc.test.ts';
import './e2e-handlers.test.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('T4 · 汇总入口已加载全部验证文件', () => {
  assert.ok(true, '模块导入完成即代表用例已注册');
});
