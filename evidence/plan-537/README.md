# #537 t1 联机入口 Before / After 证据

本目录是 #533 入口改动的重放证据：大厅新增「联机扫雷」入口，`#/online/minesweeper`
从占位页变为真实联机房间，`?room=` 深链把房间号透传给房间页。改动本身以 PR #533
（head `08e9f9e`，已 approve）为蓝本落到当前 main，没有另起一套实现。

- **Before（baseline）**：`origin/main` @ `987bac9`（main 的占位页 / 大厅无入口）
- **After（changed revision）**：`agent/plan-537-t0` @ `15a3241`（入口与构建产物对应的提交；
  之后的证据提交只新增本目录，`src/` 与构建产物不变）
- **场景**：`#/` 大厅首屏、`#/online/minesweeper`、`#/online/minesweeper?room=room_demo`
- **视口 / 主题**：1280×900、DPR 1、Chromium、`fullPage`；两个版本共用同一份
  `src/app/app.css`（本 PR 的 base 之后 main 未改 `src/`），页面主题一致（默认深色）
- **文件**：`{before,after}-{hub,online,online-room}.png`

| 状态 | 大厅 `#/` | 联机路由 `#/online/minesweeper` | 深链 `?room=room_demo` |
| --- | --- | --- | --- |
| Before（main 987bac9） | `before-hub.png` | `before-online.png` | `before-online-room.png` |
| After（15a3241） | `after-hub.png` | `after-online.png` | `after-online-room.png` |

同一场景的四张图（`before-hub.png` / `before-online.png` / `after-hub.png` /
`after-online.png`）与 #533 的证据逐字节一致（sha256 相同），说明重放后的用户可见结果
与已评审的 #533 相同。`*-online-room.png` 是本次为 `?room=` 深链补的第三组；Before 的
`before-online-room.png` 与 `before-online.png` 逐字节相同，因为占位页不读取 `?room=`。

## 复现方式

两个脚本都只从已声明的 `@playwright/test` 导入 Chromium，并分别对生产构建
（`npm run build` + `vite preview`）运行。默认端口避开本机已被占用的 4173 / 4398 / 4399。

```bash
# 1) Before：baseline 987bac9 的干净构建
git worktree add /tmp/plan-537-before 987bac9
ln -s "$PWD/node_modules" /tmp/plan-537-before/node_modules
(cd /tmp/plan-537-before && npm run build && npx vite preview --host 127.0.0.1 --port 4408 --strictPort)

# 2) Before 截图（另一个终端）
node evidence/plan-537/capture-before.mjs http://127.0.0.1:4408 evidence/plan-537

# 3) After：本分支 head 的构建
npm run build
npx vite preview --host 127.0.0.1 --port 4409 --strictPort

# 4) After 截图与行为断言（另一个终端）
node evidence/plan-537/capture-after.mjs http://127.0.0.1:4409 evidence/plan-537
```

`out-dir` 默认是本目录。脚本不只截图，还断言截图对应的行为：

- `capture-before.mjs`：大厅 `enter-online-minesweeper` 数量为 0；`#/online/minesweeper`
  与 `?room=room_demo` 的标题仍是「联机房间入口尚未接入」；`[data-testid="online-room"]`
  数量为 0。
- `capture-after.mjs`：大厅入口存在且 `href="#/online/minesweeper"`；真实
  `[data-testid="online-room"]` / `create-form` 挂载；`?room=room_demo` 透传到
  `join-room-id`；离开路由后房间 DOM 消失；阻断 `online-room-*.js` 时出现可重试错误页，
  放行后重试成功。

三个场景都由同一浏览器、同一视口和 `fullPage` 参数生成：大厅两张都是 1280×3779；
`before-online.png` / `before-online-room.png` 是 1280×900（占位页）；
`after-online.png` 是 1280×906，`after-online-room.png` 是 1280×942（深链预填邀请链接），
可直接对照。

## 基线放行

`docs/score-baseline.json` 的更新引用 PR #533 上 2026-11-26T23:10:36Z 的人工放行评论
（yeahdongcn-mk2）：

> 基线的事按下面这条判：**增量全部来自新增文件（不是把已有代码写胖），且该 PR 的评审已通过
> → 放行基线更新**，并在 PR 里记一行理由。
>
> - #531 新增 `src/app/online-route.ts`（联机入口接缝）+ 688 行功能代码，动态 import 的部分
>   本来就在包里，接上入口后进产物 → **同意基线 +17438 字节**。
> - #533 同理。

重放后实测与 #533 一致：入口 +532 gzip、全部 JS +17418 gzip，增量来自新增的入口接缝与真实
房间挂载代码，没有把既有代码写胖。
