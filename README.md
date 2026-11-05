# playground

本仓库用于验证 dsh-superagent 的端到端流程，随时可能被自动改写。

供 dsh-superagent 做端到端测试使用。

## Playground Arcade：共享网页游戏框架 + 贪食蛇

这是 Issue #11 的交付：一套可以继续扩展的网页游戏工程骨架，以及第一款完整游戏「贪食蛇」。空白画布保留为框架示例。

![Playground Arcade 大厅](docs/screenshots/after-hub-desktop.png)

![贪食蛇游戏中](docs/screenshots/after-snake-playing.png)

- **共享外壳**：Hash 路由、大厅、加载 / 错误态、音效开关、命名空间存储与可访问性约定。
- **按需引擎**：2D 使用 Phaser 4，引擎随游戏 chunk 懒加载；3D 预留 Three.js 接入位，不拖累首屏。
- **最小 2D 框架**：主循环与场景由 Phaser 提供，共享适配层统一容器缩放、ResizeObserver、输入约定与销毁生命周期。
- **完整可玩贪食蛇**：20×20 棋盘，吃果实 +10 分、变长、加速；撞墙 / 自撞结束；最高分持久化；键盘、触屏 D-pad 与滑动都能玩。
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

打开 <http://localhost:5173>，点击「开始贪食蛇」直接开玩；也可以点「进入空白画布」查看框架示例。

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

规则细节、状态机与测试计划见 [docs/snake-design.md](docs/snake-design.md)。空白画布仍然可以这样玩：

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
    blank/                 空白游戏示例（元数据、Phaser 场景、DOM 外壳）
  styles/app.css           全站样式与响应式布局
public/
  games/blank/orb.svg      示例资源，演示预加载与加载失败回退
tests/e2e/                 Playwright 桌面 / 手机端用例
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
2. 新建场景 / 逻辑 / DOM 外壳。2D 游戏可复用 `src/engine/phaser2d.ts` 的 `createPhaser2DGame()`；完整玩法参考 `src/games/snake/`（规则与渲染分离、最高分、触屏与测试），最小示例参考 `src/games/blank/`。
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
npm run test:unit    # 44 passed（含贪食蛇 21 个规则用例）
npm run build        # 通过
npm run check:budget # 通过
npm run test:e2e     # 39 passed（桌面 35 + 手机 4）
```

端到端覆盖：大厅与游戏卡片、页面内锚点滚动、进入 / 返回 / 重进、最近游玩时间（进入 → 返回大厅 → 刷新后保留）、未知游戏与未知路径、音效偏好持久化、方向键与 WASD、修饰键快捷键不劫持、鼠标点击与拖动、重置后键盘仍可用、仅容器变化时的缩放、快速切换时丢弃晚到 mount、页面隐藏时离开仍能完整销毁、监听器清理、手机触屏与横向溢出检查；贪食蛇的开始 / 暂停 / 重开、吃果实与增长、撞墙死亡、更高 / 更低最高分、刷新后最高分仍在、P / Esc / R、滑动转向、页面隐藏自动暂停、手机 D-pad 与手机端重开。

## 已知限制

- 目前只有贪食蛇一款完整游戏；空白画布用于演示框架的输入与渲染能力。
- 贪食蛇固定 20×20，没有穿墙、障碍物、特殊道具或在线排行榜；最高分只保存在本机浏览器。
- 3D（Three.js）只预留契约与目录路径，参考实现要等首个 3D 游戏接入。
- 手机端使用 Playwright 的设备模拟，真实触屏手感仍建议人工验收。
- Phaser 引擎 chunk 约数百 KB（gzip），只在进入 2D 游戏时加载；大厅首屏不包含引擎。
