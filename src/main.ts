import './styles/app.css';
import { App } from './app/app';

const root = document.querySelector<HTMLElement>('#app');
if (!root) {
  throw new Error('Missing #app root element');
}

const app = new App(root);
app.start();
