# 截图来源

这些截图用于各期交付的 Before / After 视觉证据。全部由 Playwright Chromium 真实渲染，不是 mockup。

## t4：2048（PR #26）

- Before 基线：main `d54ae9f`（PR #26 的父提交）。大厅还没有 2048 卡片，`#/games/2048` 显示「没有找到这个游戏」。
- After：本 PR head（见 PR 描述中的 commit SHA）。
- 视口 / 主题：桌面 1440×1000、手机 390×844（DPR 2），深色主题，`reducedMotion: reduce`。
- 生成：`npm run screenshots:2048`（生产构建 + `vite preview`，固定棋盘走 `?debug=1` 的只读接缝）。
- 复现 Before：在 `d54ae9f` 的干净 worktree 里 `npm ci && npm run build`，用 `node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4184 --strictPort` 启动预览，然后在分支运行 `BASE_URL=http://127.0.0.1:4184 npm run screenshots:2048:before`。

### Before（main，没有 2048）

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `before-2048-hub-desktop.png` | main 大厅 | 1440×1000 / 深色 | 只有贪食蛇与俄罗斯方块卡片。 |
| `before-2048-hub-mobile.png` | main 大厅（手机） | 390×844（DPR 2）/ 深色 | 单列大厅，没有 2048 卡片。 |
| `before-2048-route-desktop.png` | main 访问 `#/games/2048` | 1440×1000 / 深色 | 真实基线：2048 未注册，显示「没有找到这个游戏」。 |
| `before-2048-route-mobile.png` | main 访问 `#/games/2048`（手机） | 390×844（DPR 2）/ 深色 | 同上，手机视口。 |

### After（本 PR）

`after-hub-desktop.png` / `after-hub-mobile.png` 已刷新为同时含贪食蛇、俄罗斯方块与 2048 卡片的大厅；其余为 2048 游戏页的三种状态。

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `after-hub-desktop.png` | 大厅 | 1440×1000 / 深色 | 新增 2048 卡片与入口。 |
| `after-hub-mobile.png` | 大厅（手机） | 390×844（DPR 2）/ 深色 | 单列布局中的 2048 卡片。 |
| `after-2048-ready-desktop.png` | 2048 READY | 1440×1000 / 深色 | 棋盘、方块、HUD 与开始遮罩。 |
| `after-2048-playing-desktop.png` | 2048 游玩中 | 1440×1000 / 深色 | 合并后的分数、棋盘与侧栏。 |
| `after-2048-gameover-desktop.png` | 2048 GAME OVER | 1440×1000 / 深色 | 无路可走结算与重开入口。 |
| `after-2048-ready-mobile.png` | 2048 READY（手机） | 390×844（DPR 2）/ 深色 | 手机端棋盘与开始遮罩。 |
| `after-2048-playing-mobile.png` | 2048 游玩中（手机） | 390×844（DPR 2）/ 深色 | 手机端棋盘、HUD 与滑动提示。 |
| `after-2048-gameover-mobile.png` | 2048 GAME OVER（手机） | 390×844（DPR 2）/ 深色 | 手机端结算与重开入口。 |

### 证据限制

- main 没有 2048 页面，所以 Before 只能对比大厅（同一视口 / 主题）与真实未注册路由，不能与旧版 2048 页面逐像素对比。
- 手机端为 Playwright 设备模拟（390×844、DPR 2、触摸），不是真实设备截图。
- 截图来自生产构建；绘制行为另有 e2e 读取 canvas 像素验证，不依赖截图比对。

## t3：贪食蛇（PR #14）

- Before 基线：t2 已合入 main 的 `60c0206`（squash commit，树内容 = t2 分支 head `c9e8dec`）。截图在 `c9e8dec` 的干净 worktree 捕获。
- After：本 PR head（见 PR 描述中的 commit SHA）。
- 视口 / 主题：桌面 1440×1000、手机 390×844（DPR 2），深色主题，`reducedMotion: reduce`。
- 生成：`npm run screenshots:snake`（开发服务器 + 固定首果 `?food=11,10`）。
- 复现 Before：`git worktree add /tmp/t2-baseline 60c0206`，把本分支的 `scripts/capture-snake-screenshots.mjs` 复制进去，在 worktree 里 `npm ci && node scripts/capture-snake-screenshots.mjs --before`。`--before` 读取当前工作树，不要在本分支直接运行，否则 Before 会被贪食蛇构建覆盖。

### Before（t2 框架，没有贪食蛇）

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `before-framework-hub.png` | t2 大厅 | 1440×1000 / 深色 | 只有空白画布卡片，主 CTA 是「进入空白画布」。 |
| `before-framework-blank.png` | t2 空白画布游戏 | 1440×1000 / 深色 | 框架唯一可玩的入口。 |
| `before-framework-hub-mobile.png` | t2 大厅（手机） | 390×844（DPR 2）/ 深色 | 单列大厅，只有空白画布卡片。 |
| `before-framework-snake-route.png` | t2 访问 `#/games/snake` | 1440×1000 / 深色 | 真实 baseline：t2 未注册 snake，显示「没有找到这个游戏」。 |

### After（本 PR）

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `after-hub-desktop.png` | 大厅 | 1440×1000 / 深色 | 新增贪食蛇卡片，主 CTA 改为「开始贪食蛇」。 |
| `after-snake-ready.png` | 贪食蛇 READY | 1440×1000 / 深色 | HUD、棋盘、覆盖层与 D-pad（桌面隐藏）。 |
| `after-snake-playing.png` | 贪食蛇游玩中 | 1440×1000 / 深色 | 固定首果被吃后的得分、长度与速度。 |
| `after-snake-gameover.png` | 贪食蛇 GAME OVER | 1440×1000 / 深色 | 撞墙结算、最高分与重开入口。 |
| `after-hub-mobile.png` | 大厅 | 390×844（DPR 2）/ 深色 | 单列布局。 |
| `after-snake-mobile.png` | 贪食蛇（手机） | 390×844（DPR 2）/ 深色 | 棋盘、D-pad 与操作面板堆叠。 |

### 证据限制

- 贪食蛇页面在 baseline 不存在：`before-framework-snake-route.png` 是 t2 访问该路由的真实「没有找到这个游戏」响应，不是 mockup；`before-framework-blank.png` 是 t2 唯一的游戏页。大厅是同一页面、同一视口的前后对比；游戏页只能做状态对比，不能与不存在的旧贪食蛇页逐像素对比。
- 手机端为 Playwright 设备模拟（Pixel 7 视口与触摸），不是真实设备截图。
- `after-snake-*` 来自开发服务器，用于固定首果和覆盖层状态；生产构建由 `npm run build` 与 e2e 单独验证。

## t2：共享框架

这些截图用于 Issue #11 子任务 t2 的 Before / After 视觉证据。全部由 Playwright Chromium 真实渲染，不是 mockup。

### Before

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `before-base-repo.png` | base commit `91fe3be` 的 GitHub 仓库页 | 1440×1000 / GitHub 深色 | 起点只有 README 与一个 plan smoke 标记文件，没有任何应用界面。 |

生成方式（需要访问 GitHub）：

```bash
npm run screenshots:baseline
```

### After

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `after-blank-desktop.png` | 空白画布游戏（指针移动后） | 1440×1000 / 深色 | 可交互画布、HUD、操作面板与重置入口。 |
| `after-blank-mobile.png` | 空白画布游戏（触屏移动后） | 390×844（DPR 2）/ 深色 | 自适应画布、触屏操作与面板堆叠。 |

`after-hub-desktop.png` / `after-hub-mobile.png` 已由 t4 更新为含 2048 卡片的大厅。

生成方式（会先构建，再用 `vite preview` 在 4174 端口启动生产预览）：

```bash
npm run screenshots
```

截图使用 `reducedMotion: 'reduce'`，避免动效造成每张图不一致。

### 证据限制

- 起点没有应用 UI，所以 Before 只能是 base commit 的仓库页，无法提供“同一应用场景”的旧版截图；Before / After 的页面内容不同，不能逐像素比较。
- 手机端为 Playwright 设备模拟（Pixel 7 视口与触摸），不是真实设备截图。
