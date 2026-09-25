import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    // TG_UI_PORT / TG_API_PORT 让第二个 dev 实例并行跑(默认 5180 → 18800)。
    // 网关只认 5180 这个 Origin,代理时把 Origin 固定改写,免得换端口后 POST 被 403。
    port: Number(process.env['TG_UI_PORT'] ?? '5180'),
    strictPort: true,
    // 2026-09-21:这台 mac 上 fsevents 监听会静默失效(改了源码页面不更新),TG_WATCH_POLL=1 改用轮询。
    ...(process.env['TG_WATCH_POLL'] ? { watch: { usePolling: true, interval: 500 } } : {}),
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env['TG_API_PORT'] ?? '18800'}`,
        changeOrigin: true,
        ws: false,
        headers: { origin: 'http://127.0.0.1:5180' },
      },
    },
  },
});
