import type { GameModule } from '../../core/game';

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Game mount aborted', 'AbortError');
  }
}

export const game2048: GameModule = {
  meta: {
    id: '2048',
    title: '2048',
    englishTitle: 'Twenty Forty-Eight',
    description:
      '滑动 4×4 棋盘，让相同数字合并翻倍。每次有效移动都会生成新方块，无路可走时结束。键盘、鼠标与触屏都能玩。',
    engine: 'phaser',
    genre: '益智 · 数字',
    accent: '#fbbf24',
    controls: ['方向键 / WASD 滑动', '触屏在棋盘上滑动', 'R 开始 / 重新开始'],
  },
  async mount(root, services, signal) {
    throwIfAborted(signal);
    // The Phaser scene and its CSS only load when the player opens this game.
    const { mount2048 } = await import('./view');
    throwIfAborted(signal);
    return mount2048(root, services, signal);
  },
};
