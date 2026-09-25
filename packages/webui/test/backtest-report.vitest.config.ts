// WP-C 回测报告面板的测试配置(与 vitest.config.ts 同样的别名与 node 环境,只跑本包的用例)
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  test: { environment: 'node', include: ['packages/webui/test/backtest-report.test.ts'] },
});
