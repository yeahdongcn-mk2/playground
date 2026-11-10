# 共享游戏框架使用说明

本文说明 Playground Arcade 的模块边界、游戏契约、运行机制，以及接入 2D / 3D 游戏的步骤。
技术选型的候选对比与版本基线见 [tech-stack-decision.md](./tech-stack-decision.md)。

## 1. 目标与边界

这套底座服务的是「同一个仓库里不断加入小游戏」：

- 大厅、路由、加载 / 错误态、音效、存档和测试方式共享；
- 每个游戏独立可玩，游戏引擎按需加载，首屏不为未启动的游戏付出体积；
- 2D 与 3D 可以并存：共享外壳与契约，不强行共享渲染器；
- 规则与渲染分离，纯逻辑在 Node 中可测；
- 桌面、平板、手机都能操作，并保留基本的键盘可访问性。

当前**不包含**：后端账号、排行榜、实时对战、关卡编辑器、SSR、PWA 离线缓存。

## 2. 技术栈

| 层 | 选型 | 当前版本基线 |
| --- | --- | --- |
| 语言 | TypeScript（strict） | 7.0.2 |
| 构建 / 开发服务器 | Vite | 8.3.5 |
| 页面壳 | 原生 DOM + CSS | — |
| 2D 引擎 | Phaser | 4.2.1 |
| 3D 引擎 | Three.js（首个 3D 游戏接入） | 0.187.0 |
| 单元测试 | Vitest | 5.1.0 |
| 端到端测试 | Playwright（Chromium + WebKit） | 1.64.1 |
| Lint | oxlint + 模块边界脚本 | 1.91.0 / 本地脚本 |

Phaser 与 Three.js **只能**出现在某个游戏的懒加载 chunk 中。共享外壳和 `core/` 保持引擎无关；这样替换引擎或升级大版本时不会波及大厅。扫雷是纯 DOM 游戏（`engine: 'dom'`），视图直接操作 DOM，完全不加载 Phaser。

## 3. 目录与依赖方向

```text
index.html
src/
  main.ts
  app/
    app.ts          页头 / 页脚、Hash 路由、加载 / 错误态、音效开关
    hub.ts          大厅
    router.ts       #/ 与 #/games/:id 解析
  core/
    game.ts         GameModule / GameHandle / GameServices 契约
    storage.ts      命名空间 + 容错的 localStorage
    audio.ts        WebAudio 合成音效
    input.ts        方向键映射、DirectionState、边界钳制
    dom.ts          DOM 查询与 HTML 转义
  engine/
    phaser2d.ts     Phaser 2D 适配层
  games/
    registry.ts     游戏注册表
    blank/          空白游戏（index 元数据、view DOM 外壳、scene Phaser 场景）
    snake/          完整玩法参考（规则 engine、scene、响应式 view、单元 / e2e 测试）
    tetris/         第二个完整玩法（七种方块、消行计分、等级、触屏按钮）
    2048/           第三个完整玩法（滑动合并、键盘 + 触屏、固定初始棋盘）
    breakout/       第四个完整玩法（固定步长模拟、分层砖块、键盘 + 拖动挡板）
    minesweeper/    第五个完整玩法（纯 DOM 网格、难度选择、左右键、固定雷盘，不加载引擎）
  styles/app.css
public/games/<id>/  游戏静态资源
```

```text
app   → core
app   → games/registry → games/<game>/index（仅静态元数据）
games/<game>/* → core
games/<game>/view → 对应引擎（在 mount 内动态 import）
```

硬约束：

- `core/` 不得导入任何游戏或引擎。
- `games/<game>/index.ts` 的静态部分只能导入类型和元数据；视图与引擎必须在 `mount()` 内部的 `await import()` 之后。
- 每个游戏返回 `GameHandle`，`destroy()` 必须移除监听器、停止循环并释放引擎资源。
- `view` 负责 DOM 外壳与引擎适配；`scene` 只负责引擎内的绘制和输入，不能反向依赖 `app/`。
- `npm run lint` 同时运行 oxlint 与 `scripts/check-boundaries.mjs`，违反上述方向会直接失败。

## 4. 游戏契约

```ts
// src/core/game.ts
export type GameEngine = 'phaser' | 'three' | 'dom';

export interface GameMeta {
  id: string;
  title: string;
  englishTitle: string;
  description: string;
  engine: GameEngine;
  genre: string;
  accent: string;
  controls: readonly string[];
}

export interface GameServices {
  storage: StorageService; // 名字空间 playground:v1，安全读写
  audio: AudioService;     // 合成音效，尊重全局开关
  reduceMotion: boolean;   // prefers-reduced-motion
}

export interface GameHandle {
  destroy(): void;
}

export interface GameModule {
  meta: GameMeta;
  mount(root: HTMLElement, services: GameServices, signal: AbortSignal): Promise<GameHandle>;
}
```

`mount()` 接管传入容器；外壳不假设游戏内部结构。路由在离开时 abort `signal`，游戏应在动态 import 后、真正挂载前检查它；已经晚到的 mount 必须抛出 `AbortError` 或被外壳立即 `destroy()`。
`meta.controls` 会显示在大厅卡片上；`meta.engine` 决定卡片上的引擎标签。

## 5. 生命周期与路由

```text
hashchange / 首次加载
  → 解析 #/ 或 #/games/:id
  → abort 上一个路由的 AbortController，销毁 GameHandle
  → 显示路由加载态
  → 动态 import 游戏视图（引擎随之加载）
  → mount(root, services, signal)
  → 用户游玩
  → 路由变化 / beforeunload → abort signal → handle.destroy()
```

- 规范路由是 `#/games/<id>`（t1 选型文档第 140 行约定），`#/` 是大厅，查询串会被忽略但留给游戏读取。
- 未注册的游戏和未知路由会显示可恢复的错误页，而不是白屏。
- `App` 同时用 `AbortController` 和递增的 `renderToken` 处理快速切换：signal 在路由变化时立即 abort，晚到的异步 `mount()` 必须丢弃并自行销毁，不会覆盖新页面。
- 游戏不要自行修改 URL；返回大厅使用 `<a href="#/">`。

## 6. 主循环、场景与资源

2D 游戏使用 Phaser 的 `Scene` 生命周期与 `update(time, delta)` 主循环。共享适配层 `src/engine/phaser2d.ts` 统一：

- `Phaser.AUTO`（WebGL 优先，Canvas 回退）；
- 挂载容器、`Scale.RESIZE`、`autoCenter`；
- 3 个活动指针（鼠标 / 多指触屏）；
- `ResizeObserver` + `orientationchange` 触发容器重测；先 `scale.getParentBounds()` 再 `scale.refresh()`，侧栏或分栏导致的「只有容器变、窗口没变」也能适配；
- canvas 的 `data-testid`、`aria-label` 与 `role`；
- `destroy()` 断开观察器、移除全局监听器并调用 `game.destroy(true)`；若主循环在休眠（页面隐藏或游戏主动暂停），会先 `loop.wake()`，保证 Phaser 的延迟销毁仍然执行。
- Phaser 4 的 `VisibilityHandler` 会写入 `window.onblur/onfocus` 和 `document` 的 `visibilitychange`；适配层在销毁时恢复 / 移除这些全局监听，重复进入游戏不会累积监听器。

创建方式：

```ts
const runtime = createPhaser2DGame({
  parent: canvasHost,
  scene: new MyScene(callbacks),
  ariaLabel: '我的游戏画布',
});
// 路由离开时：
runtime.destroy();
```

### 资源加载

资源放在 `public/games/<id>/`，Vite 会原样静态托管；用场景的 `preload()` 加载：

```ts
preload(): void {
  this.load.image('hero', `${import.meta.env.BASE_URL}games/my-game/hero.svg`);
}
```

- `import.meta.env.BASE_URL` 保证部署在子路径时也能找到资源。
- 加载失败时应在 `create()` 里回退到程序绘制的占位物，空白示例演示了这种降级。
- 引擎自身是动态 import 的 chunk；不要在大厅或 `core/` 里静态导入 Phaser。

## 7. 输入

引擎无关的输入工具在 `src/core/input.ts`：

```ts
import { DirectionState, directionFromCode, isEditableTarget } from '../../core/input';

const directions = new DirectionState();

function onKeyDown(event: KeyboardEvent): void {
  const direction = directionFromCode(event.code); // 方向键 + WASD
  if (!direction || isEditableTarget(event.target)) return;
  event.preventDefault();
  directions.press(direction);
}

// update 中：
const vector = directions.vector(); // 对角线已归一化
```

- `DirectionState` 用集合记录按住的键，相反方向互相抵消，不会出现「最后按下的键赢」的抖动。
- `isEditableTarget` 在输入框 / 文本域 / contenteditable 中让出按键；按钮和链接仍允许方向键控制游戏（本仓库有端到端回归用例）。
- 鼠标与触屏使用指针事件；Phaser 场景里监听 `pointerdown` / `pointermove`，用 `pointer.x/y` 得到画布坐标。
- 触屏和鼠标走同一套 pointer 事件，不需要单独写 touch 分支。
- 键盘必须在 `keyup` 时释放方向；窗口 `blur` 时清空，防止切窗口后角色持续移动。
- 浏览器快捷键（Ctrl / Cmd / Alt 组合）不能劫持成游戏输入；空白示例在 `keydown` 中直接忽略带修饰键的事件，并有用例回归。

## 8. 渲染适配

- 画布父容器必须有确定高度；空白示例用 CSS `height: clamp(...)`，canvas 绝对定位铺满。
- Phaser 以 `Scale.RESIZE` 运行，游戏坐标与 CSS 像素一致，指针坐标可直接使用。
- 容器尺寸变化由 `ResizeObserver` 触发重测与 `scale.refresh()`；窗口旋转也会触发。
- 场景监听 `Scale.Events.RESIZE`，重绘背景网格，并把玩家位置钳制回新边界。
- 游戏元素离边缘保留安全边距（`clampPoint`），避免在窄屏被裁掉。
- 文本 HUD 优先用 DOM（可选中、可读屏、易响应式），世界与角色用引擎画布。

## 9. 共享服务

### 存档（`core/storage.ts`）

- Key 形如 `playground:v1:<game>.<field>`。
- 隐私模式、配额异常、读取到脏数据都返回 fallback，不阻塞游戏。
- 数字读取校验 `Number.isFinite`；布尔读取只认 `true/on/1` 与 `off`。

### 音效（`core/audio.ts`）

- 短音由 WebAudio 合成，不下载音频资源。
- 浏览器自动播放策略：第一次真实输入时 `unlock()`。
- 全局开关存在 `settings.sound`，页头按钮与所有游戏共享。
- 没有 `AudioContext` 的环境静默降级。

## 10. 新增一个 2D 游戏

以新建 `my-game` 为例：

1. **元数据与懒加载入口** `src/games/my-game/index.ts`：

   ```ts
   import type { GameModule } from '../../core/game';

   export const myGame: GameModule = {
     meta: {
       id: 'my-game',
       title: '我的游戏',
       englishTitle: 'My Game',
       description: '一句话玩法说明。',
       engine: 'phaser',
       genre: '街机',
       accent: '#22d3ee',
       controls: ['方向键 / WASD', '鼠标或触屏'],
     },
     async mount(root, services, signal) {
       if (signal.aborted) throw new DOMException('aborted', 'AbortError');
       const { mountMyGame } = await import('./view');
       return mountMyGame(root, services, signal);
     },
   };
   ```

2. **规则与场景分离**：把规则放在 `engine.ts`（无 DOM / 无 Phaser），先为边界写 Vitest；`scene.ts` 只读取状态快照并绘制。完整的拆分示例可参考 `src/games/snake/`、`src/games/tetris/`、`src/games/2048/`、`src/games/breakout/` 与 `src/games/minesweeper/`。
3. **DOM 外壳** `view.ts`：负责 HUD、覆盖层、按钮、触屏辅助键；2D 游戏用 `createPhaser2DGame()` 创建 2D 运行时，DOM 游戏（如扫雷）直接操作 DOM（见 10.1），返回的 `destroy()` 里释放引擎、监听器与计时器。
4. **注册**：在 `src/games/registry.ts` 的 `games` 数组加入 `myGame`，大厅自动出现卡片。
5. **资源**：放到 `public/games/my-game/`，场景 `preload()` 里加载；体积大的资源按需加载。
6. **测试**：规则单测放 `engine.test.ts`；浏览器行为加到 `tests/e2e/`，用 `data-testid` 定位。需要读取只读状态或固定初始数据时，可参考 snake / tetris / 2048 / breakout / minesweeper 只在 `import.meta.env.DEV` 或 hash 路由后的 `?debug=1`（例如 `#/games/breakout?debug=1`）下安装 `window.__playground`，生产默认入口不会暴露调试 API。

### 10.1 DOM 游戏（不加载引擎）

扫雷（`src/games/minesweeper/`）演示了 `engine: 'dom'` 的接入方式：

- `index.ts` 只放静态 `meta` 与 `mount()` 内的动态 `import('./view')`，并检查 `AbortSignal`；
- `view.ts` 按当前难度配置（三档预设或自定义行列雷数）用原生 DOM 网格绘制棋盘，把纯规则引擎 `engine.ts` 的状态快照同步到 HUD、格子和结束遮罩；难度卡片用 `aria-pressed` 标记当前预设，自定义配置恰好等于某档时同步该档，非法输入只在 `role=alert` 错误区显示中文原因；
- 预设与合法自定义共用同一条 `applyConfig()` 重建路径：停止旧计时器、取消待触发长按、隐藏遮罩、重置计时 / HUD，并在焦点原本位于遮罩内时把它移到当前预设或「开始自定义」按钮；非法自定义不重建棋局、不停止计时；
- 棋盘用左右键交互：左键翻开、右键插旗并 `preventDefault()` 掉浏览器菜单；
- 棋盘、难度选择器与按钮监听器挂在 `AbortController` 的 signal 上；`mountSignal` 的 abort 监听在 `destroy()` 中显式移除，计时器也在那里清理；
- `?debug=1&rows=...&cols=...&mineCount=...&safeFirst=...` 提供只读状态与棋盘配置（另可用 `mines=row,col;...` 固定雷盘、`seed` 固定随机数；缺省、空串、非数字或非有限值回退为 1，只有显式 `seed=0` 才是 0），以及 e2e 专用的 `destroy()`，正常入口不安装调试 API。
- 新增 DOM 游戏时不需要 Phaser；`meta.engine` 写 `'dom'`，大厅会自动显示对应的引擎标签。

## 11. 3D（Three.js）接入

首个 3D 游戏接入时：

- 新建 `src/games/<id>/`，`scene.ts` 中用命名导入（如 `import { WebGLRenderer, Scene, PerspectiveCamera } from 'three'`）保持 tree-shaking，由 `index.ts` 动态加载视图；
- 在 `mount()` 创建 `WebGLRenderer`，由 `destroy()` 调用 `renderer.dispose()`、释放几何体 / 材质 / 纹理并移除 canvas；
- 用 `ResizeObserver` 或共享的容器尺寸监听同步相机宽高比；
- 页面隐藏时暂停 `setAnimationLoop`，恢复时继续；
- 相机控制器（OrbitControls / PointerLockControls）和 GLTF 加载器按该游戏需要引入，不放进 `core/`；
- 路由、存储、音效、暂停、返回大厅沿用共享契约；
- 资源放 `public/games/<id>/`，首版避免大体积 glTF；首个 3D 游戏落地后再把实测包体写回选型文档。

## 12. 测试

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # oxlint + 模块边界检查
npm run test:unit    # Vitest：storage / input / router / dom 与五个游戏的纯规则引擎
npm run build        # 类型检查 + 生产构建
npm run check:budget # 入口无引擎、体积预算
npm run test:e2e     # 先 build，再用 vite preview 跑 Chromium 桌面 / Pixel 7 与 mobile-webkit
npm run test:e2e:webkit # 先 build，只跑 mobile-webkit（iPhone SE (3rd gen)）
```

当前提交本地通过：`typecheck`、`lint`、`build`、`check:budget` 通过；`npm run test:unit` 417 passed；`npm run test:e2e` 149 passed（桌面 85 + 手机 34 + WebKit 30）。

- 单测只覆盖引擎无关逻辑；不要在 Node 里启动 Phaser。
- 端到端使用 `data-testid`，覆盖进入 / 返回、最近游玩时间、键盘 / 鼠标 / 触屏、修饰键、重置、容器级缩放、未知路由、快速切换的晚到 mount、休眠时销毁和监听器清理；贪食蛇、俄罗斯方块、2048、打砖块与扫雷另有完整玩法用例（暂停 / 重开、计分 / 结束、窗口失焦暂停与恢复、手机端触屏按钮或拖动、像素绘制与监听器清理，扫雷另有左右键、固定雷盘、难度预设与自定义切换、非法自定义错误、格子可见文本、焦点迁移、畸形调试雷盘回退、胜利 / 踩雷与计时器 / 调试接缝清理）。
- 端到端会先构建，`webServer` 启动 `npm run preview`，因此测试的是生产产物，而不是 dev server。需要固定状态时由游戏通过 hash 路由后的 `?debug=1`（例如 `/#/games/breakout?debug=1`）提供只读调试接缝，测试不依赖开发服务器。
- 生产构建后可用 `npm run preview` 手工检查 `dist/`。
- 截图由 `npm run screenshots`（通用页）与 `npm run screenshots:breakout` 等游戏专用脚本生成；游戏与界面截图脚本的 WebKit 模式（`--webkit` 与专用 `--webkit-narrow`，例如 `npm run screenshots:minesweeper:webkit`、`npm run screenshots:minesweeper:webkit-narrow`）用 iPhone SE (3rd gen) 设备模拟产出 WebKit 证据，来源、复现命令与引擎 / 视口 / 主题记录见 [screenshots/README.md](./screenshots/README.md)。

### 12.1 浏览器覆盖与真实 iOS 限制

扫雷窄屏布局契约现在由 Chromium 与 WebKit 两套 Playwright 模拟共同验证。以下 7 条是唯一契约；文档、e2e 与验收共用同一组视口，新增宽度按第 7 条处理，不再逐条开单。

1. **最低支持视口 320×640**：320px 与 `src/styles/app.css` 的 `html { min-width: 320px }` 一致，640px 是最低保证高度；高度 <640 的视口不保证首屏完整。
2. **格子尺寸**：9×9 棋盘在宽度 ≥340px 且高度 ≥640px 时每格 ≥36×36px；宽度 320–339px 是几何降级区间，保证每格 ≥34×34px（320px 下约 34.2px）。9×36px 已经占满 324px，再加上棋盘边框与 gap 无法放进 320px，因此这一区间不承诺 36px。
3. **首屏入口**：矩阵内每个视口的首屏必须包含返回大厅、剩余雷数、计时器、touch-hint 与 `mobile-restart-button`（重开入口），且页面不横向滚动。
4. **覆盖矩阵**：Chromium 8 个视口为 320×640、340×700、349×700、360×640、360×740、375×667、400×700、412×839；WebKit 4 个视口为 320×640、360×640、375×667、412×839。四个视口都断言重开入口在首屏内，320×640 与 412×839 的既有断言未放宽。
5. **矩阵外边界**：未列入矩阵的组合（例如 375×640、400×667）即使命中短窄间距查询，也不承诺重开入口在首屏内；这是明确的契约边界，不是回归。
6. **大棋盘降级**：列数 >9 的大棋盘只有 9×9 享受 ≥36px 触控目标保证；大棋盘在窄屏按比例缩小并显示中文降级提示（#86），建议横屏或改用更小的棋盘，页面不横向滚动。
7. **新宽度规则**：后续新增视口宽度若落在既有媒体查询 / 尺寸公式内，按同一规则处理并补对应 e2e，不再逐条开单；超出规则范围的组合记录为已知限制。

现有 Playwright 覆盖：

- `mobile`（Pixel 7）项目运行 `tests/e2e/minesweeper.mobile.spec.ts` 的 Chromium 8 视口矩阵，并覆盖窄屏边界用例（用计算样式钉住短窄查询的 min-width / max-width / max-height 边界）；`chromium`（桌面 1440×1000）项目继续覆盖桌面交互，不运行该手机矩阵。
- `mobile-webkit` 项目使用 `devices['iPhone SE (3rd gen)']`（WebKit 引擎），运行 `tests/e2e/minesweeper.webkit.spec.ts` 冒烟、`tests/e2e/minesweeper.narrow.webkit.spec.ts` 的 WebKit 4 视口矩阵，以及复用共享用例模块的手机端用例：`tests/e2e/framework.mobile.webkit.spec.ts`（共享 `tests/e2e/framework-mobile-cases.ts`）、`tests/e2e/minesweeper.mobile.webkit.spec.ts`（轻点 / 长按 / 双指针 / 取消与重开焦点，共享 `tests/e2e/minesweeper-mobile-touch-cases.ts`）、`tests/e2e/minesweeper.difficulty.mobile.webkit.spec.ts`（触屏难度预设与自定义表单，共享 `tests/e2e/minesweeper-difficulty-mobile-cases.ts`）、`tests/e2e/snake.mobile.webkit.spec.ts`（D-pad 触屏、触屏 / 键盘混用、暂停与死亡重开，共享 `tests/e2e/snake-mobile-cases.ts`）、`tests/e2e/tetris.mobile.webkit.spec.ts`（触屏按钮移动 / 旋转 / 暂停 / 硬降、堆顶结束与重开，共享 `tests/e2e/tetris-mobile-cases.ts`）、`tests/e2e/2048.mobile.webkit.spec.ts`（滑动开始 / 合并计分 / 无横向溢出，共享 `tests/e2e/2048-mobile-cases.ts`）和 `tests/e2e/breakout.mobile.webkit.spec.ts`（拖动挡板 / 无横向溢出，共享 `tests/e2e/breakout-mobile-cases.ts`）。滑动与拖动统一由 `tests/e2e/touch-input.ts` 的跨引擎指针事件 helper 注入。
- Chromium 8 视口与 WebKit 4 视口矩阵的归属保持不变；截图脚本也提供 WebKit 模式，命令与引擎 / 视口 / 主题记录见 [screenshots/README.md](./screenshots/README.md)，Chromium 模式无回归。

首次运行需要安装两个引擎：

```bash
npx playwright install chromium webkit
npm run test:e2e        # 全部项目：Chromium 桌面 + Pixel 7 + mobile-webkit
npm run test:e2e:webkit # 只跑 mobile-webkit
```

实测差异与处理方式：

- **动态地址栏与 `dvh`**：Playwright 不模拟 iOS 动态地址栏；`100dvh` 等于模拟视口内高（与 Chromium 一致），真实 Safari 地址栏伸缩仍需真机验收。
- **安全区**：iPhone SE (3rd gen) 模拟下 `env(safe-area-inset-*)` 为 0px，刘海 / Home 指示条安全区未被模拟。
- **字体度量**：Linux WebKit 回退字体使「返回大厅」文本比 Chromium 宽约 3%（68.33px vs 66.45px）；契约断言元素边界而非固定文本宽度。
- **触屏媒体查询**：`any-pointer: coarse` 在两套模拟下都命中，touch-hint 与紧凑重开入口都会渲染。
- **长按 / 双指针 / 滑动 / 拖动注入**：Playwright 没有跨引擎的「保持按住」触摸 API，WebKit 也没有 CDP；e2e 共享辅助函数与截图脚本的 `scripts/lib/touch-input.mjs` 在 Chromium 与 WebKit 两端统一派发同语义的 `PointerEvent`（pointerdown / pointermove / pointercancel / pointerup 与 release click），所以测试与截图都不再依赖 `newCDPSession` 或 `Input.dispatchTouchEvent`。产品代码不分叉，差异只在测试 / 截图注入层；真实轻点仍用 `page.touchscreen.tap`，WebKit 环境假设用例会断言 release click 的构造器与 pointerId，防止注入形状与引擎实际行为漂移。
- **真实 iOS**：CI 没有 iOS Safari / 真机，触屏手感、安全区与渲染像素仍需人工验收；WebKit 模拟通过不代表 iOS Safari 已完全兼容。

## 13. 环境与命令

```bash
npm install
npx playwright install chromium webkit  # e2e 需要 Chromium 与 WebKit
npm run dev        # http://localhost:5173
npm run build
npm run preview
```

Node.js `^22.12.0 || ^24.0.0 || >=26.0.0`（Vite 8 的要求）。CI（`.github/workflows/ci.yml`）按 `npm ci` → `pre-commit` → `typecheck` → `lint` → `test:unit` → `build` → `check:budget` → `test:e2e` 的顺序执行，并在 e2e 前安装 Chromium 与 WebKit。

## 14. 性能与已知限制

- 大厅首屏不包含 Phaser；Phaser 只在进入使用 Phaser 的 2D 游戏时加载（本地构建 chunk 约 1.3 MB / 357 KB gzip），扫雷等 DOM 游戏不加载它。
- 入口 JS 约 10.91 KB gzip；`check:budget` 断言入口不含引擎且小于 50 KB，全部 JS chunk 小于 450 KB gzip（当前约 404.24 KB gzip）。
- 3D 尚未实现，Three.js 只在文档与目录层面预留。
- 空白示例只演示框架能力；`src/games/snake/`、`src/games/tetris/`、`src/games/2048/`、`src/games/breakout/` 与 `src/games/minesweeper/` 是完整玩法参考（规则引擎、渲染器、响应式视图、测试）。扫雷是纯 DOM 参考，其余四款使用 Phaser 场景。
- 打砖块固定 480×720 逻辑球场与 10 列砖块，没有道具、多球或在线排行榜；难度曲线由砖块行数与球速控制。
- 扫雷提供初级 / 中级 / 高级三档预设与 5–30 行、5–30 列的自定义棋盘；没有撤销、问号标记、道具或在线排行榜。
- Lint 使用 oxlint 而不是 ESLint：TypeScript 7 暂无 JS Compiler API，`typescript-eslint` 的 peer 范围也尚未覆盖 TS 7；oxlint 负责 TS 语法与常见规则，目录边界由本地脚本补足。
- 手机端使用 Playwright 的 Chromium / WebKit 设备模拟：扫雷窄屏首屏契约已在 Chromium 8 视口与 WebKit 4 视口验证，framework 手机端、扫雷触屏手势 / 触屏难度表单以及贪食蛇、俄罗斯方块、2048 与打砖块的手机端 spec 也已在两引擎运行，四个 WebKit 视口都断言重开入口在首屏内，但 WebKit 不等于 iOS Safari（不模拟动态地址栏与安全区），真实触屏手感与 iOS 渲染仍需人工验收。2048 与 breakout 的手机端 spec 也已在两引擎运行。截图脚本的 WebKit 模式覆盖大厅、空白画布、扫雷（含窄屏矩阵与成绩榜）、贪食蛇、2048 与打砖块的稳定场景；俄罗斯方块只有 e2e 覆盖、没有截图脚本。扫雷窄屏契约的边界是最低支持视口 320×640（高度 <640 不保证）；宽度 ≥340px 且高度 ≥640px 时 81 格 ≥36×36px，320–339px 为几何降级区间（每格 ≥34×34px），因为 9×36px 加边框与 gap 无法放进 320px；矩阵外组合（例如 375×640、400×667）不承诺重开入口在首屏内，列数 >9 的大棋盘只按比例缩小并显示中文降级提示（#86）、不再保证 36px。
