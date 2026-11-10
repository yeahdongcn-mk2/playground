import { defineBreakoutMobileCases } from './breakout-mobile-cases';

/**
 * The `mobile-webkit` entry point for the shared breakout phone cases. The body
 * is the shared module, so Chromium and WebKit cannot drift apart.
 */
defineBreakoutMobileCases();
