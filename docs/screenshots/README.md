# 界面截图

这些截图由 `npm run screenshots`（`scripts/capture-screenshots.mjs`）生成，用于 README 与 PR 的视觉对比。截图使用 Playwright Chromium、深色主题、`prefers-reduced-motion: reduce`，并关闭 CSS 动画以获得稳定结果。

| 文件 | 视口 | 场景 |
| --- | --- | --- |
| `before-base-repo.png` | 1440 × 1000 | 基线提交 `937e06c90f852a9cf675a972656d6a23822b44d8` 的 GitHub 仓库页：只有 README，没有可玩界面 |
| `after-hub-desktop.png` | 视口 1440 × 1000（整页高 1769） | 交付版本的大厅 |
| `after-snake-ready.png` | 视口 1440 × 1000（整页高 1057） | 贪食蛇准备开始 |
| `after-snake-playing.png` | 视口 1440 × 1000（整页高 1057） | 吃到第一个果实后（分数 10、长度 4） |
| `after-snake-gameover.png` | 视口 1440 × 1000（整页高 1057） | 撞墙结束 |
| `after-hub-mobile.png` | 390 × 844 @2x | 手机视口的大厅首屏 |
| `after-snake-mobile.png` | 390 × 844 @2x | 手机视口的棋盘与触屏方向键 |

## 关于 Before 证据

基线提交里这个仓库只有一份 README，没有应用、没有构建配置，也不存在可截图的旧界面。因此 Before 截图记录的是**基线提交的真实仓库页面**，而不是旧版游戏界面。After 截图来自本次交付的本地构建。两者的主题（GitHub 深色主题 vs 应用深色主题）与内容类型不同，这是 greenfield 项目的客观限制，PR 中已如实说明；没有用 mockup 冒充旧实现。

基线截图由 `node scripts/capture-baseline.mjs` 生成（需要访问 GitHub）。
