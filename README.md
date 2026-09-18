# dcdice-bot

把 `docs/Discord_CoC_Command_Set.md` 的指令规格落成可运行的 Discord 骰娘（TypeScript）。

**授权：AGPL-3.0-or-later**（见 `LICENSE`）——本仓库是 [Dice!](https://github.com/Dice-Developer-Team/Dice)（QQ 骰娘，AGPL-3.0-or-later，作者 w4123溯洄 / String.Empty）的 **Discord 移植**：行格式、房规判定、词库与日志格式都对齐其实现，开发期参考的源码放在工作区的 `ref/Dice`（**不随本仓库发布**）。按 AGPL §13，把本 bot 作为网络服务提供给他人时，需要让使用者能获得对应源码——本仓库即是源码。

规格不是"参考"，而是**构建输入**：`docs/discord-commands.json`（19 条命令的注册负载）被原样打进
`src/bot/spec/discord-commands.json`，由 `src/bot/manifest.ts` 载入并注册；`scripts/check-manifest.ts`
与 `tests/spec/manifest.test.ts` 保证代码与文档**永不漂移**。

## 目录结构

```
bot/
  src/contracts/     Lead 冻结的接口契约（Rng / DiceEngine / CocRules / BotStore / Platform / manifest 形状）
  src/dice/          掷骰引擎（.r 系列表达式语法，对齐 ref/Dice/Dice/RD.cpp）
  src/coc/           CoC 规则引擎（.st .rc .ra .sc .en 整行原文解析 + 房规 0-6）
  src/store/         JSON 持久化（角色卡 / 绑定 / 局 / 场景指针 / 房规 / 日志）
  src/bot/           命令清单、handler、注册表、路由、discord.js 适配
  scripts/           测试运行器与规格校验
  tests/             dice / coc / bot / spec / verify
```

分层原则：**handler 不 import discord.js**。它只拿到 `InteractionContext` + `HandlerDeps`
（store / dice / coc / rng / platform / now），返回 `ReplyPayload`；只有 `adapter.ts` 认识 discord.js。
所有随机都走注入的 `Rng`，因此测试完全确定性、不需要 token 或网络。

## 环境要求与运行

- Node.js **>= 22.18**（依赖原生 TypeScript 支持，直接 `node xxx.ts`）
- 依赖安装：`npm install --ignore-scripts`（本机沙箱禁止管道式 child spawn，构建脚本会 EPERM）

```bash
cd bot
npm install --ignore-scripts

npm run deploy   # 注册 slash 命令（需 token 与 application id）
npm run sync     # 把命令同步到 bot 当前所在的**所有**服务器（幂等，不重启也能用）
npm start        # 启动
```

> **命令同步是自动的**：`npm start` 启动时会对**当前已在的所有服务器**各注册一份 guild 命令；
> 之后被邀请进新服务器（`guildCreate`）时也会立刻给那个服务器补注册，无需任何手工操作。
> 只写 guild 作用域、不创建全局命令（同一 guild 里全局 + guild 同名命令会被客户端显示两遍）。
> `DCDICE_AUTO_SYNC_COMMANDS=0` 可关闭自动同步；`npm run sync` 用于手动补同步（命令定义变更、离线期间被邀请、CI 流程）。

两个脚本都用 `node --env-file-if-exists=.env`，所以把变量写进 `bot/.env` 即可（见 `.env.example`）：

| 变量 | 说明 |
| --- | --- |
| `DISCORD_TOKEN` | bot token（必填） |
| `DISCORD_APPLICATION_ID` | application id（`npm run deploy` 必填；别名 `CLIENT_ID`） |
| `DISCORD_GUILD_ID` | 可选；填了就把命令注册到该服务器（即时生效），否则只注册全局（别名 `GUILD_ID`） |
| `DISCORD_GUILD_IDS` | 可选；**多个**服务器 id（逗号/空格分隔），与 `DISCORD_GUILD_ID` 合并去重 |
| `DCDICE_AUTO_SYNC_COMMANDS` | 可选；设 `0` 关闭启动/入群时的自动同步 |
| `DCDICE_AUDIT_LOG` | 可选；设 `0` 关闭运行日志（默认开，见下） |
| `DCDICE_DATA_DIR` | 可选；数据目录，默认 `./data` |

## 日志转存到 Cloudflare R2（可选）

日志文件默认作为**Discord 附件**发送；配上 R2 后改为**上传对象存储 + 回执里只发链接**（服务器端上传，不受 Discord 附件大小/超时限制，日志也不会随消息过期）：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `R2_BUCKET` | ✅ | 桶名 |
| `R2_ACCESS_KEY_ID` | ✅ | R2 API Token 的 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | ✅ | 同上 Secret Access Key |
| `R2_ENDPOINT` 或 `R2_ACCOUNT_ID` | ✅（二选一） | 只给 `R2_ACCOUNT_ID` 会自动拼 `https://<account id>.r2.cloudflarestorage.com` |
| `R2_PREFIX` | ⬜ | 对象键前缀，默认 `dcdice-logs/`；对象键 = `<prefix><年>/<月>/<文件名>` |
| `R2_PUBLIC_BASE_URL` | ⬜ | 自定义域/公开域；填了发**直链**，不填发**预签名链接** |
| `R2_PRESIGN_TTL` | ⬜ | 预签名有效期（秒，60–604800），默认 604800（7 天） |
| `R2_REGION` | ⬜ | SigV4 scope 的 region，默认 `auto` |

- **开通步骤**：Cloudflare 面板 → **R2** → 建一个桶 → 右上 **Manage R2 API Tokens** → Create API Token（权限选 *Object Read & Write*，可限定到该桶）→ 记下 *Access Key ID* 与 *Secret Access Key*；*Account ID* 在 R2 概览页。
- **链接形式**：桶不公开时用默认的**预签名链接**（默认 7 天有效，回执里会提示"链接有有效期"）；想长期可点就给桶绑自定义域并填 `R2_PUBLIC_BASE_URL`。
- **降级行为**：`/log end`、`/game end` 逐个上传；R2 没配或上传失败时**自动回落到 Discord 附件**并在回执里写明原因；空日志不上传。启动日志会打印一次 `日志将上传到 R2：bucket=… prefix=… `。
- **实现**：SigV4 用 `node:crypto` 手写（**零运行依赖**），并用 AWS 官方实现 `aws4`（仅 devDependency）做**逐字符交叉校验**，见 `tests/bot/log-upload.test.ts`。

## 运行日志（journald）

每条 slash 命令写两行：**一行上下文 + 一行回执摘要**，用于事后排查"这个场景里为什么读不到卡 / 房规不对 / 子区没继承"：

```text
[2026-09-18 13:02:11] /rc user=甲(123456789012345678) scene=T7←C1 game=#1 阿卡姆 sheet=甲卡 rule=1(局) text="闪避"
    ↳ FAIL(ephemeral) 当前场景没有生效的角色卡，无法确定「闪避」的成功率。子区与频道各自独立…
```

- `scene=T7←C1`：命令发生在子区 `T7`，父频道是 `C1`；直接写在频道里就没有箭头。
- `game=`：解析到的局（没有则 `无`）；`sheet=`：解析到的角色卡（`无` = 这个场景按"局 → 本场景 → 父频道 → 全局"都找不到卡）。
- `rule=`：生效房规与来源（局 / 场景 / 默认）；`text="…"` 是原始参数（单行、超长截断）。
- 第二行：`OK/FAIL`（失败回执都是 `fail()` 产生的）、`public/ephemeral`、附件数、回执首行（≤200 字）。
- 按钮（二次确认）也会留一行：`button confirm user=U1`。
- 查看：

```bash
journalctl -u dcdice-bot -f                 # 实时
journalctl -u dcdice-bot --since "10 min ago" | grep '↳'    # 只看回执摘要
journalctl -u dcdice-bot --since today | grep '/rc '        # 只看某条命令
```

- 关闭：`.env` 里设 `DCDICE_AUDIT_LOG=0`（或只调低日志级别用 `journalctl` 过滤）。
- 异常（抛错）仍走原来的 `处理 /xxx 失败：…` 行，两者互补：**正常返回的失败回执**只有运行日志能看到。

## 邀请 bot 到服务器（必须带 `bot` scope）

**命令能显示 ≠ bot 已加入。** 只授权 `applications.commands` 时斜杠命令照样出现，但 bot
**没有成员身份、也没有身份组**，任何要发言/建子区的功能都会失败（`/game start` 建不了子区、
`/rh` 只能降级 ephemeral、日志收不到消息）。用下面这个链接重新授权即可（会同时补上托管身份组）：

```
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=397284592640
```

权限位 `397284592640` = ViewChannel, SendMessages, SendMessagesInThreads, CreatePublicThreads,
CreatePrivateThreads, ManageThreads, EmbedLinks, AttachFiles, ReadMessageHistory, UseApplicationCommands。

自检（REST 只读）：`node --env-file-if-exists=.env scripts/discord-perms.ts`
—— 会打印 bot 所在服务器数、托管身份组、逐项权限是否齐全；缺权限时直接给出上面的链接。
（Windows 本地跑该脚本时若撞上 Node 的 libuv 断言崩溃，请改在服务器上跑，服务器无此问题。）

## 校验

```bash
node scripts/check-manifest.ts   # 命令清单 vs docs/discord-commands.json（深度相等）
npx tsc --noEmit                 # 类型检查
node scripts/run-tests.ts        # 全量测试
node tests/dice/engine.test.ts   # 单个测试文件
npm run check                    # 上面三件事一起跑
```

> **为什么测试用 `node:test` 而不是 vitest**：最初是因为构建沙箱禁止**管道式**子进程（esbuild/tsx 会 `spawn EPERM`）；
> 现在权限已放开（`npx vitest --version` / `npx tsx --version` 都能跑），但仍然保留 `node:test`——零依赖、无配置、
> 单进程内执行、`node tests/bot/xxx.test.ts` 单文件即可调试。要用 vitest/tsx 也随时可以，不受本工程限制。
> 约定不变：相对导入**必须带 `.ts` 扩展名**（Node 原生 TS 的类型擦除要求）。

## 已实现的行为要点（与手册的对应）

- 整行原文解析：`/st` `/r` `/rh` `/rs` `/rc` `/ra` `/sc` `/en` 只暴露一个 `text` 选项，服务端按手册语法解析；`/st` 还会剥掉粘贴内容开头可能带的 `.st` / `/st` 前缀（连写卡片串同理），`.st clr` 依旧走二次确认
- 房规 0-6 的大成功/大失败判定、困难=目标/2、极难=目标/5、`3#` 多轮、`b/p` 奖惩骰、`k` 取大、`X` 乘号
- `/game`：多局并存（同服 `#N`）；`start` 默认**在子区开**（`thread:` 复用 / `here:true` 就地），并在父频道下建私密暗骰子区、自动开日志
- 上下文跟随：`/game switch` 后**角色卡 / 暗骰子区 / 房规**三项自动切换，解析顺序"局 > 场景 > 全局"；**日志不跟随局**——日志的作用域是"开 log 的那个场景"（单个频道或单个子区），不同频道/子区可以同时各开一条
- `/rh`：投递优先级 = 显式 `thread` > 本局暗骰子区 > 场景级登记 > 自动 `暗骰 · <场景名>`（**每个子区各一个，互不共用**）；`thread` 给出即持久化登记；**有局时只把本局 KP（`/game start keeper:`）拉进子区**，其他发起者不进子区、只拿到带骰值的 ephemeral 回显；**回执只给发起者，频道内不发任何暗骰消息**（无全体通知）
- `/log`：作用域是**当前场景**；`/log new` 只在本场景已有 `on` 日志时**拒绝**，其他频道/子区不受影响；`/log`（无参）默认记录**开 log 的那个场景**的发言，`/log end` 只结束本场景或指名的日志、在记录中不自动结束已有日志；`/log list`、`/log end [name]`
- `/game end`：默认**不归档**任何子区（`archive:true` 才归档，且只归档 bot 自建的），并把本局所有未结束日志导出

## 与 Dice! 对齐的部分

| 部分 | 说明 |
| --- | --- |
| 掷骰语法 | `N#` / `XdY` / `b`/`p` / `k` / `X` 乘号 / 算术，范围与自动排序对齐 `ref/Dice/Dice/RD.cpp`；`b`/`p` 省略骰子时默认百面骰（十位骰），写在非百面骰上表示额外同面数骰（`1d10b2` = 3 个 d10 取最大/最小，见 `src/dice/README.md`） |
| 检定房规 | 房规 0-6 边界对齐手册 §8.1；房规 6 的 1/100 特例取自 ref |
| **词库** | `/help` 无参 = Dice! 内置 `strHlpMsg` 总览，词条来自 `ref/Dice/Dice/GlobalVar.cpp` 抽取的 **351 条 messages + 148 条 HelpDoc 词条**（`scripts/import-dice-library.ts` 生成，可重跑） |
| 外部词库 | `DICE_LIBRARY_DIR=<目录>` 可覆盖/补充（`*.json`、简单 `*.yaml`，外部优先于内置）；Dice! 的规则书与牌堆词库是运行时下载的，仓库内没有，请用这个口子注入 |
| **日志格式** | 行 `名字(uid) YYYY-MM-DD HH:MM:SS\n内容\n\n`；文件名 `<局名>_<日志名>.txt`（两段同名时省略重复段 → `阿卡姆.txt`）；玩家消息与骰娘回执都入日志，`/log` 指令自身不入（对齐 `DiceEvent.cpp:188/222/239`、`DiceSession.cpp:200`） |
| **日志内容规则** | 场外话（全/半角 `(` `（` 开头的玩家消息）**不入日志**；`()  #  “”` 等特殊字符**原样保留**不转义；时间戳固定 `YYYY-MM-DD HH:MM:SS`，回退用的名字用带完整日期的 `YYYY-MM-DD HHMM`（Dice! 用的是裸 Unix 秒） |
| **日志改名迁移** | `npm run migrate-logs`（默认 dry-run，`--apply` 才写盘并备份 `logs.json`）：把旧的 `<桌名> · <时间戳>` 自动日志名迁成桌名，已结束的连导出文件一起改名，同服重名自动加 `_<logId>` |
| **日志里的名字** | 角色卡名（局 → 本场景 → 父频道 → 全局）→ 称呼 `/nn` → Discord 显示名；骰娘那行用服务器昵称 → 用户名。**每行重新解析**：中途 `/pc rename`、`/nn set`、切局只影响之后的行（对齐 `CharacterCard.cpp:737` `idx_pc`） |
| **logPainter 兼容** | 导出的 `.txt` 可直接粘进 `ref/logPainter`（`index.src.html:842` 的 `regHeader2` 正好匹配我们的行头；正文续行挂上一个说话人），已用它的正则实测 |
| 二次确认 | `/pc clr`、`/st clr` 首次只列销毁范围 + 「确认执行/取消」按钮，仅发起者可点，5 分钟过期（对齐规格 §16.6） |

## 已知限制

1. `/pc stat`：契约里没有掷骰历史存储，只输出角色卡规模（不伪造统计）。
2. `/ti` `/li`：内置症状表为**节选**，且无疯狂状态持久化。
3. `/help` `/rules`：内置小词库，非 Dice! 原版词库；未知词条给"你是不是想找"。
4. `/nn`：不做 `{nick}` 模板替换，只在掷骰/检定回执前加 `【称呼】`。
5. 全局默认卡（无局无场景时的回落层）使用 `@global` 键，只能在 DM 里用 `/pc tag` 设置。
6. `/game end` 把该局所有未结束日志作为**多个附件一次性发送**，未做 8 MiB / 多附件分片。
7. `/rh` 指向公开子区时的"保密性提示"是条件式文案：`Platform` 接口拿不到 channel type，无法判定公开/私密。
8. `main.ts` / `deploy.ts` 的**注册与同步逻辑**在仓库里只有类型检查与结构测试（真 token 只在服务器 `.env`），真实 Discord 行为靠线上运行验证；`respond` 未做 `deferReply`（各命令仅少量 REST 调用，需要时再加）。
9. 命令注册是 **guild 作用域**：新服务器靠 `guildCreate` / 启动时自动同步（`scripts/sync-commands.ts` 手动兜底）；全局命令保持 0 条，避免同一 guild 里显示两套。bot 离线期间被邀请也能在下次启动时补上。
9. 跨服同名局 id（两个服务器各有 `#1`）的房规与日志已隔离：规则/日志查询带 `guildId`，由 `tests/spec/guild-isolation.test.ts` 锁住；`GameRecord.id` 本身仍是服务器内唯一的 `#N`（显示口径与文档一致）。
10. **规则书与牌堆词库离线不可得**：Dice! 的 `.rules` 规则集来自 `http://api.kokona.tech:5555/rules`、牌堆来自运行时下载，仓库里没有数据文件。`/rules query` 离线只能命中内置词条与本机 COC7 术语层；请用 `DICE_LIBRARY_DIR` 注入官方词库。
11. 词条正文里的 Dice! 模板转义（`{self}` `{at:self}` `{case:...}`）原样保留，不展开；`/help` 总览是 `strHlpMsg` 原文 + 一行 `.xxx ↔ /xxx` 记法注记。
12. 日志正文不做 CQ 码过滤（Discord 无此概念），uid 用字符串 snowflake；无局场景日志的会话名回退为日志名。
13. `/pc clr` 在"没有角色卡"时直接提示、不出确认按钮（`/st clr` 同理）。
14. `/game start thread:` 不校验目标子区是否真实存在（Discord 的 CHANNEL 选项已保证是真实子区 id）。
15. manifest 里没有 `dm_permission` / `default_member_permissions`：权限全部在 handler 内校验。

## 独立验证

`tests/verify/**` 是独立验证者（不参与实现）写的规格对照测试，含：
- 房规 0-6 的独立 oracle（7 房规 × d100 1..100 × 28 档成功率零偏差）
- 掷骰语法/边界的逐值断言、percentile 奖惩骰取值
- manifest ↔ docs JSON 的 canonical 深度相等、命令与 handler 的一一对应
- 行为反例（权限、DM、子区失效回落等）

它发现并已修复的 2 个规格违背：`/rh` 自动子区未持久化复用（§4.2/§16.4）、本局暗骰子区失效后未回落（§16.11）。两条原始红测保留在 `tests/verify/behavior-rh-pc-setcoc.test.ts`，现在为通过状态。

第二轮验证（`tests/verify/w4-*.test.ts`，54 条）覆盖二次确认 / Dice! 词库 / Dice! 日志格式，并独立发现 3 个问题，均已修复并由 `tests/spec/round3-fixes.test.ts` 锁住：

1. **按钮结果不入日志**：`handleButtonInteraction` 走 `update` 而非 `respond`，导致"已销毁 1 张角色卡"这类最终结果没进日志。现已在按钮分支补 `appendBotReplyLine`。
2. **导出文件名碰撞**：`第一/夜` 与 `第一_夜` 清洗后同名，后导出的会覆盖前一条。现在导出时按已记录的 `fileName` 去重，冲突则加 `_<logId>`。
3. **外部词库大小写变体不覆盖内置**：Dice! 的 `dict_ci` 大小写不敏感，原先外部的 `{"R": ...}` 顶不掉内置 `r`。现在合并时按小写键顶替，`overview()` 也大小写不敏感，`stats()` 口径一致。

第三轮需求变更（已锁在 `tests/bot/rh.test.ts` + `tests/verify/behavior-rh-pc-setcoc.test.ts`）：

1. **暗骰成员只拉 KP**：本局 KP 由 `/game start keeper:` 指定，有局时 `/rh` 只把本局 KP 拉进私密子区，发起者本人（PL）不进子区，改为在**仅自己可见**的回执里看到骰值；`/rh keeper:` 只在无局时生效，有局时给了会在回执里说明被忽略（KP 不由 `/rh` 改）。
2. **暗骰子区按场景独立**：自动暗骰子区改为按**场景**缓存、命名 `暗骰 · <场景名>`，不同子区各开一个、互不串投（原先按父频道缓存，兄弟子区会共用同一个）。

---

## 授权（License）

本项目以 **GNU Affero General Public License v3.0 or later（AGPL-3.0-or-later）** 发布，全文见 [`LICENSE`](LICENSE)。

- **来源与署名**：这是 QQ 骰娘 [Dice!](https://github.com/Dice-Developer-Team/Dice)（AGPL-3.0-or-later，作者 **w4123溯洄 / String.Empty**）的 Discord 移植版。掷骰/检定语义、房规 0-6、日志行格式与文件名约定、词库抽取等都对齐上游实现；开发期参考的上游源码位于工作区 `ref/Dice`，**不在本仓库内**、也不随发布包分发。
- **你可以**：自由使用、修改、再分发，包括商用；条件是修改后的源码同样以 AGPL 提供，并保留版权与许可声明。
- **网络服务条款（§13）**：如果你把这个 bot 挂在服务器上给别人用（Discord 机器人正是这种形态），使用者有权拿到对应版本的源码。最省事的做法就是直接公开你的 fork（本仓库即源码）。
- **注意**：`ref/` 下的上游代码是 AGPL，本仓库不含其代码；若你把上游代码并入本项目，请保持 AGPL 并保留其版权头。
- 想让本仓库用别的协议（例如 MIT）**不可以**照搬上游实现细节与词库数据后再闭源——如需宽松许可，请先确认哪部分是可独立授权的原创代码。
3. **日志按场景隔离**：`/log` 的作用域是"开 log 的那个场景"，`/game switch` 不再搬走日志；不同频道/子区可同时各开一条；子区消息在子区没有生效日志时回落到父频道。
