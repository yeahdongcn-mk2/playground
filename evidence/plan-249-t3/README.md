# 镇煞动效层 Before / After 对照（#249 动效层，rebased in #431 t2 / PR #412）

- Before：`68f376c`（PR #412 rebase 时的 `origin/main`，尚未含本 PR 的动效层）。
  早先的 `3ba9cc1` 基线已被 #406 的 4+1 色板与 #411 的朱砂印 / 字标 / 金边取代，
  因此 rebase 后以最新 `main` 为 Before 重采。
- After：本 PR rebase 后的 head（`agent/plan-249-t2`，合并 `main` `68f376c`
  并重新施加循环墨雾 / 边缘抖动 / 扫描线与 reduced-motion 关闭逻辑）。
- 本目录的 PNG 是本地构建产物上的 Playwright Chromium 实拍，不是 mockup。

## 场景与捕获

- 路由 `#/games/zhen-sha`，初始战斗状态：HUD 势 0 / 完美 0 / 中招 0/3，
  结算 overlay 隐藏。
- 视口 1440×1000 与 320×640；`deviceScaleFactor: 1`、`colorScheme: dark`。
- 捕获前用 `clock.install`，再 `runFor(900)` + `runFor(32)` 推进游戏时钟；
  再把完整舞台滚入视口（320×640 需要约 133 px），等待 120 ms。
- `before-*.png` / `after-*.png`：`reducedMotion: no-preference`。截图前把三条
  CSS 动画暂停在 `currentTime = 1500ms`，让两侧停在同一相位。
- `before-reduce-*.png` / `after-reduce-*.png`：`reducedMotion: reduce`，无动画。

## 像素核对

用 Pillow 读取 PNG，逐像素比较 RGB（Before 与 After 尺寸与游戏 tick 相同）：

| 视口 | 状态 | Before→After 变化像素 | 舞台外变化 |
| --- | --- | ---: | ---: |
| 320×640 | no-preference | 130,638 | 0 |
| 320×640 | reduce | 120,414 | 0 |
| 1440×1000 | no-preference | 263,728 | 0 |
| 1440×1000 | reduce | 243,531 | 0 |

- 变化全部落在 `.zhen-sha-stage` 内；HUD 与手势提示区域逐像素相同。
- 舞台完整落在视口内：320×640 为 y 171.4–631.8，1440×1000 为 y 192.1–845.5。

## reduced-motion 运行时核对

Chromium 中 `matchMedia('(prefers-reduced-motion: reduce)').matches === true` 时：

- `document.getAnimations()` 长度为 0。
- `::before` 与 `::after` 的 `animation-name` 均为 `none`。
- `--fx-scan` 为 `transparent`。
- overlay `z-index: 4` 高于 `::before` 的 1，且 `overlay.hidden === true`。
- 正常动效下三条循环只出现在伪元素上：`zhen-sha-ink-mist` 38s、
  `zhen-sha-scanlines` 9s、`zhen-sha-jitter` 7s；`motion.test.ts` 另行守护
  三条 keyframes、`infinite` 绑定、扫描线 3px 周期与 6px 位移整数倍关系。

## 复现

构建对应提交（`npm run build`）后 `vite preview`，然后：

```bash
node evidence/plan-249-t3/capture-motion.mjs <base-url> evidence/plan-249-t3/before
node evidence/plan-249-t3/capture-motion.mjs <after-base-url> evidence/plan-249-t3/after
```
