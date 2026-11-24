# 镇煞朱砂印 / 字标 / 金棍弧金边 Before / After（#249 t2 评审修复）

- Before：`3ba9cc1`（PR #411 的 base，main 合入 #410 之后）。
- After：本 PR 产品代码 head `8cc3699`（合并 `main` `96f0ebe` 后的构建；其后的
  `docs/` 与 `evidence/` 提交不改 UI）。金边几何由 CSS 静态 polygon 承载
  （`is-arc-lifted` 切换）。`capture-marks.mjs` 已在 `8cc3699` 的构建上重跑，4 张
  After 与旧图逐字节一致（RGBA 无差异），说明 53be067 的 CSS polygon 与
  `f6bc467` 的 JS 几何渲染结果相同。
- 来源：Issue #249 第 1 条子任务（t2）的评审修复，PR #411；#431 t1 修复轮在
  `8cc3699` 重新采集证据。

## 场景

- 路由：`#/games/zhen-sha`，初始战斗状态（HUD：势 0 / 完美 0 / 中招 0/3，结算层隐藏）。
- 视口：`320x640` 与 `1440x1000`；`deviceScaleFactor: 1`、`colorScheme: dark`、
  `reducedMotion: reduce`。
- 时钟：Playwright `clock.install` 后在页面启动前 `pauseAt`，页面加载不再推进时钟；
  加载完成后 `runFor(900)` + `runFor(32)`（共 932 ms）再截图，Before / After 落在同一
  游戏 tick，画布与 HUD 像素一致，差异只来自本 PR 新增的标记层与金边。
- 截图是本地构建产物（`vite preview`）上的 Playwright Chromium 实拍，不是 mockup。
- `*-resting-*`：页面停在 `scrollTo(0, 0)` 的初始画面。
- `*-charging-*`（补充）：把整个舞台滚入视口后，按住舞台 700 ms 再截图，对应
  `drawStaff()` 的 `lift = 34` 状态；用来对照 CSS 金边是否跟随抬起的 Canvas 金弧。

## 文件

- `before-resting-320x640.png` / `after-resting-320x640.png`
- `before-resting-1440x1000.png` / `after-resting-1440x1000.png`
- `before-charging-320x640.png` / `after-charging-320x640.png`
- `before-charging-1440x1000.png` / `after-charging-1440x1000.png`

Before 还没有 `.zhen-sha-marks` 与金边层，所以 Before 的 charging 图只有抬起的 Canvas
金弧；After 的 charging 图在同一位置叠加了跟随抬起的 CSS 金边。

## 机械校验

`verify-marks.mjs` 在 After 构建上直接比较同一 x 处 Canvas 亮金弧中心与 CSS 金边
clip-path 带的中心（单位：360x560 逻辑像素）：

```text
alignment samples: 21 / 21
resting max |css-canvas|: 1.11 px
charging max |css-canvas|: 1.43 px
canvas arc lift (resting - charging): 18.29 px
```

即静息与蓄势两种状态下两条金线的中心偏差都小于 1.5 逻辑像素，且蓄势时 Canvas 金弧
中段确实抬起了约 18 px。像素差分（Playwright 截图，RGBA 完全相同才算未变）：

| 视口 | resting Before→After | charging Before→After |
| --- | --- | --- |
| 320x640 | 6,304 px，bbox `(25,313)-(307,421)` | 10,225 px，bbox `(25,189)-(307,587)` |
| 1440x1000 | 17,099 px，bbox `(369,208)-(769,770)` | 17,065 px，bbox `(369,208)-(769,770)` |

320 下 resting 的差异只在标记层；charging 滚到舞台后差异延伸到金弧区域，正是新增金边。
`tests/e2e/zhen-sha-marks.spec.ts` 另有门禁：两个视口下印/字标 bounding box 在 stage 内、
不与 HUD / 手势提示相交、computed `color` / `opacity` 不透明，并且蓄势时舞台带上
`is-arc-lifted`、computed `clip-path` 切换成抬起的 polygon，收棍后回到静息 polygon 并移除该类。

## 复现

```bash
# Before：在 3ba9cc1 的 worktree 里构建并起预览
npx vite build
npx vite preview --host 127.0.0.1 --port 4271 --strictPort

# After：在本分支构建并起预览
npm run build
npx vite preview --host 127.0.0.1 --port 4272 --strictPort

# 截图与机械校验
node evidence/plan-249-t1-review/capture-marks.mjs http://127.0.0.1:4271 evidence/plan-249-t1-review/before
node evidence/plan-249-t1-review/capture-marks.mjs http://127.0.0.1:4272 evidence/plan-249-t1-review/after
node evidence/plan-249-t1-review/verify-marks.mjs http://127.0.0.1:4272
```
