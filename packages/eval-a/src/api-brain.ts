// Eval-only direct-API brain (docs/eval/denoise-plan-2026-09-04.md §2.4): OpenAI-compatible chat.completions
// against zai's endpoint with an explicit temperature, so we can measure how much of the action noise is
// sampling temperature vs. the model itself. Lives in eval-a on purpose — the gateway never holds model keys;
// here the key is borrowed from pi's own credential store (`pi auth print-api-key --provider zai`) or ZAI_API_KEY.

import { spawnSync } from 'node:child_process';
import type { demo } from '@trade-gate/gateway';

export interface ApiBrainOptions {
  baseUrl?: string;
  model?: string;
  temperature?: number;
  apiKey?: string;
  /** zai GLM: disable thinking to mirror `pi --thinking off`. */
  thinking?: boolean;
}

export function zaiApiKey(): string {
  const env = process.env['ZAI_API_KEY'];
  if (env) return env;
  const r = spawnSync('pi', ['auth', 'print-api-key', '--provider', 'zai'], { encoding: 'utf8', timeout: 10_000 });
  const key = (r.stdout ?? '').trim();
  if (r.status !== 0 || !key) throw new Error(`无法取得 zai API key(设 ZAI_API_KEY 或确保 pi auth 可用):${(r.stderr ?? '').slice(-200)}`);
  return key;
}

const approxTokens = (s: string): number => Math.ceil(s.length / 3);

export function zaiApiBrain(opts: ApiBrainOptions = {}): demo.Brain {
  const baseUrl = (opts.baseUrl ?? process.env['ZAI_BASE_URL'] ?? 'https://api.z.ai/api/coding/paas/v4').replace(/\/$/, '');
  const model = opts.model ?? 'glm-5.3';
  const temperature = opts.temperature ?? 0;
  const thinking = opts.thinking ?? false;
  let key: string | null = opts.apiKey ?? null;
  const name = `zai-api:${model}@t${temperature}`;
  return {
    name,
    async complete(system, user, o) {
      key = key ?? zaiApiKey();
      const started = Date.now();
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), o?.timeoutMs ?? 120_000);
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            temperature,
            stream: false,
            thinking: { type: thinking ? 'enabled' : 'disabled' },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
          signal: ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`zai api HTTP ${res.status}: ${text.slice(0, 300)}`);
        const parsed = JSON.parse(text) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        const content = parsed.choices?.[0]?.message?.content ?? '';
        if (!content) throw new Error(`zai api empty content: ${text.slice(0, 300)}`);
        return {
          text: content.trim(),
          latency_ms: Date.now() - started,
          model: name,
          input_tokens: parsed.usage?.prompt_tokens ?? approxTokens(system + user),
          output_tokens: parsed.usage?.completion_tokens ?? approxTokens(content),
        };
      } finally {
        clearTimeout(t);
      }
    },
  };
}
