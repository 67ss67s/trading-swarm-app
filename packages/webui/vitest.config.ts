// Vitest for the web UI: same aliases and plugins as vite.config.ts, plus a setup file.
// The UI defaults to English, but most tests assert the Chinese source strings (they are the i18n keys),
// so every test file starts in Chinese. Tests that check English switch with setLang('en') themselves.
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(viteConfig, defineConfig({
  test: {
    setupFiles: ['./test/setup-lang.ts'],
  },
}));
