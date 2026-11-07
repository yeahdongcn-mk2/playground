# 扫雷联机对战设计说明

> 状态：设计稿（Issue #46 子任务 0、1，只出文档与契约测试，不写实现） · 范围：1v1 回合制联机扫雷
>
> 本文定义房间生命周期、状态同步与裁决协议、超时与断线重连边界，以及它们与现有单机扫雷规则引擎的关系。风格与 [贪食蛇设计说明](./snake-design.md)、[技术栈选型决策](./tech-stack-decision.md) 保持一致。

## 1. 背景与范围

当前仓库是纯静态前端：Vite 构建后直接部署 `dist/`，没有服务端、账号、房间组件或持久化数据；[框架说明](./framework.md) 第 1 节也把「实时对战」列为当前非目标。扫雷的规则引擎已经参数化：

- `MinesweeperConfig` 描述行、列、雷数与首点安全策略；
- `validateConfig()` 统一校验棋盘边界与雷数容量；
- `createSeededRng()` 提供可复现的 mulberry32 随机源；
- `difficulty.ts` 提供初级、中级、高级三档预设，并复用同一套校验。

因此本设计不另起棋盘模型，而是在现有引擎之上增加一层「房间 + 协议 + 裁决」边界。本文要回答四件事：

1. 房间从创建到销毁经过哪些状态，哪些事件推动转移，三种时限分别在何时生效、到期后如何处置；
2. 同步采用回合制还是实时、棋盘是共享还是每人一份、谁裁决踩雷与胜负；
3. 消息有哪些、字段是什么，行动如何排序、去重与冲突处理，确定性从哪来；
4. 如何划分联机概念与单机状态模型，以及掉线检测、宽限期、重连恢复与宽限用尽后的结局。

不在本文范围内：具体服务端实现、房间匹配、账号体系、排行榜、观战、聊天、持久化、道具与自定义规则扩展。本文只固定契约；`src/` 运行时代码在本子任务中不改动。

## 2. 与单机玩法和规则引擎的关系

### 2.1 复用什么

联机服务端直接复用同一个纯规则引擎，而不是复制一份棋盘逻辑：

| 现有能力 | 联机用途 |
| --- | --- |
| `MinesweeperConfig` / `validateConfig` | 建房时校验房间配置；非法配置在 `create` 就被拒绝 |
| `createSeededRng(seed)` | 服务端为每局创建确定性随机源；客户端不自行生成雷盘 |
| `firstClickSafe` | 双方共享同一首点安全规则，首点必定安全 |
| `MinesweeperEngine` | 服务端持有唯一权威棋盘，接受行动并产出快照 |
| `MinesweeperSnapshot` | 作为服务端内部状态来源，投影成脱敏的客户端快照 |
| `difficulty.ts` 预设 | 房间难度选项来源，仍通过 `validateConfig` 校验 |
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

`playing` 中的 socket 断开只更新玩家 presence，不产生新的房间状态；只有 `timeout` 事件让房间进入 `finished` 或 `dissolved`。这是后续 t2 断线超时功能的边界，详见第 5 节。

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

### 4.7 断线超时的状态边界（为 t2 预留）

断线与超时被刻意放在房间状态机之外，避免把「连接状态」误建模成「房间状态」：

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| 连接层 | `online` / `reconnecting` / `offline` 的 presence、`playerToken` 会话、宽限计时 | 房间状态、胜负、棋盘 |
| 房间 FSM | `waiting` / `ready` / `playing` / `finished` / `dissolved` 与转移 | socket 生命周期、心跳 |
| 引擎层 | 棋盘、踩雷、翻开、插旗 | 玩家在线状态、回合归属 |

明确规则：

- `playing` 中 socket 断开**不触发**房间转移；`disconnect.immediateRoomTransition` 固定为 `false`。
- 连接层用心跳检测掉线（10 s 阈值），确认掉线后只更新该玩家的 presence，并启动 `disconnect.graceMs`（15 s）宽限计时；宽限内重连取消计时，棋局继续。
- 若宽限期到期且轮到该玩家，服务端发出 `timeout(timer=turn)`，按回合超时判负；若未轮到该玩家，则只标记离线，等其回合再按 `turn` 时限处理。
- `match` 时限不因断线暂停；断线不能用来逃避整局计时。
- 只有服务端 `timeout` / `end` 事件能让房间离开 `playing`；连接层不得直接改房间状态。
- 重连恢复使用 `snapshot-at-current-seq`，不做“回滚到断线前”的语义；具体检测阈值、宽限结局与恢复细节见第 5 节。

## 5. 断线与重连

第 4.7 节只固定了「断线不直接改房间状态」的边界；本章在 t1 的三种时限之上补齐掉线检测、宽限期、席位保留、重连恢复、幂等与房主掉线规则。下方 `design:reconnect` JSON 是这些阈值与结局的权威来源，文字与 JSON 冲突时以 JSON 为准。

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

## 6. 承载方案

协议需要**共享权威状态**，纯静态前端无法单独承载：

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| 现有静态前端 + 小房间服务 | ✅ 首版推荐 | 静态资源继续由现有托管提供；WebSocket 房间服务只持有内存中的房间、引擎与计时器，职责小、可独立部署 |
| 第三方实时通道 | 备选 | 省去自建连接层，但状态仍要落在可信服务端；引入外部依赖、配额与数据边界问题，首版不优先 |
| 纯客户端 P2P / 主机权威 | ❌ | 无法防作弊，主机断线阻塞整局，且与「服务端唯一权威棋盘」冲突 |
| Serverless 短连接轮询 | 暂不选 | 回合制虽然低频，但计时器、房间广播与重连语义仍需要常驻状态；轮询延迟和成本不划算 |

首版服务端建议（仅设计约束，不在本子任务实现）：

- Node.js WebSocket 房间服务，单实例、内存态房间；不持久化对局，不接账号，玩家用临时 token 标识；
- 每个房间一个单线程事件队列、一个权威 `MinesweeperEngine`、三个计时器；
- 静态站点与 WebSocket 服务可同域反向代理，也可通过环境变量配置 `VITE_...` 服务地址；具体变量在实现子任务中命名，本设计不引入运行时代码；
- 断线重连只依赖 `playerToken`，不做跨实例迁移；服务重启视为房间 `dissolved`。

## 7. 测试与验收

新增 `tests/unit/minesweeper-online-design.test.ts`，读取本文并解析三个标记块：

- `design:room-lifecycle`：断言状态名唯一、初始态存在、每个转移的 `from`/`to` 都是已声明状态、所有状态从初始态可达、终态只允许重开/解散出边、创建/加入/就绪/开局/结束/超时六类事件都有转移、三种计时器都有对应超时转移。
- `design:protocol`：断言同步模型为回合制、裁决为服务端、棋盘共享、seed 与首点安全约束、断线不直接改变房间状态；消息表中每条消息都有方向与非空字段，字段名唯一，且至少覆盖 `join`、`snapshot`、`action`、`end` 及完整房间生命周期消息。
- `design:reconnect`：断言心跳检测 < 宽限 < 判负超时且三者均为正数、宽限值与 `design:protocol.disconnect.graceMs` 一致、判负超时与 `turn` 计时器一致；枚举的每个状态都在 `design:room-lifecycle` 中声明，重连/掉线/超时结局要么对应已有合法转移，要么停留在终态；恢复方式明确为全量快照或事件回放。

删掉任一标记块、改错状态名、把某条转移指向未声明状态，或让断线结局引用未声明的房间状态，测试就会失败。本子任务验收命令：

```bash
npm run test:unit
npm run typecheck
npm run lint
npm run build
```

测试只读文档，不修改 `src/` 运行时代码；因此不影响现有单机扫雷、其他游戏与大厅行为。

## 8. 实现阶段拆分（供计划收口节点建单）

本设计只固定契约；实现阶段建议按依赖顺序拆为：

1. **房间服务与传输骨架**：WebSocket 连接、`create`/`join`/`ready`/`start`、房间状态机、内存房间表；
2. **权威对局与协议**：服务端引擎、seed 承诺、`action`/`snapshot`/`action_result`/`end`、`seq`/幂等/回合校验与重放日志；
3. **断线重连与超时**（t2）：presence、心跳检测、15 s 宽限、`turn`/`match` 计时器、`timeout` 消息与重连快照（设计见第 5 节）；
4. **客户端联机视图与 e2e**：入口、房间 UI、脱敏棋盘渲染、重连提示、断线/超时/重放端到端用例。

依赖顺序为 1 → 2 → 3 → 4；第 2 步之前不应开始客户端联机视图，否则会为了临时协议反复改 UI。实际 issue 编号与拆分粒度由计划收口节点决定，本子任务不创建实现 issue。

## 9. 非目标与后续风险

- 不做账号、匹配队列、观战、聊天、排行榜与持久化；这些会改变房间/协议边界，需另立设计。
- 不做「同一 seed 各自棋盘」的速度赛；若要做，应作为独立模式并重新评估实时同步、公平性与反作弊。
- 首版不做多实例房间迁移、断线跨节点恢复与回放分享；服务重启即 `dissolved`。
- 首版只支持 2 人；`capacity` 固定在协议中，扩展到多人需要重新评估回合顺序、棋盘共享粒度与胜负条件。
