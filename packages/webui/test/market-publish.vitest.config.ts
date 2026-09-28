// 信号市场「发布」栏(components/market/publish.tsx + products/ + api/asp-products.ts)的测试配置,同 vitest.config.ts 的别名与 node 环境
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  test: { environment: 'node', include: ['packages/webui/test/market-publish.test.tsx'] },
});
