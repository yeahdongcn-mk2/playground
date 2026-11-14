# CI flaky 与稳定性门禁口径

本文固定 Playwright 测试在 CI 中的 passed / flaky / failed 判定、稳定性门禁的覆盖范围、每日巡检方式和 flake 的 triage 步骤。实现见 `.github/workflows/ci.yml`、`.github/workflows/flake-watch.yml`、`scripts/check-e2e-flakes.mjs` 与 `scripts/flake-watch-summary.mjs`。

## 1. 判定口径

`playwright.config.ts` 在 CI 下设置 `retries: 2`，即每个用例首跑后最多再重试 2 次。据此固定三种口径：

| 口径 | 判定 | Playwright JSON 报告状态 |
| --- | --- | --- |
| passed | 首跑（第 1 次尝试）通过，没有使用重试。 | `expected`，且第 1 次结果就是 `passed`。 |
| flaky | 首跑失败，重试后通过。 | `flaky`。 |
| failed | 重试用尽仍失败（CI 下最多 3 次尝试都失败）。 | `unexpected`。 |

flaky 不等于 passed：它说明用例首跑不稳定，只是这次被重试救了回来。failed 是确定性失败，`End-to-end tests` 步骤本身就会把 CI 判红。

## 2. 常规 PR CI 的门禁范围

`.github/workflows/ci.yml` 的 `End-to-end tests` 步骤照常运行全部 Playwright 项目，并在 CI 下把 JSON 报告写到 `test-results/e2e-report.json`；`retries: 2` 保持不变。

紧跟在 `End-to-end tests` 之后的 `Check target e2e flakes` 步骤运行：

```bash
node scripts/check-e2e-flakes.mjs
```

该检查只读取本次 e2e 的 JSON 报告，保护 `mobile-webkit` 项目中标题包含 `hub and blank canvas` 的 framework 手机端用例（`tests/e2e/framework-mobile-cases.ts` 的「hub and blank canvas fit a phone viewport」）。门禁结论：

- 目标用例首跑通过：检查通过。
- 目标用例 flaky：检查失败，并打印 project / 用例标题、重试次数、首跑错误和报告路径。
- 目标用例 failed：`End-to-end tests` 已经先失败并中止 workflow，不需要该检查重复报错。
- 目标用例被跳过、报告缺失或报告里找不到目标用例：检查失败，不能把「没有验证到」当成稳定性通过。

其他项目与其他用例不在这个 gate 的范围内：它们继续使用 `retries: 2`，即使首跑失败、重试后通过，也只记录为 flaky，不会让 `Check target e2e flakes` 失败。

## 3. 每日 flake-watch 巡检

PR CI 不重复跑目标用例；首跑稳定性由独立的 `.github/workflows/flake-watch.yml`（workflow 名 `Flake watch`）每天巡检：

- 只由 `schedule`（cron `17 3 * * *`，UTC）和手动 `workflow_dispatch` 触发，没有 `push` / `pull_request` 触发；
- job `mobile-webkit first-run stability` 的步骤 `Repeat the mobile-webkit hub case five times` 执行：

```bash
npx playwright test \
  --project=mobile-webkit \
  -g "hub and blank canvas" \
  --repeat-each=5 \
  --retries=0 \
  --trace=retain-on-failure
```

`--repeat-each=5 --retries=0` 让 5 次重复都按首跑计，任何一次冷启动失败都不会被重试掩盖。步骤 `Summarize first-run results` 调用 `node scripts/flake-watch-summary.mjs`，把重复次数、重试次数、首跑通过 / 失败 / flaky / 跳过统计写入 job summary；失败的 trace、截图与 JSON 报告通过 `test-results/` 上传保留。

该巡检是定时任务，不在 PR 关键路径上；PR 的门禁仍只依赖当次 e2e 的 JSON 报告。

## 4. CI 时长与误报成本

- **PR 时长**：`Check target e2e flakes` 只多一次 JSON 报告解析，不重跑 e2e、不增加浏览器启动；`ci.yml` 的 20 分钟超时保持不变。
- **定时巡检**：`flake-watch.yml` 是独立 job（30 分钟超时），5 次重复只占用定时任务的 runner 时间，不拉长任何 PR。
- **误报成本**：目标用例偶发失败时，门禁会判红并要求人工 triage（这是有意的稳定性信号）；其他用例的 flaky 仍可能以 success 放行，属于本次门禁覆盖范围之外的成本。

## 5. Playwright 运行环境：固定镜像

Issue #213 起，`ci.yml` 的 `verify` job 与 `.github/workflows/flake-watch.yml` 的 `mobile-webkit-first-run` job 都直接运行在固定 tag + digest 的官方 Playwright 镜像里，不再在运行时用 `--with-deps` 安装浏览器（背景见 Issue #202）：

- **镜像与版本对齐**：两个 job 的 `container.image` 都是 `mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f`。tag 的版本来自 `package-lock.json` 的 `@playwright/test`（当前 1.64.1），digest 固定多架构镜像；两者与 `scripts/lib/capture-env.mjs` 的 `PLAYWRIGHT_IMAGE_PIN` 同源。`tests/unit/ci-workflow.test.ts` 与 `tests/unit/flake-watch-workflow.test.ts` 分别校验各自 workflow、`PLAYWRIGHT_IMAGE_PIN` 与 lockfile 一致，且两个 workflow 使用同一镜像，任一处漂移都会让单测失败。
- **容器 IPC**：两个 job 的 `container.options` 都包含 `--ipc=host`，与 `scripts/run-container-capture.mjs` 的截图容器一致。GitHub container job 默认 `/dev/shm` 只有 64 MB；Playwright 官方建议 Chromium 在 Docker 下使用 host IPC，避免共享内存不足导致的偶发崩溃。
- **pre-commit 安装**：镜像自带的 `/usr/bin/python3` 没有 pip（也没有 `ensurepip`）；本次 runner 的 `actions/setup-python` toolcache CPython 在容器内无法加载 `ssl` 模块（[run 43560696477](https://github.com/yeahdongcn-mk2/playground/actions/runs/43560696477)：`pip is configured with locations that require TLS/SSL ... ssl module is not available`），所以 `-m pip` 无法访问 PyPI。镜像的 `/usr/bin/python3` 自带可用的 OpenSSL，因此 `Install pre-commit` 先下载 [get-pip.py](https://bootstrap.pypa.io/get-pip.py) 并用 `--break-system-packages` 为它 bootstrap pip，再执行 `/usr/bin/python3 -m pip install --break-system-packages ... pre-commit==4.7.0`（容器是一次性环境，PEP 668 的 externally-managed 限制显式放开），最后用 `pre-commit --version` 自检；首次的裸 `pip` 失败见 [run 43558572972](https://github.com/yeahdongcn-mk2/playground/actions/runs/43558572972)（`pip: not found`）。`verify` 不再需要 `Set up Python for pre-commit` 步骤。
- **pre-commit 缓存键**：key 为 `pre-commit-container-${{ runner.os }}-4.7.0-${{ hashFiles('.pre-commit-config.yaml') }}`，前缀 `pre-commit-container-` 把容器缓存与 host 缓存分开。容器 HOME 是 `/github/home`，而 host 上构建的 pre-commit 缓存 `db.db` 存的是绝对 `/home/runner/...` 路径，恢复进容器会 `InvalidManifestError`；改前缀后容器只会保存和复用自己构建的缓存。
- **容器内 git 信任目录**：`actions/checkout` 把 `safe.directory` 写进临时 HOME（日志：`Temporarily overriding HOME=...`），而 `run` 步骤使用容器持久的 `/github/home`；容器以 root 运行在 host 拥有的 workspace mount 上，因此 pre-commit 的 git 调用会报 `dubious ownership`（[run 43561619210](https://github.com/yeahdongcn-mk2/playground/actions/runs/43561619210)）。checkout 之后新增一步 `git config --global --add safe.directory "$GITHUB_WORKSPACE"`，把信任目录持久化。
- **容器默认 shell**：GitHub container job 的 `run` 默认用 `sh`（dash），不支持 `set -o pipefail`。因此 `Install pre-commit` 与 `WebKit narrow screenshot smoke test` 都显式声明 `shell: bash`，保留 `pipefail` 的失败语义。
- **已移除的步骤**：官方镜像内置 Chromium、WebKit、Node 与 WebKit 所需的系统依赖，因此 `verify` 不再有 `Configure apt Acquire retries and timeouts`、`Cache Playwright browsers`、`Install Playwright Chromium and WebKit` 三个步骤，也不再使用 `actions/setup-python`；`flake-watch` 同样不再有 `Configure apt Acquire retries and timeouts`、`Cache Playwright browsers`、`Install Playwright WebKit`，也不再缓存 `~/.cache/ms-playwright`。两个 job 的日志里都不会再出现 `playwright install`、`--with-deps` 或 apt GET。
- **定时巡检**：`flake-watch.yml` 的 `mobile-webkit-first-run` 复用同一个 `container.image` 与 `--ipc=host`，30 分钟预算不变；它同样没有浏览器安装、apt 或 `~/.cache/ms-playwright` 缓存步骤，`--repeat-each=5 --retries=0`、`flake-watch-summary.mjs` 汇总与 `test-results/` 产物上传保持不变。镜像在容器启动时拉取，5 次首跑之前只剩 `npm ci` 与生产构建。
- **flake-watch 验收**：本改动的 [run 43567248722](https://github.com/yeahdongcn-mk2/playground/actions/runs/43567248722) 从分支 `agent/plan-213-t1` 用 `workflow_dispatch` 触发，job 1m10s（镜像拉取 20s、5 次首跑 33.3s），5 次首跑全部通过（单次 4.7–8.9s），日志无 `playwright install`、`--with-deps` 或 apt GET，远低于 30 分钟预算；浏览器来自镜像的 `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`，只复用了 `setup-node` 的 npm 依赖缓存。
- **冷/热验收**：本修复的 [run 43563009824](https://github.com/yeahdongcn-mk2/playground/actions/runs/43563009824) 用两次 attempt 验收：attempt 1 为新推无缓存（`npm cache is not found`、`Cache not found for input keys: pre-commit-container-...`，verify job 4m22s，其中 e2e 3m09s），[attempt 2](https://github.com/yeahdongcn-mk2/playground/actions/runs/43563009824/attempts/2) 为有缓存重跑（`Cache restored from key: pre-commit-container-...`，verify job 4m18s，pre-commit 检查 0s，冷缓存为 3s），两次全部步骤通过且远低于 20 分钟。两次日志均没有 `playwright install`、`--with-deps` 或 apt GET；`Install pre-commit`、`Screenshot doc dimensions`、`End-to-end tests`、`Check target e2e flakes`、`WebKit narrow screenshot smoke test` 均成功。
- **镜像拉取失败边界**：镜像拉取发生在 job 启动阶段、任何步骤之前；tag/digest 不存在或 registry 不可达会立刻以 Docker 拉取错误让 job 失败，不会先跑完前面的步骤再拖到 job 上限。`verify` 的 job 名与 20 分钟预算、`flake-watch` job 的 30 分钟预算都保持不变。

**为什么选官方镜像**：预装浏览器的 runner 镜像需要自建并随 Playwright 版本重建，`ubuntu-latest` 没有按版本预装 Chromium / WebKit 的标签；自托管 runner 还要长期维护主机、系统依赖、扩缩容与隔离，本仓库没有这套基础设施。官方 Playwright 镜像直接发布在 MCR，tag 与 `@playwright/test` 一一对应、digest 可固定，GitHub-hosted runner 可直接拉取，维护成本最低。相对 #202 的有界安装基线（run 43129697008：冷缓存 job 4m37s，热缓存 job 6m50s），`verify` 不再有浏览器安装与 apt 阶段，耗时主要是镜像拉取/初始化容器、get-pip 安装 pre-commit、`npm ci` 与原有检查；本次冷缓存 job 4m22s、热缓存 job 4m18s。

**回退路径**：Issue #202 的有界安装包装 `scripts/install-playwright-ci.mjs` 与其单元测试仍保留，但本改动后没有任何 workflow 调用它。需要临时回退时，把 `Cache Playwright browsers`（缓存 `~/.cache/ms-playwright`，key 为 `playwright-webkit-${{ runner.os }}-${{ hashFiles('package-lock.json') }}`）、`Configure apt Acquire retries and timeouts`（写入 `Acquire::Retries "1"`、`Acquire::http::Timeout "15"` 与 `Acquire::https::Timeout "15"`）与 `Install Playwright WebKit`（`node scripts/install-playwright-ci.mjs webkit`，`timeout-minutes: 8`）三个步骤按原顺序加回 flake-watch job 即可。包装脚本仍是最多尝试 2 次、每次尝试 180 秒超时、失败后 10 秒退避；DNS 抖动（`Temporary failure resolving` / `Could not resolve`）与 apt 镜像 404（`Failed to fetch ... 404 Not Found`）都会在重试用尽后以非零状态退出，最坏耗时仍小于步骤的 8 分钟与 job 的 30 分钟。

本小节的契约由 `tests/unit/ci-workflow.test.ts`、`tests/unit/flake-watch-workflow.test.ts` 与 `tests/unit/flaky-policy-docs.test.ts` 对照两个 workflow、`PLAYWRIGHT_IMAGE_PIN` 与安装包装校验，workflow 或包装脚本改值后文档未同步会让单测失败。

## 6. Triage

出现 flaky / failed 时先看证据，再决定修复：

1. 先看 Playwright 输出里的 flaky 标注与 `Check target e2e flakes` 打印的首跑错误，确认失败发生在哪一步；再看 `test-results/e2e-report.json`、失败截图与保留的 trace。
2. 本地复现：`CI=true npm run test:e2e` 后运行 `node scripts/check-e2e-flakes.mjs`；需要看首跑稳定性时运行 `npx playwright test --project=mobile-webkit -g "hub and blank canvas" --repeat-each=5 --retries=0`，或在 Actions 手动触发 `Flake watch`。
3. 修复根因：改为等待确定的 settle 条件、固定 seed / tick、补充失败诊断或消除共享状态；不要通过放宽断言、跳过用例或加大超时来掩盖 flaky。
4. 修复后重新运行受影响的检查；如果只是重跑碰巧变绿，不能当作已修复。
