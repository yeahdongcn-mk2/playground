# 镇煞首启教学 Before / After 证据（#245 t1）

- baseline（Before）：`origin/main` @ `0253b20`，未加首启教学的当前实现
- after（After）：`agent/plan-245-t0` @ `7bcaab2`（After 截图对应的实现提交；之后只新增本 README，UI 不再变化）
- 场景：全新浏览器上下文（空 `localStorage`）直接进入 `/#/games/zhen-sha` 首屏；同一 Chromium、DPR 1
- 视口：1440×1000（桌面）与 390×844（手机）
- 主题 / 状态：默认深色主题；页面加载后 250 ms 截图，首招 telegraph 仍在进行
- 文件：
  - `{before,after}-{1440x1000,390x844}.png`：默认动画（无 reduced-motion）
  - `{before,after}-reduced-{1440x1000,390x844}.png`：`prefers-reduced-motion: reduce`

## 对照内容

Before 只有长操作说明：三手势标签下是整句「杀招出手前一瞬轻点才是完美格挡……」，侧栏还有一整段「首领只有一招……」，画面上没有任何首启提示。

After 首访在画面中央显示一圈金色轮廓 + 4 个汉字「等它出手」，同时隐藏上述两段长说明；三手势标签保留。首次完美格挡后提示消失，并把 `zhen-sha.tutorial=done` 写入 `playground:v1`。

reduced-motion 的 After 走 `data-motion="static"` 分支：金色轮廓改为静态描边/着色，不再脉冲；提示位置、尺寸与布局不变，因此没有布局跳动。

说明：截图按 `[data-testid="zhen-sha-game"]` 元素捕获，所以 Before 的元素高度比 After 高 48 px（桌面）/ 101 px（手机），差值来自被隐藏的两段长说明；游戏舞台本身的尺寸没有变化。

## 复现

```bash
# 1. 分别构建 baseline 与 after，并各起一个静态预览
git worktree add --detach /tmp/plan-245-before origin/main
ln -s "$PWD/node_modules" /tmp/plan-245-before/node_modules
(cd /tmp/plan-245-before && npm run build && npx vite preview --port 4181 --strictPort)
npm run build && npx vite preview --port 4182 --strictPort

# 2. 截图（在 after 的工作树里执行；输出到本目录）
node evidence/plan-245-t0/capture-tutorial.mjs http://127.0.0.1:4181 evidence/plan-245-t0/plan-245-t0 before
node evidence/plan-245-t0/capture-tutorial.mjs http://127.0.0.1:4182 evidence/plan-245-t0/plan-245-t0 after
node evidence/plan-245-t0/capture-tutorial.mjs http://127.0.0.1:4181 evidence/plan-245-t0/plan-245-t0 before-reduced
node evidence/plan-245-t0/capture-tutorial.mjs http://127.0.0.1:4182 evidence/plan-245-t0/plan-245-t0 after-reduced
```

文件名格式为 `<output-prefix>-<state>-<w>x<h>.png`，所以上面统一传入 `evidence/plan-245-t0/plan-245-t0`。

## 机械校验

`verify-tutorial.mjs` 用 `@playwright/test` 的 Chromium 对两个构建做 DOM 断言，结果：

```text
PASS before: no tutorial hint exists
PASS before: long gesture note is visible
PASS after: first-visit hint is visible
PASS after: hint animates by default
PASS after: hint does not intercept pointers
PASS after: hint is at most six Han characters
PASS after: long gesture note is hidden
PASS after: sidebar long note is hidden
PASS after: reduced-motion hint is visible
PASS after: reduced-motion uses the static branch
PASS after: reduced-motion ring has no animation
```

```bash
node evidence/plan-245-t0/verify-tutorial.mjs http://127.0.0.1:4181 before
node evidence/plan-245-t0/verify-tutorial.mjs http://127.0.0.1:4182 after
```

首招 ≥1.5× 基准、首次完美后持久化 `done`、两个重开入口与重新挂载不再显示、清空键后恢复、教程可见时手势与结算仍正常，由 `src/games/zhen-sha/tutorial.test.ts`、`engine.test.ts`、`zhen-sha-view.test.ts` 与 `style.test.ts` 覆盖；`capture-tutorial.mjs` / `verify-tutorial.mjs` 只补充真实浏览器截图与 DOM 证据。
