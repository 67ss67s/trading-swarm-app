/**
 * ASP 对外服务总装:把按次处理器、订阅频道、扇出器与 runtime 的真实数据源接起来。
 *
 * 接入 AspAgent 的一刀(provider-tasks.ts 交付后切):
 *   const hub = new AspServices(rt, { cli, aspId, register: registerProviderHandler, ensureSession: ensureBuyerSession });
 *   hub.start();  // 注册已配置 serviceId 的 handler + 每分钟一次订阅扇出 tick
 * serviceId 上架后写进 PUT /api/asp-services/config;没配 = 不注册、不推送。
 *
 * 花钱的地方只有两处,默认都关:Jev(plan_gate / jev_probability,每次 ≤ JUDGE_MAX_CALL_USD)与简报的便宜模型润色(未接,走模板)。
 */
import { fetchKlines, fetchTicker24h } from '../../market.js';
import { okxGet } from '../../market-okx.js';
import { matrixStudyService } from '../../routes-matrix-study.js';
import { recommendAssets } from '../../recommend.js';
import { fromDecisionClient } from '../../research/judge/index.js';
import { ResearchStore } from '../../research/store.js';
import type { DemoRuntime } from '../../runtime.js';
import { toResearchBars } from '../../strategy-candidate.js';
import type { DailyRegime } from '../../types.js';
import { currentUniverse, latestUniverseScan } from '../../universe-okx.js';
import { parseClaimableText, signalServiceId, subscriptionStatus } from '../agent.js';
import { CliError, data, list, object, payload, type MarketCli } from '../cli.js';
import { registerProviderHandler as globalRegisterProviderHandler, resolveProviderHandler, type ProviderHandler } from '../provider-tasks.js';
import { assetHorizonService, stockLike } from './asset-horizon.js';
import { ServiceBroadcaster, type SubscriptionServiceDef } from './broadcast.js';
import { checkListing, DEFAULT_PRICES, LISTINGS, listingBundle, listingPayload, LISTING_KEYS, type ListingDef, type ListingKey } from './catalog.js';
import { createJevProbabilityService, jevJudge, type JevBinding } from './jev-probability.js';
import { marketBriefChannel } from './market-brief.js';
import { microAlertsChannel } from './micro-alerts.js';
import { recorderMicroSource, type MicroSource } from './micro-source.js';
import { createPlanGateService } from './plan-gate.js';
import type { RegisterProviderHandler } from './provider-contract.js';
import { quickBacktestLoader } from './quick-backtest.js';
import { radarFeedChannel, type RadarDeps } from './radar-feed.js';
import { ensureResultTable, pauseGate, readConfig, registerAspServices, type AspServicesConfig } from './register.js';
import { makeResearchReportService } from './research-report.js';
import { compileStrategy } from '../../research/strategy.js';
import { ServiceInputError, type ChannelKey, type ChannelPush, type Deliverable, type MatrixViewLike, type PerCallService, type ServiceDeps, type SubscriptionChannel } from './types.js';

const TF_MS: Record<string, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const CONFIG_KEY = 'asp_services.config';
const PRICES_KEY = 'asp_services.prices';
const PAUSED_KEY = 'asp_services.paused';
const SERVICE_LIST_TTL_MS = 5 * 60_000;
const PROVIDER_SUBS_TTL_MS = 60_000;
const CLAIMABLE_TTL_MS = 60_000;

/** 「我的产品」:策略信号(agent.ts 那条服务)+ 目录里的 7 个服务 */
export type ProductKey = 'strategy_signal' | ListingKey;
export const PRODUCT_KEYS: readonly ProductKey[] = ['strategy_signal', ...LISTING_KEYS];
/** 策略信号不在 catalog 里;线上资料缺失时的兜底(与已上架的 40888 一致) */
export const SIGNAL_LISTING = {
  key: 'strategy_signal', kind: 'subscription', name: 'Trading Swarm 策略信号',
  description: [
    '策略信号订阅:研究台验证过的策略在运行时按规则逐根 K 线扫描,触发即推送一条单行文本信号(≤200 字),以【Futures】或【Spot】开头,含交易对、方向、市价/限价与参考价、止损、止盈与有效期。',
    '无需提供参数。',
    '订阅生效后立即推送当前有效信号,没有时告知下一次扫描时间;信号只描述规则触发的计划,不构成投资建议。',
  ],
} as unknown as ListingDef;
export const SIGNAL_DEFAULT_PRICE = '1';
/** 改资料的提示:所有对外写操作的确认框都要带 */
export const REVIEW_NOTICE = '改资料会触发 OKX 重新审核,审核期间资料状态显示为「重新审核中」 / Editing a listing triggers an OKX re-review';

export type ProductStatus = 'listed' | 'in_review' | 'paused' | 'not_listed' | 'unknown';
export interface ProductStats { active_subscribers: number; trial_subscribers: number; orders_7d: number; orders_total: number; deliveries_ok: number; deliveries_failed: number; last_delivery_at: number | null }
export interface ProductView {
  key: ProductKey; name: string; kind: 'subscription' | 'one_time'; price: string; price_unit: 'month' | 'call'; trial_hours: number | null;
  description: string; service_id: string | null; listing_id: string | null; status: ProductStatus; paused: boolean; stats: ProductStats;
}
interface ServiceListView { agent: Record<string, unknown>; items: Record<string, unknown>[] }

/** approvalStatus 人话化:2 审核中 / 3 改资料触发重新审核 / 5、6 被拒 / 1 或缺省 未提交;其余如实说「状态未知」 */
export function approvalLabel(code: number | null, remark: string | null): string {
  if (code === 2) return '审核中';
  if (code === 3) return '重新审核中(资料有改动)';
  if (code === 5 || code === 6) return `被拒:${remark || '平台未给出原因'}`;
  if (code === 1) return '未提交审核';
  return code === null ? '状态未知' : `状态未知(代码 ${code})`;
}
/** 秒或毫秒 → 毫秒;空值 null */
export function toMs(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v); if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}
export const STATUS_LABELS: Record<string, string> = { INIT: '待接单', CREATED: '待接单', ACTIVE: '付费中', REJECTED: '已拒收', DISPUTED: '争议中', COMPLETED: '已完成', CLOSED: '已结束', EXPIRED: '已到期', FAILED: '失败', CANCELLED: '已取消', CANCELED: '已取消' };
export const TASK_STATE_LABELS: Record<string, string> = {
  seen: '新订单', no_handler: '未接单(服务未启用)', declining: '拒单中', declined: '已拒单', decline_unknown: '拒单结果待确认',
  accepting: '接单中', accepted: '已接单,生成中', accept_unknown: '接单结果待确认', delivering: '交付中', delivered: '已交付',
  deliver_failed: '交付失败,待重试', deliver_unknown: '交付结果待确认', skipped: '未交付(需求无法处理)', closed: '已关闭',
};
const DECLINED_STATES = "('declined','declining','decline_unknown','no_handler')";
const httpError = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });
const FEE_RE = /^\d+(?:\.\d{1,2})?$/;

export interface AspServicesOptions {
  cli: MarketCli;
  aspId(): Promise<string>;
  /** provider-tasks.ts 的 registerProviderHandler;没有就只提供预览与扇出 */
  register?: RegisterProviderHandler;
  /** provider-tasks.ts 的 ensureBuyerSession(deliver 前建 okx-a2a 会话) */
  ensureSession?(job_id: string, asp: string, buyer: string | null): Promise<void>;
  micro?: MicroSource | null;
  tick_ms?: number;
  /** 按 key 取已注册的 provider handler(包策略信号暂停闸用);register 是全局注册表时自动用 resolveProviderHandler */
  lookup?(key: string): ProviderHandler | undefined;
  /** 不在 LISTINGS 里、但也要走扇出的订阅服务(策略信号的保活状态频道,由 agent.ts 提供) */
  extraServices?(): SubscriptionServiceDef[];
}

let shared: AspServices | null = null;
export const aspServices = (): AspServices | null => shared;

export class AspServices {
  readonly broadcaster: ServiceBroadcaster;
  readonly handlers: Record<string, PerCallService<any>>;
  readonly channels: Record<ChannelKey, SubscriptionChannel<any>>;
  private readonly micro: MicroSource | null;
  private unregister: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly rt: DemoRuntime, private readonly o: AspServicesOptions) {
    this.micro = o.micro === undefined ? recorderMicroSource() : o.micro;
    if (!process.env['VITEST']) this.refreshNonCrypto();
    this.handlers = {
      asset_horizon: assetHorizonService,
      // 模板认不出的回测描述交给研究模型编译(复审 09-26:「连续 3 根阳线」被拒单);编译失败按生成失败处理
      research_report: makeResearchReportService({ nl_compile: true }),
      plan_gate: createPlanGateService({ tradable: (s: string, m: 'spot' | 'perp') => this.tradable(s, m) }),
      jev_probability: createJevProbabilityService({ judgeAvailable: () => this.rt.modelConnections().frozenDecision() ? null : '决策模型连接未绑定或已失效 / decision model not bound', tradable: (s: string, m: 'spot' | 'perp') => this.tradable(s, m) }),
    };
    this.channels = { market_brief: marketBriefChannel, radar_feed: radarFeedChannel, micro_alerts: microAlertsChannel };
    ensureResultTable(rt.store.marketDb);
    this.broadcaster = new ServiceBroadcaster({
      db: rt.store.marketDb, cli: o.cli, aspId: o.aspId, now: () => Date.now(),
      kvGet: (k) => rt.store.kvGet(k), kvSet: (k, v) => rt.store.kvSet(k, v),
      log: (level, msg) => rt.log(level, 'asp_services', msg), emit: (e, p) => rt.emit(e, p),
      ...(o.ensureSession ? { ensureSession: o.ensureSession } : {}),
      channelDeps: (c) => this.channelDeps(c as ChannelKey),
    }, () => this.subscriptionServices());
    shared = this;
  }

  config(): AspServicesConfig { return readConfig((k) => this.rt.store.kvGet(k)); }
  prices(): Partial<Record<ListingKey, string>> { try { return JSON.parse(this.rt.store.kvGet(PRICES_KEY) ?? '{}') as Partial<Record<ListingKey, string>>; } catch { return {}; } }

  start(): void {
    this.reregister();
    this.timer ??= setInterval(() => { void this.broadcaster.tick().catch((e) => this.rt.log('error', 'asp_services', `扇出 tick 失败:${(e as Error).message}`)); }, this.o.tick_ms ?? 60_000);
    this.timer.unref?.();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer); this.timer = null;
    this.unregister?.(); this.unregister = null;
    await this.broadcaster.stop();
    if (shared === this) shared = null;
  }
  private reregister(): void {
    this.unregister?.(); this.unregister = null;
    if (!this.o.register) return;
    const off = registerAspServices({
      register: this.o.register, config: this.config(), handlers: this.handlers, channels: this.channels,
      serviceDeps: () => this.serviceDeps(), channelContext: (c) => this.broadcaster.channelContext(c),
      available: (k) => LISTINGS[k].paid_model && !this.rt.modelConnections().frozenDecision() ? 'The decision model behind this service is temporarily unavailable, so it is not accepting orders right now.' : null,
      paused: (k) => this.isPaused(k),
      db: this.rt.store.marketDb, now: () => Date.now(),
    });
    const offSignal = this.wrapSignalHandler();
    this.unregister = () => { off(); offSignal?.(); };
  }
  /**
   * 策略信号的 handler 在 agent.ts 里注册(只有 produce);这里给它套一层暂停闸:暂停时 decide 拒单,其余原样委托。
   * 注销时把原 handler 放回去。取不到原 handler(测试注入的注册表)就不包。
   */
  private wrapSignalHandler(): (() => void) | null {
    const lookup = this.o.lookup ?? (this.o.register === globalRegisterProviderHandler ? (key: string) => {
      const sid = key.slice('service:'.length); const hit = resolveProviderHandler({ kind: 'subscription', service_id: sid });
      return hit && hit.key === key ? hit.handler : undefined;
    } : null);
    if (!lookup || !this.o.register) return null;
    const key = `service:${signalServiceId(this.rt.store)}`;
    const orig = lookup(key); if (!orig) return null;
    const wrapped: ProviderHandler = {
      decide: (task, ctx) => pauseGate(this.isPaused('strategy_signal')) ?? (orig.decide ? orig.decide(task, ctx) : { accept: true }),
      produce: (task, ctx) => orig.produce(task, ctx),
    };
    const off = this.o.register(key, wrapped);
    return () => { off(); if (!lookup(key)) this.o.register!(key, orig); };
  }

  /** 已配置 serviceId 的订阅服务 → 扇出定义(暂停接单的服务带 paused,扇出器跳过) */
  subscriptionServices(): SubscriptionServiceDef[] {
    const ids = this.config().service_ids;
    return [...LISTING_KEYS.filter((k) => LISTINGS[k].kind === 'subscription' && ids[k])
      .map((k) => ({ service_id: ids[k]!, channels: (LISTINGS[k].channels ?? []).map((c) => this.channels[c]), ...(this.isPaused(k) ? { paused: true } : {}) })),
      ...(this.o.extraServices?.() ?? [])];
  }

  // ---------------------------------------------------------------- 依赖装配

  private regime(symbol: string): Promise<DailyRegime | null> {
    // dailyRegimeFor 在 runtime 上是 private(只是编译期);这里是唯一一处跨类读取
    return (this.rt as unknown as { dailyRegimeFor(s: string): Promise<DailyRegime | null> }).dailyRegimeFor(symbol);
  }
  private jevBinding(): JevBinding | null {
    const f = this.rt.modelConnections().frozenDecision();
    return f ? { profile: f.profile, provider: fromDecisionClient(f.client, f.profile), db: this.rt.store.marketDb } : null;
  }
  private recommendDeps() {
    return { now: () => Date.now(), universe: () => currentUniverse(), scan: (limit: number) => latestUniverseScan(this.rt.store.marketDb, { limit }), regime: (s: string) => this.regime(s), id: () => `rec_asp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` };
  }

  /**
   * OKX 上有没有这个加密标的:全集快照里有对应现货/永续 instId 且未被排除,并且不是股票等非加密合约
   * (OKX 合约的 instCategory:1=加密,3=股票;全集快照没带这个字段,这里单独拉一次合约列表缓存 6 小时)。快照缺失时不拦。
   */
  private tradable(symbol: string, market: 'spot' | 'perp'): boolean {
    this.refreshNonCrypto();
    // 静态黑名单兜底(股票代币/杠杆 ETF),合约列表没拉到时也不会把美股永续推出去
    if (stockLike(symbol) || this.nonCrypto.symbols.has(symbol)) return false;
    const u = currentUniverse(); if (!u?.items.length) return true;
    const a = u.items.find((x) => x.symbol === symbol);
    return !!a && !a.excluded && !!(market === 'perp' ? a.perp_inst_id : a.spot_inst_id);
  }
  private nonCrypto: { symbols: Set<string>; at: number; loading: boolean } = { symbols: new Set(), at: 0, loading: false };
  private refreshNonCrypto(): void {
    if (this.nonCrypto.loading || Date.now() - this.nonCrypto.at < 6 * 3_600_000) return;
    this.nonCrypto.loading = true;
    void (async () => {
      // 永续先拉(股票永续都在这里),拉到就生效;现货失败不影响永续结果,只是 1 小时后再补
      const next = new Set<string>(this.nonCrypto.symbols);
      let failed: Error | null = null;
      for (const t of ['SWAP', 'SPOT']) {
        try {
          const rows = await okxGet<Record<string, unknown>[]>(`/api/v5/public/instruments?instType=${t}`, 30_000, 2);
          for (const r of rows) if (r['instCategory'] !== undefined && String(r['instCategory']) !== '1') { const fam = String(r['instFamily'] || r['instId'] || ''); const base = fam.split('-')[0]!.toUpperCase(); if (base) next.add(`${base}USDT`); }
          this.nonCrypto = { ...this.nonCrypto, symbols: new Set(next) };
        } catch (e) { failed = e as Error; }
      }
      if (failed) throw failed;
      this.nonCrypto = { symbols: next, at: Date.now(), loading: false };
    })().catch((e) => { this.nonCrypto.loading = false; this.nonCrypto.at = Date.now() - 5 * 3_600_000; this.rt.log('warn', 'asp_services', `非加密合约列表获取失败,1 小时后重试:${(e as Error).message}`); });
  }
  /** 实时 24h 行情(OKX 公共接口,永续);单个失败就跳过 */
  private async tickers(symbols: string[]): Promise<Record<string, { last: number; change_24h: number }>> {
    const out: Record<string, { last: number; change_24h: number }> = {};
    await Promise.all(symbols.map(async (s) => {
      try { const t = await fetchTicker24h(s, 'perp'); const last = Number(t.lastPrice), ch = Number(t.priceChangePercent); if (Number.isFinite(last)) out[s] = { last, change_24h: Number.isFinite(ch) ? ch : 0 }; } catch {}
    }));
    return out;
  }

  serviceDeps(): ServiceDeps & Record<string, unknown> {
    const quoteVolume = async (symbol: string, market: 'spot' | 'perp') => {
      const a = currentUniverse()?.items.find((x) => x.symbol === symbol);
      const v = a ? Number(market === 'perp' ? a.perp_quote_volume_24h : a.spot_quote_volume_24h) : NaN;
      return Number.isFinite(v) ? v : null;
    };
    return {
      now: () => Date.now(),
      recommend: (args) => this.rt.recommend(args),
      // get(id) 走 detail 视图(finalist 带 side/holdout 等);联合类型里的列表视图在这里不会出现
      matrix: () => { const m = matrixStudyService(); return m ? { create: (b) => m.create(b), get: (id) => m.get(id) as unknown as MatrixViewLike, resume: (id) => m.resume(id) } : null; },
      bars: async (symbol, timeframe, limit, market) => {
        const ms = TF_MS[timeframe]; if (!ms) return [];
        const now = Date.now();
        return toResearchBars(await fetchKlines(symbol, timeframe, limit + 1, now, market), ms, now).slice(-limit);
      },
      regime: (s) => this.regime(s),
      judge: jevJudge(() => this.jevBinding(), ['take', 'regime_fit']),
      jev: () => this.jevBinding(),
      quoteVolume24h: quoteVolume,
      tradable: (s: string, m: 'spot' | 'perp') => this.tradable(s, m),
      backtestBars: quickBacktestLoader(new ResearchStore(this.rt.store.marketDb)),
      compile: async (text: string, timeframe: string) => {
        const brain = this.rt.brainForRole('research');
        const r = await compileStrategy({ text, timeframe }, brain);
        return { ir: r.ok ? r.ir : null, unmapped: r.unmapped ?? [], model: (brain as { name?: string }).name ?? null, usd: null };
      },
    };
  }

  channelDeps(c: ChannelKey): Record<string, unknown> {
    const tradable = (s: string, m: 'spot' | 'perp' = 'perp') => this.tradable(s, m);
    if (c === 'market_brief') return { regime: (s: string) => this.regime(s), scan: (limit: number) => latestUniverseScan(this.rt.store.marketDb, { limit }), universe: () => currentUniverse(), micro: this.micro, tradable, tickers: (syms: string[]) => this.tickers(syms) };
    if (c === 'micro_alerts') return { micro: this.micro };
    const radar: RadarDeps & { tradable: typeof tradable } = {
      tradable,
      latest: (tier) => this.rt.store.screens.latest(tier),
      candidates: (id, n) => this.rt.store.screens.candidates(id, n),
      // 不走 rt.recommend():那条每次落一行推荐库;这里只要流动性门结果
      fit: async (symbols, h) => (await recommendAssets(this.recommendDeps(), { symbols, horizons: [h] })).rows.map((x) => ({ symbol: x.symbol, fit: x.horizons[h], quote_vol_24h: x.quote_vol_24h, depth_usd_05: x.depth_usd_05 })),
      // 雷达触发价旁带现价(已越过触发价时注明)
      tickers: (syms: string[]) => this.tickers(syms),
    };
    return radar as unknown as Record<string, unknown>;
  }

  // ---------------------------------------------------------------- HTTP 面

  overview() {
    const cfg = this.config(), db = this.rt.store.marketDb;
    const results = db.prepare('SELECT job_id,listing,service_id,created_at,summary,sha256,anchor_json FROM okx_market_service_result ORDER BY created_at DESC LIMIT 50').all();
    return {
      listings: listingBundle(this.prices(), cfg.service_ids),
      holds: Object.fromEntries(LISTING_KEYS.filter((k) => LISTINGS[k].hold).map((k) => [k, LISTINGS[k].hold])),
      config: cfg, default_prices: DEFAULT_PRICES, prices: this.prices(),
      registered: !!this.unregister, running: !!this.timer,
      pushes: this.broadcaster.recent(50), results,
    };
  }
  saveConfig(body: Record<string, unknown>) {
    const cur = this.config();
    if (body['service_ids'] !== undefined) {
      const ids = body['service_ids'];
      if (!ids || typeof ids !== 'object' || Array.isArray(ids)) throw new ServiceInputError('service_ids_invalid', 'service_ids 必须是 {listing: serviceId}');
      for (const [k, v] of Object.entries(ids)) {
        if (!LISTING_KEYS.includes(k as ListingKey)) throw new ServiceInputError('listing_unknown', `未知服务 ${k}`);
        if (v !== null && (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v))) throw new ServiceInputError('service_id_invalid', `${k} 的 serviceId 格式无效`);
      }
      const next = { ...cur.service_ids } as Record<string, string>;
      for (const [k, v] of Object.entries(ids as Record<string, string | null>)) { if (v === null) delete next[k]; else next[k] = v; }
      this.rt.store.kvSet(CONFIG_KEY, JSON.stringify({ service_ids: next }));
    }
    if (body['prices'] !== undefined) {
      const p = body['prices'] as Record<string, unknown>;
      if (!p || typeof p !== 'object') throw new ServiceInputError('prices_invalid', 'prices 必须是 {listing: "价格"}');
      for (const [k, v] of Object.entries(p)) if (!LISTING_KEYS.includes(k as ListingKey) || typeof v !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(v)) throw new ServiceInputError('prices_invalid', `${k} 的价格无效`);
      this.rt.store.kvSet(PRICES_KEY, JSON.stringify({ ...this.prices(), ...p }));
    }
    if (this.unregister) this.reregister();
    return this.overview();
  }

  /** 本地预览:validate + handle,不 deliver、不记账;付费模型类要 allow_paid */
  async preview(listing: string, body: Record<string, unknown>): Promise<Deliverable> {
    const d = LISTINGS[listing as ListingKey];
    if (!d || d.kind !== 'one_time') throw Object.assign(new Error(`没有这个按次服务:${listing}`), { status: 404 });
    if (d.paid_model && body['allow_paid'] !== true) throw Object.assign(new Error('该服务会调用付费决策模型;确认后传 allow_paid:true'), { status: 409 });
    const svc = this.handlers[d.handler!.service]!;
    const force = d.handler!.force;
    const params = body['service_params'] === undefined || body['service_params'] === null ? null : typeof body['service_params'] === 'string' ? body['service_params'] : JSON.stringify(body['service_params']);
    const job = { job_id: `preview_${Date.now().toString(36)}`, service_key: d.handler!.service, description: String(body['description'] ?? ''), service_params: force ? JSON.stringify({ ...(params && /^\s*\{/.test(params) ? JSON.parse(params) as object : {}), ...force }) : params };
    if (force && params && !/^\s*\{/.test(params)) job.description = `${job.description}\n${params}`;
    return svc.handle(job, svc.validate(job), this.serviceDeps());
  }
  async previewChannel(channel: string): Promise<ChannelPush> {
    const c = this.channels[channel as ChannelKey];
    if (!c) throw Object.assign(new Error(`没有这个频道:${channel}`), { status: 404 });
    return c.welcome(this.broadcaster.channelContext(c.key));
  }

  // ---------------------------------------------------------------- 我的产品(卖方视图)

  private svcCache: { asp: string; at: number; value: ServiceListView } | null = null;
  private provSubsCache: { at: number; value: Record<string, unknown>[] } | null = null;
  private claimCache: { at: number; value: string | null } | null = null;
  private applying = false;

  /** 对话只读取已有缓存,冷缓存明确未就绪;不启动 CLI 或服务。 */
  chatSnapshot() {
    return { services: this.svcCache, subscribers: this.provSubsCache, claimable: this.claimCache, registered: !!this.unregister, running: !!this.timer };
  }

  pausedMap(): Partial<Record<ProductKey, boolean>> {
    try { const v = JSON.parse(this.rt.store.kvGet(PAUSED_KEY) ?? '{}') as Record<string, unknown>; return Object.fromEntries(Object.entries(v).filter(([k, x]) => PRODUCT_KEYS.includes(k as ProductKey) && x === true)) as Partial<Record<ProductKey, boolean>>; } catch { return {}; }
  }
  isPaused(key: ProductKey): boolean { return this.pausedMap()[key] === true; }
  setPaused(key: string, body: Record<string, unknown>): { key: ProductKey; paused: boolean; paused_all: Partial<Record<ProductKey, boolean>> } {
    const k = this.productKey(key);
    if (typeof body['paused'] !== 'boolean') throw httpError(400, 'paused_invalid', 'paused 必须是 true/false');
    const next = { ...this.pausedMap() }; if (body['paused']) next[k] = true; else delete next[k];
    this.rt.store.kvSet(PAUSED_KEY, JSON.stringify(next));
    this.rt.log('info', 'asp_services', `${k} ${body['paused'] ? '暂停接单' : '恢复接单'}`);
    this.rt.emit('asp_services_paused', { key: k, paused: body['paused'] });
    return { key: k, paused: body['paused'], paused_all: next };
  }
  private productKey(key: string): ProductKey {
    if (!PRODUCT_KEYS.includes(key as ProductKey)) throw httpError(404, 'product_unknown', `没有这个产品:${key}`);
    return key as ProductKey;
  }
  private def(key: ProductKey): ListingDef { return key === 'strategy_signal' ? SIGNAL_LISTING : LISTINGS[key]; }
  private configuredServiceId(key: ProductKey): string | null { return key === 'strategy_signal' ? signalServiceId(this.rt.store) : this.config().service_ids[key] ?? null; }
  /** 读库;表还没建(对应模块没起过)按空处理 */
  private q(sql: string, ...args: (string | number | null)[]): Record<string, unknown>[] {
    try { return this.rt.store.marketDb.prepare(sql).all(...args) as Record<string, unknown>[]; }
    catch (e) { if (/no such table/i.test((e as Error).message)) return []; throw e; }
  }

  /** service-list(第 1 页,20 条)缓存 5 分钟:agentInfo + 服务行 */
  async serviceList(asp: string, fresh = false): Promise<ServiceListView> {
    if (!fresh && this.svcCache && this.svcCache.asp === asp && Date.now() - this.svcCache.at < SERVICE_LIST_TTL_MS) return this.svcCache.value;
    const raw = payload(await this.o.cli.call('service-list', ['--agent-id', asp, '--page', '1', '--page-size', '20']));
    const first = object(Array.isArray(raw) ? raw[0] : raw);
    const items = Array.isArray(first['list']) ? (first['list'] as unknown[]).map(object) : list(raw);
    const value = { agent: object(first['agentInfo']), items };
    this.svcCache = { asp, at: Date.now(), value };
    return value;
  }
  /** my-subscriptions --role provider,缓存 60 秒;只留本 ASP 的行 */
  async providerSubscriptions(asp: string, fresh = false): Promise<Record<string, unknown>[]> {
    if (!fresh && this.provSubsCache && Date.now() - this.provSubsCache.at < PROVIDER_SUBS_TTL_MS) return this.provSubsCache.value;
    const rows = list(await this.o.cli.call('my-subscriptions', ['--role', 'provider']))
      .filter((r) => r['providerAgentId'] === undefined || r['providerAgentId'] === null || String(r['providerAgentId']) === asp);
    this.provSubsCache = { at: Date.now(), value: rows };
    return rows;
  }
  /** 可领收入(USDT);asp-claimable 在 4.6.2 只打人话表格,解析不了就 null */
  private async claimableUsdt(asp: string): Promise<string | null> {
    if (this.claimCache && Date.now() - this.claimCache.at < CLAIMABLE_TTL_MS) return this.claimCache.value;
    let value: string | null = null;
    try {
      const p = payload(await this.o.cli.call('asp-claimable', ['--agent-id', asp]));
      const o = object(p); const rows = Array.isArray(p) ? p.map(object) : Array.isArray(o['rewards']) ? (o['rewards'] as unknown[]).map(object) : [];
      const usdt = rows.find((r) => /^USD/i.test(String(r['symbol'] ?? r['currency'] ?? '')));
      const amt = usdt?.['amount'] ?? o['amount'];
      value = amt === undefined || amt === null || amt === '' ? null : String(amt);
    } catch (e) {
      const t = e instanceof CliError && e.code === 'cli_invalid_json' ? parseClaimableText(e.raw_message) : null;
      value = t ? (t.currency.toUpperCase().startsWith('USD') ? t.amount : '0') : null;
    }
    this.claimCache = { at: Date.now(), value };
    return value;
  }
  private onlineEntry(key: ProductKey, items: Record<string, unknown>[] | null): Record<string, unknown> | null {
    if (!items) return null;
    const sid = this.configuredServiceId(key); const def = this.def(key);
    return items.find((x) => sid && String(x['serviceId'] ?? '') === sid) ?? items.find((x) => String(x['serviceName'] ?? '') === def.name) ?? null;
  }
  private currentPrice(key: ProductKey, entry: Record<string, unknown> | null): string {
    if (entry) {
      const sub = Array.isArray(entry['subscription']) ? (entry['subscription'] as unknown[]).map(object) : [];
      const f = sub[0]?.['fee'] ?? entry['fee'];
      if (f !== undefined && f !== null && f !== '') return String(f);
    }
    if (key === 'strategy_signal') return SIGNAL_DEFAULT_PRICE;
    return this.prices()[key] ?? DEFAULT_PRICES[key];
  }
  private stats(key: ProductKey, sid: string | null, provSubs: Record<string, unknown>[] | null, now: number): ProductStats {
    const out: ProductStats = { active_subscribers: 0, trial_subscribers: 0, orders_7d: 0, orders_total: 0, deliveries_ok: 0, deliveries_failed: 0, last_delivery_at: null };
    if (!sid) return out;
    for (const r of provSubs ?? []) {
      if (String(r['serviceId'] ?? '') !== sid || subscriptionStatus(r) !== 'ACTIVE') continue;
      out.active_subscribers++; if (Number(r['trialType']) === 1) out.trial_subscribers++;
    }
    const o = this.q(`SELECT COUNT(*) AS n, SUM(created_at>=?) AS n7 FROM okx_market_provider_task WHERE service_id=? AND state NOT IN ${DECLINED_STATES}`, now - 7 * 86_400_000, sid)[0];
    out.orders_total = Number(o?.['n'] ?? 0); out.orders_7d = Number(o?.['n7'] ?? 0);
    const bump = (ok: number, bad: number, last: unknown) => { out.deliveries_ok += ok; out.deliveries_failed += bad; const l = last === null || last === undefined ? null : Number(last); if (l !== null && (out.last_delivery_at === null || l > out.last_delivery_at)) out.last_delivery_at = l; };
    // 接单交付(按次成品 / 订阅欢迎包):「交付了失败说明」也算失败
    const t = this.q(`SELECT SUM(t.state='delivered' AND COALESCE(r.summary,'') NOT LIKE 'failed:%') AS ok,
      SUM(t.state='deliver_failed' OR (t.state='delivered' AND COALESCE(r.summary,'') LIKE 'failed:%')) AS bad,
      MAX(CASE WHEN t.state='delivered' THEN t.updated_at END) AS last
      FROM okx_market_provider_task t LEFT JOIN okx_market_service_result r ON r.job_id=t.job_id WHERE t.service_id=?`, sid)[0];
    if (t) bump(Number(t['ok'] ?? 0), Number(t['bad'] ?? 0), t['last']);
    // 订阅推送:策略信号走发布器账本,其余走扇出账本
    const p = key === 'strategy_signal'
      ? this.q("SELECT SUM(status='delivered') AS ok, SUM(status='failed') AS bad, MAX(CASE WHEN status='delivered' THEN updated_at END) AS last FROM okx_market_delivery_out_job")[0]
      : this.q("SELECT SUM(j.status='delivered') AS ok, SUM(j.status='failed') AS bad, MAX(CASE WHEN j.status='delivered' THEN j.updated_at END) AS last FROM okx_market_service_push_job j JOIN okx_market_service_push p ON p.event_id=j.event_id WHERE p.service_id=?", sid)[0];
    if (p) bump(Number(p['ok'] ?? 0), Number(p['bad'] ?? 0), p['last']);
    return out;
  }

  /** GET /api/asp-services/products:ASP 身份条 + 新手清单 + 8 张产品卡。任何一路 CLI 失败只降级那一格,错误进 errors。 */
  async products() {
    const now = Date.now(); const errors: string[] = [];
    let asp: string | null = null;
    try { asp = await this.o.aspId(); } catch (e) { errors.push(`ASP 身份:${(e as Error).message.split('\n')[0]}`); }
    let svc: ServiceListView | null = null, provSubs: Record<string, unknown>[] | null = null, claimable: string | null = null;
    if (asp) {
      const id = asp;
      [svc, provSubs, claimable] = await Promise.all([
        this.serviceList(id).catch((e: Error) => { errors.push(`上架列表:${e.message.split('\n')[0]}`); return null; }),
        this.providerSubscriptions(id).catch((e: Error) => { errors.push(`订阅者列表:${e.message.split('\n')[0]}`); return null; }),
        this.claimableUsdt(id),
      ]);
    }
    const agent = svc?.agent ?? {};
    const codeRaw = agent['approvalStatus'];
    const code = codeRaw === undefined || codeRaw === null || codeRaw === '' || !Number.isFinite(Number(codeRaw)) ? null : Number(codeRaw);
    const remark = typeof agent['approvalRemark'] === 'string' && agent['approvalRemark'] ? agent['approvalRemark'] : null;
    // service-list 拿到了但没有 approvalStatus = 未提交;没拿到 = 未知
    const effCode = svc && code === null ? 1 : code;
    const label = !asp ? '未注册 ASP' : svc ? approvalLabel(effCode, remark) : '状态未知';
    const online = agent['onlineStatus'] === undefined || agent['onlineStatus'] === null ? null : Number(agent['onlineStatus']) === 1;
    const paused = this.pausedMap();
    const products: ProductView[] = PRODUCT_KEYS.map((key) => {
      const def = this.def(key); const entry = this.onlineEntry(key, svc?.items ?? null);
      const sid = this.configuredServiceId(key) ?? (entry?.['serviceId'] ? String(entry['serviceId']) : null);
      const trialRaw = entry ? entry['freeTrial'] : def.kind === 'subscription' ? '72' : null;
      const trial = trialRaw === undefined || trialRaw === null || trialRaw === '' || !(Number(trialRaw) > 0) ? null : Number(trialRaw);
      let status: ProductStatus;
      if (paused[key]) status = 'paused';
      else if (!svc) status = 'unknown';
      else if (!entry) status = 'not_listed';
      else if (effCode === 2 || effCode === 3) status = 'in_review';
      else if (effCode === 1 || effCode === 5 || effCode === 6) status = 'not_listed';
      else status = 'unknown';
      return {
        key, name: entry?.['serviceName'] ? String(entry['serviceName']) : def.name, kind: def.kind,
        price: this.currentPrice(key, entry), price_unit: def.kind === 'subscription' ? 'month' : 'call', trial_hours: def.kind === 'subscription' ? trial : null,
        description: typeof entry?.['serviceDescription'] === 'string' ? entry['serviceDescription'] : def.description.join('\n'),
        service_id: sid, listing_id: entry?.['id'] === undefined || entry?.['id'] === null ? null : String(entry['id']),
        status, paused: !!paused[key], stats: this.stats(key, sid, provSubs, now),
      };
    });
    const listedN = svc ? svc.items.length : null;
    const anyOrder = Number(this.q(`SELECT COUNT(*) AS n FROM okx_market_provider_task WHERE state NOT IN ${DECLINED_STATES}`)[0]?.['n'] ?? 0) > 0;
    const firstCustomer = (provSubs?.length ?? 0) > 0 || anyOrder;
    const submitted = effCode !== null && ![1, 5, 6].includes(effCode);
    const checklist = [
      { key: 'asp' as const, label: '注册 ASP 身份', done: !!asp, hint: asp ? `已注册 #${asp}` : '先注册 ASP 身份(名称、头像、第一个服务),才能上架产品' },
      { key: 'listed' as const, label: '上架第一个产品', done: !!listedN, hint: listedN ? `已上架 ${listedN} 个产品` : listedN === 0 ? '在产品卡上点「调整」,预检通过后提交上架' : '上架情况暂时查不到,稍后刷新' },
      { key: 'review' as const, label: '提交审核', done: submitted, hint: effCode === 2 || effCode === 3 ? `${label},等 OKX 审核结果` : effCode === 5 || effCode === 6 ? `${label};按原因修改后重新提交` : submitted ? label : effCode === 1 ? '资料还没提交审核' : '审核状态暂时查不到' },
      { key: 'first_customer' as const, label: '等第一个订阅者 / 第一张订单', done: firstCustomer, hint: firstCustomer ? '已有订阅者或订单,展开产品卡查看' : '上架通过后,买方订阅或下单会出现在这里' },
    ];
    return {
      asp: { agent_id: asp, name: agent['name'] ? String(agent['name']) : null, approval: { code: effCode, label, remark }, online, claimable_usdt: claimable },
      checklist, products, as_of: now, ...(errors.length ? { errors } : {}),
    };
  }

  /** GET /api/asp-services/products/:key/customers:订阅类 = 订阅者;按次类 = 订单 */
  async customers(key: string) {
    const k = this.productKey(key); const def = this.def(k);
    let sid = this.configuredServiceId(k);
    const asp = await this.o.aspId().catch(() => null);
    if (!sid && asp) { const svc = await this.serviceList(asp).catch(() => null); const e = this.onlineEntry(k, svc?.items ?? null); sid = e?.['serviceId'] ? String(e['serviceId']) : null; }
    if (!sid) return { key: k, kind: def.kind, service_id: null, items: [] };
    if (def.kind === 'subscription') {
      let rows: Record<string, unknown>[] = []; let error: string | null = null;
      if (asp) { try { rows = await this.providerSubscriptions(asp, true); } catch (e) { error = (e as Error).message.split('\n')[0]!; } }
      else error = '尚未注册 ASP 身份';
      const pushSql = k === 'strategy_signal'
        ? "SELECT job_id, COUNT(*) AS n FROM okx_market_delivery_out_job WHERE status='delivered' GROUP BY job_id"
        : "SELECT j.job_id AS job_id, COUNT(*) AS n FROM okx_market_service_push_job j JOIN okx_market_service_push p ON p.event_id=j.event_id WHERE p.service_id=? AND j.status='delivered' GROUP BY j.job_id";
      const pushes = new Map(this.q(pushSql, ...(k === 'strategy_signal' ? [] : [sid])).map((r) => [String(r['job_id']).toLowerCase(), Number(r['n'])]));
      const welcomes = new Set(this.q("SELECT job_id FROM okx_market_provider_task WHERE service_id=? AND state='delivered'", sid).map((r) => String(r['job_id']).toLowerCase()));
      const items = rows.filter((r) => String(r['serviceId'] ?? '') === sid).map((r) => {
        const job = String(r['jobId'] ?? ''); const status = subscriptionStatus(r); const trial = Number(r['trialType']) === 1;
        return {
          job_id: job, buyer_agent_id: r['buyerAgentId'] === undefined || r['buyerAgentId'] === null ? null : String(r['buyerAgentId']),
          status_label: status === 'ACTIVE' && trial ? '试用中' : STATUS_LABELS[status] ?? (status || '状态未知'), trial,
          started_at: toMs(r['subStartTime']) ?? toMs(r['trialStartTime']), ends_at: toMs(r['subEndTime']) ?? toMs(r['trialEndTime']),
          pushes: (pushes.get(job.toLowerCase()) ?? 0) + (welcomes.has(job.toLowerCase()) ? 1 : 0),
          active: status === 'ACTIVE', auto_renew: r['autoRenew'] === true || Number(r['autoRenew']) === 1,
        };
      }).sort((a, b) => Number(b.active) - Number(a.active) || (b.started_at ?? 0) - (a.started_at ?? 0));
      return { key: k, kind: def.kind, service_id: sid, items, ...(error ? { error } : {}) };
    }
    const rows = this.q(`SELECT t.job_id, t.buyer_agent_id, t.state, t.created_at, t.updated_at, t.test_flag, e.description, e.client_agent_id, r.summary, r.created_at AS result_at
      FROM okx_market_provider_task t LEFT JOIN okx_market_provider_event e ON e.job_id=t.job_id LEFT JOIN okx_market_service_result r ON r.job_id=t.job_id
      WHERE t.service_id=? ORDER BY t.created_at DESC LIMIT 200`, sid);
    const items = rows.map((r) => {
      const state = String(r['state']); const delivered = state === 'delivered';
      return {
        job_id: String(r['job_id']), buyer_agent_id: r['buyer_agent_id'] ? String(r['buyer_agent_id']) : r['client_agent_id'] ? String(r['client_agent_id']) : null,
        request: typeof r['description'] === 'string' ? r['description'] : '', state, state_label: TASK_STATE_LABELS[state] ?? state,
        created_at: Number(r['created_at']), delivered_at: delivered ? Number(r['result_at'] ?? r['updated_at']) : null,
        summary: typeof r['summary'] === 'string' ? r['summary'] : null, test: Number(r['test_flag']) === 1,
      };
    });
    return { key: k, kind: def.kind, service_id: sid, items };
  }

  /** 线上当前资料(没上架就用目录) */
  private async current(k: ProductKey, fresh = false) {
    const def = this.def(k);
    let asp: string | null = null; try { asp = await this.o.aspId(); } catch {}
    const svc = asp ? await this.serviceList(asp, fresh) : null;
    const entry = this.onlineEntry(k, svc?.items ?? null);
    const text = typeof entry?.['serviceDescription'] === 'string' ? entry['serviceDescription'] : def.description.join('\n');
    const lines = text.split('\n');
    const description: [string, string, string] = [lines[0] ?? '', lines[1] ?? '', lines.slice(2).join('\n')];
    return { def, asp, entry, price: this.currentPrice(k, entry), description, text };
  }
  /** 目录定义 + 线上资料 + 改动 → `agent update --service` 的数组元素(更新时保留线上名称/指南/试用) */
  private buildPayload(k: ProductKey, def: ListingDef, entry: Record<string, unknown> | null, fee: string, description: [string, string, string]): Record<string, unknown> {
    const d: ListingDef = { ...def, ...(entry?.['serviceName'] ? { name: String(entry['serviceName']) } : {}), description };
    const base = listingPayload(d, fee, entry ? String(entry['id']) : null);
    base['serviceDescription'] = description.map((x) => x.trim()).join('\n').replace(/\n+$/, '');
    if (entry) {
      base['id'] = entry['id']; // service-list 里原样的 id(数字)
      if (typeof entry['serviceGuide'] === 'string' && entry['serviceGuide'].trim()) base['serviceGuide'] = entry['serviceGuide'];
      if (def.kind === 'subscription') { if (entry['freeTrial'] === undefined || entry['freeTrial'] === null || entry['freeTrial'] === '') delete base['freeTrial']; else base['freeTrial'] = String(entry['freeTrial']); }
    }
    void k;
    return base;
  }
  private async validateListing(service: Record<string, unknown>, def: ListingDef, fee: string, description: [string, string, string]) {
    const local = checkListing({ ...def, name: String(service['serviceName'] ?? def.name), description }, fee).map((message) => ({ field: 'local', severity: 'block', message }));
    let cli: { pass: boolean; findings: Record<string, unknown>[] }; let error: string | null = null;
    try {
      const r = data(await this.o.cli.json(['agent', 'validate-listing', '--role', 'asp', '--service', JSON.stringify([service])]));
      // 诊断 code 不外露(okx-ai 规范),只留字段 / 严重度 / 说明
      cli = { pass: r['pass'] === true, findings: (Array.isArray(r['findings']) ? r['findings'] as unknown[] : []).map(object).map(({ code: _c, ...rest }) => rest) };
    } catch (e) { error = (e as Error).message.split('\n')[0]!; cli = { pass: false, findings: [{ field: 'cli', severity: 'block', message: `平台预检暂不可用:${error}` }] }; }
    return { pass: cli.pass && !local.length, findings: [...local, ...cli.findings], ...(error ? { error } : {}) };
  }

  /** POST …/:key/draft:本地自检 + validate-listing 预检,不写链 */
  async draft(key: string, body: Record<string, unknown>) {
    const k = this.productKey(key);
    const price = body['price'];
    if (price !== undefined && (typeof price !== 'string' || !FEE_RE.test(price.trim()) || !(Number(price) > 0))) throw httpError(400, 'price_invalid', '价格必须是大于 0、最多 2 位小数的数字');
    const desc = body['description'];
    if (desc !== undefined && (!Array.isArray(desc) || desc.length !== 3 || desc.some((x) => typeof x !== 'string') || !String(desc[0]).trim())) throw httpError(400, 'description_invalid', 'description 必须是 [核心能力, 需提供, 交付说明] 三段文字,第一段必填');
    const cur = await this.current(k, true);
    const fee = typeof price === 'string' ? price.trim() : cur.price;
    const description = (desc as [string, string, string] | undefined) ?? cur.description;
    const service_payload = this.buildPayload(k, cur.def, cur.entry, fee, description);
    const validate = await this.validateListing(service_payload, cur.def, fee, description);
    const priceChanged = Number(fee) !== Number(cur.price);
    const descChanged = String(service_payload['serviceDescription']) !== cur.text;
    const warns: string[] = [REVIEW_NOTICE];
    if (!cur.asp) warns.push('尚未注册 ASP 身份,不能提交');
    if (!cur.entry) warns.push('该产品还没上架:提交会新建一个上架服务;拿到 serviceId 后要写进服务配置才会自动接单');
    if (cur.entry && !priceChanged && !descChanged) warns.push('价格和描述都没有变化,无需提交');
    if (k !== 'strategy_signal' && LISTINGS[k].hold) warns.push(`上架前置条件未确认:${LISTINGS[k].hold}`);
    if (this.isPaused(k)) warns.push('该产品当前已暂停接单;改资料不会自动恢复');
    return {
      key: k, service_payload, validate, warns,
      diff: { price: { from: cur.price, to: fee, changed: priceChanged }, description: { from: cur.text, to: String(service_payload['serviceDescription']), changed: descChanged } },
    };
  }

  /** POST …/:key/apply:`onchainos agent update --agent-id <asp> --service '[payload]'`。对外写操作,必须 confirm:true。 */
  async apply(key: string, body: Record<string, unknown>) {
    const k = this.productKey(key);
    if (body['confirm'] !== true) throw httpError(400, 'confirm_required', '这是对外写操作,确认后传 confirm:true');
    const raw = Array.isArray(body['service_payload']) && body['service_payload'].length === 1 ? body['service_payload'][0] : body['service_payload'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'payload_invalid', 'service_payload 必须是 draft 返回的对象');
    const sp = { ...(raw as Record<string, unknown>) };
    if (this.applying) throw httpError(409, 'apply_in_progress', '上一次提交还没结束,请稍候');
    this.applying = true;
    try {
      const cur = await this.current(k, true);
      if (!cur.asp) throw httpError(409, 'asp_missing', '尚未注册 ASP 身份');
      const allowed = new Set(['operation', 'id', 'serviceName', 'serviceDescription', 'serviceGuide', 'serviceType', 'fee', 'subscription', 'freeTrial']);
      const extra = Object.keys(sp).filter((x) => !allowed.has(x)); if (extra.length) throw httpError(400, 'payload_invalid', `service_payload 含不支持的字段:${extra.join(',')}`);
      if (sp['serviceType'] !== 'A2A') throw httpError(400, 'payload_invalid', '只支持 A2A 服务');
      if (cur.entry) { if (sp['operation'] !== 'update' || String(sp['id']) !== String(cur.entry['id'])) throw httpError(409, 'payload_mismatch', `payload 不是这个产品的上架记录(应为 update #${String(cur.entry['id'])}),请重新预检`); }
      else if (sp['operation'] !== 'create' || sp['id'] !== undefined) throw httpError(409, 'payload_mismatch', '该产品未上架,payload 应为 create,请重新预检');
      const name = cur.entry?.['serviceName'] ? String(cur.entry['serviceName']) : cur.def.name;
      if (sp['serviceName'] !== name) throw httpError(400, 'payload_invalid', '这里不支持改服务名');
      let fee: string;
      if (cur.def.kind === 'subscription') {
        const sub = Array.isArray(sp['subscription']) ? (sp['subscription'] as unknown[]).map(object) : [];
        if (sp['fee'] !== '' || sub.length !== 1 || sub[0]!['interval'] !== 'month') throw httpError(400, 'payload_invalid', '订阅类必须是 fee:"" + 一条 month 月费');
        fee = String(sub[0]!['fee'] ?? '');
      } else {
        if (!Array.isArray(sp['subscription']) || (sp['subscription'] as unknown[]).length || sp['freeTrial'] !== undefined) throw httpError(400, 'payload_invalid', '按次类不能带订阅或试用');
        fee = String(sp['fee'] ?? '');
      }
      if (!FEE_RE.test(fee) || !(Number(fee) > 0)) throw httpError(400, 'payload_invalid', '价格必须是大于 0、最多 2 位小数的数字');
      if (typeof sp['serviceDescription'] !== 'string' || !sp['serviceDescription'].trim()) throw httpError(400, 'payload_invalid', '描述不能为空');
      const lines = sp['serviceDescription'].split('\n');
      const validate = await this.validateListing(sp, cur.def, fee, [lines[0] ?? '', lines[1] ?? '', lines.slice(2).join('\n')]);
      if (!validate.pass) throw Object.assign(httpError(409, 'validate_failed', `预检未通过:${validate.findings.map((f) => String(f['message'] ?? '')).join(';').slice(0, 500)}`), { validate });
      this.rt.log('info', 'asp_services', `提交上架资料更新 ${k} (${String(sp['operation'])} ${String(sp['id'] ?? '')}) 价格 ${fee}`);
      const result = await this.o.cli.call('update', ['--agent-id', cur.asp, '--service', JSON.stringify([sp])]);
      this.svcCache = null;
      if (k !== 'strategy_signal') this.rt.store.kvSet(PRICES_KEY, JSON.stringify({ ...this.prices(), [k]: fee }));
      const out = data(result);
      return { ok: true, key: k, tx_hash: findTxHash(result), result: out, notice: REVIEW_NOTICE };
    } finally { this.applying = false; }
  }
}

/** agent update 的回执里找交易哈希:txHash / tx_hash / transactionHash 键优先,其次任意 0x+64 位十六进制 */
export function findTxHash(v: unknown, depth = 0): string | null {
  if (depth > 8 || v === null || typeof v !== 'object') return null;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (/^(tx_?hash|transaction_?hash|hash)$/i.test(k) && typeof x === 'string' && x) return x;
  for (const x of Object.values(v as Record<string, unknown>)) { const r = findTxHash(x, depth + 1); if (r) return r; }
  if (depth === 0) { const m = JSON.stringify(v).match(/0x[0-9a-fA-F]{64}/); return m ? m[0] : null; }
  return null;
}
