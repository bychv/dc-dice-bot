/**
 * Drift guard: assert the bundled command manifest is byte-for-byte the documented spec,
 * and that the payload satisfies Discord's own validation rules.
 *
 *   node scripts/check-manifest.ts
 *
 * 两种运行环境：
 *   - 仓库模式：能找到 `docs/discord-commands.json`，做逐字节 deep-equal
 *   - 部署包模式（服务器上只上传了 bot/）：找不到 docs/，跳过文档比对，只做 Discord 规则校验
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { COMMANDS } from '../src/bot/manifest.ts';
import { validateManifest } from '../src/bot/spec-validate.ts';

const docsCandidates = [
  '../../docs/discord-commands.json', // 仓库布局：bot/ 与 docs/ 同级
  '../docs/discord-commands.json', // 万一被打包成 bot/docs/
].map((relative) => fileURLToPath(new URL(relative, import.meta.url)));

const docsPath = docsCandidates.find((candidate) => existsSync(candidate)) ?? null;

type Json = unknown;

function deepEqual(a: Json, b: Json, path = '$'): string[] {
  if (a === b) return [];
  if (typeof a !== typeof b) return [`${path}: type ${typeof a} vs ${typeof b}`];
  if (a === null || b === null) return a === b ? [] : [`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`];
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return [`${path}: array vs non-array`];
    if (a.length !== b.length) return [`${path}: length ${a.length} vs ${b.length}`];
    return a.flatMap((v, i) => deepEqual(v, b[i], `${path}[${i}]`));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as Record<string, Json>).sort();
    const bk = Object.keys(b as Record<string, Json>).sort();
    const diffs: string[] = [];
    if (ak.join(',') !== bk.join(',')) {
      diffs.push(`${path}: keys [${ak.join(',')}] vs [${bk.join(',')}]`);
    }
    for (const k of ak) {
      if (!bk.includes(k)) continue;
      diffs.push(...deepEqual((a as Record<string, Json>)[k], (b as Record<string, Json>)[k], `${path}.${k}`));
    }
    return diffs;
  }
  return [`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`];
}

const documented = docsPath === null ? null : (JSON.parse(readFileSync(docsPath, 'utf8')) as Json);

if (documented === null) {
  console.log('note: 未找到 docs/discord-commands.json（部署包模式），跳过与文档的逐字节比对');
} else {
  const diffs = deepEqual(COMMANDS, documented);
  if (diffs.length > 0) {
    console.error(`FAIL: manifest drifted from docs/discord-commands.json (${diffs.length} differences)`);
    for (const d of diffs.slice(0, 40)) console.error('  - ' + d);
    process.exit(1);
  }
  console.log(`OK: ${COMMANDS.length} commands match docs/discord-commands.json exactly`);
  console.log('   ' + COMMANDS.map((c) => c.name).join(', '));
}

// 除了与文档一致，还要满足 Discord 自己会校验的命名/长度规则（含 name_localizations 的大小写）
const problems = validateManifest(COMMANDS);
if (problems.length > 0) {
  console.error(`FAIL: ${problems.length} 处 payload 不符合 Discord 校验规则：`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('OK: payload 通过 Discord 侧校验规则（名称/本地化名/描述/选项结构）');
