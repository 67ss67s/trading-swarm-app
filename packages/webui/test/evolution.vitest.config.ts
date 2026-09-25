// 进化方格(components/evolution/grid-logic.ts + api/evolution.ts 归一)的测试配置,同 vitest.config.ts 的别名与 node 环境
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  test: { environment: 'node', include: ['packages/webui/test/evolution.test.ts'] },
});
