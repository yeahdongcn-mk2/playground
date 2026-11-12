# Web 游戏技术栈选型决策

> 状态：已决定（ADR-001） · 调研快照：2026-11-05 · 范围：Issue #11 子任务 t1（只做选型，不实现游戏）
>
> 本文给出可复用的网页游戏底座选型、模块边界与 2D/3D 扩展方式，后续游戏与工程任务直接按此实施。

## 1. 背景与需求

仓库要承载多个「点开即玩」的网页小游戏，第一款是贪食蛇，之后会同时出现 2D 街机（打砖块、2048、射击）和 3D 游戏（迷宫、赛车、第一人称探索）。

由此得到的硬性约束：

- **多游戏共用一套底座**：大厅、路由、存档、音效、输入与测试方式复用，新增游戏不重复造轮子。
- **2D 与 3D 并存**：不要求同一个渲染器包打天下，但要求共享外壳与契约。
- **首屏轻量**：没进入游戏时不加载游戏引擎；每个游戏按需加载自己的引擎。
- **纯静态部署**：无后端、无账号，构建产物可直接放静态托管。
- **可测试、可维护**：游戏规则与渲染分离，关键逻辑能在 Node 中单测；真实浏览器有端到端覆盖。
- **桌面与移动端可用**：键盘、触屏、响应式、基本可访问性都是底座的一部分。

当前非目标：服务端渲染、在线排行/对战、游戏编辑器、PWA 离线缓存。

## 2. 调研方法与数据快照

调研时间 2026-11-05，数据来自可复现来源：

- npm registry / downloads API：`npm view <pkg> version time.modified license engines`、`https://api.npmjs.org/downloads/point/last-month/<pkg>`
- GitHub API：`gh api repos/<owner>/<repo>`；各项目官方文档

| 包 | 最新版本 | npm 最近更新 | 定位 | GitHub Stars | npm 月下载（约） | 许可证 |
| --- | --- | --- | --- | ---: | ---: | --- |
| Phaser | 4.2.1 | 2026-07-09 | 完整 2D 游戏框架 | 40,648 | 2,404,797 | MIT |
| Three.js | 0.187.0（r187） | 2026-10-30 | 3D 渲染库 | 117,577 | 94,482,864 | MIT |
| PixiJS | 8.22.0 | 2026-10-30 | 2D 渲染库 | 48,622 | 5,521,647 | MIT |
| @babylonjs/core（Babylon.js） | 9.33.2 | 2026-11-02 | 完整 3D 引擎 | 26,296 | 1,382,767 | Apache-2.0 |
| Kaplay | 3001.0.19 | 2026-05-12 | 轻量 2D 框架 | 1,824 | 31,006 | MIT |
| Vite | 8.3.5 | 2026-10-21 | 构建/开发服务器 | 83,730 | 780,701,798 | MIT |
| TypeScript | 7.0.2 | 2026-11-04 | 类型系统 | 111,733 | 1,233,662,728 | Apache-2.0 |

下载量包含大量传递依赖，只能作为生态健康度信号，不能等同于游戏项目数。版本与数据应在每次大版本升级时复核；测试工具同样核对：Vitest 5.1.0（Node `^22.12.0 || ^24.0.0 || >=26.0.0`）、Playwright 1.64.1（Node >=20）。

## 3. 候选方案对比

### 3.1 渲染与游戏框架

| 维度 | Phaser 4 | PixiJS 8 | Three.js | Babylon.js | Kaplay |
| --- | --- | --- | --- | --- | --- |
| 类型 | 完整 2D 游戏框架 | 2D 渲染器 | 3D 渲染库 | 完整 3D 引擎 | 轻量 2D 框架 |
| 场景/生命周期 | 内置 Scene | 自建 | 自建 | 内置 | 基础场景 |
| 输入（键盘/指针/触屏） | 内置 | 基础事件 | 基础事件 | 内置 | 内置 |
| 音频 | 内置 | 无（需插件） | 无 | 内置 | 内置 |
| 物理 | Arcade / Matter | 无 | 无 | 多套 | 基础 |
| 补间/粒子 | 内置 | 插件 | 自建 | 内置 | 部分 |
| 3D 能力 | 无 | 无 | 强 | 强 | 无 |
| 2D 开发效率 | 高 | 中 | 低 | 中 | 高 |
| TypeScript 类型 | 官方 | 官方 | 官方 | 官方 | 官方 |
| 包体量级（gzip，参考） | 约 360 KB | 约 150–250 KB | 按需 tree-shake | 较大（未实测） | 较小 |
| 生态与资料 | 很大 | 大 | 最大 | 大 | 小 |

包体为同类小游戏构建产物的量级参考，随具体玩法、素材与 tree-shaking 浮动，不是本仓库实测值。

### 3.2 构建与运行时

| 候选 | 结论 | 理由 |
| --- | --- | --- |
| Vite 8 | ✅ 选用 | 原生 ESM、秒级 HMR、每个游戏一个动态 import 边界、静态产物简单 |
| 应用框架（React/Vue） | ❌ | 大厅是静态 DOM + 少量交互，引入运行时与状态模型不划算 |
| 原生 Canvas / DOM 作 2D 游戏引擎 | ❌ | 小游戏也需要场景、输入、音频、补间，自建会重复造轮子；仅适合极简游戏（应用外壳仍用原生 DOM/CSS） |
| Godot / Unity WebGL | ❌ | 导出体积以 MB 计，构建链和首屏体验不符合「点开即玩」 |

### 3.3 关键观察

1. **2D 与 3D 的能力诉求不同**：2D 小游戏要开箱即用的场景、输入、音频、补间；3D 更看重相机、材质、光照、模型与 WebGPU 路线。单引擎通吃通常以 2D 体验或包体为代价。
2. **PixiJS 是渲染器不是框架**：需要自行补场景、循环、音频、资源管理，长期会重复造轮子。
3. **Babylon.js 是「单引擎全都要」的可行选项**，但体积更大、2D 工作流不如 Phaser 直接；当前没有必须单引擎的约束。
4. **Kaplay 适合原型**，但生态与维护信号弱；**Phaser 4 + Three.js 的组合覆盖最完整**：各自解决 2D/3D，按游戏动态加载，互不污染。

## 4. 决策（ADR-001）

**采用「共享外壳 + 按需引擎」：**

| 层 | 选型 | 版本基线 |
| --- | --- | --- |
| 语言 | TypeScript（strict） | 7.0.2 |
| Node 运行时 | Node.js（推荐 24 LTS） | `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0`（Vite 与 Vitest 的交集） |
| 构建/开发服务器 | Vite | 8.3.5 |
| 应用外壳 | 原生 DOM + CSS，无 UI 框架 | — |
| 2D 引擎 | Phaser | 4.2.1 |
| 3D 引擎 | Three.js（首个 3D 游戏时接入） | 0.187.0 |
| 单元测试 | Vitest | 5.1.0 |
| 端到端测试 | Playwright（Chromium） | 1.64.1 |
| 部署 | 纯静态产物（`dist/`） | — |

- Phaser 4 提供完整的 2D 游戏系统，且保持 Phaser 3 的 Scene/GameObject/Input/Tweens 心智模型，交付快、资料多；但 tint/FX/Mask/Shader 等有破坏性变更，旧示例需对照官方 Migration Guide。
- Three.js 是事实标准的 3D 渲染库，生态最大，按需引入，不拖累 2D 游戏。
- 外壳保持引擎无关：大厅、路由、HUD、设置只依赖 DOM 与共享契约，因此引擎升级或替换不会波及平台层。
- 每个游戏一个动态 `import()`，引擎随游戏 chunk 加载；大厅首屏不承担引擎体积。

**为什么不选「只用一个框架」**：Phaser 覆盖不了 3D；Three.js 直接做 2D 缺少整套游戏系统；Babylon.js 可同时做 2D/3D，但会增加 2D 体积与心智负担。本项目共享的是**外壳、契约、工程规范与测试方式**，不是强行共享渲染器。

## 5. 模块分层与边界

```text
index.html
public/games/<game>/      大资源（模型/纹理/音频）
src/
  main.ts                 入口：创建应用、挂载路由
  app/                    应用外壳：页头/页脚、路由、大厅、加载/错误态
    app.ts
    hub.ts
  core/                   引擎无关的共享能力
    game.ts               GameModule / GameHandle / GameServices 契约
    storage.ts            带命名空间与容错的 localStorage
    audio.ts              WebAudio 合成音效
    dom.ts                DOM 小工具
  games/
    registry.ts           游戏注册表（只含元数据与懒加载入口）
    <game>/
      index.ts            GameModule 元数据 + mount()
      logic/              纯规则逻辑（无 DOM、无引擎）
      scene.ts            引擎渲染与输入
      view.ts             DOM HUD / 覆盖层 / 触屏控制
tests/e2e/                Playwright 端到端
```

`vitest.config.ts`、`playwright.config.ts`、`package.json` 与锁文件在仓库根目录。

**依赖方向（硬约束）**：

```text
app   → core
app   → games/registry → games/<game>/index（仅静态元数据）
games/<game>/* → core
games/<game>/scene → 对应引擎（scene 模块在 mount 内动态加载）
```

- `core/` 不得导入任何游戏或引擎。
- `games/<game>/index.ts` 只允许 `import type` 与静态元数据；场景必须在 `mount()` 内 `await import()`，纯逻辑 `logic/` 可直接导入，禁止值导入 `scene.ts`。
- registry 用显式 map 或 `import.meta.glob('./*/index.ts')`，保证 Vite 为每个游戏生成独立 chunk；模块依赖方向由 `scripts/check-boundaries.mjs` 检查、TS 语法与常见规则由 oxlint（`src`、`tests` 与 `scripts`）覆盖，入口 chunk 不含 phaser/three 且 gzip < 50 KB 由 `npm run check:budget` 断言。
- `GameModule.mount(root, services, signal: AbortSignal)` 返回 `Promise<GameHandle>`；路由持有 `AbortController`，切换时 abort，晚到的 mount 必须立即 `destroy()` 并丢弃。
- `destroy()` 必须清除监听器、动画帧、WebGL 上下文与音频节点；路由使用 hash（`#/games/<game>`），静态托管无需 SPA fallback，资源路径一律由 `import.meta.env.BASE_URL` 拼接，禁止硬编码 `/games/...`。
- 契约：`GameMeta{id,title,engine,genre}`、`GameServices{storage.get/set,audio.play}`、`GameHandle{destroy}`；存档/音效统一走 `GameServices`，key 前缀用游戏 id（如 `snake.highscore`）。
- **资源管线**：小图标/字体等可被 Vite 处理的资源走 `import`；大模型/纹理/音频放 `public/games/<game>/`，随游戏按需加载；音效优先 WebAudio 合成，减少二进制资源。

## 6. 2D / 3D 扩展路径

### 2D（当前主路径，Phaser 4）

1. `games/<game>/logic/` 写纯规则与状态机，先在 Vitest 覆盖边界。
2. `scene.ts` 用 Phaser Scene 只做绘制与输入，读取逻辑快照，不反向修改规则。
3. `view.ts` 用 DOM 做 HUD、暂停/结束覆盖层、触屏方向键；DOM 比 Canvas 更易访问和响应式。
4. `index.ts` 注册 `GameModule`，在 `registry.ts` 增加条目，大厅自动出现卡片；销毁时调用 `game.destroy(true)` 并清理 DOM/监听器/音频。
5. Phaser 4 与 Phaser 3 存在破坏性差异，迁移旧示例前先查官方 Migration Guide。

### 3D（Three.js，首个 3D 游戏时接入）

1. 新建 `games/<game>/`，`scene.ts` 用具名导入（如 `import { WebGLRenderer, Scene, PerspectiveCamera } from 'three'`）保持 tree-shaking，由 `index.ts` 动态加载。
2. 在 `mount()` 创建 `WebGLRenderer`，`destroy()` 中依次 `setAnimationLoop(null)`、`dispose()` 几何体/材质/纹理、`renderer.dispose()` + `forceContextLoss()`、移除 canvas、断开 ResizeObserver 并 `exitPointerLock()`；处理 resize 与 `visibilitychange` 暂停。
3. 相机控制器（PointerLock/Orbit）与 `three/addons/loaders/GLTFLoader.js` 按游戏深导入，不放进共享层。
4. 资源放 `public/games/<game>/`，实际 URL 用 `${import.meta.env.BASE_URL}games/<game>/...`；首版避免大体积模型。
5. 复用共享契约：路由、暂停、音效、最高分、返回大厅。

**预算**：大厅首屏 JS < 50 KB gzip；单个 2D 游戏首局总下载（含共享 Phaser 块）< 450 KB gzip（Phaser 约 360 KB，游戏代码约 90 KB）；3D 首局总下载 < 800 KB gzip。超出时拆分场景或延迟非关键资源。

## 7. 本地开发 / 构建 / 测试命令

前置：Node.js 版本见 §4（推荐 24 LTS），npm 10+。

```bash
npm ci                              # 安装锁定依赖
npx playwright install --with-deps chromium   # 首次安装浏览器（Linux 需 root 或预装依赖）

npm run dev                         # 开发服务器，默认 http://localhost:5173
npm run typecheck                   # tsc --noEmit
npm run lint                        # oxlint（src / tests / scripts）+ scripts/check-boundaries.mjs 依赖方向检查
npm run test:unit                   # Vitest 单测（规则/状态机/存储）
npm run build                       # typecheck + vite build → dist/
npm run check:budget                # 入口 chunk 无引擎 + gzip 预算
npm run preview                     # 本地预览生产构建
npm run test:e2e                    # 先 build；webServer 只拉起 preview
```

上述 npm scripts（含 `lint`、`check:budget`）由 t2 落地时写入 `package.json`；`test:e2e` 前需先 `build`，Playwright `webServer` 只启动 `preview`。端到端最低覆盖：进入/退出、暂停/重开、最高分持久化、快速切换不残留 canvas/RAF、触屏/移动视口、基本可访问性、用可控延迟的假 `GameModule` 覆盖 abort 后晚到 mount；WebKit/Firefox 暂不纳入 v1。

TypeScript 7 为原生编译器，`tsc --noEmit` 是唯一类型门禁；Vite/Vitest 只转译，不做类型检查。CI 顺序：`npm ci` → `typecheck` → `lint` → `test:unit` → `build` → `check:budget` → `test:e2e` → 归档 `dist/`。

## 8. 风险与复核条件

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 2D 引擎共享块较大 | 首局加载稍慢 | 仅进入游戏时加载；构建时抽成共享引擎 chunk，跨游戏缓存复用 |
| 2D/3D 两套引擎增加维护面 | 升级成本 | 引擎只出现在各游戏内部，共享层引擎无关 |
| 3D 尚未实测 | 规划可能与现实不符 | 首个 3D 游戏作为验收点，再更新本文与预算 |

出现以下情况重新评估 ADR-001：2D 游戏 ≥ 5 个且 Phaser 缓存/包体成为瓶颈；3D 游戏 ≥ 3 个且 Three.js 工程化能力不足；引擎出现破坏性升级；需要单引擎统一编辑/发布。

## 9. 参考资料

- Phaser：<https://phaser.io> · Three.js：<https://threejs.org/manual/> · Vite：<https://vite.dev/guide/>
- PixiJS：<https://pixijs.com> · Babylon.js：<https://www.babylonjs.com> · Kaplay：<https://kaplayjs.com> · MDN Games：<https://developer.mozilla.org/en-US/docs/Games>
