# AGENTS.md

Agent Notes are agent-written RFCs that record the rationale and the rejected alternatives behind a durable decision. The contract for this repository is [.agents/notes/README.md](.agents/notes/README.md); work under `.agents/notes/` also follows [.agents/notes/AGENTS.md](.agents/notes/AGENTS.md).

## Repository layout

```
.agents/notes/README.md                                  the Agent Note contract
.agents/notes/{proposed,implemented,rejected}/<class>/   active notes
.agents/notes/archived/<class>/                          sealed artifacts + manifest.json
.agents/skills/archive-agent-notes/                      archive workflow
scripts/                                                 gates
```

## Commands

```sh
node scripts/verify-agent-note-classification.ts   # path and class
node scripts/verify-agent-note-format.ts           # header and required sections
node scripts/verify-archived-agent-notes.ts        # sealed archive; --write appends new seals
```

Run all three after touching `.agents/notes/` or `scripts/`.

## 本仓库（`dcdice-bot`）

上面是上游原文；本节只记录本仓库的事实，与契约冲突时以上游契约（`.agents/notes/README.md`）为准。

- 本仓库 = **骰娘源码 + Agent Notes**：`src/`、`tests/`、`scripts/`（三个门禁 + 各种工具），决策记录本体在 `.agents/notes/`，归档工作流在 `.agents/skills/archive-agent-notes/`。
- 工作区（`F:\Git\dcdice`）同级还有（都在本仓库之外）：`docs/`（指令集规格 `Discord_CoC_Command_Set.md` 与权威清单 `discord-commands.json`，`scripts/check-manifest.ts` 在仓库布局下会拿它与 `src/bot/spec/discord-commands.json` 镜像逐字节比对；在服务器部署包里找不到 `docs/` 时跳过这一步）、`logs-*/`（跑团日志归档，含玩家隐私，不入库）、`ref/Dice`（上游 Dice! 参考源码，不入库）。
- **来源**：`https://github.com/deshark42/agent-notes` @ `bd347ecfaea1a6ff1746972038a95bc984a2eba7`（2026-10-04），见 [.agents/UPSTREAM](.agents/UPSTREAM)。升级方式：重新 clone 上游，覆盖 `AGENTS.md`、`.agents/`、`scripts/agent-note-tree.ts`、`scripts/archived-agent-notes.ts`、`scripts/verify-agent-note-*.ts`（本节的本地说明不被覆盖）。
- 三面门禁也可用 npm：`npm run verify-agent-note-classification` / `verify-agent-note-format` / `verify-archived-agent-notes`。