# #251 t2 结算页接入：Before / After 截图

本目录是 Plan 节点 `#251 t2`「结算页接入」的视觉证据。计划流程不直接开 PR，所以把 Before / After 截图、采集脚本和复现命令放在这里，由后续收集节点随 PR 一并提交。

## 对比口径

| 项 | Before | After |
| --- | --- | --- |
| 产品代码 | `5cb5b79`（t1 已合并，结算模块存在但 view 仍是纯文字 overlay） | `11a87ce`（本分支产品、测试与文档提交；截图取自该树，其后追加本证据目录与一处文档措辞修正） |
| 场景 | 固定输入序列的胜利：三次完美格挡 + 破防后蓄势棍击 | 同一场景、同一输入序列 |
| 结果数值 | 完美 3 / 得分 1900 | 完美 3 / 用时 4.8s / 刀光 6 道 / 首领 黑煞·第 1 阶段 / 得分 1900 |
| 视口 | 1440×1000 与 320×640 | 同左 |
| 主题 | 深色（`colorScheme: dark`），`reducedMotion: reduce` | 同左 |
| 渲染 | 生产构建产物（`npm run build` + `vite preview`），Chromium headless | 同左 |

Before 的纯文字 overlay 只显示胜负标题、完美数与得分；After 用 `settlement.ts` 的「战绩符」canvas 替换，并保留 DOM 数值读版（完美 / 用时 / 刀光 / 首领）和「再来一局 / 返回大厅」两个动作。

根因差异：320×640 下 Before 的结算卡片仍在 stage 内（y≈305，高 458），首屏只能看到顶部；After 在窄屏把结算层提升为整屏覆盖（320×640），数值和按钮无需滚动。桌面端两者都停在 stage 内，After 卡片高 606，恰好放进 651 高的 overlay。

## 截图

| 文件 | 说明 | CSS 视口 / PNG 尺寸 | sha256 |
| --- | --- | --- | --- |
| `plan-251-t1-before-1440x1000.png` | Before，桌面，纯文字结算 | 1440×1000 / 1440×1000 | `1bde6e458a470bf82d1493d26e6f1b8d62b60290a1538845693639c9ae256cd8` |
| `plan-251-t1-after-1440x1000.png` | After，桌面，战绩符结算 | 1440×1000 / 1440×1000 | `f57bdabf3c762bbc6e2e57d8b4314886d4800be43df6c29be2052626224aabf1` |
| `plan-251-t1-before-320x640.png` | Before，窄屏，纯文字结算 | 320×640 / 320×640 | `77f634b25a88e49b001d3d621b5cb3b02b71977d38fcd73174341fd3504b2488` |
| `plan-251-t1-after-320x640.png` | After，窄屏，整屏战绩符结算 | 320×640 / 320×640 | `28b5b35c103e7b98a14ab57c3bec0900da8d8f1ce76c5d7073cfdfca90c7634e` |

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
- 用 `page.clock` 冻结墙上时间，再按 1500 / 3000 / 4500 ms 三次攻击判定点派发真实 `PointerEvent`；破防后按住 300 ms、松手终结。两版走完全相同的真实指针路径，没有为截图改动游戏代码，也没有使用 After 的调试接缝。
- 时钟冻结下仍可能因机器负载丢帧，导致某次点击落在完美判定带之外。脚本在保存前会检查 `overlay-title` 必须为「一棍定魂」，否则重开新页面重试（最多 6 次）；本次 Before 桌面第 4 次成功，其余第 1 次成功。脚本不会把失败局当作胜利证据保存。
- 采集环境不是真机；窄屏覆盖通过 Chromium 视口模拟。三真人盲测仍是后续 #421。

## 复现

```bash
# 1) Before：t1 合并后的基线
git worktree add --detach /tmp/zhen-251-before 5cb5b79
(cd /tmp/zhen-251-before && npm ci && npm run build)
(cd /tmp/zhen-251-before && npx vite preview --host 127.0.0.1 --port 4190 --strictPort) &

# 2) After：本分支（产品提交 11a87ce）
npm ci
npm run build
npx vite preview --host 127.0.0.1 --port 4191 --strictPort &

# 3) 从仓库根目录采集
node evidence/plan-251-t1/capture-settlement.mjs \
  --before http://127.0.0.1:4190 \
  --after http://127.0.0.1:4191 \
  --out evidence/plan-251-t1
```

脚本依赖仓库根 `node_modules` 中的 `@playwright/test`；两个 preview 必须指向各自 worktree 的 `dist`。输出最后一行应为 `Captured 4 screenshots into evidence/plan-251-t1`。
