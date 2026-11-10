import { defineFrameworkMobileCases } from './framework-mobile-cases';

/**
 * The `mobile-webkit` entry point for the framework mobile case. The body is
 * the shared module, so Chromium and WebKit cannot drift apart.
 */
defineFrameworkMobileCases();
