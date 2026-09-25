// Response cache (docs/eval/README.md §3): key = sha256(context_hash + model + prompt_version [+ repair
// suffix]). A hit returns the stored text and the *original* latency/tokens, so a cached run reproduces
// the first run's episodes byte for byte.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, sha256, writeJson } from './util.js';

export interface CachedResponse {
  text: string;
  model: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cached_at: number;
  context_hash: string;
  prompt_version: string;
  extra: string;
}

export function cacheKey(contextHash: string, model: string, promptVersion: string, extra = ''): string {
  return sha256(`${contextHash}${model}${promptVersion}${extra}`);
}

export class ResponseCache {
  hits = 0;
  misses = 0;
  constructor(readonly dir: string) {}

  path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  get(key: string): CachedResponse | null {
    const p = this.path(key);
    if (!existsSync(p)) {
      this.misses++;
      return null;
    }
    this.hits++;
    return readJson<CachedResponse>(p);
  }

  put(key: string, value: CachedResponse): void {
    writeJson(this.path(key), value);
  }
}
