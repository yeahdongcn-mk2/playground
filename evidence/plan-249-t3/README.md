# 镇煞动效层 Before / After 对照（#249 t2 评审修复）

- Before：`3ba9cc1`（PR #412 的 base，t2 动效层改动前）。
- After：`0a98289`（本次评审修复提交：断言、注释与文档；视觉与 `dbab40c`
  相同，评审修复没有改样式效果）。
- 本目录的 PNG 是本地构建产物上的 Playwright Chromium 实拍，不是 mockup。

## 场景与捕获

- 路由 `#/games/zhen-sha`，初始战斗状态：HUD 势 0 / 完美 0 / 中招 0/3，
  结算 overlay 隐藏。
- 视口 1440×1000 与 320×640；`deviceScaleFactor: 1`、`colorScheme: dark`。
- 捕获前用 `clock.install`，再 `runFor(900)` + `runFor(32)` 推进游戏时钟；
  滚动页面让 HUD 与完整舞台进入视口，等待 120 ms。
- `before-*.png` / `after-*.png`：`reducedMotion: no-preference`。截图前把三条
  CSS 动画暂停在 `currentTime = 1500ms`，让两侧停在同一相位。
- `before-reduce-*.png` / `after-reduce-*.png`：`reducedMotion: reduce`，无动画。

## 像素核对

用 Pillow 读取 PNG，逐像素比较 RGB：

| 视口 | 状态 | Before→After 变化像素 | 舞台外变化 |
| --- | --- | ---: | ---: |
| 320×640 | no-preference | 132,503 | 0 |
| 320×640 | reduce | 120,867 | 0 |
| 1440×1000 | no-preference | 266,900 | 0 |
| 1440×1000 | reduce | 244,386 | 0 |

- 变化全部落在 `.zhen-sha-stage` 内；HUD 与手势提示区域逐像素相同。
- 舞台完整落在视口内：320×640 为 y 166.4–626.8，1440×1000 为 y 104.1–757.4。

## reduced-motion 运行时核对

Chromium 中 `matchMedia('(prefers-reduced-motion: reduce)').matches === true` 时：

- `document.getAnimations()` 长度为 0。
- `::before` 与 `::after` 的 `animation-name` 均为 `none`。
- `--fx-scan` 为 `transparent`。
- overlay `z-index: 3` 高于 `::before` 的 1，且 `overlay.hidden === true`。
- 正常动效下三条循环只出现在伪元素上：`zhen-sha-ink-mist` 38s、
  `zhen-sha-scanlines` 9s、`zhen-sha-jitter` 7s；采样 0/3000/6000/9000 ms
  可见 mist transform 与扫描线 `background-position` 变化，扫描线在 9s 回到
  0，说明 6px 位移是 3px 周期的整数倍。

## 复现

构建对应提交（`npm run build`）后 `vite preview`，用 Playwright Chromium
按上述视口、主题、`reducedMotion` 与时钟步骤导航到 `#/games/zhen-sha` 并截图。
