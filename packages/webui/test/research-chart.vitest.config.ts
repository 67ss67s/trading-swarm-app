// 研究图表(research-chart.tsx)渲染测试配置:与 vitest.config.ts 同样的别名与 node 环境,只跑本文件(仓库根目录执行)
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  test: { environment: 'node', include: ['packages/webui/test/research-chart.test.ts'] },
});
