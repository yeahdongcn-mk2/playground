# Playground Arcade

一个可网页游玩的小游戏实验场：共享大厅、输入、存档与音效，游戏引擎按需加载。第一款作品是经典**贪食蛇**，底座为后续的 2D 街机和 3D 游戏做好了分层规划。

![Playground Arcade 大厅](docs/screenshots/after-hub-desktop.png)

## 特性

- 🐍 **完整可玩的贪食蛇**：键盘 / WASD、触屏 D-pad、滑动；暂停、重开、实时最高分。
- 🏗️ **可复用底座**：`GameModule` 契约、游戏注册表、共享存档/音效/路由/HUD。
- ⚡ **懒加载引擎**：大厅首屏 JS 约 7.7 KB gzip（7.67 KB）；Phaser 4 只在进入 2D 游戏时加载。
- 🧪 **真实测试**：23 个单元测试（规则 + 存档容错）+ Playwright 端到端测试 + GitHub Actions CI。
- 📱 **响应式与可访问性**：移动端布局、`aria-live` 状态播报、减少动效支持。
- 🧭 **面向未来**：Phaser 4 承载 2D，Three.js（路线图）承载 3D，两者都不进入大厅首屏。

## 快速开始

要求：Node.js ≥ 22.12（推荐 24 LTS）。

```bash
npm install
npm run dev
```

打开终端输出的本地地址（默认 <http://localhost:5173>）。生产构建与预览：

```bash
npm run build
npm run preview
```

## 操作

| 输入 | 行为 |
| --- | --- |
| `↑` `↓` `←` `→` / `W` `A` `S` `D` | 转向 |
| `空格` / `Enter` | 开始、暂停/继续、结束后重开 |
| `P` / `Esc` | 暂停 / 继续 |
| `R` | 重新开始 |
| 触屏 D-pad / 在棋盘上滑动 | 转向 |

吃到果实 +10 分、长度 +1，并逐渐加速（150 ms/步 → 最低 70 ms/步）。撞墙或撞到自己即结束。

## 脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Vite 开发服务器 |
| `npm run build` | 类型检查 + 生产构建 |
| `npm run preview` | 预览生产构建 |
| `npm run typecheck` | TypeScript 严格检查 |
| `npm run test:unit` | Vitest 单元测试 |
| `npm run test:e2e` | Playwright 端到端测试（首次需 `npx playwright install chromium`） |
| `npm run test:prod` | 生产预览冒烟测试（需先构建） |
| `npm run screenshots` | 重新生成 `docs/screenshots/` 下的界面截图 |

## 目录结构

```
src/
├── app/            大厅、路由、站点外壳
├── core/           GameModule 契约、存档、音效、DOM 辅助
├── games/
│   ├── registry.ts 游戏注册表
│   └── snake/      贪食蛇（engine / Phaser scene / DOM view / 测试）
└── styles/         共享样式
docs/               选型、架构、路线图、贪食蛇设计、截图
tests/e2e/          Playwright 端到端测试
.github/workflows/  CI
```

## 技术选型

| 层 | 选择 | 理由 |
| --- | --- | --- |
| 构建 | Vite 8 | 快速开发服务器，天然按游戏拆包 |
| 语言 | TypeScript 7（严格模式） | 规则与接口的类型安全 |
| 2D | Phaser 4 | 场景、输入、音频、补间、粒子开箱即用 |
| 3D | Three.js（规划） | 最大的 3D 生态；首个 3D 游戏接入 |
| 外壳 | 原生 DOM + CSS | 大厅更小、更快、更易访问；无需 UI 框架 |
| 测试 | Vitest + Playwright | 规则与真实浏览器行为分别验证 |

完整的框架对比、实测包体与替代方案分析见 [docs/framework-selection.md](docs/framework-selection.md)，分层与扩展方式见 [docs/architecture.md](docs/architecture.md)，阶段计划见 [docs/roadmap.md](docs/roadmap.md)，贪食蛇玩法与测试见 [docs/snake-design.md](docs/snake-design.md)。

## 测试与 CI

```bash
npm run typecheck
npm run test:unit
npm run build
npx playwright install chromium   # 首次运行 e2e
npm run test:prod                # 生产预览：确认调试钩子不存在
npm run test:e2e
```

CI（`.github/workflows/ci.yml`）在 push 到 `main` 与 PR 时依次执行类型检查、单元测试、生产构建、生产预览冒烟和 Playwright。端到端测试使用开发服务器，并通过 `window.__playground` 只读状态快照做断言；`test:prod` 另行验证生产构建。

## 部署

产物是 `dist/` 下的纯静态文件，可以部署到任意静态托管（GitHub Pages、Netlify、Vercel、对象存储）。如果部署在子路径，需要在 `vite.config.ts` 中设置对应的 `base`。

> 本仓库同时用于 dsh-superagent 的端到端验证，内容可能会被自动化流程更新。
