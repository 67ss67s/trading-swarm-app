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
        // 网关重启/没起来时 vite 默认回一个空 body 的 502,页面只会显示「Bad Gateway」。
        // 改回 503 + 结构化错误码,前端据此自动重试并在连上后整页刷新(configure 先于 vite 自己的 502 处理注册)。
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            if (!('req' in res) || res.headersSent || res.writableEnded) return;
            res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '3' }).end(
              JSON.stringify({ error: { code: 'gateway_unavailable', message: `网关暂时连不上(${(err as NodeJS.ErrnoException).code ?? err.message}),多半在重启,恢复后自动刷新` } }),
            );
          });
        },
      },
    },
  },
});
