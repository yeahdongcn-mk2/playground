# 扫雷联机对战设计说明

> 状态：设计稿（Issue #46 设计子任务 1-3，只出文档与契约测试，不写实现；最终版含实现清单、术语表与章节索引） · 范围：1v1 回合制联机扫雷
>
> 本文定义房间生命周期、状态同步与裁决协议、超时与断线重连边界、承载方案选型、实现阶段 issue 清单，以及它们与现有单机扫雷规则引擎参数化的关系。风格与 [贪食蛇设计说明](./snake-design.md)、[技术栈选型决策](./tech-stack-decision.md) 保持一致。

## 0. 章节索引

| 章节 | 内容 |
| --- | --- |
| [1. 背景与范围](#1-背景与范围) | 现状、目标与不在范围内的内容 |
| [2. 与现有单机玩法和规则引擎参数化的关系](#2-与现有单机玩法和规则引擎参数化的关系) | 复用什么、单机不回归的保障、排行榜与自定义难度的后续接入 |
| [3. 房间生命周期](#3-房间生命周期) | 状态、事件、转移、三种时限与 `design:room-lifecycle` 契约 |
| [4. 状态同步与裁决协议](#4-状态同步与裁决协议) | 回合制、共享棋盘、服务端权威、消息与 `design:protocol` 契约 |
| [5. 断线与重连](#5-断线与重连) | 心跳、宽限、席位、恢复、幂等与 `design:reconnect` 契约 |
| [6. 承载方案选型](#6-承载方案选型) | 候选方案、对比、选型、演进与 `design:hosting` 契约 |
| [7. 测试与验收](#7-测试与验收) | 文档契约测试与验收命令 |
| [8. 实现阶段 issue 清单](#8-实现阶段-issue-清单) | 依赖顺序、issue 内容与 `design:implementation-plan` 契约 |
| [9. 非目标与后续风险](#9-非目标与后续风险) | 首版不做的内容 |
| [10. 术语表](#10-术语表) | 房间、协议、重连与规则引擎术语 |

阅读顺序建议：先读第 2 节确认复用的引擎边界，再按第 3 → 4 → 5 → 6 节理解契约；实现前读第 8 节的任务图。

## 1. 背景与范围

当前仓库是纯静态前端：Vite 构建后直接部署 `dist/`，没有服务端、账号、房间组件或持久化数据；[框架说明](./framework.md) 第 1 节也把「实时对战」列为当前非目标。扫雷的规则引擎已经参数化：

- `MinesweeperConfig` 描述行、列、雷数与首点安全策略；
- `validateConfig()` 统一校验棋盘边界与雷数容量；
- `createSeededRng()` 提供可复现的 mulberry32 随机源；
- `src/games/minesweeper/difficulty.ts` 提供初级、中级、高级三档预设，并复用同一套校验。

上述规则与校验都位于 `src/games/minesweeper/engine.ts`，联机层只调用，不复制一份棋盘逻辑。

因此本设计不另起棋盘模型，而是在现有引擎之上增加一层「房间 + 协议 + 裁决」边界。本文要回答五件事：

1. 房间从创建到销毁经过哪些状态，哪些事件推动转移，三种时限分别在何时生效、到期后如何处置；
2. 同步采用回合制还是实时、棋盘是共享还是每人一份、谁裁决踩雷与胜负；
3. 消息有哪些、字段是什么，行动如何排序、去重与冲突处理，确定性从哪来；
4. 如何划分联机概念与单机状态模型，以及掉线检测、宽限期、重连恢复与宽限用尽后的结局；
5. 实现阶段按什么依赖顺序拆成哪些 issue，以及本文的术语与章节索引。

不在本文范围内：具体服务端实现、房间匹配、账号体系、排行榜、观战、聊天、持久化、道具与自定义规则扩展。本文只固定契约；`src/` 运行时代码在本子任务中不改动。

## 2. 与现有单机玩法和规则引擎参数化的关系

### 2.1 复用什么

联机服务端直接复用同一个纯规则引擎，而不是复制一份棋盘逻辑：

| 现有能力 | 联机用途 |
| --- | --- |
| `MinesweeperConfig` / `validateConfig`（`src/games/minesweeper/engine.ts`） | 建房时校验房间配置；非法配置在 `create` 就被拒绝 |
| `createSeededRng(seed)`（同文件） | 服务端为每局创建确定性随机源；客户端不自行生成雷盘 |
| `firstClickSafe` | 双方共享同一首点安全规则，首点必定安全 |
| `MinesweeperEngine` | 服务端持有唯一权威棋盘，接受行动并产出快照 |
| `MinesweeperSnapshot` | 作为服务端内部状态来源，投影成脱敏的客户端快照 |
| `difficulty.ts` 预设（`src/games/minesweeper/difficulty.ts`） | 房间难度选项来源，仍通过 `validateConfig` 校验 |
| `engine.test.ts` 的确定性用例 | 重放校验的基础：同一 seed、配置与行动顺序必须得到同一结果 |

### 2.2 不锁死现有单机状态模型

现有单机模型只有 `MinesweeperStatus = 'ready' | 'playing' | 'won' | 'lost'`，它描述的是**一块棋盘**，不是房间。联机设计刻意把两者分开：

- **房间状态机在引擎之外**。`waiting`、`ready`、`finished`、`dissolved` 等房间状态不会加入 `MinesweeperStatus`，也不会加入 `MinesweeperSnapshot`。
- **引擎仍是一局一份实例**。服务端每个房间、每局比赛创建一个 `MinesweeperEngine`；重开就是新建实例并换 seed，而不是在旧实例上叠加联机字段。
- **联机 DTO 与引擎类型分离**。协议中的 `snapshot`、`action`、`end` 是传输层对象；投影函数把 `MinesweeperSnapshot` 转成脱敏快照，不修改引擎返回值，也不把 socket、计时器或玩家信息塞进引擎。
- **单机入口、调试 API 与 e2e 不受影响**。`view.ts` 仍按 `MinesweeperSnapshot` 绘制；联机接入将是独立视图/路由，不复用单机调试参数的语义。
- **规则与裁决解耦**。引擎负责「这步是否踩雷、是否翻完」，房间层负责「轮到谁、是否超时、谁赢」。这样以后把同步方式从回合制改成别的形式，也不用重写规则引擎。

### 2.3 首点安全的确定性细节

现有引擎在**第一次翻开**时才布雷：首点安全区会排除雷，随机源在此时才被消耗。因此「seed 相同」本身不足以复现整局，**seed + 配置 + 有序行动日志（含第一次翻开）** 才是完整重放输入。联机协议据此规定：

- seed 由服务端生成，客户端不得指定或提前获知；
- 客户端永远不本地生成雷盘，只渲染服务端快照；
- 第一手翻开和后续所有行动都按 `seq` 记录，重放时按相同顺序喂给引擎；
- 开局时服务端先公布 seed 的哈希承诺，结束后再公布 seed，便于事后审计。

### 2.4 单机玩法不回归的保障

联机是新增的独立入口与视图，单机扫雷继续走现有路径：

- **状态模型不变**：`MinesweeperStatus` 仍只有 `ready` / `playing` / `won` / `lost`，`MinesweeperSnapshot` 不新增房间、玩家、socket 或计时字段；联机 DTO 在协议层单独定义。
- **规则引擎不改语义**：不修改 `src/games/minesweeper/engine.ts` 的默认棋盘、首点安全与布雷时机；联机只通过 `new MinesweeperEngine(config)` 注入 `MinesweeperConfig` 与 seed。
- **入口与路由不变**：单机扫雷的调试参数、难度选择与视图行为保持现状；联机使用独立路由/视图并按需加载，不进入大厅首屏包。
- **自动检查继续覆盖单机**：`engine.test.ts`、`difficulty.test.ts`、`view.test.ts` 与现有 e2e 保持通过；`npm run lint` 的边界检查确保游戏模块不反向依赖联机层。
- **部署不回归**：静态产物仍是默认发布物；联机房间服务是可选新增单元，房间服务不可用时单机与大厅仍可正常加载。
- **文档契约测试**：本文的五个 `design:*` JSON 块由 `tests/unit/minesweeper-online-design.test.ts` 校验，状态名、时限与承载选择的改动会在 CI 中暴露。

### 2.5 排行榜与自定义难度的后续接入

本设计不实现排行榜与自定义难度，但保留接入点，避免以后返工：

- **自定义难度**：单机的 `parseCustomDifficulty()` 已复用 `validateConfig()` 校验行、列、雷数与首点安全容量；联机建房可直接调用同一个校验函数，只接受 `MIN_ROWS`–`MAX_ROWS`、`MIN_COLS`–`MAX_COLS` 范围内且通过雷数与安全区检查的配置。首版联机固定 `firstClickSafe: true`；后续若要开放自定义，把校验后的 `MinesweeperConfig` 连同规则版本写入 `create` 与重放记录即可。
- **难度预设**：`src/games/minesweeper/difficulty.ts` 的初级/中级/高级仍是房间难度选项来源；自定义配置通过同一 `validateConfig` 校验，不另写一套边界。
- **排行榜**：首版 `end` 已携带 `matchId`、`winnerId`、`finalSnapshot` 与 seed，服务端保留 replay 记录；后续排行榜应以服务端权威结果为准，按「规则版本 + 配置（行/列/雷数/首点策略）+ 模式」分组，不接受客户端上报成绩。排行字段可以新增在结算服务或 `end` 的扩展字段中，不需要改动房间状态机、同步协议或 `MinesweeperStatus`。
- **范围边界**：以上两项都需要新的产品决策（排行维度、账号/匿名、自定义参数范围），因此不在本设计或实现 issue 清单的首版范围内，只确认为兼容方向。

## 3. 房间生命周期

### 3.1 状态

| 状态 | 含义 | 生效时限 |
| --- | --- | --- |
| `idle` | 尚未创建房间；`create` 请求通过校验前的初始态 | 无 |
| `waiting` | 房间已创建，座位未满或尚未全员就绪 | 等待加入 / 准备时限 |
| `ready` | 座位已满且全员就绪，等待房主开局 | 等待加入 / 准备时限 |
| `playing` | 服务端持有权威棋盘，按回合接受行动 | 回合时限 + 整局时限 |
| `finished` | 本局已结束并保留结果，可重开或解散；终态 | 无（重开窗口由房间层另行清理） |
| `dissolved` | 房间已销毁，不可恢复；终态 | 无 |

### 3.2 事件与转移

| 事件 | 来源 | 作用 |
| --- | --- | --- |
| `create` | 客户端 | `idle → waiting`，服务端校验配置并分配 `roomId` |
| `join` | 客户端 | `waiting → waiting`，直到座位满 |
| `ready` | 客户端 | 全员就绪时 `waiting → ready`；有人取消时 `ready → waiting` |
| `start` | 房主 | `ready → playing`，生成 `matchId`、seed 与权威棋盘 |
| `action` | 当前回合玩家 | `playing → playing`；非法/过期行动不产生转移 |
| `end` | 服务端 | `playing → finished`（踩雷、翻完安全格、认输或超时裁决） |
| `timeout` | 服务端 | `waiting`/`ready → dissolved`，或 `playing → finished` |
| `rematch` | 双方 | `finished → ready`，保留座位，换新 seed |
| `leave` | 客户端 | 非对局阶段离房；对局中的连接断开不算房间事件 |
| `dissolve` | 房主或服务端 | `waiting` / `ready` / `playing` / `finished → dissolved` |

```text
idle ──create──▶ waiting ──join──▶ waiting ──ready(全员)──▶ ready ──start──▶ playing
                    │                  │                       │                  │
                    │ timeout(join)    │ unready               │ timeout(join)    │ action（自环）
                    ▼                  │                       ▼                  ▼
                dissolved ◀────────────┘                   dissolved          playing
                                                                                  │
                                                        end / timeout(turn|match) ▼
                                                                              finished
                                                                                  │ rematch
                                                                                  └──────▶ ready
finished ──dissolve──▶ dissolved
```

`playing` 中的 socket 断开只更新玩家 presence，不产生新的房间状态；只有 `timeout` 事件让房间进入 `finished` 或 `dissolved`。这是断线超时功能的边界，详见第 5 节。

### 3.3 契约 JSON

下方 `design:room-lifecycle` JSON 是自动化测试读取的权威状态机；文字、表格与 JSON 冲突时以 JSON 为准，并应同步修正测试期望。

<!-- design:room-lifecycle -->
```json
{
  "version": 1,
  "initial": "idle",
  "terminalStates": ["finished", "dissolved"],
  "terminalExitEvents": ["rematch", "dissolve"],
  "capacity": 2,
  "states": [
    {
      "name": "idle",
      "kind": "pre-room",
      "timers": [],
      "description": "尚未创建房间；收到 create 请求并通过校验后进入 waiting。"
    },
    {
      "name": "waiting",
      "kind": "lobby",
      "timers": ["join"],
      "description": "房间已创建，等待第二位玩家加入并等待所有人就绪。"
    },
    {
      "name": "ready",
      "kind": "lobby",
      "timers": ["join"],
      "description": "座位已满且所有玩家已就绪，等待房主 start。"
    },
    {
      "name": "playing",
      "kind": "match",
      "timers": ["turn", "match"],
      "description": "服务端持有唯一权威棋盘，按回合接受行动。"
    },
    {
      "name": "finished",
      "kind": "terminal",
      "timers": [],
      "description": "本局已结束并保留结果，可 rematch 或 dissolve。"
    },
    {
      "name": "dissolved",
      "kind": "terminal",
      "timers": [],
      "description": "房间已销毁；不可恢复，也无法重开。"
    }
  ],
  "events": [
    {
      "name": "create",
      "source": "client",
      "description": "创建房间请求通过协议版本、配置与容量校验。"
    },
    {
      "name": "join",
      "source": "client",
      "description": "玩家加入未满员的房间。"
    },
    {
      "name": "ready",
      "source": "client",
      "description": "玩家设置或取消就绪；全员就绪时 waiting 进入 ready，取消就绪时 ready 回到 waiting。"
    },
    {
      "name": "start",
      "source": "client",
      "description": "房主在 ready 状态开局；服务端生成 matchId、seed 与权威棋盘。"
    },
    {
      "name": "action",
      "source": "client",
      "description": "当前回合玩家提交翻开或插旗；正常行动保持 playing。"
    },
    {
      "name": "end",
      "source": "server",
      "description": "踩雷、翻完安全格、认输或超时裁决导致本局结束。"
    },
    {
      "name": "timeout",
      "source": "server",
      "description": "join、turn 或 match 计时器到期；由服务端发布。"
    },
    {
      "name": "rematch",
      "source": "client",
      "description": "finished 后双方接受重开，回到 ready。"
    },
    {
      "name": "dissolve",
      "source": "client-or-server",
      "description": "房主解散、服务端清理或不可恢复错误导致房间销毁。"
    },
    {
      "name": "leave",
      "source": "client",
      "description": "非对局阶段玩家离房；对局中的连接断开不触发本事件。"
    }
  ],
  "timers": {
    "join": {
      "scope": "waiting|ready",
      "defaultMs": 120000,
      "start": "create",
      "reset": "on-rematch",
      "onExpire": "dissolve",
      "reason": "join-timeout"
    },
    "turn": {
      "scope": "playing",
      "defaultMs": 30000,
      "start": "turn-start",
      "reset": "accepted-action-or-turn-change",
      "onExpire": "end",
      "reason": "turn-timeout"
    },
    "match": {
      "scope": "playing",
      "defaultMs": 900000,
      "start": "start",
      "reset": "never",
      "onExpire": "end",
      "reason": "match-timeout"
    }
  },
  "transitions": [
    {
      "id": "t-create",
      "from": "idle",
      "event": "create",
      "to": "waiting",
      "guard": "请求通过协议版本、MinesweeperConfig 校验与容量校验"
    },
    {
      "id": "t-join",
      "from": "waiting",
      "event": "join",
      "to": "waiting",
      "guard": "仍有空位且玩家未被封禁"
    },
    {
      "id": "t-ready-all",
      "from": "waiting",
      "event": "ready",
      "to": "ready",
      "guard": "座位已满且所有玩家 ready"
    },
    {
      "id": "t-unready",
      "from": "ready",
      "event": "ready",
      "to": "waiting",
      "guard": "任一玩家取消 ready"
    },
    {
      "id": "t-start",
      "from": "ready",
      "event": "start",
      "to": "playing",
      "guard": "房主发起且所有玩家仍在线"
    },
    {
      "id": "t-action",
      "from": "playing",
      "event": "action",
      "to": "playing",
      "guard": "当前回合玩家、turnId 与 seq 合法，且行动未结束比赛"
    },
    {
      "id": "t-end",
      "from": "playing",
      "event": "end",
      "to": "finished",
      "guard": "踩雷、翻完所有安全格、认输或超时裁决"
    },
    {
      "id": "t-join-timeout-waiting",
      "from": "waiting",
      "event": "timeout",
      "to": "dissolved",
      "timer": "join",
      "guard": "创建后 join 计时器到期仍未开局"
    },
    {
      "id": "t-join-timeout-ready",
      "from": "ready",
      "event": "timeout",
      "to": "dissolved",
      "timer": "join",
      "guard": "ready 状态下 join 计时器到期仍未开局"
    },
    {
      "id": "t-turn-timeout",
      "from": "playing",
      "event": "timeout",
      "to": "finished",
      "timer": "turn",
      "guard": "当前玩家行动计时器或断线宽限期到期"
    },
    {
      "id": "t-match-timeout",
      "from": "playing",
      "event": "timeout",
      "to": "finished",
      "timer": "match",
      "guard": "整局计时器到期，按进度判定"
    },
    {
      "id": "t-rematch",
      "from": "finished",
      "event": "rematch",
      "to": "ready",
      "guard": "双方仍在线且都接受重开"
    },
    {
      "id": "t-leave-waiting",
      "from": "waiting",
      "event": "leave",
      "to": "waiting",
      "guard": "非房主离房且仍有座位"
    },
    {
      "id": "t-leave-waiting-dissolve",
      "from": "waiting",
      "event": "leave",
      "to": "dissolved",
      "guard": "房主离房或房间已无玩家"
    },
    {
      "id": "t-leave-ready",
      "from": "ready",
      "event": "leave",
      "to": "waiting",
      "guard": "非房主在开局前离房，座位不再满"
    },
    {
      "id": "t-leave-ready-dissolve",
      "from": "ready",
      "event": "leave",
      "to": "dissolved",
      "guard": "房主在开局前离房"
    },
    {
      "id": "t-dissolve-waiting",
      "from": "waiting",
      "event": "dissolve",
      "to": "dissolved",
      "guard": "房主解散或服务端清理"
    },
    {
      "id": "t-dissolve-ready",
      "from": "ready",
      "event": "dissolve",
      "to": "dissolved",
      "guard": "房主解散或服务端清理"
    },
    {
      "id": "t-dissolve-playing",
      "from": "playing",
      "event": "dissolve",
      "to": "dissolved",
      "guard": "服务端故障或运维终止，不产生胜负"
    },
    {
      "id": "t-dissolve-finished",
      "from": "finished",
      "event": "dissolve",
      "to": "dissolved",
      "guard": "重开窗口结束或房主关闭房间"
    }
  ]
}
```

### 3.4 三种时限与超时处置

| 时限 | 覆盖范围 | 默认值 | 起算 / 重置 | 到期处置 |
| --- | --- | ---: | --- | --- |
| 等待加入（`join`） | `waiting` 与 `ready` | 120 s | `create` 时起算；重开时从 `rematch` 重新起算 | 房间 `dissolved`，客户端收到 `timeout` + `room_closed` |
| 回合 / 行动（`turn`） | `playing` 的当前回合 | 30 s | 每次进入新回合或服务端接受一个行动时重置 | 当前玩家判负，对手获胜；`playing → finished` |
| 整局（`match`） | 整个 `playing` | 15 min | `start` 时起算，不因暂停/断线重置 | 按已翻开的安全格数判定；相同则平局；`playing → finished` |

补充规则：

- `ready` 不单独设准备计时器；它与 `waiting` 共用从建房开始的 `join` 时限，避免「最后一秒加入、马上被准备超时踢掉」的不公平。
- `join` 到期是**解散房间**，不产生胜负；`turn` / `match` 到期是**结束本局**，产生 `end` 结果并在 `finished` 保留。
- `turn` 与 `match` 同时到期时，先到期的计时器生效；服务端按到期事件串行处理，保证只产生一个终态。
- 超时由服务端计时器触发，客户端时间只用于展示倒计时，不能作为裁决依据。
- 重开（`rematch`）回到 `ready` 后，`join` 时限重新起算；新一局使用新 seed，旧局行动日志不再复用。
- 房间层在 `finished` 保留结果一段时间供双方查看；窗口结束或房主关闭时通过 `dissolve` 进入终态 `dissolved`。

## 4. 状态同步与裁决协议

### 4.1 选型

| 维度 | 决策 | 理由 |
| --- | --- | --- |
| 同步模型 | **回合制** | 扫雷没有连续运动，只有离散的翻开/插旗；回合制把行动串行化，天然容忍网络延迟，不需要时钟同步或高频广播 |
| 棋盘 | **共享一份** | 服务端只维护一个权威 `MinesweeperEngine`；双方看到同一块脱敏棋盘，踩雷即分出胜负，状态与重放都只有一条主线 |
| 裁决权 | **服务端权威** | 雷盘、行动合法性、超时与胜负都由服务端决定；客户端只提交意图并渲染快照 |
| 传输 | WebSocket + JSON | 双向、低开销、便于房间广播；首版数据结构简单，JSON 足够且易调试 |
| 确定性 | 服务端 seed + 首点安全 + 有序行动日志 | 复用 `createSeededRng()` 与引擎的首点布雷逻辑；seed 不交给客户端生成 |

**为什么不是实时制**：实时制要处理高频状态广播、客户端时钟偏移、插值与回滚，还会让「谁先点到」变成网络条件比赛。扫雷的玩法收益不足以抵消这些复杂度。未来若做「同一 seed 各自棋盘的速度赛」，也应作为独立模式重新评审，而不是修改本协议的语义。

**为什么不是每人一份棋盘**：每人一份会带来多实例、双份快照、跨棋盘公平性和双方进度比较；共享棋盘则只有一个权威状态，冲突处理、观战、重放和断线恢复都更直接。代价是双方轮流行动、节奏较慢，首版接受这个取舍。

**为什么不是主机权威或客户端上报加校验**：主机权威把裁决权交给其中一名玩家，主机断线、作弊或版本不一致都会阻塞整局；客户端上报加校验需要客户端维护完整雷盘（或至少可信状态），既泄漏信息又制造状态分歧。服务端权威的代价是必须有房间服务，这与「纯静态部署」的现状冲突，因此第 6 节单独说明承载方式。

### 4.2 棋盘与可见性

- 服务端在 `start` 时创建 `matchId`、生成 seed，并用 `MinesweeperConfig` + `createSeededRng(seed)` 创建权威引擎实例。
- 引擎在第一次 `reveal()` 时才布雷，首点安全区由 `firstClickSafe` 保证；服务端记录这第一手，作为重放输入的一部分。
- `snapshot` 只包含已翻开格子的 `adjacentMines`、`revealed`、`flagged`，**不包含未翻开的 `mine` 字段**；`seedHash` 只用于承诺审计，不是 seed 本身；只有 `end` 的 `finalSnapshot` 才公布全部雷位。
- 双方收到同一份脱敏棋盘；不存在某个玩家的私有棋盘或私有雷盘。
- 插旗是共享动作，双方都能看到；插旗消耗一个回合，避免无限插旗拖延。

### 4.3 消息总览

```text
A: create ─────────────▶ room_state(waiting)
B: join ───────────────▶ room_state(waiting)
A/B: ready ────────────▶ room_state(ready)      // 全员就绪
A: start ──────────────▶ snapshot(playing)
A: action(reveal) ─────▶ action_result + snapshot(广播)
B: action(flag) ───────▶ action_result + snapshot(广播)
B: action(reveal) ─────▶ ... 踩雷 ──▶ end
A/B: rematch ──────────▶ room_state(ready)
```

方向约定：`client-to-server` 表示客户端意图，`server-to-client` 表示服务端权威结果或广播。所有成功改变状态的服务端消息都带单调递增的 `seq`；客户端只渲染 `seq` 不小于本地已应用值的消息。

### 4.4 契约 JSON

下方 `design:protocol` JSON 是自动化测试读取的权威消息表；字段类型是传输层名义类型，具体对象形状由服务端与客户端共享的 DTO 定义。

<!-- design:protocol -->
```json
{
  "version": 1,
  "implementationStatus": "design-only",
  "transport": {
    "kind": "websocket",
    "path": "/api/games/minesweeper/rooms/:roomId/socket",
    "encoding": "json",
    "reconnect": "player-token"
  },
  "syncModel": "turn-based",
  "authority": "server",
  "board": "shared",
  "playersPerRoom": 2,
  "turn": {
    "actionsPerTurn": 1,
    "firstTurn": "host",
    "order": "seat-order",
    "flagConsumesTurn": true
  },
  "adjudication": {
    "mineHit": "server",
    "winCondition": "opponent-hit-mine-or-all-safe-revealed",
    "engine": "MinesweeperEngine",
    "serverValidates": ["turn", "turnId", "seq", "bounds", "cellState", "deadline"]
  },
  "seed": {
    "source": "server",
    "algorithm": "mulberry32",
    "firstClickSafe": true,
    "clientMayChooseSeed": false,
    "commitment": "sha256(seed)",
    "replayRecord": ["seed", "config", "orderedActions"]
  },
  "ordering": {
    "mode": "server-serialized",
    "sequence": "monotonic-seq",
    "clientExpectedSeq": true,
    "idempotencyKey": "actionId",
    "conflict": "reject-stale-and-resync",
    "turnOwnership": "only-current-player"
  },
  "visibility": {
    "snapshotHidesMines": true,
    "revealMinesAt": "end",
    "perPlayerView": "same-redacted-board"
  },
  "disconnect": {
    "presence": "per-player",
    "graceMs": 15000,
    "immediateRoomTransition": false,
    "resume": "snapshot-at-current-seq",
    "expiry": "timeout"
  },
  "hosting": {
    "requiresServer": true,
    "staticHostingOnly": false,
    "mvp": "node-websocket-room-service",
    "stateStore": "in-memory",
    "persistence": "none",
    "reason": "共享权威棋盘无法只靠静态前端承载"
  },
  "messages": [
    {
      "type": "create",
      "direction": "client-to-server",
      "fields": [
        {"name": "requestId", "type": "string", "required": true},
        {"name": "protocolVersion", "type": "integer", "required": true},
        {"name": "config", "type": "MinesweeperConfig", "required": true},
        {"name": "displayName", "type": "string", "required": true}
      ]
    },
    {
      "type": "join",
      "direction": "client-to-server",
      "fields": [
        {"name": "requestId", "type": "string", "required": true},
        {"name": "protocolVersion", "type": "integer", "required": true},
        {"name": "roomId", "type": "string", "required": true},
        {"name": "playerToken", "type": "string", "required": false},
        {"name": "displayName", "type": "string", "required": true}
      ]
    },
    {
      "type": "ready",
      "direction": "client-to-server",
      "fields": [
        {"name": "roomId", "type": "string", "required": true},
        {"name": "requestId", "type": "string", "required": true},
        {"name": "ready", "type": "boolean", "required": true}
      ]
    },
    {
      "type": "start",
      "direction": "client-to-server",
      "fields": [
        {"name": "roomId", "type": "string", "required": true},
        {"name": "requestId", "type": "string", "required": true}
      ]
    },
    {
      "type": "action",
      "direction": "client-to-server",
      "fields": [
        {"name": "roomId", "type": "string", "required": true},
        {"name": "matchId", "type": "string", "required": true},
        {"name": "actionId", "type": "string", "required": true},
        {"name": "seq", "type": "integer", "required": true},
        {"name": "turnId", "type": "integer", "required": true},
        {"name": "kind", "type": "reveal|flag", "required": true},
        {"name": "row", "type": "integer", "required": true},
        {"name": "col", "type": "integer", "required": true},
        {"name": "clientTimeMs", "type": "integer", "required": true}
      ]
    },
    {
      "type": "rematch",
      "direction": "client-to-server",
      "fields": [
        {"name": "roomId", "type": "string", "required": true},
        {"name": "requestId", "type": "string", "required": true},
        {"name": "accept", "type": "boolean", "required": true}
      ]
    },
    {
      "type": "leave",
      "direction": "client-to-server",
      "fields": [
        {"name": "roomId", "type": "string", "required": true},
        {"name": "requestId", "type": "string", "required": true}
      ]
    },
    {
      "type": "room_state",
      "direction": "server-to-client",
      "fields": [
        {"name": "roomId", "type": "string", "required": true},
        {"name": "seq", "type": "integer", "required": true},
        {"name": "state", "type": "RoomState", "required": true},
        {"name": "hostId", "type": "string", "required": true},
        {"name": "capacity", "type": "integer", "required": true},
        {"name": "players", "type": "PlayerView[]", "required": true},
        {"name": "playerToken", "type": "string", "required": false},
        {"name": "config", "type": "MinesweeperConfig", "required": true},
        {"name": "matchId", "type": "string|null", "required": true},
        {"name": "turnPlayerId", "type": "string|null", "required": true},
        {"name": "joinDeadlineAt", "type": "integer", "required": true},
        {"name": "deadlineAt", "type": "integer|null", "required": true},
        {"name": "stateReason", "type": "string|null", "required": true}
      ]
    },
    {
      "type": "snapshot",
      "direction": "server-to-client",
      "fields": [
        {"name": "roomId", "type": "string", "required": true},
        {"name": "matchId", "type": "string", "required": true},
        {"name": "seq", "type": "integer", "required": true},
        {"name": "turnPlayerId", "type": "string", "required": true},
        {"name": "turnId", "type": "integer", "required": true},
        {"name": "seedHash", "type": "string", "required": true},
        {"name": "deadlineAt", "type": "integer", "required": true},
        {"name": "matchDeadlineAt", "type": "integer", "required": true},
        {"name": "elapsedMs", "type": "integer", "required": true},
        {"name": "engineStatus", "type": "playing|won|lost", "required": true},
        {"name": "mineCount", "type": "integer", "required": true},
        {"name": "remainingMines", "type": "integer", "required": true},
        {"name": "revealedSafeCount", "type": "integer", "required": true},
        {"name": "board", "type": "RedactedBoard", "required": true}
      ]
    },
    {
      "type": "action_result",
      "direction": "server-to-client",
      "fields": [
        {"name": "roomId", "type": "string", "required": true},
        {"name": "matchId", "type": "string", "required": true},
        {"name": "actionId", "type": "string", "required": true},
        {"name": "seq", "type": "integer", "required": true},
        {"name": "turnId", "type": "integer", "required": true},
        {"name": "accepted", "type": "boolean", "required": true},
        {"name": "reason", "type": "string|null", "required": true},
        {"name": "revealedCells", "type": "Cell[]", "required": true},
        {"name": "flaggedCell", "type": "Cell|null", "required": true},
        {"name": "turnPlayerId", "type": "string", "required": true},
        {"name": "deadlineAt", "type": "integer", "required": true}
      ]
    },
    {
      "type": "end",
      "direction": "server-to-client",
      "fields": [
        {"name": "roomId", "type": "string", "required": true},
        {"name": "matchId", "type": "string", "required": true},
        {"name": "seq", "type": "integer", "required": true},
        {"name": "reason", "type": "match-reason", "required": true},
        {"name": "winnerId", "type": "string|null", "required": true},
        {"name": "loserId", "type": "string|null", "required": true},
        {"name": "finalSnapshot", "type": "RevealedBoard", "required": true},
        {"name": "seed", "type": "integer", "required": true},
        {"name": "stats", "type": "MatchStats", "required": true}
      ]
    },
    {
      "type": "timeout",
      "direction": "server-to-client",
      "fields": [
        {"name": "roomId", "type": "string", "required": true},
        {"name": "matchId", "type": "string|null", "required": true},
        {"name": "seq", "type": "integer", "required": true},
        {"name": "timer", "type": "join|turn|match", "required": true},
        {"name": "subjectId", "type": "string|null", "required": true},
        {"name": "deadlineAt", "type": "integer", "required": true},
        {"name": "resultingState", "type": "RoomState", "required": true},
        {"name": "reason", "type": "string", "required": true}
      ]
    },
    {
      "type": "room_closed",
      "direction": "server-to-client",
      "fields": [
        {"name": "roomId", "type": "string", "required": true},
        {"name": "seq", "type": "integer", "required": true},
        {"name": "reason", "type": "string", "required": true},
        {"name": "finalState", "type": "RoomState", "required": true}
      ]
    },
    {
      "type": "error",
      "direction": "server-to-client",
      "fields": [
        {"name": "requestId", "type": "string|null", "required": true},
        {"name": "roomId", "type": "string|null", "required": true},
        {"name": "code", "type": "string", "required": true},
        {"name": "message", "type": "string", "required": true},
        {"name": "retryable", "type": "boolean", "required": true},
        {"name": "currentSeq", "type": "integer|null", "required": true}
      ]
    }
  ]
}
```

### 4.5 行动顺序、冲突与幂等

服务端为每个房间维护单线程事件队列，所有行动按到达顺序串行处理：

1. **回合归属**：只有 `turnPlayerId` 的行动会被接受；其他玩家的行动返回 `not-your-turn`，不改变状态、不消耗回合。
2. **版本校验**：客户端带 `seq`（它最后应用的服务端序号）与 `turnId`。`seq` 落后时返回 `stale-state` 并附带最新 `snapshot`；客户端不得自动重放未确认的旧行动，只重新提交当前意图。
3. **幂等**：每个行动有客户端生成的 `actionId`。服务端缓存最近一段窗口内的 `actionId → action_result`；重复提交直接返回缓存结果，不重复应用。网络重试不会多走一步。
4. **合法性**：服务端校验坐标边界、格子状态（已翻开/已插旗）、`kind` 与当前回合；非法行动返回 `invalid-action`，不消耗回合，也不重置 `turn` 截止时间。
5. **接受与广播**：合法行动使 `seq + 1`、`turnId + 1`（若未结束），服务端应用引擎，先向行动者回 `action_result`，再向双方广播新的 `snapshot`；若踩雷或翻完安全格，紧接着广播 `end`。
6. **同回合并发**：双方几乎同时提交时，先到者按上述规则胜出，后到者因 `seq` / `turnId` 或回合归属失败；服务端从不合并两个行动。
7. **重复/乱序消息**：`seq` 小于等于本地已应用值的广播被丢弃；`actionId` 重复按幂等返回；`turnId` 与当前值不符按过期处理。

### 4.6 延迟、重连与重放

- **客户端时钟不可信**：`deadlineAt` 是服务端时间戳；客户端可估算偏移做倒计时，但服务端只按自己的计时器裁决。过期到达的行动返回 `deadline-passed`，不应用。
- **乐观更新受限**：客户端可以对「待确认」格子显示 pending 样式，但不得在服务端确认前翻开雷或改变 HUD 的权威计数；一切以 `snapshot` / `action_result` 为准。
- **重连**：首次 `join` 成功时，服务端只在发给该玩家的 `room_state` 副本中签发 `playerToken`，广播副本不含该字段；重连时客户端带 `playerToken` 重新 `join`，服务端校验 token 与房间，若对局仍在则下发当前 `snapshot`（当前 `seq`、`seedHash`）与 `room_state`，不要求客户端重放离线期间的行动。若房间已 `finished`，下发 `end` 结果；若 `dissolved`，返回 `room-not-found`。
- **重放**：服务端记录 `matchId`、`config`、`seed`、按 `seq` 排序的已接受行动（含第一次翻开）以及每步结果。重放时用同一 `createSeededRng(seed)`、同一 `firstClickSafe` 配置和同一行动顺序重新运行引擎，逐步比对快照摘要。开局时 `snapshot.seedHash` 公布 seed 的哈希承诺，`end` 时才随结果公布 seed 本身，防止客户端提前算雷。
- **审计边界**：客户端只拿到脱敏快照，无法据此复原未翻开雷位；服务端日志是唯一事实来源。

### 4.7 断线超时的状态边界（同步协议与断线语义的分界）

断线与超时被刻意放在房间状态机之外，避免把「连接状态」误建模成「房间状态」：

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| 连接层 | `online` / `reconnecting` / `offline` 的 presence、`playerToken` 会话、宽限计时 | 房间状态、胜负、棋盘 |
| 房间 FSM | `waiting` / `ready` / `playing` / `finished` / `dissolved` 与转移 | socket 生命周期、心跳 |
| 引擎层 | 棋盘、踩雷、翻开、插旗 | 玩家在线状态、回合归属 |

明确规则：

- `playing` 中 socket 断开**不触发**房间转移；`disconnect.immediateRoomTransition` 固定为 `false`。
- 连接层用 5 s 间隔、连续错过 2 次的心跳检测掉线（共 10 s 阈值），确认掉线后只更新该玩家的 presence，并启动 `disconnect.graceMs`（15 s）宽限计时；宽限内重连取消计时，棋局继续。
- 若宽限期到期且轮到该玩家，服务端发出 `timeout(timer=turn)`，按回合超时判负；若未轮到该玩家，则只标记离线，等其回合再按 `turn` 时限处理。
- `match` 时限不因断线暂停；断线不能用来逃避整局计时。
- 只有服务端 `timeout` / `end` 事件能让房间离开 `playing`；连接层不得直接改房间状态。
- 重连恢复使用 `snapshot-at-current-seq`，不做“回滚到断线前”的语义；具体检测阈值、宽限结局与恢复细节见第 5 节。

## 5. 断线与重连

第 4.7 节只固定了「断线不直接改房间状态」的边界；本章在第 3.4 节的三种时限之上补齐掉线检测、宽限期、席位保留、重连恢复、幂等与房主掉线规则。下方 `design:reconnect` JSON 是这些阈值与结局的权威来源，文字与 JSON 冲突时以 JSON 为准。

### 5.1 心跳与掉线检测

- 传输层使用 WebSocket 应用层 ping/pong：服务端每 5 s 发一次 `ping`，客户端在同一条连接上回 `pong`；服务端记录最后有效心跳时间，客户端时钟不参与判定。
- 连续错过 2 个心跳周期（10 s）仍收不到有效 `pong`，服务端把该玩家 presence 置为 `offline`，并启动宽限计时。检测阈值 10 s 小于宽限 15 s，也小于回合时限 30 s。
- 心跳只更新 presence，不产生房间事件，不改变 `seq`、`turnId`、`seed` 或棋盘；presence 是连接层状态，不进入 `RoomState`。
- 单次丢包或后台节流不直接判掉线；必须连续错过 `missedBeats` 次心跳才进入 `offline`，避免把短暂抖动当成弃局。
- 房间状态仍只有 `idle` / `waiting` / `ready` / `playing` / `finished` / `dissolved`；`online` / `reconnecting` / `offline` 只存在于连接层。

### 5.2 宽限期、席位保留与暂停语义

- 检测到掉线后启动 15 s 宽限（`graceMs`），席位保留：该 `playerToken` 对应的座位不会被其他玩家占用，`players` 中仍保留该玩家（presence 标记为 `offline`）。
- 掉线期间**不暂停**：`turn` 与 `match` 计时器照常运行，`match` 时限不因掉线或重连重置。断线不能用来逃避整局时限，也不能让对手无限等待。
- 宽限内重连：取消宽限计时，presence 回到 `online`，不产生房间转移，也不改变 `seq`；回合与整局计时器继续按原 `deadlineAt` 走。
- 宽限用尽前不允许对手顶替该座位；`waiting` / `ready` 中的空位只有在服务端确认释放席位后才允许新玩家 `join`。
- 客户端只展示服务端 `deadlineAt` 的倒计时，不能用自己的时钟提前或推迟判负。

### 5.3 重连与状态恢复

- 重连沿用 `join` 消息与 `playerToken`：客户端带原 token、`roomId`、协议版本重新 `join`；服务端校验 token 与房间，校验通过后把新 socket 绑定到原玩家，而不是创建新座位。
- 恢复方式是**全量快照**：服务端下发当前 `room_state` 与当前 `seq` 的 `snapshot`（含 `turnPlayerId`、`turnId`、`seedHash`、`deadlineAt`、`matchDeadlineAt`、脱敏棋盘与计数），客户端整体重绘；不重放离线期间的增量事件，也不重发未确认行动。
- 恢复粒度由房间状态决定：
  - `waiting` / `ready`：恢复座位与 `room_state`；对局尚未开始，不产生棋盘快照。
  - `playing`：恢复当前 `snapshot` 与房间状态；若离线期间本局已结束，则改为下发 `end` 结果与 `room_state(finished)`。
  - `finished`：结果仍在保留窗口内时，恢复 `end` 结果与 `room_state(finished)`，并允许在窗口内接受 `rematch`。
  - `dissolved`：房间已销毁，返回 `room-not-found` / `room_closed`，不恢复座位或结果。
- 重连不改变状态机：`playing` 中重连仍是 `playing`，`finished` 中重连仍是 `finished`；只有 `timeout` / `end` / `rematch` / `dissolve` / `leave` 等既有事件能推动转移。
- 同一 `playerToken` 只允许一个活动 socket：新连接建立时旧连接收到 `session-replaced` 并关闭，避免双端同时行动；后建立的连接不重置 `turn` / `match` 截止时间。

### 5.4 幂等与重复提交

- 重连本身幂等：同一 `playerToken` 在宽限内重复 `join` 只返回当前 `room_state` + `snapshot`，不重复占座、不新建玩家、不重置宽限计时。
- `action` 幂等沿用第 4.5 节：`actionId` 在服务端保留窗口内只应用一次，重复提交返回缓存的 `action_result`，不增加 `seq` / `turnId`。
- 重复 `timeout` 只按 `seq` 发布一次；客户端丢弃 `seq` 不大于本地已应用值的消息。
- 宽限用尽触发的判负也只产生一个 `timeout` 与一个 `end`；重连与超时同时到达时由服务端串行队列决定先后，先被接受的一方生效，另一方按状态已变化拒绝，不产生第二个终态。

### 5.5 房主掉线与主机迁移

- 承载选型是服务端权威（第 6 节），**不是 P2P**；裁决、棋盘与计时器都在服务端，因此不存在「主机迁移」。房主掉线不会把权威状态交给其中一名玩家；若未来改成 P2P，需要重新设计权威与迁移规则，不属于本设计。
- 房主在 `waiting` / `ready` 掉线：宽限内重连恢复房主身份；宽限用尽仍离线时，房间失去开局能力，按 `leave` 解散（`waiting → dissolved` 或 `ready → dissolved`）。
- 非房主在 `waiting` / `ready` 掉线：宽限内恢复；宽限用尽后服务端释放席位，`waiting` 保持 `waiting`，`ready` 回到 `waiting`。被释放的 `playerToken` 失效，之后回来只能按新 `join` 处理（若房间仍有空位）。
- 房主在 `playing` / `finished` 掉线：与普通玩家相同，对局继续；服务端仍持有权威棋盘，房主身份在剩余房间生命周期内保留，不转交他人。若房主在重开窗口内一直离线，房间按第 3.4 节的窗口规则 `dissolve`。

### 5.6 宽限期用尽后的结局

| 掉线时状态 | 掉线者 | 宽限用尽后的结局 | 房间转移 |
| --- | --- | --- | --- |
| `waiting` | 非房主 | 释放席位 | `waiting → waiting`（`leave`） |
| `ready` | 非房主 | 释放席位，座位不再满 | `ready → waiting`（`leave`） |
| `waiting` / `ready` | 房主 | 解散房间 | `→ dissolved`（`leave`） |
| `playing` | 当前回合玩家 | 判负，对手获胜 | `playing → finished`（`timeout(turn)`） |
| `playing` | 非当前回合玩家 | 保留席位；轮到他时按 `turn` 时限判负；若 `match` 先到期则按整局时限结算 | `playing → finished`（`timeout(turn\|match)`） |
| `finished` | 任意 | 保留结果，不转移；重开窗口结束后解散 | 无（窗口结束走 `dissolve`） |
| `dissolved` | 任意 | 不可恢复 | 无（`room-not-found`） |

补充：

- `playing` 中宽限用尽但未轮到掉线者时，不会立刻改房间状态；等服务端把回合交给他，再由 `turn` 计时器按 30 s 判负。`match` 时限先到则按第 3.4 节按进度判定，不因掉线特殊处理。
- 双方都掉线时不另设「双方掉线」状态；仍由先到期的 `turn` / `match` 计时器产生 `finished`，由服务端串行队列保证只产生一个结果。
- `join` 时限（120 s）与宽限期独立：宽限期只保留席位，不延长房间等待加入的总时限；`join` 到期仍然 `dissolved`。
- 宽限用尽只对 `playing` 产生判负；`waiting` / `ready` 是释放席位或解散，不产生胜负。

### 5.7 契约 JSON

下方 `design:reconnect` JSON 是断线重连规则的权威来源；测试将它和 `design:room-lifecycle` / `design:protocol` 交叉校验。

<!-- design:reconnect -->
```json
{
  "version": 1,
  "status": "design-only",
  "heartbeat": {
    "channel": "websocket-ping-pong",
    "intervalMs": 5000,
    "missedBeats": 2,
    "detectMs": 10000,
    "clock": "server",
    "onDetect": "offline"
  },
  "grace": {
    "graceMs": 15000,
    "startsAt": "offline-detect",
    "seatReserved": true,
    "pauseOnDisconnect": false,
    "pauseTimers": false,
    "playingCurrent": "forfeit",
    "playingOther": "wait-until-turn",
    "lobby": "release-seat-or-dissolve",
    "finished": "retain-result"
  },
  "forfeit": {
    "timer": "turn",
    "timeoutMs": 30000,
    "startsAt": "turn-start",
    "when": "offline-and-current-player",
    "outcome": "finished"
  },
  "recovery": {
    "method": "snapshot-at-current-seq",
    "eventReplay": false,
    "auth": "playerToken",
    "includes": ["room_state", "snapshot", "deadlines", "presence"],
    "onFinished": "end",
    "onDissolved": "room-not-found"
  },
  "idempotency": {
    "reconnect": "player-token",
    "duplicateJoin": "reuse-seat",
    "duplicateAction": "actionId-cache",
    "duplicateTimeout": "once-per-seq",
    "socketRace": "newest-wins"
  },
  "hosting": {
    "topology": "server-authoritative",
    "p2p": false,
    "hostMigration": "not-applicable",
    "hostDisconnectInLobby": "dissolve",
    "hostDisconnectInMatch": "normal-player"
  },
  "states": [
    {
      "name": "idle",
      "reconnect": "rejected",
      "reason": "room-not-created",
      "graceOutcome": "none",
      "recovery": "room-not-found"
    },
    {
      "name": "waiting",
      "reconnect": "allowed",
      "reason": "seat-reserved-within-grace",
      "graceOutcome": "release-seat",
      "recovery": "room-state"
    },
    {
      "name": "ready",
      "reconnect": "allowed",
      "reason": "seat-reserved-within-grace",
      "graceOutcome": "release-seat",
      "recovery": "room-state"
    },
    {
      "name": "playing",
      "reconnect": "allowed",
      "reason": "seat-reserved-within-grace",
      "graceOutcome": "forfeit-or-wait-turn",
      "recovery": "snapshot-at-current-seq"
    },
    {
      "name": "finished",
      "reconnect": "allowed",
      "reason": "result-retained",
      "graceOutcome": "retain-result",
      "recovery": "end-result"
    },
    {
      "name": "dissolved",
      "reconnect": "rejected",
      "reason": "terminal",
      "graceOutcome": "none",
      "recovery": "room-not-found"
    }
  ],
  "outcomes": [
    {
      "id": "waiting-join-timeout",
      "kind": "timeout",
      "from": "waiting",
      "event": "timeout",
      "to": "dissolved",
      "timer": "join",
      "transition": "t-join-timeout-waiting",
      "guard": "join 计时器到期仍未开局"
    },
    {
      "id": "ready-join-timeout",
      "kind": "timeout",
      "from": "ready",
      "event": "timeout",
      "to": "dissolved",
      "timer": "join",
      "transition": "t-join-timeout-ready",
      "guard": "join 计时器到期仍未开局"
    },
    {
      "id": "playing-turn-timeout",
      "kind": "forfeit",
      "from": "playing",
      "event": "timeout",
      "to": "finished",
      "timer": "turn",
      "transition": "t-turn-timeout",
      "guard": "回合到期，或宽限用尽且轮到掉线者"
    },
    {
      "id": "playing-match-timeout",
      "kind": "timeout",
      "from": "playing",
      "event": "timeout",
      "to": "finished",
      "timer": "match",
      "transition": "t-match-timeout",
      "guard": "整局计时器到期，按进度判定"
    },
    {
      "id": "waiting-seat-release",
      "kind": "seat-release",
      "from": "waiting",
      "event": "leave",
      "to": "waiting",
      "transition": "t-leave-waiting",
      "guard": "非房主宽限用尽，释放席位但房间仍有空位"
    },
    {
      "id": "ready-seat-release",
      "kind": "seat-release",
      "from": "ready",
      "event": "leave",
      "to": "waiting",
      "transition": "t-leave-ready",
      "guard": "非房主宽限用尽，座位不再满"
    },
    {
      "id": "waiting-host-dissolve",
      "kind": "host-disconnect",
      "from": "waiting",
      "event": "leave",
      "to": "dissolved",
      "transition": "t-leave-waiting-dissolve",
      "guard": "房主宽限用尽，房间失去开局能力"
    },
    {
      "id": "ready-host-dissolve",
      "kind": "host-disconnect",
      "from": "ready",
      "event": "leave",
      "to": "dissolved",
      "transition": "t-leave-ready-dissolve",
      "guard": "房主宽限用尽，房间失去开局能力"
    },
    {
      "id": "reconnect-waiting",
      "kind": "reconnect",
      "from": "waiting",
      "to": "waiting",
      "transition": "state-preserving",
      "recovery": "room-state"
    },
    {
      "id": "reconnect-ready",
      "kind": "reconnect",
      "from": "ready",
      "to": "ready",
      "transition": "state-preserving",
      "recovery": "room-state"
    },
    {
      "id": "reconnect-playing",
      "kind": "reconnect",
      "from": "playing",
      "to": "playing",
      "transition": "state-preserving",
      "recovery": "snapshot-at-current-seq"
    },
    {
      "id": "reconnect-finished",
      "kind": "reconnect",
      "from": "finished",
      "to": "finished",
      "transition": "state-preserving",
      "recovery": "end-result"
    },
    {
      "id": "reconnect-dissolved",
      "kind": "reconnect",
      "from": "dissolved",
      "to": "dissolved",
      "transition": "rejected",
      "recovery": "room-not-found"
    }
  ]
}
```

## 6. 承载方案选型

第 4 节固定了「服务端权威 + 共享棋盘 + 回合制」，第 5 节固定了断线重连语义；本节回答权威状态放在哪里、现有静态前端如何接入，以及该选择与 [技术栈选型决策](./tech-stack-decision.md) 的纯静态部署、[框架说明](./framework.md) 的非目标之间的关系。下方 `design:hosting` JSON 是选型的权威来源；文字、表格与 JSON 冲突时以 JSON 为准。

### 6.1 候选方案

| 编号 | 方案 | 形态 |
| --- | --- | --- |
| A | **独立服务端（独立房间服务）**（选用） | 现有静态前端继续由静态托管提供；另加一个独立的 Node WebSocket 房间服务，持有房间状态、权威 `MinesweeperEngine`、seed 承诺与计时器。客户端通过同域反向代理或可配置的 `wss://` 地址连接。 |
| B | **现有静态前端 + 第三方实时通道** | 客户端直接接入托管实时服务（托管 WebSocket 如 Ably / Pusher，或 WebRTC 数据通道平台）传递消息，不新增自有常驻服务。 |
| C | 纯静态前端 + P2P / 主机权威 | 两个浏览器直接互连，由其中一名玩家计算权威棋盘；仅作为对比项，不满足第 4 节的权威要求。 |
| D | Serverless 短连接轮询 | 静态前端按回合轮询无状态函数，房间状态放在外部存储。 |

A 与 B 是本次需要决定的两种承载方式；C、D 作为已评估的替代项保留，避免后续重复讨论。

### 6.2 对比

| 维度 | A 独立服务端 | B 现有静态前端 + 第三方实时通道 | 结论 |
| --- | --- | --- | --- |
| 部署与运维 | 新增一个独立部署单元（进程/容器）：WebSocket 升级、TLS、健康检查、日志与同域反代；单实例内存态，无数据库。 | 不新增自有进程，但需要供应商项目、密钥、区域与配额；托管通道不执行游戏规则，权威状态与计时器仍要另找运行位置。 | A 把新增复杂度收敛在一个可测试的服务里；B 把复杂度转移到供应商配置与跨边界排障。 |
| 成本 | 一个最小常驻实例加带宽；MVP 无持久化、无数据库账单，成本可预测。 | 免费额度可覆盖演示，但按连接、消息或时长计费；心跳、重连和广播会放大用量，若再用供应商函数承载权威逻辑还会叠加调用与存储费用。 | A 更适合首版预算；B 适合连接层规模远大于逻辑复杂度的场景，本项目不是。 |
| 延迟 | 客户端到同域/就近区域单跳 WebSocket；回合制下一次行动确认只增加一个 RTT，广播给双方各一跳，30 s 回合时限有充足余量。 | 托管边缘的接入延迟通常也低，但权威逻辑若在自有服务与供应商之间往返会多一跳；WebRTC 数据面最低，却无法同时提供可信裁决。 | 回合制不追求毫秒级同步，A 的单跳已足够，B 的延迟优势不构成选型理由。 |
| 权威与反作弊 | 权威引擎、seed 承诺、行动校验与计时器在同一服务进程内；客户端只提交意图、接收脱敏快照，无法提前算雷或篡改结果。 | 纯消息通道没有裁决能力，裁决只能落在客户端或对端；若改用供应商 serverless 函数执行规则，则要按供应商运行时重写房间原子性、计时器与恢复语义。 | A 直接满足第 4 节的服务端权威；B 要么违反权威要求，要么退化成「第三方托管服务端」。 |
| 断线恢复 | 服务端持有 `playerToken`、presence、15 s 宽限、`deadline` 与全量快照；重连按 `snapshot-at-current-seq` 恢复，与第 5 节逐条一致。 | 供应商可提供连接恢复与 presence，但席位保留、宽限到期判负、整局计时不暂停仍要自有状态层；供应商的重连窗口/TTL 与设计阈值不一致时还需要适配。 | A 的断线语义完全可控；B 会把连接生命周期与房间语义拆到两个系统。 |
| 数据与隐私 | 只有临时 token、脱敏快照和行动经过自有服务；对局不持久化、不接账号，日志与保留策略自己控制。 | 消息经过第三方处理器，需要评估数据驻留、日志保留与委托处理条款；WebRTC 直连还可能暴露玩家 IP，需要 TURN 中继与隐私说明。 | A 的数据边界更小、更容易解释；B 引入额外的合规与信任面。 |
| 可测试性 | Node 服务可在 Vitest 中用进程内引擎 + fake timers 覆盖房间、协议与超时；本地 WebSocket + Playwright 可复现端到端，CI 不依赖外部账号。 | 需要供应商沙箱、录制回放或适配层 mock；presence 与重连窗口由供应商实现，CI 难以完整复现生产语义。 | A 的契约测试与现有单测方式一致；B 的回归信号更弱。 |
| 与现有文档目标的关系 | `dist/` 静态产物仍是默认发布物，现有单机游戏部署不变；联机是显式新增的独立服务，不把大厅改成 SSR，也不改变首屏体积约束。ADR-001 的纯静态基线与 `framework.md` 的「实时对战非目标」继续约束现状，本设计是范围扩展，实现阶段需在那两份文档中登记。 | 表面上更接近纯静态，但权威逻辑仍要落在客户端或供应商服务端，无法真正零后端；纯 P2P 甚至违反服务端权威。 | 两种方案都会扩展「纯静态」边界；A 的扩展是显式、可审计的，B 只是把服务端藏到第三方。 |

### 6.3 选型与理由

**选型：A 独立服务端（独立房间服务）**（`choice: dedicated-room-service`）。

- **权威与反作弊**：A 把引擎、seed 承诺、行动校验和计时器放在同一个可信进程里，客户端拿不到未翻开的雷位；B 的通道本身没有裁决能力，纯 P2P 更把棋盘交给对端，二者都不满足第 4 节。
- **部署与运维**：A 只增加一个独立部署单元，静态产物和现有发布链不变；B 虽然不自建进程，但供应商配置、配额、区域和跨边界排障会成为新的运维面，而权威状态仍要自有服务承载。
- **成本**：A 是最小常驻实例加带宽，MVP 无数据库和持久化账单；B 按连接、消息或时长计费，心跳、重连和广播会放大用量，预算随活跃度波动。
- **延迟**：A 是单跳 WebSocket，回合制下一次行动确认只多一个 RTT；B 的托管边缘接入同样可以很低，但权威逻辑跨自有服务与供应商往返时会多一跳，WebRTC 的低延迟又换不来权威裁决。
- **断线恢复**：A 的 `playerToken`、presence、15 s 宽限、`deadline` 和全量快照都在同一状态机里，能逐条实现第 5 节；B 的连接恢复与 presence 由供应商定义，席位保留、到期判负和整局计时不暂停仍要自有层实现。
- **数据与隐私**：A 只传输临时 token、脱敏快照和行动，对局不持久化、不接账号；B 让消息经过第三方处理器，需要额外评估数据驻留、日志保留与委托处理条款，WebRTC 直连还会暴露 IP。
- **可测试性**：A 可以用进程内引擎 + fake timers 测房间、协议与超时，本地 WebSocket + Playwright 就能覆盖端到端，CI 不依赖外部账号；B 依赖供应商沙箱、录制回放或 mock，回归信号的完整性更弱。
- **与静态部署的关系**：A 保留 `dist/` 静态产物和现有单机游戏部署，只把联机作为显式新增服务；ADR-001 的纯静态基线与 `framework.md` 的「实时对战非目标」仍是现状约束，实现阶段需要在那两份文档中登记这次范围扩展。B 表面上更接近纯静态，但权威逻辑仍落在客户端或供应商服务端，并不能真正零后端。

**被否方案及原因：**

- **B 第三方实时通道**（`third-party-realtime`）：纯通道只解决消息传输、连接管理和可选 presence，不执行扫雷规则与权威裁决；权威状态仍要落到可信服务端。若把权威逻辑放进供应商函数，又会绑定其运行时、计时器模型和数据边界，首版引入的依赖与合规面大于省下的连接层代码。
- **C 纯静态 P2P / 主机权威**（`p2p-host-authority`）：主机权威把裁决交给一名玩家，主机可作弊或修改棋盘；主机断线会阻塞整局，纯 P2P 也没有可信 seed 与统一计时器，与第 4 节服务端权威直接冲突。
- **D Serverless 短连接轮询**（`serverless-polling`）：回合制虽然低频，但房间广播、三套计时器和 15 s 宽限都需要常驻或可原子唤醒的权威状态；短连接轮询在延迟、连接成本和断线恢复语义上都不占优，留作未来演进备选。

### 6.4 演进路径

首版只做单实例、内存态。以下演进不改变第 4、5 节的客户端协议与断线语义：

| 阶段 | 变更 | 不变量 |
| --- | --- | --- |
| 单实例 MVP | 现有静态站点 + 独立 Node WebSocket 房间服务；内存房间表、无持久化，同域反代或客户端配置服务地址。 | 第 4、5 节的协议、`seq` 单调性、seed 承诺、宽限与计时器语义不变；服务重启视为 `dissolved`。 |
| 多实例分片 | 按 `roomId` 把房间固定到实例（一致性哈希或房间目录），共享存储只放房间→实例索引与 presence；跨实例重连先查路由。 | 单房间仍单线程串行；客户端协议与 `snapshot-at-current-seq` 恢复方式不变。 |
| 传输层替换 | 若自建连接层的运维/带宽成本高于收益，可只把客户端到服务端的传输换成托管 WebSocket 或 WebRTC 数据通道，权威房间逻辑仍在自有服务。 | 权威模型与 `choice` 不变；需重新评估供应商延迟、配额、数据边界和断线窗口是否匹配第 5 节。 |
| 托管房间运行时 | 若供应商的有状态运行时能执行完整权威逻辑、计时器与原子房间操作，可把房间服务整体迁移。 | 必须通过本文全部契约测试并保持第 5 节断线语义，否则不迁移。 |

触发重新评估的条件（与 `design:hosting.reevaluateWhen` 一致）：

- 单实例无法承载并发房间数，或房间服务的运维成本超出维护预算；
- 第三方实时通道在总成本、延迟或隐私条款上显著优于自托管，且不牺牲权威裁决；
- 需要多区域部署、跨区域重连或更强的一致性保障；
- 供应商提供可验证的有状态房间运行时，并能通过本文契约测试。

### 6.5 部署约束（仅设计约束，不在本子任务实现）

- 静态站点仍由现有静态托管提供，构建产物仍是 `dist/`；联机功能新增独立房间服务，不改变现有游戏的构建与首屏预算。
- 房间服务单实例、内存态、无持久化：不接账号，玩家用临时 `playerToken` 标识；服务重启或崩溃视为房间 `dissolved`。
- 同一房间的单线程事件队列、权威 `MinesweeperEngine` 与三套计时器都在房间服务内；客户端不得直连数据库或其他可变状态。
- 静态站点与房间服务可同域反向代理，也可通过客户端环境变量配置服务地址；具体变量名留到实现子任务，本文不引入运行时代码。
- `docs/tech-stack-decision.md` 的纯静态部署与 `docs/framework.md` 的「实时对战非目标」是现状约束；本设计新增的联机能力在实现阶段需要同步更新这两处表述与部署说明，本子任务只记录关系，不改写它们的结论。

### 6.6 契约 JSON

`design:hosting` JSON 是选型、对比维度、被否原因与演进路径的权威来源；测试会校验 `choice` 属于 `candidates`、`rejected` 每项都有理由、必需维度齐全，并交叉检查协议中的 `hosting` 约束。

<!-- design:hosting -->
```json
{
  "version": 1,
  "status": "design-only",
  "choice": "dedicated-room-service",
  "candidates": [
    {
      "id": "dedicated-room-service",
      "title": "独立服务端（独立房间服务）",
      "description": "现有静态前端继续由静态托管提供；另加独立的 Node WebSocket 房间服务，持有房间状态、权威引擎、seed 承诺与计时器。",
      "staticFrontend": true,
      "ownServer": true,
      "thirdPartyRealtime": false,
      "authority": "server"
    },
    {
      "id": "third-party-realtime",
      "title": "现有静态前端 + 第三方实时通道",
      "description": "静态前端直接接入托管 WebSocket / WebRTC 服务传输消息；纯通道不执行游戏规则，权威逻辑仍要另找可信运行位置。",
      "staticFrontend": true,
      "ownServer": false,
      "thirdPartyRealtime": true,
      "authority": "none"
    },
    {
      "id": "p2p-host-authority",
      "title": "纯静态前端 + P2P / 主机权威",
      "description": "两个浏览器直接互连，由其中一名玩家计算权威棋盘。",
      "staticFrontend": true,
      "ownServer": false,
      "thirdPartyRealtime": false,
      "authority": "client"
    },
    {
      "id": "serverless-polling",
      "title": "Serverless 短连接轮询",
      "description": "静态前端按回合轮询无状态函数，房间状态放在外部存储。",
      "staticFrontend": true,
      "ownServer": false,
      "thirdPartyRealtime": false,
      "authority": "server"
    }
  ],
  "rejected": [
    {
      "id": "third-party-realtime",
      "reason": "纯实时通道只提供消息传输、连接管理和可选 presence，不执行扫雷规则与权威裁决；权威状态仍要落到可信服务端。把权威逻辑放进供应商函数又会绑定其运行时、计时器模型和数据边界，首版引入的依赖与合规面大于省下的连接层代码。"
    },
    {
      "id": "p2p-host-authority",
      "reason": "主机权威把裁决交给一名玩家，主机可作弊或改棋盘；主机断线会阻塞整局，纯 P2P 也没有可信 seed 与统一计时器，与第 4 节服务端权威直接冲突。"
    },
    {
      "id": "serverless-polling",
      "reason": "回合制虽然低频，但房间广播、三套计时器和 15 s 宽限都需要常驻或可原子唤醒的权威状态；短连接轮询在延迟、连接成本和断线恢复语义上都不占优，留作未来演进备选。"
    }
  ],
  "reasons": [
    {
      "dimension": "deployment-ops",
      "label": "部署与运维",
      "choice": "只新增一个独立部署单元，静态产物和现有发布链不变；单实例内存态，职责限于连接、房间、引擎与计时器。",
      "alternative": "不新增自有进程，但供应商项目、密钥、区域、配额与跨边界排障成为新的运维面；权威状态和计时器仍要另找运行位置。"
    },
    {
      "dimension": "cost",
      "label": "成本",
      "choice": "一个最小常驻实例加带宽，MVP 无数据库和持久化账单，成本可预测；扩容按房间数线性增加。",
      "alternative": "按连接、消息或时长计费，心跳、重连和广播会放大用量；若再用供应商函数承载权威逻辑还会叠加调用与存储费用。"
    },
    {
      "dimension": "latency",
      "label": "延迟",
      "choice": "客户端到同域或就近区域的单跳 WebSocket；回合制下一次行动确认只增加一个 RTT，广播给双方各一跳，30 s 回合时限有充足余量。",
      "alternative": "托管边缘接入通常也低，但权威逻辑跨自有服务与供应商往返会多一跳；WebRTC 数据面最低，却无法同时提供可信裁决。"
    },
    {
      "dimension": "authority-anti-cheat",
      "label": "权威与反作弊",
      "choice": "权威引擎、seed 承诺、行动校验与计时器在同一服务进程内；客户端只提交意图并渲染脱敏快照，无法提前算雷或篡改结果。",
      "alternative": "纯消息通道没有裁决能力，裁决只能落在客户端或对端；供应商函数方案虽可承载逻辑，但要按供应商运行时重写房间原子性、计时器与恢复语义。"
    },
    {
      "dimension": "disconnect-recovery",
      "label": "断线恢复",
      "choice": "服务端自己持有 playerToken、presence、15 s 宽限、deadline 与全量快照，重连按 snapshot-at-current-seq 恢复，与第 5 节逐条一致。",
      "alternative": "供应商可提供连接恢复与 presence，但席位保留、宽限到期判负和整局计时不暂停仍要自有状态层；其重连窗口与 TTL 和设计阈值不一致时还要适配。"
    },
    {
      "dimension": "data-privacy",
      "label": "数据与隐私",
      "choice": "只有临时 token、脱敏快照和行动经过自有服务；对局不持久化、不接账号，日志与保留策略自己控制。",
      "alternative": "消息经过第三方处理器，需要额外评估数据驻留、日志保留与委托处理条款；WebRTC 直连还可能暴露玩家 IP，需要 TURN 中继和隐私说明。"
    },
    {
      "dimension": "testability",
      "label": "可测试性",
      "choice": "Node 服务可在 Vitest 中用进程内引擎与 fake timers 覆盖房间、协议和超时；本地 WebSocket + Playwright 可复现端到端，CI 不依赖外部账号。",
      "alternative": "需要供应商沙箱、录制回放或适配层 mock；presence 与重连窗口由供应商实现，CI 难以完整复现生产语义，回归信号更弱。"
    },
    {
      "dimension": "static-deployment-alignment",
      "label": "与静态部署目标的关系",
      "choice": "保留 dist/ 静态产物和现有单机游戏部署，只把联机作为显式新增服务；ADR-001 的纯静态基线与 framework.md 的实时对战非目标仍是现状约束，实现阶段需要在那两份文档中登记这次范围扩展。",
      "alternative": "表面上更接近纯静态，但权威逻辑仍落在客户端或供应商服务端，无法真正零后端；纯 P2P 甚至违反服务端权威目标。"
    }
  ],
  "references": [
    "docs/tech-stack-decision.md",
    "docs/framework.md",
    "docs/minesweeper-online-design.md"
  ],
  "evolution": [
    {
      "stage": "mvp",
      "change": "单实例 Node WebSocket 房间服务 + 现有静态站点；内存房间表、无持久化，同域反代或客户端配置服务地址。",
      "invariant": "第 4、5 节的协议、seq 单调性、seed 承诺、宽限与计时器语义不变；服务重启视为 dissolved。"
    },
    {
      "stage": "multi-instance",
      "change": "按 roomId 把房间固定到实例（一致性哈希或房间目录），共享存储只放房间到实例的索引与 presence；跨实例重连先查路由。",
      "invariant": "单房间仍单线程串行；客户端协议与 snapshot-at-current-seq 恢复方式不变。"
    },
    {
      "stage": "managed-transport",
      "change": "只把客户端到服务端的传输层替换为托管 WebSocket 或 WebRTC 数据通道，权威房间逻辑仍在自有服务。",
      "invariant": "权威模型与 choice 不变；需重新评估供应商延迟、配额、数据边界和断线窗口是否匹配第 5 节。"
    },
    {
      "stage": "managed-room-runtime",
      "change": "若供应商的有状态运行时能执行完整权威逻辑、计时器与原子房间操作，可把房间服务整体迁移。",
      "invariant": "必须通过本文全部契约测试并保持第 5 节断线语义，否则不迁移。"
    }
  ],
  "reevaluateWhen": [
    "单实例无法承载并发房间数，或房间服务的运维成本超出维护预算",
    "第三方实时通道在总成本、延迟或隐私条款上显著优于自托管，且不牺牲权威裁决",
    "需要多区域部署、跨区域重连或更强的一致性保障",
    "供应商提供可验证的有状态房间运行时，并能通过本文契约测试"
  ]
}
```

## 7. 测试与验收

新增/更新 `tests/unit/minesweeper-online-design.test.ts`，读取本文并解析五个标记块：

- `design:room-lifecycle`：断言状态名唯一、初始态存在、每个转移的 `from`/`to` 都是已声明状态、所有状态从初始态可达、终态只允许重开/解散出边、创建/加入/就绪/开局/结束/超时六类事件都有转移、三种计时器都有对应超时转移。
- `design:protocol`：断言同步模型为回合制、裁决为服务端、棋盘共享、seed 与首点安全约束、断线不直接改变房间状态；消息表中每条消息都有方向与非空字段，字段名唯一，且至少覆盖 `join`、`snapshot`、`action`、`end` 及完整房间生命周期消息。
- `design:reconnect`：断言心跳检测 < 宽限 < 判负超时且三者均为正数、宽限值与 `design:protocol.disconnect.graceMs` 一致、判负超时与 `turn` 计时器一致；枚举的每个状态都在 `design:room-lifecycle` 中声明，重连/掉线/超时结局要么对应已有合法转移，要么停留在终态；恢复方式明确为全量快照或事件回放。
- `design:hosting`：断言 `choice` 属于 `candidates`、每项候选 id 唯一、被否候选不在 `choice` 且都有非空理由、除 `choice` 外的候选都出现在 `rejected` 中；选型理由覆盖部署、成本、延迟、权威与反作弊、断线恢复、数据与隐私、可测试性、与静态部署的关系，每条理由都同时给出选用方案与被否方案；`references` 包含 `docs/tech-stack-decision.md` 与 `docs/framework.md`，演进阶段与重新评估条件非空，且 `choice` 的权威模型与 `design:protocol.hosting.requiresServer` 一致。
- `design:implementation-plan`：断言版本与状态、任务 id 唯一、`title` / `detail` / `acceptance` 非空、`depends_on` 只引用已定义 id 且不存在环、数组顺序满足依赖先后；至少覆盖 `engine`、`protocol`、`hosting`、`reconnect`、`client-ui`、`e2e` 六类任务；`contracts.roomStates` / `contracts.timersMs` / `contracts.hostingChoice` 分别与 `design:room-lifecycle`、`design:protocol` 与 `design:hosting` 交叉一致。
- **关系章节**：断言第 2 节正文出现 `MinesweeperConfig`、`createSeededRng`、`src/games/minesweeper/engine.ts` 与 `difficulty.ts`，删除任一引用测试即失败；同时确认该节说明单机不回归、排行榜与自定义难度的后续接入。
- **索引与术语表**：断言第 0 节章节索引与第 10 节术语表存在，并覆盖房间、协议、重连与规则引擎的关键术语。

删掉任一标记块、改错状态名、把某条转移指向未声明状态、让断线结局引用未声明的房间状态、把 `choice` 改成未列出的候选，或让实现任务的依赖成环/引用未定义 id，测试就会失败。本子任务验收命令：

```bash
npm run test:unit
npm run typecheck
npm run lint
npm run build
```

测试只读文档，不修改 `src/` 运行时代码；因此不影响现有单机扫雷、其他游戏与大厅行为。

## 8. 实现阶段 issue 清单

本节把设计拆成可按依赖顺序建单的实现任务。id 是稳定标识，计划收口节点可直接用 id 建 issue 或写成任务图；范围只覆盖 MVP，不包含第 9 节与第 2.5 节列出的排行榜、自定义难度、观战等后续项。

| id | 标题 | 范围 | 依赖 |
| --- | --- | --- | --- |
| `engine-adapter` | 引擎适配：服务端复用纯规则引擎 | 用 `MinesweeperConfig` + seed 创建引擎、脱敏快照投影、重放日志；不改单机入口 | 无 |
| `protocol-contracts` | 协议层：消息类型与序列化契约 | 把第 4 节消息固化为共享类型/校验器；统一 `seq`、`turnId`、`actionId` 语义 | `engine-adapter` |
| `room-service` | 承载/服务端：独立 WebSocket 房间服务 | Node WebSocket 服务、内存房间表、房间 FSM、建房/加入/就绪/开局/离房/解散、120 s `join` 计时器、`playerToken` | `protocol-contracts` |
| `authoritative-match` | 权威对局与协议落地 | 服务端引擎实例、seed 承诺、`action`/`snapshot`/`action_result`/`end`、幂等、重放 | `room-service`、`engine-adapter` |
| `reconnect-timeout` | 断线重连与超时 | presence、2×5 s 心跳、15 s 宽限、席位保留、`turn`/`match` 计时器、`timeout`、`snapshot-at-current-seq` 恢复 | `room-service`、`authoritative-match` |
| `client-room-ui` | 客户端房间 UI 与联机棋盘 | 联机入口、房间/准备/结果/重开界面、脱敏棋盘、回合与倒计时、presence/重连提示；单机入口不变 | `protocol-contracts`、`room-service`、`authoritative-match` |
| `deploy-docs` | 联机部署与文档登记 | 静态站点 + 独立房间服务的部署配置、环境变量、健康检查；更新 `docs/tech-stack-decision.md` 与 `docs/framework.md` 的范围表述 | `room-service` |
| `online-e2e` | 联机端到端测试 | Playwright 双浏览器上下文覆盖创建→加入→就绪→开局→行动→结束、重连与超时；CI 不依赖外部账号 | `client-room-ui`、`reconnect-timeout` |

依赖分层（每一层的验收要点见下方 JSON；`depends_on` 只列直接前置任务，测试会校验拓扑顺序与无环）：

```text
第 1 层：engine-adapter
第 2 层：protocol-contracts
第 3 层：room-service
第 4 层：authoritative-match、deploy-docs
第 5 层：reconnect-timeout、client-room-ui
第 6 层：online-e2e

engine-adapter
  └─▶ protocol-contracts
        └─▶ room-service
              ├─▶ authoritative-match ─┬─▶ reconnect-timeout ─┐
              │                          └─▶ client-room-ui ───┼─▶ online-e2e
              └─▶ deploy-docs
```

`design:implementation-plan` JSON 是任务图、门禁与契约快照的权威来源；文字、表格与 JSON 冲突时以 JSON 为准。下方的 `contracts` 冗余记录跨章节的状态名、时限与承载选择，测试会拿它和前三份契约 JSON 交叉校验，防止汇总时出现漂移。

<!-- design:implementation-plan -->
```json
{
  "version": 1,
  "status": "design-only",
  "sourceIssue": 46,
  "order": "topological",
  "contracts": {
    "roomStates": ["idle", "waiting", "ready", "playing", "finished", "dissolved"],
    "timersMs": {
      "join": 120000,
      "turn": 30000,
      "match": 900000
    },
    "hostingChoice": "dedicated-room-service",
    "protocolVersion": 1
  },
  "tasks": [
    {
      "id": "engine-adapter",
      "category": "engine",
      "title": "引擎适配：服务端复用纯规则引擎",
      "detail": "在服务端用 MinesweeperConfig 与 seed 创建 MinesweeperEngine，提供从 MinesweeperSnapshot 到脱敏联机快照的投影，并记录可重放的 seed/config/有序行动日志；不修改 MinesweeperStatus、单机视图与默认 9×9 入口。",
      "depends_on": [],
      "acceptance": [
        "Node 环境不依赖 DOM 即可创建并推进引擎，首点安全与布雷时机与 src/games/minesweeper/engine.ts 一致",
        "投影后的快照不包含未翻开的 mine 字段，end 前不泄漏 seed",
        "同一 config、seed 与有序行动得到同一结果，重放比对通过",
        "现有引擎、难度与视图单测保持通过"
      ]
    },
    {
      "id": "protocol-contracts",
      "category": "protocol",
      "title": "协议层：消息类型、字段与序列化契约",
      "detail": "把第 4 节的消息表固化为共享 TypeScript 类型和运行时校验器，覆盖 create/join/ready/start/action/rematch/leave/room_state/snapshot/action_result/end/timeout/room_closed/error；统一 seq、turnId、actionId 的语义与错误码。",
      "depends_on": ["engine-adapter"],
      "acceptance": [
        "协议版本、消息方向与必填字段与 design:protocol 一致",
        "非法消息返回 error 且不改变房间或棋盘状态",
        "seq 单调、turnId 与 actionId 的去重语义有单元测试",
        "共享类型可被服务端与客户端同时引用，不引入 DOM 依赖"
      ]
    },
    {
      "id": "room-service",
      "category": "hosting",
      "title": "承载/服务端：独立 WebSocket 房间服务",
      "detail": "新增独立 Node WebSocket 房间服务：内存房间表、房间状态机、create/join/ready/start/leave/dissolve、120 s join 计时器、playerToken 签发与 room-not-found；静态前端继续由静态托管提供，不引入数据库。",
      "depends_on": ["protocol-contracts"],
      "acceptance": [
        "房间状态只能经 create/join/ready/start/leave/dissolve/timeout 转移，非法事件被拒绝且不改变状态",
        "roomId 唯一，playerToken 只发给本人，未知房间返回 room-not-found",
        "120 s join 超时解散房间并广播 timeout + room_closed（fake timers 测试）",
        "房间表单实例内存态，服务重启视为 dissolved；无持久化依赖"
      ]
    },
    {
      "id": "authoritative-match",
      "category": "protocol",
      "title": "权威对局与协议落地",
      "detail": "start 时生成 matchId/seed 并创建权威引擎；实现 seed 哈希承诺、action 校验与 snapshot/action_result/end 广播、seq/turnId/actionId 幂等、回合归属、踩雷/翻完/认输结算与按 seq 重放。",
      "depends_on": ["room-service", "engine-adapter"],
      "acceptance": [
        "非当前玩家、过期 seq、重复 actionId 与非法坐标均被拒绝，且不消耗回合",
        "snapshot 脱敏，end 才公布 finalSnapshot 与 seed；seedHash 与 end.seed 对应",
        "踩雷、翻完安全格、认输三种结局都产生 end 并进入 finished",
        "同一 replay 记录重放得到相同快照摘要与结果",
        "与 design:room-lifecycle 的 playing 自环、end 转移一致"
      ]
    },
    {
      "id": "reconnect-timeout",
      "category": "reconnect",
      "title": "断线重连与超时",
      "detail": "实现 presence、5 s 心跳连续错过 2 次判 offline、15 s 宽限与席位保留、turn 30 s / match 15 min 计时器、timeout 消息、playerToken 重连与 snapshot-at-current-seq 恢复；断线不直接改变房间状态。",
      "depends_on": ["room-service", "authoritative-match"],
      "acceptance": [
        "10 s 检测 < 15 s 宽限 < 30 s 回合判负，阈值与 design:reconnect 一致",
        "宽限内重连恢复当前 seq 快照，不重放离线行动；重复 join/action/timeout 幂等",
        "轮到掉线者时回合超时判负；未轮到则保留席位，match 计时不暂停",
        "waiting/ready/finished/dissolved 的掉线结局与第 5.6 节一致",
        "集成测试用 fake timers 覆盖检测、宽限与判负"
      ]
    },
    {
      "id": "client-room-ui",
      "category": "client-ui",
      "title": "客户端房间 UI 与联机棋盘",
      "detail": "新增联机入口与房间界面：创建/加入、准备、开局、结果、重开与离房；渲染脱敏快照、当前回合、倒计时、presence 与重连提示。联机视图独立按需加载，不改单机扫雷入口。",
      "depends_on": ["protocol-contracts", "room-service", "authoritative-match"],
      "acceptance": [
        "创建/加入/准备/开局/结束/重开/离房流程可操作，错误显示可读错误码",
        "棋盘只渲染服务端快照，不显示未翻开雷位；插旗/翻开按回合禁用",
        "倒计时基于 deadlineAt 估算，不作为裁决依据；重连后恢复到当前 seq",
        "单机扫雷入口、调试参数与难度选择行为不变",
        "视图单测覆盖房间状态切换与快照渲染"
      ]
    },
    {
      "id": "deploy-docs",
      "category": "hosting",
      "title": "联机部署与文档登记",
      "detail": "登记联机范围扩展：静态站点 + 独立房间服务的部署方式、同域反代或服务地址环境变量、健康检查与日志；同步更新 docs/tech-stack-decision.md 与 docs/framework.md 中的「实时对战非目标」表述。",
      "depends_on": ["room-service"],
      "acceptance": [
        "构建产物仍是 dist/，单机与大厅的部署链不变",
        "文档明确联机服务的部署单元、配置项、健康检查与回滚方式",
        "docs/tech-stack-decision.md 与 docs/framework.md 的范围表述和本设计一致，并链接本文",
        "本地/CI 可按文档在无外部账号的情况下启动联机服务"
      ]
    },
    {
      "id": "online-e2e",
      "category": "e2e",
      "title": "联机端到端测试",
      "detail": "用 Playwright 启动本地房间服务与静态站点，双浏览器上下文覆盖创建→加入→就绪→开局→轮流行动→结束，以及断线重连、回合超时判负、重复/非法行动。",
      "depends_on": ["client-room-ui", "reconnect-timeout"],
      "acceptance": [
        "e2e 在 CI 中不依赖外部账号、网络或第三方实时通道",
        "覆盖完整开局到结算主流程，双方棋盘一致且踩雷方判负",
        "覆盖断线重连恢复与回合超时判负（测试配置可缩短时限）",
        "覆盖重复 actionId 与非法坐标被拒绝且状态不变",
        "失败时保留 trace/截图，便于定位"
      ]
    }
  ]
}
```

## 9. 非目标与后续风险

- 不做账号、匹配队列、观战、聊天、排行榜与持久化；这些会改变房间/协议边界，需另立设计。排行榜与自定义难度的兼容方向见第 2.5 节。
- 不做「同一 seed 各自棋盘」的速度赛；若要做，应作为独立模式并重新评估实时同步、公平性与反作弊。
- 首版不做多实例房间迁移、断线跨节点恢复与回放分享；服务重启即 `dissolved`。
- 首版只支持 2 人；`capacity` 固定在协议中，扩展到多人需要重新评估回合顺序、棋盘共享粒度与胜负条件。

## 10. 术语表

| 术语 | 含义 | 契约/位置 |
| --- | --- | --- |
| 房间（room） | 一次 1v1 对局的容器，由 `roomId` 标识 | 第 3 节 |
| 房间 FSM | `idle → waiting → ready → playing → finished/dissolved` 的状态机 | `design:room-lifecycle` |
| presence | 玩家在线状态（`online` / `reconnecting` / `offline`），不属于房间状态 | 第 4.7、5 节 |
| `playerToken` | 服务端签发给单个玩家的重连凭证，只出现在发给本人的消息中 | 第 4.6 节 |
| `matchId` | 一局对局的标识；重开生成新值 | 第 3.2 节 |
| `seq` | 服务端为已接受行动/广播分配的单调序号 | `design:protocol.ordering` |
| `turnId` | 当前回合标识；行动必须匹配当前回合 | `design:protocol.ordering` |
| `actionId` | 客户端生成的幂等键，重复提交返回缓存结果 | `design:protocol.ordering` |
| seed 承诺 | 开局公布 `sha256(seed)`，结束后才公布 seed | 第 2.3、4.6 节 |
| 宽限期 | 检测掉线后保留席位、等待重连的 15 s 窗口 | `design:reconnect.grace` |
| `snapshot-at-current-seq` | 重连时下发当前 `seq` 的全量脱敏快照，不重放离线行动 | `design:reconnect.recovery` |
| 脱敏快照 | 只含已翻开格子的信息、不含未翻开雷位的客户端快照 | 第 4.2 节 |
| 单机规则引擎 | `src/games/minesweeper/engine.ts` 中与 DOM 无关的棋盘规则与 `validateConfig` | 第 2 节 |
| 难度预设 | `src/games/minesweeper/difficulty.ts` 的初级/中级/高级配置 | 第 2.1、2.5 节 |
| 独立房间服务 | 承载权威房间与棋盘的 Node WebSocket 服务（`dedicated-room-service`） | 第 6 节 |
