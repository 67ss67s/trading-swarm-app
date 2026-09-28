// 英文评审版(TG_PUBLIC_LANG=en)的判断语言两层兜底:喂给模型的清单标签用英文键;模型输出仍含中文 → 同一个 brain 重写一次
// (最多一次、计入今日判断次数与花费、额度满就不重写)。本机(不设 TG_PUBLIC_LANG)行为不变。另测访客拿不到内部提示词。
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
import { flagLabel, flagWords, judgmentCjkFields, rewriteJudgmentInEnglish } from '../../src/demo/output-language.js';
import { scanChecklist } from '../../src/demo/review-metrics.js';
import { publicView } from '../../src/demo/public-view.js';
import type { TfFeatures } from '../../src/demo/market.js';
import type { Judgment } from '../../src/demo/types.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';

const NOW = Date.UTC(2026, 7, 2, 23, 0);
const feat = (tf: string): TfFeatures => ({
  tf, last_close: 63500, last_open_time: NOW - 900_000, ema20: 63400, ema50: 63200, atr14: 100, swing_high_20: 63600, swing_low_20: 63000,
  swing_high_50: 63800, swing_low_50: 62800, dist_to_high20_pct: 0.16, dist_to_low20_pct: 0.79, vol_ratio_20: 0.8, change_pct_last: 0.1, change_pct_5: 0.4, last_bars: '…',
} as TfFeatures);

afterEach(() => vi.unstubAllEnvs());

describe('喂给模型的清单标签', () => {
  it('英文模式:回踩确认 → retest_confirmed=,系统提示里的引用同步;本机原样', () => {
    vi.stubEnv('TG_PUBLIC_LANG', 'en');
    expect(flagLabel('回踩确认')).toBe('retest_confirmed=');
    expect(flagLabel('挤压', ' ')).toBe('squeeze=');
    const en = scanChecklist([feat('15m'), feat('1h'), feat('4h')])!.text;
    expect(en).toContain('retest_confirmed=no');
    expect(en).not.toContain('回踩确认');
    expect(flagWords('「回踩确认=是」时考虑 PROPOSE;共识=否 时不能开;失效确认=是')).toBe('「retest_confirmed=yes」时考虑 PROPOSE;consensus=no 时不能开;invalidation_confirmed=yes');
    expect(flagWords('议会共识是前置')).toBe('议会共识是前置'); // 通用词不跟 = 不换
    vi.stubEnv('TG_PUBLIC_LANG', '');
    expect(flagLabel('回踩确认')).toBe('回踩确认=');
    expect(scanChecklist([feat('15m'), feat('1h'), feat('4h')])!.text).toContain('回踩确认 否');
    expect(flagWords('回踩确认=是')).toBe('回踩确认=是');
  });
});

const zhJudgment = { action: 'NO_TRADE', direction: null, headline: 'BNB 周期信号互相矛盾', thesis: 'no edge', reasons: ['回踩确认 no [E9]'], watch_conditions: [] };
const enJudgment = { action: 'NO_TRADE', direction: null, headline: 'BNB timeframes conflict', thesis: 'no edge', reasons: ['retest_confirmed=no [E9]'], watch_conditions: [] };
const call = (text: string) => ({ text, input_tokens: 10, output_tokens: 5, latency_ms: 1 });

describe('判断含中文 → 英文重写一次', () => {
  it('本机模式不检测、不重写', async () => {
    const complete = vi.fn();
    expect(judgmentCjkFields(zhJudgment)).toEqual([]);
    const r = await rewriteJudgmentInEnglish({ judgment: zhJudgment, previous: '{}', allowed: true, complete, parse: () => null });
    expect(complete).not.toHaveBeenCalled();
    expect(r.judgment).toBe(zhJudgment);
  });

  it('英文模式:含中文时只调一次;重写成英文、动作方向不变就采用', async () => {
    vi.stubEnv('TG_PUBLIC_LANG', 'en');
    expect(judgmentCjkFields(zhJudgment)).toEqual(['headline', 'reasons']);
    const complete = vi.fn(async (suffix: string) => { expect(suffix).toContain('Your previous output contained Chinese text in: headline, reasons'); return call(JSON.stringify(enJudgment)); });
    const r = await rewriteJudgmentInEnglish({ judgment: zhJudgment, previous: JSON.stringify(zhJudgment), allowed: true, complete, parse: (t) => JSON.parse(t) });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ accepted: true, still_cjk: [], judgment: enJudgment });
  });

  it('重写后仍含中文 / 动作变了:不再重试,保留原判断并报出仍含中文的字段', async () => {
    vi.stubEnv('TG_PUBLIC_LANG', 'en');
    const still = vi.fn(async () => call(JSON.stringify(zhJudgment)));
    const r1 = await rewriteJudgmentInEnglish({ judgment: zhJudgment, previous: '', allowed: true, complete: still, parse: (t) => JSON.parse(t) });
    expect(still).toHaveBeenCalledTimes(1);
    expect(r1).toMatchObject({ accepted: false, still_cjk: ['headline', 'reasons'], judgment: zhJudgment });
    const flipped = vi.fn(async () => call(JSON.stringify({ ...enJudgment, action: 'WATCH', direction: 'long' })));
    const r2 = await rewriteJudgmentInEnglish({ judgment: zhJudgment, previous: '', allowed: true, complete: flipped, parse: (t) => JSON.parse(t) });
    expect(flipped).toHaveBeenCalledTimes(1);
    expect(r2.accepted).toBe(false);
    expect(r2.judgment).toBe(zhJudgment);
  });

  it('额度用完(allowed=false)时不调模型', async () => {
    vi.stubEnv('TG_PUBLIC_LANG', 'en');
    const complete = vi.fn();
    const r = await rewriteJudgmentInEnglish({ judgment: zhJudgment, previous: '', allowed: false, complete, parse: () => null });
    expect(complete).not.toHaveBeenCalled();
    expect(r.still_cjk).toEqual(['headline', 'reasons']);
  });
});

describe('访客拿不到内部提示词', () => {
  it('公网投影里 context_text / judgment_raw 置 null,只给长度', () => {
    const ep = { id: 'ep-1', context_text: '[system]\n你是判断模块', judgment_raw: '{"action":"NO_TRADE"}', judgment: { headline: 'ok' } };
    const out = publicView(ep) as Record<string, unknown>;
    expect(out['context_text']).toBeNull();
    expect(out['context_text_hidden']).toEqual({ hidden: true, length: ep.context_text.length });
    expect(out['judgment_raw']).toBeNull();
    expect(out['judgment_raw_hidden']).toEqual({ hidden: true, length: ep.judgment_raw.length });
    expect(out['judgment']).toEqual({ headline: 'ok' });
  });
});

// ---------------------------------------------------------------- runtime 接线(假行情 + 桩大脑)

let server: FakeMarketServer, DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;
let rt: InstanceType<typeof DemoRuntime> | null = null, state: StateDb | null = null;
beforeAll(async () => { server = await startFakeMarketServer(77000, 200); process.env.TG_DEMO_MARKET_BASE = server.url; ({ DemoRuntime } = await import('../../src/demo/runtime.js')); });
afterAll(async () => { await server.close(); delete process.env.TG_DEMO_MARKET_BASE; });
afterEach(async () => { if (rt) await rt.stop(); state?.close(); rt = null; state = null; });

const answer = (headline: string, reason: string): string => JSON.stringify({ action: 'NO_TRADE', direction: null, confidence: 0.3, headline, thesis: 'stub thesis', reasons: [reason], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null });
async function drain() { const start = performance.now(); while (rt!.queueView().pending || rt!.queueView().running) { if (performance.now() - start > 10000) throw Error('runtime did not drain'); await new Promise((r) => setTimeout(r, 10)); } }

async function runScan(reply: (user: string, n: number) => string, cap = 0) {
  state = openStateDb(':memory:');
  const store = new DemoStore(state);
  const calls: string[] = [];
  rt = new DemoRuntime({ store, backend: new PaperBackend(10000), brains: { stub: stubBrain((system, user) => { if (system.includes('Portfolio 仓位顾问')) return '{}'; calls.push(user); return reply(user, calls.length); }) }, marketPollMs: 600000, accountPollMs: 600000 });
  await rt.start();
  rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], auto_approve: true, daily_judgment_cap: cap });
  expect(rt.scan('BTCUSDT', { kind: 'manual', detail: 'test' })).toBe(true);
  await drain();
  const ep = store.episode(store.episodes(5).find((e) => e.symbol === 'BTCUSDT')!.id)!;
  return { ep, calls, rt: rt! };
}

describe('runtime:英文评审版判断含中文时重写一次', () => {
  it('第一遍中文、重写后英文:采用英文,调用两次,重写计入今日判断次数', async () => {
    vi.stubEnv('TG_PUBLIC_LANG', 'en');
    const { ep, calls, rt: r } = await runScan((user) => (user.includes('Your previous output contained Chinese') ? answer('No setup', 'retest_confirmed=no [E1]') : answer('没有优势', '回踩确认 no [E1]')));
    expect(calls).toHaveLength(2);
    expect(ep.judgment!.headline).toBe('No setup');
    expect(ep.judgment!.reasons).toEqual(['retest_confirmed=no [E1]']);
    expect(r.modelJudgmentsToday()).toBe(2);
  });

  it('重写后仍是中文:只重试一次,保留原判断', async () => {
    vi.stubEnv('TG_PUBLIC_LANG', 'en');
    const { ep, calls } = await runScan(() => answer('没有优势', '回踩确认 no [E1]'));
    expect(calls).toHaveLength(2);
    expect(ep.judgment!.headline).toBe('没有优势');
  });

  it('本机模式(不设 TG_PUBLIC_LANG):中文输出照常采用,不重写', async () => {
    const { ep, calls, rt: r } = await runScan(() => answer('没有优势', '回踩确认 否 [E1]'));
    expect(calls).toHaveLength(1);
    expect(ep.judgment!.headline).toBe('没有优势');
    expect(r.modelJudgmentsToday()).toBe(1);
  });
});
