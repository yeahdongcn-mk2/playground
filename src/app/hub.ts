import { escapeHtml } from '../core/dom';
import type { GameModule } from '../core/game';
import { formatLastPlayed, type PlayHistoryReader } from './play-history';
import { gameHref } from './router';

const GITHUB_URL = 'https://github.com/yeahdongcn-mk2/playground';

const FEATURES = [
  {
    index: '01',
    title: '主循环与场景',
    body: 'Phaser 的 update 循环与 Scene 生命周期被统一收进按需加载的 2D 适配层；页面隐藏时主循环休眠。',
  },
  {
    index: '02',
    title: '资源加载',
    body: '资源放在 public/games/<id>/，由场景 preload 统一加载；失败时保留可玩的回退画面。',
  },
  {
    index: '03',
    title: '输入统一',
    body: '方向键 / WASD、鼠标、触屏共用一套方向判定与边界钳制，游戏只实现自己的手势。',
  },
  {
    index: '04',
    title: '渲染适配',
    body: '容器尺寸驱动的 RESIZE 缩放 + ResizeObserver，桌面、平板、手机共用一块自适应画布。',
  },
  {
    index: '05',
    title: '页面壳',
    body: 'Hash 路由、加载 / 错误态、音效开关、存储服务与可访问性约定都由共享外壳提供。',
  },
  {
    index: '06',
    title: '2D / 3D 扩展',
    body: '契约与引擎无关：2D 用 Phaser，3D 预留给 Three.js；新游戏只需要一个 mount()。',
  },
] as const;

export function renderHub(
  games: readonly GameModule[],
  playHistory: PlayHistoryReader,
  now = Date.now(),
): string {
  return `
    <section class="hub">
      <section class="hero" aria-labelledby="hero-title">
        <div class="hero-copy">
          <p class="eyebrow"><span class="status-dot" aria-hidden="true"></span> SHARED GAME SHELL · ISSUE #11</p>
          <h1 id="hero-title">一块画布，<br /><span>无限种玩法。</span></h1>
          <p class="lede">
            用 Vite 8 + TypeScript 7 + Phaser 4 搭起的共享游戏底座：
            页面壳、按需引擎、输入、资源与自适应渲染已经接通，第一款完整游戏「贪食蛇」已经跑通。
          </p>
          <div class="hero-actions">
            <a class="button button--primary" href="${gameHref('snake')}" data-testid="enter-snake">
              开始贪食蛇 <span aria-hidden="true">→</span>
            </a>
            <a class="button button--ghost" href="${gameHref('blank')}" data-testid="enter-blank">
              进入空白画布
            </a>
            <button class="button button--ghost" type="button" data-action="scroll-features">
              看看框架能力
            </button>
          </div>
          <dl class="hero-stats">
            <div><dt>2D 引擎</dt><dd>Phaser 4</dd></div>
            <div><dt>外壳</dt><dd>原生 TS</dd></div>
            <div><dt>3D</dt><dd>Three.js 预留</dd></div>
            <div><dt>首屏</dt><dd>按需加载</dd></div>
          </dl>
        </div>
        <div class="hero-visual" aria-hidden="true">
          <div class="orb-stage">
            <span class="orb-ring orb-ring--outer"></span>
            <span class="orb-ring orb-ring--inner"></span>
            <span class="orb-core"></span>
            <span class="orb-caption">BLANK / CANVAS</span>
          </div>
        </div>
      </section>

      <section class="section" id="games" aria-labelledby="games-title">
        <div class="section-heading">
          <div>
            <p class="panel-kicker">PLAY</p>
            <h2 id="games-title">游戏大厅</h2>
          </div>
          <p>每个游戏一个动态 import；引擎随游戏 chunk 加载，大厅首屏不为未启动的游戏买单。</p>
        </div>
        <div class="game-grid">
          ${games.map((game) => renderGameCard(game, playHistory, now)).join('')}
          <article class="game-card game-card--placeholder" aria-label="更多游戏即将加入">
            <div class="game-card-art game-card-art--placeholder" aria-hidden="true">
              <span class="placeholder-grid"></span>
              <span class="placeholder-plus">+</span>
            </div>
            <div class="game-card-body">
              <p class="game-card-genre">下一款</p>
              <h3>你的游戏 <span>Your Game</span></h3>
              <p>实现 GameModule、注册元数据，然后让想法直接跑起来。2D 与 3D 共用同一套外壳。</p>
              <p class="game-card-cta game-card-cta--muted">等待接入</p>
            </div>
          </article>
        </div>
      </section>

      <section class="section" id="features" aria-labelledby="features-title">
        <div class="section-heading">
          <div>
            <p class="panel-kicker">FRAMEWORK</p>
            <h2 id="features-title">共享框架做了什么</h2>
          </div>
          <p>引擎无关的外壳 + 按需加载的引擎适配层。新增游戏不需要改核心层。</p>
        </div>
        <div class="feature-grid">
          ${FEATURES.map(
            (feature) => `
              <article class="feature-card">
                <span class="feature-index" aria-hidden="true">${feature.index}</span>
                <h3>${escapeHtml(feature.title)}</h3>
                <p>${escapeHtml(feature.body)}</p>
              </article>
            `,
          ).join('')}
        </div>
      </section>

      <section class="section section--split" id="start" aria-labelledby="start-title">
        <div>
          <p class="panel-kicker">QUICK START</p>
          <h2 id="start-title">三步跑起来</h2>
          <ol class="steps">
            <li><strong>安装</strong><span>需要 Node.js 22.12+、24+ 或 26+。</span></li>
            <li><strong>启动</strong><span>Vite 开发服务器默认在 5173 端口。</span></li>
            <li><strong>构建</strong><span>先跑类型检查，再产出静态 dist/。</span></li>
          </ol>
          <p class="section-note">
            接入新游戏的契约、目录约定与 3D 扩展路径见
            <a href="${GITHUB_URL}/blob/main/docs/framework.md" target="_blank" rel="noreferrer">框架使用说明</a>。
          </p>
        </div>
        <div class="code-card">
          <div class="code-card-bar" aria-hidden="true"><span></span><span></span><span></span></div>
          <pre><code><span class="code-comment"># 安装依赖</span>
npm install

<span class="code-comment"># 本地开发</span>
npm run dev

<span class="code-comment"># 类型检查 + 生产构建</span>
npm run build</code></pre>
        </div>
      </section>
    </section>
  `;
}

function renderGameCard(game: GameModule, playHistory: PlayHistoryReader, now: number): string {
  const meta = game.meta;
  const isSnake = meta.id === 'snake';
  return `
    <a class="game-card" href="${gameHref(meta.id)}" data-testid="game-card-${escapeHtml(meta.id)}"
      style="--game-accent: ${escapeHtml(meta.accent)}">
      <div class="game-card-art${isSnake ? ' game-card-art--snake' : ''}"
        aria-hidden="true">
        <span class="game-card-engine">${escapeHtml(engineLabel(meta.engine))}</span>
        ${renderCardArt(isSnake)}
      </div>
      <div class="game-card-body">
        <p class="game-card-genre">${escapeHtml(meta.genre)} · ${escapeHtml(meta.controls.join(' · '))}</p>
        <h3>${escapeHtml(meta.title)} <span>${escapeHtml(meta.englishTitle)}</span></h3>
        <p>${escapeHtml(meta.description)}</p>
        ${renderLastPlayed(meta.id, playHistory.lastPlayed(meta.id), now)}
        <p class="game-card-cta">打开 <span aria-hidden="true">→</span></p>
      </div>
    </a>
  `;
}

function renderLastPlayed(gameId: string, lastPlayed: number | null, now: number): string {
  const testId = `data-testid="game-card-last-played-${escapeHtml(gameId)}"`;
  if (lastPlayed === null) {
    return `
        <p class="game-card-played game-card-played--empty" ${testId}>
          <span class="game-card-played-label">最近游玩</span>
          <span class="game-card-played-value">还没玩过</span>
        </p>`;
  }

  const playedAt = new Date(lastPlayed);
  const datetime = Number.isNaN(playedAt.getTime())
    ? ''
    : ` datetime="${playedAt.toISOString()}"`;
  return `
        <p class="game-card-played" ${testId}>
          <span class="game-card-played-label">最近游玩</span>
          <time class="game-card-played-value"${datetime}>${escapeHtml(
            formatLastPlayed(lastPlayed, now),
          )}</time>
        </p>`;
}

function renderCardArt(isSnake: boolean): string {
  if (isSnake) {
    return `
      <svg class="snake-card-art" viewBox="0 0 220 132" aria-hidden="true">
        <defs>
          <linearGradient id="snake-card-body" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stop-color="#4d7c0f" />
            <stop offset="1" stop-color="#bef264" />
          </linearGradient>
        </defs>
        <g stroke="rgba(148,163,184,0.12)" stroke-width="1">
          <path d="M0 22H220M0 44H220M0 66H220M0 88H220M0 110H220" />
          <path d="M22 0V132M44 0V132M66 0V132M88 0V132M110 0V132M132 0V132M154 0V132M176 0V132M198 0V132" />
        </g>
        <path d="M34 104 H96 V54 H142 V88 H178" fill="none" stroke="url(#snake-card-body)"
          stroke-width="14" stroke-linecap="round" stroke-linejoin="round" />
        <circle cx="178" cy="40" r="9" fill="#fb7185" />
        <circle cx="175" cy="37" r="2.4" fill="#fff" opacity="0.7" />
        <circle cx="186" cy="34" r="3.2" fill="#4ade80" />
      </svg>
      <span class="mini-grid"></span>
    `;
  }
  return `
    <span class="mini-orb"></span>
    <span class="mini-grid"></span>
  `;
}

function engineLabel(engine: GameModule['meta']['engine']): string {
  switch (engine) {
    case 'phaser':
      return 'Phaser 4';
    case 'three':
      return 'Three.js';
    case 'dom':
      return 'DOM / Canvas';
  }
}
