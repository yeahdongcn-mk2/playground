import type { GameModule } from '../../core/game';

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Game mount aborted', 'AbortError');
  }
}

export const minesweeperGame: GameModule = {
  meta: {
    id: 'minesweeper',
    title: '扫雷',
    englishTitle: 'Minesweeper',
    description:
      '初级 / 中级 / 高级三档预设，或自定义行、列与雷数；左键翻开、右键插旗，触屏轻点翻开、长按插旗；避开地雷并翻开所有安全格；踩雷立即结束，全部安全格翻开即获胜。',
    engine: 'dom',
    genre: '益智 · 经典',
    accent: '#f472b6',
    controls: [
      '选择预设难度或自定义棋盘',
      '左键翻开格子',
      '右键插旗 / 取消',
      '触屏轻点翻开 / 长按插旗',
      '按钮重开或返回大厅',
    ],
  },
  async mount(root, services, signal) {
    throwIfAborted(signal);
    // This game renders with native DOM, so only its view and CSS load on entry.
    const { mountMinesweeper } = await import('./view');
    throwIfAborted(signal);
    return mountMinesweeper(root, services, signal);
  },
};
