import type { GameEngine } from '../core/game';
import { GAMES, UPCOMING_GAMES } from '../games/registry';

const ENGINE_LABELS: Readonly<Record<GameEngine, { dimension: string; label: string }>> = {
  phaser: { dimension: '2D', label: 'Phaser 4' },
  three: { dimension: '3D', label: 'Three.js' },
  dom: { dimension: '2D', label: 'DOM' },
};

const REPO_URL = 'https://github.com/yeahdongcn-mk2/playground';
const DOCS_URL = `${REPO_URL}/blob/main/docs/framework-selection.md`;

/** Static, dependency-free hub markup. No user input is interpolated here. */
export function renderHub(): string {
  const playableCards = GAMES.map((game) => {
    const meta = game.meta;
    const engine = ENGINE_LABELS[meta.engine];
    return `
      <a
        class="game-card game-card--playable"
        href="#/games/${meta.id}"
        data-testid="game-card-${meta.id}"
        style="--accent: ${meta.accent}"
      >
        <div class="card-art">
          ${snakeArt(`card-${meta.id}`)}
          <span class="card-badge card-badge--play">可游玩</span>
        </div>
        <div class="card-body">
          <div class="card-tags">
            <span>${engine.dimension}</span>
            <span>${engine.label}</span>
            <span>${meta.genre}</span>
          </div>
          <h3>${meta.title} <span>${meta.englishTitle}</span></h3>
          <p>${meta.description}</p>
          <span class="card-cta">开始游戏 <span aria-hidden="true">→</span></span>
        </div>
      </a>
    `;
  }).join('');

  const upcomingCards = UPCOMING_GAMES.map((game) => `
    <article class="game-card game-card--soon" style="--accent: ${game.accent}">
      <div class="card-art">
        ${game.englishTitle === 'Neon Breakout' ? breakoutArt('card-breakout') : labyrinthArt('card-maze')}
        <span class="card-badge card-badge--soon">规划中</span>
      </div>
      <div class="card-body">
        <div class="card-tags">
          <span>${game.engine}</span>
          <span>路线图</span>
        </div>
        <h3>${game.title} <span>${game.englishTitle}</span></h3>
        <p>${game.description}</p>
        <span class="card-cta">规划中 · <a href="https://github.com/yeahdongcn-mk2/playground/issues" target="_blank" rel="noreferrer">欢迎在 Issue 里投票</a></span>
      </div>
    </article>
  `).join('');

  return `
    <div class="shell">
      <section class="hero" aria-labelledby="hero-title">
        <div class="hero-copy">
          <p class="eyebrow"><span class="pulse-dot" aria-hidden="true"></span> PLAYGROUND ARCADE · VOL. 01</p>
          <h1 id="hero-title">小游戏，<br /><em>认真做。</em></h1>
          <p class="hero-lede">
            一个可以持续生长的浏览器游戏实验场：共享大厅、输入、存档与音效，
            游戏引擎按需加载。第一款作品是经典贪食蛇，后续会加入 2D 街机与 3D 作品。
          </p>
          <div class="hero-actions">
            <a class="button button--primary" href="#/games/snake">立即开玩 <span aria-hidden="true">→</span></a>
            <a class="button button--ghost" href="#stack">看看技术底座</a>
          </div>
          <dl class="hero-stats">
            <div><dt>2D 引擎</dt><dd>Phaser 4</dd></div>
            <div><dt>3D 计划</dt><dd>Three.js</dd></div>
            <div><dt>后端依赖</dt><dd>0</dd></div>
          </dl>
        </div>

        <div class="hero-visual" aria-hidden="true">
          <div class="cabinet">
            <div class="cabinet-top">
              <span class="cabinet-dot"></span><span class="cabinet-dot"></span><span class="cabinet-dot"></span>
              <span class="cabinet-label">PLAYER 1 · READY</span>
            </div>
            <div class="cabinet-screen">
              ${snakeArt('hero')}
              <span class="screen-scan"></span>
            </div>
            <div class="cabinet-bottom">
              <span>INSERT COIN</span>
              <span class="blink">●</span>
              <span>1 PLAYER</span>
            </div>
          </div>
          <span class="hero-chip hero-chip--one">60 FPS</span>
          <span class="hero-chip hero-chip--two">WebGL / Canvas</span>
        </div>
      </section>

      <section class="section" id="games" aria-labelledby="games-title">
        <div class="section-head">
          <h2 id="games-title">游戏库</h2>
          <p>${GAMES.length} 款可玩 · ${UPCOMING_GAMES.length} 款规划中</p>
        </div>
        <div class="game-grid">
          ${playableCards}
          ${upcomingCards}
        </div>
      </section>

      <section class="section" id="stack" aria-labelledby="stack-title">
        <div class="section-head">
          <h2 id="stack-title">技术底座</h2>
          <p>共享外壳 + 按需引擎，2D 与 3D 各自用最合适的工具</p>
        </div>
        <div class="stack-grid">
          <article class="stack-card">
            <span class="stack-index">01 / BUILD</span>
            <h3>Vite 8 + TypeScript 7</h3>
            <p>秒级开发服务器、严格类型检查、按游戏自动拆包。大厅首屏不下载任何游戏引擎。</p>
          </article>
          <article class="stack-card">
            <span class="stack-index">02 / 2D</span>
            <h3>Phaser 4</h3>
            <p>场景、输入、音频、动效与粒子开箱即用。贪食蛇已经跑通这套 2D 游戏适配层。</p>
          </article>
          <article class="stack-card">
            <span class="stack-index">03 / 3D</span>
            <h3>Three.js（规划）</h3>
            <p>首个 3D 作品接入时新增渲染适配器；大厅、存档、音效和输入契约保持不变。</p>
          </article>
        </div>
        <p class="stack-note">
          完整的框架对比、架构决策与路线图记录在仓库
          <a href="${DOCS_URL}" target="_blank" rel="noreferrer">技术选型文档</a> 中。
        </p>
      </section>
    </div>
  `;
}

function snakeArt(id: string): string {
  const verticals = Array.from(
    { length: 17 },
    (_, index) => `<line x1="${index * 25}" y1="0" x2="${index * 25}" y2="225" />`,
  ).join('');
  const horizontals = Array.from(
    { length: 10 },
    (_, index) => `<line x1="0" y1="${index * 25}" x2="400" y2="${index * 25}" />`,
  ).join('');

  return `
    <svg class="art-svg" viewBox="0 0 400 225" role="img" aria-label="贪食蛇画面示意">
      <defs>
        <linearGradient id="${id}-body" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stop-color="#4d7c0f" />
          <stop offset="1" stop-color="#bef264" />
        </linearGradient>
        <filter id="${id}-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect width="400" height="225" fill="#08111f" />
      <g stroke="#15243a" stroke-width="1" opacity="0.7">${verticals}${horizontals}</g>
      <circle cx="318" cy="68" r="18" fill="#fb7185" opacity="0.16" />
      <circle cx="318" cy="68" r="9" fill="#fb7185" />
      <circle cx="315" cy="65" r="2.2" fill="#ffffff" opacity="0.6" />
      <path
        d="M72 168 H150 V96 H244 V148 H310"
        fill="none"
        stroke="url(#${id}-body)"
        stroke-width="20"
        stroke-linecap="round"
        stroke-linejoin="round"
        filter="url(#${id}-glow)"
      />
      <circle cx="318" cy="142" r="2.6" fill="#0a101d" />
      <circle cx="318" cy="154" r="2.6" fill="#0a101d" />
    </svg>
  `;
}

function breakoutArt(id: string): string {
  const bricks = [
    { x: 46, y: 46, fill: '#22d3ee' },
    { x: 106, y: 46, fill: '#38bdf8' },
    { x: 166, y: 46, fill: '#818cf8' },
    { x: 226, y: 46, fill: '#c084fc' },
    { x: 286, y: 46, fill: '#f472b6' },
    { x: 76, y: 72, fill: '#38bdf8' },
    { x: 136, y: 72, fill: '#818cf8' },
    { x: 196, y: 72, fill: '#c084fc' },
    { x: 256, y: 72, fill: '#f472b6' },
  ]
    .map(
      (brick) =>
        `<rect x="${brick.x}" y="${brick.y}" width="48" height="16" rx="4" fill="${brick.fill}" opacity="0.85" />`,
    )
    .join('');

  return `
    <svg class="art-svg" viewBox="0 0 400 225" role="img" aria-label="霓虹打砖块画面示意">
      <defs>
        <radialGradient id="${id}-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0" stop-color="#22d3ee" stop-opacity="0.55" />
          <stop offset="1" stop-color="#22d3ee" stop-opacity="0" />
        </radialGradient>
      </defs>
      <rect width="400" height="225" fill="#071420" />
      <g stroke="#11293a" stroke-width="1" opacity="0.8">
        <line x1="0" y1="150" x2="400" y2="150" />
        <line x1="0" y1="180" x2="400" y2="180" />
      </g>
      ${bricks}
      <circle cx="250" cy="152" r="34" fill="url(#${id}-glow)" />
      <circle cx="250" cy="152" r="7" fill="#e0f2fe" />
      <rect x="150" y="196" width="100" height="10" rx="5" fill="#22d3ee" />
    </svg>
  `;
}

function labyrinthArt(id: string): string {
  return `
    <svg class="art-svg" viewBox="0 0 400 225" role="img" aria-label="3D 立体迷宫画面示意">
      <defs>
        <linearGradient id="${id}-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#c084fc" />
          <stop offset="1" stop-color="#7c3aed" />
        </linearGradient>
      </defs>
      <rect width="400" height="225" fill="#0c0a1d" />
      <g opacity="0.5" stroke="#2a2350" stroke-width="1">
        <path d="M0 180 L200 80 L400 180 L200 280 Z" fill="none" />
        <path d="M0 140 L200 40 L400 140 L200 240 Z" fill="none" />
        <path d="M0 100 L200 0 L400 100 L200 200 Z" fill="none" />
      </g>
      <g>
        <path d="M176 106 L200 94 L224 106 L200 118 Z" fill="url(#${id}-top)" />
        <path d="M176 106 L200 118 L200 162 L176 150 Z" fill="#6d28d9" />
        <path d="M224 106 L200 118 L200 162 L224 150 Z" fill="#4c1d95" />
      </g>
      <g opacity="0.9">
        <path d="M256 126 L280 114 L304 126 L280 138 Z" fill="url(#${id}-top)" opacity="0.7" />
        <path d="M256 126 L280 138 L280 162 L256 150 Z" fill="#6d28d9" opacity="0.7" />
        <path d="M304 126 L280 138 L280 162 L304 150 Z" fill="#4c1d95" opacity="0.7" />
      </g>
      <circle cx="200" cy="139" r="30" fill="#c084fc" opacity="0.14" />
      <circle cx="200" cy="139" r="5" fill="#f5d0fe" />
    </svg>
  `;
}
