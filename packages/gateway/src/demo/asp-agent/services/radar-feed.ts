/**
 * 订阅频道「雷达榜单」(市场情报 · radar_feed):雷达三档(短线 short / 波段 swing / 周线 weekly)每跑完一轮就推一次。
 * 内容 = 入选币(名次、适配分、理由)+ 证据时效(跑完多久、过没过期)+ 推荐层流动性门(对应周期档是否合格、原因、方向、策略族)。
 *
 * 全部代码计算、零模型;只给分析与依据,不给买卖指令。取数全走注入的 RadarDeps(测试零网络),
 * 何时调用、扇出、deliver、落账归 broadcaster。
 */
import {
  HORIZON_LABEL, HORIZON_RADAR_TIER, RADAR_TIER_EVERY_MS,
  type Horizon, type HorizonFit, type RadarTier,
} from '../../recommend.js';
import { BANNED_WORDS } from '../publisher.js';
import { clean, DISCLAIMER, MAX_TEXT, num } from './render.js';
import type { ChannelDeps, ChannelPush, SubscriptionChannel } from './types.js';

export const RADAR_TIERS: readonly RadarTier[] = ['short', 'swing', 'weekly'];
/** 雷达档 → 推荐层周期档(short←short、mid←swing、long←weekly) */
export const RADAR_TIER_HORIZON: Record<RadarTier, Horizon> = Object.fromEntries(
  (Object.entries(HORIZON_RADAR_TIER) as [Horizon, RadarTier][]).map(([h, t]) => [t, h]),
) as Record<RadarTier, Horizon>;
const TIER_ZH: Record<RadarTier, string> = { short: '短线档', swing: '波段档', weekly: '周线档' };
/** 每次推送列出的入选币上限(recommendAssets 单次最多 12 个币) */
export const RADAR_FEED_TOP = 10;
const WELCOME_TOP = 5;
const STATE_KEY = (t: RadarTier): string => `radar_feed:last:${t}`;

const REASON_TEXT: Record<string, string> = {
  liquidity: '流动性不足', history: '上市时间不足', regime: '日线状态不适合', no_market: '无对应市场',
  excluded: '全集排除', unknown_asset: 'OKX 全集无此币', not_requested: '未评估', unavailable: '流动性门暂不可用',
};
const DIR_TEXT: Record<string, string> = { long: '偏多 long', short: '偏空 short', both: '双向 both' };

/** ScreenStore.latest 的子集 */
export interface RadarScreenLike { id: string; status: string; started_at: number; finished_at: number | null }
/** ScreenStore.candidates 的子集(同一币可能对应多条策略,按 rank 升序) */
export interface RadarCandidateLike { symbol: string; rank: number; fit_score: number; reasons: string[]; strategy_id?: string }
/** 推荐层对单币单周期的流动性门结果(recommendAssets 的 row 摊平) */
export interface RadarFitRow { symbol: string; fit: HorizonFit; quote_vol_24h: number | null; depth_usd_05: number | null }

export interface RadarDeps {
  /** 该档最近一轮跑完的筛选;没有返回 null(runtime: store.screens.latest(tier)) */
  latest(tier: RadarTier): RadarScreenLike | null;
  /** 该轮候选,按 rank 升序(runtime: store.screens.candidates(screen_id, n)) */
  candidates(screen_id: string, n: number): RadarCandidateLike[];
  /** 推荐层流动性门:对这些币只评估 horizon 一档(runtime: recommendAssets(..., { symbols, horizons: [horizon] }).rows 摊平) */
  fit(symbols: string[], horizon: Horizon): Promise<RadarFitRow[]>;
  /** 该档刷新周期(过期 = 超过两倍周期);缺省用 RADAR_TIER_EVERY_MS(runtime: radar.everyMs(tier)) */
  every_ms?(tier: RadarTier): number;
}

type Deps = ChannelDeps & RadarDeps;

export interface Pick {
  rank: number; symbol: string; fit_score: number; strategy_id: string | null; reasons: string[];
  gate: { eligible: boolean; reason: string | null; reason_text: string | null; direction: string | null; families: string[]; evidence: string[]; quote_vol_24h: number | null; depth_usd_05: number | null };
}
export interface TierReport {
  tier: RadarTier; horizon: Horizon; screen_id: string; finished_at: number; age_ms: number; stale: boolean; refresh_every_ms: number;
  picks: Pick[]; gate_error: string | null;
}

const SCRUB = new RegExp(BANNED_WORDS.source, 'gi');
/** 候选理由可能来自筛选大脑的自由文本:先把红线词屏蔽掉,再做整段兜底检查 */
const scrub = (s: string, max = 60): string => {
  const t = String(s).replace(SCRUB, '[已屏蔽]').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const utc = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const ago = (ms: number): string => {
  const m = Math.max(0, ms);
  return m < 3_600_000 ? `${Math.max(1, Math.round(m / 60_000))} 分钟前` : m < 86_400_000 ? `${Math.round(m / 3_600_000)} 小时前` : `${Math.floor(m / 86_400_000)} 天${Math.round((m % 86_400_000) / 3_600_000) ? ` ${Math.round((m % 86_400_000) / 3_600_000)} 小时` : ''}前`;
};
const span = (ms: number): string => (ms % 86_400_000 === 0 ? `${ms / 86_400_000} 天` : `${Math.round(ms / 3_600_000)} 小时`);
const finishedAt = (s: RadarScreenLike): number => s.finished_at ?? s.started_at;

function latestDone(deps: Deps, tier: RadarTier): RadarScreenLike | null {
  const s = deps.latest(tier);
  return s && s.status === 'done' ? s : null;
}

/** 同一币多条策略只留名次最前的那条 */
function distinctPicks(rows: RadarCandidateLike[], n: number): RadarCandidateLike[] {
  const out: RadarCandidateLike[] = [];
  const seen = new Set<string>();
  for (const c of [...rows].sort((a, b) => a.rank - b.rank)) {
    if (out.length >= n) break;
    if (seen.has(c.symbol)) continue;
    seen.add(c.symbol);
    out.push(c);
  }
  return out;
}

async function buildReport(deps: Deps, tier: RadarTier, screen: RadarScreenLike, top: number): Promise<TierReport> {
  const now = deps.now(), horizon = RADAR_TIER_HORIZON[tier];
  const every = deps.every_ms?.(tier) ?? RADAR_TIER_EVERY_MS[tier];
  const at = finishedAt(screen);
  const cands = distinctPicks(deps.candidates(screen.id, top * 6), top);
  let fits = new Map<string, RadarFitRow>(), gateError: string | null = null;
  if (cands.length) {
    try { fits = new Map((await deps.fit(cands.map((c) => c.symbol), horizon)).map((r) => [r.symbol, r])); }
    catch (err) { gateError = scrub((err as Error).message, 120); deps.log('warn', `radar_feed: 流动性门取数失败 ${tier}/${screen.id}: ${gateError}`); }
  }
  const picks: Pick[] = cands.map((c) => {
    const r = fits.get(c.symbol);
    const f: HorizonFit = r?.fit ?? { eligible: false, reason: 'unavailable', direction: null, families: [], evidence: [gateError ? '流动性门取数失败' : '推荐层没有返回这个币'] };
    return {
      rank: c.rank, symbol: c.symbol, fit_score: c.fit_score, strategy_id: c.strategy_id ? scrub(c.strategy_id, 80) : null, reasons: c.reasons.slice(0, 2).map((x) => scrub(x)),
      gate: {
        eligible: f.eligible, reason: f.reason, reason_text: f.reason ? REASON_TEXT[f.reason] ?? f.reason : null,
        direction: f.direction, families: [...f.families], evidence: f.evidence.slice(0, 4).map((x) => scrub(x, 80)),
        quote_vol_24h: r?.quote_vol_24h ?? null, depth_usd_05: r?.depth_usd_05 ?? null,
      },
    };
  });
  return { tier, horizon, screen_id: screen.id, finished_at: at, age_ms: now - at, stale: now - at > 2 * every, refresh_every_ms: every, picks, gate_error: gateError };
}

function freshness(r: TierReport): string {
  return `跑完于 ${ago(r.age_ms)}(${r.stale ? '已过期' : '未过期'},刷新周期 ${span(r.refresh_every_ms)},超过两倍周期算过期)`;
}

function pickLine(p: Pick, horizon: Horizon): string {
  const g = p.gate, hz = HORIZON_LABEL[horizon];
  const gate = g.eligible
    ? `${hz}门 通过 · 方向 ${DIR_TEXT[g.direction ?? ''] ?? '—'} · 策略族 ${g.families.join('/') || '—'}`
    : `${hz}门 不合格:${g.reason_text ?? '—'}${g.evidence.length ? `(${g.evidence.slice(-1)[0]})` : ''}`;
  const why = p.reasons.length ? ` · 理由:${p.reasons.join(';')}` : '';
  return `#${p.rank} ${p.symbol} 适配 ${num(p.fit_score)} · ${gate}${why}`;
}

function assertClean(text: string): void {
  if (BANNED_WORDS.test(text)) throw new Error('radar_feed_banned_words');
}

/** 标题 + 行 + 免责声明 + JSON;超长时去掉 JSON 行(payload 仍完整) */
function compose(head: string[], payload: Record<string, unknown>): string {
  const body = [...head, DISCLAIMER].join('\n');
  const full = `${body}\n${JSON.stringify(payload)}`;
  assertClean(full);
  return full.length <= MAX_TEXT ? full : body;
}

function tierPayload(r: TierReport): Record<string, unknown> {
  return {
    tier: r.tier, horizon: r.horizon, screen_id: r.screen_id, finished_at: r.finished_at, age_ms: r.age_ms, stale: r.stale,
    refresh_every_ms: r.refresh_every_ms, gate_error: r.gate_error, picks: r.picks,
  };
}

export function renderTierPush(r: TierReport): ChannelPush {
  const hz = HORIZON_LABEL[r.horizon];
  const passed = r.picks.filter((p) => p.gate.eligible).length;
  const summary = r.picks.length
    ? `${TIER_ZH[r.tier]} ${r.tier} 本轮 ${r.picks.length} 个入选,${hz}流动性门通过 ${passed}/${r.picks.length} · ${r.stale ? '已过期' : '未过期'}`
    : `${TIER_ZH[r.tier]} ${r.tier} 本轮无入选币`;
  const head = [
    `【雷达榜单 / Radar Picks】${TIER_ZH[r.tier]} ${r.tier} · ${utc(r.finished_at)}`,
    summary,
    `证据时效:${freshness(r)}`,
    ...(r.gate_error ? [`注意:推荐层流动性门取数失败,以下${hz}门结果不可用`] : []),
    ...(r.picks.length ? r.picks.map((p) => pickLine(p, r.horizon)) : ['本轮没有币通过雷达筛选。']),
    `方法:雷达筛选名次/适配分 + 推荐层${hz}流动性门(成交额/深度/上市时间)与日线状态 → 方向与策略族;代码计算、零模型 / rule-based, no LLM`,
  ];
  const payload = clean({ channel: 'radar_feed', source: 'trading-swarm', version: 1, kind: 'tier_update', ...tierPayload(r) });
  return { event_id: `radar:${r.tier}:${r.screen_id}`, channel: 'radar_feed', summary, text: compose(head, payload), payload };
}

export const radarFeedChannel: SubscriptionChannel<RadarDeps> = {
  key: 'radar_feed',
  every_ms: 5 * 60_000,

  async tick(deps) {
    // 首次启用:各档当前这一轮已经在欢迎包里给过了,只记游标不推,免得开服头 15 分钟连推三档旧榜
    if (!deps.state.get('radar_feed:primed')) {
      for (const tier of RADAR_TIERS) { const s = latestDone(deps, tier); if (s) deps.state.set(STATE_KEY(tier), s.id); }
      deps.state.set('radar_feed:primed', String(deps.now()));
      return null;
    }
    const fresh = RADAR_TIERS
      .map((tier, i) => ({ tier, i, screen: latestDone(deps, tier) }))
      .filter((x): x is { tier: RadarTier; i: number; screen: RadarScreenLike } => !!x.screen && deps.state.get(STATE_KEY(x.tier)) !== x.screen.id)
      .sort((a, b) => finishedAt(a.screen) - finishedAt(b.screen) || a.i - b.i);
    const next = fresh[0];
    if (!next) return null;
    let push: ChannelPush;
    try { push = renderTierPush(await buildReport(deps, next.tier, next.screen, RADAR_FEED_TOP)); }
    catch (err) { deps.log('error', `radar_feed: ${next.tier}/${next.screen.id} 渲染失败: ${(err as Error).message}`); return null; }
    deps.state.set(STATE_KEY(next.tier), next.screen.id);
    return push;
  },

  async welcome(deps) {
    const now = deps.now();
    const reports: (TierReport | null)[] = [];
    for (const tier of RADAR_TIERS) {
      const s = latestDone(deps, tier);
      reports.push(s ? await buildReport(deps, tier, s, WELCOME_TOP) : null);
    }
    const lines = RADAR_TIERS.map((tier, i) => {
      const r = reports[i];
      if (!r) return `${TIER_ZH[tier]} ${tier}:尚未运行`;
      const top = r.picks.length
        ? r.picks.map((p) => `${p.symbol}(#${p.rank} 适配 ${num(p.fit_score)},${HORIZON_LABEL[r.horizon]}门${p.gate.eligible ? `通过 ${DIR_TEXT[p.gate.direction ?? ''] ?? ''}`.trim() : `不合格:${p.gate.reason_text ?? '—'}`})`).join('、')
        : '本轮无入选币';
      return `${TIER_ZH[tier]} ${tier}:${freshness(r)} · 前 ${r.picks.length}:${top}`;
    });
    const ran = reports.filter((r): r is TierReport => !!r);
    const summary = ran.length
      ? `雷达三档最新一轮合并摘要:已运行 ${ran.length}/3 档${ran.some((r) => r.stale) ? ',含过期档' : ''}`
      : '雷达三档尚未运行,有新一轮跑完会立即推送';
    const head = [
      `【雷达榜单 / Radar Picks】三档摘要 short/swing/weekly · ${utc(now)}`,
      summary,
      ...lines,
      '之后每档每跑完一轮单独推送一次(入选币、理由、证据时效、流动性门)。',
    ];
    const payload = clean({ channel: 'radar_feed', source: 'trading-swarm', version: 1, kind: 'welcome', as_of: now,
      tiers: Object.fromEntries(RADAR_TIERS.map((t, i) => [t, reports[i] ? tierPayload(reports[i]!) : null])) });
    const ids = RADAR_TIERS.map((t, i) => `${t}=${reports[i]?.screen_id ?? 'none'}`).join(',');
    return { event_id: `radar:welcome:${ids}`, channel: 'radar_feed', summary, text: compose(head, payload), payload };
  },
};
