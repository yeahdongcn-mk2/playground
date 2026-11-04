# Web 小游戏框架选型

> 快照日期：2026-11-04。版本、Star 数与下载量会随时间变化，结论应定期复核。
> 本文是 [Issue #7](https://github.com/yeahdongcn-mk2/playground/issues/7) 的调研交付物，决策记录为 ADR-001。

## 1. 背景与约束

目标是让这个仓库成为一个可以持续添加网页小游戏的实验场：

- 第一款作品是可玩的**贪食蛇**，必须真正跑通一套可复用的工程结构，而不只是写一个一次性 demo。
- 未来会出现 **2D 街机**（打砖块、2048、飞行射击等）和 **3D**（迷宫、赛车、第一人称探索等）两类游戏。
- 每个游戏都应该独立可玩、可测试，并且**首屏不为未启动的游戏付出引擎体积**。
- 尽量纯静态部署（无后端、无账号），降低长期维护成本。
- 需要照顾桌面键盘、移动端触屏、可访问性和弱网加载。

## 2. 调研方法与数据快照

调研时间：2026-11-04。数据来自以下可复现来源：

- npm registry：`npm view <pkg> version time.modified`
- GitHub API：`gh api repos/<owner>/<repo>`
- npm downloads API：`https://api.npmjs.org/downloads/point/last-month/<pkg>`
- 各项目官方文档与本仓库实际构建产物

| 项目 | 最新版本 | 定位 | GitHub Stars | npm 月下载（约） | 许可证 |
| --- | --- | --- | ---: | ---: | --- |
| **Phaser** | 4.2.1（2026-07-09） | 2D 游戏框架 | 40,646 | 2,343,542 | MIT |
| **Three.js** | r187（2026-10-30） | 3D 渲染库 | 117,532 | 91,321,437 * | MIT |
| **PixiJS** | 8.22.0（2026-10-01） | 2D 渲染库 | 48,623 | 5,368,738 | MIT |
| **Babylon.js** | 9.33.2（2026-11-02） | 3D 游戏引擎 | 26,295 | 1,370,505 | Apache-2.0 |
| **Kaplay** | 3001.0.19 | 轻量 2D 框架 | 1,823 | 30,770 | MIT |

\* Three.js 的 npm 下载量包含大量构建工具/可视化库的传递依赖，不能直接当作“游戏项目数”。Star 和下载量只作为**生态健康度信号**，最终决策以能力匹配为准。

Phaser 4 于 2026-04-10 发布 4.0.0，是一次 WebGL 渲染器重写，但保持了 Phaser 3 的核心 API（Scene、Game Objects、Input、Tweens 等）。当前 4.2.x 是稳定线。参考：[Phaser 4.0 Release](https://github.com/phaserjs/phaser/releases/tag/v4.0.0)。

## 3. 候选方案对比

| 维度 | Phaser 4 | PixiJS 8 | Three.js | Babylon.js | Kaplay |
| --- | --- | --- | --- | --- | --- |
| 类型 | 完整 2D 游戏框架 | 2D 渲染器 | 3D 渲染库 | 完整 3D 引擎 | 轻量 2D 框架 |
| 场景 / 生命周期 | ✅ 内置 | ❌ 自建 | ❌ 自建 | ✅ 内置 | ✅ 基础 |
| 输入（键盘/指针/触屏） | ✅ 内置 | ✅ 基础事件 | ✅ 基础事件 | ✅ 内置 | ✅ 内置 |
| 音频 | ✅ 内置 | ❌ 自建/插件 | ❌ 自建 | ✅ 内置 | ✅ 内置 |
| 补间 / 粒子 | ✅ 内置 | ❌ 插件 | ❌ 自建 | ✅ 内置 | ✅ 部分 |
| 物理 | ✅ Arcade / Matter | ❌ | ❌ | ✅ 多套 | ✅ 基础 |
| 3D 能力 | ❌（需插件/伪 3D） | ❌ | ✅ 强 | ✅ 强 | ❌ |
| 2D 开发效率 | 高 | 中 | 低 | 中 | 高 |
| 典型生产包体 | 约 363 KB gzip（本仓库实测） | 约 150–250 KB gzip | 按需 tree-shake | 约 700 KB+ gzip | 小 |
| TypeScript 类型 | ✅ 官方 | ✅ 官方 | ✅ 社区维护 | ✅ 官方 | ✅ 官方 |
| 生态与资料 | 很大 | 大 | 最大 | 大 | 小 |

### 关键观察

1. **2D 与 3D 的能力需求差异很大。** 2D 小游戏需要场景管理、输入、音频、补间、粒子等“开箱即用”的系统；3D 更看重相机、材质、光照、模型加载和 WebGPU 路线。让一个引擎同时把两边都做到最好，代价通常是包体和 2D 开发体验。
2. **Phaser 4 + Three.js 的组合覆盖最完整。** Phaser 负责 2D 街机，Three.js 负责 3D；两者都按需加载，互不影响。
3. **PixiJS 是渲染器，不是游戏框架。** 用它需要自己补场景、循环、音频、资源管理等基础设施，长期会重复造轮子。
4. **Babylon.js 是“单引擎全都要”的可行选项**，但 3D 引擎体积更大，2D 工作流不如 Phaser 直接；本项目目前没有必须用单引擎的约束。
5. **Godot / Unity WebGL 被排除**：Web 导出体积通常以数 MB 起步，构建链和首屏体验不适合“点开即玩”的轻量小游戏。
6. **Kaplay 适合快速原型**，但生态、类型完整度和长期维护信号弱于 Phaser，不适合作为多游戏长期底座。

## 4. 决策（ADR-001）

**采用“共享外壳 + 按需引擎”的架构：**

- **构建与语言**：Vite 8 + TypeScript 7（严格模式）。
- **应用外壳**：原生 DOM + CSS，不引入 React/Vue。大厅、路由、HUD、设置等只占很小体积。
- **2D 引擎**：**Phaser 4**。贪食蛇用它实现，验证 2D 适配层。
- **3D 引擎**：**Three.js**（首个 3D 游戏时接入）。不在当前包中预装。
- **共享层**：`GameModule` 契约 + 存档、音效、输入约定、路由、HUD 样式。
- **测试**：Vitest（纯逻辑）+ Playwright（真实浏览器端到端）。
- **加载策略**：每个游戏一个动态 `import()`，引擎随游戏 chunk 加载；大厅首屏不含任何游戏引擎。

### 实测包体（`npm run build`）

| 产物 | 大小 | gzip |
| --- | ---: | ---: |
| 大厅外壳 JS | 20.62 KB | 7.67 KB |
| 全局 CSS | 16.61 KB | 4.61 KB |
| 贪食蛇 + Phaser 4 chunk（懒加载） | 1,384.30 KB | 363.17 KB |

这组数字验证了核心假设：**大厅几乎零成本，只有真正开始一局 2D 游戏时才下载 Phaser。**

### 为什么不是“只选一个框架”

- Phaser 无法可靠覆盖未来 3D 需求；
- Three.js 是渲染库，直接拿来做 2D 会缺少一整套游戏系统；
- Babylon.js 可以同时做 2D/3D，但会增加 2D 游戏的体积和心智负担；
- 共享的是**外壳、契约、工程规范与测试方式**，而不是强行共享同一个渲染器。每个游戏仍然只依赖自己需要的引擎。

## 5. 对未来的约束

- 新游戏必须实现 `GameModule`，并通过 `mount()` 返回可销毁的句柄。
- 引擎只能在游戏模块内部导入，禁止在大厅/核心层静态导入 Phaser 或 Three.js。
- 每个游戏的引擎 chunk 目标：2D < 450 KB gzip，3D < 800 KB gzip；超出时再评估按场景拆包。
- 3D 接入时优先复用 Three.js 生态的控制器和加载器，但输入、存档、音效仍走共享服务。
- 每次新增一个引擎或大版本升级，都需要更新本文的版本快照并复核决策。

## 6. 参考链接

- Phaser：<https://github.com/phaserjs/phaser> · <https://phaser.io>
- Phaser 4.0 Release Notes：<https://github.com/phaserjs/phaser/releases/tag/v4.0.0>
- Three.js：<https://github.com/mrdoob/three.js> · <https://threejs.org/manual/>
- PixiJS：<https://github.com/pixijs/pixijs> · <https://pixijs.com>
- Babylon.js：<https://github.com/BabylonJS/Babylon.js> · <https://www.babylonjs.com>
- Kaplay：<https://github.com/kaplayjs/kaplay> · <https://kaplayjs.com>
- Vite：<https://vite.dev/guide/>
- MDN Games：<https://developer.mozilla.org/en-US/docs/Games>
- npm downloads API：<https://api.npmjs.org/downloads/point/last-month/phaser>
