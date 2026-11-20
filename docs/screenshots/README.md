# 截图来源

这些截图用于各期交付的 Before / After 视觉证据。全部由 Playwright 的 Chromium 或 WebKit 真实渲染（各节注明引擎），不是 mockup。

引擎标注：文件名 `-desktop` 为 Chromium 1440×1000；`-mobile` 为 Chromium 手机截图（扫雷玩法 `-mobile` 为 Pixel 7 412×839 / DPR 2.625，对应独立的 `mobile-touch` 捕获目标；扫雷成绩为 320×640 / DPR 2；其余手机图多为自定义 390×844 / DPR 2，大厅为全页长图）；`-webkit` / `-webkit-narrow-*` 为 WebKit `iPhone SE (3rd gen)` 设备模拟。WebKit 手机截图的命令、设备参数与引擎 / 视口 / 主题记录见「webkit-phone」与「webkit-narrow」两节；Chromium 的既有命令与文件名保持不变。

## 固定捕获环境（Issue #199）

- 目的：把浏览器构建、字体、DPR 与 EGL / 软件渲染固定到同一环境，让截图捕获可复现；宿主上的普通 `npm run screenshots:*` 命令对未收录文件保持不变，只多打印一行环境指纹，不会因为缺少字体 / EGL 探测而失败；清单收录的文件在宿主重跑会在写出任何字节前被拒绝，必须用 `npm run screenshots:container -- <target>` 重拍。
- 镜像 tag / digest：`mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f`。tag 的版本来自 `package-lock.json` 的 `@playwright/test`（当前 1.64.1），digest 固定的是多架构 manifest list——同一个 digest 在 amd64 与 arm64 主机会解析到不同浏览器构建；实际运行平台由 `linux/amd64` 固定，见下一条。契约常量在 `scripts/lib/capture-env.mjs` 的 `PLAYWRIGHT_IMAGE_PIN`。CI 与截图共用同一个 pin：`.github/workflows/ci.yml` 的 `verify` job 与 `.github/workflows/flake-watch.yml` 的 `guarded-first-run` job 的 `container.image` 必须与 `PLAYWRIGHT_IMAGE_PIN`、`docker/capture/Dockerfile` 的 `FROM` 完全一致；`tests/unit/ci-workflow.test.ts`、`tests/unit/flake-watch-workflow.test.ts`、`tests/unit/capture-env.test.ts` 与 `tests/unit/flaky-policy-docs.test.ts` 会分别校验镜像、常量与文档，任一处漂移都会让单测失败。
- 平台固定与 arm64 主机：宿主入口对 `docker build --platform linux/amd64` 与 `docker run --platform linux/amd64` 都显式传平台，并在构建或复用本地镜像后用 `docker image inspect --format '{{.Os}}/{{.Architecture}}'` 断言实际镜像平台恰为 `linux/amd64`；宿主入口还通过 `docker run --env CAPTURE_PLATFORM=linux/amd64` 注入平台，容器入口的 `assertContainerCaptureEnvironment` 在运行任何捕获、写出任何 PNG 之前校验该变量。这样固定的不只是一个多架构 digest，还包括该 digest 实际解析出的架构。arm64 主机（例如 Apple Silicon）必须让 Docker 以 amd64 模拟运行（Docker Desktop 的 amd64 模拟或等效的 binfmt / qemu）；宿主机无法提供 amd64 镜像时，入口在构建 / inspect 阶段以可读错误拒绝（非 0 退出）：构建失败或无法 inspect 时列出期望平台、镜像 digest 与重拍命令，inspect 成功但平台不符时再列出实际平台；绝不会静默改用 arm64 浏览器写出不同 PNG。失败示例：`Capture image playground-capture:v1.64.1-noble is platform "linux/arm64", but the fixed capture platform is "linux/amd64" (image digest sha256:...)`；容器内校验到平台不符时是 `Capture environment variable "CAPTURE_PLATFORM" is "linux/arm64": expected "linux/amd64".`
- 升级清单（Playwright 版本 bump 时逐项完成）：
  1. 更新 `package-lock.json` 的 `@playwright/test` 并安装依赖；新版本必须存在对应的官方 Playwright 镜像 tag。
  2. 更新 `scripts/lib/capture-env.mjs` 的 `PLAYWRIGHT_IMAGE_PIN`（version / tag / digest）；digest 仍是多架构 manifest list，实际运行平台继续由 `CAPTURE_PLATFORM=linux/amd64`、`docker build` / `docker run` 的 `--platform linux/amd64` 与镜像 `Os` / `Architecture` 断言固定，不要只改 digest 就假设平台不变。
  3. 更新 `docker/capture/Dockerfile` 的 `FROM`。
  4. 更新两个 workflow 的 `container.image`：`ci.yml` 的 `verify` 与 `flake-watch.yml` 的 `guarded-first-run`，两处必须使用同一个 reference。
  5. 同步文档：本节、`docs/screenshots/capture-sha256-manifest.json` 的 `environment.platform` / 镜像字段、`docs/ci-flaky-policy.md` 第 5 节与 `README.md` 的 CI / WebKit 说明；环境指纹示例与清单平台必须保持 `linux/amd64`。
  6. 运行 `npm run test:unit`、`npm run verify:doc-counts`、`npm run verify:screenshots:doc-dims` 与 `npm run verify:screenshots:sha256`；在容器内重跑受影响的截图，确认 PNG 尺寸与 sha256 仍与文档记录一致（像素差异按「webkit-phone」的既有口径评估）。镜像 pin / 环境指纹变化时，按下方「已提交证据 sha256 清单与校验」显式重拍并同步 `docs/screenshots/capture-sha256-manifest.json` 的 `environment`、`provenance` 与 `sha256`，否则校验器会以退出码 2 指出固定契约不一致；若校验器以 `Platform mismatch` 退出 1，先修运行平台再重拍，不要改写 `environment.platform` 或 sha256 掩盖。
  7. 未来支持 arm64 时按平台拆分证据：为每个平台分别维护清单与文档（独立 `environment.platform`、独立 `capture-sha256-manifest-<os>-<arch>.json` 或等价命名、独立表格与重拍命令），amd64 与 arm64 不共用一份 sha256；同一个多架构 digest 在不同架构解析到不同浏览器构建，混用清单会把平台差异伪装成哈希漂移。拆分后给 `verify:screenshots:sha256` 传对应 `--manifest`，并让校验器按该清单的 `environment.platform`（或新增显式 `--platform`）校验、为每个清单各跑一次；当前校验器仍以 `CAPTURE_PLATFORM=linux/amd64` 为唯一合法平台，因此 arm64 支持还必须同步扩展校验器与测试，不能只新增一个清单文件。
  8. 重新取得一次无缓存与一次有缓存的 `verify` run，并重新触发 `flake-watch` 验收，把新的 run 链接与耗时写回本节。
- 容器镜像：`docker/capture/Dockerfile` 以上述 digest 为基础，只校验官方镜像自带的 `libegl1` / `libegl-mesa0` / `libgl1` / `libgl1-mesa-dri` / `libglx-mesa0` 与 EGL vendor 文件，不安装任何额外系统包；构建失败会指出缺失的包名。
- 本地镜像复用：`ensureCaptureImage` 先把 `PLAYWRIGHT_IMAGE_PIN` 的 tag / digest 与 `docker/capture/Dockerfile` 全文哈希成构建输入指纹，构建时写入 Docker 标签 `playground.capture.build-input`；每次运行用 `docker image inspect --format` 读取该标签，只有镜像存在且标签与当前指纹一致时才跳过 `docker build`。标签缺失（旧镜像）或 tag / digest / Dockerfile 任一变化都会使指纹失效：Dockerfile 的非 `FROM` 内容变化会重建，pin 与 `FROM` 一起更新时也会重建；若只改 Dockerfile 的运行阶段 `FROM`（最后一个）而不同步 pin，则直接以包含期望 reference 与实际 FROM 的可读错误失败，避免复用旧基础镜像却继续打印新 digest。
- 本地镜像重建：本地镜像 `playground-capture:<tag>` 按构建输入指纹打标签——`PLAYWRIGHT_IMAGE_PIN` 的 tag / digest 加上 `docker/capture/Dockerfile` 全文，一起做 sha256 后写入 Docker 标签 `playground.capture.build-input`。输入不变时重复运行直接跳过 `docker build`；pin 或 Dockerfile 任一变化时自动重建，不需要手动删除镜像。本次修复前构建的旧镜像没有该标签，第一次运行会因缺少标签判定指纹不一致并重建一次，无需手动 `docker rmi`。构建或复用前会先校验 Dockerfile 运行阶段的 `FROM` 与 pin 一致，不一致时直接报包含期望 reference 与实际 FROM 的错误，因此容器日志中的 `CAPTURE_IMAGE_DIGEST` 始终与实际基础镜像一致。
- 字体：保留官方镜像自带字体，不额外引入会改变光栅的字体；固定清单为 `fonts-freefont-ttf`、`fonts-ipafont-gothic`、`fonts-liberation`、`fonts-noto-color-emoji`、`fonts-tlwg-loma-otf`、`fonts-unifont`、`fonts-wqy-zenhei`。字体版本由容器内 `dpkg-query` 实测记录，不预置未知版本；记录与实际不一致时按环境差异处理，而不是静默重拍。
- EGL / 软件渲染变量：`EGL_PLATFORM=surfaceless`、`LIBGL_ALWAYS_SOFTWARE=1`、`__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json`。缺少 WebKit 会报 `Could not create surfaceless EGL display`；容器入口会校验这三个变量，缺失或值不符时指出变量名与期望值。
- 按捕获目标的 DPR（不做全局常量）：

| 捕获目标 | DPR | 说明 |
| --- | --- | --- |
| `desktop` | 1 | Chromium 桌面视口截图 |
| `mobile` | 2 | Chromium DPR 2 手机截图（390×844 大厅、320×640 扫雷成绩，以及窄屏 / 短屏 / 大棋盘模式） |
| `mobile-touch` | 2.625 | Chromium Pixel 7 触屏截图（412×839 扫雷 ready / playing / lost / won 的 before 与 after） |
| `webkit` | 2 | WebKit `iPhone SE (3rd gen)` 设备模拟与窄屏矩阵 |

- 环境指纹：`captureEnvironmentFingerprint({ target, run })` 按固定字段顺序输出 `source`（`host` / `container`）、`target`、`dpr`、`platform`（容器固定 `linux/amd64`，由入口注入的 `CAPTURE_PLATFORM` 决定并在捕获前断言；宿主为 `unavailable`）、`image`、`node`、`playwright`、`browser`（捕获运行时传入 `browser.version()`；直接调用且未提供时为 `null`）、`fonts`、`env`。容器内记录镜像 tag / digest、平台、Node 与 Playwright 版本、字体包版本、三个 EGL 变量与目标 DPR；宿主上标 `source=host`，`platform` / `image` / `fonts` / `env` 记为 `unavailable`，不抛错。
  指纹按**捕获上下文**记录：每类捕获目标第一次创建上下文时打印一行，同一目标每次运行只打印一行。扫雷 After 的 Chromium 运行会同时创建桌面与 Pixel 7 触屏上下文，因此分别输出 `target=desktop dpr=1` 与 `target=mobile-touch dpr=2.625`；大厅证据只由 `npm run screenshots:container -- screenshots`（`scripts/capture-screenshots.mjs`）生成（不再由各游戏脚本顺带写出）；其他 Chromium 截图脚本（`screenshots`、`:snake`、`:2048`、`:breakout`、`:minesweeper:scores` 等，窄屏模式只创建手机上下文）只输出 `target=desktop dpr=1` / `target=mobile dpr=2`，不会出现 `mobile-touch` 行；WebKit 运行输出 `target=webkit dpr=2`。每个目标一行，不会把 DPR 2 的手机图或 DPR 2.625 的触屏图记成桌面。容器内日志示例如下（这里只展开扫雷 After 的 `mobile-touch` 一行，`desktop` / `mobile` / `webkit` 行的字段相同）：
  ```text
  capture-env: source=container target=mobile-touch dpr=2.625 platform=linux/amd64 image=mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f node=v26.13.0 playwright=1.64.1 browser=156.0.8078.4 fonts=fonts-freefont-ttf@20211204+svn4273-2,fonts-ipafont-gothic@00303-21ubuntu1,fonts-liberation@1:2.1.5-3,fonts-noto-color-emoji@2.047-0ubuntu0.24.04.1,fonts-tlwg-loma-otf@1:0.7.3-1,fonts-unifont@1:15.1.01-1build1,fonts-wqy-zenhei@0.9.45-8 env=EGL_PLATFORM=surfaceless,LIBGL_ALWAYS_SOFTWARE=1,__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json
  ```
  示例中的 `platform=linux/amd64` 不是展示性文字：它来自入口注入的 `CAPTURE_PLATFORM`，必须与 `docs/screenshots/capture-sha256-manifest.json` 的 `environment.platform` 及 `scripts/lib/capture-env.mjs` 的 `CAPTURE_PLATFORM` 一致；`tests/unit/screenshot-platform-docs.test.ts` 会用 `parseCaptureEnvironmentFingerprintLine` 解析该示例并比对。
  宿主上同一行是 `source=host ... platform=unavailable ... image=unavailable ... fonts=unavailable env=unavailable`。
- 容器命令：`npm run screenshots:container -- <target> [passthrough...]`，其中 `<target>` 是现有的截图 npm script（例如 `screenshots:webkit`、`screenshots`、`screenshots:snake`）；透传参数直接跟在 target 后，例如 `npm run screenshots:container -- screenshots:snake --allow-historical-overwrite`（`screenshots:snake` 会读取该开关；`screenshots:webkit` 不支持它，会静默忽略）。历史 After 图的覆盖开关只在固定容器内生效：未注入容器指纹时宿主直接带 `--allow-historical-overwrite` 会被共享守卫拒绝并给出可读错误，必须通过本命令重拍。入口会预检 Docker CLI / daemon、镜像 tag 与锁文件版本和 target 白名单；该 target 的预览端口只在 `BASE_URL` 未设置或为空串、容器内会自行启动 preview 时才预检，默认值来自目标脚本声明的 `previewPort`（宿主预检与容器注入共用这一份声明，入口不再维护按 target 名手写端口表）；设置 `PREVIEW_PORT` 会覆盖运行时端口但不改变脚本声明，显式设置 `BASE_URL`（外部 preview 模式）时跳过宿主预览端口探测，避免共享宿主上无关进程占用 4183 / 4185 等默认端口导致 before 捕获被误拒。再挂载仓库、按需在容器内 `npm ci`、构建并执行原截图命令。捕获目标不再由入口按脚本名或透传 flag 的手写映射推导，而是执行目标脚本的声明：入口从 `package.json` 的 target 命令取出 `node` 脚本路径与脚本自带参数（例如 `screenshots:minesweeper:webkit-before` 自带 `--webkit --touch-before`），拼上容器透传参数后直接运行 `<script> <脚本自带参数...> <透传参数...> --print-capture-targets`（`--print-capture-targets` 只打印声明，不启动 preview 或浏览器；不执行 `npm run build`），以脚本打印的一行 JSON（`script` + `targets` + `previewPort`）为唯一来源，其中 `previewPort` 是脚本自身的默认预览端口、`PREVIEW_PORT` 只覆盖运行时端口而不改变声明，宿主预检与容器注入的 `PREVIEW_PORT` 都以该声明为默认值，校验目标白名单与固定 DPR 后注入 `CAPTURE_TARGET` / `CAPTURE_TARGET_DPR`；例如 `screenshots:minesweeper` 的声明注入 `desktop,mobile-touch` / `1,2.625`，`screenshots:minesweeper:touch-before` 注入 `mobile-touch` / `2.625`，WebKit 目标注入 `webkit` / `2`。`--webkit` / `--touch-before` / 窄屏家族等透传参数会原样传给脚本，因此脚本声明会按实际分支给出目标，入口不再单独维护这些 flag 的规则；`--before` / `--clear` / `--allow-historical-overwrite` 不改变目标。无声明、退出码非 0、JSON 或目标非法时入口给出可读错误。容器内重新解析同一份声明并校验注入值；捕获运行时断言实际记录必须与声明一致，多记或漏记都会以包含实际 target 与声明来源的可读错误失败；运行时再按实际创建的上下文逐目标打印指纹。产物经挂载写回宿主 `docs/screenshots/`，日志写到 `test-results/capture-container/<target>-<timestamp>.log`（已被 `.gitignore` 忽略）。捕获只依赖容器内浏览器，宿主不需要安装 Playwright 浏览器。
- 验收口径：2026-11-12 在临时工作副本中以 `npm run screenshots:container -- screenshots:webkit` 连跑两次，`after-blank-webkit.png` 的 sha256 两次相同且等于已提交的 `cd4ed3fea1e0a068661c8102ee0b58b0601b3a249e480d76224d22782a0e088f`；Issue #326 后来证明这两跑不足以排除间歇漂移：同一固定容器内未加接缝的 15 跑中 3 跑写出 `5569689d97ee9dadf8725dd5e8d043acf758ce92d56731f0f4d1ea53c4b9be95`。空白 WebKit 采集路径现已在场景 settle 之后、截图之前增加共享 header 合成落定接缝（通用模块 `scripts/lib/webkit-compositing-settle.mjs` 的 `settleSharedHeaderCompositing`，blank 路径经 `blank-settle.mjs` 的 `settleBlankHeader` 复用同一实现，只切换 `backdrop-filter` 后恢复样式表值）；2026-11-19 在固定容器内连续 16 跑（宿主并发负载，load average 峰值约 30）sha256 全部为 `cd4ed3fe…`，该批 `after-hub-webkit.png` 全部为 `6c2856e3…`；每跑写后 `sha256sum` 与写前护栏共同证明字节，`node scripts/verify-screenshot-sha256.mjs --log <log>` 也均退出 0。这 16 跑早于 #329 的修复：当时的 `--log` 还不读取日志内的 captured sha256，因此它们的字节相等仍由每跑写后 `sha256sum` 与写前护栏证明，而不是由现在的日志哈希校验补证（详见「空白画布截图确定性」）。当时顺带写出的 `after-hub-webkit.png` 不在最初子任务验收范围内，后续 Issue #318 t3 已在同一容器内复核并收录清单；hub 路径的并发负载漂移由 Issue #341 t2 在截图前接入同一接缝修复（见「大厅复核」）。容器内日志中的指纹与本节记录的镜像 tag / digest、EGL 变量与 DPR 一致。
- 容器路径下的 e2e 与截图尺寸 / 渲染一致性：CI 的 `verify` 在同一镜像内跑完 e2e、flake gate、截图尺寸校验与 WebKit 窄屏重拍。[run 43563009824](https://github.com/yeahdongcn-mk2/playground/actions/runs/43563009824) 的冷缓存 attempt 1（verify 4m22s、e2e 3m09s）与有缓存 [attempt 2](https://github.com/yeahdongcn-mk2/playground/actions/runs/43563009824/attempts/2)（verify 4m18s、e2e 3m11s）全部步骤成功，`End-to-end tests`、`Check target e2e flakes`、`Screenshot doc dimensions`、`WebKit narrow screenshot smoke test` 均通过，日志没有 `playwright install`、`--with-deps` 或 apt GET。结论：容器路径没有改变 e2e 结果；已提交截图的文档尺寸仍与 PNG 逐项一致（24 行 / 24 文件），容器内重拍的 4 张 WebKit 窄屏图保持 DPR 2 尺寸（640×1280、720×1280、750×1334、824×1678）。渲染一致性按本节与「webkit-phone」的既有口径：同一容器内的确定性截图可逐字节一致，历史 After 图只与相同构建 / 捕获环境比较；容器缩小跨环境字体与 EGL 差异，但不能保证重跑结果等于已提交 PNG。

### 已提交证据 sha256 清单与校验（Issue #199）

- 清单文件：`docs/screenshots/capture-sha256-manifest.json`。它只收录文档已注明由官方 Playwright 容器捕获、且 sha256 等于已提交产物的 WebKit 确定性证据；不纳入 #137 标记的历史 After 证据，也不纳入宿主捕获的桌面 / 手机变体。扩大覆盖时，可复现证据按固定容器重拍并在同一改动中显式更新清单；只有历史证据才需要额外走 #137 的显式刷新口径。
- 清单覆盖（14 张，`sha256` 是已提交 PNG 的字节指纹；捕获 commit 是产生当前字节的构建提交，PNG 与清单可能在该提交之后的证据提交中入库）：

| 文件 | sha256 | 固定容器内重拍命令 | 捕获 commit |
| --- | --- | --- | --- |
| `after-blank-webkit.png` | `cd4ed3fea1e0a068661c8102ee0b58b0601b3a249e480d76224d22782a0e088f` | `npm run screenshots:container -- screenshots:webkit` | `f5b87c05b3c55694c3605530de4bcf8e20097a80`（#162） |
| `after-hub-webkit.png` | `6c2856e33a5619dc2eff5833c059608c74f03492192029515edf345b165581f4` | `npm run screenshots:container -- screenshots:webkit` | `c6a8c6c0b6cb70aac968f12d834d00f1073ade61`（#318 t3） |
| `after-snake-webkit.png` | `d8e262f366b11436d5a1dc309f01ee86a473b23f74684fd92e03392fc28450ba` | `npm run screenshots:container -- screenshots:snake:webkit` | `c6a8c6c0b6cb70aac968f12d834d00f1073ade61`（#318 t3） |
| `after-2048-playing-webkit.png` | `4173dce84c814f2573fa506360f95bab477c985b37a2dfe2d5b0d1c2c5992a91` | `npm run screenshots:container -- screenshots:2048:webkit` | `8dbe3e7e40e1a17ac84f5b715ce6383cbf039187`（#145） |
| `after-2048-gameover-webkit.png` | `bf7548b7c7fc696b89e9d1ed00c48f0d1bdb2274575c278240e6c801630ba837` | `npm run screenshots:container -- screenshots:2048:webkit` | `8dbe3e7e40e1a17ac84f5b715ce6383cbf039187`（#145） |
| `after-breakout-playing-webkit.png` | `27297f5f79792511e1d2a56cc1a1c5565922ba10e7fda3de798c663769147704` | `npm run screenshots:container -- screenshots:breakout:webkit` | `bc7759432d66034141261a483a50454ee0631235`（#159） |
| `after-breakout-ready-webkit.png` | `372a320ab27d94e2881484047adb358ef222391c00c1c4bfb6a636ab6f3e5f65` | `npm run screenshots:container -- screenshots:breakout:webkit` | `d3f0f30437b69022f29f6c7677f117f84ffc09f1`（#318 t4） |
| `after-breakout-levelclear-webkit.png` | `c1edf10ec9b483db6a022fa26998438286220d88d0be614a0ead09fe046ddf2d` | `npm run screenshots:container -- screenshots:breakout:webkit` | `d3f0f30437b69022f29f6c7677f117f84ffc09f1`（#318 t4） |
| `after-breakout-gameover-webkit.png` | `ea78b118f6a50374e2949affae4fca410eeedf057c4e316afad0cd1eae7b8d13` | `npm run screenshots:container -- screenshots:breakout:webkit` | `d3f0f30437b69022f29f6c7677f117f84ffc09f1`（#318 t4） |
| `after-minesweeper-ready-webkit.png` | `56c3f68d51c643d9e23a3e5a17d99b44b9da47c52d0cca451080ec3dc878fe0a` | `npm run screenshots:container -- screenshots:minesweeper:webkit` | `5115db16d93a75636de679102a65f83e50c4cf6b`（#318 t1 返工） |
| `after-minesweeper-playing-webkit.png` | `b64d959f12a3b8a08a0757d8cf1ae4875a21a3d96a6df8a28c4a81ca9290d9fb` | `npm run screenshots:container -- screenshots:minesweeper:webkit` | `5115db16d93a75636de679102a65f83e50c4cf6b`（#318 t1 返工） |
| `after-minesweeper-lost-webkit.png` | `6b888d338c7cea61d82578e3ce7e75e5b29620f3fdfc7f25a848a84fea12f3b4` | `npm run screenshots:container -- screenshots:minesweeper:webkit` | `5115db16d93a75636de679102a65f83e50c4cf6b`（#318 t1 返工） |
| `after-minesweeper-won-webkit.png` | `77e7b244607dbdec71ff31df1a991a6744d813fa800c254eb1ebbaf8567f12a2` | `npm run screenshots:container -- screenshots:minesweeper:webkit` | `5115db16d93a75636de679102a65f83e50c4cf6b`（#318 t1 返工） |
| `after-minesweeper-scores-webkit.png` | `012a7bf09d4f8d8c3b8a38ff34f362def21a2dc2c3a076f5be027d3cdc89fb12` | `npm run screenshots:container -- screenshots:minesweeper:scores:webkit` | `2cc6f87d3bcc5fba0e7db5b02df7e5a73dce1f40`（#318 t2 / #341 t3） |

- 有意不收录音像：`after-2048-ready-webkit.png` 自 Issue #374 起不在上表 / 清单内。它在并发负载下会稳定落在 `672285de…`（仅页眉 1833 px）、`d8a808b0…`（10728 px：页眉 1833 px + READY 卡片 / 背板 8895 px）等 1-LSB 变体；fresh page 重采样、重启 browser 进程与更长的 settle 等待都不能可靠回到已提交的 `0ea38c8d…`（证据见「2048 ready 的负载相关栅格与清单外口径」）。该 PNG 仍是当前 UI 的视觉证据，捕获时保留预热页、两条接缝与 `{ stable: true }` 两帧门禁；写盘前用同一 `webkit` 环境的已收录 `after-2048-playing-webkit.png` 条目做环境护栏，所以宿主命令会在写 ready 前因环境校验失败而中止（清单 / playing 条目缺失时 `requireRecorded` 也会直接失败），但它不参与 `verify:screenshots:sha256` / `verify:screenshots:repro` 的逐字节验收。
- 清单顶层 `environment` 记录整份清单共用的固定环境指纹：平台 `linux/amd64`（`environment.platform`，必须与 `scripts/lib/capture-env.mjs` 的 `CAPTURE_PLATFORM` 一致；字段只接受 `<os>/<arch>` 或带 variant 的 `<os>/<arch>/<variant>`，`unavailable` 不是合法清单平台），镜像 `mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f`，`EGL_PLATFORM=surfaceless`、`LIBGL_ALWAYS_SOFTWARE=1`、`__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json`，目标 `webkit` / DPR 2，字体版本与上文容器日志记录一致（`fonts-freefont-ttf@20211204+svn4273-2`、`fonts-ipafont-gothic@00303-21ubuntu1`、`fonts-liberation@1:2.1.5-3`、`fonts-noto-color-emoji@2.047-0ubuntu0.24.04.1`、`fonts-tlwg-loma-otf@1:0.7.3-1`、`fonts-unifont@1:15.1.01-1build1`、`fonts-wqy-zenhei@0.9.45-8`）；每条 capture 记录还带 `provenance.container`（镜像 tag / digest）与捕获 commit。
- 写前护栏（Issue #199 t2）：`scripts/lib/capture-runtime.mjs` 的 `captureScreenshot` 在写出任何字节之前读取本清单。目标文件被收录时，它用产生该截图的上下文目标（`desktop` / `mobile` / `mobile-touch` / `webkit`）构造 `captureEnvironmentFingerprint()`，并与清单 `environment` 的 `source`、`target`、`dpr`、`platform`、镜像 repository / tag / digest、三个 EGL 变量与字体包版本逐项比较。宿主（`source=host`）或任一字段不一致时以非零状态失败，stderr 列出文件名、期望 / 实际环境指纹、差异项与固定容器重拍命令，目标 PNG 不会被创建或替换；固定容器内指纹一致时先把截图写入内存，再用同目录临时文件 + rename 原子写入。写入后若新 PNG 的 sha256 与清单不同，捕获本身仍成功，但会打印必须同步清单 `sha256` / `provenance.captureCommit`、本文档表格与 provenance 的 checklist，并且不会改写清单，因此 `npm run verify:screenshots:sha256` 会继续以退出码 1 报告该文件的哈希不一致，直到在同一改动里显式更新清单与文档。未收录文件在既未设 `stable: true`、`stableFrames` 也为 1 时仍走原来的 `page.screenshot({ path })` 写入路径；显式传 `stable: true`（未重采样的单页稳定捕获，settle 后连续两帧）、`stableFrames > 1`（间隔式整幅稳定帧）或 `capturedBytes` 时同样走连续帧检查 / 调用方稳定字节 + 原子写入。扫雷 ready 在 `captureManifestedScreenshot` 的采样里通过导出的 `captureStableFramesBytes` 复用该门禁（Issue #341 t4）；2048 ready 已移出清单（Issue #374），仍以 `{ stable: true }` 走同一 settle 式连续两帧门禁并原子写入，写前用已收录的 `after-2048-playing-webkit.png` 条目校验同一 `webkit` 环境。清单缺失（例如裁剪过的检出）时按「未收录」处理；清单存在但无法解析时在写截图前以可读错误失败，避免在无法判断收录关系时静默写证据。
- 平台与清单一一对应：`environment.platform` 是整份清单的权威平台，校验器不会从 PNG 反推平台，一份清单只描述一个平台。未来支持 arm64 时必须另建独立清单（例如 `capture-sha256-manifest-linux-arm64.json`）以及独立 README 表格 / 重拍命令，amd64 与 arm64 的 sha256 不得写进同一份清单或互相替代——同一个多架构 digest 在不同架构解析到不同浏览器构建，混用会把平台差异伪装成哈希漂移。用 `--manifest` 指向对应清单的同时，还要让校验器按该清单的 `environment.platform`（或显式 `--platform`）校验；当前实现仍只接受 `linux/amd64`，所以 arm64 支持必须同步扩展校验器与测试，不能只新增一个清单文件。
- 命令与退出码：`npm run verify:screenshots:sha256`（即 `node scripts/verify-screenshot-sha256.mjs`）读取清单，逐个校验文件存在且 PNG sha256 与期望一致；传入 `--log <捕获日志>` 时再校验日志中的 `capture-env:` 指纹，并读取捕获器在 sha256 漂移时打印的 `Wrote <path>` checklist：每条记录按 `Wrote <path>` 的 basename 与清单 `captures[].file` 关联，`captured sha256` 必须等于当前清单的 `sha256`。日志里的 `manifest sha256` 只是捕获时的基线，允许与当前清单不同（表示清单后来已按那次捕获更新）；记录里的文件不在当前清单按日志哈希失败处理，并提示按写出该文件的脚本重拍并补清单条目，不猜测固定容器目标。没有 drift checklist / 没有 captured sha256 的旧日志保持原行为，不额外校验，`--log` 仍只做 PNG 与 `capture-env:` 校验。全部一致退出 0；哈希不一致、环境指纹不一致、平台不一致或日志 captured sha256 不一致退出 1，并把「日志 captured sha256 不一致」单独成段（以 `FAIL: <n> capture-log captured sha256 problem(s):` 开头，对清单内文件列出文件名、expected / captured sha256 与固定容器内重拍命令），不与磁盘哈希或环境指纹失败混在一起；只有日志 captured sha256 失败时不会打印 `committed PNG hashes still match the manifest` 这种总结。平台差异单独成段（`Platform mismatch`）：清单 `environment.platform` 或日志指纹平台与固定 `linux/amd64` 不一致时（例如期望 `linux/amd64`、实际 `linux/arm64`），列出期望 / 实际平台、镜像 tag / digest 与逐文件固定容器重拍命令；单独出现时退出 1，即使所有 PNG 的 sha256 仍与清单一致也按平台差异失败。退出码优先级：清单若同时还有其它固定契约不一致（镜像 tag / digest、EGL、DPR 或重拍命令），校验器仍以清单非法退出 2，并在同一输出中打印平台段；只有平台一项不一致时才用 1。清单非法（含重复文件、sha256 不是 64 位 hex、缺少 / 非法 `environment.platform`，或 `environment` 的其它字段 / `provenance.container` / 重拍命令与固定契约不一致）或捕获日志中的 `capture-env:` 行格式非法（缺字段、重复 / 未知字段、非规范十进制 DPR 如 `2.0` / `+2`），或 sha256 drift 记录格式非法（块头存在但 `manifest sha256` / `captured sha256` 缺失、重复或不是 64 位小写 hex）时退出 2。运行时写出的 `capture-env: unavailable (...)` 回退行按环境不可用处理（退出 1），不算非法日志。缺少已提交 PNG 按哈希失败处理（退出 1），因为它同样说明证据与清单不一致。
- 本地带日志复核示例：`npm run verify:screenshots:sha256 -- --log test-results/capture-container/screenshots-webkit-<timestamp>.log`。
- CI：`.github/workflows/ci.yml` 的 `verify` job 在 `Screenshot doc dimensions` 之后、`Production build` 之前运行 `Screenshot evidence sha256 manifest` 步骤（`npm run verify:screenshots:sha256`，不带日志），干净检出即校验已提交证据，防止静默替换；`tests/unit/ci-workflow.test.ts` 钉住该步骤的命令与位置。
- 刷新流程（固定容器重拍后显式更新清单，不静默改写）：在临时工作副本（不要在准备提交的 worktree 里直接覆盖已提交 PNG）用上表的固定容器命令重拍所需目标，连续两次运行并对每份日志分别执行带 `--log` 的校验；只有两次 sha256 相同且环境指纹一致时，才在同一改动里显式更新清单的 `sha256` / `provenance` 与本节表格，并说明重拍原因。固定容器内指纹一致但新哈希与清单不同时，写前护栏会直接打印清单 / 文档同步 checklist：先按 checklist 更新 `captures[].sha256`、`captures[].provenance.captureCommit` 与本节表格，再重跑 `npm run verify:screenshots:sha256`，不要把清单留在旧哈希上。若目标属于 #137 标记的历史 After 证据，替换已提交 PNG 还必须走 #137 的显式刷新口径（`--allow-historical-overwrite` 等护栏）；本清单收录的当前 WebKit 证据不在历史清单内，按上表命令重拍并显式更新清单即可。校验器本身只读清单和 PNG，不会改写文件。
- 平台门禁：重拍前先确认入口的 `--platform linux/amd64` 与镜像 `Os` / `Architecture` 断言通过，日志中 `platform=linux/amd64`；带 `--log` 校验出现 `Platform mismatch`（例如 `linux/arm64`）时先修正运行平台，单独的平台漂移按退出码 1 处理，若清单同时还有其它固定契约不一致则按退出码 2 处理；不能通过改清单 / 更新 sha256 掩盖。arm64 成为受支持平台时按上一段的拆分流程新增独立清单与文档，而不是把本清单的 `environment.platform` 改成 arm64；新增清单前先按上一段扩展校验器。
- 单测：`tests/unit/screenshot-sha256.test.ts` 用临时目录构造 PNG / 日志夹具，覆盖清单解析（非法条目、控制字符路径、大小写重复文件、非 64 位 hex）、全部一致时的退出 0、缺文件 / 哈希漂移 / 环境指纹漂移 / 非法日志（缺字段、重复或未知字段、非规范十进制 DPR）的可读报错与退出码、`capture-env: unavailable (...)` 回退行按环境不可用处理、`--log` 的 sha256 drift 记录（按 `Wrote <path>` basename 关联清单，`captured sha256` 与清单不同或文件不在清单退出 1，块头存在但字段缺失 / 重复 / 非法 hex 退出 2，同一文件多条记录、多文件、磁盘哈希或环境指纹与日志哈希同时漂移都有覆盖，旧日志没有 drift checklist 时保持退出 0），以及清单环境 / `provenance.container` / 重拍命令与固定契约不一致时经 CLI 退出 2；平台字段单独覆盖：清单缺少 / 非法 `environment.platform` 退出 2，清单平台与日志平台漂移（期望 `linux/amd64`、实际 `linux/arm64`）单独报告期望 / 实际平台、镜像 tag / digest 与重拍命令并退出 1，PNG 哈希一致但平台不一致时仍失败。测试还断言清单的镜像 tag / 平台 / EGL / 目标 DPR 与 `scripts/lib/capture-env.mjs` 常量一致、字体版本与 README 的容器 `capture-env:` 示例一致。不依赖真实浏览器或 Docker。`tests/unit/capture-write-guard.test.ts` 覆盖写前护栏：指纹一致时原子写入、rename 失败时目标保持旧字节且不残留临时文件、指纹 / 宿主不符时在写出任何字节前失败且不改动目标 PNG、未收录文件保持原写入路径、固定环境下哈希漂移时打印清单 / 文档 checklist 且校验器仍以退出码 1 失败、截图编码失败不留下临时文件、畸形清单与清单存在但不可读时 fail-closed，以及清单缺失按未收录处理。`tests/unit/capture-minesweeper-determinism.test.ts` 另外覆盖扫雷 WebKit ready 的一次性预热页（含 `try/finally` 关闭路径）、首屏重绘接缝（滚动往返、字体等待与双 rAF settle）、整幅连续两帧的接线，以及 lost 的 loss overlay 背板重绘接缝（仅 WebKit after），还有四张 PNG 与清单 / README 表格 / 历史证据列表之间的契约；`expectedRecaptureCommand` 对扫雷命令的映射在 `tests/unit/screenshot-sha256.test.ts`。`tests/unit/capture-write-guard.test.ts` 同时覆盖整幅稳定帧：连续两帧一致才写、瞬时帧后重试、超出尝试预算时不写并保留旧 PNG、未收录文件走同一稳定检查，以及非法 `stableFrames` / `stableAttempts` / `stableIntervalMs` 参数。`tests/unit/screenshot-platform-docs.test.ts` 另外钉住本 README 的平台文档契约：固定捕获环境写明 `linux/amd64`、`--platform`、平台指纹字段与 arm64 主机拒绝行为；清单章节写明 `environment.platform`、平台差异单独报告及退出码、重拍流程与未来按平台拆分清单；容器 `capture-env:` 示例可被 `parseCaptureEnvironmentFingerprintLine` 解析，且示例平台与清单 `environment.platform`、`CAPTURE_PLATFORM` 一致。`tests/unit/screenshot-webkit-evidence-docs.test.ts` 另外钉住扫雷最高用时榜的固定容器两跑记录、旧 PNG 像素差与 `capture-sha256-manifest.json` 条目（Issue #318 t2），以及扫雷四态的固定容器连续 3 跑记录、旧 PNG 像素差与清单条目（Issue #318 t1）。

## 夜间固定容器两跑复现与排障（Issue #199）

- 目的：每晚在固定的 Playwright 容器里重跑清单收录的证据，证明「同一构建、同一固定容器连续两跑逐字节一致、且等于入库清单」，把跨机器 / 引擎漂移在夜间暴露出来，而不是等到重拍时才由人发现。
- 触发与入口：`.github/workflows/capture-repro.yml` 只在 `schedule`（每日 04:41 UTC）与 `workflow_dispatch` 触发，权限为 `contents: read`、超时 60 分钟，运行在普通 `ubuntu-latest`；固定容器由入口自己启动，所以该 job 故意没有 `container:` 键。入口是 `npm run verify:screenshots:repro`（`node scripts/verify-screenshot-repro.mjs`）。
- 目标来源：目标不写在 workflow 里，而是从 `docs/screenshots/capture-sha256-manifest.json` 的每个 `captures[].command` 派生（当前每条都是 `npm run screenshots:container -- <target>`），同一个 command 的多个文件只对应一次目标捕获；新增清单条目会自动进入夜间复现，不需要改 workflow。清单记录的环境（平台 / 镜像 / 字体 / EGL / DPR）与固定捕获环境不一致时，入口以 2 退出，与运行期哈希 / 指纹漂移的 1 区分。
- 连续两跑 / 可重复复现：默认每个唯一 target 连续运行两次 `npm run screenshots:container -- <target>`，两跑之间立即对该 target 对应的清单文件做 sha256；只有 `run 1 == run 2 == 清单` 才退出 0，两份日志还必须分别通过 `node scripts/verify-screenshot-sha256.mjs --log <日志>`（即 `npm run verify:screenshots:sha256 -- --log <日志>`）的环境指纹 / 平台校验。可选 `--target <screenshots:target>`（可重复，只跑选中的清单 target）与 `--runs <N>`（每个 target 的跑次，正整数，默认 2）用于在固定容器内重复复现漂移；需要同时注入宿主并发负载时按下一节「并发负载截图复现」加 `--load <N>`（默认 0 关闭）；入口逐跑打印并汇总每个清单文件的 sha256，并把每跑 PNG 副本保留到 `test-results/screenshot-repro/<target>-run<N>-png/`，因为下一跑会删除并重拍同一证据路径（target 里的 `:` 换成 `-`）；每跑开始前会先删除该跑目录里的同名旧副本，避免上一次调用留下的 PNG 在本次未写出文件时被误当成这一跑的字节。每跑的捕获日志保存到 `test-results/screenshot-repro/`，例如 `screenshots-webkit-run1.log`、`screenshots-2048-webkit-run2.log`，容器入口自身的日志在 `test-results/capture-container/`，失败时两个目录都会作为 artifact 上传。每跑开始前入口会删除该 target 的清单文件，再运行 capture；因此被既有写保护跳过的历史证据（日志出现 `Refusing to overwrite historical`）会以 sha256 `unavailable` 失败，而不是拿工作区里已提交的字节静默通过。CI runner 用完即弃，但本地运行会删除并重写工作区里已提交的 PNG，所以本地复现应使用临时副本，失败后执行 `git restore docs/screenshots` 恢复证据。需要真正重拍时按下方排障步骤显式加 `--allow-historical-overwrite`。
- 失败汇总：入口把差异文件、期望 / 逐跑实际 sha256（run 1..N）、每跑的日志 / 保留 PNG 路径、每跑的环境指纹与重拍步骤写到步骤输出，并追加到 `$GITHUB_STEP_SUMMARY`；各跑日志的环境指纹不一致、capture 退出非 0、每跑 PNG 副本写入失败或日志校验失败也会各自列成一节。对照顺序是：先看各跑是否彼此一致，再看是否等于清单——都一致却与清单不同，通常意味着需要显式刷新证据，而不是环境抖动；各跑不一致则是固定环境内的真实抖动（见 Issue #328 小节）。
- 排障 / 重拍步骤：1）在本地或临时副本运行 `npm run verify:screenshots:repro` 复现；2）若某个 target 漂移，先检查平台（`linux/amd64`）、镜像 tag / digest 与字体 / EGL 指纹，再对该 target 执行 `npm run screenshots:container -- <target>` 重拍；3）用带 `--log` 的 `verify:screenshots:sha256` 分别校验两次日志；4）确认新字节是预期结果后，在同一改动里显式更新 `docs/screenshots/capture-sha256-manifest.json` 的 `sha256` / `provenance` 与本 README 的表格，并说明重拍原因。不要只改清单掩盖环境差异。
- 只读边界：CI 以只读权限运行，不执行 `git commit` / `git push`，也不编辑清单；capture 只按既有命令写工作区里的正常证据路径（runner 用完即弃），清单内容由「Assert the manifest was not modified」步骤用 `git diff --exit-code -- docs/screenshots/capture-sha256-manifest.json` 断言未变，即使复现失败也会运行。重拍与清单更新始终由人（或显式的证据刷新改动）完成。
- 单测：`tests/unit/screenshot-repro.test.ts` 用临时目录与注入的捕获 / 校验函数覆盖目标派生、`--target` / `--runs` 解析与 target / 跑次选择、逐跑 sha256 汇总与保留 PNG 副本、多跑漂移的失败报告与漂移跑次识别、两跑顺序、两跑一致退出 0、哈希漂移与陈旧清单的差异文案、环境指纹不一致、日志校验失败与 capture 退出的失败汇总、每跑前删除旧证据后漏写 / 第二跑复用 / 删除失败 / 副本写入失败 / 重复调用时清理同名旧副本的失败路径，以及 CLI 的退出码与 `$GITHUB_STEP_SUMMARY` 追加；真实子进程用例用 PATH 里的假 `npm` 覆盖默认 spawn 的日志落盘与 `captureFailures` 映射、默认 verifyLog 的 `verifyFailures` 映射，并真正执行 `node scripts/verify-screenshot-repro.mjs` 覆盖直接入口的 `process.exitCode`（`--help` / 非法参数 / 非法清单 / capture 失败）；`tests/unit/capture-repro-workflow.test.ts` 钉住 workflow 的触发条件、只读权限、超时、无 `container:`、清单派生、不写仓库 / 清单、失败仍上传日志，以及本节与主 README 的文档契约。

## 并发负载截图复现（Issue #352）

- 目的：夜间两跑不保证 runner 同时有其它负载，而 #328 / #341 / #342 的 WebKit 像素漂移只在宿主并发时出现。本节记录独立的并发负载闸门：对受影响的 WebKit 清单 target 重复至少 4 跑，并在捕获期间保持 CPU 负载，任一跑偏离清单即非 0 退出。
- 触发：`.github/workflows/capture-repro-load.yml` 只在 `schedule`（每日 05:47 UTC，在 04:41 夜间两跑之后）与 `workflow_dispatch` 触发；权限 `contents: read`、超时 120 分钟，运行在普通 `ubuntu-latest`，与夜间一样没有 job 级 `container:`，固定容器仍由入口自己启动。
- dispatch 输入：都可选，留空取默认值；输入先由 `node scripts/check-repro-load-inputs.mjs` 校验（只接受清单 target、`runs >= 4`、`load` 为正整数且不超过上限），再经 `$GITHUB_OUTPUT` 传给捕获步骤，不把未校验的 dispatch 值拼进 `run:`。

| 输入 | 默认值 | 含义 |
| --- | --- | --- |
| `targets` | `screenshots:webkit,screenshots:breakout:webkit,screenshots:snake:webkit` | 逗号分隔的清单 target；默认是三个受并发负载影响的 WebKit target |
| `runs` | `4` | 每个 target 的跑次，正整数且至少 4 |
| `load` | `8` | 捕获期间保持的 CPU 占用进程数，正整数 |

- 本地命令：下面这条即默认值（`--target` 可重复；入口自身的 `--runs` 默认仍是 2、`--load` 默认 0，夜间两跑直接使用这两个默认值）：

  ```bash
  npm run verify:screenshots:repro -- --target screenshots:webkit --target screenshots:breakout:webkit --target screenshots:snake:webkit --runs 4 --load 8
  ```

  负载进程在正常结束、capture 失败或异常时都会统一 SIGTERM（超时升级 SIGKILL）回收并等待退出，不会在本次复现结束后继续残留；同一个 `--load` 调用的各跑共享这批负载进程。
- 失败输出：任一跑与清单不同、各跑环境指纹不一致、capture 退出非 0、每跑 PNG 副本写入失败、逐跑日志校验失败或负载进程启动 / 提前退出 / 停止失败都以非 0 退出（失败报告退出 1；用法或清单非法退出 2）。报告列出每个差异文件的期望与逐跑实际 sha256、每跑日志与保留 PNG 路径（例如 `test-results/screenshot-repro/screenshots-webkit-run1.log` 与同目录的 `screenshots-webkit-run1-png/`；target 里的 `:` 换成 `-`）、环境指纹、本次请求 / 启动 / 停止的负载进程数以及重拍步骤，并追加到 `$GITHUB_STEP_SUMMARY`；workflow 失败时仍上传 `capture-repro-load-logs` artifact，包含 `test-results/screenshot-repro/` 与 `test-results/capture-container/`。重拍仍按上一节：`npm run screenshots:container -- <target>`，再用 `node scripts/verify-screenshot-sha256.mjs --log <log>` 校验，确认后才显式更新清单与本 README。
- 默认夜间不变：`.github/workflows/capture-repro.yml` 仍是每日 04:41 UTC 一次、按清单 `command` 派生 target、每个 target 连续两跑、超时 60 分钟；新闸门是独立 workflow，不替换也不改动夜间 job 的触发、目标集合、跑次或时长。
- 清单只读：两个 workflow 都用 `git diff --exit-code -- docs/screenshots/capture-sha256-manifest.json` 断言清单未被修改，失败路径（`if: always()`）也会检查；负载闸门只读取清单，不放宽断言、不自动改写清单。若某个 target 在并发负载下确实无法收敛，按既有口径把它移出本 workflow 的 `targets` 默认集合（或按 #137 / #199 的显式刷新流程移出清单）并在本节记录原因与证据，不在闸门里降低校验。
- 证据边界：`--load` 注入的是宿主（GitHub runner 或本地机器）上的 CPU 占用进程，捕获仍在 `linux/amd64` 的固定 Playwright 容器内执行；因此该闸门只覆盖「Linux WebKit 固定容器」这类已收录清单证据的宿主并发敏感性，不覆盖容器内 CPU 竞争、Chromium 桌面 / 手机宿主捕获、其它引擎 / 平台或跨构建像素差异。arm64 等其它平台仍按「固定捕获环境」的拆分流程另建清单与闸门。
- 单测：`tests/unit/capture-repro-load-workflow.test.ts` 钉住新 workflow 的触发、输入、校验顺序、只读权限与失败仍上传日志，并断言夜间两跑契约不变；`tests/unit/repro-load-inputs.test.ts` 覆盖输入校验与 CLI；`tests/unit/capture-repro-load-docs.test.ts` 钉住本节的 workflow 文件名、三个默认 target、`runs >= 4`、`--target` / `--runs` / `--load`、失败输出、artifact、夜间不变、清单只读与证据边界，并校验本地命令与 workflow / CLI 参数一致、主 README 链接到新 workflow。

## 通用大厅整页证据（Issue #161 / 子任务 1）

- 目的：`scripts/capture-screenshots.mjs` 已为 Chromium 大厅显式补上 `fullPage: true`；本节记录重拍后的两张共享整页证据，并让 `npm run verify:screenshots:doc-dims` 逐张校验它们。
- 单一 owner（Issue #221）：`after-hub-desktop.png` / `after-hub-mobile.png` 只由 `scripts/capture-screenshots.mjs` 经 `npm run screenshots:container -- screenshots` 写入；`npm run screenshots:2048`、`npm run screenshots:breakout`、`npm run screenshots:minesweeper`、`npm run screenshots:snake` 及其 WebKit / before / 窄屏变体都不再重写这两张共享证据。游戏 PR 改大厅卡片时必须单独跑上面的 owner 命令重拍，并在同一改动中同步本表的捕获命令、sha256 与整页尺寸。
- 捕获环境 / 命令：固定 Playwright 容器（镜像 tag / digest、字体与 EGL 变量见「固定捕获环境」）内执行 `npm run screenshots:container -- screenshots`（生产构建 + `vite preview`，端口 4174）。同一构建、端口空闲时连跑两次。
- 捕获提交：`6217a208f55ca7ed2f4d8eb4f5a1c383c60f6d26`（分支 `agent/plan-161-t1`，该提交只含这两张 PNG；文档与测试在后续提交）。
- 确定性口径：两次运行写出的两张图 sha256 完全一致，并与该提交的 PNG 一致；桌面 / 手机的完整 sha256 记录在下方表格的「捕获命令 / sha256」列，由 `npm run verify:screenshots:doc-dims` 一并校验。这是同一构建、同一捕获环境的确定性结果，不是跨构建的像素基准。
- 页脚漂移：桌面整页图会截入共享页脚，旧提交捕获的桌面 After 图带旧页脚，用当前构建重跑必然不同；按「历史 After 证据与当前构建不一致（Issue #137）」的口径，不要求新图等于历史 PNG，本节 sha256 只对上述两次同构建运行有效。
- 视口 / 主题：桌面 1440×1000 CSS px、DPR 1；手机 390×844 CSS px、DPR 2、`isMobile: true`、`hasTouch: true`；深色主题、`reducedMotion: reduce`。两张均为整页截图（`fullPage: true`），手机整页高度按同一次捕获实测记录。
- WebKit 口径：`after-hub-webkit.png` 仍保持 WebKit `iPhone SE (3rd gen)` 375×667 / DPR 2 的视口截图（`fullPage: false`，750×1334）；该图已在 Issue #318 t3 的固定容器内重拍并收录清单（宿主 `npm run screenshots:webkit` 现在会在写出前被写前护栏拒绝），本节两次 `npm run screenshots:snake` 的验收不涉及它。

| 文件 | 场景 | 视口 / 主题 | 整页尺寸 | 捕获命令 / sha256 |
| --- | --- | --- | --- | --- |
| `after-hub-desktop.png` | 大厅（Chromium 桌面，含页脚） | 1440×1000 / 深色 / DPR 1，fullPage: true | 整页 1440×3468 | `npm run screenshots:container -- screenshots` / `7232a8977654561531fd1a1acf507d62ebf9486e78fb16b1714f5b732e7fc168` |
| `after-hub-mobile.png` | 大厅（Chromium 手机） | 390×844（DPR 2）/ 深色，fullPage: true | 整页 780×13194 | `npm run screenshots:container -- screenshots` / `d2fa7877424f0552010f63bb3731d4b82b0771c7ce70e7f72c233b467419f448` |

## zhen-sha：镇煞游戏首屏命名证据（Issue #274 / t1）

- 目的：记录游戏内名称统一为「镇煞」后的首屏 Before / After。Before 是改名前的旧标题，After 的 `<h1>` 读作「镇煞 Zhen Sha」；除标题首字外两张首屏图逐像素一致，布局与画布没有漂移。
- Before 基线：`2f1d6f08cdf50369aa722181713738cde06e803d`（#274 t1 改动前的 `main`，也是本分支起点）。
- After 构建源码提交：`46aae2cca4cf57e10b5837b2c6262d2e1bf51973`（分支 `agent/plan-274-t0`；截图 PNG 与本节是其后的证据提交，不改变构建产物）。
- 捕获方式：同一 worktree 分别 checkout Before / After 源码后执行 `npm ci && npm run build`，用 `vite preview --host 127.0.0.1 --port 4198|4199 --strictPort` 提供生产产物；随后用 Playwright Chromium 真实渲染 `#/games/zhen-sha`，等待 `[data-testid="zhen-sha-game"]` 挂载与 `document.fonts.ready`，再把 `requestAnimationFrame` 冻结在 mount 帧后截图。冻结只用于让两版画布逐像素可比，没有改动游戏逻辑或产物。
- 视口 / 主题：桌面 1440×1000 CSS px、DPR 1；手机 320×640 CSS px、DPR 2、`isMobile: true`、`hasTouch: true`。两张均为深色主题、`reducedMotion: reduce`、视口截图（`fullPage: false`）。
- 像素差异：桌面 644 个像素、手机 947 个像素不同，差异包围盒分别只覆盖标题首字（桌面 147,131–181,165；手机 229,233–273,277），因此改名没有移动首屏元素。
- 预算基线（`npm run check:budget`）：入口 33.42 KB / 11.16 KB gzip（上限 50 KB）；全部 JS 改名后 410.59 KB gzip（改名前 410.58 KB），上限 450 KB，剩余 39.41 KB；CSS 13.57 KB gzip。

| 文件 | 场景 | CSS 视口 / PNG 尺寸 | sha256 |
| --- | --- | --- | --- |
| `before-zhen-sha-route-desktop.png` | 游戏首屏（改名前的旧标题） | 1440×1000 / 1440×1000 | `18758a81807b26e9512db9895b2abbcedf408dd7b6496d0251ea23fda36f105a` |
| `after-zhen-sha-route-desktop.png` | 游戏首屏（「镇煞」） | 1440×1000 / 1440×1000 | `8f903d39bb5e681ec9a59a322ab5a759c5058df6c24f6ffa44a11785ef1a8002` |
| `before-zhen-sha-route-320x640.png` | 游戏首屏（改名前的旧标题） | 320×640 / 640×1280 | `94e43a57bc1825ca7e909f194b2f49a1fccdec657bee35cbc807476cab3ba81e` |
| `after-zhen-sha-route-320x640.png` | 游戏首屏（「镇煞」） | 320×640 / 640×1280 | `35447f5d3e9108fc4bbd6e2873c49c26f55b4b1215fa825735f4dd3a99904cee` |

## 大厅六款计数文案证据（Issue #274 / t2）

- 目的：记录大厅首屏从旧的 `ISSUE #11` 与五款游戏叙事改为当前「六款游戏 + 镇煞」叙事后的 Before / After。After 首屏同时能读出「六款游戏」与「镇煞」；除 eyebrow 与 lede 文本外，两张首屏图没有布局或视觉漂移。
- Before 基线：`0965faa695b0e9935e461211aa5f66020f546021`（#275 合并后的 #274 t1 head，也是本子任务 t2 的 base）。
- After 构建源码提交：`fbe5bcbf4a0362b16d4b1bc16122a8e2f42368d6`（分支 `agent/plan-274-t1`；截图 PNG 与本节是其后的证据提交，不改变构建产物）。
- 捕获方式：同一 worktree 先在 base 提交执行 `npm ci && npm run build` 并捕获 Before，完成文案改动后再构建捕获 After；两次都用 `vite preview --host 127.0.0.1 --port 4194|4195 --strictPort` 提供各自的生产产物。随后用 Playwright Chromium 真实渲染 `/`，等待 `networkidle`、`document.fonts.ready` 后再等待 400 ms 截视口图（`fullPage: false`）。
- 视口 / 主题：桌面 1440×1000 CSS px、DPR 1；手机 320×640 CSS px、DPR 2、`isMobile: true`、`hasTouch: true`。四张均为深色主题、`reducedMotion: reduce`。
- 首屏可读性：After 桌面与手机首屏都完整显示 eyebrow「六款游戏已上线」与包含「镇煞」的 lede；手机端 lede 底边为 y=603（<640），无需滚动即可读到。
- 像素差异：桌面 3144 个像素不同（bbox 214,173–509,502）；手机 8546 个像素不同（bbox 88,668–593,1196，PNG 坐标，对应 CSS 44,334–296,598）。差异只落在 eyebrow 与 lede 文本带，hero、按钮与右侧视觉未移动。
- 预算（`npm run check:budget`，After 提交实测）：入口 33.45 KB / 11.16 KB gzip（上限 50 KB，余 38.84 KB）；全部 JS 410.58 KB gzip（上限 450 KB，余 39.42 KB）；CSS 13.57 KB gzip。
- t1 游戏首屏证据沿用上一节「zhen-sha：镇煞游戏首屏命名证据」，本轮未重拍。

| 文件 | 场景 | CSS 视口 / PNG 尺寸 | sha256 |
| --- | --- | --- | --- |
| `before-hub-copy-desktop.png` | 大厅首屏（Before：eyebrow 为 `ISSUE #11`、lede 未含镇煞） | 1440×1000 / 1440×1000 | `5ddcb814e3280e29382948eb8dc1ea868374ecf136c33ecd0ace145a9508cba8` |
| `after-hub-copy-desktop.png` | 大厅首屏（After：「六款游戏已上线」+「镇煞」） | 1440×1000 / 1440×1000 | `72b976e5a9ff2f39a89a5d192a417c595d6bb202df8c441d29b257b52e7e77a8` |
| `before-hub-copy-320x640.png` | 大厅首屏（Before：eyebrow 为 `ISSUE #11`、lede 未含镇煞） | 320×640 / 640×1280 | `bbcf73a1dbe7d9822c5e7b9da464cf165ace935cdf01c837731c03aeeee4002e` |
| `after-hub-copy-320x640.png` | 大厅首屏（After：「六款游戏已上线」+「镇煞」） | 320×640 / 640×1280 | `d01ee645cf07577a2abdea391fef8546b1d196de20711bf09f2a5c12601cb660` |

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
- WebKit 部分另有独立口径：窄屏的漂移产物、2048 ready 的单页稳定捕获与清单外口径、扫雷四态的稳定接缝、EGL 与官方 Playwright 容器环境事实、`webkit-narrow` 以 CI 清单而非 sha256 校验，统一记录在「webkit-phone」的「WebKit 历史证据（Issue #137 / #120）」；哈希级复现见 #199。

## CI：截图文档整页尺寸校验（Issue #134）

- 覆盖范围：`docs/screenshots/README.md` 表格里的尺寸行、完整 sha256 与 `docs/screenshots/<file>.png` 逐项比对：
  - 整页行 `整页 W×H`：把文档尺寸与 PNG 签名 / IHDR 宽高比对，共 16 行 / 16 个文件，其中包括「通用大厅整页证据」收录的 `after-hub-desktop.png` / `after-hub-mobile.png`。
  - 视口行 `CSS 视口 / PNG 尺寸`（`W1×H1 / W2×H2`）：只把斜杠后的 `W2×H2` 与 PNG 签名 / IHDR 宽高比对；斜杠前的 CSS 视口按 DPR 可能与 PNG 尺寸不同，仅作为文档元数据保留。现有 8 条视口证据是 `before/after-zhen-sha-route-desktop`、`before/after-zhen-sha-route-320x640`、`before/after-hub-copy-desktop`、`before/after-hub-copy-320x640`，共 8 行 / 8 个文件。
  - 完整 sha256：同一表格行最后一列（捕获命令 / sha256）里反引号包裹的哈希按文件位置一一对齐（每个文件一个哈希槽），完整 64 位哈希用 `node:crypto` 的 SHA-256 计算 `docs/screenshots/<file>.png` 的实际哈希后比对；现有 8 条视口证据与「通用大厅整页证据」两行各带 1 个完整哈希，共 10 个文件。哈希与尺寸在同一行、同一次遍历中校验。
  - 省略号简写：解析器把带 `…` 的缩略哈希当作空槽跳过，不与文件比较；本 README 的表格已无缩略哈希写法（「通用大厅整页证据」两行已改用完整哈希），解析器保留该兼容分支并由测试覆盖。不带省略号的 8–63 位短十六进制若恰好是文件 sha256 的前缀，会作为截断报告（见失败表现），以免把写短的完整哈希静默放过；普通短十六进制（如表格里的 7 位提交前缀）不受影响。
  - 合计 24 行 / 24 个文件，其中 10 个文件校验完整 sha256。只读 README 与已提交 PNG，不执行截图脚本、不写文件，也不需要浏览器或生产构建。
- CI 位置：`.github/workflows/ci.yml` 的 `verify` job，在 `Unit tests`（`npm run test:unit`）之后、`Production build`（`npm run build`）之前新增名为 `Screenshot doc dimensions` 的步骤；`verify` 的 `timeout-minutes` 保持 20。放在构建前，尺寸或哈希漂移会尽早失败。
- 步骤命令：`npm run verify:screenshots:doc-dims`（即 `node scripts/check-screenshot-doc-dims.mjs`）。
- 复现命令：`npm run verify:screenshots:doc-dims`。通过时输出 `OK: 检查了 24 个文件 / 24 行 README（整页 16 行 / 视口 8 行，sha256 10 个文件），尺寸与 sha256 全部一致。` 并以 0 退出；该计数与 `tests/unit/screenshot-doc-dims.test.ts` 的 CLI 契约断言一致。
- 失败表现：尺寸问题与哈希问题进入同一个问题列表，并以相同的非 0 状态退出。把 `after-hub-copy-desktop.png` 行斜杠后的 `1440×1000` 改成 `1441×1000` 后，本地实测输出：

```text
FAIL: 发现 1 处尺寸 / sha256 问题（检查了 24 个文件 / 24 行 README，整页 16 行 / 视口 8 行）：
  README 87: after-hub-copy-desktop.png: 视口 PNG 1441×1000 != PNG 1440×1000（尺寸不一致）
```

  把 `after-zhen-sha-route-desktop.png` 行的完整 sha256 首字符 `8` 改成 `0` 后输出：

```text
FAIL: 发现 1 处尺寸 / sha256 问题（检查了 24 个文件 / 24 行 README，整页 16 行 / 视口 8 行）：
  README 68: after-zhen-sha-route-desktop.png: sha256 文档 0f903d39bb5e681ec9a59a322ab5a759c5058df6c24f6ffa44a11785ef1a8002 != 实际 8f903d39bb5e681ec9a59a322ab5a759c5058df6c24f6ffa44a11785ef1a8002（sha256 不一致）
```

  把同一行的完整 sha256 去掉最后一位（截断成 63 位）后输出：

```text
FAIL: 发现 1 处尺寸 / sha256 问题（检查了 24 个文件 / 24 行 README，整页 16 行 / 视口 8 行）：
  README 68: after-zhen-sha-route-desktop.png: sha256 文档 8f903d39bb5e681ec9a59a322ab5a759c5058df6c24f6ffa44a11785ef1a800 != 实际 8f903d39bb5e681ec9a59a322ab5a759c5058df6c24f6ffa44a11785ef1a8002（sha256 截断：文档 63 位，实际 64 位）
```

  以上修改都以 1 退出，恢复文档后重新通过；「通用大厅整页证据」两行现在也校验完整 sha256，改错一个字符，或删掉末尾一位（得到 63 位前缀），同样以 1 退出并给出行号、文件名与两份哈希。整页行仍按原口径校验，把 `after-minesweeper-scores-desktop.png` 行的 `整页 1440×1606` 改成 `1440×1607` 时输出 `README 296: after-minesweeper-scores-desktop.png: 整页 1440×1607 != PNG 1440×1606（尺寸不一致）`。PNG 缺失、PNG 签名错误或 IHDR 截断时同样逐条给出 README 行号、文件名、文档值与实际 PNG 状态。
- 实测耗时：2026-11-11 在 `agent/plan-134-t1` 的本地 worktree 实测，`npm run verify:screenshots:doc-dims` 约 0.08–0.09 s（`node scripts/check-screenshot-doc-dims.mjs` 本身约 0.02 s，其余为 npm 启动开销），属于毫秒级；相对 `verify` job 的分钟级耗时（见下节 WebKit 冒烟步骤的参考 run）可忽略。CI runner 的绝对耗时不同，以实际 run 为准。
- 防回归：`tests/unit/ci-workflow.test.ts` 断言 `Screenshot doc dimensions` 步骤存在、其 `run` 恰为 `npm run verify:screenshots:doc-dims`、位于 `npm run test:unit` 之后且在 `npm run build` 之前，并继续钉住 `verify` 的 `timeout-minutes: 20`；脚本行为（整页 / 视口尺寸写错、完整 sha256 写错与截断、省略号简写跳过、PNG 缺失 / 签名错误 / IHDR 截断、CLI 退出码与 24 行 / 24 文件 / 10 个哈希文件计数）由 `tests/unit/screenshot-doc-dims.test.ts` 覆盖。

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
  - `npm run screenshots:container -- screenshots:webkit` → 大厅 / 空白画布（两张均已收录清单，宿主命令会在写出前被拒绝）
  - `npm run screenshots:container -- screenshots:snake:webkit` → 贪食蛇手机 ready（开发服务器 + 固定首果；已收录清单，宿主命令会在写出前被拒绝；脚本固定 READY 标题的 `--text` 颜色并关闭其过渡，提交页在 `waitForSnakeReady` 等待标题计算色为 `rgb(226,232,240)` 且零动画，再依次执行 `settleWebkitReadyPaint` 滚动往返、D-pad 取景、`repaintWebkitReadyOverlay` 遮罩重绘与 `{ stable: true }` 连续两帧原子落盘，不稳定直接抛错；Issue #342 返工先打开同一 READY 场景的一次性预热页，再采集提交页）
  - `npm run screenshots:container -- screenshots:2048:webkit` → 2048 ready / playing / gameover（playing / gameover 已收录清单；ready 是清单外的负载相关视觉证据）。容器内 ready 正常写单页；宿主运行会在写 ready 前用同一 `webkit` 环境校验失败并中止，不会覆盖已提交 PNG。三条路径都先打开同一 READY 场景的一次性预热页。ready 保留滚动往返 + overlay 重绘接缝与 `{ stable: true }` 连续两帧门禁，单页落盘、不做清单重采样（Issue #374）；playing / gameover 先从 fresh page 重采样到清单 sha256，并在截图前重绘共享页眉 / 同帧重建页眉与结算卡背板（Issue #341 t3）
  - `npm run screenshots:container -- screenshots:breakout:webkit` → 打砖块 ready / playing / levelclear / gameover（四张均已收录清单，宿主命令会在 ready 前被拒绝；ready 在 `openReady` 里先执行 `settleReadyBackdrop` 首屏重绘接缝）
  - `npm run screenshots:container -- screenshots:minesweeper:webkit` → 扫雷 ready / playing / lost / won（四张已收录固定环境 sha256 清单；宿主命令会在 ready 前被写前护栏拒绝）；ready 保留原有预热页 + 滚动往返 + 整幅连续两帧门禁，并在此之上进入 fresh page 重采样（Issue #341 t4）；playing / won 在首次揭示前重绘共享页眉，lost 在 overlay 背板重绘后同帧重建页眉与损失卡背板；四张都从 fresh page 重采样到清单 sha256
  - `npm run screenshots:minesweeper:webkit-before` → 同一组 WebKit 手机 Before 状态（需 `BASE_URL` 指向触屏改动前的基线预览；仓库不提交这些 Before 文件）
  - `npm run screenshots:container -- screenshots:minesweeper:scores:webkit` → 最高用时榜（当前面板包含「清空记录」；已收录清单，宿主命令会在写出前被拒绝）；有意修改榜单 UI 时在该固定容器命令后加 `--allow-new-bytes`（仍需固定容器，宿主会被环境护栏拒绝），写盘后按漂移清单同步清单与本文档表格
  - WebKit 图默认保护已全部转为清单写前护栏：`screenshots:webkit`、`screenshots:snake:webkit`、`screenshots:2048:webkit`、`screenshots:breakout:webkit`、`screenshots:minesweeper:webkit` 与 `screenshots:minesweeper:scores:webkit` 的当前图除 `after-2048-ready-webkit.png` 外都已收录 `capture-sha256-manifest.json`，不再属于「WebKit 历史证据（Issue #137 / #120）」的保护集合；宿主命令会在首个写盘前被清单护栏拒绝，重拍只能走上面的固定容器命令。未注入容器指纹时宿主直接带 `--allow-historical-overwrite` 仍会被拒绝。`after-2048-ready-webkit.png` 自 Issue #374 起有意移出逐字节清单：负载下它会稳定落在 `672285de…` / `d8a808b0…` / `1f45d828…` 等 1-LSB 变体，fresh page 重采样、重启 browser 进程与更长等待都不能可靠回到 `0ea38c8d…`，因此它只保留预热页、滚动往返 + overlay 重绘接缝与单页 `{ stable: true }` 两帧门禁，写前用同一 `webkit` 环境的 playing 清单条目做环境护栏，不参与 `verify:screenshots:sha256` / `verify:screenshots:repro` 的逐字节比较。扫雷 ready 先打开一个一次性预热页，再在每次 fresh page 采样中对实际页面做滚动往返重绘 sticky 页眉，并以整幅连续两帧 sha256 相同作为采样门禁、再要求整幅 bytes 等于清单 sha256 才落盘（Issue #318 t1；Issue #341 t4）；贪食蛇 ready 同样先打开同一 READY 场景的一次性预热页，提交页再走滚动往返、D-pad 取景与 overlay 背板重绘，并用连续两帧逐字节一致作为落盘条件（Issue #342 返工）；扫雷 playing / won 在首次揭示前重绘共享页眉，lost 在截图前隐藏并恢复损失 overlay 两帧，强制半透明背板重新快照，然后同帧重建页眉与损失卡背板，消除偶发的 1-LSB 棋盘 / 背板变体。负载下这些错误栅格会跨帧保持字节稳定，光靠接缝或连续两帧门禁无法识别；因此 `screenshots:2048:webkit` 的 playing / gameover 与 `screenshots:minesweeper:webkit` 的 ready / playing / lost / won 都从 fresh page 重新采样，直到整幅 bytes 的 sha256 等于清单条目（最多 20 次，否则在写盘前失败；有意改图用 `--allow-new-bytes`）；扫雷 ready 保留预热页并在每次采样里走滚动往返接缝与稳定帧门禁，其 overlay 重绘只属于 lost、ready 本身用 `captureStableFramesBytes`（Issue #341 t4）。`screenshots:minesweeper:webkit-narrow` 走独立的 `webkit-narrow` 模式，不在保护集合内，CI 冒烟仍可先 `rm` 再重新生成。
  - 窄屏 4 视口见上文 `webkit-narrow` 小节。
- 预览端口：通用大厅 / 空白画布脚本（`npm run screenshots` 与 `npm run screenshots:webkit`）默认 `4174`；共享主机或并行 worktree 用 `PREVIEW_PORT=4175 npm run screenshots` 覆盖（`PREVIEW_PORT` 为空串时回退 `4174`；WebKit 模式复用同一启动路径与端口）。端口已被占用时脚本在启动 preview 前以非零状态退出，错误包含实际端口、`the port is already in use` 与 `Set PREVIEW_PORT` 建议，不会写出或覆盖任何截图；端口探测通过后 preview 提前退出时报告子进程退出码与 stderr，不再静默连到端口上的其它服务。显式设置 `BASE_URL` 时（外部 preview 模式）不启动 preview、不探测端口，行为与文件名保持不变。
- 引擎 / 视口 / 主题记录：每个脚本在写图后会输出一行 `engine=…, viewport=…, theme=dark, reducedMotion=reduce`；下表也逐项记录。WebKit 模式不写既有 Chromium 文件名，Chromium 模式也不会写这些 `-webkit` 文件。
- 覆盖边界：俄罗斯方块只有 e2e 覆盖，没有 `capture-*` 截图脚本；因此本表不包含俄罗斯方块截图。WebKit 是 Linux 构建，不等同真实 iOS Safari，动态地址栏 / 安全区 / 真机字体仍由上文差异小节与 e2e 覆盖。

| 文件 | 场景 | 引擎 / 视口 / 主题 | 生成命令 |
| --- | --- | --- | --- |
| `after-hub-webkit.png` | 大厅 | WebKit / 375×667 / 深色 | `npm run screenshots:container -- screenshots:webkit` |
| `after-blank-webkit.png` | 空白画布（触屏移动并停稳后） | WebKit / 375×667 / 深色 | `npm run screenshots:container -- screenshots:webkit` |
| `after-snake-webkit.png` | 贪食蛇 READY（手机；一次性预热页 + 四段落定 + 连续两帧） | WebKit / 375×667 / 深色 | `npm run screenshots:container -- screenshots:snake:webkit` |
| `after-2048-ready-webkit.png` | 2048 READY（手机） | WebKit / 375×667 / 深色 | `npm run screenshots:container -- screenshots:2048:webkit` |
| `after-2048-playing-webkit.png` | 2048 合并计分中（手机） | WebKit / 375×667 / 深色 | `npm run screenshots:container -- screenshots:2048:webkit` |
| `after-2048-gameover-webkit.png` | 2048 无路可走（手机） | WebKit / 375×667 / 深色 | `npm run screenshots:container -- screenshots:2048:webkit` |
| `after-breakout-ready-webkit.png` | 打砖块 READY（手机） | WebKit / 375×667 / 深色 | `npm run screenshots:container -- screenshots:breakout:webkit` |
| `after-breakout-playing-webkit.png` | 打砖块游玩中（手机） | WebKit / 375×667 / 深色 | `npm run screenshots:container -- screenshots:breakout:webkit` |
| `after-breakout-levelclear-webkit.png` | 打砖块过关（手机） | WebKit / 375×667 / 深色 | `npm run screenshots:container -- screenshots:breakout:webkit` |
| `after-breakout-gameover-webkit.png` | 打砖块生命用完（手机） | WebKit / 375×667 / 深色 | `npm run screenshots:container -- screenshots:breakout:webkit` |
| `after-minesweeper-ready-webkit.png` | 扫雷 READY（手机） | WebKit / 375×667 / 深色 | `npm run screenshots:container -- screenshots:minesweeper:webkit` |
| `after-minesweeper-playing-webkit.png` | 扫雷游玩中（触屏轻点 + 长按插旗） | WebKit / 375×667 / 深色 | `npm run screenshots:container -- screenshots:minesweeper:webkit` |
| `after-minesweeper-lost-webkit.png` | 扫雷 BOOM（触屏） | WebKit / 375×667 / 深色 | `npm run screenshots:container -- screenshots:minesweeper:webkit` |
| `after-minesweeper-won-webkit.png` | 扫雷 CLEARED（触屏） | WebKit / 375×667 / 深色 | `npm run screenshots:container -- screenshots:minesweeper:webkit` |
| `after-minesweeper-scores-webkit.png` | 最高用时榜（含「清空记录」，手机） | WebKit / 320×640 / 深色 | `npm run screenshots:container -- screenshots:minesweeper:scores:webkit` |

上表被 `capture-sha256-manifest.json` 收录的行（`after-hub-webkit.png`、`after-blank-webkit.png`、`after-snake-webkit.png`、`after-2048-playing-webkit.png`、`after-2048-gameover-webkit.png`、`after-breakout-playing-webkit.png`、`after-breakout-ready-webkit.png`、`after-breakout-levelclear-webkit.png`、`after-breakout-gameover-webkit.png`、`after-minesweeper-ready-webkit.png`、`after-minesweeper-playing-webkit.png`、`after-minesweeper-lost-webkit.png`、`after-minesweeper-won-webkit.png` 与 `after-minesweeper-scores-webkit.png`）已改为固定容器命令；对应的宿主命令（`npm run screenshots:webkit`、`npm run screenshots:snake:webkit`、`npm run screenshots:2048:webkit`、`npm run screenshots:breakout:webkit`、`npm run screenshots:minesweeper:webkit`、`npm run screenshots:minesweeper:scores:webkit`）会在写出这些文件前被写前护栏拒绝。同一脚本中先写出的未收录文件仍可能在护栏拒绝前已经落盘，随后命令才以非零状态中止。`after-2048-ready-webkit.png` 是唯一的清单外当前 WebKit 证据：脚本在写它之前先用已收录的 `after-2048-playing-webkit.png` 条目校验环境，因此宿主运行也必须在 ready 之前被拒绝。

### WebKit 历史证据（Issue #137 / #120）

- 来源：本表在 [`498a14f`](https://github.com/yeahdongcn-mk2/playground/commit/498a14fb2c7faf426ae79381f433b64f2a18586e)（#120「为截图脚本补 WebKit 模式并收口浏览器覆盖文档与 CI 时长」）首次入库；`webkit-narrow` 的 After 证据更早由 [`9c39e68`](https://github.com/yeahdongcn-mk2/playground/commit/9c39e68dbe38e2ca79b3bf869a8fb6f8b15738e5)（#102「为扫雷窄屏契约补 WebKit 视口矩阵并处理跨引擎差异」）引入，并在 `498a14f` 重新捕获（例如 `after-minesweeper-webkit-narrow-320x640.png` 从 179378 更新为 182309 字节，其余三张也同步更新）。其中 `after-2048-playing-webkit.png` / `after-2048-gameover-webkit.png`、`after-breakout-playing-webkit.png` 与扫雷 ready / playing / lost / won 后来按确定性接缝重拍并纳入固定环境 sha256 清单。其余历史图只代表当时的 UI 与捕获环境快照。Issue #318 t1 只重拍扫雷 ready / playing / lost / won（ready 增加一次性预热页、滚动往返与整幅连续两帧稳定判据）并纳入清单，t2 只重拍扫雷最高用时榜并纳入固定环境 sha256 清单，t3 只重拍大厅与贪食蛇（贪食蛇修复 READY 标题的 reduced-motion 过渡起点）并纳入清单，t4 只重拍打砖块 ready / levelclear / gameover（ready 增加首屏重绘接缝）并纳入清单，其余已提交 PNG 不改动。
- 已报告的漂移产物（最后捕获于 `498a14f` / #120；同一命令重跑后 sha256 与已提交产物不同）：
  - 扫雷窄屏：`after-minesweeper-webkit-narrow-320x640.png`、`after-minesweeper-webkit-narrow-360x640.png`、`after-minesweeper-webkit-narrow-375x667.png`、`after-minesweeper-webkit-narrow-412x839.png`。尺寸与已提交一致，sha256 全部不同。
- 曾修复但负载下仍会漂移、现已移出清单：`after-2048-ready-webkit.png`（原捕获提交 `498a14f`，相对已提交 `4f488a3e…` 曾有两跑 2198 / 368 像素的跨环境差异）。在官方 Playwright 容器内它曾连续两跑差 1833 像素（每通道最大 1，全部落在 sticky 站点页眉文字带；棋盘与 DOM 盒完全相同）。原因是新浏览器首帧对 sticky 页眉的合成层光栅化有两种只差 1 的稳定结果；#199 t1 的滚动往返 + overlay 重绘 + 连续两帧门禁消除了空闲 / 跨环境的两跑差异，得到 `0ea38c8d6a1ff580c695cedc6f5165ad4299a7612dd3da32d3c62c06e73b4856` 并曾收录进清单。Issue #374 t1 随后确认并发负载下仍会落在 `672285de…`（仅页眉 1833 px）、`d8a808b0…`（10728 px：页眉 1833 px + READY 卡片 / 背板 8895 px）与 `1f45d828…` 等稳定 1-LSB 变体；20 页 fresh-page 重采样可能全部错过，重启 browser 进程与更长的 settle 等待也不能可靠回到规范栅格。因此 #374 的修复改为保留预热页、两条接缝与单页 `{ stable: true }` 两帧门禁，把该图移出 sha256 清单，并在写盘前用已收录的 playing 条目做同一 `webkit` 环境护栏；证据与验收见「2048 ready 的负载相关栅格与清单外口径」。
- 不在这组漂移里：`after-breakout-playing-webkit.png` / `after-2048-playing-webkit.png` / `after-2048-gameover-webkit.png` 走固定 seed / 步进 / 首屏重绘的确定性接缝，在官方 Playwright 容器内重跑与已提交产物逐字节一致（playing `4173dce8…`、gameover `bf7548b7…`）；2048 ready 不在逐字节基准内，见上条。`after-blank-webkit.png` 的确定性另见「空白画布截图确定性」。`after-breakout-ready-webkit.png` / `after-breakout-levelclear-webkit.png` / `after-breakout-gameover-webkit.png` 已在 Issue #318 t4 复核并收录清单（ready 走首屏重绘接缝，见下条）；扫雷 `after-minesweeper-ready-webkit.png` 已在 Issue #318 t1 按「一次性预热页 + 滚动往返 + 整幅连续两帧」复核，`after-minesweeper-playing-webkit.png` / `after-minesweeper-lost-webkit.png` / `after-minesweeper-won-webkit.png` 按既有 settle（playing / won 在首次揭示前重绘共享页眉，lost 另加 loss overlay 背板重绘并同帧重建页眉 / 背板，Issue #341 t3）复核，四张均收录清单（见下条）；`after-minesweeper-scores-webkit.png`、`after-hub-webkit.png` 与 `after-snake-webkit.png` 已在固定容器内复核并收录清单（见下两条）。`after-breakout-playing-webkit.png` 曾在固定容器 + 宿主并发负载下 4 跑中 3 跑漂到 `693453d3…`（差异全落在共享页眉）；Issue #328 t2 在 WebKit playing 捕获里接入共享 header 重绘接缝并要求连续两帧一致后再落盘，修复后在同等负载下 4 跑均为清单一字节 `27297f5f…`，见「after-breakout-playing-webkit 并发负载漂移复现、归因与修复（Issue #328）」。
- 大厅复核（Issue #318 t3）：在固定捕获容器内用 `npm run screenshots:container -- screenshots:webkit` 连续两跑 sha256 相同（均为 `6c2856e33a5619dc2eff5833c059608c74f03492192029515edf345b165581f4`），已按固定容器口径重拍并收录 `capture-sha256-manifest.json`（捕获 commit `c6a8c6c0b6cb70aac968f12d834d00f1073ade61`）。相对重拍前的已提交 PNG `8b766aec…`，两跑结果与旧字节差 740211 像素（73.9841%，bbox 覆盖整幅 750×1334，每通道最大 199，变化像素平均 1.7），其中 691635 像素只差 1 个色阶、39995 像素差 2 个色阶，其余是文字 / 图形抗锯齿边缘（6458 像素每通道差 ≥50）；精确等于文字色 `rgb(226,232,240)` 的像素数 10268 与旧图一致，布局与内容未变。原因是旧 PNG 来自 #120 的旧捕获环境，固定容器的软件光栅让整幅渐变背景产生 ±1 色阶差。`reducedMotion: reduce` 加 `animation-duration: 0.001ms; animation-iteration-count: 1` 让 orbit / breathe 在截图前到达终态，容器内两跑逐字节一致也与冻结状态吻合。
- 大厅并发负载漂移修复（Issue #341 t2）：在固定容器内用未接缝的 t1 版本（`148f9f7`）在宿主并发负载（load average 约 15–21，另加 4 个 CPU 占用进程）下连续跑 `npm run screenshots:container -- screenshots:webkit`，第 10 跑复现 `99dfef39…`（同跑 `after-blank-webkit.png` 仍为 `cd4ed3fe…`；10 跑里 1 次漂移）。对 `99dfef39…` 与已提交 `6c2856e3…` 逐像素差分：259936 个像素不同（25.9806%，bbox rows 46–848 / cols 0–749，每通道最大 198，变化像素平均 1.55），其中 204049 个只差 1、37581 个差 2；共享 header 带（rows 23–114 / cols 24–725）只占 2429 个像素且恰好每通道差 1，而每通道差 >10 的像素全部落在 rows 356–538 / cols 284–465 的 `.orb-core` 圆形区域。三通道均 >200 的核心亮区框在已提交图为 rows 356–498 / cols 284–434，在漂移图为 rows 359–497 / cols 287–433，缩了约 3–4 px，与 reduced-motion `breathe` 动画终帧 `scale(0.97)` 相对静止 `scale(1)` 的比例吻合。因此主体漂移来自 hub 内 hero orb 的动画残留，不是共享 header 的 `backdrop-filter` 合成；header 在该变体里也有 2429 个 1 色阶像素，所以两处都接缝。修复仍在写出 `after-hub-webkit.png` 之前：先用 `settleSharedHeaderCompositing` 钉住 header（与 blank 同源），再用同一模块新增的 `settleHubHeroCompositing` finish 页面上的 reduced-motion 动画、确认没有 running / pending 动画后等 2 次双 rAF 提交帧；没有新增旁路 sleep，也没有放宽 `verify:screenshots:sha256` / `verify:screenshots:repro`。2026-11-19 修复后在固定容器内连续 4 跑 `npm run screenshots:container -- screenshots:webkit`（第 3 跑同时运行 6 个宿主 CPU 占用进程，load average 由 3.03 升到 4.66），每跑 `after-hub-webkit.png` 都是 `6c2856e33a5619dc2eff5833c059608c74f03492192029515edf345b165581f4`、`after-blank-webkit.png` 都是 `cd4ed3fea1e0a068661c8102ee0b58b0601b3a249e480d76224d22782a0e088f`；4 份日志分别执行 `node scripts/verify-screenshot-sha256.mjs --log <log>` 均退出 0，15 条清单条目（当时 ready 仍在清单内；现已为 14 条）与 capture-env 指纹全部通过。同一修复另跑 4 跑（每跑同时运行 8 个宿主 CPU 占用进程，load average 峰值 13.25）也全部为同一组字节，`--log` 校验均退出 0。字节未变，所以已提交 PNG、`capture-sha256-manifest.json` 的 `sha256` / `provenance.captureCommit` 与上表都不改动。回归护栏 `tests/unit/capture-hub-determinism.test.ts` 钉住这两处接缝在 hub 截图之前的顺序、只属于 WebKit 路径、blank 顺序不变，并覆盖动画落定与 header / hero 缺失时捕获失败。
- 贪食蛇复核（Issue #318 t3，返工）：上轮 PR #335 的「首个页面预热」接缝在复核中仍不稳定：同一固定容器连续四跑里有两跑停在 READY 标题的黑色过渡起点（`8e9e845e…`，相对已提交 PNG 差 7092 像素 / 0.7088%，bbox rows 545–589 / cols 208–543，该区域 4515 个像素在白色标题行是 `rgb(226,232,240)`、在漂移行是 `rgb(0,0,0)`），另两跑为 `d8e262f3…`。根因是 `src/styles/app.css` 的 reduced-motion 规则对所有元素设置 `transition-duration`，于是 READY overlay 标题（`snake.css` 的 `.snake-overlay-card h2`）会在 CSS 注入时从初始黑色开始一次 `color` 过渡，WebKit 有时把过渡留在起点。返工在 `snake.css` 给该标题显式 `color: var(--text)` 并 `transition: none`，同时 `scripts/capture-snake-screenshots.mjs` 的 `waitForSnakeReady` 在截图前等待标题计算色恰为 `rgb(226,232,240)` 且 `getAnimations()` 为空：颜色或过渡未落定就让捕获失败，而不是写出黑色标题图。移除无效的大厅预热页后（大厅预热并不能阻止 READY 标题过渡；Issue #342 返工按 #318 t1 的 READY 场景预热页另行处理冷启动栅格变体，见下条），在固定捕获容器内用 `npm run screenshots:container -- screenshots:snake:webkit` 连续四跑（含容器 `npm ci` 后的首跑）sha256 全部为 `d8e262f366b11436d5a1dc309f01ee86a473b23f74684fd92e03392fc28450ba`，capture-env 指纹逐项一致（平台 `linux/amd64`、镜像 tag / digest、字体、EGL、DPR、Playwright 均相同）；带 `--log` 的 `npm run verify:screenshots:sha256` 也通过。重拍字节与上轮提交完全相同，因此清单 `sha256` 与 `captureCommit` 仍为 `d8e262f3…` / `c6a8c6c0…`；相对重拍前的旧提交 PNG `de50e83d…` 的 158 像素（0.0158%）差异与上轮记录一致。测试护栏同步加强：`tests/unit/capture-snake-determinism.test.ts` 钉住标题的显式颜色 / `transition: none`、捕获脚本的计算色与零动画等待条件，以及标题色与 `app.css` `--text` 的同步（Issue #342 返工改为断言 READY 场景预热页必须先于提交页）；手机 e2e 在运行期新增 READY 标题计算色为 `rgb(226,232,240)` 且无进行中动画的断言。pre-fix 基线 `d393cee` 在同一固定容器用旧脚本复现到的黑色标题图（run3，`8e9e845e…`）保存为 `docs/screenshots/before-snake-ready-black-title.png`，只用于 PR 的 Before / After 对比，不纳入 sha256 清单。Issue #342 t1 的固定容器连续 4 跑（含一次宿主并发负载）验收记录见下两条。
- 贪食蛇冷启动漂移返工（Issue #342 返工）：复核在固定容器内 11 跑中有 1 跑（冷 `npm ci` 首跑）写出 `3d595ea5…`，与清单 `d8e262f3…` 差 9138 像素（每通道最大 2，bbox rows 23–832 / cols 24–695），差异集中在共享 sticky 页眉与 READY 卡片 / `backdrop-filter` 背板区域；该错误栅格在连续两帧 `{ stable: true }` 检查下仍逐字节一致，说明帧内稳定性拦不住跨进程首个页面的稳定变体。返工按 #318 t1 扫雷 ready 的既有口径，在 `scripts/capture-snake-screenshots.mjs` 的 `captureWebkitMobile` 中先打开一个一次性预热页加载同一 READY 场景（固定首果 URL + `waitForSnakeReady` + 两帧 `settleCapturePaint`），在 `try/finally` 中关闭后再创建提交页；提交页因此不是浏览器首个页面，`settleWebkitReadyPaint` → D-pad 取景 → `repaintWebkitReadyOverlay` → `{ stable: true }` 的顺序保持不变。返工后在固定容器内用 `npm run verify:screenshots:repro -- --target screenshots:snake:webkit --runs 8` 连续 8 跑：首跑为删除 `node_modules/.capture-package-lock-hash` 后的冷 `npm ci`，运行期间与 2048 / 打砖块 / 扫雷的 3 个并发捕获容器重叠；8 跑 sha256 全部为 `d8e262f366b11436d5a1dc309f01ee86a473b23f74684fd92e03392fc28450ba`，等于清单与已提交 PNG，每跑 `--log` 校验退出 0，capture-env 指纹逐项一致，`verify:screenshots:repro` 退出 0。清单与已提交 PNG 均未改变；`tests/unit/capture-snake-determinism.test.ts` 新增断言钉住预热页先于提交页、加载同一 READY 场景、`try/finally` 关闭与既有接缝顺序。
- 贪食蛇并发负载验收（Issue #342 t1）：在固定捕获容器内用 `npm run screenshots:container -- screenshots:snake:webkit` 连续 4 跑；第 2 跑同时启动 8 个宿主 CPU 占用进程，load average 由 3.16 升到 5.70（1 分钟均值）。每跑写出的 `after-snake-webkit.png` 都是 `d8e262f366b11436d5a1dc309f01ee86a473b23f74684fd92e03392fc28450ba`，等于 `docs/screenshots/capture-sha256-manifest.json`、清单表与已提交 PNG；4 份日志分别用 `node scripts/verify-screenshot-sha256.mjs --log <log>` 校验均退出 0，15 条清单条目（当时 ready 仍在清单内；现已为 14 条）与 capture-env 指纹全部通过（平台 `linux/amd64`、镜像 tag / digest、字体、EGL、DPR、Playwright 逐项相同）。提交页的四段落定口径固定为：`waitForSnakeReady` 等待 READY 标题计算色 `rgb(226,232,240)` 且 `getAnimations()` 为空 → `settleWebkitReadyPaint` 滚动往返重绘 sticky 页眉 → D-pad 取景 → `repaintWebkitReadyOverlay` 遮罩重绘 → `{ stable: true }` 连续两帧逐字节一致后原子落盘；任一帧不稳定就让捕获抛错，而不是写出瞬时帧。重拍字节与已提交 PNG 完全相同，因此清单 `sha256` / `provenance.captureCommit`（`d8e262f3…` / `c6a8c6c0…`）与本文档表格都不改动。
- 扫雷最高用时榜复核（Issue #318 t2）：在固定捕获容器内用 `npm run screenshots:container -- screenshots:minesweeper:scores:webkit` 连续两跑 sha256 相同（均为 `44768a977454b98f4526033e96c3cdf60012f6278b10912cf7a11071419674fe`，第三次复跑也相同），已按固定容器口径重拍并收录 `capture-sha256-manifest.json`（捕获 commit `05818ae0bfe980ac9274d75146d22a4e59f96c8e`）。相对重拍前的已提交 PNG `05aa1754…`，两跑结果与旧字节差 5687 像素（0.2143%，bbox rows 23–3999 / cols 24–615，每通道最大 140，变化像素平均 5.0），差异集中在页眉、棋盘 / 成绩行与页脚的文字抗锯齿，不是布局位移；原因是旧 PNG 来自 #120 的旧捕获环境，固定容器的字体 / EGL 光栅会产生略有不同的文字边缘，而容器内连续两跑逐字节一致。
- 扫雷最高用时榜并发负载漂移复现与修复（Issue #341 t3）：Issue #341 记录宿主并发负载下 `screenshots:minesweeper:scores:webkit` 曾把 `after-minesweeper-scores-webkit.png` 写成 `b7f08eac…`，相对当时清单 `44768a97…` 差 3416 像素（bbox rows 2853–2944，每通道最大 1）；该带对应难度设置卡底部的「开始自定义」主按钮（青色渐变，CSS y≈1427–1472），不在共享页眉（页眉为 rows 23–114），也不是最高用时榜的成绩行，因此只重绘 header 无法解释。修复在 `captureWebkitMobile` 的 `openWin` / `settle` 之后、截图之前接入 Issue #341 t1 的 `settleSharedHeaderCompositing`，并让这次全页截图走 `{ stable: true }`：连续两张整幅截图逐字节一致才原子落盘，仍不稳定就抛错而不是写抖动图；另先打开一次性预热页，消除新浏览器进程首屏偶发的棋盘 / 成绩行 1-LSB 变体（未加预热页的一批 4 跑里有 1 跑在棋盘带漂出 11553 像素）。`--before` / `--clear` / Chromium 保持原单张截图路径。修复前在同一固定容器 + 宿主并发负载（10 个 `yes`，load average 17.55 → 21.21）连续 3 跑未复现 b7f08eac（3 跑均为 `44768a97…`），且 b7f08eac 的 PNG 未保留、无法重做差分，故漂移归因沿用 Issue #341 记录的像素证据。修复后在同一固定容器 + 更高并发负载（load average 19.21 → 26.74）连续 4 跑每跑 sha256 均为 `012a7bf09d4f8d8c3b8a38ff34f362def21a2dc2c3a076f5be027d3cdc89fb12`，每跑 `node scripts/verify-screenshot-sha256.mjs --log <log>` 退出 0。重拍后相对旧 PNG `44768a97…` 差 4708 像素（0.1774%，bbox rows 23–2944 / cols 24–615，每通道最大 1）：共享页眉 1292 像素（rows 23–114，接缝重建了 header 的合成快照）与「开始自定义」主按钮渐变带 3416 像素（rows 2853–2944，即 #341 记录的 1-LSB 变体），页面主体 / 页脚逐像素一致；字节变化合法且 4 跑可复现，因此清单 `sha256` 更新为 `012a7bf09d4f8d8c3b8a38ff34f362def21a2dc2c3a076f5be027d3cdc89fb12`、`provenance.captureCommit` 更新为 `2cc6f87d3bcc5fba0e7db5b02df7e5a73dce1f40`。后续复核在同一固定容器内 8 跑（其中 3 跑带 24×`yes`）发现仍有 3 跑写出稳定的棋盘带变体，说明这 4 跑不足以覆盖持续负载，见下条返工。
- 扫雷最高用时榜并发负载漂移返工（Issue #341 t3 返工）：复核在同一固定容器内 8 跑（其中 3 跑带 24×`yes`）有 3 跑写出 `a8187dcf4fb7d6772e6fbbac3cd6ba7975ea93f854e34f332fb76223f5494fd2`，相对清单 `012a7bf0…` 差 6845 像素（bbox rows 407–926 / cols 4–605，每通道最大 1，棋盘带）；三次失败字节完全相同，说明预热页与 `{ stable: true }` 只能保证帧内稳定，拦不住跨进程 / 负载下稳定但错误的栅格。返工在固定容器内复现到同样的 `a8187dcf…`，并在更高宿主负载下观察到另外几种逐通道差 1 的稳定变体：`9d96de924c7b548388026d97a1305363e0bb8ffe945393f19391fc521201855a`（相对 `012a7bf0…` 差 6682 像素，rows 524–918 / cols 34–605，胜利卡片与主按钮）、`192673be4fb7a09589e1c76f6e7609e5396009dccdf58ba36ef3228035944637`（差 163 像素，rows 407–926 / cols 4–567，棋盘背板）、`f256fdbd889f5bb8c8fccb74ef389c4495ad4e1705e38d47c3cf2f360eaf41df`（差 3416 像素，rows 2853–2944，「开始自定义」主按钮）与 `00af5003d8f45aee3730e711147eacf801102edd7bc9e15cec67d131f033c80c`（差 22 像素，rows 411–926 / cols 72–567）。这些变体各自独立落位，任何单一“隐藏 / 恢复某个元素”的接缝都无法同时钉住页眉、棋盘背板、胜利卡片和远端按钮；`WEBKIT_SKIA_ENABLE_CPU_RENDERING=1` 虽能让栅格稳定，但会把页眉 / 按钮 / 棋盘 / 卡片四块一起改成另一种 1-LSB 基准（相对 `012a7bf0…` 差 11553 像素，rows 23–2944），等于回退 #363 已接受的页眉 / 按钮修正，因此不采用。修复在 #363 的 header 接缝之前补上滚动往返（`settleWebkitReadyPaint`）与胜利 overlay 重绘（`repaintWebkitReadyOverlay`），并保持 `settleWebkitReadyPaint` → `repaintWebkitReadyOverlay` → `settleSharedHeaderCompositing` 的顺序；`captureWebkitMobile` 先用 `captureStableBytes` 取两帧一致的全页字节，再与清单 sha256 比较，不相等就丢弃该页、在新 context 中重开并重做接缝，最多 20 次，只有相等才通过本地 `capture` 辅助函数（转发到 `captureScreenshot` 的 `capturedBytes` 路径）走原有的固定环境护栏与原子写。第一张采样先做一次 `checkOnly` 环境预检，宿主 / 错误镜像会直接抛出清单护栏的环境错误，而不是耗完 20 次重采样；若某一页连两帧稳定都达不到，也按一次失败采样处理并继续。这样写出的一定是清单里的 `012a7bf0…`；20 次都不匹配则在写任何字节前失败，不会用重采样改写证据。`--allow-new-bytes` 是有意修改榜单 UI 时的显式出口。`--before` / `--clear` / Chromium 仍走原来的单张截图路径。`tests/unit/capture-minesweeper-scores-determinism.test.ts` 钉住重采样顺序、每次新 context、比较后才写、失败不写与 flag；`tests/unit/capture-write-guard.test.ts` 覆盖 `capturedBytes` 仍先做环境护栏且不再截第三张图。修复后在固定容器 + 宿主 24×`yes` 并发负载下连续 6 跑，每跑 sha256 均为 `012a7bf09d4f8d8c3b8a38ff34f362def21a2dc2c3a076f5be027d3cdc89fb12`（等于清单与已提交 PNG），每跑 `node scripts/verify-screenshot-sha256.mjs --log <log>` 退出 0；6 跑分别用了 1 / 2 / 1 / 3 / 2 / 2 次采样，run2 第 1 张是 `8654cc86…`、run4 前两张都是 `ecca7a13…`，随后都回到 `012a7bf0…`，直接验证了重采样生效。清单 `sha256` / `provenance.captureCommit` 与已提交 PNG 均未改动。合并最新 `main`（`b09d5e6`）后在同一固定容器内以宿主 24×`yes` 负载连续复跑 4 跑（load average 24.83 → 41.57），每跑 sha256 仍为 `012a7bf0…`、`--log` 校验退出 0，4 跑分别用了 2 / 4 / 1 / 2 次采样；run2 前 3 张为 `ecca7a13…` / `8654cc86…` / `8654cc86…` 后回到 `012a7bf0…`，再次验证重采样生效。在最新 `main`（`3dc05ec`）上再次复跑：固定镜像 `mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f`，宿主 12×`yes` 并发负载（load average 1.84 → 16.84），`PREVIEW_PORT=4477 npm run verify:screenshots:repro -- --target screenshots:minesweeper:scores:webkit --runs 4` 退出 0；4 跑 sha256 均为 `012a7bf09d4f8d8c3b8a38ff34f362def21a2dc2c3a076f5be027d3cdc89fb12`，4 跑分别用了 1 / 2 / 1 / 2 次采样（run2 第 1 张 `8654cc86…`、run4 第 1 张 `ecca7a13…` 后回到 `012a7bf0…`），每跑 `node scripts/verify-screenshot-sha256.mjs --log <log>` 均退出 0，已提交 PNG 与清单 `sha256` / `provenance.captureCommit` 未改动。评审收尾后再次按同一命令复跑 4 跑（`PREVIEW_PORT=4478`，宿主 12×`yes`，load average 3.55 → 21.95）：4 跑 sha256 仍均为 `012a7bf09d4f8d8c3b8a38ff34f362def21a2dc2c3a076f5be027d3cdc89fb12`，分别用了 9 / 1 / 5 / 1 次采样（run1 依次采到 `f256fdbd…`、`f6919ad3…`、`192673be…`、`65d5e199…`、`8654cc86…` 后回到清单字节，run3 采到 `00af5003…`、`8654cc86…`、`f256fdbd…` 后回到清单字节），每跑 `--log` 校验退出 0，已提交 PNG 与清单未改动。
- 打砖块复核（Issue #318 t4）：在固定捕获容器内用 `npm run screenshots:container -- screenshots:breakout:webkit` 连续两跑（当时这四张仍在历史保护集合内，需要额外加 `--allow-historical-overwrite`；现已收录清单，重拍不再需要该 flag），三张状态图 sha256 全部相同：ready `372a320ab27d94e2881484047adb358ef222391c00c1c4bfb6a636ab6f3e5f65`、levelclear `c1edf10ec9b483db6a022fa26998438286220d88d0be614a0ead09fe046ddf2d`、gameover `ea78b118f6a50374e2949affae4fca410eeedf057c4e316afad0cd1eae7b8d13`，已按固定容器口径重拍并收录 `capture-sha256-manifest.json`（捕获 commit `d3f0f30437b69022f29f6c7677f117f84ffc09f1`）。同一跑写出的 `after-breakout-playing-webkit.png` 两跑都等于清单 `27297f5f…`，字节未变。首帧问题的证据：未加接缝时同一容器两跑都得到 ready `d094461de01cf7b87068c8a4c4c4b7d32760549837a2e116ef796735c1fc1a91`，相对重拍前已提交 PNG `98f81735…` 差 443830 像素（44.3608%），差异集中在整块砖墙（bbox rows 72..1333 / cols 70..679，每通道最大 105），砖块场完全没有被 WebKit 合成进 READY overlay 的模糊背景；根因是 READY overlay 是静态 HTML，出现早于 Phaser 画出球场，WebKit 在首次合成时就把 `backdrop-filter: blur(5px)` 的背景快照固定成空球场。接缝 `settleReadyBackdrop` 在场景 ready 之后把同一 overlay 的 `backdrop-filter` 关闭一帧再恢复，强制重新快照背景；它只在 WebKit 的 `openReady` 调用，playing / levelclear / gameover 不走该路径。加接缝后两跑 ready 都等于 `372a320a…`，相对重拍前已提交 PNG `98f81735…` 的剩余差异是 1782 像素（0.1781%，bbox rows 23–776 / cols 24–725，每通道最大 10，变化像素平均 1.12）；levelclear 相对旧 PNG `0bba968a…` 差 278 像素（0.0278%，bbox rows 72–739 / cols 128–590，每通道最大 12，变化像素平均 1.93），gameover 相对旧 PNG `9a5a09c7…` 差 310 像素（0.0310%，bbox rows 72–762 / cols 128–590，每通道最大 10，变化像素平均 1.95），都是旧 #120 捕获环境与固定容器的字体 / EGL 光栅差异，不是布局或内容变化。
- 扫雷四态复核（Issue #318 t1 返工）：在固定捕获容器内用 `npm run screenshots:container -- screenshots:minesweeper:webkit` 连续 3 跑（含全新容器 `npm ci` 后的首跑），每跑结束后立即对四张 PNG 取 sha256，三跑结果完全相同，且等于已提交 PNG 与 `capture-sha256-manifest.json` 的四条记录（ready `56c3f68d51c643d9e23a3e5a17d99b44b9da47c52d0cca451080ec3dc878fe0a`、playing `b64d959f12a3b8a08a0757d8cf1ae4875a21a3d96a6df8a28c4a81ca9290d9fb`、lost `6b888d338c7cea61d82578e3ce7e75e5b29620f3fdfc7f25a848a84fea12f3b4`、won `77e7b244607dbdec71ff31df1a991a6744d813fa800c254eb1ebbaf8567f12a2`），每跑日志另用 `npm run verify:screenshots:sha256 -- --log <日志>` 校验固定环境指纹与当前字节，退出 0。首次复审发现只重绘 sticky 页眉不足：5 跑里有 1 跑 ready 取到 `c463b380…`（与 `56c3f68d…` 差 105 px，每通道最大 1，bbox 落在棋盘），说明新浏览器进程的首个页面还会把棋盘栅格化成 1-LSB 变体。现在的 ready 先打开一个一次性预热页，预热首个页面的栅格化路径，再对实际页面做滚动往返，并以整幅连续两帧 sha256 相同作为落盘条件；连续两帧检查只拦住本进程内仍待重绘的帧，跨进程首个页面的变体由一次性预热页消除。合并 #324 后又复现到 lost 偶发 1-LSB 棋盘变体（7497 px，每通道最大 1，bbox rows 388–953 / cols 4–694）：损失 overlay 的半透明背板会缓存旧快照。lost 现在在截图前隐藏并恢复 overlay 两帧，强制背板重新快照；修复后连续 6 跑 lost 均为 `6b888d33…`，ready / playing / won 字节不变。相对重拍前已提交的 #120 PNG，四张分别差 ready 113 px（0.0113%，bbox rows 72–201 / cols 128–288，每通道最大 10，变化像素平均 1.21）、playing 574 px（0.0574%，bbox rows 72–845 / cols 38–711，每通道最大 14，变化像素平均 1.44）、lost 210 px（0.0210%，bbox rows 72–843 / cols 38–711，每通道最大 12，变化像素平均 1.15）、won 236 px（0.0236%，bbox rows 72–677 / cols 39–431，每通道最大 12，变化像素平均 1.18）；差异集中在页眉与 HUD / 文字行的字体 / EGL 抗锯齿边缘，不是布局或内容变化。该节的像素差口径与 t1 不同：t2 / t3 / t4 记录的是复核 / 接缝前后的变化，这里记录的是旧 #120 捕获环境与固定容器字体 / EGL 光栅的差异，两组数字不要混用。
- 环境事实：本机 WebKit 需设置 `__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json EGL_PLATFORM=surfaceless LIBGL_ALWAYS_SOFTWARE=1` 才能启动，否则会因 EGL / surfaceless display 初始化失败。官方 Playwright 容器 `mcr.microsoft.com/playwright:v1.64.1-noble` 内重跑扫雷 4 张，尺寸仍为 750×1334，sha256 仍与已提交不同，但像素差压到 ready 0.0113%（113 px）/ playing 0.06%（574 px）/ lost 0.02%（210 px）/ won 0.02%（236 px），每通道最大 10 / 14 / 12 / 12；ready 还会出现 1.1264%（11270 px）的另一种渲染结果（每通道最大同为 10），两种结果互差 11157 px（每通道最大 1）；同一容器内首跑取到 1.1264% 这一版、随后重跑取到 0.0113% 这一版，新起容器首跑又取回 1.1264% 这一版，所以 0.0113% 只是其中一种采样，不能当作唯一稳定值；容器只能缩小差异，不能保证等于已提交 PNG。Issue #318 t1 返工后，四态在固定容器内连续 3 跑（含全新容器首跑）sha256 全部相同，ready 的预热页 + 滚动往返 + 整幅连续两帧把上面的跨进程变体与待重绘帧都拦在落盘前；playing / won 仍走既有路径，lost 另加损失 overlay 背板重绘接缝。2048 ready 的空闲 / 跨环境两跑漂移已由 #199 t1 的页眉重绘 + overlay 重绘接缝消除（见上）；但并发负载下这些接缝只能保证帧内稳定，仍会采到 `d8a808b0…` / `672285de…` 等 1-LSB 变体，而 fresh page 重采样 / 重启 browser / 更长等待都不能可靠恢复规范字节，因此 Issue #374 已把该图移出逐字节清单并保留接缝与单页两帧门禁（见上）；跨机器 / 引擎 / 字体 / EGL 环境则可能不同。
- 权威口径：`after-minesweeper-scores-webkit.png`、`after-hub-webkit.png`、`after-snake-webkit.png`、`after-breakout-playing-webkit.png`、`after-breakout-ready-webkit.png`、`after-breakout-levelclear-webkit.png`、`after-breakout-gameover-webkit.png` 与扫雷 `after-minesweeper-ready-webkit.png` / `after-minesweeper-playing-webkit.png` / `after-minesweeper-lost-webkit.png` / `after-minesweeper-won-webkit.png` 已收录 sha256 清单；`after-2048-ready-webkit.png` 与其余未被清单收录的 WebKit 图（窄屏矩阵）不作为「重跑必须等于已提交 PNG」的验收基准；逐字节比较只在同一构建、同一捕获环境下的确定性产物之间成立。需要哈希级复现时，先固定捕获环境（容器镜像、字体包、EGL / 软件渲染参数、DPR），见后续单 [#199](https://github.com/yeahdongcn-mk2/playground/issues/199)。
- `webkit-narrow` 的权威校验不是 sha256，而是 CI 的清单校验：`WebKit narrow screenshot smoke test` 用 `docs/screenshots/ci-webkit-narrow-manifest.json` 校验 4 张 `after-minesweeper-webkit-narrow-*.png` 的 PNG 签名 / IHDR 尺寸（DPR 2）、`-webkit-narrow-<W>x<H>.png` 命名，以及捕获日志中逐文件的 `engine=webkit` / 视口记录。CI 的窄屏步骤包含重拍与校验两半（见上文「复现命令（本地等价于 CI 步骤）」）；其中校验半段等价的本地命令是 `node scripts/verify-screenshot-artifacts.mjs --manifest docs/screenshots/ci-webkit-narrow-manifest.json --log <log>`，`<log>` 用本地重拍时 tee 出的捕获日志。`npm run verify:screenshots:webkit` 则是另一条命令：它用内置的 23 个 WebKit 产物清单校验 PNG 签名 / IHDR 尺寸与命名（该清单已包含这 4 张窄屏图，但不是 `ci-webkit-narrow-manifest.json` 的 4 文件清单），不带 `--log` 时不校验日志中的 `engine=webkit` / 视口。

### 证据限制

- 这是当前 head 的静态视觉证据，不是 UI 改动的 Before / After 对比；t1–t3 原任务没有改变页面渲染，目的是让已稳定的手机端场景在 WebKit 引擎下可复现地留下截图。#318 t3 返工只固定 READY 标题的过渡起点、不改变其最终渲染；`before-snake-ready-black-title.png` 是该返工的 pre-fix 实拍对比图，不作为长期证据或 sha256 清单条目。#318 t4 的 READY 接缝也不改变最终样式：它只在截图前关闭再恢复同一 `backdrop-filter`，强制 WebKit 用当前球场内容重新合成背景，因此入库画面仍是真实 READY 状态的渲染。
- 截图脚本的 WebKit 模式与 e2e 的 `mobile-webkit` project 使用同一设备参数；长按 / 触摸注入使用 `scripts/lib/touch-input.mjs`，e2e 的 `tests/e2e/touch-input.ts` 也使用同一实现（含 `releaseTouchClick`），因此两侧行为语义一致。

## after-breakout-playing-webkit 并发负载漂移复现、归因与修复（Issue #328）

- 来源与入口：Issue #328 记录 PR #324 第二轮评审期间、宿主并发负载下 `screenshots:breakout:webkit` 两跑把 `after-breakout-playing-webkit.png` 写成 `693453d3…`（清单 / 已提交 PNG 为 `27297f5f…`）。本子任务给复现入口 `scripts/verify-screenshot-repro.mjs` 增加可重复的 `--target <screenshots:target>` 与 `--runs <N>`，默认仍按清单全部 target × 2 跑；每次运行逐跑打印并汇总每个清单文件的 sha256，并把每跑 PNG 副本保留到 `test-results/screenshot-repro/<target>-run<N>-png/`（`test-results/` 被忽略，副本不提交；每跑开始前会先清理该跑目录里的同名旧副本）。命令：`PREVIEW_PORT=4271 npm run verify:screenshots:repro -- --target screenshots:breakout:webkit --runs 4`。
- 复现次数与负载：2026-11-19 在同一固定容器内连续 4 跑（每跑都是独立 `docker run --platform linux/amd64`、同一仓库挂载、同一 `PREVIEW_PORT=4271`），宿主为 12 vCPU；跑前另起 24 个 `yes > /dev/null` 持续占用 CPU（另有其它 worktree 的并发任务），`load average` 从起跑时 8.55 升到结束时 40.77（1 min）/ 20.24（5 min）。4 跑都通过 capture 与固定环境指纹校验，无 capture / 环境指纹失败；run 2–4 的 `verify-screenshot-sha256 --log` 因当前 PNG 与清单不一致而失败，这是漂移本身的预期结果，不是日志或环境问题。
- 复现结果：`after-breakout-playing-webkit.png` 4 跑 sha256 为 run 1 `27297f5f79792511e1d2a56cc1a1c5565922ba10e7fda3de798c663769147704`（等于清单），run 2 / 3 / 4 均为 `693453d38f1d4be8ab5c704aa3ffa938577d17292f45511823fc2a94d3722b78`（与 #328 记录的漂移字节相同），即 4 跑中复现 3 次。同一 target 的另外三张在 4 跑中全部稳定：ready `372a320ab27d94e2881484047adb358ef222391c00c1c4bfb6a636ab6f3e5f65`、levelclear `c1edf10ec9b483db6a022fa26998438286220d88d0be614a0ead09fe046ddf2d`、gameover `ea78b118f6a50374e2949affae4fca410eeedf057c4e316afad0cd1eae7b8d13`。
- 镜像 / 字体指纹（4 跑逐项相同）：`capture-env: source=container target=webkit dpr=2 platform=linux/amd64 image=mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f node=v26.13.0 playwright=1.64.1 browser=27.2 fonts=fonts-freefont-ttf@20211204+svn4273-2,fonts-ipafont-gothic@00303-21ubuntu1,fonts-liberation@1:2.1.5-3,fonts-noto-color-emoji@2.047-0ubuntu0.24.04.1,fonts-tlwg-loma-otf@1:0.7.3-1,fonts-unifont@1:15.1.01-1build1,fonts-wqy-zenhei@0.9.45-8 env=EGL_PLATFORM=surfaceless,LIBGL_ALWAYS_SOFTWARE=1,__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json`。
- 两版像素差异（run 1 `27297f5f…` vs run 2 `693453d3…`；run 3 / 4 与 run 2 逐字节相同）：两版都是 750×1334 RGBA；差异 1522 像素 / 1000500（0.1521%），bbox 为 rows 23–114 / cols 24–725（0 起始的 PNG 像素坐标），每通道最大差均为 1，且 1522 个差异像素全部只差 1 个色阶；rows 115–1333 逐像素一致。
- 归因：差异全部落在页面顶部共享 `site-header` 的 sticky 页眉带（brand / nav 文字与 `backdrop-filter: blur(18px)` 合成区，页眉内容高度约 74 CSS px = 148 PNG px，bbox 完全在页眉内），没有一像素落在打砖块 HUD、`.breakout-stage` / Phaser canvas 或游戏面板上。它与 Issue #326 记录的 `after-blank-webkit.png` 共享页眉漂移是同一类（那一例 bbox 也是 rows 23–114 / cols 24–725，只是 1892 像素），因此归因为 WebKit 对共享页眉 `backdrop-filter` 合成层的负载相关栅格化变体，而不是 Phaser 球场首帧 / HUD 抖动。`after-breakout-playing` 的固定 debug 步进（seed 7、120 步）保证球场状态本身确定；同一批运行里 ready / levelclear / gameover 也全部稳定。
- 处理与边界（t1）：t1 子任务只扩展复现入口并记录证据，不修改清单 sha256、不改 UI、不接受新截图为证据，因此 `capture-sha256-manifest.json` 与已提交 PNG 保持 `27297f5f…` 不变；实验后已用 `git restore docs/screenshots` 还原工作区字节，漂移副本只留在被忽略的 `test-results/screenshot-repro/`。
- 修复（t2）：`scripts/capture-breakout-screenshots.mjs` 在 `openPlaying` 等到 `data-debug-steps=120` 并完成常规 settle 后，只在 `IS_WEBKIT` 条件内调用 `settleSharedHeaderCompositing`（复用 Issue #326 / #341 的 `scripts/lib/webkit-compositing-settle.mjs`，没有第二份 toggle / 帧等待实现）；它把共享页眉的 `backdrop-filter` 关闭、等待两帧、再恢复并等待两帧，强制 WebKit 从当前页面重建页眉合成快照。`captureWebkitMobile` 再以 `{ stable: true }` 走 `captureStableBytes` 的稳定帧路径：连续两张截图逐字节一致才原子落盘，否则抛错而不是写入仍在重绘的帧。接缝与稳定落盘只作用于这一张 WebKit playing 图；ready / levelclear / gameover 与 Chromium 仍走原来的单张截图路径，因此它们的字节不变。实现接线由 `tests/unit/capture-breakout-determinism.test.ts` 钉住：接缝必须在 `data-debug-steps` 等待之后、由 `IS_WEBKIT` 包裹、全脚本文本只有一次调用、不泄漏进其它状态，帧预算沿用 `SHARED_HEADER_SETTLE_FRAMES = 2`，并且只有该文件传入 `stable: true`。
- 修复验证（t2，2026-11-19）：同一固定容器内连续 4 跑（每跑独立 `docker run --platform linux/amd64`、同一仓库挂载、同一 `PREVIEW_PORT=4271`），宿主为 12 vCPU；跑前另起 16 个 `yes > /dev/null` 持续占用 CPU（另有其它 worktree 的并发任务），`load average` 从起跑时 21.95 升到 38.45（1 min）/ 34.02（结束）。`after-breakout-playing-webkit.png` 4 跑 sha256 全部为 `27297f5f79792511e1d2a56cc1a1c5565922ba10e7fda3de798c663769147704`，等于清单与已提交 PNG；同 target 的 ready `372a320a…`、levelclear `c1edf10e…`、gameover `ea78b118…` 4 跑也全部等于清单。命令 `PREVIEW_PORT=4271 npm run verify:screenshots:repro -- --target screenshots:breakout:webkit --runs 4` 退出 0（4 跑 × 4 文件均与清单及彼此一致），每跑另跑 `node scripts/verify-screenshot-sha256.mjs --log test-results/screenshot-repro/screenshots-breakout-webkit-run<N>.log` 均退出 0。随后全量 `npm run verify:screenshots:repro` 也通过：6 个 target × 2 跑，15 个清单文件全部等于清单且各跑彼此一致。字节没有变化，所以清单 `sha256` / `provenance.captureCommit`、已提交 PNG 与本文件的清单行都不需要刷新；接缝也不改变正常页面渲染。

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
- 生成 After：`npm run screenshots:minesweeper`（生产构建 + `vite preview`，固定雷盘走调试接缝）。该命令只重跑扫雷 After 玩法截图，不写共享大厅证据（`after-hub-desktop.png` / `after-hub-mobile.png` 只由 `npm run screenshots:container -- screenshots` 写入，见「通用大厅整页证据」）；4 张桌面与 4 张手机玩法历史图默认跳过并打印守卫警告；确需重建时只能在固定容器内用 `npm run screenshots:container -- screenshots:minesweeper --allow-historical-overwrite`，并在同一改动中同步 `993f5e7`（#61）等捕获 commit 与 `capture-sha256-manifest.json` 条目（若收录）。
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

### 2048 playing/gameover 与扫雷 lost 等状态的共享 header 接缝（Issue #341 t3）

- 接线：
  - `scripts/capture-2048-screenshots.mjs`：playing 在 `settle(playing)` 后调用 `settleSharedHeaderCompositing(playing)`；gameover 在 `settle(over)` 后用 `settleBackdropLayersCompositing(over)` 在同一帧重建 shared header 与 game-over 卡片的半透明背板，不再额外跑一次 header-only 接缝。ready 先打开同一 READY 场景的一次性预热页，再在单个提交页上重跑 `settleWebkitReadyPaint` + `repaintWebkitReadyOverlay`，用 `{ stable: true }`（`captureStableBytes`）保留连续两帧门禁后单页落盘；它不参与 fresh-page 清单字节重采样，写盘前用已收录的 `after-2048-playing-webkit.png` 条目做 `checkOnly` 环境校验（Issue #374，见「2048 ready 的负载相关栅格与清单外口径」）。
  - `scripts/capture-minesweeper-screenshots.mjs`：playing / won 在 `openTouchGame` 之后、首次触摸揭示之前调用页眉接缝（避免 live 计时在接缝期间跨秒）；lost 在损失 overlay 出现后先 `repaintWebkitReadyOverlay(lost)`，再用 `settleBackdropLayersCompositing(lost)` 一次性重建页眉与损失卡背板；ready 保留原有预热页 + 滚动往返 + 整幅连续两帧接缝，并在此之上接入清单字节重采样（Issue #341 t4，见下节）。
  - `settleBackdropLayersCompositing` 只在页内把 `.site-header` 与 `[data-testid="overlay"]` 的 `backdrop-filter` 同时切换为 `none` 再恢复为样式表值；不隐藏元素、不改最终可见样式。顺序执行页眉 / overlay 两个接缝时，后一个接缝会把前一层重新采样到另一个 1-LSB 变体，所以多层必须同帧重建。
  - 接缝找不到选择器时抛错，两个脚本都不 catch；Chromium / before 路径不经过接缝。
- 有界重采样：`captureManifestedScreenshot`（`scripts/lib/capture-runtime.mjs`，复用 main #373 的 `expectedCaptureSha256` / `capturedBytes` / `checkOnly`）把 2048 playing / gameover 与扫雷 ready / playing / lost / won 从 fresh page 采样，先在内存里校验整幅 bytes 的 sha256 等于清单条目再写盘；最多 20 个 fresh page，仍不匹配就抛错且不写任何文件。2048 playing / gameover 与扫雷 ready 的预热页在采样前各跑一次，稳定帧 / 滚动接缝在每次采样里都保留（扫雷 ready 见 Issue #341 t4，见下节）。2048 ready 自 Issue #374 起不在该重采样集合内，见「2048 ready 的负载相关栅格与清单外口径」。`--allow-new-bytes` 是唯一的有意改图出口：跳过 sha 校验，但仍走固定环境护栏与原子写（之后仍需人工同步 manifest / README）。
- 当前 head 的空闲主机复核（2026-11-20，固定容器）：`PREVIEW_PORT=4492 ... --runs 2` 与 `PREVIEW_PORT=4493 ... --runs 2` 均退出 0，2048 playing / gameover 两张 = `4173dce8` / `bf7548b7`（ready 不在清单内，见下节）、扫雷四张 = `56c3f68d` / `b64d959f` / `6b888d33` / `77e7b244`，2/2 等于清单与已提交 PNG，每跑 `node scripts/verify-screenshot-sha256.mjs --log` 退出 0。
- 并发负载验收（2026-11-20 当前 head，固定镜像 `mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f`，宿主 12 个 `yes`，load average 13–23）：
  - `PREVIEW_PORT=4492 npm run verify:screenshots:repro -- --target screenshots:2048:webkit --runs 4` 退出 1：playing 4/4 = `4173dce8`、gameover 4/4 = `bf7548b7`；ready 3/4 = `0ea38c8d`，第 4 跑写出 `d8a808b0`（相对清单 `0ea38c8d` 差 10728 px，bbox rows 23–1024 / cols 24–725，每通道最大差 2；其中共享页眉带 rows 23–114 为 1833 px，其余 8895 px 落在 READY 卡片 / 背板，与 #374 记录的同一张图一致）。ready 当时按 t3 验收保持未接缝 / 未重采样；该剩余变体随后确认无法用重采样可靠收敛，已由 Issue #374 移出逐字节清单（见下节）。日志 `test-results/screenshot-repro/screenshots-2048-webkit-run{1..4}.log`。
  - `PREVIEW_PORT=4493 npm run verify:screenshots:repro -- --target screenshots:minesweeper:webkit --runs 4` 退出 1，失败项只有 ready：playing 4/4 = `b64d959f`、lost 4/4 = `6b888d33`、won 4/4 = `77e7b244`；ready 3/4 = `56c3f68d`，第 3 跑 `c463b380`（105 px 棋盘变体，当时属 t4，后由 #377 修复）。重采样在现场生效：第 3 跑 lost 第 1 个 fresh page = `cc121c27`，第 4 跑 playing 前两个 fresh page = `1b734cb6`、lost 第 1 个 = `182e269c`，都在后续 fresh page 命中清单后才写盘，没有写出清单外字节。日志 `test-results/screenshot-repro/screenshots-minesweeper-webkit-run{1..4}.log`。
  - 每跑 `node scripts/verify-screenshot-sha256.mjs --log` 对没有 ready 漂移的 3+3 跑退出 0；发生 ready 漂移的 2048 第 4 跑与扫雷第 3 跑退出 1，repro 如实失败，没有改清单绕过。
- 口径修正与验收范围：本子任务描述写 `screenshots:2048:webkit` 4/4 ready = `56c3f68d` 且 repro 退出 0，但 `56c3f68d` 实际是扫雷 ready；`after-2048-ready-webkit.png` 的清单 / 已提交 bytes 是 `0ea38c8d`，负载下第 4 跑是 `d8a808b0`。按 #374 / t4 的分工，本子任务（t3）的接缝验收范围是 2048 playing / gameover 与扫雷 playing / lost / won 共 6 个状态：它们在 4 跑负载下全部 4/4 命中清单。2048 与扫雷 ready 当时都保持未改动的原有路径（扫雷 ready 的 105 px 变体由 t4 修复，2048 ready 由后续 Issue #374 移出逐字节清单，见下节）；因此两个 target 的 `verify:screenshots:repro` 退出 1 只来自 ready，不构成本子任务接缝范围内的失败。
- 结论：本子任务接线的 2048 playing / gameover 与扫雷 playing / lost / won 在 12+ `yes` 负载下 4/4 命中清单；重采样在有漂移的跑次里避免了写错字节。两个 target 的唯一剩余差异都是当时未改动的 ready 路径（2048 ready 10728 px：共享页眉 1833 px + READY 卡片 / 背板 8895 px；扫雷 ready 105 px 棋盘），扫雷 ready 随后由 t4 的清单字节重采样修复（#377），2048 ready 随后由 Issue #374 移出逐字节清单，保留接缝与单页两帧门禁（见下节）。
- 证据限制：负载验收只覆盖 Linux WebKit 软件栅格与固定字体 / 镜像；真机 iOS Safari 的合成行为不在本证据内。负载下所有状态都仍可能落到 1-LSB 变体；重采样遇到持续负载也可能耗尽 20 个 fresh page 后失败（不写盘），本次运行未耗尽。

### 扫雷 ready 并发负载漂移的清单字节重采样（Issue #341 t4）

- 现象与归因：Issue #341 记录 `after-minesweeper-ready-webkit.png` 在宿主并发负载下写成 `c463b380…`，相对清单 `56c3f68d…` 差 105 px（bbox rows 465–971 / cols 2–747，每通道最大 1）。该 bbox 落在棋盘区域，不在共享页眉（rows 23–114），也不是滚动偏移或布局位移；差异是逐通道 1 的稳定栅格变体（#318 t1 首次复现时已由逐像素差分确认），所以整幅连续两帧门禁与页眉滚动接缝都拦不住它。一次性预热页只把首个页面的栅格化路径推走，不能证明后续采样页一定落到清单字节。
- 修复：`scripts/capture-minesweeper-screenshots.mjs` 的 WebKit-after ready 路径改为与 playing / lost / won 相同的 `captureManifestedScreenshot` 有界重采样：
  - 预热页仍在采样前打开并关闭；每个采样页在 `openTouchGame(ready, WIN_MINES)` 后执行既有 `settleWebkitReadyPaint` 滚动往返；
  - 每次采样用新导出的 `captureStableFramesBytes` 保留 `READY_CAPTURE_STABLE_FRAMES=2` / 250 ms / 5 次尝试的整幅连续两帧门禁（`tests/unit/capture-minesweeper-determinism.test.ts` 钉住预热、滚动、稳定帧与 ready 采样接线）；
  - 只有整幅 bytes 的 sha256 等于清单条目才通过 `capturedBytes` 走原有固定环境护栏与原子写；最多 20 个 fresh page，耗尽时抛错且不写任何文件；
  - `--allow-new-bytes` 仍是有意改图出口；未收录清单时退回单页采样（仍走两帧门禁）且不比对清单 sha256。没有降低 `verify:screenshots:sha256` / `verify:screenshots:repro` 的校验。
- 验收（2026-11-20，固定镜像 `mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f`，宿主 12 个 `yes`，观察到的 1 分钟 load average 约 19–20）：`PREVIEW_PORT=4500 npm run verify:screenshots:repro -- --target screenshots:minesweeper:webkit --runs 4` 退出 0；4/4 跑 ready = `56c3f68d…`、playing = `b64d959f…`、lost = `6b888d33…`、won = `77e7b244…`，每跑 `node scripts/verify-screenshot-sha256.mjs --log test-results/screenshot-repro/screenshots-minesweeper-webkit-run<N>.log` 退出 0；4 跑的 ready 都第一张采样即命中清单，lost 在 run3 先采到 `182e269c…`、`cc121c27…` 后由 fresh page 命中清单，说明重采样在负载下按预期丢弃变体。
- 追加压力验收（2026-11-20，同一固定镜像，宿主 16 个 `yes`，观察到的 1 分钟 load average 约 24–26）：`PREVIEW_PORT=4501 npm run verify:screenshots:repro -- --target screenshots:minesweeper:webkit --runs 8` 退出 0；8/8 跑四个文件全部等于清单，每跑 `node scripts/verify-screenshot-sha256.mjs --log test-results/screenshot-repro/screenshots-minesweeper-webkit-run<N>.log` 退出 0。ready 在 run2（连续 3 次 `c463b380…`）、run3 / run4 / run8（各 1 次 `c463b380…`）、run7（`d7f827a2…` 后 `c463b380…`）先采到已知变体，全部在后续 fresh page 命中 `56c3f68d…` 后才写盘；run1 / run5 / run6 第一张采样即命中。playing 在 run8 先采到 `1b734cb6…` 两次，lost 在 run1 / run3 / run5 / run6 / run8 也各有变体（run5 连续 5 次），均由后续 fresh page 命中清单。日志 `test-results/screenshot-repro/screenshots-minesweeper-webkit-run{1..8}.log`（同样为未入库的本地证据）。
- 证据限制：除 t3 已列的固定环境 / 真机边界外，重采样在持续负载下可能耗尽 20 个 fresh page 并失败且不写盘；本次验收未耗尽。

### 2048 ready 的负载相关栅格与清单外口径（Issue #374 t1）

- 现象与归因：Issue #374 记录固定容器 + 宿主 12 个 `yes` 负载下 `after-2048-ready-webkit.png` 写成 `d8a808b0…`（相对 `0ea38c8d…` 差 10728 px：共享页眉 1833 px + READY 卡片 / 背板 8895 px，每通道最大 2）或 `672285de…`（仅页眉 1833 px，每通道最大 1）。#199 t1 的滚动往返、overlay 重绘与 `{ stable: true }` 连续两帧门禁让每一次捕获内部的栅格跨帧保持字节稳定；但“这一次捕获选中哪个变体”会随负载 / 进程变化，因此帧门禁只能证明“本次帧内稳定”，不能证明取到规范栅格。该变体与 #341 t3 的共享 header 接缝无关。
- 为什么不再重采样：复审在 head `649ac5b` 上用同一负载独立复现，run1 的 ready 在 20 个 fresh page 内始终没有出现 `0ea38c8d…`，只采到 `672285de…` / `d8a808b0…` / `1f45d828…`，repro 退出 1。本次修复的诊断在同一固定容器、宿主 12 个 `yes` 下进一步确认：
  - 同一 browser 进程内连续 24 个 fresh page（实验页数，仅用于观察变体连续性；实际重采样预算是 20 页）：第 1 页 = `0ea38c8d…`，第 2–21 页连续 = `672285de…`，第 22 页 = `0ea38c8d…`，第 23–24 页又回到 `672285de…`；错误变体不是每页独立重掷，20 页预算可能整段错过。
  - 6 次全新 browser 进程（无预热）的首个 READY 采样只有 1 次 `0ea38c8d…`；另一组「预热 + 首采样」的全新 browser 进程在停止前也全部是 `672285de…`，没有出现规范字节。重启 browser 进程不能可靠换回规范栅格。
  - 在 seam 之后额外等待 1 s 的 2 次样本为 `0ea38c8d…`（CANONICAL）/ `672285de…`；等待 3 s 的 2 次样本均为 `d8a808b0…`（`test-results/experiment2-load.log` 的 E3 段：`E3-wait-1000-browser-1` / `E3-wait-1000-browser-2` / `E3-wait-3000-browser-1` / `E3-wait-3000-browser-2`）。变体是已完成并缓存的合成结果，不是等待不够。
  - 这些日志是 `test-results/` 下的本地产物，未入库；`672285de…` 与 `d8a808b0…` 的像素差与上文 #374 / #341 t3 记录一致。
- 处理：#374 t1 的验收原文允许两条路——让 ready 可靠收敛，或按 #318 口径移出“重跑必须等于清单”的集合。既然 20 页预算在复审的负载下已经实测失败，继续加大预算仍是概率性规避，本次选择第二条：
  - `docs/screenshots/capture-sha256-manifest.json` 不再收录 `after-2048-ready-webkit.png`；`verify:screenshots:sha256` 与夜间 `verify:screenshots:repro` 只对 14 张可稳定复现的证据做逐字节校验。
  - `scripts/capture-2048-screenshots.mjs` 的 ready 路径保留一次性预热页、`settleWebkitReadyPaint` 滚动往返、`repaintWebkitReadyOverlay` overlay 重绘与 `{ stable: true }` 连续两帧门禁，单页写入，不再进入 `captureManifestedScreenshot` 的 fresh-page 清单重采样。
  - ready 仍属于固定 `webkit` 环境：写盘前调用 `checkReadyCaptureEnvironment`，以已收录的 `after-2048-playing-webkit.png` 条目做 `checkOnly` 环境比较；宿主运行或镜像 / EGL / 字体 / DPR 不一致时在写 ready 前失败，不会用宿主渲染覆盖已提交 PNG；`requireRecorded` 让清单缺失或 playing 条目不存在时也直接失败，而不是退化成无护栏写入。
  - playing / gameover 的共享 header 接缝、fresh-page 清单重采样与 `--allow-new-bytes` 出口保持不变；已提交 PNG 与清单中另外 14 张记录不变。
- 单测：`tests/unit/capture-2048-determinism.test.ts` 钉住 ready 为清单外单页捕获（预热页 `try/finally`、两条接缝顺序、playing 条目环境校验、`{ stable: true }`、ready 页 `try/finally`），并断言清单不含该文件、重采样只覆盖 playing / gameover 两张；删除预热页、任一接缝、环境校验或两帧门禁，或把 ready 重新接回清单重采样，都会让用例失败。
- 验收：见下一条“验收记录”。该口径不把 ready 的负载变体当成可复现证据，也不通过放宽其他图片的校验来换取绿色：`verify:screenshots:sha256` 仍逐张校验 14 张清单记录，`verify:screenshots:repro` 仍对 2048 playing / gameover 与扫雷四态做 4 跑逐字节比较。
- 验收记录（2026-11-20，固定镜像 `mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f`，宿主 12 个 `yes`，load average 13.92 → 23.08）：`PREVIEW_PORT=4520 npm run verify:screenshots:repro -- --target screenshots:2048:webkit --runs 4` 退出 0；playing 4/4 = `4173dce8…`、gameover 4/4 = `bf7548b7…`，4 跑日志均通过 `--log` 校验。ready 不在比较集合内，并如预期被重写（该次 repro 的 run1 后为 `d8a808b0…`，4 跑结束后为 `672285de…`）。随后在同一负载下单独跑 `PREVIEW_PORT=4530 npm run screenshots:container -- screenshots:2048:webkit` 四次、每次跑后立即取 sha256，得到：

  | 跑次 | 开始时 1 分钟 load | ready | playing | gameover |
  | --- | --- | --- | --- | --- |
  | 1 | 3.88 | `d8a808b0…` | `4173dce8…` | `bf7548b7…` |
  | 2 | 14.44 | `d8a808b0…` | `4173dce8…` | `bf7548b7…` |
  | 3 | 21.89 | `0ea38c8d…` | `4173dce8…` | `bf7548b7…` |
  | 4 | 23.69 | `672285de…` | `4173dce8…` | `bf7548b7…` |

  同一组负载下 ready 在 4 次捕获里选中了 3 种字节，且 run3 仍能取到规范 `0ea38c8d…`；playing / gameover 则 4/4 命中清单。这直接说明 ready 的“单次帧内稳定”与“跨次可复现”是两件事，也解释了为什么 20 页预算是概率性的。验收后已把工作区的 ready PNG 恢复到已提交的 `0ea38c8d…`，没有把负载变体提交。`npm run verify:screenshots:sha256` 在同一工作区退出 0，校验 14 张清单记录。合入 #379 后同一条 repro 入口也支持 `--load 12`；本次用 `PREVIEW_PORT=4521 npm run verify:screenshots:repro -- --target screenshots:2048:webkit --runs 1 --load 12` 确认负载注入可用（退出 0，12/12 worker 正常启停），4 跑验收仍用宿主机 12 个 `yes`。日志 `test-results/repro-2048-load.log`、`test-results/repro-load12.log`、`test-results/ready-variants.log` 与 `test-results/screenshot-repro/screenshots-2048-webkit-run{1..4}.log`（本地产物，未入库）。
- 证据限制：负载验收只覆盖 Linux WebKit 软件栅格与固定字体 / 镜像；真机 iOS Safari 的合成行为不在本证据内。`screenshots:2048:webkit` 在负载下会把 ready 重写成当时的 1-LSB 变体（这是清单外视觉证据，不参与验收）；CI 只在工作区写该文件，不提交，也不检查它的 git 状态；人工重拍后如需提交，应先确认它代表当前 UI，而不是把负载变体当成规范字节。

## t7：扫雷触屏与手机布局（Issue #33 / 子任务 2）

- Before 基线：`60bc3f3`（PR #36 合入扫雷 DOM 视图后、本子任务触屏与手机布局改动前）。页面已有桌面鼠标操作；手机视口下轻点可以翻开，但没有触屏插旗，重开按钮位于首屏之外。
- After：本子任务分支 `agent/plan-33-t2`。手机与桌面 After 截图在提交 [`c7bdade`](https://github.com/yeahdongcn-mk2/playground/commit/c7bdade) 捕获并入库；其后 `fbbe118` 只调整触屏交互逻辑与测试、把触屏提示 / 手机重开按钮的显示条件从 `(hover: none) and (pointer: coarse)` 放宽到 `any-pointer: coarse`，并同步 README 与截图脚本；`f36826f` 重截 `before-minesweeper-playing-mobile.png` 并对齐本文件引用，静态截图的界面视觉未变，因此这些 After 截图仍代表当前 head。Before 截图由 `60bc3f3` 构建生成，同样在 `c7bdade` 入库（游玩中一张在 `f36826f` 重截）。PR [#38](https://github.com/yeahdongcn-mk2/playground/pull/38) 描述附有 4 组 Before / After 链接。
- 视口 / 主题：Pixel 7（412×839 CSS px，DPR 2.625，`isMobile: true`、`hasTouch: true`），深色主题，`reducedMotion: reduce`。Before / After 使用同一场景、同一视口、同一状态，均为视口截图（`fullPage: false`），以便核对 HUD、返回大厅与重开入口在手机首屏内完整可见。
- 指纹口径：这些手机玩法图属于独立的 `mobile-touch` 捕获目标；Chromium 触屏上下文会打印 `target=mobile-touch dpr=2.625`，与 `target=desktop dpr=1`、`target=mobile dpr=2` 各占一行（每个目标一行，同一目标每次运行只打印一行）。容器内该行以 `source=container` 开头，镜像 tag / digest 与 EGL 变量按「固定捕获环境」的契约固定。
- 容器复现：After 用 `npm run screenshots:container -- screenshots:minesweeper`（入口注入 `desktop,mobile-touch` / `1,2.625`；这 4 张 After 属历史证据，确需重建时按上一行加 `--allow-historical-overwrite`）；Before 用 `BASE_URL=http://127.0.0.1:4188 npm run screenshots:container -- screenshots:minesweeper:touch-before`（入口只注入 `mobile-touch` / `2.625`），并在 `60bc3f3` 的基线 worktree 提供 preview。两条命令都按目标逐行打印指纹。
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

以上 4 张手机玩法图同样是历史证据：最后捕获于 `993f5e7`（#61），当前构建重跑尺寸仍为 1082×2202，但 ready / playing / lost / won 分别约有 50.8 / 50.9 / 50.7 / 56.1 万像素不同，范围约 50.7–56.1 万像素。原因是 #85 最高用时榜、#87「清空记录」等侧栏 UI 变更后未重拍；它们只代表 #61 时点的 UI，不能作为当前构建「重跑必须逐字节一致」的基准。权威对照口径见文首「历史 After 证据与当前构建不一致（Issue #137）」。已提交的 8 张 `before/after-minesweeper-{ready,playing,lost,won}-mobile.png` 保持 Pixel 7 412×839、PNG IHDR 1082×2202；本子任务不重拍、不改动任何 PNG，`tests/unit/screenshot-target-docs.test.ts` 会逐张校验这 8 个 IHDR，防止文档与证据再次漂移。

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
- 游玩截图确定性：`openPlaying()` 固定 `?debug=1&seed=7&steps=120`。点击「开始游戏」后，调试接缝在下一帧内以引擎固定的 120 Hz 步长（`FIXED_STEP_MS`）精确推进 120 个固定步（约 1 秒模拟时间），随后暂停主循环；截图脚本等待 `data-debug-steps=120` 标记后再截图。所以球、挡板与砖块状态只由 seed 与步数决定，不依赖真实帧时序。因此 3 张 `after-breakout-playing-{desktop,mobile,webkit}.png` 是确定性产物：同一构建、预览端口 4185 空闲时连续两次执行 `npm run screenshots:breakout`（以及固定容器内的 `npm run screenshots:container -- screenshots:breakout:webkit`）得到的 sha256 完全一致，并等于已提交产物；ready / levelclear / gameover 等未走该接缝的图不受影响；共享大厅证据不由该命令写出。复现命令：`npm run screenshots:breakout && npm run screenshots:container -- screenshots:breakout:webkit`，随后用 `sha256sum docs/screenshots/after-breakout-playing-{desktop,mobile,webkit}.png` 对照。WebKit 产物在官方 Playwright 容器（`mcr.microsoft.com/playwright:v1.64.1-noble`，与仓库的 Playwright 1.64.1 对应）内捕获，避免宿主 EGL / 字体环境差异。本子任务重生成的桌面整页 playing 图带当前页脚，与其余 desktop 图的旧页脚不一致；页脚漂移统一由 #137 跟踪，不影响本子任务的确定性验收。
- 预览端口：默认 `4185`；共享主机或并行 worktree 用 `PREVIEW_PORT=4186 npm run screenshots:breakout` 覆盖（`PREVIEW_PORT` 为空串时回退 `4185`；`screenshots:breakout:webkit` 复用同一启动路径与端口）。端口已被占用时脚本在启动 preview 前以非零状态退出，错误包含实际端口、`the port is already in use` 与 `Set PREVIEW_PORT` 建议，不会写出或覆盖任何截图；端口探测通过后 preview 提前退出时报告子进程退出码与 stderr，不再静默连到端口上的其它服务。Before 模式（`screenshots:breakout:before`）以 `BASE_URL` 为准，不启动 preview、不探测 preview 端口；`npm run screenshots:container` 与此一致，`BASE_URL` 非空时跳过宿主预览端口预检，只有 `BASE_URL` 为空、容器内会自行启动 preview 时才探测默认 `4185`。
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
- 预览端口：默认 `4183`；共享主机或并行 worktree 用 `PREVIEW_PORT=4184 npm run screenshots:2048` 覆盖（`PREVIEW_PORT` 为空串时回退 `4183`；`screenshots:2048:webkit` 复用同一启动路径与端口）。端口已被占用时脚本在启动 preview 前以非零状态退出，错误包含实际端口、`the port is already in use` 与 `Set PREVIEW_PORT` 建议，不会写出或覆盖任何截图；端口探测通过后 preview 提前退出时报告子进程退出码与 stderr，不再静默连到端口上的其它服务。Before 模式（`screenshots:2048:before`）以 `BASE_URL` 为准，不启动 preview、不探测 preview 端口；`npm run screenshots:container` 与此一致，`BASE_URL` 非空时跳过宿主预览端口预检，只有 `BASE_URL` 为空、容器内会自行启动 preview 时才探测默认 `4183`。
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

### 确定性重截（ready / playing / gameover）

- 调试接缝：生产构建在 URL 带 `debug` 参数时启用（例如 `?debug=1`），开发服务器默认启用（与 `README.md` 的说明一致）。`seed` 是有限数字时按其播种，缺省或非法（空白、`abc`、`Infinity`、`NaN`）回退 `1`。生产构建不带 `debug` 时保持原有的随机初始局面与随机生成；开发服务器即使不带 `debug` / `seed` 也会启用调试接缝并使用默认 seed `1`，因此初始局面是固定的。
- 固定参数：`seed=135`，playing / gameover 都只按一次 `ArrowLeft`。
  - playing：`MERGE_BOARD` = `2,2,4,4/8,8,16,16/.,.,.,./.,.,.,.`，合并后得分 `60`，seed 135 在 `(0,3)` 生成 `2`。
  - gameover：`STUCK_BOARD` = `2,2,16,8/8,4,2,16/4,8,16,2/16,2,4,8`，左移后只剩 `(0,3)` 空格，seed 135 生成 `2`，结算文本为 `本局 4 分 · 最大方块 16`。
- 复现命令（同一构建、预览端口空闲；Chromium 与 WebKit 分开执行并各跑两次）：
  ```sh
  npm run screenshots:2048
  npm run screenshots:container -- screenshots:2048:webkit
  sha256sum docs/screenshots/after-2048-{playing,gameover}-{desktop,mobile,webkit}.png
  ```
  两次运行的 6 个 sha256 应完全一致，且等于已提交产物（`after-2048-ready-webkit.png` 自 Issue #374 起不在逐字节清单内，不参与这条断言）。本 PR 只改动 `after-2048-ready-webkit.png`，playing / gameover 的已提交产物保持不变；After 守卫会跳过 ready 桌面 / 手机历史图，WebKit ready 已由 #199 t1 移出历史清单并曾纳入固定环境 sha256 清单，Issue #374 起又移出逐字节清单（保留单页两帧门禁与 playing 条目环境校验）。该命令不再写共享大厅证据（共享大厅图由 `scripts/capture-screenshots.mjs` 写出，`after-hub-webkit.png` 是独立的 WebKit 视口证据），因此提交时不需要再还原这两张共享图。WebKit 产物在官方 Playwright 容器（`mcr.microsoft.com/playwright:v1.64.1-noble`，与仓库的 Playwright 1.64.1 对应）内捕获，避免宿主 EGL / 字体环境差异。
- 等待条件：所有状态先等待 `document.fonts.ready` 与两个 `requestAnimationFrame`（让最后的状态变更完成画布绘制）；playing / gameover 另等 gameover 的 `本局 4 分 · 最大方块 16` 结算文本。WebKit ready 还先做一次滚动往返（离开页面顶部再回到顶部）强制定格 sticky 页眉，再把 READY overlay 隐藏两帧后恢复（`repaintWebkitReadyOverlay`），最后用 `captureStableBytes()` 等到连续两张截图逐字节一致才落盘；仍不稳定就失败，不写抖动帧。Issue #374 随后为 ready 增加一次性预热页并把它移出清单：提交页仍重跑上述滚动往返 / overlay 重绘，并以 `captureStableBytes` 连续两帧门禁单页落盘；写盘前用已收录的 `after-2048-playing-webkit.png` 条目做 `checkOnly` 固定环境校验，ready 不参与 fresh-page 清单字节重采样。
- 共享 header 接缝（Issue #341 t3）：WebKit playing 在 `settle(playing)` 之后、截图之前调用 `settleSharedHeaderCompositing(playing)`；gameover 在 `settle(over)` 之后用 `settleBackdropLayersCompositing(over)` 在同一帧重建共享页眉与 game-over 卡片的半透明背板，不再额外调用 header-only 接缝。playing / gameover 再从 fresh page 有界重采样直到整幅 sha256 命中清单；ready 不在清单内，也不再重采样。同一 12+ `yes` 负载下 playing / gameover 4/4 跑为 `4173dce8` / `bf7548b7`，ready 的 4 次捕获则是 `d8a808b0` / `d8a808b0` / `0ea38c8d` / `672285de`，见「2048 playing/gameover 与扫雷 lost 等状态的共享 header 接缝（Issue #341 t3）」与「2048 ready 的负载相关栅格与清单外口径」。
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
- 提交范围：After 守卫会跳过 ready / gameover / mobile 历史图；该命令不再写共享大厅证据（`after-hub-*.png` 只由 `npm run screenshots:container -- screenshots` 写入），提交时只保留本任务的 `after-snake-playing.png` 与文档 / 测试改动，未受影响的已提交产物保持不变。
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
- 确定性条件：`reducedMotion: reduce` 下目标圆环不脉冲、orb 缩放固定为 1；orb 到达目标后场景把 `target` 置空并精确落到点击点，trail 按 1.15 s 生命衰减并从数组移除。等 `data-trail="0"` 后画面只剩固定 backdrop / 网格 / 静态 orb，不再随时间变化，因此同一构建的截图在场景内逐字节一致；正常交互没有变化，也不需要新增调试接缝。WebKit 空白路径还额外等待共享 header 的字体并在截图前重绘其 `backdrop-filter` 快照（`settleSharedHeaderCompositing`，blank 路径经 `settleBlankHeader` 复用，见下条），避免站点头部在路由切换后以每通道 1 个色阶的差异被合成；正常页面渲染不变，也不是产品调试接缝。
- WebKit 共享 header 合成落定（Issue #326）：`waitForBlankSettled` 只证明空白 canvas 停稳；站点共享 header 在客户端路由切换后仍可能以另一份 `backdrop-filter: blur(18px)` 合成结果入库。未加接缝时在同一固定容器内连续重拍 15 跑（2026-11-19，含 `npm ci` 后的首跑），12 跑得到 `cd4ed3fe…`、3 跑得到 `5569689d97ee9dadf8725dd5e8d043acf758ce92d56731f0f4d1ea53c4b9be95`；两版都是 750×1334，差异恰好 1892 个像素，bbox rows 23–114 / cols 24–725（共享 header），每通道最大差 1，空白 canvas、HUD 与画布外区域逐像素一致；同一批 15 跑里 `after-hub-webkit.png` 全部为 `6c2856e3…`。通用接缝 `settleSharedHeaderCompositing`（`scripts/lib/webkit-compositing-settle.mjs`）等待 `document.fonts.ready`，把目标 header 的 `backdrop-filter` / `-webkit-backdrop-filter` 置为 `none` 并等待 2 次 commit（每次双 `requestAnimationFrame`），再恢复空值（移除内联覆盖，未加前缀的 `backdrop-filter` 回落到样式表的 `blur(18px)`，`-webkit-backdrop-filter` 清除内联值）并等待 2 次 commit；header 找不到时捕获直接失败，不会静默跳过。blank 路径由 `settleBlankHeader`（`scripts/lib/blank-settle.mjs`）复用同一实现，只在空白场景 settle 之后、`after-blank-webkit.png` 截图之前运行；任意 WebKit capture 都可向通用模块传入自定义 `selector` / `frames` / `evaluate`（Issue #341 t1 抽出该模块，供 t2 / t3 使用）。`captureWebkitMobile` 现在调用同一模块三处：hub 截图前的共享 header 接缝、hub 截图前的 hero 动画落定（`settleHubHeroCompositing`，Issue #341 t2，见「大厅复核」）与 blank 场景 settle 之后的 `settleBlankHeader`；Chromium desktop / mobile 与正常页面渲染都不经过这些接缝。加 blank 接缝后 2026-11-19 在同一固定容器连续 16 跑（宿主并发负载，load average 峰值约 30；当时 hub 路径尚未接入，hub 路径的 4 跑见「大厅复核」）sha256 全部为 `cd4ed3fea1e0a068661c8102ee0b58b0601b3a249e480d76224d22782a0e088f`，`after-hub-webkit.png` 全部为 `6c2856e33a5619dc2eff5833c059608c74f03492192029515edf345b165581f4`，16 份日志的 capture-env 指纹逐项一致且分别执行 `node scripts/verify-screenshot-sha256.mjs --log <log>` 全部退出 0。这些运行早于 #329 的修复：当时的 `--log` 只校验当前 PNG 与日志环境指纹、不读取日志内的 captured sha256，因此每跑字节相等仍由每跑写后 `sha256sum` 的 `cd4ed3fe…` 与写前护栏共同证明，不应把它们说成已被新的日志哈希校验验证过。字节未变，因此 `capture-sha256-manifest.json` 的 `sha256` / `provenance.captureCommit` 与本表都不改动；本条只记录本次漂移与新增接缝。Issue #341 t2 的 hub 差分与 4 跑验证见「大厅复核」：hub 的主体漂移不是 header，而是 hero orb 的 reduced-motion 动画残留；同一模块新增 `settleHubHeroCompositing` 处理它，hub 的 header 接缝仍保留（该变体里 header 也有 2429 个像素差 1 个色阶）。
- 验证噪声：2026-11-19 首次 `npm run verify:screenshots:repro` 在宿主并发负载下失败，失败不在 blank：`screenshots:webkit` 首跑把 `after-hub-webkit.png` 写成 `99dfef398ad544f4c1f496904d9f8e015867a8827e614bfef78a3c95dc714571`（第二跑回到 `6c2856e3…`），该 hub 部分已由 Issue #341 t2 在 hub 截图前接入共享 header 接缝修复（见「大厅复核」）；`screenshots:minesweeper:scores:webkit` 第二跑把 `after-minesweeper-scores-webkit.png` 写成 `b7f08eac34dbf325f00bbbb195f9726b49b03a207acd9e17e6bf3249eb21c89d`（相对清单 3416 个像素差，rows 2853–2944，每通道最大差 1），scores 部分仍不在本条范围。`after-blank-webkit.png` 在该轮两跑均为 `cd4ed3fe…`，`after-breakout-playing-webkit.png` 本轮仍为 `27297f5f…`（未触发 #328）。宿主负载回落后用 `PREVIEW_PORT=4212 npm run verify:screenshots:repro` 重跑通过：6 个 target × 2 跑、15 个文件同时等于清单与彼此，`after-blank-webkit.png` / `after-hub-webkit.png` 均等于清单；`PREVIEW_PORT` 只改变 preview 监听端口，不进入 capture-env 指纹，也不影响像素。
- 复现（同一构建、预览端口 4174 空闲；Chromium 在宿主、WebKit 在固定容器内各跑至少两次；WebKit 空白图按 Issue #326、hub 图按 Issue #341 t2 改为固定容器内连跑至少 4 次，并包含一次冷启动或并发负载）：

  ```sh
  npm run screenshots
  npm run screenshots:container -- screenshots:webkit
  sha256sum docs/screenshots/after-blank-{desktop,mobile,webkit}.png
  ```

  上述次数的运行（WebKit 至少 4 次）写出的 3 个 sha256 应完全一致，并等于已提交产物：`after-blank-desktop.png` `24c34e278b7272834077ea6696cc0b5087d87dfb20323ec796ba97c719f3fb47`、`after-blank-mobile.png` `a097836e00acfe0c9965ecde6e72b7f40b366e4bdd82b1d6af705bcbefa685ff`、`after-blank-webkit.png` `cd4ed3fea1e0a068661c8102ee0b58b0601b3a249e480d76224d22782a0e088f`；同一条 WebKit 命令写出的 `after-hub-webkit.png` 也应为 `6c2856e33a5619dc2eff5833c059608c74f03492192029515edf345b165581f4`（Issue #341 t2）。WebKit 产物在官方 Playwright 容器（`mcr.microsoft.com/playwright:v1.64.1-noble`，与仓库的 Playwright 1.64.1 对应）内捕获，避免宿主 EGL / 字体环境差异（本机直接运行会因 `Could not create surfaceless EGL display` 失败）。
- Before / After：旧产物 sha256 分别为 `0aa5b5d35c5c4894423f8a37fb97bddf0731206a1435a786ae3a4be01a14f0c6`、`155681ac86f01f8d7b728e2e0569b30a9fbc519565744087f7524dc54b1fb5d3`、`5274dcadc087a17f0e03e243edc4be83ab2f743d8a908e9d64943ced384230b8`；本轮 3 张图都按上述等待重新生成。旧 desktop / mobile 产物来自 t2 时期，后续任务改过页面文案与布局，因此新旧图的差异不只在 orb / trail 位置；本子任务只对当前 head 的逐字节可复现性负责，不把旧图当作像素级回归基准。`after-blank-desktop.png` 是 1440×1000 视口截图（`fullPage: false`），不是整页图，不包含页脚；`npm run screenshots`（owner 命令）仍会写出 hub 图，提交前用 `git checkout -- docs/screenshots/after-hub-*.png` 还原，保持未受影响的已提交产物不变。
- 回归护栏：`tests/unit/capture-blank-determinism.test.ts` 用 fake page 运行时覆盖 `scripts/lib/blank-settle.mjs` 的 `waitForBlankSettled`（未连续 N 次落点且 `trail` 未清零就不返回、移动会重置连续计数、超时带最后读数报错）与 `nextBlankStableStreak`，并静态钉住 `capture-screenshots.mjs` 的 `tapBlankCanvas` 内确实 `await waitForBlankSettled(page, target)`、3 个场景都走同一等待、脚本不再含 `waitForTimeout(700)`、`view.ts` 暴露 `data-trail`。删除该等待会让单测失败。Issue #326 的 header 接缝现在由通用模块与 blank 包装共同覆盖：`tests/unit/webkit-compositing-settle.test.ts` 用 jsdom 运行时测试 `settleSharedHeaderCompositing` / `repaintSharedHeader` 必须等待 `document.fonts.ready`，在两次 toggle 之间各等待配置的 commit 数，最后恢复为空值，header 缺失时抛错，并覆盖注入 `evaluate` 与自定义 `selector` / `frames` 的非 blank 编排；`tests/unit/capture-blank-determinism.test.ts` 静态钉住 `captureWebkitMobile` 中 `tapBlankCanvas` → `settleBlankHeader` → `after-blank-webkit.png` 的顺序、该接缝只出现一次且不进入 hub / Chromium 空白路径，断言 blank 模块只复用通用模块而不保留第二套 toggle / rAF 实现，并把选择器与 `src/app/app.ts` 的真实 `.site-header` 关联。Issue #341 t2 的 hub 接线由 `tests/unit/capture-hub-determinism.test.ts` 钉住：`captureWebkitMobile` 里 `settleSharedHeaderCompositing` 与 `settleHubHeroCompositing` 都必须位于 hub 加载之后、`after-hub-webkit.png` 截图之前且各出现一次（hero 动画落定最靠近截图），blank 路径的顺序保持不变，Chromium 的 `captureDesktop` / `captureMobile` 不得调用它们；jsdom 运行时用例证明 `settleHubHeroAnimations` 会先 finish 动画、等动画全部结束后才走配置的 commit 等待，动画仍在跑时抛错，复用同一 jsdom 用例证明 header / hero 缺失时捕获失败而不是静默跳过。删除调用、少一次 toggle / commit 等待、去掉恢复或跳过缺失元素都会让单测失败。

### 证据限制

- 起点没有应用 UI，所以 Before 只能是 base commit 的仓库页，无法提供“同一应用场景”的旧版截图；Before / After 的页面内容不同，不能逐像素比较。
- 手机端为 Playwright 设备模拟（Pixel 7 视口与触摸），不是真实设备截图。
