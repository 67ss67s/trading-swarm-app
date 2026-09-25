import { defineConfig } from 'vitest/config';

// 默认 5 s 在并行跑满 14 个文件时会把「合成 case → run → report」那几个偏慢的用例误判成超时
// (它们本身 2–3 s)。这里只放宽超时,不改任何断言。
export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 120_000 } });
