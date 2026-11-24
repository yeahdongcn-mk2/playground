# #251 t2 结算页接入：Before / After 截图

本目录是 Plan 节点 `#251 t2`「结算页接入」的视觉证据。计划流程不直接开 PR，所以把 Before / After 截图、采集脚本和复现命令放在这里，由后续收集节点随 PR 一并提交。

## 对比口径

| 项 | Before | After |
| --- | --- | --- |
| 产品代码 | `9147cdc`（rebase 前的最新 `main`：结算模块与 `?debug=1` 已在 main，view 仍是纯文字 overlay） | 本分支 rebase 后的产品提交（含结算页与保存战绩符；截图取自该树，其后追加本证据目录） |
| 场景 | 固定输入序列的胜利：三次完美格挡 + 破防后蓄势棍击 | 同一场景、同一输入序列 |
| 结果数值 | 完美 3 / 得分 1900 | 完美 3 / 用时 4.8s / 刀光 6 道 / 首领 黑煞·第 1 阶段 / 得分 1900 |
| 视口 | 1440×1000 与 320×640 | 同左 |
| 主题 | 深色（`colorScheme: dark`），`reducedMotion: reduce` | 同左 |
| 渲染 | 生产构建产物（`npm run build` + `vite preview`），Chromium headless | 同左 |

Before 的纯文字 overlay 只显示胜负标题、完美数与得分；After 用 `settlement.ts` 的「战绩符」canvas 替换，并保留 DOM 数值读版（完美 / 用时 / 刀光 / 首领）和「再来一局 / 保存战绩符 / 返回大厅」三个动作。

根因差异：320×640 下 Before 的结算卡片仍在 stage 内（y≈305，高 458），首屏只能看到顶部；After 在窄屏把结算层提升为整屏覆盖（320×640），数值和按钮无需滚动。桌面端两者都停在 stage 内，After 卡片高 606，恰好放进 651 高的 overlay。

第三轮复审修复（`be62fe9`）：`position: fixed` 只让结算层脱离 stage 的溢出裁剪，没有脱离 `.zhen-sha-stage { isolation: isolate }` 的层叠上下文，所以上一版 320×640 截图里 sticky 页头（0–67）仍盖住结算卡顶部。现在结算打开（`data-status` 为 `won` / `lost`）时把 stage 的层叠级别提到 30，高于页头的 20；320×640 下页头不再可见、不可点，`overlay-kicker` 与标题顶边命中的都是结算内容。

第四轮（t2 保存战绩符接入）：结算卡片新增「保存战绩符」按钮，调用 `settlement.ts` 的 `downloadSettlementPng` 在离屏 1080×1440 canvas 上重绘同一战绩符，经 blob URL + `<a download>` 下载 `zhen-sha-seal-<timestamp>.png`；离线可用、不发起 fetch/XHR，destroy 时移除监听并由导出函数释放 object URL。三个动作在 320×640 与桌面同处一行，结算卡高度未变（桌面 606 / 窄屏 594），仍完整落在首屏。下面另附一张由该按钮真实下载的 PNG，便于核对导出尺寸与文件名。

## 截图

| 文件 | 说明 | CSS 视口 / PNG 尺寸 | sha256 |
| --- | --- | --- | --- |
| `plan-251-t1-before-1440x1000.png` | Before，桌面，纯文字结算 | 1440×1000 / 1440×1000 | `35f79029556d78c825a13b2b347ea42d3d83b286a9ba79c724b0f8c3b1ac1985` |
| `plan-251-t1-after-1440x1000.png` | After，桌面，战绩符结算 | 1440×1000 / 1440×1000 | `b0915414d64f3eafe90d9eb7a8a7bfbd49356be0739aa50bc4c534873917cf94` |
| `plan-251-t1-before-320x640.png` | Before，窄屏，纯文字结算 | 320×640 / 320×640 | `53d4ab3b3b83a2234772cff51a7d8813c496362c0055bba4e5981d392b4575e0` |
| `plan-251-t1-after-320x640.png` | After，窄屏，整屏战绩符结算（页头已完全被覆盖） | 320×640 / 320×640 | `9d84385856d055a48f350b8138413b8adad60e0fe01ac1d6c4c72f038e2ef33e` |
| `plan-251-t1-after-seal-1080x1440.png` | After 点击「保存战绩符」实际下载的 PNG（采集时文件名 `zhen-sha-seal-1795527253250.png`） | — / 1080×1440 | `9d3fd57fcefb083001328d7241f6046c68243e02d38c7a5eb336b0425b6f34b1` |

采集时记录的关键几何 / 溢出数据：

| 截图 | 页面 `scrollWidth / clientWidth` | overlay | 结算卡片 | 战绩符 canvas | 页面滚动 |
| --- | --- | --- | --- | --- | --- |
| Before 1440 | 1440 / 1440 | 418×651 | — | — | 0 |
| After 1440 | 1440 / 1440 | 418×651，内容无滚动（651/651） | 340×606 | 260×347 | 0 |
| Before 320 | 320 / 320 | 294×458（在 stage 内） | — | — | 265（把 stage 内容滚入首屏后截图） |
| After 320 | 320 / 320 | 320×640（fixed，整屏） | 300×594 | 260×347 | 0 |

Before 窄屏截图的 `scrollY=265` 是 baseline 自身布局造成的：结算层在 stage 内、位于首屏下方；为了让对比图完整展示纯文字 overlay，采集时把它滚入视口。After 使用整屏 fixed 结算层，同一视口下无需滚动。两者仍是同一视口、同一主题、同一胜利场景。

## 采集方式

- Node `v22.19.0`，Playwright `1.64.1`，Chromium headless shell。
- 截图用 `page.clock` 冻结墙上时间，再按 1500 / 3000 / 4500 ms 三次攻击判定点派发真实 `PointerEvent`；破防后按住 300 ms、松手终结。两版走完全相同的真实指针路径，没有为截图改动游戏代码。实际下载的战绩符 PNG 则走 After 的 `?debug=1` 固定输入序列，确保每次导出的结算与刀光逐项一致。
- 时钟冻结下仍可能因机器负载丢帧，导致某次点击落在完美判定带之外。脚本在保存前会检查 `overlay-title` 必须为「一棍定魂」，否则重开新页面重试（最多 6 次）；本次 4 张截图均第 1 次成功。脚本不会把失败局当作胜利证据保存。
- 采集环境不是真机；窄屏覆盖通过 Chromium 视口模拟。三真人盲测仍是后续 #421。

## 复现

```bash
# 1) Before：rebase 前的最新 main 基线
git worktree add --detach /tmp/zhen-251-before 9147cdc
(cd /tmp/zhen-251-before && npm ci && npm run build)
(cd /tmp/zhen-251-before && npx vite preview --host 127.0.0.1 --port 4190 --strictPort) &

# 2) After：本分支（产品提交见 PR head）
npm ci
npm run build
npx vite preview --host 127.0.0.1 --port 4191 --strictPort &

# 3) 从仓库根目录采集
node evidence/plan-251-t1/capture-settlement.mjs \
  --before http://127.0.0.1:4190 \
  --after http://127.0.0.1:4191 \
  --out evidence/plan-251-t1
```

脚本依赖仓库根 `node_modules` 中的 `@playwright/test`；两个 preview 必须指向各自 worktree 的 `dist`。脚本会额外点击 After 的「保存战绩符」并把真实下载保存为 `plan-251-t1-after-seal-1080x1440.png`，日志中的 `after seal:` 行记录文件名与 PNG 头尺寸；输出最后一行应为 `Captured 4 screenshots into evidence/plan-251-t1`；目录中会多出 1 张上面提到的实际下载 PNG（共 4 张截图 + 1 张战绩符）。
