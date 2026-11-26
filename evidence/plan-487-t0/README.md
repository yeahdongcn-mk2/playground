# #487 t1 联机入口 Before / After 证据

PR #533 的用户可见改动有两处：大厅新增「联机扫雷」入口，`#/online/minesweeper`
从占位页变为真实联机房间。本目录保存同一场景、同一视口下的 Before 与 After
截图，供 PR 描述直接引用。

- **Before（baseline）**：`origin/main` @ `76f6f5e`（main 的占位页 / 大厅无入口）
- **After（changed revision）**：`agent/plan-487-t0` @ `71df2a2`（UI 与构建产物对应的提交；
  之后 #533 的修复提交只改单测与证据文件，`src/` 与构建产物不变）
- **场景**：`#/` 大厅首屏 与 `#/online/minesweeper` 联机路由
- **视口**：1280×900、DPR 1、Chromium、`fullPage` 截图（与评审核对时一致）
- **文件**：`{before,after}-{hub,online}.png`

| 状态 | 大厅 | 联机路由 |
| --- | --- | --- |
| Before（main 76f6f5e） | `before-hub.png` | `before-online.png` |
| After（71df2a2） | `after-hub.png` | `after-online.png` |

## 复现方式

两个脚本都只从已声明的 `@playwright/test` 导入 Chromium，并分别对生产构建
（`npm run build` + `npm run preview`）运行：

```bash
# main 76f6f5e 的构建，默认 http://127.0.0.1:4398
node evidence/plan-487-t0/capture-before.mjs <before-base-url> [out-dir]

# PR head 71df2a2 的构建，默认 http://127.0.0.1:4399
node evidence/plan-487-t0/capture-after.mjs <after-base-url> [out-dir]
```

`out-dir` 默认是本目录。脚本不只截图，还断言截图对应的行为：

- `capture-before.mjs`：大厅 `enter-online-minesweeper` 数量为 0；联机页标题仍是
  「联机房间入口尚未接入」；`[data-testid="online-room"]` 数量为 0。
- `capture-after.mjs`：大厅入口存在且 `href="#/online/minesweeper"`；真实
  `[data-testid="online-room"]` / `create-form` 挂载；`?room=room_487_demo` 透传到
  `join-room-id`；离开路由后房间 DOM 消失；阻断 `online-room-*.js` 时出现可重试错误页，
  放行后重试成功。

两张 Before 图与两张 After 图由同一浏览器、同一视口和 `fullPage` 参数生成，因此大厅
高度（1280×3779）与联机页高度（1280×900 / 1280×906）可直接对照。
