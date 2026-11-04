import { AudioService } from '../core/audio';
import { createBrowserStorage } from '../core/storage';
import { query } from '../core/dom';
import type { GameHandle } from '../core/game';
import { findGame } from '../games/registry';
import { renderHub } from './hub';

const REPO_URL = 'https://github.com/yeahdongcn-mk2/playground';
const DOCS_URL = `${REPO_URL}/blob/main/docs/framework-selection.md`;

type Route = { kind: 'home' } | { kind: 'game'; id: string };

const SOUND_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 9.5h3.2L12 5.5v13L7.2 14.5H4z" fill="currentColor" stroke="none" />
    <path class="sound-on" d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" />
    <path class="sound-off" d="M15.5 9.5l5 5M20.5 9.5l-5 5" />
  </svg>
`;

const GITHUB_ICON = `
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.54 2.87 8.39 6.84 9.75.5.1.68-.22.68-.49
      0-.24-.01-.87-.01-1.7-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62
      1 .07 1.53 1.06 1.53 1.06.89 1.57 2.34 1.12 2.91.86.09-.66.35-1.12.63-1.38-2.22-.26-4.55-1.14-4.55-5.07
      0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.36 9.36 0 0 1 5 0
      c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75
      0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.82 0 .27.18.6.69.49
      A10.27 10.27 0 0 0 22 12.26C22 6.58 17.52 2 12 2z" />
  </svg>
`;

export class App {
  private readonly root: HTMLElement;
  private readonly storage = createBrowserStorage();
  private readonly audio: AudioService;
  private readonly view: HTMLElement;
  private readonly soundButton: HTMLButtonElement;
  private currentHandle: GameHandle | null = null;
  private renderToken = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    this.audio = new AudioService(this.storage);
    this.root.innerHTML = `
      <header class="site-header">
        <a class="brand" href="#/" aria-label="Playground Arcade 首页">
          <span class="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32">
              <rect x="2.5" y="2.5" width="27" height="27" rx="8" fill="#0b1526"
                stroke="rgba(163, 230, 53, 0.4)" />
              <path d="M9 21h6v-5h5v5h4" fill="none" stroke="#a3e635" stroke-width="3"
                stroke-linecap="round" stroke-linejoin="round" />
              <circle cx="10" cy="10" r="2" fill="#fb7185" />
            </svg>
          </span>
          <span class="brand-text"><strong>PLAYGROUND</strong><span>ARCADE</span></span>
        </a>
        <nav class="header-nav" aria-label="站点操作">
          <button class="icon-button" type="button" data-action="sound" data-testid="sound-toggle"
            aria-pressed="true" aria-label="关闭音效" title="关闭音效">
            ${SOUND_ICON}
          </button>
          <a class="icon-button" href="${REPO_URL}" target="_blank" rel="noreferrer"
            aria-label="GitHub 仓库" title="GitHub 仓库">
            ${GITHUB_ICON}
          </a>
        </nav>
      </header>
      <main id="view" class="view" tabindex="-1"></main>
      <footer class="site-footer">
        <p>Playground Arcade · 用 Vite + TypeScript + Phaser 4 构建</p>
        <p class="footer-meta">
          <a href="${REPO_URL}" target="_blank" rel="noreferrer">GitHub</a>
          <span aria-hidden="true">·</span>
          <a href="${DOCS_URL}" target="_blank" rel="noreferrer">框架选型</a>
          <span aria-hidden="true">·</span>
          <span>© ${new Date().getFullYear()}</span>
        </p>
      </footer>
    `;

    this.view = query<HTMLElement>(this.root, '#view');
    this.soundButton = query<HTMLButtonElement>(this.root, '[data-action="sound"]');
    this.bindSound();
  }

  start(): void {
    window.addEventListener('hashchange', this.handleHashChange);
    window.addEventListener('beforeunload', () => this.destroyCurrentGame());
    this.renderSoundState();
    void this.renderRoute();
  }

  private readonly handleHashChange = (): void => {
    void this.renderRoute();
  };

  private async renderRoute(): Promise<void> {
    if (window.location.hash === '#stack') {
      const stack = document.getElementById('stack');
      if (stack) {
        stack.scrollIntoView({ block: 'start' });
        return;
      }
    }

    const token = (this.renderToken += 1);
    this.destroyCurrentGame();
    const route = parseRoute(window.location.hash);
    window.scrollTo(0, 0);

    if (route.kind === 'home') {
      this.view.className = 'view';
      this.view.innerHTML = renderHub();
      document.title = 'Playground Arcade · 贪食蛇';
      if (window.location.hash === '#stack') {
        requestAnimationFrame(() => {
          document.getElementById('stack')?.scrollIntoView({ block: 'start' });
        });
      }
      return;
    }

    const game = findGame(route.id);
    if (!game) {
      this.renderGameError('没有找到这个游戏');
      return;
    }

    this.view.className = 'view view--game';
    this.view.innerHTML = `
      <div class="game-loading" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <p>正在加载「${game.meta.title}」…</p>
      </div>
    `;
    document.title = `${game.meta.title} · Playground Arcade`;

    const mountPoint = document.createElement('div');
    mountPoint.className = 'game-mount';
    this.view.replaceChildren(mountPoint);

    try {
      const handle = await game.mount(mountPoint, {
        storage: this.storage,
        audio: this.audio,
      });
      if (token !== this.renderToken) {
        handle.destroy();
        mountPoint.remove();
        return;
      }
      this.currentHandle = handle;
      this.view.focus({ preventScroll: true });
    } catch (error) {
      console.error(error);
      if (token === this.renderToken) {
        this.renderGameError(`「${game.meta.title}」加载失败`);
      }
    }
  }

  private destroyCurrentGame(): void {
    if (this.currentHandle) {
      this.currentHandle.destroy();
      this.currentHandle = null;
    }
  }

  private renderGameError(message: string): void {
    this.view.className = 'view';
    this.view.innerHTML = `
      <section class="game-error">
        <p class="eyebrow">LOAD ERROR</p>
        <h1>${message}</h1>
        <p>请刷新页面重试；如果问题持续出现，欢迎在 GitHub Issue 中反馈。</p>
        <a class="button button--primary" href="#/">返回游戏库</a>
      </section>
    `;
    document.title = 'Playground Arcade · 加载失败';
  }

  private bindSound(): void {
    this.soundButton.addEventListener('click', () => {
      this.audio.toggle();
      this.renderSoundState();
      this.audio.unlock();
      this.soundButton.blur();
    });

    const unlock = (): void => this.audio.unlock();
    document.addEventListener('pointerdown', unlock, { once: true, capture: true });
    document.addEventListener('keydown', unlock, { once: true, capture: true });
  }

  private renderSoundState(): void {
    const enabled = this.audio.enabled;
    this.soundButton.classList.toggle('is-muted', !enabled);
    this.soundButton.setAttribute('aria-pressed', String(enabled));
    const label = enabled ? '关闭音效' : '开启音效';
    this.soundButton.setAttribute('aria-label', label);
    this.soundButton.setAttribute('title', label);
  }
}

function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/^\/+/, '');
  const [section, id] = path.split('/');
  if (section === 'games' && id) {
    return { kind: 'game', id };
  }
  return { kind: 'home' };
}
