/**
 * Evidence-only harness for the online Minesweeper create form (#540 t2).
 *
 * The real `#/online/minesweeper` route is still on the open entry PR (#543),
 * not on main, so the built site cannot reach the room view yet. This page is
 * not part of the product build: it renders the real application shell
 * (`App`) and mounts the production composition root (`mountOnlineRoom`) in
 * the same `.view.view--game` wrapper the entry route uses. Before and after
 * screenshots load this identical page, so the only visual difference is the
 * product change under review.
 */
import '/src/styles/app.css';
import { App } from '/src/app/app';
import { mountOnlineRoom } from '/src/games/minesweeper/online/client/online-room';

const root = document.getElementById('app');
if (root === null) {
  throw new Error('Missing #app root element');
}

// Constructing App builds the production header, view container and footer.
// Do not call start(): its home route would overwrite the evidence mount.
new App(root);

const view = root.querySelector<HTMLElement>('#view');
if (view === null) {
  throw new Error('Missing #view container');
}

view.className = 'view view--game';
view.replaceChildren();
document.title = '联机扫雷 · Playground Arcade';

const mountPoint = document.createElement('div');
mountPoint.className = 'game-mount';
view.append(mountPoint);
mountOnlineRoom(mountPoint, { roomId: null });
document.body.dataset.evidenceReady = 'true';
