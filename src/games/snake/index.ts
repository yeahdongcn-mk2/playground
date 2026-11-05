import type { GameModule } from '../../core/game';

export const snakeGame: GameModule = {
  meta: {
    id: 'snake',
    title: '贪食蛇',
    englishTitle: 'Snake',
    description:
      '吃掉果实变长、加速，别撞上墙或自己的身体。经典玩法，键盘与触屏都能玩。',
    engine: 'phaser',
    genre: '街机',
    accent: '#a3e635',
    controls: ['方向键 / WASD 转向', '空格 / P / Esc 暂停', '触屏滑动或 D-pad 转向'],
  },
  async mount(root, services, signal) {
    // Phaser itself is only downloaded when this game starts, keeping the hub
    // shell small even as more engine-backed games are added.
    const { mountSnake } = await import('./snake-view');
    return mountSnake(root, services, signal);
  },
};
