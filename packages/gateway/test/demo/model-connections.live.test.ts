// §9.52 真实联通验证(默认跳过):TG_LIVE_MODEL_TEST=1 时用 ~/.trading-swarm-okx/openrouter.env 的 key
// 各发一次 Decisions API(Jev)与一次 chat/completions(deepseek flash),打印延迟与花费。
// 每次跑约 $0.00006;本机要走代理:HTTPS_PROXY=http://127.0.0.1:7897。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { httpBrain } from '../../src/demo/brain-http.js';
import { JevDecisionClient } from '../../src/demo/decisions.js';
import { parseEnvKey } from '../../src/demo/model-connections.js';

const LIVE = process.env['TG_LIVE_MODEL_TEST'] === '1';

describe.skipIf(!LIVE)('live OpenRouter', () => {
  const key = LIVE ? parseEnvKey(readFileSync(path.join(os.homedir(), '.trading-swarm-okx', 'openrouter.env'), 'utf8')) : null;

  it('Jev decisions: one noul + one choice question', async () => {
    let raw = '';
    const recording: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      raw = await res.clone().text();
      return res;
    };
    const client = new JevDecisionClient({ api_key: key!, fetchFn: recording });
    try {
      const r = await client.decide({
        state: { symbol: 'BTCUSDT', timeframe: '15m', close: 64000, ema20: 63500, ema50: 63000, rsi14: 61, volume_ratio: 1.4, breakout: 'close above 20-bar high' },
        questions: {
          take: { type: 'noul', instructions: 'Is this a good long breakout entry for the next 4 bars?', criteria: { true: 'enter long', false: 'skip' } },
          regime: { type: 'choice', instructions: 'Which regime is the market in?', criteria: { trend: 'trending', range: 'ranging', volatile: 'volatile / news-driven' } },
        },
      }, { timeoutMs: 30_000 });
      console.log('[live] decisions', JSON.stringify({ latency_ms: r.latency_ms, usage: r.usage, answers: r.answers, model: r.model }));
      expect(Object.keys(r.answers)).toEqual(['take', 'regime']);
    } catch (e) {
      console.log('[live] decisions raw (redacted)', raw.replace(key!, '[redacted]').slice(0, 1500));
      throw e;
    }
  }, 60_000);

  it('deepseek flash chat/completions answers "ok"', async () => {
    const brain = httpBrain({ kind: 'openrouter', base_url: 'https://openrouter.ai/api/v1', api_key: key!, model: 'deepseek/deepseek-v4.1-flash' });
    const r = await brain.complete('你是连通性测试。只回复一个词:ok', 'ping', { timeoutMs: 60_000 });
    console.log('[live] chat', JSON.stringify({ name: brain.name, latency_ms: r.latency_ms, text: r.text.slice(0, 40), input_tokens: r.input_tokens, output_tokens: r.output_tokens, cost_usd: r.cost_usd }));
    expect(r.text.toLowerCase()).toContain('ok');
  }, 90_000);
});
