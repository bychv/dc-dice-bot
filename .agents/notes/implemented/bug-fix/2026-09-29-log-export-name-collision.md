# Agent Note: 导出文件名碰撞：以 `fileName: null` 交给 store 去重

Status: implemented

## 问题

`/log end` 的导出文件名沿用 Dice! 的 `<会话名>_<日志名>.txt`（会话名取局名、查不到回退日志名），文件名里的非法字符会被替换成 `_`。于是**不同日志可能算出同一个文件名**：两条只有非法字符不同的日志名（`第一/夜` 与 `第一_夜`），或者两个同名局里的同名日志。store 的同名去重只在 `fileName === null` 时执行（`bot/src/store/jsonStore.ts` 的 `logFilePath`，冲突时加 `_<logId>`），而当时的 `exportLogRecord` 先把算好的名字写进记录、再调用 `logFilePath` —— 去重条件恒为假，**整条逻辑被跳过**，后导出的一条静默覆盖前一条。

线上真实事故：L5「观音误我」的导出覆盖了 L4 同名的 0 字节文件；两条日志都叫 `观音误我.txt`，实测线上至今两条记录的 `fileName` 都是它。

## 决策

- `exportLogRecord`（`bot/src/bot/handlers/gameCore.ts`）改为以 **`fileName: null`** 落盘、再从落盘结果回填 `basename(path)`：默认名与去重都由 store 一处决定，冲突时得到 `观音误我_L5.txt`，附件名与磁盘名始终一致。
- **同一条日志重导出沿用已记录的 `fileName`**（`exportLogFile`）：`/log export`，以及 `/log on` 续接后的再次 `/log end`，都覆盖同一个文件，不产生副本、不新建日志 id（见 [日志生命周期](../feature/2026-09-30-log-lifecycle-resume-and-export.md)）。
- 测试替身 `MemoryStore.logFilePath` 必须与真实 store **同口径**（默认名 `<会话名>_<日志名>.txt` + 仅在 `fileName === null` 时去重），否则 bot 层测不出这个行为。

## 测试

`bot/tests/spec/export-name-collision.test.ts`（真实 `jsonStore`）：两个同名局各开一条同名日志，逐条 `/log end` —— 第一条用默认名、第二条得到 `观音误我_L2.txt`，且断言**第一条的文件内容没有被覆盖**。

## 曾考虑的替代方案

**在导出侧自己比对文件名** —— "默认名 + 冲突规则"会在 store 与 handler 各存一份实现，任何一侧改动都会漂移，而漂移的后果正是静默覆盖。已否决。

**一律追加时间戳** —— 同一日志每导出一次就生成新文件，反复导出堆出一批近似命名（`东乡村_20261011_2210.txt`…），与 Dice! 的命名口径也不再一致。已否决。

**继续允许覆盖、靠人注意取不同名** —— 事故已经发生（0 字节日志被覆盖），说明这不是机制。已否决。

## 后果

- 收益：同名日志不再互相覆盖，文件名可反查日志 id（`观音误我_L5.txt` 对应 L5）。
- 代价：`fileName` 一旦定下就**固定**，要换名只能另开日志；测试替身与真实 store 之间多了一条"必须同步"的隐性契约——改这条逻辑时，对齐替身那步当时直接挂了一个既有用例（已修复）。
- **历史坏数据保留**：L4 那条 0 字节日志的记录仍指向被 L5 覆盖后的文件（内容本来就是空的），没有回溯修正。
