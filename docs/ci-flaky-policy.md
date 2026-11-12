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

## 5. 浏览器安装的缓存与失败边界

Playwright 的 `--with-deps` 安装会在 apt 阶段受 runner 的 DNS 抖动和 Ubuntu 镜像 404 影响。为避免一次安装耗尽 job 的 20 分钟超时，`ci.yml` 的 `verify` job 把浏览器安装收敛为有界步骤（背景见 Issue #202）：

- **缓存路径与 key**：`Cache Playwright browsers` 用 `actions/cache@v4` 缓存 `~/.cache/ms-playwright`，key 为 `playwright-${{ runner.os }}-${{ hashFiles('package-lock.json') }}`，restore key 为 `playwright-${{ runner.os }}-`。key 绑定 `package-lock.json`，因此依赖或 Playwright 版本变化时冷缓存重新下载，命中时直接复用已安装的 Chromium 与 WebKit。
- **安装步骤与超时**：`Install Playwright Chromium and WebKit` 只执行 `node scripts/install-playwright-ci.mjs`，步骤级 `timeout-minutes: 8`。包装脚本最多尝试 2 次，每次尝试独立 180 秒超时，失败后按 10 秒退避重试。
- **apt Acquire 配置**：安装前由 `Configure apt Acquire retries and timeouts` 把 `Acquire::Retries "1"`、`Acquire::http::Timeout "15"` 与 `Acquire::https::Timeout "15"` 写入 `/etc/apt/apt.conf.d/99-ci-acquire`，让单次 apt 请求快速失败，而不是长时间挂起。
- **两种失败形态**：DNS 抖动表现为 `Temporary failure resolving` / `Could not resolve`；apt 镜像 404 表现为 `Failed to fetch ... 404 Not Found`，通常以 exit 100 结束。两者都按 runner 的瞬时基础设施故障处理：包装脚本重试并打印 apt/DNS 提示，重试用尽后仍失败就返回非零状态。
- **失败边界**：最坏情况由 2 × 180 秒尝试、退避和进程组 SIGTERM/SIGKILL 收敛组成，仍小于步骤级 8 分钟；因此失败会在步骤自身的 `timeout-minutes` 内以非零状态和可操作诊断（尝试次数、耗时、node/npm/Playwright 版本、`~/.cache/ms-playwright` 内容与 apt 提示）退出，不会耗尽 job 的 20 分钟。
- **验收 run**：Issue #202 使用 [run 43129697008](https://github.com/yeahdongcn-mk2/playground/actions/runs/43129697008) 的两个 attempt 验收：attempt 1 冷缓存（`Cache not found`，job 4m37s），attempt 2 热缓存重跑（`Cache restored from key: playwright-Linux-...`，job 6m50s），两次 `verify` 均通过。

本小节的契约由 `tests/unit/flaky-policy-docs.test.ts` 对照 `.github/workflows/ci.yml` 与 `scripts/install-playwright-ci.mjs` 校验，workflow 或包装脚本改值后文档未同步会让单测失败。

## 6. Triage

出现 flaky / failed 时先看证据，再决定修复：

1. 先看 Playwright 输出里的 flaky 标注与 `Check target e2e flakes` 打印的首跑错误，确认失败发生在哪一步；再看 `test-results/e2e-report.json`、失败截图与保留的 trace。
2. 本地复现：`CI=true npm run test:e2e` 后运行 `node scripts/check-e2e-flakes.mjs`；需要看首跑稳定性时运行 `npx playwright test --project=mobile-webkit -g "hub and blank canvas" --repeat-each=5 --retries=0`，或在 Actions 手动触发 `Flake watch`。
3. 修复根因：改为等待确定的 settle 条件、固定 seed / tick、补充失败诊断或消除共享状态；不要通过放宽断言、跳过用例或加大超时来掩盖 flaky。
4. 修复后重新运行受影响的检查；如果只是重跑碰巧变绿，不能当作已修复。
