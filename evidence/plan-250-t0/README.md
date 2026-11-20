# 镇煞大厅卡面 Before / After 证据

- baseline：`origin/main` @ `e088b32`
- after：`agent/plan-250-t0`（本分支提交）
- 场景：大厅 `#games` 游戏卡片区；同一 Chromium、`reducedMotion: reduce`、DPR 1
- 视口：1440×1000（滚到游戏区顶部）与 320×640（滚到镇煞卡片）
- 文件：`{before,after}-{1440x1000,320x640}.png`

## 机械校验

`playwright` 逐卡截取 `.game-card-art` 后比较 SHA-256 与 bounding box：

- 贪食蛇、俄罗斯方块、2048、打砖块、扫雷五张卡片的像素哈希与布局在 before/after 完全一致；
- 镇煞卡片像素不同、布局 box 不变（1440 与 320 两个视口）；
- 镇煞卡带 `.game-card-art--zhen-sha`，专属 `svg.zhen-sha-card-art` 为 `aria-hidden="true"`，无外部图片/字体引用；
- 320px 下卡面高度 156px，镇煞 SVG 240×144，金色 `#f6c453` 与墨黑 `#08070a` 已生效。

复现：`node evidence/plan-250-t0/verify-visual.mjs <before-url> <after-url>`。
