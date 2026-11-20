# 镇煞大厅卡面 Before / After 证据

- baseline：`origin/main` @ `e088b32`
- after：本分支 head（以 PR 描述中标注的 revision 为准；截图提交只改实现与证据，不再改卡面行为）
- 场景：大厅 `#games` 游戏卡片区；同一 Chromium、`reducedMotion: reduce`、DPR 1
- 视口：1440×1000（滚到游戏区顶部）与 320×640（滚到镇煞卡片）
- 文件：`{before,after}-{1440x1000,320x640}.png`

本目录是本 PR 的复现材料，用于在 PR 描述中给出 Before/After 对照，不替代
`docs/screenshots/` 的固定容器截图与 sha256 清单；仓库级大厅截图仍由
`docs/screenshots/README.md` 规定的 owner 命令生成。

## 实现口径（改道后）

镇煞专属卡面只存在于 `src/styles/app.css`：用大厅卡片已有的
`a.game-card[href="#/games/zhen-sha"]` 钩子定位，`::before` 伪元素承载水墨圆环 +
金色棍弧的内联 SVG data URI，并隐藏默认 `.mini-orb`。`src/app/hub.ts` 只保留说明性
注释，入口 JS 不内联 SVG 或长字符串，因此 `entryGzipBytes` / `totalJsGzipBytes`
与 baseline 一致。

## 机械校验

`@playwright/test` 的 Chromium 逐卡截取 `.game-card-art` 后比较 SHA-256 与 bounding box：

- 贪食蛇、俄罗斯方块、2048、打砖块、扫雷五张卡片的像素哈希与布局在 before/after 完全一致；
- 镇煞卡片像素不同、布局 box 不变（1440 与 320 两个视口）；
- 镇煞卡保留默认卡面标记（无内联 SVG、无 `game-card-art--zhen-sha`），专属卡面来自
  伪元素 data URI，解码后含 `viewBox='0 0 220 132'`、金色 `#f6c453` 与墨黑 `#08070a`；
- 320px 下卡面高度 156px，伪元素宽度为卡面的 84%，金色 `#f6c453` 与墨黑 `#08070a` 生效。

## 捕获与校验

- 捕获：`node evidence/plan-250-t0/capture-hub.mjs <url> <output-prefix>`；用同一 Chromium
  与视口参数分别对 baseline、after 运行，输出 `before-*.png` / `after-*.png`。
- 校验：`node evidence/plan-250-t0/verify-visual.mjs <before-url> <after-url>`，逐卡截取
  `.game-card-art` 后比较 SHA-256 与 bounding box，并检查 after 的 CSS 伪元素卡面。
  该脚本只做机械校验，不重写上面四张 PNG。

两个脚本都只从已声明的 `@playwright/test` 导入浏览器，不从传递依赖 `playwright` 导入。
