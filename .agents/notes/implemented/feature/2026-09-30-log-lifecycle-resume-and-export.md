# Agent Note: `/log on` 可续接已结束的日志 + `/log export`

Status: implemented

## 问题

一条日志 `/log end` 之后曾是**单向门**：想在同一个场景接着记只能 `/log new`，而 `/log new` 在本场景已有 `on` 日志时会被拒绝——于是同一场团被切成 `东乡村.txt`、`东乡村 2.txt`… 多份文件，事后要拼。另一个缺口是**快照**：长团中途想把当前记录导出一份发给别人，`/log end` 会真的结束记录，没有别的出口。

## 决策

- **`/log end` 不再是单向门**：`/log on` 在没有 `on` 日志时接本场景**最近的一条**（`off` 暂停的、或 `ended` 结束过的）。续接时 `state` 回 `on`、`endedAt` 清空（"还在记"与"有结束时间"不能同时成立）、**`fileName` 保留**，因此再次 `/log end` 覆盖同一个导出文件、日志 `id` 不变（`bot/src/bot/handlers/log.ts` 的 `logOn()`）。
- 新增 **`/log export [name]`**：导出但**不改状态**——`state`、当前日志指针、`endedAt` 全不动，写盘后按配置上传对象存储（R2）或作为附件发出；已结束的日志也能再导一份（`log.ts` 的 `logExport()` + `gameCore.ts` 的 `exportLogFile()`）。
- 回执说明：续接时提示"导出文件仍是 `X`；再次 `/log end` 会重新导出并覆盖它，中途想看就 `/log export`"。
- 命令清单：`/log` 子命令为 `new(name,game) / list / on / off / end(name) / export(name)`；文档 §11.1 的子命令表与"已结束的日志"增补段同步，README 同步。

## 测试

`bot/tests/bot/log.test.ts`：`off then on resumes the same log; an ended log can be resumed too`（断言 `endedAt` 清空、`fileName` 沿用、`id` 不变）、`/log export：导出但不结束，状态不变，之后还能继续记`（状态保持 `on`、沿用同一文件名、第二次导出能看到两段内容），以及 `/log export name:` 可导出已结束的日志（状态不变）、"无局场景日志 off→on 也能继续"的回归用例。

## 曾考虑的替代方案

**结束后只能 `/log new`** —— 同一场景碎成多份文件，历史被切段；且因为"同场景唯一性"必须先结束才能开新，实操里非常别扭。已否决。

**给 `/log end` 加一个"顺便快照"开关** —— 同一个子命令承载两种状态语义，回执必须额外区分"结束了/没结束"，读日志的人分不清；也与"导出一份、继续记"的诉求冲突。已否决。

**`export` 顺带把日志置 `off`** —— 与"导出不打断记录"直接矛盾。已否决。

**为"导出过但没结束"再加一个状态** —— 状态机从 3 个变 4 个，`/log list`、`/log new` 的唯一性判定、`/sn` 的 `sceneStillRecording` 都要跟着改，收益只是 `list` 里能显示"导出过"。已否决。

## 后果

- 收益：长团可随时取快照；一条日志一个文件，结束 → 续接 → 再结束都覆盖同一个文件（命名与去重口径见 [导出文件名碰撞](../bug-fix/2026-09-29-log-export-name-collision.md)）。
- 代价：`fileName` 一旦定下就固定，要换名只能另开日志；"导出过"**不留痕**（`/log list` 只显示名称/状态/开始时间，没有导出行）。
- 与昵称同步的联动：`/sn` 的钩子挂在这套状态机上——续接会重新改名、暂停/结束会还原（见 [统计昵称同步](2026-09-29-nickname-sync.md)）。
