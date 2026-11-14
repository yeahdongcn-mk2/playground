import { AudioService } from '../core/audio';
import { escapeHtml, query } from '../core/dom';
import type { GameHandle, GameServices } from '../core/game';
import { createBrowserStorage } from '../core/storage';
import { findGame, games } from '../games/registry';
import { renderHub } from './hub';
import { PlayHistory } from './play-history';
import { gameHref, parseRoute } from './router';

const REPO_URL = 'https://github.com/yeahdongcn-mk2/playground';
const FRAMEWORK_DOC_URL = `${REPO_URL}/blob/main/docs/framework.md`;

const SOUND_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 9.5h3.2L12 5.5v13L7.2 14.5H4z" fill="currentColor" stroke="none" />
    <path class="sound-waves" d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" />
    <path class="sound-cross" d="M15.5 9.5l5 5M20.5 9.5l-5 5" />
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

const SHELL_HTML = `
  <a class="skip-link" href="#/">跳到主要内容</a>
  <header class="site-header">
    <a class="brand" href="#/" aria-label="Playground Arcade 首页">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32">
          <rect x="2.5" y="2.5" width="27" height="27" rx="8" fill="#0b1526"
            stroke="rgba(34, 211, 238, 0.45)" />
          <path d="M9 21h6v-5h5v5h4" fill="none" stroke="#67e8f9" stroke-width="3"
            stroke-linecap="round" stroke-linejoin="round" />
          <circle cx="10" cy="10" r="2" fill="#f0abfc" />
        </svg>
      </span>
      <span class="brand-text"><strong>PLAYGROUND</strong><span>ARCADE</span></span>
    </a>
    <nav class="site-nav" aria-label="站点导航">
      <a class="nav-link" href="#/">大厅</a>
      <a class="nav-link nav-link--docs" href="${FRAMEWORK_DOC_URL}" target="_blank" rel="noreferrer">
        框架说明
      </a>
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
    <div class="footer-brand">
      <strong>Playground Arcade</strong>
      <span>共享游戏框架 · 六款游戏已上线</span>
    </div>
    <div class="footer-links">
      <a href="${REPO_URL}" target="_blank" rel="noreferrer">GitHub</a>
      <a href="${FRAMEWORK_DOC_URL}" target="_blank" rel="noreferrer">框架说明</a>
      <span>Vite 8 · TypeScript 7 · Phaser 4</span>
    </div>
  </footer>
`;

export class App {
  private readonly root: HTMLElement;
  private readonly storage = createBrowserStorage();
  private readonly audio: AudioService;
  private readonly playHistory: PlayHistory;
  private readonly reduceMotion: boolean;
  private readonly view: HTMLElement;
  private readonly soundButton: HTMLButtonElement;
  private currentHandle: GameHandle | null = null;
  private currentController: AbortController | null = null;
  private renderToken = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    this.audio = new AudioService(this.storage);
    this.playHistory = new PlayHistory(this.storage);
    this.reduceMotion = prefersReducedMotion();
    this.root.innerHTML = SHELL_HTML;

    this.view = query<HTMLElement>(this.root, '#view');
    this.soundButton = query<HTMLButtonElement>(this.root, '[data-action="sound"]');
    this.bindChrome();
    this.renderSoundState();
  }

  start(): void {
    window.addEventListener('hashchange', this.handleHashChange);
    window.addEventListener('beforeunload', this.handleBeforeUnload);
    void this.renderRoute();
  }

  private readonly handleHashChange = (): void => {
    void this.renderRoute();
  };

  private readonly handleBeforeUnload = (): void => {
    this.destroyCurrentGame();
  };

  private bindChrome(): void {
    this.soundButton.addEventListener('click', () => {
      const enabled = this.audio.toggle();
      this.renderSoundState();
      if (enabled) {
        this.audio.play('blip');
      }
    });

    const skipLink = query<HTMLAnchorElement>(this.root, '.skip-link');
    skipLink.addEventListener('click', (event) => {
      event.preventDefault();
      this.view.focus({ preventScroll: false });
    });
  }

  private bindHubActions(): void {
    const scrollButton = query<HTMLButtonElement>(this.view, '[data-action="scroll-features"]');
    const features = query<HTMLElement>(this.view, '#features');
    scrollButton.addEventListener('click', () => {
      features.scrollIntoView({
        behavior: this.reduceMotion ? 'auto' : 'smooth',
        block: 'start',
      });
    });
  }

  private renderSoundState(): void {
    this.soundButton.setAttribute('aria-pressed', String(this.audio.enabled));
    const label = this.audio.enabled ? '关闭音效' : '开启音效';
    this.soundButton.setAttribute('aria-label', label);
    this.soundButton.title = label;
  }

  private async renderRoute(): Promise<void> {
    const token = (this.renderToken += 1);
    this.destroyCurrentGame();
    window.scrollTo(0, 0);

    const route = parseRoute(window.location.hash);
    this.root.dataset.route = route.kind;

    if (route.kind === 'home') {
      this.view.className = 'view';
      this.view.innerHTML = renderHub(games, this.playHistory);
      document.title = 'Playground Arcade · 共享游戏框架与六款游戏';
      this.bindHubActions();
      return;
    }

    if (route.kind === 'unknown') {
      this.renderRouteError('没有找到这个页面', `路由 #${route.path} 不存在。`, false);
      return;
    }

    const game = findGame(route.id);
    if (!game) {
      this.renderRouteError('没有找到这个游戏', `游戏 ${route.id} 尚未注册到大厅。`, true);
      return;
    }

    this.view.className = 'view view--game';
    document.title = `${game.meta.title} · Playground Arcade`;

    const mountPoint = document.createElement('div');
    mountPoint.className = 'game-mount';
    mountPoint.innerHTML = renderRouteLoading(game.meta.title);
    this.view.replaceChildren(mountPoint);

    const services: GameServices = {
      storage: this.storage,
      audio: this.audio,
      reduceMotion: this.reduceMotion,
    };

    const controller = new AbortController();
    this.currentController = controller;

    try {
      const handle = await game.mount(mountPoint, services, controller.signal);
      if (token !== this.renderToken || controller.signal.aborted) {
        handle.destroy();
        return;
      }
      this.currentHandle = handle;
      this.playHistory.record(game.meta.id);
      this.view.focus({ preventScroll: true });
    } catch (error) {
      if (token === this.renderToken) {
        this.currentController = null;
        if (controller.signal.aborted) {
          return;
        }
        console.error(`Failed to mount game "${game.meta.id}"`, error);
        this.renderRouteError(
          `「${game.meta.title}」加载失败`,
          '请检查网络后重试，或先返回大厅。',
          true,
        );
      }
    }
  }

  private renderRouteError(title: string, message: string, retry: boolean): void {
    this.view.className = 'view view--game';
    this.view.replaceChildren();
    const section = document.createElement('section');
    section.className = 'route-error';
    section.innerHTML = `
      <p class="panel-kicker">ROUTE ERROR</p>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <div class="route-error-actions">
        <a class="button button--primary" href="#/">返回大厅</a>
        ${retry ? '<button class="button button--ghost" type="button" data-action="retry">重试</button>' : ''}
      </div>
      <p class="route-error-hint">可用入口：<a href="${gameHref('blank')}">#/games/blank</a></p>
    `;
    this.view.append(section);
    document.title = `${title} · Playground Arcade`;

    section.querySelector<HTMLButtonElement>('[data-action="retry"]')?.addEventListener('click', () => {
      void this.renderRoute();
    });
  }

  private destroyCurrentGame(): void {
    this.currentController?.abort();
    this.currentController = null;
    if (!this.currentHandle) {
      return;
    }
    const handle = this.currentHandle;
    this.currentHandle = null;
    try {
      handle.destroy();
    } catch (error) {
      console.error('Failed to destroy the previous game', error);
    }
  }
}

function renderRouteLoading(title: string): string {
  return `
    <div class="route-loading" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <p>正在加载「${escapeHtml(title)}」…</p>
    </div>
  `;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
