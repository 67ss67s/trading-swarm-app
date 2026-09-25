/**
 * 订阅频道 market_brief:行情简报,每 30 分钟一份,所有订阅者共用一份。
 *
 * 内容全部来自代码计算(日线 regime、每日全市场扫描、OKX 全集快照的资金费率、BTC/ETH 录制器盘口与清算),
 * 可选 summarize 钩子让便宜模型写两三句人话;缺省或返回 null 用确定性模板。只给分析和依据,不给买卖指令。
 * 某块数据取不到就写「暂缺」,不让整份失败。
 */
import type { DailyRegime } from '../../types.js';
import type { UniverseAsset, UniverseScanSummary } from '../../universe-okx.js';
import { BANNED_WORDS } from '../publisher.js';
import { bookStats, sumLiquidations, usd, type MicroSource, type Wall } from './micro-source.js';
import { DISCLAIMER, MAX_TEXT, clean, num, sha256Of } from './render.js';
import type { ChannelDeps, ChannelKey, ChannelPush, SubscriptionChannel } from './types.js';

// ---------------------------------------------------------------- 频道共用渲染

/** `2026-09-25 14:30 UTC` */
export function utcLabel(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
/** BTCUSDT → BTC */
export const baseOf = (symbol: string): string => symbol.replace(/-?USDT(-SWAP)?$/i, '');
export const price = (x: number | null | undefined): string => x === null || x === undefined || !Number.isFinite(x) ? '—' : x >= 1000 ? x.toFixed(1) : x >= 1 ? x.toFixed(2) : x.toPrecision(4);
/** 失衡 ±x.xx,绝对值太小的不写成 -0.00 */
export const imbalanceText = (x: number | null | undefined): string => { if (x === null || x === undefined || !Number.isFinite(x)) return '—'; const v = Math.abs(x) < 0.005 ? 0 : x; return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`; };
export const signedPct = (x: number | null | undefined, digits = 1): string => x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(digits)}%`;

/**
 * 频道推送渲染:标题 + 摘要 + 要点 + 免责声明 + sha256,放得下就附规范化 JSON。
 * 整段文字(含 JSON)过 BANNED_WORDS,命中直接抛错,不推。
 */
export function channelPush(channel: ChannelKey, event_id: string, title: string, summary: string, lines: string[], body: Record<string, unknown>): ChannelPush {
  const payload = clean({ channel, event_id, source: 'trading-swarm', version: 1, ...body });
  const sha256 = sha256Of(payload);
  const head = [title, summary, ...lines, DISCLAIMER, `sha256: ${sha256}`].join('\n');
  const full = `${head}\n${JSON.stringify({ ...payload, sha256 })}`;
  const text = full.length <= MAX_TEXT ? full : head;
  if (BANNED_WORDS.test(text) || BANNED_WORDS.test(summary)) throw new Error(`${channel}_banned_words`);
  return { event_id, channel, summary, text, payload: { ...payload, sha256 } };
}

/** 给一段取数加超时 + 兜底:失败返回 null 并记日志,不抛 */
export async function safely<T>(deps: Pick<ChannelDeps, 'log'>, name: string, fn: () => T | Promise<T>, timeout_ms = 20_000): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout ${timeout_ms}ms`)), timeout_ms); }),
    ]);
  } catch (e) {
    deps.log('warn', `${name} 取数失败:${(e as Error).message}`);
    return null;
  } finally { if (timer) clearTimeout(timer); }
}

// ---------------------------------------------------------------- 简报

export interface BriefConfig {
  symbols: string[];
  scan_top: number;
  funding_top: number;
  /** 资金费率极值只看永续 24h 成交额够的,免得被没人交易的小币刷屏 */
  funding_min_perp_vol_usd: number;
  liq_window_ms: number;
  book_band_pct: number;
  /** welcome 复用最近一份简报的时限 */
  welcome_reuse_ms: number;
  /** 单块取数超时 */
  block_timeout_ms: number;
}
export const BRIEF_DEFAULTS: BriefConfig = {
  symbols: ['BTCUSDT', 'ETHUSDT'],
  scan_top: 5,
  funding_top: 3,
  funding_min_perp_vol_usd: 5_000_000,
  liq_window_ms: 30 * 60_000,
  book_band_pct: 0.005,
  welcome_reuse_ms: 45 * 60_000,
  block_timeout_ms: 20_000,
};
export const BRIEF_EVERY_MS = 30 * 60_000;

export interface BriefFacts {
  slot: number;
  generated_at: number;
  majors: {
    symbol: string;
    last: number | null;
    change_24h_pct: number | null;
    regime: { kind: DailyRegime['regime']; ret_20d_pct: number; ret_5d_pct: number; atr_pct: number; vol_pct_rank: number; ema_stack: string; as_of: number } | null;
  }[];
  scan: { at: number | null; screen_id: string | null; scanned: number; top: { rank: number; symbol: string; score: number; reasons: string[] }[] } | null;
  funding: { updated_at: number | null; highest: FundingRow[]; lowest: FundingRow[] } | null;
  books: Record<string, { at: number; mid: number; spread_bps: number; bid_depth_usd: number; ask_depth_usd: number; imbalance: number | null; visible_pct: number; wall_bid: Wall | null; wall_ask: Wall | null } | null>;
  liquidations: Record<string, { window_ms: number; long_usd: number; short_usd: number; total_usd: number; count: number } | null>;
  /** 取不到的块 */
  missing: string[];
}
export interface FundingRow { symbol: string; rate: number; perp_quote_volume_24h: number | null }

export interface BriefDeps {
  /** runtime: dailyRegimeFor(symbol) */
  regime(symbol: string): Promise<DailyRegime | null>;
  /** runtime: latestUniverseScan(store.marketDb, { limit }) */
  scan(limit: number): UniverseScanSummary | Promise<UniverseScanSummary>;
  /** runtime: currentUniverse() */
  universe(): { updated_at: number | null; items: UniverseAsset[] } | null | Promise<{ updated_at: number | null; items: UniverseAsset[] } | null>;
  /** BTC/ETH 盘口 + 清算;没有录制器传 null */
  micro: MicroSource | null;
  /** 便宜模型写两三句人话;缺省/返回 null/抛错 → 确定性模板 */
  summarize?(facts: BriefFacts): Promise<string | null>;
  brief_config?: Partial<BriefConfig>;
}

const REGIME_LABEL: Record<DailyRegime['regime'], string> = { bull: '多头 bull', bear: '空头 bear', range: '震荡 range', volatile: '高波动 volatile' };
/** 模型人话里不许出现操作指令(模板本身不写) */
export const INSTRUCTION_WORDS = /买入|卖出|做多|做空|开多|开空|开仓|平仓|加仓|减仓|抄底|追多|追空|止损|止盈|入场|离场|\bbuy\b|\bsell\b|\bgo long\b|\bgo short\b|\bentry\b|\bstop[- ]loss\b|\btake[- ]profit\b/i;

const slotOf = (ms: number): number => Math.floor(ms / BRIEF_EVERY_MS) * BRIEF_EVERY_MS;
const numOrNull = (s: string | null | undefined): number | null => { if (s === null || s === undefined) return null; const n = Number(s); return Number.isFinite(n) ? n : null; };

export async function collectBriefFacts(deps: ChannelDeps & BriefDeps, now: number): Promise<BriefFacts> {
  const cfg = { ...BRIEF_DEFAULTS, ...deps.brief_config };
  const missing: string[] = [];
  const t = cfg.block_timeout_ms;
  const [universe, scan] = await Promise.all([
    safely(deps, 'universe', () => deps.universe(), t),
    safely(deps, 'scan', () => deps.scan(cfg.scan_top), t),
  ]);
  const items = universe?.items ?? [];
  if (!items.length) missing.push('universe');

  const majors = await Promise.all(cfg.symbols.map(async (symbol) => {
    const r = await safely(deps, `regime ${symbol}`, () => deps.regime(symbol), t);
    if (!r) missing.push(`regime:${symbol}`);
    const a = items.find((x) => x.symbol === symbol);
    return {
      symbol,
      last: numOrNull(a?.last),
      change_24h_pct: numOrNull(a?.change_24h),
      regime: r ? { kind: r.regime, ret_20d_pct: r.ret_20d_pct, ret_5d_pct: r.ret_5d_pct, atr_pct: r.atr_pct, vol_pct_rank: r.vol_pct_rank, ema_stack: r.ema_stack, as_of: r.as_of } : null,
    };
  }));

  let scanFacts: BriefFacts['scan'] = null;
  if (scan && scan.ready && scan.candidates.length) {
    scanFacts = { at: scan.at, screen_id: scan.screen_id, scanned: scan.scanned, top: [...scan.candidates].sort((a, b) => a.rank - b.rank).slice(0, cfg.scan_top).map((c) => ({ rank: c.rank, symbol: c.symbol, score: c.score, reasons: c.reasons.slice(0, 2) })) };
  } else missing.push('scan');

  let funding: BriefFacts['funding'] = null;
  const rows: FundingRow[] = items
    .filter((a) => !a.excluded && a.funding_rate !== null && (numOrNull(a.perp_quote_volume_24h) ?? 0) >= cfg.funding_min_perp_vol_usd)
    .map((a) => ({ symbol: a.symbol, rate: numOrNull(a.funding_rate)!, perp_quote_volume_24h: numOrNull(a.perp_quote_volume_24h) }))
    .filter((r) => r.rate !== null && Number.isFinite(r.rate));
  if (rows.length) {
    const sorted = [...rows].sort((a, b) => b.rate - a.rate || a.symbol.localeCompare(b.symbol));
    const n = Math.min(cfg.funding_top, Math.floor(sorted.length / 2) || 1);
    funding = { updated_at: universe?.updated_at ?? null, highest: sorted.slice(0, n), lowest: sorted.slice(-n).reverse() };
  } else missing.push('funding');

  const books: BriefFacts['books'] = {};
  const liquidations: BriefFacts['liquidations'] = {};
  const micro = deps.micro;
  for (const symbol of cfg.symbols) {
    books[symbol] = null; liquidations[symbol] = null;
    if (!micro || !micro.symbols().includes(symbol)) { missing.push(`book:${symbol}`, `liq:${symbol}`); continue; }
    const book = await safely(deps, `book ${symbol}`, () => micro.book(symbol, now), t);
    const st = book ? bookStats(book, { band_pct: cfg.book_band_pct }) : null;
    if (book && st) books[symbol] = { at: book.at, mid: st.mid, spread_bps: st.spread_bps, bid_depth_usd: st.bid_depth_usd, ask_depth_usd: st.ask_depth_usd, imbalance: st.imbalance, visible_pct: st.visible_pct, wall_bid: st.wall_bid, wall_ask: st.wall_ask };
    else missing.push(`book:${symbol}`);
    // 清算只在录制器覆盖了整个窗口时才给数:否则 0 可能只是没录到
    const cov = await safely(deps, `coverage ${symbol}`, () => micro.coverage(symbol, now), t);
    const covered = !!cov && cov.from_ms <= now - cfg.liq_window_ms && cov.to_ms >= now - 5 * 60_000;
    const liqs = covered ? await safely(deps, `liq ${symbol}`, () => micro.liquidations(symbol, now - cfg.liq_window_ms, now), t) : null;
    if (liqs) { const s = sumLiquidations(liqs); liquidations[symbol] = { window_ms: cfg.liq_window_ms, long_usd: s.long_usd, short_usd: s.short_usd, total_usd: s.total_usd, count: s.count }; }
    else missing.push(`liq:${symbol}`);
  }
  return { slot: slotOf(now), generated_at: now, majors, scan: scanFacts, funding, books, liquidations, missing };
}

/** 确定性两三句人话:只陈述状态,不给操作 */
export function templateSummary(f: BriefFacts): string {
  const parts: string[] = [];
  const reg = f.majors.map((m) => `${baseOf(m.symbol)} 日线${m.regime ? REGIME_LABEL[m.regime.kind].split(' ')[0] : '状态暂缺'}`);
  parts.push(`${reg.join('、')}。`);
  if (f.scan?.top.length) parts.push(`每日扫描排名靠前:${f.scan.top.slice(0, 3).map((c) => baseOf(c.symbol)).join('、')}。`);
  if (f.funding?.highest.length && f.funding.lowest.length) parts.push(`资金费率最高 ${baseOf(f.funding.highest[0]!.symbol)} ${signedPct(f.funding.highest[0]!.rate * 100, 3)},最低 ${baseOf(f.funding.lowest[0]!.symbol)} ${signedPct(f.funding.lowest[0]!.rate * 100, 3)}。`);
  const liqs = Object.values(f.liquidations).filter((x): x is NonNullable<typeof x> => !!x);
  if (liqs.length) {
    const long = liqs.reduce((s, x) => s + x.long_usd, 0), short = liqs.reduce((s, x) => s + x.short_usd, 0);
    const lead = long + short === 0 ? '近 30 分钟 BTC/ETH 无清算记录' : `近 30 分钟 BTC/ETH 清算 ${usd(long + short)},${long >= short ? '多头被强平为主' : '空头被强平为主'}(多 ${usd(long)} / 空 ${usd(short)})`;
    parts.push(`${lead}。`);
  }
  return parts.join('');
}

function regimeLine(m: BriefFacts['majors'][number]): string {
  const b = baseOf(m.symbol);
  const px = m.last !== null ? ` ${price(m.last)}(24h ${signedPct(m.change_24h_pct, 2)})` : '';
  if (!m.regime) return `${b}${px} · 日线状态暂缺`;
  const r = m.regime;
  return `${b}${px} · ${REGIME_LABEL[r.kind]} · 20日 ${signedPct(r.ret_20d_pct)} · 5日 ${signedPct(r.ret_5d_pct)} · ATR ${num(r.atr_pct)}% · 波动分位 ${Math.round(r.vol_pct_rank * 100)}%`;
}

export function renderBrief(f: BriefFacts, summaryText: string): ChannelPush {
  const lines: string[] = [];
  lines.push('— 日线状态 / Daily regime');
  for (const m of f.majors) lines.push(regimeLine(m));

  lines.push(`— 每日扫描前列 / Scan leaders${f.scan?.at ? `(${utcLabel(f.scan.at)})` : ''}`);
  if (f.scan) for (const c of f.scan.top) lines.push(`${c.rank}. ${c.symbol} 分 ${num(c.score, 1)}${c.reasons.length ? ` — ${c.reasons.join(';').slice(0, 90)}` : ''}`);
  else lines.push('暂缺 / n/a');

  lines.push('— 资金费率极值 / Funding extremes(当期费率)');
  if (f.funding) {
    lines.push(`最高 / Highest: ${f.funding.highest.map((r) => `${baseOf(r.symbol)} ${signedPct(r.rate * 100, 3)}`).join(' · ')}`);
    lines.push(`最低 / Lowest: ${f.funding.lowest.map((r) => `${baseOf(r.symbol)} ${signedPct(r.rate * 100, 3)}`).join(' · ')}`);
  } else lines.push('暂缺 / n/a');

  lines.push('— 盘口 / Order book(OKX 永续,可见 200 档)');
  for (const s of Object.keys(f.books)) {
    const b = f.books[s];
    if (!b) { lines.push(`${baseOf(s)} 暂缺 / n/a`); continue; }
    const vis = b.visible_pct < 0.005 ? `可见 ±${(b.visible_pct * 100).toFixed(2)}%` : '±0.5%';
    lines.push(`${baseOf(s)} 中间价 ${price(b.mid)} · 价差 ${num(b.spread_bps, 2)}bp · 深度(${vis}) 买 ${usd(b.bid_depth_usd)} / 卖 ${usd(b.ask_depth_usd)} · 失衡 ${imbalanceText(b.imbalance)}`);
  }

  lines.push(`— 近 30 分钟清算 / Liquidations 30m`);
  for (const s of Object.keys(f.liquidations)) {
    const l = f.liquidations[s];
    lines.push(l ? `${baseOf(s)} 多头被强平 ${usd(l.long_usd)} / 空头被强平 ${usd(l.short_usd)}(${l.count} 笔)` : `${baseOf(s)} 暂缺 / n/a`);
  }
  if (f.missing.length) lines.push(`数据暂缺 / Missing: ${f.missing.join(', ')}`);

  const summary = f.majors.map((m) => `${baseOf(m.symbol)} ${m.regime ? REGIME_LABEL[m.regime.kind].split(' ')[0] : '暂缺'}`).join(' · ')
    + (f.scan?.top[0] ? ` · 扫描首位 ${baseOf(f.scan.top[0].symbol)}` : '');
  return channelPush('market_brief', `brief:${f.slot}`, `【行情简报 / Market Brief】 ${utcLabel(f.slot)}`, summaryText, lines,
    { kind: 'market_brief', slot: f.slot, generated_at: f.generated_at, summary_line: summary, facts: f });
}

interface Stored { push: ChannelPush; generated_at: number; slot: number }
const STATE_KEY = 'brief:last';
function loadLast(deps: ChannelDeps): Stored | null {
  try { const raw = deps.state.get(STATE_KEY); return raw ? JSON.parse(raw) as Stored : null; } catch { return null; }
}

async function build(deps: ChannelDeps & BriefDeps, now: number): Promise<ChannelPush> {
  const facts = await collectBriefFacts(deps, now);
  let text: string | null = null;
  if (deps.summarize) {
    text = await safely(deps, 'summarize', () => deps.summarize!(facts), (deps.brief_config?.block_timeout_ms ?? BRIEF_DEFAULTS.block_timeout_ms));
    if (text !== null) {
      text = text.replace(/\s+/g, ' ').trim().slice(0, 400);
      if (!text || BANNED_WORDS.test(text) || INSTRUCTION_WORDS.test(text)) { deps.log('warn', 'market_brief 模型摘要为空或含指令/红线词,改用模板'); text = null; }
    }
  }
  const push = renderBrief(facts, text ?? templateSummary(facts));
  deps.state.set(STATE_KEY, JSON.stringify({ push, generated_at: now, slot: facts.slot } satisfies Stored));
  return push;
}

export const marketBriefChannel: SubscriptionChannel<BriefDeps> = {
  key: 'market_brief',
  every_ms: BRIEF_EVERY_MS,
  /** 同一个 30 分钟槽只算一次;重复 tick 回放同一份(同 event_id、同内容),由 broadcaster 按 (订阅, event_id) 判重 */
  async tick(deps) {
    const now = deps.now();
    const last = loadLast(deps);
    if (last && last.slot === slotOf(now)) return last.push;
    return build(deps, now);
  },
  async welcome(deps) {
    const now = deps.now();
    const reuse = deps.brief_config?.welcome_reuse_ms ?? BRIEF_DEFAULTS.welcome_reuse_ms;
    const last = loadLast(deps);
    if (last && now - last.generated_at <= reuse && now >= last.generated_at) return last.push;
    return build(deps, now);
  },
};
