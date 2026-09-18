/**
 * 迁移已有日志名 → 新命名（旧 `<桌名> · <MMDD-HHmm>` ⇒ 桌名）。
 *
 *   node --env-file-if-exists=.env scripts/migrate-log-names.ts            # 只看计划（dry-run）
 *   node --env-file-if-exists=.env scripts/migrate-log-names.ts --apply    # 真正写盘（先备份 logs.json）
 *
 * 默认读 `DCDICE_DATA_DIR`（或 `./data`）；`--dir <path>` 可覆盖。
 * 迁移逻辑在 `src/bot/migrateLogNames.ts`（有测试），这里只是 CLI 外壳：
 * 从 `logs.json` 取出所有日志 id → 算计划 → 打印 → 可选应用。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { migrateLogNames } from '../src/bot/migrateLogNames.ts';
import { createJsonStoreWithExtras } from '../src/store/jsonStore.ts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dirFlag = args.indexOf('--dir');
const dir = resolve(dirFlag >= 0 ? (args[dirFlag + 1] ?? './data') : (process.env.DCDICE_DATA_DIR ?? './data'));

const logsJson = join(dir, 'logs.json');
if (!existsSync(logsJson)) {
  console.error(`找不到 ${logsJson}（用 --dir 指定数据目录，或设置 DCDICE_DATA_DIR）。`);
  process.exit(1);
}

interface RawLogsFile {
  logs?: Record<string, unknown>;
}
const raw = JSON.parse(readFileSync(logsJson, 'utf8')) as RawLogsFile;
const logIds = Object.keys(raw.logs ?? {});

const store = createJsonStoreWithExtras({ dir });
const result = await migrateLogNames(
  store,
  logIds,
  (guildId, gameId) => store.getGame(guildId, gameId),
  { logsDir: join(dir, 'logs'), dryRun: !apply },
);

console.log(`数据目录：${dir}；共 ${logIds.length} 条日志，需要迁移 ${result.changes.length} 条。`);
for (const change of result.changes) {
  const file = change.fileFrom ? `（文件名 ${change.fileFrom} → ${change.fileTo}）` : '';
  console.log(`  ${change.logId}: 「${change.from}」 → 「${change.to}」${file}`);
}
for (const warning of result.warnings) console.log(`  ⚠️ ${warning}`);

if (!apply) {
  console.log('以上是 dry-run 计划；加 --apply 才会写入。');
  process.exit(0);
}

mkdirSync(join(dir, 'logs'), { recursive: true });
const backup = `${logsJson}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
copyFileSync(logsJson, backup);
console.log(`已备份 ${logsJson} → ${backup}`);
console.log(`已改名的导出文件：${result.renamedFiles.length} 个`);
for (const file of result.renamedFiles) console.log(`  ${file.from} → ${file.to}`);
console.log('迁移完成。');
