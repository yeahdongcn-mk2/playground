# 架构设计

本文说明 Playground Arcade 的分层、游戏契约、2D/3D 扩展方式与质量标准。选型依据见 [framework-selection.md](./framework-selection.md)，路线图见 [roadmap.md](./roadmap.md)。

## 1. 目标与非目标

**目标**

- 同一个仓库承载多个互不干扰的网页小游戏。
- 大厅首屏轻量；只有进入某个游戏时才加载该游戏的引擎。
- 游戏规则与渲染解耦，规则可以在 Node（Vitest）中测试。
- 新游戏接入成本低：实现一个 `GameModule`，注册后自动出现在大厅；卡片插画按游戏补充。
- 桌面、平板、手机都可玩；键盘和触屏都有完整操作路径。

**当前非目标**

- 后端账号、在线排行榜、实时对战。
- 通用编辑器或关卡工具。
- 服务端渲染（SSR）。这是一个静态 SPA，部署只需静态文件。
- 同时在一个游戏里混用多个 3D 引擎。

## 2. 分层结构

```
index.html
└── src/main.ts
    ├── app/App                 路由、站点头部、页脚、音效开关
    │   └── app/hub.ts          大厅静态视图（DOM + CSS + 内联 SVG）
    ├── core/
    │   ├── game.ts             GameModule / GameHandle / GameServices 契约
    │   ├── storage.ts          带命名空间与容错的 localStorage 封装
    │   ├── audio.ts            WebAudio 合成音效（无音频资源）
    │   └── dom.ts              小型 DOM 查询辅助
    └── games/
        ├── registry.ts         游戏注册表 + 路线图卡片数据
        └── snake/
            ├── index.ts        GameModule 元数据与懒加载入口
            ├── engine.ts       纯规则引擎（无 DOM / 无 Phaser）
            ├── engine.test.ts  引擎单元测试
            ├── scene.ts        Phaser 场景：绘制与键盘
            ├── snake-view.ts   DOM HUD/覆盖层/触屏 + 生命周期
            └── debug.ts        仅开发环境的测试类型声明
```

### 依赖方向

```
app  →  core
app  →  games/registry  →  games/<game>/index（只含元数据）
games/<game>/snake-view  →  core + engine + scene
scene                   →  Phaser（懒加载）
```

核心层**不得**导入任何游戏或引擎。`games/<game>/index.ts` 只能静态导入类型与元数据，引擎必须放在 `mount()` 内部的动态 `import()` 之后。

## 3. 游戏契约

```ts
export interface GameMeta {
  id: string;
  title: string;
  englishTitle: string;
  description: string;
  engine: 'phaser' | 'three' | 'dom';
  genre: string;
  accent: string;
}

export interface GameServices {
  storage: StorageService;
  audio: AudioService;
}

export interface GameHandle {
  destroy(): void;
}

export interface GameModule {
  meta: GameMeta;
  mount(root: HTMLElement, services: GameServices): Promise<GameHandle>;
}
```

约定：

- `mount()` 拥有传入容器内的 DOM 与引擎实例；`destroy()` 必须移除全部全局监听器、动画帧、WebAudio 节点引用和画布。
- 游戏不得自行修改 URL 路由；返回大厅统一使用 `href="#/"`。
- 存档使用 `GameServices.storage` 并自带游戏前缀（如 `snake.highscore`），由服务统一加 `playground:v1:` 命名空间。
- 音效走 `GameServices.audio`，尊重用户在站点头部的全局开关。
- 游戏的最高分等持久化数据必须在游戏结束后仍可恢复。

### 生命周期

```
hashchange
  → App 销毁上一个 GameHandle
  → 显示加载态
  → 动态 import 游戏模块（引擎 chunk）
  → mount() 创建 DOM / 引擎
  → 用户游玩
  → 路由变化 / 页面卸载 → handle.destroy()
```

路由切换时的竞态由 `renderToken` 保护：过期的异步 `mount()` 完成后会立即销毁，不会覆盖新页面。

## 4. 2D 适配层（当前：Phaser 4）

贪食蛇把 2D 游戏拆成三部分：

1. **规则引擎**（`engine.ts`）：网格、蛇身、食物、碰撞、速度、状态机。零浏览器依赖，17 个单元测试覆盖；`core/storage` 另有 6 个容错测试。
2. **渲染与键盘**（`scene.ts`）：Phaser Scene 负责棋盘、蛇、果实、眼睛、相机反馈和键盘映射；只读取引擎快照，不修改规则。
3. **DOM 外壳**（`snake-view.ts`）：HUD、覆盖层、按钮、触屏方向键、滑动、可见性自动暂停、存档、音效、调试钩子。

后续 2D 游戏沿用同一模式：

- 逻辑放 `engine.ts`（或 `logic/`），先写测试再接引擎；
- Phaser Scene 只做表现与输入；
- HUD/菜单优先用 DOM（更容易访问、测试和响应式），棋盘/世界用 Phaser Canvas；
- 通过 `GameModule` 暴露统一的 `destroy()`。

## 5. 3D 适配计划（Three.js）

首个 3D 游戏（立体迷宫）接入时新增 `games/maze/`，不修改大厅和核心契约：

- `scene.ts` 内 `import * as THREE from 'three'`，由 `index.ts` 动态加载；
- 使用 `WebGLRenderer`，在 `mount()` 中创建、在 `destroy()` 中 `dispose()` 几何体/材质/纹理并移除 canvas；
- 相机与控制器（如 `PointerLockControls` / `OrbitControls`）按游戏需求引入，不放进共享层；
- 输入抽象：键盘/触屏映射保持在游戏内，但暂停、音效、最高分、返回大厅沿用共享约定；
- 资源：模型/纹理放 `public/games/<id>/`，按需加载；首版避免大体积 glTF；
- 渲染循环使用 `requestAnimationFrame` 或 Three.js `setAnimationLoop`，页面隐藏时暂停；
- 若未来 WebGPU 成为默认路径，优先评估 Three.js `WebGPURenderer`，保留 WebGL 回退。

3D 适配层尚未在当前 PR 中实现，属于路线图 M2；当前只保证契约和目录结构不会阻碍它。

## 6. 共享服务

### 存档（`core/storage.ts`）

- Key 形如 `playground:v1:<game>.<field>`。
- 读取失败、隐私模式、配额异常都返回 fallback，不阻塞游戏。
- 数字读取会校验 `Number.isFinite`，避免脏数据把 UI 变成 `NaN`。

### 音效（`core/audio.ts`）

- 使用 WebAudio 合成短音，不下载任何音频文件。
- 浏览器自动播放策略：第一次 pointerdown/keydown 时 `unlock()`。
- 全局开关持久化为 `playground:v1:settings.sound`。
- 没有 AudioContext 的环境静默降级。

### 测试接缝

仅开发环境（`import.meta.env.DEV`，生产构建会被消除）提供：

- `window.__playground.getState()`：只读的蛇状态快照，供 Playwright 断言；
- `?food=x,y`：把第一颗果实放到指定格，供确定性端到端测试与截图；
- 两者都不影响生产行为，也不暴露写接口。

## 7. 性能预算

| 指标 | 目标 | 当前 |
| --- | --- | --- |
| 大厅首屏 JS（gzip） | < 50 KB | 7.67 KB |
| 大厅首屏 CSS（gzip） | < 20 KB | 4.61 KB |
| 2D 游戏 chunk（gzip） | < 450 KB | 363.17 KB |
| 3D 游戏 chunk（gzip） | < 800 KB | 待首个 3D 游戏 |
| 交互帧率 | 60 FPS（目标） | 20×20 网格，棋盘与游戏两层 Graphics |
| 首局可玩时间（本地） | < 500 ms | 引擎 chunk 懒加载后立即进入 |

原则：

- 引擎不进首屏；
- 图形优先用 Phaser Graphics / 少量 Sprite，避免为小游戏引入大图集；
- 不为“可能用到”的库付费，按需引入；
- 新增大依赖前先记录包体变化。

## 8. 测试策略

```
         Playwright（真实 Chromium）
        /  路由、Canvas、键盘、触屏、存档
       /
      Vitest（jsdom / node）
     /  规则、状态机、边界、存档容错
    /
   TypeScript 严格类型检查 + Vite 生产构建
```

- **单元测试**：规则引擎是重点，覆盖移动、转向队列、吃食物、加速、撞墙、撞自己、尾随、胜利、暂停、重开、非法布局。
- **端到端**：验证真实浏览器中的挂载、开始、暂停、结束、重开、最高分持久化（保留更高分/覆盖更低分）、音效开关、移动端方向键与转向、滑动、页面隐藏自动暂停、路由返回。
- **CI**：类型检查 → 单元测试 → 生产构建 → 生产预览冒烟（确认 DEV 调试钩子不存在）→ Playwright。
- 视觉回归暂不做像素对比（字体/显卡差异大），以人工截图和关键 DOM/Canvas 断言为主。

## 9. 可访问性

- 所有按钮有可读文本或 `aria-label`；音效按钮使用 `aria-pressed`。
- 状态变化通过 `aria-live="polite"` 播报（开始、暂停、结束、胜利）。
- 键盘可完成全部操作；焦点有可见样式；遵循 `prefers-reduced-motion`（减少镜头抖动/闪烁）。
- 颜色不是唯一信息：分数、状态同时以文本和徽标表达。

## 10. 接入一个新游戏的清单

1. 在 `src/games/<id>/` 下实现规则模块与单元测试。
2. 实现 `index.ts`，导出 `GameModule`；引擎在 `mount()` 内动态导入。
3. 在 `games/registry.ts` 注册，并在 `app/hub.ts` 补充该游戏的卡片插画；若要展示“规划中”卡片，更新 `UPCOMING_GAMES`。
4. 复用 `GameServices`（存档/音效），使用 `snake.highscore` 式前缀。
5. 实现 `destroy()`：移除监听器、停止循环、销毁引擎资源。
6. 增加至少一个 Playwright 流程测试；更新文档与截图。
7. 运行 `npm run typecheck && npm run test:unit && npm run build && npm run test:e2e`。

## 11. 已知限制

- 目前只有一个真正的 2D 游戏，3D 适配器尚未落地；3D 部分为经过约束的设计，不是已验证实现。
- 经典模式固定 20×20，无穿墙/障碍物/道具；这些属于玩法扩展，不是框架能力缺失。
- 最高分只存在当前浏览器（localStorage），没有账号或跨设备同步。
- Phaser chunk 约 363 KB gzip；未来游戏增多时仍按游戏拆包，但每个 2D 游戏都会各自加载 Phaser（浏览器缓存可复用同一 URL）。
- 未接入 PWA / Service Worker，离线缓存暂未实现。
