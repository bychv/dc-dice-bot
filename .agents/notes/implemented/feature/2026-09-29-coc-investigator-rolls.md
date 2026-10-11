# Agent Note: `/coc` 自动掷调查员卡（embed、两个总值、多张合并）

Status: implemented

## 问题

Dice! 的 `.coc`（COC 人物作成）在裁剪阶段被移除（`docs/Discord_CoC_Command_Set.md` §14），选卡只能 `/r` 掷点后 `/st` 手动录入，中间没有任何"一次看几张、自己挑一张"的手段。`/pc new` 虽然能直接建卡，但它用的是简化掷法（9 项全部 3D6×5，`bot/src/bot/handlers/sheets.ts` 的 `rollCoc7Attrs`），与 CoC 7e 手册不符，而且**占卡位**（`MAX_SHEETS_PER_USER = 16`，见 `pc.ts` 的限额分支）——不适合"多掷几张挑一张"。

## 决策

- 新增 `/coc [数量=1]`（命令集 19 → 20 条）：`数量` 为 INTEGER，1–10，默认 1；超过 10 按 10 掷并在回执里说明，0/负数按 1。
- 掷法**逐条按手册**（用户给出公式）：力量/体质/敏捷/外貌/意志 3D6×5；体型/智力/教育 (2D6+6)×5；幸运 3D6×5 —— `sheets.ts`：`rollCoc7Card()` + `COC7_BONUS6_ATTRS`。
- 每张卡给**两个总值**：8 项基础属性之和（`baseTotal`）与它加幸运（`totalWithLuck`）。
- **embed 展示**：标题 `CoC7 调查员卡`（多张为 `×N`），每张卡一个竖向 field，多张时末尾加一行 `合计（N 张）` 给出两项平均值；页脚只写 `coc7e`。
- **多张合并进同一条 embed**：一次交互一条消息，不刷屏。
- **不落库**：`/coc` 只作选卡参考，要保存用 `/pc new`；回执 `content` 只留一句说明，`【使用者】` 前缀由回执出口统一加（见 [回执统一回显使用者](../architecture/2026-09-20-receipts-echo-the-actor.md)）。
- 为此引入 embed 通道：契约新增 `ApiEmbed` 与 `ReplyPayload.embeds`（`bot/src/contracts/bot.ts`），adapter 转发（`adapter.ts` 的 `reply`/`editReply` 两条路径），并把 embed 的标题/描述/字段**展开成文本后写入日志**（`adapter.ts` 的 `logTextOf()`）——否则日志里只剩"掷了 N 张卡"，数值全丢。

## 测试

`bot/tests/bot/coc.test.ts` 七条：固定 rng 下的确定性折算与 24 次掷骰调用、`总值 = 8 项之和` 且含幸运一致、单张 embed 结构、多张合并（3 张卡 + 合计行）、数量边界（0→1、999→10 并说明）、`renderCardLines` 分栏、页脚固定为 `coc7e`。

## 曾考虑的替代方案

**复用 `/pc new` 的简化掷法** —— 与手册不符（体型/智力/教育应为 2D6+6）；但"顺手统一"会改变既有随机卡的取值区间，属于另一个决策，本次不做。已否决。

**掷出的卡直接落库** —— 掷 3 张就占 3 个卡位（每人上限 16），"挑一张"的用法会挤爆卡位列表；`/coc` 的定位是参考而非建卡。已否决。

**一张卡一条消息** —— 3 张卡刷 3 条消息，频道噪音大且难以横向比较。已否决。

**页脚写完整掷法说明** —— 用户明确要求"底部不要写一大坨规则，写 coc7e 就行"。已否决。

**用纯文本行代替 embed** —— 卡面数字对齐与多卡分块只能靠空格手排，embed 的 field 天然分块。已否决。

## 后果

- 收益：一次交互拿到 N 张卡与两个总值（含平均），不占卡位、不刷屏；embed 通道顺带铺好，此后带 embed 的命令可直接复用，且 embed 内容会进日志。
- 代价：`/pc new` 与 `/coc` **掷法不一致**（已知偏差，统一需要单独决策并同步既有测试）；embed 只作展示，交互组件仍走 `components`。
- 文档同步：`docs/Discord_CoC_Command_Set.md` §5.4 + §2 总览表、`bot/README.md`（命令数 19 → 20）。
