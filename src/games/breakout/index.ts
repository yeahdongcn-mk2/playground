import type { GameModule } from '../../core/game';

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Game mount aborted', 'AbortError');
  }
}

export const breakoutGame: GameModule = {
  meta: {
    id: 'breakout',
    title: '打砖块',
    englishTitle: 'Breakout',
    description:
      '移动挡板接住小球，逐层击碎彩色砖墙。每过一关砖块更多、球速更快；漏球扣命，三条命用完结束。键盘、鼠标与触屏都能玩。',
    engine: 'phaser',
    genre: '街机 · 经典',
    accent: '#22d3ee',
    controls: ['← / → 或 A / D 移动挡板', '空格发球 / 继续', '触屏在球场上拖动挡板'],
  },
  async mount(root, services, signal) {
    throwIfAborted(signal);
    // The Phaser scene, rules engine and CSS only load when this game opens.
    const { mountBreakout } = await import('./view');
    throwIfAborted(signal);
    return mountBreakout(root, services, signal);
  },
};
