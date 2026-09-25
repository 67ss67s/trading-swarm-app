import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  test: { environment: 'node', include: ['packages/webui/test/research-presentation.test.ts', 'packages/webui/test/my-strategies.test.ts', 'packages/webui/test/my-strategies-deploy.test.ts'] },
});
