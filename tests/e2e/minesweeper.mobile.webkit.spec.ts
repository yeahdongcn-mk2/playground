import { defineMinesweeperMobileTouchCases } from './minesweeper-mobile-touch-cases';

/**
 * The `mobile-webkit` entry point for the shared minesweeper touch gestures.
 * The 8-viewport Chromium matrix and the short-screen query boundary stay in
 * `minesweeper.mobile.spec.ts`; the WebKit 4-viewport contract stays in
 * `minesweeper.narrow.webkit.spec.ts`.
 */
defineMinesweeperMobileTouchCases();
