# #539 t1 联机入口 Before / After 证据

本目录是 #539 t1「把 #533/#543 的联机入口重放到当前 main」的视觉证据：
大厅新增「联机扫雷」入口，`#/online/minesweeper` 从占位页变为真实联机房间，
`?room=` 深链把房间号透传给房间页。改动以 #533（head `08e9f9e`，已 approve）与
#543（head `3175824`，即 #533 的重放）为蓝本，不改房间 / 协议 / 服务端逻辑。

## 对比口径

- **Before（baseline）**：`origin/main` @ `674df65`（main 的占位页 / 大厅无入口）
- **After（changed revision）**：`agent/plan-539-t0` @ `8e98ea1`（入口与构建产物对应的提交；
  本证据提交只新增本目录，`src/` 与构建产物不变）
- **场景**：`#/` 大厅首屏、`#/online/minesweeper`、`#/online/minesweeper?room=room_demo`
- **视口 / 主题**：1280×900、DPR 1、Chromium、`fullPage`；两个版本共用同一份
  `src/styles/app.css`（本 PR 的 base 之后 main 未改 `src/` 的入口样式，页面始终
  `color-scheme: dark`），页面主题一致（深色）
- **渲染**：`npm run build` 的生产构建 + `vite preview`，真实 `App` 外壳

| 状态 | 大厅 `#/` | 联机路由 `#/online/minesweeper` | 深链 `?room=room_demo` |
| --- | --- | --- | --- |
| Before（main 674df65） | `before-hub.png` | `before-online.png` | `before-online-room.png` |
| After（8e98ea1） | `after-hub.png` | `after-online.png` | `after-online-room.png` |

| 文件 | CSS 视口 / PNG 尺寸 | sha256 |
| --- | --- | --- |
| `before-hub.png` | 1280×900 / 1280×3779 | `36192cafed6055d4697a3bda21f315ca3b6c51b9a87c68380716ef4fbd006bbe` |
| `before-online.png` | 1280×900 / 1280×900 | `ca7e88053749c1c942f91b710d9736eb2ce45f3ea652ea6da205a5ede787806c` |
| `before-online-room.png` | 1280×900 / 1280×900 | `ca7e88053749c1c942f91b710d9736eb2ce45f3ea652ea6da205a5ede787806c` |
| `after-hub.png` | 1280×900 / 1280×3779 | `07d2c107987569273e36917a8093f3fd09865c8ddd9bc7e18ddff3fecd21af74` |
| `after-online.png` | 1280×900 / 1280×906 | `d96153ecd971d5faeac53354c9abaf908b84fbfd88510f3d719c0deaa1db7a15` |
| `after-online-room.png` | 1280×900 / 1280×942 | `194fd237dd4fecec9a13422da00193cd493d3dc1ca3e8d63833da612ebda351c` |

`before-online-room.png` 与 `before-online.png` 逐字节相同是预期的：占位页不读取 `?room=`。
六张图与 #537 t1 目录（`evidence/plan-537/`，PR #543 上已评审）的对应截图逐字节一致：
两边可见状态相同时，重新采集应得到同一结果，说明重放后的用户可见结果与已评审的入口相同。
`before-online.png` 的占位页在 674df65 与 987bac9 上没有变化，因此基线截图可直接对照。

## 复现方式

两个脚本都只从已声明的 `@playwright/test` 导入 Chromium，并分别对生产构建
（`npm run build` + `vite preview`）运行。默认端口避开本机已被占用的 4173 / 4398 / 4399。

```bash
# 1) Before：baseline 674df65 的干净构建
git worktree add /tmp/plan-539-before 674df65
ln -s "$PWD/node_modules" /tmp/plan-539-before/node_modules
(cd /tmp/plan-539-before && npm run build && npx vite preview --host 127.0.0.1 --port 4408 --strictPort)

# 2) Before 截图（另一个终端）
node evidence/plan-539/capture-before.mjs http://127.0.0.1:4408 evidence/plan-539

# 3) After：本分支 head 的构建
npm run build
npx vite preview --host 127.0.0.1 --port 4409 --strictPort

# 4) After 截图与行为断言（另一个终端）
node evidence/plan-539/capture-after.mjs http://127.0.0.1:4409 evidence/plan-539
```

脚本不只截图，还断言截图对应的行为：

- `capture-before.mjs`：大厅 `enter-online-minesweeper` 数量为 0；`#/online/minesweeper`
  与 `?room=room_demo` 的标题仍是「联机房间入口尚未接入」；`[data-testid="online-room"]`
  数量为 0。
- `capture-after.mjs`：大厅入口存在且 `href="#/online/minesweeper"`；真实
  `[data-testid="online-room"]` / `create-form` 挂载；`?room=room_demo` 透传到
  `join-room-id`；离开路由后房间 DOM 消失；阻断 `online-room-*.js` 时出现可重试错误页，
  放行后重试成功。

两次采集均输出 `RESULT: PASS`，证明截图对应的页面状态与断言一致。

## 体积基线

`docs/score-baseline.json` 按实测更新（评分脚本用 `check:budget` 打印的 gzip KB 计数）：
入口 `12012 → 12544`（+532）、全部 JS `424940 → 442849`（+17909）。入口增量是新增的
`src/app/online-route.ts` 接缝；全部 JS 的增量是此前已在仓库、但未被入口引用的联机房间
客户端（`online-room` 懒加载 chunk）进入构建图，不是把既有代码写胖。50 KB / 450 KB 上限不变。
这与 PR #533 上 2026-11-26T23:10:36Z 的人工放行结论一致（增量全部来自新增文件）。
