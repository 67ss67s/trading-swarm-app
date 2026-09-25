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
import { fetchKlines } from '../../market.js';
import { matrixStudyService } from '../../routes-matrix-study.js';
import { recommendAssets } from '../../recommend.js';
import { fromDecisionClient } from '../../research/judge/index.js';
import { ResearchStore } from '../../research/store.js';
import type { DemoRuntime } from '../../runtime.js';
import { toResearchBars } from '../../strategy-candidate.js';
import type { DailyRegime } from '../../types.js';
import { currentUniverse, latestUniverseScan } from '../../universe-okx.js';
import type { MarketCli } from '../cli.js';
import { assetHorizonService } from './asset-horizon.js';
import { ServiceBroadcaster, type SubscriptionServiceDef } from './broadcast.js';
import { DEFAULT_PRICES, LISTINGS, listingBundle, LISTING_KEYS, type ListingKey } from './catalog.js';
import { createJevProbabilityService, jevJudge, type JevBinding } from './jev-probability.js';
import { marketBriefChannel } from './market-brief.js';
import { microAlertsChannel } from './micro-alerts.js';
import { recorderMicroSource, type MicroSource } from './micro-source.js';
import { planGateService } from './plan-gate.js';
import type { RegisterProviderHandler } from './provider-contract.js';
import { quickBacktestLoader } from './quick-backtest.js';
import { radarFeedChannel, type RadarDeps } from './radar-feed.js';
import { ensureResultTable, readConfig, registerAspServices, type AspServicesConfig } from './register.js';
import { researchReportService } from './research-report.js';
import { ServiceInputError, type ChannelKey, type ChannelPush, type Deliverable, type MatrixViewLike, type PerCallService, type ServiceDeps, type SubscriptionChannel } from './types.js';

const TF_MS: Record<string, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const CONFIG_KEY = 'asp_services.config';
const PRICES_KEY = 'asp_services.prices';

export interface AspServicesOptions {
  cli: MarketCli;
  aspId(): Promise<string>;
  /** provider-tasks.ts 的 registerProviderHandler;没有就只提供预览与扇出 */
  register?: RegisterProviderHandler;
  /** provider-tasks.ts 的 ensureBuyerSession(deliver 前建 okx-a2a 会话) */
  ensureSession?(job_id: string, asp: string, buyer: string | null): Promise<void>;
  micro?: MicroSource | null;
  tick_ms?: number;
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
    this.handlers = {
      asset_horizon: assetHorizonService,
      research_report: researchReportService,
      plan_gate: planGateService,
      jev_probability: createJevProbabilityService({ judgeAvailable: () => this.rt.modelConnections().frozenDecision() ? null : '决策模型连接未绑定或已失效 / decision model not bound' }),
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
    this.unregister = registerAspServices({
      register: this.o.register, config: this.config(), handlers: this.handlers, channels: this.channels,
      serviceDeps: () => this.serviceDeps(), channelContext: (c) => this.broadcaster.channelContext(c),
      available: (k) => LISTINGS[k].paid_model && !this.rt.modelConnections().frozenDecision() ? '决策模型暂不可用,暂不接单 / decision model unavailable' : null,
      db: this.rt.store.marketDb, now: () => Date.now(),
    });
  }

  /** 已配置 serviceId 的订阅服务 → 扇出定义 */
  subscriptionServices(): SubscriptionServiceDef[] {
    const ids = this.config().service_ids;
    return LISTING_KEYS.filter((k) => LISTINGS[k].kind === 'subscription' && ids[k])
      .map((k) => ({ service_id: ids[k]!, channels: (LISTINGS[k].channels ?? []).map((c) => this.channels[c]) }));
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
      matrix: () => { const m = matrixStudyService(); return m ? { create: (b) => m.create(b), get: (id) => m.get(id) as unknown as MatrixViewLike } : null; },
      bars: async (symbol, timeframe, limit, market) => {
        const ms = TF_MS[timeframe]; if (!ms) return [];
        const now = Date.now();
        return toResearchBars(await fetchKlines(symbol, timeframe, limit + 1, now, market), ms, now).slice(-limit);
      },
      regime: (s) => this.regime(s),
      judge: jevJudge(() => this.jevBinding(), ['take', 'regime_fit']),
      jev: () => this.jevBinding(),
      quoteVolume24h: quoteVolume,
      backtestBars: quickBacktestLoader(new ResearchStore(this.rt.store.marketDb)),
    };
  }

  channelDeps(c: ChannelKey): Record<string, unknown> {
    if (c === 'market_brief') return { regime: (s: string) => this.regime(s), scan: (limit: number) => latestUniverseScan(this.rt.store.marketDb, { limit }), universe: () => currentUniverse(), micro: this.micro };
    if (c === 'micro_alerts') return { micro: this.micro };
    const radar: RadarDeps = {
      latest: (tier) => this.rt.store.screens.latest(tier),
      candidates: (id, n) => this.rt.store.screens.candidates(id, n),
      // 不走 rt.recommend():那条每次落一行推荐库;这里只要流动性门结果
      fit: async (symbols, h) => (await recommendAssets(this.recommendDeps(), { symbols, horizons: [h] })).rows.map((x) => ({ symbol: x.symbol, fit: x.horizons[h], quote_vol_24h: x.quote_vol_24h, depth_usd_05: x.depth_usd_05 })),
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
}
