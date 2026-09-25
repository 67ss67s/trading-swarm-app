// Vitest defaults for the gateway. The demo suite spawns real child processes (brain/exec CLIs,
// `which`, `pi --list-models`) and real HTTP servers, so vitest's 5 s default trips over machine load
// rather than over an actual regression — 20 s is still tight enough to catch a hang.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
