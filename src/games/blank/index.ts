import type { GameModule } from '../../core/game';

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Game mount aborted', 'AbortError');
  }
}

export const blankGame: GameModule = {
  meta: {
    id: 'blank',
    title: '空白画布',
    englishTitle: 'Blank Canvas',
    description:
      '框架的最小可运行示例：主循环、资源预加载、键盘与指针输入、容器级响应式渲染，都在这一块画布里跑通。',
    engine: 'phaser',
    genre: '框架演示',
    accent: '#22d3ee',
    controls: ['方向键 / WASD 移动', '鼠标或触屏点击、拖动', '重置位置并返回大厅'],
  },
  async mount(root, services, signal) {
    throwIfAborted(signal);
    // Phaser and the scene are only fetched when this game starts, so the hub
    // shell never pays the 2D engine's bundle cost.
    const { mountBlankGame } = await import('./view');
    throwIfAborted(signal);
    return mountBlankGame(root, services, signal);
  },
};
