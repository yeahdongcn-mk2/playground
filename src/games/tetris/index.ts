import type { GameModule } from '../../core/game';

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Game mount aborted', 'AbortError');
  }
}

export const tetrisGame: GameModule = {
  meta: {
    id: 'tetris',
    title: '俄罗斯方块',
    englishTitle: 'Tetris',
    description:
      '七种方块从天而降，旋转、移动、消行得分。等级越高下落越快，堆到顶端就结束。键盘与触屏都能玩。',
    engine: 'phaser',
    genre: '街机 · 益智',
    accent: '#c084fc',
    controls: ['方向键 / WASD 移动旋转', '空格硬降 · P 暂停 · R 重开', '触屏方向与硬降按钮'],
  },
  async mount(root, services, signal) {
    throwIfAborted(signal);
    // Phaser and the scene only load when the player opens this game, so the
    // hub shell never pays the 2D engine's bundle cost.
    const { mountTetris } = await import('./tetris-view');
    throwIfAborted(signal);
    return mountTetris(root, services, signal);
  },
};
