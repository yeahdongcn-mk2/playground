# #540 t2 建房表单：三档预设与自定义棋盘 Before / After

本目录是 Plan 节点 `#540 t2`「建房表单支持三档预设与自定义棋盘」的视觉证据。
产品 PR #547（合并提交 `889b2cd`）已提交原始 Before / After 截图与采集脚本；
隐藏态浏览器断言与补充截图由后续 fix PR 补入。

## 对比口径

| 项 | Before | After |
| --- | --- | --- |
| 产品代码 | `987bac9`（产品 PR 的 main 基线） | `528402a`（产品提交的树；内容 squash 为 `889b2cd`，本 fix 分支基于 `08353e2`，产品源文件一致） |
| 场景 | 联机扫雷 `#/online/minesweeper` 建房表单，默认「初级」预设 | 同一建房表单，难度选「自定义」并填入 12 行 / 12 列 / 20 雷 |
| 表单尺寸（桌面 1440×1000） | 666×226，自定义字段不存在 | 666×299，自定义字段可见 |
| 表单尺寸（窄屏 320×640） | 264×221 | 264×299 |
| 视口 | 1440×1000 与 320×640 | 同左 |
| 主题 | 深色（`colorScheme: dark`），`reducedMotion: reduce`，DPR 1 | 同左 |
| 渲染 | Vite dev server + 真实 `App` 外壳 + 生产 `mountOnlineRoom`，Chromium headless | 同左 |

Before 的难度控件只有初级/中级/高级三个预设；After 增加「自定义 · 行 / 列 / 雷数」，
选中后在表单内出现三个 `type=number` 输入。两版都用同一个证据页
`harness.html` 渲染，差异仅来自产品代码。

## 为什么用证据页

`#/online/minesweeper` 的真实路由仍在未合并的入口 PR #543 上，main 的
`src/app/app.ts` 对该路由只渲染占位错误页。为了在 main 基线上也能拍到实际组件，
`harness.html` 构造真实 `App`（页头、`#view`、页脚、全局样式），再把生产组合根
`mountOnlineRoom` 挂到入口路由使用的 `.view.view--game` 容器里。这不是 mockup：
建房表单、CSS、焦点与错误文案都来自对应提交的生产代码；Before / After 加载同一个
证据页，仅产品提交不同。入口路由合并后，可用同一脚本改走真实路由复核。

## 截图

| 文件 | 说明 | CSS 视口 / PNG 尺寸 | sha256 |
| --- | --- | --- | --- |
| `before-1440x1000.png` | Before，桌面，默认初级预设，三档 select | 1440×1000 / 1440×1000 | `3138c5cdbc12301bdd9951aad74a529a48522b4b36e03a19a85fb55bfcba5e46` |
| `after-1440x1000.png` | After，桌面，自定义选中，12×12 / 20 雷输入可见 | 1440×1000 / 1440×1000 | `ddf03582dffc85b664e80c45414904070ec062b085b4f39921a373f20dfa25be` |
| `before-320x640.png` | Before，窄屏，三档 select（表单滚动到页头下方） | 320×640 / 320×640 | `66351c010d6195e1d6b848d530c46c69062ee55850d17012f9949c2b067fb49f` |
| `after-320x640.png` | After，窄屏，自定义三列输入 | 320×640 / 320×640 | `beef660946ae004dfa3d5eb18b41de6cc78ed5c4ba4131a864b5c815cb6c6354` |
| `after-preset-1440x1000.png` | After 附加态：默认「初级」预设选中，自定义字段按 `[hidden]` 规则不显示（与 `before-1440x1000.png` 逐字节相同） | 1440×1000 / 1440×1000 | `3138c5cdbc12301bdd9951aad74a529a48522b4b36e03a19a85fb55bfcba5e46` |
| `after-focus-1440x1000.png` | After 附加态：行数输入聚焦，显示 `box-shadow` 焦点环 | 1440×1000 / 1440×1000 | `ffa0ab2545239623957d2d0f77e2ad3ad72c2a16b24c6ff7bbacd83cd6e70ad3` |
| `after-invalid-1440x1000.png` | After 附加态：行数填 4，form-error 显示「行数必须是 5 到 30 之间的整数。」且不建房 | 1440×1000 / 1440×1000 | `4fc296a2717ff7779c64abe7ee54baaef2366c9303b4c77dd1d68f69815bfbbc` |

采集时记录的关键几何数据：

| 截图 | 页面 scrollY | 表单 top / width / height | selectedDifficulty | 自定义字段可见 | form-error |
| --- | --- | --- | --- | --- | --- |
| `before-1440x1000.png` | 0 | 465 / 666 / 226 | `beginner` | —（不存在） | 空 |
| `after-1440x1000.png` | 0 | 465 / 666 / 299 | `custom` | true（`display: grid`） | 空 |
| `before-320x640.png` | 393 | 79 / 264 / 221 | `beginner` | —（不存在） | 空 |
| `after-320x640.png` | 393 | 79 / 264 / 299 | `custom` | true（`display: grid`） | 空 |
| `after-preset-1440x1000.png` | 0 | 465 / 666 / 226 | `beginner` | false（`display: none`，0×0） | 空 |
| `after-invalid-1440x1000.png` | 0 | 465 / 666 / 299 | `custom` | true（`display: grid`） | 行数必须是 5 到 30 之间的整数。 |

窄屏两张都先滚到建房表单、并让 sticky 页头不遮挡表单顶部；滚动量相同（393），
两张截图内容区一致。320 宽下三个数字输入各 71px 宽，页面 `scrollWidth = clientWidth = 320`，
无横向溢出。

`after-preset-1440x1000.png` 与 `before-1440x1000.png` 逐字节相同（sha256 一致）。
这是预期的：两种构建在默认「初级」预设下渲染相同，第四个「自定义」选项只在展开 select
时才可见；仅凭图像相同并不能证明自定义字段被隐藏。判别证据是 `capture-room-form.mjs`
在真实浏览器里的断言——预设态必须 `customFieldsDisplay === 'none'` 且盒 0×0，自定义态
必须 `customFieldsDisplay === 'grid'` 且盒非零。脚本输出里的 `customFieldsDisplay` /
`customFieldsBox` / `customFieldsVisible` 就是这三项实测值；本机实测盒尺寸（记录用，不是
断言值）为桌面自定义态 632×70、窄屏 230×70、预设态 0×0。
Vitest 的 jsdom 不加载 `room-view.css`，所以只断言 `customFields.hidden` 的单测发现不了
`.online-room__custom-fields[hidden] { display: none; }` 被删除；这条浏览器断言补上了缺口：
删掉该规则后，预设态会变成 `display: grid`、盒尺寸 632×70，脚本立即失败。
单测侧的回归守卫是 `tests/unit/online-room-view.test.ts` 的样式表检查，它按完整类名
匹配 `.online-room__custom-fields[hidden] { display: none; }`，规则被删除、改名、`[hidden]`
挪到后代选择器或改成非 `none` 的 display 都会失败。
浏览器断言只在证据脚本里手动复现，不在 CI 执行（真实联机路由还没接入 main）；
CI 覆盖的是上面的样式表源码守卫。

## PR 描述可用段落

> 建房表单的难度选择从三档预设扩展为「初级/中级/高级/自定义」：选自定义时显示行、列、
> 雷数三个数字输入，非法值在现有 `form-error` 区域显示与单机一致的中文原因且不发送
> `create`；合法值以 `{ rows, cols, mines, firstClickSafe: true }` 发出。自定义解析复用
> `parseCustomDifficulty`（内部仍走 `validateConfig`），没有复制边界与首点安全规则。
>
> Before/After 均为同视口（1440×1000、320×640）、深色主题、DPR 1：Before 为 `987bac9`
> 的三档 select，After 为 `528402a` 的自定义选项与三个数字输入（另附聚焦与非法值状态）。
> 截图与复现说明见 `evidence/plan-540/`。
>
> 视觉证据把六张既有截图固定到合并提交 `889b2cd` 的 raw 链接
> （`before-1440x1000` / `after-1440x1000`、`before-320x640` / `after-320x640`，
> 以及聚焦与非法值两张），新增的 `after-preset-1440x1000.png` 固定到本 fix PR 的
> head 提交；PR 描述写明 Before `987bac9` / After `528402a`、视口与深色主题。

## 采集方式

- Node `v22.19.0`，Playwright `1.64.1`（Chromium `156.0.8078.4` headless），Vite `8.3.5`。
- 两棵工作树各自启动 Vite dev server；Before 用 `987bac9` 的基线工作树，把本目录的
  `harness.html` / `harness.ts` 原样复制进去（不提交），After 直接用 `528402a` 的产品代码
  （本 fix 分支基于当时 main，产品源文件一致）。
- `capture-room-form.mjs` 以 1440×1000、320×640 两个视口、`colorScheme: dark`、
  `reducedMotion: reduce`、DPR 1 打开同一证据页；After 通过真实 `change` 事件选择
  `custom` 并填入 12/12/20；截图前 `blur()`，窄屏滚动到表单顶部，等待 100ms 后截图。
- 脚本在真实浏览器里断言自定义字段的可见性：自定义态必须 `display: grid` 且盒尺寸非零，
  默认预设态必须 `display: none` / 0×0，否则捕获直接失败；`after-preset-1440x1000.png`
  记录的就是预设态。
- 焦点、预设与非法值三张附加图只用于展示新增焦点样式、隐藏态与中文错误，
  不参与 Before/After 对照。

## 复现

```bash
# 1) Before：产品 PR 的 main 基线工作树
git worktree add --detach /tmp/plan540-before 987bac9
mkdir -p /tmp/plan540-before/evidence/plan-540
cp evidence/plan-540/harness.html evidence/plan-540/harness.ts \
  /tmp/plan540-before/evidence/plan-540/
(cd /tmp/plan540-before && npm ci)
(cd /tmp/plan540-before && npx vite --host 127.0.0.1 --port 4191 --strictPort) &

# 2) After：产品提交 528402a 的树（本 fix 分支基于 08353e2；产品源文件与 528402a 相同）
npm ci
npx vite --host 127.0.0.1 --port 4190 --strictPort &

# 3) 从仓库根目录采集
node evidence/plan-540/capture-room-form.mjs \
  --before http://127.0.0.1:4191 \
  --after http://127.0.0.1:4190 \
  --out evidence/plan-540
```

脚本依赖仓库根 `node_modules` 中的 `@playwright/test`；浏览器使用本机已安装的
Playwright Chromium。输出最后一行应为
`Captured create-form evidence into evidence/plan-540`。
