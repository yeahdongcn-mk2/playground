import type { GameModule } from '../../core/game';

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Game mount aborted', 'AbortError');
  }
}

export const zhenShaGame: GameModule = {
  meta: {
    id: 'zhen-sha',
    title: '镇煞',
    englishTitle: 'Zhen Sha',
    description:
      '一柄金棍，一位黑煞首领。轻点格挡杀招，长按蓄势，破防后松手一棍定胜负。三种手势就能试玩六十秒。',
    engine: 'dom',
    genre: '动作 · 弹反',
    accent: '#f6c453',
    controls: ['轻点：格挡', '长按：蓄势', '松手：棍击'],
  },
  async mount(root, services, signal) {
    throwIfAborted(signal);
    // Only the metadata lives in the shell bundle; the canvas view, its CSS and
    // the rules engine load when this game is opened.
    const { mountZhenSha } = await import('./zhen-sha-view');
    throwIfAborted(signal);
    return mountZhenSha(root, services, signal);
  },
};
