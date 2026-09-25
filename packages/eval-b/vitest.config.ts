import { defineConfig } from 'vitest/config';

// 合成 case 的确定性对拍在全量并行负载下超过默认 5 秒；保持断言不变。
export default defineConfig({ test: { testTimeout: 20_000, hookTimeout: 20_000 } });
