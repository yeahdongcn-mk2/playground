# 截图来源

这些截图用于各期交付的 Before / After 视觉证据。全部由 Playwright 的 Chromium 或 WebKit 真实渲染（各节注明引擎），不是 mockup。

引擎标注：文件名 `-desktop` 为 Chromium 1440×1000；`-mobile` 为 Chromium 手机截图（扫雷 `-mobile` 为 Pixel 7 412×839，扫雷成绩为 320×640；其余手机图多为自定义 390×844，大厅为全页长图）；`-webkit` / `-webkit-narrow-*` 为 WebKit `iPhone SE (3rd gen)` 设备模拟。WebKit 手机截图的命令、设备参数与引擎 / 视口 / 主题记录见「webkit-phone」与「webkit-narrow」两节；Chromium 的既有命令与文件名保持不变。

## 固定捕获环境（Issue #199）

- 目的：把浏览器构建、字体、DPR 与 EGL / 软件渲染固定到同一环境，让截图捕获可复现；宿主上的普通 `npm run screenshots:*` 命令保持不变，只多打印一行环境指纹，不会因为缺少字体 / EGL 探测而失败。
- 镜像 tag / digest：`mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f`。tag 的版本来自 `package-lock.json` 的 `@playwright/test`（当前 1.64.1），digest 固定多架构镜像；契约常量在 `scripts/lib/capture-env.mjs` 的 `PLAYWRIGHT_IMAGE_PIN`。升级 Playwright 时必须同时更新该常量、`docker/capture/Dockerfile` 的 `FROM` 与本节。
- 容器镜像：`docker/capture/Dockerfile` 以上述 digest 为基础，只校验官方镜像自带的 `libegl1` / `libegl-mesa0` / `libgl1` / `libgl1-mesa-dri` / `libglx-mesa0` 与 EGL vendor 文件，不安装任何额外系统包；构建失败会指出缺失的包名。
- 字体：保留官方镜像自带字体，不额外引入会改变光栅的字体；固定清单为 `fonts-freefont-ttf`、`fonts-ipafont-gothic`、`fonts-liberation`、`fonts-noto-color-emoji`、`fonts-tlwg-loma-otf`、`fonts-unifont`、`fonts-wqy-zenhei`。字体版本由容器内 `dpkg-query` 实测记录，不预置未知版本；记录与实际不一致时按环境差异处理，而不是静默重拍。
- EGL / 软件渲染变量：`EGL_PLATFORM=surfaceless`、`LIBGL_ALWAYS_SOFTWARE=1`、`__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json`。缺少 WebKit 会报 `Could not create surfaceless EGL display`；容器入口会校验这三个变量，缺失或值不符时指出变量名与期望值。
- 按捕获目标的 DPR（不做全局常量）：

| 捕获目标 | DPR | 说明 |
| --- | --- | --- |
| `desktop` | 1 | Chromium 桌面视口截图 |
| `mobile` | 2 | Chromium 手机截图（含扫雷 Pixel 7 与 390×844 大厅） |
| `webkit` | 2 | WebKit `iPhone SE (3rd gen)` 设备模拟与窄屏矩阵 |

- 环境指纹：`captureEnvironmentFingerprint({ target, run })` 按固定字段顺序输出 `source`（`host` / `container`）、`target`、`dpr`、`image`、`node`、`playwright`、`browser`（捕获运行时传入 `browser.version()`；直接调用且未提供时为 `null`）、`fonts`、`env`。容器内记录镜像 tag / digest、Node 与 Playwright 版本、字体包版本、三个 EGL 变量与目标 DPR；宿主上标 `source=host`，`image` / `fonts` / `env` 记为 `unavailable`，不抛错。
  指纹按**捕获上下文**记录：每类捕获目标第一次创建上下文时打印一行，同一目标每次运行只打印一行。Chromium 运行会同时创建桌面与手机上下文，因此分别输出 `target=desktop dpr=1` 和 `target=mobile dpr=2`，不会把 DPR 2 的手机图记成桌面；WebKit 运行输出 `target=webkit dpr=2`。容器内日志示例如下：
  ```text
  capture-env: source=container target=webkit dpr=2 image=mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f node=v26.13.0 playwright=1.64.1 browser=27.2 fonts=fonts-freefont-ttf@20211204+svn4273-2,fonts-ipafont-gothic@00303-21ubuntu1,fonts-liberation@1:2.1.5-3,fonts-noto-color-emoji@2.047-0ubuntu0.24.04.1,fonts-tlwg-loma-otf@1:0.7.3-1,fonts-unifont@1:15.1.01-1build1,fonts-wqy-zenhei@0.9.45-8 env=EGL_PLATFORM=surfaceless,LIBGL_ALWAYS_SOFTWARE=1,__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json
  ```
  宿主上同一行是 `source=host ... image=unavailable ... fonts=unavailable env=unavailable`。
- 容器命令：`npm run screenshots:container -- <target> [passthrough...]`，其中 `<target>` 是现有的截图 npm script（例如 `screenshots:webkit`、`screenshots`、`screenshots:snake`）；透传参数直接跟在 target 后，例如 `npm run screenshots:container -- screenshots:snake --allow-historical-overwrite`（`screenshots:snake` 会读取该开关；`screenshots:webkit` 不支持它，会静默忽略）。历史 After 图的覆盖开关只在固定容器内生效：未注入容器指纹时宿主直接带 `--allow-historical-overwrite` 会被共享守卫拒绝并给出可读错误，必须通过本命令重拍。入口会预检 Docker CLI / daemon、镜像 tag 与锁文件版本、target 白名单和该 target 的预览端口，再挂载仓库、按需在容器内 `npm ci`、构建并执行原截图命令；容器入口按脚本的捕获模式注入 `CAPTURE_TARGET` / `CAPTURE_TARGET_DPR`（Chromium 截图脚本为 `desktop,mobile` / `1,2`，WebKit 脚本为 `webkit` / `2`，只截手机的窄屏 / 触屏模式为 `mobile` / `2`），并在容器内校验列表中的每个目标与固定 DPR 一致；运行时再按实际创建的上下文逐目标打印指纹。产物经挂载写回宿主 `docs/screenshots/`，日志写到 `test-results/capture-container/<target>-<timestamp>.log`（已被 `.gitignore` 忽略）。捕获只依赖容器内浏览器，宿主不需要安装 Playwright 浏览器。
- 验收口径：2026-11-12 在临时工作副本中以 `npm run screenshots:container -- screenshots:webkit` 连跑两次，`after-blank-webkit.png` 的 sha256 两次相同且等于已提交的 `cd4ed3fea1e0a068661c8102ee0b58b0601b3a249e480d76224d22782a0e088f`；顺带写出的 `after-hub-webkit.png` 不纳入本子任务验收。容器内日志中的指纹与本节记录的镜像 tag / digest、EGL 变量与 DPR 一致。

## 历史 After 证据与当前构建不一致（Issue #137）

- 权威对照口径：逐字节比较只在同一构建、同一捕获环境下的确定性产物之间成立。需要与历史提交对照时，用同一脚本在父提交（或该图的历史捕获 commit）的干净 worktree 里重拍，再与同一次重拍的另一次运行比较；不要求重跑结果等于已提交的历史 `fullPage` PNG。历史 After 图只代表各自 PR 时点的 UI 快照，不是当前构建的确定性基准。
- 页脚漂移：`60bc3f3`（#36）把共享页脚文案从「四款游戏已上线」改成「五款游戏已上线」。桌面整页图（`fullPage: true`）会把页脚一起截入，因此在这之前捕获的桌面 After 图用当前构建重跑必然不同；差异通常只落在页脚文本带，不能据此判定当前 UI 或截图脚本回归。
- 本次核对出的历史 After 图（保留原产物，不重拍、不改 PNG；整页尺寸只写已提交 PNG 的值，当前构建重跑尺寸仅作正文对照）：
  - `after-2048-ready-desktop.png` / `after-2048-ready-mobile.png`：`8ec4adc`（#26）捕获。桌面整页图含旧页脚；手机 ready 图当前构建重跑有 15599 个像素不同（每通道最大 20，集中在棋盘面板边缘），不是页脚。
  - `after-breakout-ready-desktop.png` / `after-breakout-levelclear-desktop.png` / `after-breakout-gameover-desktop.png`：`26e84fa`（#29）捕获。
  - `after-snake-ready.png` / `after-snake-gameover.png` / `after-snake-mobile.png`：`048fe5a`（#14）捕获。桌面整页图除页脚文本带外，画布区域还有每通道差 1 的像素（bbox 约 x 245–876、y 218–847）；手机图不含页脚，重跑仍有约 54596 个像素每通道差 1。
  - `after-breakout-ready-mobile.png` / `after-breakout-gameover-mobile.png`：`26e84fa`（#29）捕获。这两张手机视口图的重跑差异覆盖游戏区约 y=472..1565，不是页脚。
  - `after-minesweeper-ready-desktop.png` / `after-minesweeper-playing-desktop.png` / `after-minesweeper-lost-desktop.png` / `after-minesweeper-won-desktop.png` 与对应 `after-minesweeper-ready-mobile.png` / `after-minesweeper-playing-mobile.png` / `after-minesweeper-lost-mobile.png` / `after-minesweeper-won-mobile.png`：`993f5e7`（#61）捕获。当前构建重跑桌面整页为 1440×1529（won 为 1440×1598），已提交 PNG 仍是表格里的整页 1440×1324；手机图尺寸同为 1082×2202，但约 50.7–56.1 万像素不同。原因是 #85 最高用时榜、#87「清空记录」等侧栏 UI 变更后未重拍。
- 上述历史图都只代表各自捕获时点的 UI，不能作为当前构建「重跑必须逐字节一致」的基准。
- 脚本保护（t4，Issue #199 收紧）：`scripts/lib/screenshot-evidence.mjs` 维护上述历史 After 清单（含 issue、游戏、最后捕获 commit 与说明）。`capture-2048-screenshots.mjs`、`capture-breakout-screenshots.mjs`、`capture-snake-screenshots.mjs`、`capture-minesweeper-screenshots.mjs` 在 After 捕获写文件前调用同一守卫：命中清单且未加 `--allow-historical-overwrite` 时默认跳过该文件，并打印包含 `historical After evidence`、`#137`、文件名、容器入口与开关提示的警告；宿主普通捕获（不带开关）不受影响，仍照常写当前证据。带了开关也不再单凭 flag 放行：只在 `npm run screenshots:container` 内、且捕获进程的 `captureEnvironmentFingerprint()` 报告 `source=container`、镜像 tag / digest 与固定契约一致、三个 EGL 变量齐全时才允许覆盖，否则在写该文件前抛出包含文件名与容器入口的可读错误。放行时会打印必须同步更新的 checklist：文件名、`docs/screenshots/README.md` 中该文件的捕获 commit，以及 `docs/screenshots/capture-sha256-manifest.json` 中该文件的条目（若该图已收录）。未列入清单的当前证据（2048 playing / gameover、打砖块 playing、扫雷专用窄屏 / 短屏 / 大棋盘模式、`after-minesweeper-webkit-narrow-*` CI 冒烟等）不受影响，仍会正常刷新；`capture-minesweeper-scores-screenshots.mjs` 的 #45 拒绝逻辑保持原样。确认重建历史图时只能在固定容器内执行 `npm run screenshots:container -- <target> --allow-historical-overwrite`，并在同一改动中同步本节与对应小节的捕获 commit / 尺寸，以及 sha256 清单条目（若收录）。
- 不在此列：`after-2048-playing-desktop.png` / `after-2048-gameover-desktop.png` 已在 `8dbe3e7`（#145）按固定 seed 重拍，打砖块的 `after-breakout-playing-desktop.png` / `after-breakout-playing-mobile.png` 与贪食蛇的 `after-snake-playing.png` 也已在后续任务按当前构建重拍；这些图与当前构建一致，不受本口径影响。
- 各图的历史证据说明仍以对应小节为准：2048 见「t4：2048（PR #26）」的「生成」与「证据限制」，打砖块见「t5：打砖块（Issue #27 / 子任务 1）」的「生成」与「证据限制」，贪食蛇见「t3：贪食蛇（PR #14）」的「生成」与「证据限制」，扫雷桌面见「t6：扫雷（Issue #33 / 子任务 1）」、手机见「t7：扫雷触屏与手机布局（Issue #33 / 子任务 2）」。
- WebKit 部分另有独立口径：打砖块 / 扫雷 / 窄屏 / 2048 的漂移产物、EGL 与官方 Playwright 容器环境事实、`webkit-narrow` 以 CI 清单而非 sha256 校验，统一记录在「webkit-phone」的「WebKit 历史证据（Issue #137 / #120）」；哈希级复现见 #199。

## CI：截图文档整页尺寸校验（Issue #134）

- 覆盖范围：`docs/screenshots/README.md` 表格里带 `整页 W×H` 的单元格与 `docs/screenshots/<file>.png` 的 PNG 签名 / IHDR 宽高逐项比对；只读 README 与已提交 PNG，不执行截图脚本、不写文件，也不需要浏览器或生产构建。
- CI 位置：`.github/workflows/ci.yml` 的 `verify` job，在 `Unit tests`（`npm run test:unit`）之后、`Production build`（`npm run build`）之前新增名为 `Screenshot doc dimensions` 的步骤；`verify` 的 `timeout-minutes` 保持 20。放在构建前，尺寸漂移会尽早失败。
- 步骤命令：`npm run verify:screenshots:doc-dims`（即 `node scripts/check-screenshot-doc-dims.mjs`）。
- 复现命令：`npm run verify:screenshots:doc-dims`。通过时输出 `OK: 检查了 14 个文件 / 14 行 README，整页尺寸全部一致。` 并以 0 退出；该计数与 `tests/unit/screenshot-doc-dims.test.ts` 的 CLI 契约断言一致。
- 失败表现：把 `after-minesweeper-scores-desktop.png` 行的 `整页 1440×1606` 改成 `1440×1607` 后，本地实测输出：

```text
FAIL: 发现 1 处整页尺寸问题（检查了 14 个文件 / 14 行 README）：
  README 217: after-minesweeper-scores-desktop.png: 整页 1440×1607 != PNG 1440×1606（尺寸不一致）
```

  命令以 1 退出；恢复文档后重新通过。PNG 缺失、PNG 签名错误或 IHDR 截断时同样逐条给出 README 行号、文件名、文档值与实际 PNG 状态。
- 实测耗时：2026-11-11 在 `agent/plan-134-t1` 的本地 worktree 实测，`npm run verify:screenshots:doc-dims` 约 0.08–0.09 s（`node scripts/check-screenshot-doc-dims.mjs` 本身约 0.02 s，其余为 npm 启动开销），属于毫秒级；相对 `verify` job 的分钟级耗时（见下节 WebKit 冒烟步骤的参考 run）可忽略。CI runner 的绝对耗时不同，以实际 run 为准。
- 防回归：`tests/unit/ci-workflow.test.ts` 断言 `Screenshot doc dimensions` 步骤存在、其 `run` 恰为 `npm run verify:screenshots:doc-dims`、位于 `npm run test:unit` 之后且在 `npm run build` 之前，并继续钉住 `verify` 的 `timeout-minutes: 20`；脚本行为（改错任一维度、PNG 缺失 / 签名错误 / IHDR 截断、CLI 退出码）由 `tests/unit/screenshot-doc-dims.test.ts` 覆盖。

## CI：WebKit 窄屏截图冒烟（Issue #121）

- 覆盖场景：扫雷 9×9 READY 首屏在 WebKit `iPhone SE (3rd gen)` 设备模拟下的 320×640、360×640、375×667、412×839 四个窄屏视口；使用与 e2e 同源的固定雷盘和 READY 状态，深色主题、`reducedMotion: reduce`、视口截图（`fullPage: false`）。对应产物是 `after-minesweeper-webkit-narrow-<W>x<H>.png`。
- CI 位置：`.github/workflows/ci.yml` 的 `verify` job，在 `npm run test:e2e` 之后新增名为 `WebKit narrow screenshot smoke test` 的步骤；`verify` 的 `timeout-minutes` 保持 20。
- 步骤内容：先用 `rm -f docs/screenshots/after-minesweeper-webkit-narrow-*.png` 删除本次要重新生成的四个文件，再执行 `npm run screenshots:minesweeper:webkit-narrow`（内部先 `npm run build` 并启动 `vite preview`，默认端口 4186，可用 `PREVIEW_PORT` 覆盖），把脚本的 `engine=webkit` 记录 tee 到 `$RUNNER_TEMP/minesweeper-webkit-narrow.log`，最后用 `scripts/verify-screenshot-artifacts.mjs` 按 `docs/screenshots/ci-webkit-narrow-manifest.json` 校验四个 PNG 的签名 / IHDR 宽高（DPR 2：640×1280、720×1280、750×1334、824×1678）、`-webkit-narrow-<W>x<H>.png` 命名，以及日志中逐文件的 `engine=webkit` / 视口记录。步骤开头的 `set -euo pipefail` 保证管道和任一命令失败都会让 `verify` job 变红。
- 复现命令（本地等价于 CI 步骤）：

```bash
set -euo pipefail
rm -f docs/screenshots/after-minesweeper-webkit-narrow-*.png
npm run screenshots:minesweeper:webkit-narrow 2>&1 | tee /tmp/minesweeper-webkit-narrow.log
node scripts/verify-screenshot-artifacts.mjs --manifest docs/screenshots/ci-webkit-narrow-manifest.json --log /tmp/minesweeper-webkit-narrow.log
```

  端口 4186 被占用时在捕获命令前加 `PREVIEW_PORT=4187`；脚本会在启动前报错并提示，不会静默连到别的服务。
- 实测耗时：2026-11-11 在 `agent/plan-121-t2` 的本地 worktree 实测，`npm run screenshots:minesweeper:webkit-narrow`（含生产构建、WebKit 启动与四个视口）约 10.0 s，校验器约 0.02 s。作为参考，新增步骤前的 `main`（`20f1fe7`）CI run `42894213139` 的 `verify` job 实际耗时 316 s（其中 e2e 244 s）；新增检查约 10 s 量级，20 分钟 timeout 仍有充足余量。CI runner 的绝对耗时不同，以实际 run 为准。
- 失败表现：捕获命令失败（构建 / WebKit 启动 / 页面定位器）时，`set -euo pipefail` 让步骤在捕获命令处失败；若脚本成功退出但没有写出产物（例如移除了 `--webkit-narrow` 分派），校验器会报告四个 `missing file` 与四条 `missing capture log record` 并返回 1；PNG 截断 / 非 PNG、宽高不符、文件名缺少窄屏视口、日志记录 engine 不是 `webkit` 或视口不符时，分别输出对应文件与期望 / 实际值，步骤同样变红。负向验证：临时移除 `scripts/capture-minesweeper-screenshots.mjs` 的 `captureWebkitNarrow` 分派后，该步骤在本地以 8 条问题失败（4 个缺失文件 + 4 条缺失日志），恢复后通过。

## webkit-narrow：扫雷窄屏首屏契约的 WebKit 矩阵（Issue #83 / 子任务 1）

- Before 基线：`d6aeb3d`（t1 合入后的 `main`，也就是本子任务开始前的 `main`）。
- After：`agent/plan-100-t3` 的本次 head（由仓库内脚本重新生成，已包含 Issue #60 的短窄视口修复）。`tests/e2e/minesweeper-helpers.ts` 抽出 Chromium 与 WebKit 共用的首屏契约（无横向溢出、81 格 ≥ 最小格且近似正方形、HUD 两个读数 / 返回大厅 / 触屏提示在首屏，重开入口按视口可选），新增 `tests/e2e/minesweeper.narrow.webkit.spec.ts` 覆盖 320×640、360×640、375×667、412×839。
- 视觉差异与修复：WebKit 把带 padding 的 `.minesweeper-stage` 的 `aspect-ratio` 解析到内容盒，导致 stage 比宽度高出一个 padding + border 的高度，9×9 格子变成纵向长方形（412×839 下 39.33×41.33）。`src/games/minesweeper/view.ts` 给 `rows === cols` 的棋盘加 `data-square-board="true"`，`minesweeper.css` 在 ≤560px 时让 stage 由去内边距的 board 提供行 / 列比例；Chromium 的 9×9 布局与既有大棋盘（16×16 / 16×30）几何断言不变。
- 视口 / 主题：320×640、360×640、375×667、412×839 CSS px；Playwright WebKit `iPhone SE (3rd gen)` 设备模拟（DPR 2、`isMobile: true`、`hasTouch: true`），深色主题、`reducedMotion: reduce`。Before / After 使用同一 9×9 READY 场景（READY 下雷盘不可见），均为视口截图（`fullPage: false`）。
- 复现（已入库，不再依赖临时脚本）：
  - After：`npm run screenshots:minesweeper:webkit-narrow`（生产构建 + `vite preview`，端口 `4186`，可用 `PREVIEW_PORT` 覆盖）。
  - Before：在 `d6aeb3d` 的干净 worktree 中 `npm ci && npm run build`，启动 `vite preview --host 127.0.0.1 --port 4174 --strictPort`，然后在当前分支运行 `BASE_URL=http://127.0.0.1:4174 npm run screenshots:minesweeper:webkit-narrow-before`。
  - 两个命令都使用 `iPhone SE (3rd gen)` WebKit 设备模拟，循环 320×640、360×640、375×667、412×839 四个视口，输出到 `docs/screenshots/`；脚本会为每张图打印 `engine=webkit, viewport=<W>x<H>, theme=dark, reducedMotion=reduce` 记录。
  - 长按 / 触控注入复用 `scripts/lib/touch-input.mjs`：e2e 的 `tests/e2e/touch-input.ts` 也使用同一实现（re-export 常量、类型与 `dispatchTouchPointerEvent`，并调用 `releaseTouchClick`），不再依赖 Chromium CDP；Chromium 的既有 `screenshots:minesweeper:*` 命令与文件名保持不变。

| 文件 | 场景 | 视口 / 主题 | stage（Before → After） | 单格（Before → After） | 重开入口底部（After） |
| --- | --- | --- | --- | --- | --- |
| `before-minesweeper-webkit-narrow-320x640.png` / `after-minesweeper-webkit-narrow-320x640.png` | 9×9 READY（基线 `d6aeb3d` / 本子任务） | 320×640 / 深色 | 320×324 → 320×320 | 34.219×34.656 → 34.219×34.219 | 612.47 px |
| `before-minesweeper-webkit-narrow-360x640.png` / `after-minesweeper-webkit-narrow-360x640.png` | 9×9 READY（基线 `d6aeb3d` / 本子任务） | 360×640 / 深色 | 360×364 → 360×360 | 38.656×39.109 → 38.656×38.656 | 636.47 px |
| `before-minesweeper-webkit-narrow-375x667.png` / `after-minesweeper-webkit-narrow-375x667.png` | 9×9 READY（基线 `d6aeb3d` / 本子任务） | 375×667 / 深色 | 375×379 → 375×375 | 40.328×40.766 → 40.328×40.328 | 651.47 px |
| `before-minesweeper-webkit-narrow-412x839.png` / `after-minesweeper-webkit-narrow-412x839.png` | 9×9 READY（基线 `d6aeb3d` / 本子任务） | 412×839 / 深色 | 388×406 → 388×388 | 39.328×41.328 → 39.328×39.328 | 732.06 px |

### 证据限制

- 手机端为 Playwright WebKit 的 Linux WPE 设备模拟（iPhone SE (3rd gen) 视口 / DPR / 触摸参数），不是真实 iOS Safari 截图；Playwright 不模拟 iOS 动态地址栏与 `env(safe-area-inset-*)`，真机手感仍需人工验收。
- After 已用本次 head 重新生成，因此包含 Issue #60 的短窄视口修复：360×640 / 375×667 的 `mobile-restart-button` 现在完整落在首屏内。Before 仍是 `d6aeb3d` 的历史基线；当前行为另由 `tests/e2e/minesweeper.narrow.webkit.spec.ts` 在 320×640、360×640、375×667、412×839 四个 WebKit 视口上的 e2e 断言证明。
- 截图只证明 9×9 READY 的静态视觉；契约的显隐、无横向溢出、格子尺寸与重开入口边界由 `tests/e2e/minesweeper.narrow.webkit.spec.ts` 在生产构建上验证，Chromium 无回归由 `npm run test:e2e` 验证。
- 这 4 张窄屏图的权威校验是 CI 的清单校验（`docs/screenshots/ci-webkit-narrow-manifest.json` 对尺寸 / 引擎 / 命名的断言，见上文「CI：WebKit 窄屏截图冒烟」）；本地复跑同一步骤用 `node scripts/verify-screenshot-artifacts.mjs --manifest docs/screenshots/ci-webkit-narrow-manifest.json --log <log>`，而 `npm run verify:screenshots:webkit` 按内置 23 个 WebKit 产物清单校验签名 / 尺寸 / 命名，不校验日志中的 `engine=webkit` / 视口。它不是与已提交 PNG 的 sha256 比对；WebKit 重跑的跨环境差异见「webkit-phone」的「WebKit 历史证据（Issue #137 / #120）」。

## webkit-phone：t1–t3 稳定场景的 WebKit 手机端截图（Issue #100 / t4）

- 来源：本子任务分支 `agent/plan-100-t3` 的当前 head。Chromium 的既有同名状态文件保持不变；下表全部是新增的 `*-webkit*.png`，由仓库内脚本生成。
- 引擎 / 设备：Playwright WebKit（Linux WPE）`iPhone SE (3rd gen)` 设备模拟（DPR 2、`isMobile: true`、`hasTouch: true`）；除成绩榜使用 320×640 外，其余为 375×667 CSS px。深色主题、`reducedMotion: reduce`；除成绩榜为全页截图（`fullPage: true`，宽度 320 CSS px）外，其余为视口截图（`fullPage: false`）。
- 复现命令：
  - `npm run screenshots:webkit` → 大厅 / 空白画布
  - `npm run screenshots:snake:webkit` → 贪食蛇手机 ready（开发服务器 + 固定首果）
  - `npm run screenshots:2048:webkit` → 2048 ready / playing / gameover
  - `npm run screenshots:breakout:webkit` → 打砖块 ready / playing / levelclear / gameover
  - `npm run screenshots:minesweeper:webkit` → 扫雷 ready / playing / lost / won
  - `npm run screenshots:minesweeper:webkit-before` → 同一组 WebKit 手机 Before 状态（需 `BASE_URL` 指向触屏改动前的基线预览；仓库不提交这些 Before 文件）
  - `npm run screenshots:minesweeper:scores:webkit` → 最高用时榜（当前面板包含「清空记录」）
  - WebKit 历史图默认保护：`npm run screenshots:2048:webkit`、`npm run screenshots:breakout:webkit` 与 `npm run screenshots:minesweeper:webkit` 命中「WebKit 历史证据（Issue #137 / #120）」列出的文件时默认跳过并打印守卫警告；确需重建时只能在固定容器内加 `--allow-historical-overwrite`，例如 `npm run screenshots:container -- screenshots:2048:webkit --allow-historical-overwrite`、`npm run screenshots:container -- screenshots:breakout:webkit --allow-historical-overwrite` 或 `npm run screenshots:container -- screenshots:minesweeper:webkit --allow-historical-overwrite`，并在同一改动中同步捕获 commit 与 `capture-sha256-manifest.json` 条目（若收录）。未注入容器指纹时宿主直接带该开关会被拒绝。`npm run screenshots:minesweeper:webkit-narrow` 走独立的 `webkit-narrow` 模式，不在保护集合内，CI 冒烟仍可先 `rm` 再重新生成。
  - 窄屏 4 视口见上文 `webkit-narrow` 小节。
- 预览端口：通用大厅 / 空白画布脚本（`npm run screenshots` 与 `npm run screenshots:webkit`）默认 `4174`；共享主机或并行 worktree 用 `PREVIEW_PORT=4175 npm run screenshots` 覆盖（`PREVIEW_PORT` 为空串时回退 `4174`；WebKit 模式复用同一启动路径与端口）。端口已被占用时脚本在启动 preview 前以非零状态退出，错误包含实际端口、`the port is already in use` 与 `Set PREVIEW_PORT` 建议，不会写出或覆盖任何截图；端口探测通过后 preview 提前退出时报告子进程退出码与 stderr，不再静默连到端口上的其它服务。显式设置 `BASE_URL` 时（外部 preview 模式）不启动 preview、不探测端口，行为与文件名保持不变。
- 引擎 / 视口 / 主题记录：每个脚本在写图后会输出一行 `engine=…, viewport=…, theme=dark, reducedMotion=reduce`；下表也逐项记录。WebKit 模式不写既有 Chromium 文件名，Chromium 模式也不会写这些 `-webkit` 文件。
- 覆盖边界：俄罗斯方块只有 e2e 覆盖，没有 `capture-*` 截图脚本；因此本表不包含俄罗斯方块截图。WebKit 是 Linux 构建，不等同真实 iOS Safari，动态地址栏 / 安全区 / 真机字体仍由上文差异小节与 e2e 覆盖。

| 文件 | 场景 | 引擎 / 视口 / 主题 | 生成命令 |
| --- | --- | --- | --- |
| `after-hub-webkit.png` | 大厅 | WebKit / 375×667 / 深色 | `npm run screenshots:webkit` |
| `after-blank-webkit.png` | 空白画布（触屏移动并停稳后） | WebKit / 375×667 / 深色 | `npm run screenshots:webkit` |
| `after-snake-webkit.png` | 贪食蛇 READY（手机） | WebKit / 375×667 / 深色 | `npm run screenshots:snake:webkit` |
| `after-2048-ready-webkit.png` | 2048 READY（手机） | WebKit / 375×667 / 深色 | `npm run screenshots:2048:webkit` |
| `after-2048-playing-webkit.png` | 2048 合并计分中（手机） | WebKit / 375×667 / 深色 | `npm run screenshots:2048:webkit` |
| `after-2048-gameover-webkit.png` | 2048 无路可走（手机） | WebKit / 375×667 / 深色 | `npm run screenshots:2048:webkit` |
| `after-breakout-ready-webkit.png` | 打砖块 READY（手机） | WebKit / 375×667 / 深色 | `npm run screenshots:breakout:webkit` |
| `after-breakout-playing-webkit.png` | 打砖块游玩中（手机） | WebKit / 375×667 / 深色 | `npm run screenshots:breakout:webkit` |
| `after-breakout-levelclear-webkit.png` | 打砖块过关（手机） | WebKit / 375×667 / 深色 | `npm run screenshots:breakout:webkit` |
| `after-breakout-gameover-webkit.png` | 打砖块生命用完（手机） | WebKit / 375×667 / 深色 | `npm run screenshots:breakout:webkit` |
| `after-minesweeper-ready-webkit.png` | 扫雷 READY（手机） | WebKit / 375×667 / 深色 | `npm run screenshots:minesweeper:webkit` |
| `after-minesweeper-playing-webkit.png` | 扫雷游玩中（触屏轻点 + 长按插旗） | WebKit / 375×667 / 深色 | `npm run screenshots:minesweeper:webkit` |
| `after-minesweeper-lost-webkit.png` | 扫雷 BOOM（触屏） | WebKit / 375×667 / 深色 | `npm run screenshots:minesweeper:webkit` |
| `after-minesweeper-won-webkit.png` | 扫雷 CLEARED（触屏） | WebKit / 375×667 / 深色 | `npm run screenshots:minesweeper:webkit` |
| `after-minesweeper-scores-webkit.png` | 最高用时榜（含「清空记录」，手机） | WebKit / 320×640 / 深色 | `npm run screenshots:minesweeper:scores:webkit` |

### WebKit 历史证据（Issue #137 / #120）

- 来源：本表在 [`498a14f`](https://github.com/yeahdongcn-mk2/playground/commit/498a14fb2c7faf426ae79381f433b64f2a18586e)（#120「为截图脚本补 WebKit 模式并收口浏览器覆盖文档与 CI 时长」）首次入库；`webkit-narrow` 的 After 证据更早由 [`9c39e68`](https://github.com/yeahdongcn-mk2/playground/commit/9c39e68dbe38e2ca79b3bf869a8fb6f8b15738e5)（#102「为扫雷窄屏契约补 WebKit 视口矩阵并处理跨引擎差异」）引入，并在 `498a14f` 重新捕获（例如 `after-minesweeper-webkit-narrow-320x640.png` 从 179378 更新为 182309 字节，其余三张也同步更新）。其中 `after-2048-playing-webkit.png` / `after-2048-gameover-webkit.png` 与 `after-breakout-playing-webkit.png` 后来按确定性接缝重拍。其余历史图只代表当时的 UI 与捕获环境快照。本节只记录既有复核结果，不重拍、不改动任何已提交 PNG。
- 已报告的漂移产物（最后捕获于 `498a14f` / #120；同一命令重跑后 sha256 与已提交产物不同）：
  - 打砖块：`after-breakout-ready-webkit.png`、`after-breakout-levelclear-webkit.png`、`after-breakout-gameover-webkit.png`。以下数字来自 #159 复审 head [`044a02a`](https://github.com/yeahdongcn-mk2/playground/commit/044a02a58359367e03962e76ce62984e971f969b) 在官方容器内的复核，只是该 head 的单次测量值，会随测量 head / 环境变化：ready 的差异覆盖约 24.6 万像素（bbox rows 72..1333、cols 70..679，整幅 750×1334，不是页脚）；levelclear 也有差异；gameover 仅 11 像素。
  - 扫雷：`after-minesweeper-ready-webkit.png`、`after-minesweeper-playing-webkit.png`、`after-minesweeper-lost-webkit.png`、`after-minesweeper-won-webkit.png`。本机 WebKit 重跑像素差 ready 3.27% / playing 3.27% / lost 4.57% / won 4.13%（每通道最大 217–218），集中在 HUD / 文字行，不是页脚。
  - 扫雷窄屏：`after-minesweeper-webkit-narrow-320x640.png`、`after-minesweeper-webkit-narrow-360x640.png`、`after-minesweeper-webkit-narrow-375x667.png`、`after-minesweeper-webkit-narrow-412x839.png`。尺寸与已提交一致，sha256 全部不同。
  - 2048：`after-2048-ready-webkit.png`（同一捕获提交 `498a14f`）。在官方 Playwright 容器内按 `npm run screenshots:2048:webkit` 连续两跑，两次 sha256 不同（`672285de…` 与 `0ea38c8d…`）；相对已提交 `4f488a3e…`，尺寸同为 750×1334，两跑分别差 2198 / 1000500 像素（0.22%，每通道最大 11）与 368 / 1000500 像素（0.037%，每通道最大 11），两跑之间差 1833 像素（每通道最大 1），故一并归入本组漂移证据，且不能把单次采样的 0.22% 当作稳定结论。
- 不在这组漂移里：`after-breakout-playing-webkit.png` / `after-2048-playing-webkit.png` / `after-2048-gameover-webkit.png` 走固定 seed / 步进的确定性接缝，在官方 Playwright 容器内重跑与已提交产物逐字节一致（2048 playing `4173dce8…`、gameover `bf7548b7…`）。`after-blank-webkit.png` 的确定性另见「空白画布截图确定性」。本轮未复核 `after-hub-webkit.png` / `after-snake-webkit.png` / `after-minesweeper-scores-webkit.png`，不能据此推断它们稳定。
- 环境事实：本机 WebKit 需设置 `__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json EGL_PLATFORM=surfaceless LIBGL_ALWAYS_SOFTWARE=1` 才能启动，否则会因 EGL / surfaceless display 初始化失败。官方 Playwright 容器 `mcr.microsoft.com/playwright:v1.64.1-noble` 内重跑扫雷 4 张，尺寸仍为 750×1334，sha256 仍与已提交不同，但像素差压到 ready 0.0113%（113 px）/ playing 0.06%（574 px）/ lost 0.02%（210 px）/ won 0.02%（236 px），每通道最大 10 / 14 / 12 / 12；ready 还会出现 1.1264%（11270 px）的另一种渲染结果（每通道最大同为 10），两种结果互差 11157 px（每通道最大 1）；同一容器内首跑取到 1.1264% 这一版、随后重跑取到 0.0113% 这一版，新起容器首跑又取回 1.1264% 这一版，所以 0.0113% 只是其中一种采样，不能当作唯一稳定值；容器只能缩小差异，不能保证等于已提交 PNG。同一捕获环境连续两跑也只在部分状态逐字节一致：playing / lost / won 在容器内两跑 sha256 相同，ready 的相邻两跑则可能不同，而 2048 ready 在同一容器两跑不同（见上）；跨机器 / 引擎 / 字体 / EGL 环境则可能不同。
- 权威口径：这组 WebKit 图不作为「重跑必须等于已提交 PNG」的验收基准；逐字节比较只在同一构建、同一捕获环境下的确定性产物之间成立。需要哈希级复现时，先固定捕获环境（容器镜像、字体包、EGL / 软件渲染参数、DPR），见后续单 [#199](https://github.com/yeahdongcn-mk2/playground/issues/199)。
- `webkit-narrow` 的权威校验不是 sha256，而是 CI 的清单校验：`WebKit narrow screenshot smoke test` 用 `docs/screenshots/ci-webkit-narrow-manifest.json` 校验 4 张 `after-minesweeper-webkit-narrow-*.png` 的 PNG 签名 / IHDR 尺寸（DPR 2）、`-webkit-narrow-<W>x<H>.png` 命名，以及捕获日志中逐文件的 `engine=webkit` / 视口记录。CI 的窄屏步骤包含重拍与校验两半（见上文「复现命令（本地等价于 CI 步骤）」）；其中校验半段等价的本地命令是 `node scripts/verify-screenshot-artifacts.mjs --manifest docs/screenshots/ci-webkit-narrow-manifest.json --log <log>`，`<log>` 用本地重拍时 tee 出的捕获日志。`npm run verify:screenshots:webkit` 则是另一条命令：它用内置的 23 个 WebKit 产物清单校验 PNG 签名 / IHDR 尺寸与命名（该清单已包含这 4 张窄屏图，但不是 `ci-webkit-narrow-manifest.json` 的 4 文件清单），不带 `--log` 时不校验日志中的 `engine=webkit` / 视口。

### 证据限制

- 这是当前 head 的静态视觉证据，不是 UI 改动的 Before / After 对比；本轮没有改变页面渲染，目的是让 t1–t3 已稳定的手机端场景在 WebKit 引擎下可复现地留下截图。
- 截图脚本的 WebKit 模式与 e2e 的 `mobile-webkit` project 使用同一设备参数；长按 / 触摸注入使用 `scripts/lib/touch-input.mjs`，e2e 的 `tests/e2e/touch-input.ts` 也使用同一实现（含 `releaseTouchClick`），因此两侧行为语义一致。

## short：扫雷 360×640 / 375×667 短窄视口首屏重开入口（Issue #60 / t1）

- Before 基线：`249bda2`（本子任务开始前的 `main`；与旧 PR #84 的基线 `a60062e` 相比扫雷布局未变，本轮按任务要求重新生成，不复用旧图）。360×640 READY 下 9×9 格子约 38.66×38.66 px、页面无横向溢出，HUD、返回大厅和 touch-hint 在首屏内；但 `mobile-restart-button` 底部约 652.52 px，超出 640 px 视口约 12.52 px。375×667 下格子约 40.33×40.33 px，重开按钮底部约 667.52 px，超出 667 px 视口约 0.52 px。
- After：本子任务分支 `agent/plan-60-t0`，实现提交 `6f84598`。`minesweeper.css` 在既有 `(max-width: 400px) and (max-height: 700px)` 查询之后新增 `(min-width: 340px) and (max-width: 400px) and (max-height: 667px)`，再压缩 `.game-heading` 的 `row-gap` / `padding` 与 touch hint / touch actions 的纵向 `margin`（共 16 px）。舞台宽度、棋盘格子尺寸、横向规则与游戏规则均未改：360×640 下重开按钮底部约 636.52 px，375×667 下约 651.52 px，均完整落在首屏内。320×640 的布局与 34 px 格子下限不变；高度 700 px 及以上的 340×700 / 349×700 / 400×700 / 360×740 / 412×839 不受新增收紧影响。
- 覆盖范围：新增查询在 CSS 上对 340–400px 宽且高度 ≤667px 生效（边界用例 340×667，目标视口 360×640 / 375×667），不止两个验收目标。首屏契约对 `tests/e2e/minesweeper.mobile.spec.ts` 的 8 个视口（320×640、340×700、349×700、360×640、360×740、375×667、400×700、412×839）全部断言重开入口；另有计算样式断言钉住整段边界：340×667 / 400×667 收紧，340×668 / 340×700 / 320×640 不收紧，401×667 回落到基础间距。未列入首屏契约的更矮组合（例如 375×640、400×667）虽命中查询，重开入口仍可能低于首屏。
- 视口 / 主题：360×640 与 375×667 CSS px，DPR 2，`isMobile: true`、`hasTouch: true`，深色主题，`reducedMotion: reduce`；同一固定雷盘（WIN_MINES）与 READY 状态，均为视口截图（`fullPage: false`）。
- 生成 After：`npm run screenshots:minesweeper:short`（生产构建 + `vite preview`）。
- 复现 Before：在 `249bda2` 的干净 worktree 里 `npm ci && npm run build`，用 `node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4192 --strictPort` 启动预览，然后在当前分支运行 `BASE_URL=http://127.0.0.1:4192 npm run screenshots:minesweeper:short-before`。

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `before-minesweeper-ready-360x640.png` | 扫雷 READY（基线 `249bda2`） | 360×640 / 深色 | 修复前：格子约 38.66 px，重开按钮底部约 652.52 px，底部被首屏截断约 12.52 px。 |
| `after-minesweeper-ready-360x640.png` | 扫雷 READY（本子任务） | 360×640 / 深色 | 修复后：格子尺寸不变，重开按钮底部约 636.52 px，完整在首屏内。 |
| `before-minesweeper-ready-375x667.png` | 扫雷 READY（基线 `249bda2`） | 375×667 / 深色 | 修复前：格子约 40.33 px，重开按钮底部约 667.52 px，边缘截断。 |
| `after-minesweeper-ready-375x667.png` | 扫雷 READY（本子任务） | 375×667 / 深色 | 修复后：格子尺寸不变，重开按钮底部约 651.52 px，完整在首屏内。 |

### 证据限制

- 手机端为 Playwright Chromium 设备模拟（360×640 / 375×667、DPR 2、触摸），不是真实设备截图。
- 截图只证明静态视觉；`tests/e2e/minesweeper.mobile.spec.ts` 的 `FIRST_SCREEN_VIEWPORTS` 契约用例在 8 个视口下断言无横向溢出、81 个格子达到对应最小尺寸且近方形、返回大厅 / HUD / touch-hint 在首屏，并对 `mobile-restart-button` 断言 `x >= 0`、`y >= 0`、`x + width <= 视口宽`、`y + height <= 视口高`。`tests/e2e/minesweeper.narrow.webkit.spec.ts` 在 WebKit 的 320×640、360×640、375×667、412×839 下同样断言重开入口。

## large-board：扫雷窄屏大棋盘降级提示（Issue #60）

- Before 基线：`289d76d`（本子任务开始前的 `main`）。16×30 棋盘按现有方式自适应铺满、页面无横向溢出、右下角格子可点按，但窄屏没有任何大棋盘降级提示。
- After：本子任务分支 `agent/plan-60-t1`。`src/games/minesweeper/view.ts` 在列数 > 9 时给 `.minesweeper-game` 设置 `data-large-board="true"`，并在棋盘下加入 `role="status"` 的中文提示 `data-testid="board-size-warning"`；`src/games/minesweeper/minesweeper.css` 只在 `max-width: 560px` 且 `data-large-board="true"` 时显示。9×9 与宽屏布局不变，提示不改变棋盘尺寸，也不引入横向滚动。
- 视口 / 主题：320×640 与 360×640 CSS px，DPR 2、`isMobile: true`、`hasTouch: true`、深色主题、`reducedMotion: reduce`；同一 URL（`#/games/minesweeper?debug=1&rows=16&cols=30&mineCount=99&safeFirst=1`）、同一 16×30 READY 棋盘，均为视口截图（`fullPage: false`）。
- 生成 After：`npm run screenshots:minesweeper:large`（生产构建 + `vite preview`）。
- 复现 Before：在 `289d76d` 的干净 worktree 里 `npm ci && npm run build`，用 `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4193 --strictPort` 启动预览，然后在当前分支运行 `BASE_URL=http://127.0.0.1:4193 npm run screenshots:minesweeper:large-before`（Before 模式不启动 preview，端口以 `BASE_URL` 为准）。

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `before-minesweeper-large-board-320x640.png` | 16×30 READY（基线 `289d76d`） | 320×640 / 深色 | 大棋盘按比例铺满，棋盘下方没有降级提示。 |
| `after-minesweeper-large-board-320x640.png` | 16×30 READY（本子任务） | 320×640 / 深色 | 棋盘位置与格子尺寸不变，新增中文提示：≥36px 只对 9×9 保证，建议横屏或改用更小的棋盘。 |
| `before-minesweeper-large-board-360x640.png` | 16×30 READY（基线 `289d76d`） | 360×640 / 深色 | 同 320×640 场景，无降级提示。 |
| `after-minesweeper-large-board-360x640.png` | 16×30 READY（本子任务） | 360×640 / 深色 | 同 320×640 场景，提示可见且页面无横向溢出。 |

### 证据限制

- 手机端为 Playwright 设备模拟（320×640 / 360×640、DPR 2、触摸），不是真实设备截图。
- 截图只证明静态视觉；提示显隐、棋盘格数、无横向溢出、右下角格子 tap 后进入「进行中」、切回 9×9 隐藏由 `tests/e2e/minesweeper.difficulty.mobile.spec.ts` 在生产构建上验证；宽屏隐藏由 `tests/e2e/minesweeper.difficulty.spec.ts` 验证。
- Before / After 的棋盘外框、stage 与首尾格子包围盒逐项一致（320×640 下 board 316×166.66、360×640 下 356×188）；棋盘截图仅 ≤0.5% 像素因抗锯齿有 ≤2 的差异，证明提示没有改变棋盘尺寸。
- 额外本地核对：320×640 / 360×640 / 412×839 的 9×9 READY 整屏截图在 Before / After 间逐字节一致（相同设备参数与主题），说明提示隐藏时首屏布局未变。

## scores：扫雷本地最高用时榜（Issue #45 / 子任务 1）

- Before 基线：`a60062e`（存储模块 #82 合入后的 `main`，也就是本子任务开始前的 `main`）。侧栏只有操作、本局与难度卡片，还没有最高用时卡片；`localStorage` 里预置的成绩键会被忽略。
- After：本子任务分支 `agent/plan-45-t1` 的提交 [`338d06c`](https://github.com/yeahdongcn-mk2/playground/commit/338d06c)（含审查修正与最终截图）。侧栏在难度卡片之后新增「最高用时」卡片：三档预设按初级 / 中级 / 高级固定顺序展示，没有记录的档位显示 `—`；自定义棋盘按配置单列并显示长标签；整张榜为空时显示「还没有记录」。截图场景先向本机存储预置一条 30×30 / 100 雷（首点不安全）的自定义记录，再以固定初级雷盘从 (8, 8) 一次获胜，因此 After 面板同时显示新写入的初级成绩、未记录预设的占位与一条自定义成绩。
- 视口 / 主题：桌面 1440×1000 CSS px、DPR 1；手机 320×640 CSS px、DPR 2、`isMobile: true`、`hasTouch: true`；两者均为深色主题、`reducedMotion: reduce`，Before / After 使用同一 URL、同一固定雷盘、同一 WON 状态，均为整页截图（`fullPage: true`）。
- 生成 After（历史证据，默认冻结）：这两张 After 图由 #45 子任务 1 的 `npm run screenshots:minesweeper:scores` 在提交 [`338d06c`](https://github.com/yeahdongcn-mk2/playground/commit/338d06c) 生成，保留的是当时还没有「清空记录」的界面，不代表当前 UI。当前 UI 已包含「清空记录」，再次执行该命令会静默把历史证据替换成当前界面；脚本现在默认拒绝覆盖：在启动 preview、浏览器或写文件之前以非零状态退出，提示这是 #45 历史证据并给出 `--allow-historical-overwrite`。该脚本的 #45 拒绝逻辑保持独立；确需重建时建议在固定容器内显式加该参数（`npm run screenshots:container -- screenshots:minesweeper:scores --allow-historical-overwrite`），并在重建后同步本节表格的整页尺寸、描述与 sha256 清单条目（若收录）；当前 UI 的 After 证据见下一节 `scores-clear`。
- 预览端口：默认 `4192`，共享主机或并行 worktree 用 `PREVIEW_PORT=4193 npm run screenshots:minesweeper:scores` 覆盖（`PREVIEW_PORT` 为空串时回退 `4192`）。端口已被占用时脚本会在启动 preview 前以非零状态退出，错误包含实际端口、`the port is already in use` 与 `Set PREVIEW_PORT` 的处理建议，不会写出或覆盖任何截图；端口探测通过后 preview 提前退出时，脚本报告子进程退出码与 stderr，不会再静默连到端口上的其它服务、之后才以无关的定位器超时报错。
- 复现 Before：在 `a60062e` 的干净 worktree 里 `npm ci && npm run build`，用 `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4192 --strictPort` 启动预览，再运行 `BASE_URL=http://127.0.0.1:4192 npm run screenshots:minesweeper:scores-before`（Before 模式不启动 preview，端口以 `BASE_URL` 为准）。

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `before-minesweeper-scores-desktop.png` | 扫雷 WON（基线 `a60062e`） | 1440×1000 / 深色 / 整页 1440×1324 | 侧栏没有最高用时卡片；胜利遮罩、固定雷盘与 After 相同。 |
| `after-minesweeper-scores-desktop.png` | 扫雷 WON（#45 子任务 1 历史证据） | 1440×1000 / 深色 / 整页 1440×1606 | 难度卡片后新增最高用时卡片：初级显示刚写入的用时，中级 / 高级显示 `—`，自定义区显示预置的 30×30 / 100 雷（首点不安全）记录；该时期还没有「清空记录」按钮，默认不被当前命令覆盖。 |
| `before-minesweeper-scores-320x640.png` | 扫雷 WON（320×640 基线 `a60062e`） | 320×640 / 深色 / 整页 640×3580 | 手机整页截图没有最高用时卡片，页面无横向溢出。 |
| `after-minesweeper-scores-320x640.png` | 扫雷 WON（320×640，#45 子任务 1 历史证据） | 320×640 / 深色 / 整页 640×4098 | 长自定义标签在卡片内换行，320px 下页面无横向溢出；新增卡片使整页高度增加，该时期还没有「清空记录」按钮，默认不被当前命令覆盖。 |

### 证据限制

- 手机端为 Playwright 320×640 触摸模拟（DPR 2），不是真实设备截图。
- 截图只证明静态视觉；写入 / 刷新保留、失败不写入、慢成绩不覆盖、切换难度与损坏数据回退由 `src/games/minesweeper/view.test.ts` 覆盖，胜利刷新保留、失败不记录与 320px 长标签无溢出由 `tests/e2e/minesweeper.spec.ts` / `minesweeper.mobile.spec.ts` 在生产构建上验证。
- Before 基线已有存储模块，但还没有榜单 UI；本组 Before / After 只证明视觉差异，不证明存储逻辑（由存储模块自身的单测覆盖）。

## scores-clear：扫雷最高用时「清空记录」（Issue #45 / 子任务 2）

- Before 基线：`289d76d`（子任务 1 合入后的 `main`，也就是本子任务开始前的 `main`）。最高用时卡片已有预设 / 自定义成绩与「还没有记录」空态，但没有任何清空入口。
- After：本子任务分支 `agent/plan-45-t2` 的提交 [`8ca28f7`](https://github.com/yeahdongcn-mk2/playground/commit/8ca28f7)。最高用时卡片底部新增「清空记录」按钮（`data-testid="clear-scores-button"`、可访问名称「清空记录」）：有记录时可用，空榜时保持可见但禁用；点击后整张榜立即回到空态并通过现有 announcer 播报，只删除扫雷成绩键，其它游戏 / 设置存储保持不变。
- 视口 / 主题：桌面 1440×1000 CSS px、DPR 1；手机 320×640 CSS px、DPR 2、`isMobile: true`、`hasTouch: true`；两者均为深色主题、`reducedMotion: reduce`，Before / After 使用同一 URL、同一固定初级雷盘、同一预置自定义记录与同一 WON 状态，均为整页截图（`fullPage: true`）。
- 生成 After：`npm run screenshots:minesweeper:scores-clear`（生产构建 + `vite preview`）。
- 预览端口：与 scores 相同，默认 `4192`；共享主机或并行 worktree 用 `PREVIEW_PORT=4193 npm run screenshots:minesweeper:scores-clear` 覆盖（空串回退 `4192`）。端口已被占用时同样在启动 preview 前以非零状态退出并提示 `PREVIEW_PORT`，preview 在端口探测通过后提前退出时报告子进程退出码与 stderr；两种失败都不写出或覆盖任何截图。
- 复现 Before：先在 `289d76d` 的干净 worktree 里 `npm ci && npm run build`，用 `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4193 --strictPort` 启动基线 preview；然后在含本 PR 脚本的 worktree（本分支）里运行 `BASE_URL=http://127.0.0.1:4193 npm run screenshots:minesweeper:scores-clear-before`。这个 npm script 与脚本的 `--clear` 支持都是本 PR 才新增的，直接在 `289d76d` worktree 里执行会报 `Missing script`；Before 模式不启动 preview，端口以 `BASE_URL` 指向的基线 preview 为准，脚本会确认基线有榜单卡片但没有清空按钮。

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `before-minesweeper-clear-scores-desktop.png` | 扫雷 WON（基线 `289d76d`） | 1440×1000 / 深色 / 整页 1440×1606 | 最高用时卡片有初级成绩、预设占位与长自定义记录，但底部没有清空入口；胜利遮罩与固定雷盘和 After 相同。 |
| `after-minesweeper-clear-scores-desktop.png` | 扫雷 WON（本子任务） | 1440×1000 / 深色 / 整页 1440×1661 | 卡片底部新增可用的「清空记录」按钮；记录内容、遮罩与基线一致，新增按钮使整页高度增加。 |
| `before-minesweeper-clear-scores-320x640.png` | 扫雷 WON（320×640 基线 `289d76d`） | 320×640 / 深色 / 整页 640×4098 | 手机整页截图同样没有清空入口，长自定义标签照常换行，页面无横向溢出。 |
| `after-minesweeper-clear-scores-320x640.png` | 扫雷 WON（320×640 本子任务） | 320×640 / 深色 / 整页 640×4210 | 手机端新增的「清空记录」按钮仍位于卡片内，320px 下无横向溢出；页面高度增加来自新增按钮。 |

### 证据限制

- 截图只证明有记录时按钮可见且可用这一静态视觉；空榜禁用、点击后立即空态与播报、只删扫雷键与刷新后仍为空由 `src/games/minesweeper/view.test.ts` 与 `tests/e2e/minesweeper.spec.ts` 在生产构建上验证。
- Before 基线已经包含最高用时榜，因此这组 Before / After 只证明清空入口的视觉差异，不重复证明榜单本身的视觉（见上一节 scores）。
- 手机端为 Playwright 320×640 触摸模拟（DPR 2），不是真实设备截图。

## difficulty：扫雷难度选择（Issue #44 / 子任务 3）

- Before 基线：`9f9aa54`（PR #57 合入「扫雷视图支持任意棋盘配置与安全重建」后的 `main`，也就是本子任务开始前的 `main`）。侧栏只有操作与本局状态卡片，没有难度控件。
- After：本子任务分支 `agent/plan-44-t3` 的提交 [`2933d26`](https://github.com/yeahdongcn-mk2/playground/commit/2933d26)（该提交含难度卡片 UI 修正并刷新了 After 截图）。侧栏在操作与本局状态卡片之后新增「难度」卡片：初级 / 中级 / 高级三个预设按钮，以及行 / 列 / 雷数三个数字输入和「开始自定义」按钮；当前档以 `aria-pressed` 标记，非法自定义在 `role=alert` 区域显示中文错误。其后审查修正只改 e2e 断言与文档；合并 `main` 后在本分支重新生成截图，桌面 After PNG 仍与 `2933d26` 逐字节一致（sha256 `88d1fb28…`）。
- 视口 / 主题：桌面 1440×1000 CSS px，DPR 1，深色主题，`reducedMotion: reduce`；Before / After 使用同一固定雷盘（`?debug=1&mines=...`）、READY 状态，均为整页截图（`fullPage: true`）。
- 生成 After：`npm run screenshots:minesweeper`（生产构建 + `vite preview`，固定雷盘走调试接缝）。该命令刷新大厅（大厅卡片描述和侧栏布局随难度选择更新）；4 张桌面与 4 张手机玩法历史图默认跳过并打印守卫警告；确需重建时只能在固定容器内用 `npm run screenshots:container -- screenshots:minesweeper --allow-historical-overwrite`，并在同一改动中同步 `993f5e7`（#61）等捕获 commit 与 `capture-sha256-manifest.json` 条目（若收录）。
- 预览端口：默认 `4186`，共享主机或并行 worktree 用 `PREVIEW_PORT=4187 npm run screenshots:minesweeper:short` 覆盖。端口已被占用时脚本会在启动 preview 与创建输出目录之前以非零状态退出并提示 `PREVIEW_PORT`，不会写出任何截图，也不会静默连到别人的 preview。
- 复现 Before：在 `9f9aa54` 的干净 worktree 里 `npm ci && npm run build`，用 `node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4186 --strictPort` 启动预览，再运行 `BASE_URL=http://127.0.0.1:4186 npm run screenshots:container -- screenshots:minesweeper --allow-historical-overwrite`。这里用默认 after 模式即可，但必须显式加 `--allow-historical-overwrite` 且只能在固定容器内执行，因为共享守卫会默认跳过 `after-minesweeper-ready-desktop.png` 等历史文件名；通用 `--before` 模式已删除（显式传入会报错并以非零状态退出），它原先只服务于更早的、还没有扫雷路由的基线。脚本会以 After 文件名写出基线截图，把 `after-minesweeper-ready-desktop.png` 另存为 `before-minesweeper-ready-desktop.png` 即可。

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `before-minesweeper-ready-desktop.png` | 扫雷 READY（基线 `9f9aa54`） | 1440×1000 / 深色 / 整页 1440×1027 | 侧栏没有难度卡片；9×9 隐藏棋盘、HUD 与操作说明。 |
| `after-minesweeper-ready-desktop.png` | 扫雷 READY（本子任务，#61 历史证据） | 1440×1000 / 深色 / 整页 1440×1324 | 侧栏在操作与本局状态卡之后新增难度卡片，初级预设为 `aria-pressed="true"`，自定义表单显示 9 / 9 / 10；棋盘与 HUD 仍是初级 READY。整页高度增加来自新增侧栏卡片。 |

本次同时刷新了 `after-hub-desktop.png` / `after-hub-mobile.png`（大厅卡片描述改为支持难度选择）与 4 张桌面玩法截图；手机玩法截图只显示首屏，难度卡片位于侧栏下方、首屏不可见，其滚动后的可操作性由手机 e2e 覆盖。这 4 张桌面玩法图与 t7 的 4 张手机玩法图最后捕获于 `993f5e7`（#61）；当前构建重跑桌面整页为 1440×1529（won 为 1440×1598），手机图约 50.7–56.1 万像素不同，原因是 #85 最高用时榜、#87「清空记录」等侧栏 UI 变更后未重拍。表格中的「整页 1440×1324」是已提交 PNG 的值，不能作为当前构建「重跑必须逐字节一致」的基准；权威对照口径见文首「历史 After 证据与当前构建不一致（Issue #137）」。

### 证据限制

- Before / After 只提供桌面扫雷页面；手机端难度控件的可操作性由 `tests/e2e/minesweeper.difficulty.mobile.spec.ts` 在 412×839 与 320×640 视口验证，不依赖截图比对。
- 手机截图仍是 Playwright 设备模拟（Pixel 7 / 自定义视口），不是真实设备截图。
- 截图只证明静态视觉；三档切换、合法 / 非法自定义、计时器与监听器清理由 `tests/e2e/minesweeper.difficulty.spec.ts` 在生产构建上验证。

## restart：扫雷 320×640 首屏纵向溢出（Issue #53 / 子任务 1）

- Before 基线：`9f9aa54`（本条子任务开始前的最新 `main`，已含子任务 0 的窄屏格子修复与 #57 的可配置棋盘视图；默认 9×9 布局与格子尺寸不变）。320×640 READY 下 9×9 格子约 34.2×34.2 px、无横向溢出，HUD 与返回大厅在首屏内；但 `mobile-restart-button` 底部约 664.1 px，未完整落在首屏内（底部约 24 px 被视口截断）。
- After：本子任务分支 `agent/plan-39-t1`，变更提交 `46f0381`（截图与代码同提交）。`minesweeper.css` 新增 `@media (max-width: 400px) and (max-height: 700px)`，只压缩窄而矮视口内的纵向间距（`.minesweeper-game` 的 padding-bottom、`.game-heading` 的 padding / row-gap、HUD stat 的 padding / line-height、touch hint 与 touch actions 的 margin / line-height）。棋盘宽度、格子尺寸、横向规则和游戏规则未变：320×640 下格子仍约 34.2×34.2 px、无横向溢出；`mobile-restart-button` 底部约 612.5 px，完整落在 640 px 首屏内。查询覆盖的最宽视口 400×700 经手工测量也在首屏内（约 692.5 px）。360×740（高度 > 700 px）不受该查询影响，布局与子任务 0 一致。
- 视口 / 主题：320×640 CSS px，DPR 2，`isMobile: true`、`hasTouch: true`，深色主题，`reducedMotion: reduce`；同一固定雷盘（WIN_MINES）与 READY 状态，均为视口截图（`fullPage: false`）。
- 生成 After：`npm run screenshots:minesweeper:restart`（生产构建 + `vite preview`）。
- 复现 Before：在 `9f9aa54` 的干净 worktree 里 `npm ci && npm run build`，用 `node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4191 --strictPort` 启动预览，然后在当前分支运行 `BASE_URL=http://127.0.0.1:4191 npm run screenshots:minesweeper:restart-before`。

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `before-minesweeper-ready-320x640-restart.png` | 扫雷 READY（320×640，含重开入口） | 320×640 / 深色 | 修复前：格子约 34.2 px，重开按钮底部约 664.1 px，底部被首屏截断约 24 px。 |
| `after-minesweeper-ready-320x640-restart.png` | 扫雷 READY（320×640，含重开入口） | 320×640 / 深色 | 修复后：格子尺寸不变，重开按钮底部约 612.5 px，完整在首屏内。 |

### 证据限制

- 手机端为 Playwright 设备模拟（320×640、DPR 2、触摸），不是真实设备截图。
- 截图只证明静态视觉；`tests/e2e/minesweeper.mobile.spec.ts` 的 320×640 用例断言 `mobile-restart-button` 的 `x + width <= 320` 且 `y + height <= 640`，并检查返回大厅、remaining-mines、timer 在首屏、81 个格子仍 ≥34 px、无横向溢出、touch-hint 仍可见。360×740 / 340×700 / 349×700 / 412×839 的既有手机用例继续通过。
- `400×700` 的首屏位置来自手工测量，未纳入自动化用例；自动化断言只覆盖 `320×640` 重开入口与既有手机视口用例。

## narrow / min：扫雷 320–360px 窄屏触控目标（Issue #53 / 子任务 0）

- Before 基线：`3814d69`（本条子任务开始前的 `main`）。320×640 下 9×9 格子约 32.7×32.7 px；360×740 下约 37.1×37.1 px。两者页面均无横向溢出，HUD 与返回大厅在首屏内；360×740 另含重开入口。
- After：本子任务分支 `agent/plan-39-t0`。`minesweeper.css` 的 `max-width: 400px` 断点改用 `margin-inline: -12px`、stage `padding: 1px`，保留 1px 棋盘 gap；320×640 下每格约 34.2×34.2 px，360×740 下约 38.7×38.7 px，页面无横向溢出。320×640 下 HUD 与返回大厅在首屏内；360×740 下 HUD、返回大厅与 `mobile-restart-button` 仍在首屏内。桌面布局与游戏规则未改。
- 视口 / 主题：320×640 与 360×740 CSS px，DPR 2，`isMobile: true`、`hasTouch: true`，深色主题，`reducedMotion: reduce`；同一固定雷盘、READY 状态，均为视口截图（`fullPage: false`）。
- 生成 After：`npm run screenshots:minesweeper:min`（320×640）与 `npm run screenshots:minesweeper:narrow`（360×740），均为生产构建 + `vite preview`。
- 复现 Before：在 `3814d69` 的干净 worktree 里 `npm ci && npm run build`，用 `node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4189 --strictPort` 启动预览，然后在当前分支运行 `BASE_URL=http://127.0.0.1:4189 npm run screenshots:minesweeper:min-before` 与 `BASE_URL=http://127.0.0.1:4189 npm run screenshots:minesweeper:narrow-before`。

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `before-minesweeper-ready-320x640.png` | 扫雷 READY（320 最低宽度） | 320×640 / 深色 | 修复前：格子约 32.7 px。 |
| `after-minesweeper-ready-320x640.png` | 扫雷 READY（320 最低宽度） | 320×640 / 深色 | 修复后：格子约 34.2 px，横向无溢出。 |
| `before-minesweeper-ready-360x740.png` | 扫雷 READY（360 窄屏） | 360×740 / 深色 | 修复前：格子约 37.1 px。 |
| `after-minesweeper-ready-360x740.png` | 扫雷 READY（360 窄屏） | 360×740 / 深色 | 修复后：格子约 38.7 px，横向无溢出，HUD、返回大厅与重开入口仍在首屏。 |

### 证据限制

- 手机端为 Playwright 设备模拟（320×640 / 360×740、DPR 2、触摸），不是真实设备截图。
- 截图只证明静态视觉；`tests/e2e/minesweeper.mobile.spec.ts` 的 320×640 / 340×700 / 349×700 / 360×740 用例逐一断言 81 个格子的最小尺寸（320 下 ≥34 px，340 / 349 / 360 下 ≥36 px）、`scrollWidth - innerWidth === 0`，并检查 HUD、返回大厅（360 另含重开入口）在视口内。

## t7：扫雷触屏与手机布局（Issue #33 / 子任务 2）

- Before 基线：`60bc3f3`（PR #36 合入扫雷 DOM 视图后、本子任务触屏与手机布局改动前）。页面已有桌面鼠标操作；手机视口下轻点可以翻开，但没有触屏插旗，重开按钮位于首屏之外。
- After：本子任务分支 `agent/plan-33-t2`。手机与桌面 After 截图在提交 [`c7bdade`](https://github.com/yeahdongcn-mk2/playground/commit/c7bdade) 捕获并入库；其后 `fbbe118` 只调整触屏交互逻辑与测试、把触屏提示 / 手机重开按钮的显示条件从 `(hover: none) and (pointer: coarse)` 放宽到 `any-pointer: coarse`，并同步 README 与截图脚本；`f36826f` 重截 `before-minesweeper-playing-mobile.png` 并对齐本文件引用，静态截图的界面视觉未变，因此这些 After 截图仍代表当前 head。Before 截图由 `60bc3f3` 构建生成，同样在 `c7bdade` 入库（游玩中一张在 `f36826f` 重截）。PR [#38](https://github.com/yeahdongcn-mk2/playground/pull/38) 描述附有 4 组 Before / After 链接。
- 视口 / 主题：Pixel 7（412×839 CSS px，DPR 2.625，`isMobile: true`、`hasTouch: true`），深色主题，`reducedMotion: reduce`。Before / After 使用同一场景、同一视口、同一状态，均为视口截图（`fullPage: false`），以便核对 HUD、返回大厅与重开入口在手机首屏内完整可见。
- 生成 After：`npm run screenshots:minesweeper`（生产构建 + `vite preview`，固定雷盘走 `?debug=1&mines=row,col;...` 调试接缝）。4 张手机玩法历史图默认跳过并打印守卫警告；确需重建时只能在固定容器内用 `npm run screenshots:container -- screenshots:minesweeper --allow-historical-overwrite`，并在同一改动中同步捕获 commit 与 `capture-sha256-manifest.json` 条目（若收录）。
- 复现 Before：在 `60bc3f3` 的干净 worktree 里 `npm ci && npm run build`，用 `node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4188 --strictPort` 启动预览，然后在当前分支运行 `BASE_URL=http://127.0.0.1:4188 npm run screenshots:minesweeper:touch-before`。Before 的游玩中截图用鼠标右键插旗（基线还没有触屏插旗），After 用真实触摸轻点 + 长按插旗，因此两张游玩中截图里的旗子与 HUD 状态相同，但产生方式不同。

### Before（`60bc3f3`，桌面鼠标输入、无手机布局调整）

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `before-minesweeper-ready-mobile.png` | 扫雷 READY（手机） | Pixel 7 412×839 / 深色 | 初始棋盘与 HUD；HUD 与返回大厅可见，但重开按钮在首屏之外。 |
| `before-minesweeper-playing-mobile.png` | 扫雷游玩中（手机） | Pixel 7 412×839 / 深色 | 轻点翻开安全格、右键（鼠标）插旗后的棋盘与 HUD。 |
| `before-minesweeper-lost-mobile.png` | 扫雷 BOOM（手机） | Pixel 7 412×839 / 深色 | 踩雷结束遮罩与全部雷。 |
| `before-minesweeper-won-mobile.png` | 扫雷 CLEARED（手机） | Pixel 7 412×839 / 深色 | 固定雷盘翻开全部安全格后的胜利遮罩。 |

### After（`agent/plan-33-t2`，截图捕获于 `c7bdade`）

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `after-minesweeper-ready-mobile.png` | 扫雷 READY（手机，#61 历史证据） | Pixel 7 412×839 / 深色 | 触屏提示、轻点 / 长按说明，以及位于首屏内的「重开」入口；9×9 格子加大到约 39 px 触控目标。 |
| `after-minesweeper-playing-mobile.png` | 扫雷游玩中（手机，#61 历史证据） | Pixel 7 412×839 / 深色 | 真实触摸轻点翻开、长按 0.5 秒插旗后的状态；HUD 剩余雷数随之减少。 |
| `after-minesweeper-lost-mobile.png` | 扫雷 BOOM（手机，#61 历史证据） | Pixel 7 412×839 / 深色 | 触摸踩雷后的失败遮罩。 |
| `after-minesweeper-won-mobile.png` | 扫雷 CLEARED（手机，#61 历史证据） | Pixel 7 412×839 / 深色 | 触摸翻开最后一格后的胜利遮罩。 |

`after-hub-desktop.png` / `after-hub-mobile.png` 也随本子任务刷新，因为扫雷卡片新增了触屏操作说明；`after-minesweeper-*-desktop.png` 因侧栏新增「触屏」操作行而重新生成，桌面鼠标左键 / 右键行为不变。

以上 4 张手机玩法图同样是历史证据：最后捕获于 `993f5e7`（#61），当前构建重跑尺寸仍为 1082×2202，但 ready / playing / lost / won 分别约有 50.8 / 50.9 / 50.7 / 56.1 万像素不同，范围约 50.7–56.1 万像素。原因是 #85 最高用时榜、#87「清空记录」等侧栏 UI 变更后未重拍；它们只代表 #61 时点的 UI，不能作为当前构建「重跑必须逐字节一致」的基准。权威对照口径见文首「历史 After 证据与当前构建不一致（Issue #137）」。

### 证据限制

- 手机端为 Playwright Pixel 7 设备模拟（412×839、DPR 2.625、触摸），不是真实手机截图。
- Before 截图只能证明旧界面的视觉状态；触屏长按 / 取消等交互行为由 `tests/e2e/minesweeper.mobile.spec.ts` 在生产构建上验证，不依赖截图比对。
- PR [#38](https://github.com/yeahdongcn-mk2/playground/pull/38) 描述中附有 4 组 Before / After 截图链接（基线 `60bc3f3`），截图与说明随分支一起提交。

## t6：扫雷（Issue #33 / 子任务 1）

- Before 基线：main `cdd2200`（PR #35 合入扫雷规则引擎后、接入共享框架前的提交）。大厅还没有扫雷卡片，`#/games/minesweeper` 显示「没有找到这个游戏」。
- After：PR #36（分支 `agent/plan-33-t1`）。大厅 After 截图捕获于提交 [`e75da7b`](https://github.com/yeahdongcn-mk2/playground/commit/e75da7bddb6172bd44b6ef7cd0edfb6911364258)，4 张玩法 After 截图重跑后与该提交内容逐字节一致；其后提交只更新本文档与测试，不改变界面。PR 描述中附有 Before / After 截图链接。后续 t7 子任务因侧栏新增「触屏」操作行、扫雷卡片新增触屏说明，重新生成了 4 张桌面玩法截图与大厅截图；桌面鼠标左键 / 右键行为未变。
- 视口 / 主题：桌面 1440×1000、手机 390×844（DPR 2），深色主题，`reducedMotion: reduce`。桌面与手机大厅均为整页截图（`fullPage: true`），Before / After 用同一口径。
- 生成：`npm run screenshots:minesweeper`（生产构建 + `vite preview`，固定雷盘走 `?debug=1&mines=row,col;...` 调试接缝）。4 张桌面玩法历史图默认跳过并打印守卫警告；确需重建时只能在固定容器内用 `npm run screenshots:container -- screenshots:minesweeper --allow-historical-overwrite`，并在同一改动中同步捕获 commit 与 `capture-sha256-manifest.json` 条目（若收录）。
- Before 来源：该组 Before 图在通用 `--before` 模式移除前，于 `cdd2200` 的干净 worktree 里用当时的扫雷截图命令生成。通用模式与对应的 npm 命令现已删除，脚本会对 `--before` 明确报错并以非零状态退出，因此这 3 张 Before 图只作为 `cdd2200` 的历史证据保留，不再由当前脚本复现。

### Before（main `cdd2200`，没有扫雷）

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `before-minesweeper-hub-desktop.png` | main 大厅 | 1440×1000 / 深色 | 只有贪食蛇、俄罗斯方块、2048、打砖块与空白画布卡片（没有扫雷）。 |
| `before-minesweeper-hub-mobile.png` | main 大厅（手机） | 390×844（DPR 2）/ 深色 | 整页单列大厅，没有扫雷卡片。 |
| `before-minesweeper-route-desktop.png` | main 访问 `#/games/minesweeper` | 1440×1000 / 深色 | 真实基线：扫雷未注册，显示「没有找到这个游戏」。 |

### After（PR #36，截图捕获于 `e75da7b`）

`after-hub-desktop.png` / `after-hub-mobile.png` 已刷新为同时含贪食蛇、俄罗斯方块、2048、打砖块、扫雷与空白画布卡片的大厅（手机为整页截图）。

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `after-hub-desktop.png` | 大厅 | 1440×1000 / 深色 | 新增扫雷卡片与入口。 |
| `after-hub-mobile.png` | 大厅（手机） | 390×844（DPR 2）/ 深色 | 整页单列布局，含扫雷卡片。 |
| `after-minesweeper-ready-desktop.png` | 扫雷 READY（#61 历史证据） | 1440×1000 / 深色 / 整页 1440×1324 | 9×9 隐藏棋盘、HUD、侧栏与操作提示；文件已由难度选择子任务刷新为含难度卡片的整页截图。 |
| `after-minesweeper-playing-desktop.png` | 扫雷游玩中（#61 历史证据） | 1440×1000 / 深色 / 整页 1440×1324 | 翻开部分棋盘、一面旗子、剩余雷数与计时；侧栏含难度卡片。 |
| `after-minesweeper-won-desktop.png` | 扫雷 CLEARED（#61 历史证据） | 1440×1000 / 深色 / 整页 1440×1324 | 固定雷盘翻开全部安全格后的胜利遮罩；侧栏在状态卡后含难度卡片。 |
| `after-minesweeper-lost-desktop.png` | 扫雷 BOOM（#61 历史证据） | 1440×1000 / 深色 / 整页 1440×1324 | 固定雷盘踩雷后的失败遮罩与全部雷；侧栏在状态卡后含难度卡片。 |

以上 4 张桌面玩法图是历史证据：最后捕获于 `993f5e7`（#61），当前构建重跑桌面整页为 1440×1529（won 为 1440×1598），已提交 PNG 与表中「整页 1440×1324」一致；原因是 #85 最高用时榜、#87「清空记录」等侧栏 UI 变更后未重拍。它们只代表 #61 时点的 UI，不能作为当前构建「重跑必须逐字节一致」的基准；权威对照口径见文首「历史 After 证据与当前构建不一致（Issue #137）」。

### 证据限制

- main 没有扫雷页面，所以 Before 只能对比大厅（同一视口 / 主题）与真实未注册路由，不能与旧版扫雷页面逐像素对比。
- 通用 `--before` 模式及其 npm 命令已删除；上表 3 张 Before 图是 `cdd2200` 的历史证据，不再由当前脚本生成。
- After 大厅截图已在最终 head 重新生成：`7b2f05b` 的 hub 文案改动会让旧图过期，当时刷新后桌面大厅为 1440×3422；4 张游戏页截图重跑后逐字节一致。后续难度选择子任务再次刷新了这些共用文件：桌面大厅变为 1440×3468，4 张桌面玩法截图变为整页 1440×1324 并含难度卡片（见文首 difficulty 小节）。
- 本子任务只做桌面输入与桌面 e2e；手机端只刷新大厅截图，不覆盖手机端扫雷玩法。
- 手机端为 Playwright 设备模拟（390×844、DPR 2、触摸、大厅整页截图），不是真实设备截图。
- 截图来自生产构建；交互行为另有桌面 e2e 验证，不依赖截图比对。

## t5：打砖块（Issue #27 / 子任务 1）

- Before 基线：main `63bf67e`（PR #28 合入打砖块规则引擎后、接入共享框架前的提交）。大厅还没有打砖块卡片，`#/games/breakout` 显示「没有找到这个游戏」。
- After：PR #29 的截图捕获提交 [`abed3bc`](https://github.com/yeahdongcn-mk2/playground/commit/abed3bc0346fe738f24ef4e51666ca1ddb369f48)（分支 `agent/plan-27-t1`）。其后提交只修改 `tests/e2e/` 与 `docs/screenshots/README.md`，不改变界面；PR 描述中附有 Before / After 截图链接。
- 视口 / 主题：桌面 1440×1000、手机 390×844（DPR 2），深色主题，`reducedMotion: reduce`。桌面与手机大厅均为整页截图（`fullPage: true`），手机 Before / After 用同一口径，保证单列布局中的打砖块卡片进入画面。
- 生成：`npm run screenshots:breakout`（生产构建 + `vite preview`，固定砖块 / 球 / 生命走 `?debug=1` 调试接缝）。`after-breakout-ready-desktop.png` / `after-breakout-levelclear-desktop.png` / `after-breakout-gameover-desktop.png` 与 `after-breakout-ready-mobile.png` / `after-breakout-gameover-mobile.png` 是 `26e84fa`（#29）捕获的历史证据：桌面整页图含旧页脚，手机图重跑差异覆盖游戏区约 y=472..1565（不是页脚），用当前构建重跑必然不同；脚本默认跳过这些历史图并打印守卫警告，确需重建时只能在固定容器内用 `npm run screenshots:container -- screenshots:breakout --allow-historical-overwrite`，并在同一改动中同步本节捕获 commit 与 `capture-sha256-manifest.json` 条目（若收录）；权威对照口径见「历史 After 证据与当前构建不一致（Issue #137）」。
- 游玩截图确定性：`openPlaying()` 固定 `?debug=1&seed=7&steps=120`。点击「开始游戏」后，调试接缝在下一帧内以引擎固定的 120 Hz 步长（`FIXED_STEP_MS`）精确推进 120 个固定步（约 1 秒模拟时间），随后暂停主循环；截图脚本等待 `data-debug-steps=120` 标记后再截图。所以球、挡板与砖块状态只由 seed 与步数决定，不依赖真实帧时序。因此 3 张 `after-breakout-playing-{desktop,mobile,webkit}.png` 是确定性产物：同一构建、预览端口 4185 空闲时连续两次执行 `npm run screenshots:breakout`（以及 `npm run screenshots:breakout:webkit`）得到的 sha256 完全一致，并等于已提交产物；ready / levelclear / gameover / hub 等未走该接缝的图不受影响。复现命令：`npm run screenshots:breakout && npm run screenshots:breakout:webkit`，随后用 `sha256sum docs/screenshots/after-breakout-playing-{desktop,mobile,webkit}.png` 对照。WebKit 产物在官方 Playwright 容器（`mcr.microsoft.com/playwright:v1.64.1-noble`，与仓库的 Playwright 1.64.1 对应）内捕获，避免宿主 EGL / 字体环境差异。本子任务重生成的桌面整页 playing 图带当前页脚，与其余 desktop 图的旧页脚不一致；页脚漂移统一由 #137 跟踪，不影响本子任务的确定性验收。
- 预览端口：默认 `4185`；共享主机或并行 worktree 用 `PREVIEW_PORT=4186 npm run screenshots:breakout` 覆盖（`PREVIEW_PORT` 为空串时回退 `4185`；`screenshots:breakout:webkit` 复用同一启动路径与端口）。端口已被占用时脚本在启动 preview 前以非零状态退出，错误包含实际端口、`the port is already in use` 与 `Set PREVIEW_PORT` 建议，不会写出或覆盖任何截图；端口探测通过后 preview 提前退出时报告子进程退出码与 stderr，不再静默连到端口上的其它服务。Before 模式（`screenshots:breakout:before`）以 `BASE_URL` 为准，不启动 preview、不探测端口。
- 复现 Before：在 `63bf67e` 的干净 worktree 里 `npm ci && npm run build`，用 `node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4184 --strictPort` 启动预览，然后在当前分支运行 `BASE_URL=http://127.0.0.1:4184 npm run screenshots:breakout:before`。

### Before（main `63bf67e`，没有打砖块）

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `before-breakout-hub-desktop.png` | main 大厅 | 1440×1000 / 深色 | 只有贪食蛇、俄罗斯方块、2048 与空白画布卡片（没有打砖块）。 |
| `before-breakout-hub-mobile.png` | main 大厅（手机） | 390×844（DPR 2）/ 深色 | 整页单列大厅，没有打砖块卡片。 |
| `before-breakout-route-desktop.png` | main 访问 `#/games/breakout` | 1440×1000 / 深色 | 真实基线：打砖块未注册，显示「没有找到这个游戏」。 |
| `before-breakout-route-mobile.png` | main 访问 `#/games/breakout`（手机） | 390×844（DPR 2）/ 深色 | 同上，手机视口。 |

### After（PR #29，截图捕获于 `abed3bc`）

`after-hub-desktop.png` / `after-hub-mobile.png` 已刷新为同时含贪食蛇、俄罗斯方块、2048、打砖块、扫雷与空白画布卡片的大厅（手机为整页截图）。

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `after-hub-desktop.png` | 大厅 | 1440×1000 / 深色 | 新增打砖块卡片与入口。 |
| `after-hub-mobile.png` | 大厅（手机） | 390×844（DPR 2）/ 深色 | 整页单列布局，含打砖块卡片。 |
| `after-breakout-ready-desktop.png` | 打砖块 READY（#29 历史证据） | 1440×1000 / 深色 | 球场、分层砖块、HUD 与开始遮罩。 |
| `after-breakout-playing-desktop.png` | 打砖块游玩中 | 1440×1000 / 深色 | 挡板、球、砖墙与 HUD。 |
| `after-breakout-levelclear-desktop.png` | 打砖块 LEVEL CLEAR（#29 历史证据） | 1440×1000 / 深色 | 固定单砖清空后的过关遮罩。 |
| `after-breakout-gameover-desktop.png` | 打砖块 GAME OVER（#29 历史证据） | 1440×1000 / 深色 | 固定单条命结束后的结算与重开入口。 |
| `after-breakout-ready-mobile.png` | 打砖块 READY（手机，#29 历史证据） | 390×844（DPR 2）/ 深色 | 手机端球场与开始遮罩。 |
| `after-breakout-playing-mobile.png` | 打砖块游玩中（手机） | 390×844（DPR 2）/ 深色 | 手机端球场、HUD 与触屏提示。 |
| `after-breakout-gameover-mobile.png` | 打砖块 GAME OVER（手机，#29 历史证据） | 390×844（DPR 2）/ 深色 | 手机端结算与重开入口。 |

### 证据限制

- main 没有打砖块页面，所以 Before 只能对比大厅（同一视口 / 主题）与真实未注册路由，不能与旧版打砖块页面逐像素对比。
- 桌面整页与手机 ready / gameover After 图与当前构建的对照口径见「历史 After 证据与当前构建不一致（Issue #137）」：这些图是 #29 历史证据，逐字节比较只在同一构建、同一捕获环境下成立。
- 手机端为 Playwright 设备模拟（390×844、DPR 2、触摸、大厅整页截图），不是真实设备截图。
- 截图来自生产构建；绘制行为另有 e2e 读取 canvas 像素验证，不依赖截图比对。

## t4：2048（PR #26）

- Before 基线：main `d54ae9f`（PR #26 的父提交）。大厅还没有 2048 卡片，`#/games/2048` 显示「没有找到这个游戏」。
- After：本 PR head（见 PR 描述中的 commit SHA）。
- 视口 / 主题：桌面 1440×1000、手机 390×844（DPR 2），深色主题，`reducedMotion: reduce`。桌面与手机大厅均为整页截图（`fullPage: true`）；手机 Before 用同一口径重截，保证单列布局中的 2048 卡片进入画面。
- 生成：`npm run screenshots:2048`（生产构建 + `vite preview`，固定棋盘走 `?debug=1` 调试接缝）。`after-2048-ready-desktop.png` / `after-2048-ready-mobile.png` 是 `8ec4adc`（#26）捕获的历史证据：桌面整页图含旧页脚，手机 ready 图当前构建重跑有 15599 个像素不同（每通道最大 20，集中在棋盘面板边缘）；脚本默认跳过这两张历史图并打印守卫警告，确需重建时只能在固定容器内用 `npm run screenshots:container -- screenshots:2048 --allow-historical-overwrite`，并在同一改动中同步本节捕获 commit、尺寸与 `capture-sha256-manifest.json` 条目（若收录）；权威对照口径见「历史 After 证据与当前构建不一致（Issue #137）」。
- 预览端口：默认 `4183`；共享主机或并行 worktree 用 `PREVIEW_PORT=4184 npm run screenshots:2048` 覆盖（`PREVIEW_PORT` 为空串时回退 `4183`；`screenshots:2048:webkit` 复用同一启动路径与端口）。端口已被占用时脚本在启动 preview 前以非零状态退出，错误包含实际端口、`the port is already in use` 与 `Set PREVIEW_PORT` 建议，不会写出或覆盖任何截图；端口探测通过后 preview 提前退出时报告子进程退出码与 stderr，不再静默连到端口上的其它服务。Before 模式（`screenshots:2048:before`）以 `BASE_URL` 为准，不启动 preview、不探测端口。
- 复现 Before：在 `d54ae9f` 的干净 worktree 里 `npm ci && npm run build`，用 `node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4184 --strictPort` 启动预览，然后在分支运行 `BASE_URL=http://127.0.0.1:4184 npm run screenshots:2048:before`。

### Before（main，没有 2048）

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `before-2048-hub-desktop.png` | main 大厅 | 1440×1000 / 深色 | 只有贪食蛇、俄罗斯方块与空白画布卡片（没有 2048）。 |
| `before-2048-hub-mobile.png` | main 大厅（手机） | 390×844（DPR 2）/ 深色 | 整页单列大厅，没有 2048 卡片。 |
| `before-2048-route-desktop.png` | main 访问 `#/games/2048` | 1440×1000 / 深色 | 真实基线：2048 未注册，显示「没有找到这个游戏」。 |
| `before-2048-route-mobile.png` | main 访问 `#/games/2048`（手机） | 390×844（DPR 2）/ 深色 | 同上，手机视口。 |

### After（本 PR）

`after-hub-desktop.png` / `after-hub-mobile.png` 是跨任务共用的文件名，当前已由 t6 刷新为含扫雷的五游戏大厅（手机为整页截图）；2048 卡片仍在。下表「新增 2048 卡片」描述的是 t4 当时的页面状态。2048 的文件名保留 `-desktop` / `-mobile` 后缀，明确每种状态各自的视口。

| 文件 | 场景 | 视口 / 主题 | 说明 |
| --- | --- | --- | --- |
| `after-hub-desktop.png` | 大厅 | 1440×1000 / 深色 | 新增 2048 卡片与入口。 |
| `after-hub-mobile.png` | 大厅（手机） | 390×844（DPR 2）/ 深色 | 整页单列布局，含 2048 卡片。 |
| `after-2048-ready-desktop.png` | 2048 READY | 1440×1000 / 深色 | 棋盘、方块、HUD 与开始遮罩。 |
| `after-2048-playing-desktop.png` | 2048 游玩中 | 1440×1000 / 深色 | 合并后的分数、棋盘与侧栏。 |
| `after-2048-gameover-desktop.png` | 2048 GAME OVER | 1440×1000 / 深色 | 无路可走结算与重开入口。 |
| `after-2048-ready-mobile.png` | 2048 READY（手机） | 390×844（DPR 2）/ 深色 | 手机端棋盘与开始遮罩。 |
| `after-2048-playing-mobile.png` | 2048 游玩中（手机） | 390×844（DPR 2）/ 深色 | 手机端棋盘、HUD 与滑动提示。 |
| `after-2048-gameover-mobile.png` | 2048 GAME OVER（手机） | 390×844（DPR 2）/ 深色 | 手机端结算与重开入口。 |

### 确定性重截（playing / gameover）

- 调试接缝：生产构建在 URL 带 `debug` 参数时启用（例如 `?debug=1`），开发服务器默认启用（与 `README.md` 的说明一致）。`seed` 是有限数字时按其播种，缺省或非法（空白、`abc`、`Infinity`、`NaN`）回退 `1`。生产构建不带 `debug` 时保持原有的随机初始局面与随机生成；开发服务器即使不带 `debug` / `seed` 也会启用调试接缝并使用默认 seed `1`，因此初始局面是固定的。
- 固定参数：`seed=135`，playing / gameover 都只按一次 `ArrowLeft`。
  - playing：`MERGE_BOARD` = `2,2,4,4/8,8,16,16/.,.,.,./.,.,.,.`，合并后得分 `60`，seed 135 在 `(0,3)` 生成 `2`。
  - gameover：`STUCK_BOARD` = `2,2,16,8/8,4,2,16/4,8,16,2/16,2,4,8`，左移后只剩 `(0,3)` 空格，seed 135 生成 `2`，结算文本为 `本局 4 分 · 最大方块 16`。
- 复现命令（同一构建、预览端口空闲；Chromium 与 WebKit 分开执行并各跑两次）：
  ```sh
  npm run screenshots:2048
  npm run screenshots:2048:webkit
  sha256sum docs/screenshots/after-2048-{playing,gameover}-{desktop,mobile,webkit}.png
  ```
  两次运行的 6 个 sha256 应完全一致，且等于已提交产物。本任务只提交这 6 张 playing / gameover 图；After 守卫现在会跳过 ready 桌面 / 手机 / WebKit 历史图，只顺带写出 hub，提交前用 `git checkout --` 还原 hub，保持未受影响的已提交产物不变。WebKit 产物在官方 Playwright 容器（`mcr.microsoft.com/playwright:v1.64.1-noble`，与仓库的 Playwright 1.64.1 对应）内捕获，避免宿主 EGL / 字体环境差异。
- 等待条件：截图前等待 `document.fonts.ready`、两个 `requestAnimationFrame`（让最后的状态变更完成画布绘制），以及 gameover 的 `本局 4 分 · 最大方块 16` 结算文本；不再只依赖固定 timeout。
- 页脚：`after-2048-playing-desktop.png` / `after-2048-gameover-desktop.png` 是 `fullPage` 截图，包含当前页脚「五款游戏已上线」。这两张按本次确定性接缝重新生成，所以与 t4 时（页脚仍为「四款游戏已上线」）的历史证据不同；ready 桌面图不在本次范围，保持历史产物，其对照口径见「历史 After 证据与当前构建不一致（Issue #137）」。

### 证据限制

- main 没有 2048 页面，所以 Before 只能对比大厅（同一视口 / 主题）与真实未注册路由，不能与旧版 2048 页面逐像素对比。
- 手机端为 Playwright 设备模拟（390×844、DPR 2、触摸、大厅整页截图），不是真实设备截图。
- 截图来自生产构建；绘制行为另有 e2e 读取 canvas 像素验证，不依赖截图比对。
- After 图与当前构建的对照口径见「历史 After 证据与当前构建不一致（Issue #137）」：`after-2048-ready-desktop.png`（历史页脚）与 `after-2048-ready-mobile.png`（棋盘面板边缘 15599 个像素不同）是历史产物，逐字节比较只在同一构建、同一捕获环境下成立。

## t3：贪食蛇（PR #14）

- Before 基线：t2 已合入 main 的 `60c0206`（squash commit，树内容 = t2 分支 head `c9e8dec`）。截图在 `c9e8dec` 的干净 worktree 捕获。
- After：本 PR head（见 PR 描述中的 commit SHA）。
- 视口 / 主题：桌面 1440×1000、手机 390×844（DPR 2），深色主题，`reducedMotion: reduce`。
- 生成：`npm run screenshots:snake`（开发服务器 + 固定首果 `?food=11,10`；游玩图另固定 `seed=7&ticks=3`）。`after-snake-ready.png` / `after-snake-gameover.png` / `after-snake-mobile.png` 是 `048fe5a`（#14）历史证据，脚本默认跳过并打印守卫警告；确需重建时只能在固定容器内用 `npm run screenshots:container -- screenshots:snake --allow-historical-overwrite`，并在同一改动中同步本节捕获 commit 与 `capture-sha256-manifest.json` 条目（若收录）。未注入容器指纹时宿主直接带开关会被拒绝。
- 端口：贪食蛇截图需要 DEV-only 的固定首果接缝，因此 `npm run screenshots:snake` / `npm run screenshots:snake:webkit` 启动的是 `vite` 开发服务器（不是 `vite preview`），默认 `127.0.0.1:5188`，可用 `PREVIEW_PORT=5189 npm run screenshots:snake` 覆盖（`PREVIEW_PORT` 为空串时回退 `5188`；`--webkit` 复用同一启动路径与端口）。端口已被占用时脚本在启动前以非零状态退出，错误包含实际端口、`the port is already in use` 与 `Set PREVIEW_PORT` 建议，并明确说明占用的是开发服务器而不是 preview，不会写出或覆盖任何截图；端口探测通过后开发服务器提前退出时报告子进程退出码与 stderr，不再静默连到端口上的其它服务。
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
| `after-snake-ready.png` | 贪食蛇 READY（#14 历史证据） | 1440×1000 / 深色 | HUD、棋盘、覆盖层与 D-pad（桌面隐藏）。 |
| `after-snake-playing.png` | 贪食蛇游玩中 | 1440×1000 / 深色 | 固定首果被吃后，按固定 seed / tick 冻结的得分、长度、速度与下一颗果实。 |
| `after-snake-gameover.png` | 贪食蛇 GAME OVER（#14 历史证据） | 1440×1000 / 深色 | 撞墙结算、最高分与重开入口。 |
| `after-hub-mobile.png` | 大厅 | 390×844（DPR 2）/ 深色 | 单列布局。 |
| `after-snake-mobile.png` | 贪食蛇（手机，#14 历史证据） | 390×844（DPR 2）/ 深色 | 棋盘、D-pad 与操作面板堆叠。 |

`after-hub-desktop.png` / `after-hub-mobile.png` 是跨任务共用的文件名，当前已由 t4 / t5 / t6 更新为含 2048、打砖块与扫雷的五游戏大厅（手机为整页截图）；t3 表格里的「新增贪食蛇卡片」描述当时状态。

### 游玩截图确定性

- 调试接缝：游玩图访问 `?debug=1&food=11,10&seed=7&ticks=3`。`food` 固定第一颗果实；`seed` 只固定吃下首果后下一颗果实的 RNG；`ticks` 让场景在开始后精确推进 3 个引擎 tick（每 tick 前进一格，吃首果后 `stepMs` 为 144 ms），随后冻结运行并等待 `[data-testid="snake-game"][data-debug-ticks="3"]` 标记再截图，不再依赖 `score >= 10` 后的 120 ms 真实时间。
- 确定性状态：最终蛇头 `(13,10)`、长度 4、得分 10、速度 `1.04×`，下一颗果实在 `(4,0)`；这些值只由固定首果、seed 与 tick 数决定，同一 seed 与 tick 数在 `src/games/snake/engine.test.ts` 的 deterministic screenshot scenario 中钉住。
- 冻结方式：调试接缝只停止引擎 tick，保留 Phaser 循环重绘已冻结的 Graphics；直接 sleep 掉 WebGL 循环会让截图捕获到黑屏画布，因此不再使用 `game.loop.sleep()`。
- 复现命令（同一工作树、开发端口 5188 空闲）：
  ```sh
  npm run screenshots:snake
  npm run screenshots:snake
  sha256sum docs/screenshots/after-snake-playing.png
  ```
  两次运行生成的 `after-snake-playing.png` sha256 应完全一致并等于已提交产物。本子任务实测旧产物（Before）`fe38ad4f0f4d8d8f1fb86895159e3d9ab5dc5ceb687bdc80b9784c55446ca367`，新产物（After，两次运行相同）`b0c8e07878fe1e4573a7aaf52e2591d5759b083970a76e34fc65a12f47c4b058`。
- 提交范围：After 守卫会跳过 ready / gameover / mobile 历史图，只顺带写出 hub；提交前用 `git checkout --` 还原 hub，只保留本任务的 `after-snake-playing.png` 与文档 / 测试改动，未受影响的已提交产物保持不变。
- 页脚：`after-snake-playing.png` 是桌面整页图，重生成后带当前页脚「五款游戏已上线」；ready / gameover 桌面图与手机图仍是历史产物，页脚漂移由 #137 统一跟踪，不计入本次确定性修复。
- 历史证据：`after-snake-ready.png` / `after-snake-gameover.png` / `after-snake-mobile.png` 最后捕获于 `048fe5a`（#14）；桌面整页图除页脚外画布区域还有每通道差 1 的像素（bbox 约 x 245–876、y 218–847），手机图重跑仍有约 54596 个像素每通道差 1。它们只代表 #14 时点的 UI，不能作为当前构建「重跑必须逐字节一致」的基准；权威对照口径见「历史 After 证据与当前构建不一致（Issue #137）」。

### 证据限制

- 贪食蛇页面在 baseline 不存在：`before-framework-snake-route.png` 是 t2 访问该路由的真实「没有找到这个游戏」响应，不是 mockup；`before-framework-blank.png` 是 t2 唯一的游戏页。大厅是同一页面、同一视口的前后对比；游戏页只能做状态对比，不能与不存在的旧贪食蛇页逐像素对比。
- 手机端为 Playwright 设备模拟（Pixel 7 视口与触摸），不是真实设备截图。
- `after-snake-*` 来自开发服务器，用于固定首果、固定 seed / tick 与覆盖层状态；生产构建由 `npm run build` 与 e2e 单独验证。

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
| `after-blank-desktop.png` | 空白画布游戏（指针移动并停稳后） | 1440×1000 / 深色 | 可交互画布、HUD、操作面板与重置入口。 |
| `after-blank-mobile.png` | 空白画布游戏（触屏移动并停稳后） | 390×844（DPR 2）/ 深色 | 自适应画布、触屏操作与面板堆叠。 |

`after-hub-desktop.png` / `after-hub-mobile.png` 已由后续 t4 / t5 / t6 更新为含 2048、打砖块与扫雷的五游戏大厅；t2 表格里的「只有空白画布卡片」描述的是 t2 当时状态。

生成方式（会先构建，再用 `vite preview` 在 4174 端口启动生产预览）：

```bash
npm run screenshots
```

截图使用 `reducedMotion: 'reduce'`，避免动效造成每张图不一致。

### 空白画布截图确定性（plan-135 子任务 3）

- 旧问题：点击后只 `waitForTimeout(700)`，orb 以 `POINTER_SPEED = 820` 朝目标移动，落点与 trail 残影取决于这 700 ms 内跑了多少帧；同一构建、端口 4174 空闲时连续两次执行 `npm run screenshots`，`after-blank-desktop.png` / `after-blank-mobile.png` 的 sha256 都会变化。
- 等待条件：点击 / 轻触后不再固定等待，改为每 100 ms 读取 `[data-testid="readout"]` 的 `data-x` / `data-y` / `data-trail`（`trail` 是场景实际 trail 数组长度，由 `src/games/blank/view.ts` 写入），直到连续 5 个采样都落在点击目标 ±2 CSS px 且 `data-trail="0"` 才截图；15 s 内不满足则报错并带最后一次读数，不会静默写出中间帧。
- 固定参数：桌面在 canvas 的 (0.66, 0.40) 处点击；手机与 WebKit 在 (0.36, 0.62) 处轻触；`colorScheme: dark`、`reducedMotion: reduce`。桌面 1440×1000（DPR 1，视口截图，不是整页图、不含页脚），手机 390×844（DPR 2），WebKit 375×667（DPR 2）。
- 确定性条件：`reducedMotion: reduce` 下目标圆环不脉冲、orb 缩放固定为 1；orb 到达目标后场景把 `target` 置空并精确落到点击点，trail 按 1.15 s 生命衰减并从数组移除。等 `data-trail="0"` 后画面只剩固定 backdrop / 网格 / 静态 orb，不再随时间变化，因此同一构建的截图逐字节一致；正常交互没有变化，也不需要新增调试接缝。
- 复现（同一构建、预览端口 4174 空闲；Chromium 与 WebKit 各跑两次）：

  ```sh
  npm run screenshots
  npm run screenshots:webkit
  sha256sum docs/screenshots/after-blank-{desktop,mobile,webkit}.png
  ```

  两次运行的 3 个 sha256 应完全一致，并等于已提交产物：`after-blank-desktop.png` `24c34e278b7272834077ea6696cc0b5087d87dfb20323ec796ba97c719f3fb47`、`after-blank-mobile.png` `a097836e00acfe0c9965ecde6e72b7f40b366e4bdd82b1d6af705bcbefa685ff`、`after-blank-webkit.png` `cd4ed3fea1e0a068661c8102ee0b58b0601b3a249e480d76224d22782a0e088f`。WebKit 产物在官方 Playwright 容器（`mcr.microsoft.com/playwright:v1.64.1-noble`，与仓库的 Playwright 1.64.1 对应）内捕获，避免宿主 EGL / 字体环境差异（本机直接运行会因 `Could not create surfaceless EGL display` 失败）。
- Before / After：旧产物 sha256 分别为 `0aa5b5d35c5c4894423f8a37fb97bddf0731206a1435a786ae3a4be01a14f0c6`、`155681ac86f01f8d7b728e2e0569b30a9fbc519565744087f7524dc54b1fb5d3`、`5274dcadc087a17f0e03e243edc4be83ab2f743d8a908e9d64943ced384230b8`；本轮 3 张图都按上述等待重新生成。旧 desktop / mobile 产物来自 t2 时期，后续任务改过页面文案与布局，因此新旧图的差异不只在 orb / trail 位置；本子任务只对当前 head 的逐字节可复现性负责，不把旧图当作像素级回归基准。`after-blank-desktop.png` 是 1440×1000 视口截图（`fullPage: false`），不是整页图，不包含页脚；脚本仍会写出 hub 图，提交前用 `git checkout -- docs/screenshots/after-hub-*.png` 还原，保持未受影响的已提交产物不变。
- 回归护栏：`tests/unit/capture-blank-determinism.test.ts` 用 fake page 运行时覆盖 `scripts/lib/blank-settle.mjs` 的 `waitForBlankSettled`（未连续 N 次落点且 `trail` 未清零就不返回、移动会重置连续计数、超时带最后读数报错）与 `nextBlankStableStreak`，并静态钉住 `capture-screenshots.mjs` 的 `tapBlankCanvas` 内确实 `await waitForBlankSettled(page, target)`、3 个场景都走同一等待、脚本不再含 `waitForTimeout(700)`、`view.ts` 暴露 `data-trail`。删除该等待会让单测失败。

### 证据限制

- 起点没有应用 UI，所以 Before 只能是 base commit 的仓库页，无法提供“同一应用场景”的旧版截图；Before / After 的页面内容不同，不能逐像素比较。
- 手机端为 Playwright 设备模拟（Pixel 7 视口与触摸），不是真实设备截图。
