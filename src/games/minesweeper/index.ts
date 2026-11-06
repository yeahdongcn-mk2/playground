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
      '9×9 棋盘藏着 10 颗雷。左键翻开、右键插旗，避开地雷并翻开所有安全格；踩雷立即结束，全部安全格翻开即获胜。',
    engine: 'dom',
    genre: '益智 · 经典',
    accent: '#f472b6',
    controls: ['左键翻开格子', '右键插旗 / 取消', '按钮重开或返回大厅'],
  },
  async mount(root, services, signal) {
    throwIfAborted(signal);
    // This game renders with native DOM, so only its view and CSS load on entry.
    const { mountMinesweeper } = await import('./view');
    throwIfAborted(signal);
    return mountMinesweeper(root, services, signal);
  },
};
