# 镇煞风格层 Before / After 对照（#249 t1）

- Before：`c9fbf6f`（本 PR 最初的 base；当前合并基线 `a219ea6` 相对它只新增
  `bosses.ts` / 测试 / 文档，镇煞视觉层相同）
- After：截图捕获于 `6cafece`（该提交对 CSS 仅改注释，视觉层与 `de3c22d` 相同）；
  当前 head 在其后只追加 evidence、测试与文档。

四张 PNG 都是在本地构建产物上用 Playwright 的 Chromium 实拍，不是 mockup：

- 路由：`#/games/zhen-sha`，初始战斗状态（HUD：势 0 / 完美 0 / 中招 0/3，结算 overlay 隐藏）。
- 视口：1440×1000 与 320×640；`deviceScaleFactor: 1`、`colorScheme: dark`、
  `reducedMotion: reduce`。
- 同一份捕获脚本先 `clock.install` 再把页面时间推进到 900 ms，两张图因此落在同一游戏
  tick；before / after 的 HUD 文本与 canvas 像素哈希一致，差异只来自风格层。
- 分层像素核对：关闭 `::before` 后 1440×1000 有 172,607 个像素变化（320×640 为
  85,571）；关闭 `::after` 后仍有 1,527 / 1,119 个像素变化，证明纸纹与飞白各自可见，
  且 `::before`/`::after` 的 `pointer-events: none` 不拦截手势。
- HUD 与手势提示：1440×1000 下 HUD 位于舞台上方，手势提示在舞台下方；320×640 下
  HUD、提示、舞台依次排列，互不重叠。

复现：构建对应提交（`npm run build`）后 `vite preview`，用 Playwright 以相同视口、
主题和 `clock.runFor(900)` 截图；`evidence/plan-249-t0/` 只保留对照图与这份说明。
