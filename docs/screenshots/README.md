# 截图来源

这些截图用于 Issue #11 子任务 t2 的 Before / After 视觉证据。全部由 Playwright Chromium 真实渲染，不是 mockup。

## Before

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `before-base-repo.png` | base commit `91fe3be` 的 GitHub 仓库页 | 1440×1000 / GitHub 深色 | 起点只有 README 与一个 plan smoke 标记文件，没有任何应用界面。 |

生成方式（需要访问 GitHub）：

```bash
npm run screenshots:baseline
```

## After

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `after-hub-desktop.png` | 大厅首页 | 1440×1000 / 深色 | 共享外壳、游戏卡片、框架能力与快速开始。 |
| `after-blank-desktop.png` | 空白画布游戏（指针移动后） | 1440×1000 / 深色 | 可交互画布、HUD、操作面板与重置入口。 |
| `after-hub-mobile.png` | 大厅首页 | 390×844（DPR 2）/ 深色 | 单列布局与移动端导航。 |
| `after-blank-mobile.png` | 空白画布游戏（触屏移动后） | 390×844（DPR 2）/ 深色 | 自适应画布、触屏操作与面板堆叠。 |

生成方式（会先构建，再用 `vite preview` 在 4174 端口启动生产预览）：

```bash
npm run screenshots
```

截图使用 `reducedMotion: 'reduce'`，避免动效造成每张图不一致；After 截图对应本次 PR 的交付版本。

## 证据限制

- 起点没有应用 UI，所以 Before 只能是 base commit 的仓库页，无法提供“同一应用场景”的旧版截图；Before / After 的页面内容不同，不能逐像素比较。
- 手机端为 Playwright 设备模拟（Pixel 7 视口与触摸），不是真实设备截图。
