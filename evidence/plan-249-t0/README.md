# 镇煞风格层 Before / After 对照（#249 t1）

- Before：`66bf2da`（rebase 后的 main）。截图最初在 `c9fbf6f` 捕获；本节点在
  `66bf2da` 重拍，四张 PNG 逐字节一致——两者之间只新增 `bosses.ts` 数据、测试与
  文档，镇煞视觉层相同。
- After：`4b52054`（rebase 后的分支 head）。截图最初捕获于 rebase 前 `6cafece`；
  本节点在 rebase 后的 head 重拍，四张 PNG 同样逐字节一致，视觉层未变。

四张 PNG 都是在本地构建产物上用 Playwright 的 Chromium 实拍，不是 mockup：

- 路由：`#/games/zhen-sha`，初始战斗状态（HUD：势 0 / 完美 0 / 中招 0/3，结算 overlay 隐藏）。
- 视口：1440×1000 与 320×640；`deviceScaleFactor: 1`、`colorScheme: dark`、
  `reducedMotion: reduce`。
- 同一份捕获脚本先 `clock.install`，再用 `runFor(900)` 加 `runFor(32)` 手动推进 932 ms；
  页面加载期间时钟也按真实时间前进（实测约 0.54 s），截图前还会 `scrollTo(0, 0)` 并等待
  80 ms，提交帧的有效页面时间因此约 1.47 s（按该脚本重放可逐字节复现）；两张图落在同一
  游戏 tick，before / after 的 HUD 文本与 canvas 像素哈希一致，差异只来自风格层。
- 分层像素核对：关闭 `::before` 后 1440×1000 有 172,607 个像素变化（320×640 为
  85,571）；关闭 `::after` 后仍有 1,527 / 1,119 个像素变化，证明纸纹与飞白各自可见，
  且 `::before`/`::after` 的 `pointer-events: none` 不拦截手势。
- HUD 与手势提示：1440×1000 下 HUD 位于舞台上方，手势提示在舞台下方；320×640 下
  HUD、提示、舞台依次排列，互不重叠。

复现：构建对应提交（`npm run build`）后 `vite preview`，用 Playwright 以相同视口和主题
`clock.install`、导航到 `#/games/zhen-sha`、`runFor(900)`、`runFor(32)`，再 `scrollTo(0, 0)`
并等待 80 ms 后截图；`evidence/plan-249-t0/` 只保留对照图与这份说明。
