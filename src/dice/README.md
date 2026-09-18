# `src/dice` — 掷骰引擎

规格来源：`docs/Discord_CoC_Command_Set.md` §4.1/§4.3、`docs/User_Manual.md` §.r、
参考实现 `ref/Dice/Dice/RD.cpp`、`RD.h`、`RDConstant.h`、`DiceEvent.cpp`。
契约（冻结，勿改）：`src/contracts/dice.ts`、`src/contracts/rng.ts`。

## 导出

```ts
import { createDiceEngine, parseRollText, renderRoll, createMathRng } from './dice/index.ts';
```

- `createDiceEngine(): DiceEngine` —— `roll(expression, rng)` 接受含 `N#` 前缀的表达式；
  `percentile({bonus, penalty}, rng)` 掷 d100 及奖惩骰。
- `parseRollText(text): RollTextParse` —— 拆 `expression` / `reason` / `rounds`。
- `renderRoll(result, {compact})` —— `compact:true` 等价 `/rs`（只给结果）。
- `createMathRng(): Rng` —— `Math.random` 实现；测试一律注入假 `Rng`。

## 语法与边界

| 片段 | 语义 | 边界 |
| --- | --- | --- |
| `N#` | 多轮（每轮重掷全部骰式） | 1-10（仅整数） |
| `XdY` | 掷 X 个 Y 面骰 | X 1-100，Y 1-1000 |
| `bN` / `pN` | 奖励 / 惩罚骰。**省略骰子时默认百面骰**：1 个 d100 + N 个十位骰（CoC 奖惩骰） | N 0-9（`b`/`p` 缺省 1） |
| `XdYbN` / `XdYpN`（Y ≠ 100） | **额外掷 N 个同面数骰**，奖励保留最大的 X 个、惩罚保留最小的 X 个（`1d10b2` = 3 个 d10 取最大） | N 0-9，X 1-100 |
| `kN` | 取最大 N 个 | 1 ≤ N ≤ 个数 |
| `X` / `x` / `*` | 乘号（常量） | 非负整数 |
| `/` | 除号（常量除数，按 C++ 整数截断取整） | >0 |
| `+` `-` | 算术项；`+-`/`--` 折叠 | 表达式不能以运算符结尾 |

其它：空表达式回落 `1d100`；`d`/`d100`/`D100` 都归一化为 `1d100`；
单个骰式一次掷出 **超过 20 个骰子** 时该轮点数升序排序并置 `sorted=true`
（RD.cpp:351/389）。非法输入一律 `{ ok:false, error }`，绝不抛异常；
假 `Rng` 返回越界值也只会变成错误结果。

## 契约字段约定（本模块的实现口径）

- `expression`：归一化写法，如 `3d6k2`、`3#1d6`、`1d10+1d6+3`、`b2`、`p1`（`1d100b2` → `b2`）、`*`→`X`。
- `groups[*].values`：**掷骰顺序**的全部点数。多轮时把每一轮的点数依次拼接
  （同一骰式的每轮个数固定，可按 `rounds` 切回），因此 `3#1d6` 的 `values` 是 3 个数。
  `keep` 存在时 `values` 仍保留全部点数，只有“取大”参与求和。
- `groups[*]`（百面骰奖惩骰）：`sides=100`，`values=[基数d100, ...十位骰]`；十位骰的存法与
  RD 一致（基数末位为 0 时存 `1..10`，否则存 `0..9`），`bonus`/`penalty` 记个数。
- `groups[*]`（非百面骰额外奖惩骰）：`sides=Y`，`values` 是 `X+N` 个同面数骰的原始点数，
  `bonus`/`penalty` 记额外个数；`keep` 存在时 `values` 同样保留全部点数。
- `modifier`：常量项（纯数字项，含其 `X`/`/` 折叠）的带符号和。骰式的 `X`/`/` 作用在该骰式
  自身，不进入 `modifier`；`totals`/`total` 才是权威结果。
- `totals`：每轮总点数，`total = Σ totals`。

## 奖惩骰取值依据（RD.cpp:202-275）

**形态 A：百面骰（省略骰子 / `1d100bN` / `bN`）**

- 先掷基数 `d100`，再为每个奖励/惩罚骰掷 `d10` 作为新的十位；**个位始终取基数的个位**。
- 十位映射：基数 `%10==0` 时用 `die(1..10)` 直接作十位，否则用 `die-1 (0..9)`。
- 奖励骰（B_Dice）取**最小**候选：`if (vintTmpRes[i] < intTmpD100/10)`；惩罚骰（P_Dice）取
  **最大**候选：`if (vintTmpRes[i] > intTmpD100/10)`。由于个位不变，比较十位等价于比较完整候选值。
- `percentile().candidates` 列出所有候选百面骰（基数额外十位替换后的值），**首位是选中值**；
  `value = tens*10 + units`，`100` 的 `tens=10, units=0`。
- `bonus` 与 `penalty` 同时给出时互相抵消（CoC 惯例），返回的是抵消后的生效个数。

**形态 B：非百面骰（`XdYbN` / `XdYpN`，Y ≠ 100）**

- 掷 `X + N` 个 `Y` 面骰，作为同权的一个大池；奖励保留最大的 `X` 个求和，惩罚保留最小的 `X` 个求和。
- `X = 1` 时就是取最大 / 最小：`1d10b2` 掷 3/8/2 → 8。
- 需求方口径（`1d10b2` = 多两个 10 面骰按奖惩规则取最大最小）；参考实现 `RD.cpp` 只认独立的
  `B`/`P` 项（一律百面骰），对本形态报错，本移植按需求方口径实现并有测试锁定。

## 渲染口径

- `compact:false` 模仿 `RD::FormCompleteString()`：`表达式=单骰点数=分项小计=总点数`，
  相邻重复段去重；奖惩骰显示 `45[奖励骰:2 6]`；非百面骰的额外奖惩骰显示「保留值[奖励骰:被丢掉的骰]」
  （`1d10b2` 掷 3/8/2 → `8[奖励骰:3 2]`）；乘除显示 `(3+4+5)×5`。
- `compact:true`：单轮 `表达式=总点数`；多轮 `表达式=每轮点数之和=总点数`。
- 多轮 `compact:false`：`表达式={ 第1轮; 第2轮; ... }=总和`。

## 与调用方的接缝（重要）

`parseRollText()` 按契约把 `N#` 从 `expression` 中拆出。因此 `/r` 处理器若要把多轮传下去，
需要自己拼回去：

```ts
const { expression, reason, rounds } = parseRollText(text);
const result = dice.roll(rounds > 1 ? `${rounds}#${expression}` : expression, rng);
```

`roll()` 本身也能直接吃整段原文里的表达式（含 `N#`），但**不接受**理由文本。
角色卡表达式名（如 `沙漠之鹰`）需要调用方先解析；直接 `roll('沙漠之鹰')` 会返回
“无法解析的掷骰表达式”（与 `RD` 一致；`DiceEvent.cpp` 的 `.r` 处理器在找不到角色卡表达式时
回落到默认 `d100` 并把原文当理由，这一层属于 bot 处理器）。
