# playground

本仓库用于验证 dsh-superagent 的端到端流程，随时可能被自动改写。

供 dsh-superagent 做端到端测试使用。

## Playground Arcade：共享网页游戏框架 + 贪食蛇 + 俄罗斯方块 + 2048

这是 Issue #11 的交付：一套可以继续扩展的网页游戏工程骨架，以及第一款完整游戏「贪食蛇」。Issue #19 又接入了第二款完整游戏「俄罗斯方块」，Issue #24 接入了第三款完整游戏「2048」。空白画布保留为框架示例。

![Playground Arcade 大厅](docs/screenshots/after-hub-desktop.png)

![贪食蛇游戏中](docs/screenshots/after-snake-playing.png)

- **共享外壳**：Hash 路由、大厅、加载 / 错误态、音效开关、命名空间存储与可访问性约定。
- **按需引擎**：2D 使用 Phaser 4，引擎随游戏 chunk 懒加载；3D 预留 Three.js 接入位，不拖累首屏。
- **最小 2D 框架**：主循环与场景由 Phaser 提供，共享适配层统一容器缩放、ResizeObserver、输入约定与销毁生命周期。
- **完整可玩贪食蛇**：20×20 棋盘，吃果实 +10 分、变长、加速；撞墙 / 自撞结束；最高分持久化；键盘、触屏 D-pad 与滑动都能玩。
- **完整可玩俄罗斯方块**：10×20 棋盘，七种方块（I / O / T / S / Z / J / L）、旋转与踢墙、左右移动、加速下落、消行计分、等级加速；堆顶结束，支持暂停 / 重开；键盘与移动端触屏按钮都能玩。
- **完整可玩 2048**：4×4 棋盘，方向键 / WASD 或触屏滑动合并相同数字，合并计分并生成新方块；无路可走时结束，支持重开与最高分；键盘与触屏都能玩。
- **可交互空白游戏**：方向键 / WASD、鼠标点击拖动、触屏点击拖动都能移动光标；重置位置、返回大厅、页面隐藏自动休眠。
- **工程化**：TypeScript strict、oxlint + 模块边界检查、Vitest 单元测试、Playwright 桌面与手机端到端测试，以及按同样顺序执行检查的 GitHub Actions CI。

框架的契约、生命周期、输入 / 资源 / 渲染约定与 2D/3D 扩展方式见 **[docs/framework.md](docs/framework.md)**。
技术栈选型与候选对比见 **[docs/tech-stack-decision.md](docs/tech-stack-decision.md)**（t1 交付）。

## 快速开始

要求 Node.js `^22.12.0 || ^24.0.0 || >=26.0.0`（Vite 8 的要求）与 npm 10+。

```bash
npm install
npm run dev
```

打开 <http://localhost:5173>，点击「开始贪食蛇」直接开玩；也可以在大厅选择「俄罗斯方块」「2048」，或点「进入空白画布」查看框架示例。

## 贪食蛇玩法

20 × 20 的棋盘，初始长度 3，向右移动。

| 项目 | 规则 |
| --- | --- |
| 果实 | 随机出现在空格；吃到后蛇增长 1 格、得分 +10 |
| 速度 | 初始每步 150 ms；每吃一个果实减少 6 ms，最低 70 ms |
| 死亡 | 撞墙，或撞到自己的身体 |
| 胜利 | 蛇填满整个棋盘 |
| 最高分 | 保存在浏览器 `localStorage`，刷新后仍在 |

| 输入 | 行为 |
| --- | --- |
| `↑ ↓ ← →` / `W A S D` | 转向；不能 180° 反向 |
| `空格` / `Enter` | 开始、暂停 / 继续；结束后重开 |
| `P` / `Esc` | 暂停 / 继续 |
| `R` | 立即重开 |
| 触屏 D-pad / 在棋盘上滑动 | 转向；D-pad 中间按钮开始 / 暂停 |

规则细节、状态机与测试计划见 [docs/snake-design.md](docs/snake-design.md)。

## 俄罗斯方块玩法

10 × 20 的棋盘，七种方块从顶部下落，消行得分并提升等级。

| 项目 | 规则 |
| --- | --- |
| 方块 | I / O / T / S / Z / J / L 七种，七袋随机保证每袋各出现一次 |
| 旋转 | 顺时针旋转；贴墙或贴地时尝试小幅踢墙、踢地 |
| 下落 | 初始每格 800 ms；按住 `↓` / `S` 以每格 45 ms 加速下落 |
| 消行得分 | 一次消 1 / 2 / 3 / 4 行得 100 / 300 / 500 / 800 分 × 当前等级 |
| 等级 | 每消 10 行升 1 级，下落间隔每级减少 70 ms，最低 80 ms |
| 结束 | 新方块在出生位置被挡住（堆到顶部） |
| 重开 | 结束后按 `R` 或点击「再来一局」 |

| 输入 | 行为 |
| --- | --- |
| `← →` / `A D` | 左右移动；按住可连续移动 |
| `↑` / `W` | 顺时针旋转 |
| `↓` / `S` | 加速下落；按住可连续下落 |
| `空格` | 硬降到底并立即锁定 |
| `P` / `Esc` | 暂停 / 继续 |
| `R` | 立即重开 |
| 触屏 ← ↻ → / ↓ ⤓ ⏸ | 移动、旋转、加速下落 / 硬降、暂停或继续（窄屏或触屏设备显示） |

端到端测试通过 hash 路由后的 query `?debug=1`（例如 `/#/games/tetris?debug=1`；开发服务器默认启用，生产构建需要在路由后显式带上）读取只读状态并固定首块 / 初始棋盘；正常入口不会出现调试 UI。

## 2048 玩法

![2048 游玩中](docs/screenshots/after-2048-playing-desktop.png)

4 × 4 的棋盘，开局放置两个方块，每次向一个方向滑动，相同的数字相撞后合并翻倍。

| 项目 | 规则 |
| --- | --- |
| 起始 | 开局随机放置 2 个方块（2 或 4） |
| 移动 | 一次只向一个方向滑动，所有方块尽量靠向该方向 |
| 合并 | 相邻的相同数字合并为两倍；一次移动中每个方块最多参与一次合并 |
| 生成 | 每次有效移动后在随机空格生成一个 2 或 4 |
| 计分 | 每次合并后的数值累加到得分；有效移动不额外加分 |
| 结束 | 棋盘填满，且四个方向都没有可移动或可合并的方块 |
| 重开 | 结束后按 `R` 或点击「再来一局」；重开后得分归零 |
| 最高分 | 保存在浏览器 `localStorage`，刷新后仍在 |

| 输入 | 行为 |
| --- | --- |
| `↑ ↓ ← →` / `W A S D` | 向对应方向滑动并合并 |
| 在棋盘上滑动 | 手指或鼠标滑动，方向与手势一致 |
| `R` | 开始 / 立即重开 |

2048 同样通过 hash 路由后的 query `?debug=1`（例如 `/#/games/2048?debug=1`；开发服务器默认启用，生产构建需要在路由后显式带上）安装只读状态接缝，可以用 `board=2,2,.,./...` 指定初始棋盘供端到端测试复现；正常入口不显示调试 UI。

## 空白画布

空白画布仍然可以这样玩：

- `↑ ↓ ← →` 或 `W A S D` 移动光标；
- 鼠标点击 / 拖动，或用手指点击 / 拖动；
- 「重置位置」回到画布中心；「返回大厅」回到首页。

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动 Vite 开发服务器（默认 `http://localhost:5173`） |
| `npm run build` | 先执行 `tsc --noEmit`，再产出静态 `dist/` |
| `npm run preview` | 本地预览生产构建 |
| `npm run typecheck` | 只做 TypeScript 类型检查 |
| `npm run test:unit` | Vitest 单元测试 |
| `npm run test:e2e` | 先构建，再用 `vite preview` 跑 Playwright 端到端测试 |
| `npm run lint` | oxlint + 模块依赖方向检查 |
| `npm run check:budget` | 检查入口无引擎、gzip 体积预算 |
| `npm run screenshots` | 构建后生成 `docs/screenshots/` 中的界面截图 |
| `npm run screenshots:snake` | 生成贪食蛇 Before / After 截图（开发服务器 + 固定首果） |
| `npm run screenshots:2048` | 构建后生成 2048 大厅与 ready / playing / gameover 截图 |
| `npm run screenshots:2048:before` | 用 `BASE_URL` 指定的 main 预览生成 2048 Before 截图 |

首次运行端到端测试前需要安装浏览器：

```bash
npx playwright install chromium
```

## 目录结构

```text
index.html                 页面壳入口
src/
  main.ts                  创建应用并挂载路由
  app/
    app.ts                 站点页头 / 页脚、Hash 路由、加载 / 错误态、音效开关
    hub.ts                 大厅视图（游戏卡片、能力说明、快速开始）
    router.ts              #/ 与 #/games/:id 的解析
  core/
    game.ts                GameModule / GameHandle / GameServices 契约
    storage.ts             带命名空间与容错的 localStorage
    audio.ts               WebAudio 合成音效（无音频资源）
    input.ts               方向键映射、方向状态、归一化与边界钳制
    dom.ts                 DOM 查询、文本更新与 HTML 转义
  engine/
    phaser2d.ts            共享 2D 适配层：RESIZE 缩放、容器监听、销毁
  games/
    registry.ts            游戏注册表（只含元数据与懒加载入口）
    snake/
      engine.ts            纯规则引擎（移动 / 转向 / 食物 / 碰撞 / 计分 / 状态机）
      engine.test.ts       Vitest 单元测试
      scene.ts             Phaser 绘制与键盘输入
      snake-view.ts        HUD、覆盖层、按钮、D-pad、滑动与最高分
      index.ts             GameModule 元数据与懒加载入口
      snake.css            游戏页样式（随游戏 chunk 加载）
    tetris/
      engine.ts            纯规则引擎（方块 / 旋转 / 碰撞 / 消行 / 计分 / 状态机）
      engine.test.ts       Vitest 单元测试
      scene.ts             Phaser 绘制与键盘输入
      tetris-view.ts       HUD、覆盖层、触屏按钮与测试接缝
      palette.ts           七种方块的配色
      index.ts             GameModule 元数据与懒加载入口
      tetris.css           游戏页样式（随游戏 chunk 加载）
    2048/
      engine.ts            纯规则引擎（滑动 / 合并 / 计分 / 生成 / 状态机）
      engine.test.ts       Vitest 单元测试
      scene.ts             Phaser 绘制 4×4 棋盘与方块
      view.ts              HUD、开始 / 结束 / 重开遮罩、键盘、滑动与测试接缝
      index.ts             GameModule 元数据与懒加载入口
      2048.css             游戏页样式（随游戏 chunk 加载）
    blank/                 空白游戏示例（元数据、Phaser 场景、DOM 外壳）
  styles/app.css           全站样式与响应式布局
public/
  games/blank/orb.svg      示例资源，演示预加载与加载失败回退
tests/e2e/                 Playwright 桌面 / 手机端用例（含 2048）
docs/
  framework.md             框架使用说明
  snake-design.md          贪食蛇规则、状态机、结构与测试计划
  tech-stack-decision.md   t1 选型决策（候选对比、版本基线、2D/3D 扩展）
  screenshots/             截图与来源说明
```

依赖方向是单向的：

```text
app   → core
app   → games/registry → games/<game>/index（仅元数据）
games/<game>/* → core
games/<game>/scene → 对应引擎（动态 import）
```

`core/` 不导入任何游戏或引擎；引擎只出现在游戏的懒加载 chunk 中。

## 新增一个游戏

1. 新建 `src/games/<id>/index.ts`，导出 `GameModule`：编写 `meta`，在 `mount()` 内动态 `import()` 自己的视图。
2. 新建场景 / 逻辑 / DOM 外壳。2D 游戏可复用 `src/engine/phaser2d.ts` 的 `createPhaser2DGame()`；完整玩法参考 `src/games/snake/`（规则与渲染分离、最高分、触屏与测试）、`src/games/tetris/`（旋转 / 消行 / 等级、触屏按钮与调试接缝）和 `src/games/2048/`（数字合并、键盘 + 滑动与固定初始棋盘），最小示例参考 `src/games/blank/`。
3. 在 `src/games/registry.ts` 的 `games` 数组里注册；大厅会自动出现一张卡片。
4. 需要新资源时放到 `public/games/<id>/`，在场景 `preload()` 里加载。

更完整的步骤、契约示例和 3D（Three.js）接入清单见 [docs/framework.md](docs/framework.md)。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 语言 | TypeScript 7（strict） |
| 构建 / 开发服务器 | Vite 8 |
| 页面壳 | 原生 DOM + CSS，无 UI 框架 |
| 2D 引擎 | Phaser 4（按游戏懒加载） |
| 3D 引擎 | Three.js（首个 3D 游戏时接入） |
| 单元测试 | Vitest |
| 端到端测试 | Playwright（Chromium、桌面 + Pixel 7） |

2D 游戏把规则与渲染分离：纯逻辑放 `engine.ts` / `logic/` 并先写单测，Phaser Scene 只负责绘制与输入。3D 游戏在 `mount()` 内创建 `WebGLRenderer` 和相机，沿用相同的路由、存储、音效和销毁契约。

## 验证

当前提交已在本地通过：

```bash
npm run typecheck    # 通过
npm run lint         # 通过
npm run test:unit    # 117 passed（含贪食蛇 21、俄罗斯方块 38、2048 35 个规则用例）
npm run build        # 通过
npm run check:budget # 通过（入口 9.6 KB gzip，全部 JS 384.7 KB gzip）
npm run test:e2e     # 53 passed（桌面 46 + 手机 7）
```

端到端覆盖：大厅与游戏卡片、页面内锚点滚动、进入 / 返回 / 重进、最近游玩时间（进入 → 返回大厅 → 刷新后保留）、未知游戏与未知路径、音效偏好持久化、方向键与 WASD、修饰键快捷键不劫持、鼠标点击与拖动、重置后键盘仍可用、仅容器变化时的缩放、快速切换时丢弃晚到 mount、页面隐藏时离开仍能完整销毁、监听器清理、手机触屏与横向溢出检查；贪食蛇的开始 / 暂停 / 重开、吃果实与增长、撞墙死亡、更高 / 更低最高分、刷新后最高分仍在、P / Esc / R、滑动转向、页面隐藏自动暂停、手机 D-pad 与手机端重开；俄罗斯方块的从大厅进入 / 返回、键盘移动与旋转、硬降消行计分、暂停 / 继续、堆顶结束与重开、R 重开，以及手机端触屏按钮操作与手机端结束 / 重开；2048 的从大厅进入 / 返回、方向键与 WASD 合并计分、固定棋盘无路可走结束 / 重开 / R 重开、READY 时 R 直接开始、canvas 像素确认棋盘与方块确实被绘制，以及 destroy 后键盘 / 可见性 / 指针监听与就绪定时器的清理；手机端滑动合并与横向溢出检查。

## 已知限制

- 目前有贪食蛇、俄罗斯方块与 2048 三款完整游戏；空白画布用于演示框架的输入与渲染能力。
- 贪食蛇固定 20×20，没有穿墙、障碍物、特殊道具或在线排行榜；最高分只保存在本机浏览器。
- 俄罗斯方块固定 10×20，没有暂存（hold）、多块预览、T-spin 计分或在线排行榜。
- 2048 固定 4×4，没有撤销、存档读档或在线排行榜；最高分只保存在本机浏览器。
- 3D（Three.js）只预留契约与目录路径，参考实现要等首个 3D 游戏接入。
- 手机端使用 Playwright 的设备模拟，真实触屏手感仍建议人工验收。
- Phaser 引擎 chunk 约数百 KB（gzip），只在进入 2D 游戏时加载；大厅首屏不包含引擎。
