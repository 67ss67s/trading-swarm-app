// 盯盘参数 / 筛选页纯逻辑(components/watch/watch-logic.ts + api/universe.ts 归一)的测试配置,同 vitest.config.ts 的别名与 node 环境
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  test: { environment: 'node', include: ['packages/webui/test/watch.test.ts'] },
});
