# 贪食蛇设计说明

本文记录 `src/games/snake/` 的规则、状态机、结构边界与测试计划。玩法与运行步骤见根目录 [README](../README.md)。

## 范围

- 在 t2 的共享框架上实现第一款完整游戏：20 × 20 棋盘、方向控制、食物、增长、碰撞 / 死亡、计分与最高分、暂停 / 重开、桌面与移动端适配。
- 核心规则放在与渲染无关的 `engine.ts`，Phaser 场景只负责绘制与输入，DOM 视图负责 HUD、覆盖层和触屏。
- 不包含穿墙、障碍物、特殊道具、在线排行榜或联机；这些都不在本子任务内。

## 规则

| 项目 | 规则 |
| --- | --- |
| 棋盘 | 20 × 20，初始蛇长 3，位于中间一行，向右移动 |
| 食物 | 从所有空格中等概率选一个；果实被吃后立即生成下一个 |
| 增长 | 吃到食物时蛇头前进、尾巴不缩短，长度 +1 |
| 计分 | 每个食物 +10 分 |
| 速度 | 初始每步 150 ms；每吃一个食物减少 6 ms，最低 70 ms |
| 死亡 | 撞墙，或蛇头进入身体占用的格子 |
| 胜利 | 蛇填满整个棋盘（食物无处生成） |
| 最高分 | 写入共享 `StorageService` 的 `playground:v1:snake.highscore`，刷新后仍在 |

转向规则：

- 一次 tick 只应用一个转向，连续快速按键进入最多 2 个的队列，避免斜穿拐角。
- 与当前方向相同或相反的转向被拒绝；反向会立刻撞到自己，因此不允许。
- 跟随尾巴是合法的：非进食 tick 尾巴会先腾出格子，所以蛇头可以进入尾巴当前所在的格子。

## 状态机

```text
ready ──start()──▶ running ──pause()──▶ paused
  ▲                  │  ▲                 │
  │                  │  └──── resume() ────┘
  │                  ├── 撞墙 / 自撞 ──▶ gameover
  │                  └── 棋盘填满 ─────▶ won
  └──────── restart() ───────────────────────┘
```

- `ready`：棋盘已渲染，等待开始。
- `running`：按 `stepMs` 推进。
- `paused`：手动暂停或页面隐藏；时间线停止，状态保留。
- `gameover` / `won`：显示覆盖层，等待重开。
- `restart()` 重置分数、速度、蛇与食物，回到 `ready`；视图随后调用 `start()` 立即开始新一局。

## 结构

```text
src/games/snake/
  engine.ts        纯规则引擎：状态、转向队列、碰撞、食物、计分、速度、胜利
  engine.test.ts   Vitest 单元测试（23 个）
  scene.ts         Phaser 场景：棋盘 / 蛇 / 果实绘制、键盘输入、死亡闪动、固定 tick 截图接缝
  snake-view.ts    DOM 视图：HUD、覆盖层、按钮、D-pad、滑动、最高分、音效
  index.ts         GameModule 元数据与懒加载入口
  snake.css        游戏页样式（随游戏 chunk 加载）
  fixed-ticks.ts   固定 tick 推进循环（与 Phaser 解耦，便于单测）
  debug.ts         window.__playground 类型声明与 debug seed / ticks 解析
```

依赖方向：

- `engine.ts` 不依赖 Phaser、DOM 或存储，只接收可注入的 `rng`、初始蛇和食物。
- `scene.ts` 只依赖 Phaser 与 `engine.ts` 的类型；它不碰 DOM 或 localStorage。
- `snake-view.ts` 依赖 `core/` 的 `query` / `setText`、共享音效与存储，并动态加载 `scene.ts` 和 `phaser2d.ts`。
- `index.ts` 的静态部分只放元数据，`mount()` 内部才 `import('./snake-view')`。

## 渲染与输入

- 复用 `createPhaser2DGame()`：`Scale.RESIZE` + ResizeObserver，场景在 `scale.resize` 时按实际画布尺寸重新计算格子大小，因此桌面侧栏、窄屏和横竖屏切换都不依赖固定像素。
- 两层 `Graphics`：底层画背景网格，另一层每帧画蛇和果实；死亡时用短暂的红色闪动表达反馈，`prefers-reduced-motion` 时省略闪动、抖动和全屏闪光。
- 键盘在 Phaser 场景里监听，用 `WeakSet<KeyboardEvent>` 去重，避免同一次按键被多个监听路径处理；输入框或可编辑元素聚焦时不劫持方向键。
- 触屏：棋盘上滑动（阈值 24 px）与棋盘下方的 3 × 3 D-pad 都能转向；D-pad 中间键开始 / 暂停。D-pad 在宽屏桌面隐藏，在窄屏或粗指针设备显示。
- 页面隐藏（`visibilitychange`）或窗口失焦时自动暂停；`visibilitychange`、`blur` 和所有按钮监听都挂在同一个 `AbortController` 上，`destroy()` 时统一移除。
- 覆盖层按钮、键盘与 D-pad 走同一个 `primaryAction()`；开始 / 重开统一走 `beginRun()`，避免三套开始逻辑漂移。开始后主动 blur 焦点，让空格和方向键回到游戏。

## 最高分与音效

- 最高分只在 `score > best` 时写入，避免刷新或暂停时无意义地写存储。
- 每局记录 `runStartBest`；结算时只有超过开局最高分才显示「新纪录」，不会把旧纪录误报成新纪录。
- 音效复用 `AudioService`：开始 / 重开 / 胜利用 `start`，吃食物与暂停 / 继续用 `blip`，死亡用 `reset`；不新增音频资源。

## 测试

### 单元测试（23）

`src/games/snake/engine.test.ts` 覆盖：

- 初始状态、启动 / 暂停 / 恢复 / 重开。
- 前进、吃食物增长与计分、连续吃多个食物、速度下限。
- 撞墙、撞自己、跟随尾巴、反向拒绝、转向队列（含快速转向和队列上限）。
- 食物不生成在蛇身上、注入 RNG 的确定性、填满棋盘时胜利。
- 截图场景的确定性：固定首果 + seed 7 + 3 个 tick 后的蛇身、下一颗果实、得分与速度；不同 seed 会改变下一颗果实。
- `state` 返回防御性副本，外部修改不影响引擎。

运行：`npm run test:unit`（全仓 568 个用例）。

`src/games/snake/debug.test.ts` 另行覆盖 seed / ticks 参数解析；截图确定性护栏（脚本常量、view / scene 接线与固定 tick 循环）在 `tests/unit/capture-snake-determinism.test.ts`。

### 端到端（24）

`tests/e2e/snake.spec.ts`（桌面 18 个）与共享的 `tests/e2e/snake-mobile-cases.ts`（手机 3 个）覆盖；手机用例由 `tests/e2e/snake.mobile.spec.ts` 与 `tests/e2e/snake.mobile.webkit.spec.ts` 分别接入 Chromium `mobile` 与 WebKit `mobile-webkit` 项目，两个引擎运行同一份断言：

- 从大厅卡片进入、返回大厅；聚焦「返回大厅」时按 Enter 正常导航，不会被游戏快捷键截获。
- 开始、吃固定位置果实、增长、得分、最高分持久化与刷新。
- 暂停 / 继续（按钮、空格、P、Esc）、重开（按钮、空格、R）。
- 撞墙死亡、结算覆盖层、重开新一局；更高 / 更低的历史最高分；首次刷新最高分时的「新纪录！」。
- 滑动转向、WASD 转向、页面隐藏 / 窗口失焦自动暂停、无控制台 / 页面错误。
- 空格 / Enter 在结算后开新局；聚焦返回链接时 Enter 正常导航；大厅主 CTA 进入游戏。
- 手机：D-pad 位于棋盘下方、开始 / 转向 / 中间键暂停、触屏点按后方向键仍能转向 / 暂停（触屏与键盘混用）、死亡后重开、无横向溢出；Chromium 与 WebKit 各运行一遍。

测试通过 `?debug=1`（生产构建）或开发服务器启用只读的 `window.__playground`、固定首果 `?food=x,y`、固定 RNG `?seed=n` 与固定 tick `?ticks=n`；生产构建默认不安装调试 API，只有带 `?debug=1` 时才启用这些接缝，正常入口不会出现可见的调试 UI，也不会使用固定 seed / tick。

运行：`npm run test:e2e`（先 `npm run build`，再用 `vite preview` 跑 Playwright）。

### 截图

`scripts/capture-snake-screenshots.mjs` 用开发服务器抓取：

- `--before`：在 t2 基线（`60c0206`，即 t2 分支 head `c9e8dec` 的同一棵树）的干净 worktree 运行，抓取框架大厅、手机大厅、空白画布，以及 `#/games/snake` 在 t2 的真实「没有找到这个游戏」错误页。`--before` 读取当前工作树，必须先 checkout / worktree 到基线，不能在本分支直接跑。
- 默认：贪食蛇大厅、READY、游玩中、GAME OVER、手机大厅与手机游戏（After，当前分支）。
- 固定首果 `?food=11,10` 固定第一颗果实；游玩图再固定 `?seed=7&ticks=3`，吃下首果后推进 3 个引擎 tick 并冻结运行，使蛇身、下一颗果实、得分、长度与速度可逐字节复现。冻结期间保留 Phaser 循环重绘已冻结的 Graphics，不 sleep WebGL 循环（否则截图会捕获到黑屏画布）。
- 桌面 1440×1000、手机 390×844（DPR 2），深色主题，`reducedMotion: reduce`；同一工作树、开发端口 5188 空闲时连续两次 `npm run screenshots:snake` 生成的 `after-snake-playing.png` sha256 完全一致。复现命令与哈希对照见 [docs/screenshots/README.md](screenshots/README.md) 的「游玩截图确定性」小节。

运行：`npm run screenshots:snake`；WebKit 手机 READY 图用 `npm run screenshots:snake:webkit`。

## 已知限制

- 固定 20×20，无穿墙、障碍物、特殊道具或在线排行榜。
- 最高分只在本机 localStorage，不跨设备同步。
- 手机端为 Playwright 设备模拟（Pixel 7），真实触屏手感仍建议人工验收。
- 调试 seam（`?debug=1` / `?food=` / `?seed=` / `?ticks=`）用于自动化测试与截图；正常入口不会启用，debug seed / tick 无效或缺省时回退到原有实时行为。
