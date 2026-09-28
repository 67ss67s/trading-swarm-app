/**
 * 「策略研究」流程页(#strategy-research)的纯逻辑:路由状态、推荐卡片墙、海选预填、验收状态条、回测 vs 模拟盘对照、上岗分桌。
 * 全是纯函数,单测在 test/strategy-research.test.ts。文案 key = 中文原文,英文在 ./i18n-en.ts。
 *
 * 路由(hash 不带斜杠):
 *   #strategy-research?step=assets|scout|refine|validate|deploy
 *     &rec=<recommendation_id>            第 1 步用哪份推荐(刷新不重算)
 *     &syms=SOLUSDT,XRPUSDT&tfs=15m,4h    第 1 步带进海选的资产与周期
 *     &fams=breakout,ma_trend&sides=long&mkt=perp
 *     &sref=<strategy_id>                 「我的策略」详情「用海选测这条」
 *     &study=<ms_…>&trial=<mt_…>          海选结果 / 精修带入的那一组
 *     &strategy=<rs_…>                    验收 / 上岗的那条策略
 */
import type { BindingRoleSlice, ResearchStrategy } from '@trade-gate/contracts';
import type { StrategyRun, StrategyRunEvent } from '@/api/types';
import type { MatrixStudyView, MatrixTimeframe } from '@/api/matrix-study';
import { DESK_SLICES } from '@/api/agent-strategy';
import { MATRIX_CANDIDATE_PREFIX } from '@/components/agent-strategy/switch-list';
import { FAMILIES } from '@/components/matrix-study/shared';
import { t, tmap } from '@/lib/i18n';

// ---------------------------------------------------------------- 步骤

export type FlowStep = 'assets' | 'scout' | 'refine' | 'validate' | 'deploy';
export const STEPS: FlowStep[] = ['assets', 'scout', 'refine', 'validate', 'deploy'];
export const STEP_TITLE: Record<FlowStep, string> = tmap({ assets: '选资产', scout: '海选', refine: '精修', validate: '验收', deploy: '上岗' });
/** 每步「在做什么 → 产出什么」 */
export const STEP_DOING: Record<FlowStep, string> = tmap({
  assets: '按行情推荐值得研究的币',
  scout: '几种打法一次全回测',
  refine: '挑一组逐条改规则',
  validate: '没看过的历史考一次,再上模拟盘跑',
  deploy: '交给 agent 按这条策略值班',
});
export const STEP_OUTPUT: Record<FlowStep, string> = tmap({
  assets: '几个币和周期',
  scout: '一张结果地图和候选',
  refine: '存进我的策略',
  validate: '能不能上岗的证据',
  deploy: '楼层各桌按规则干活',
});

export interface FlowRoute {
  step: FlowStep;
  rec: string | null;
  syms: string[];
  tfs: MatrixTimeframe[];
  fams: string[];
  sides: ('long' | 'short')[];
  mkt: 'spot' | 'perp' | null;
  sref: string | null;
  study: string | null;
  trial: string | null;
  strategy: string | null;
}

const TFS: MatrixTimeframe[] = ['3m', '5m', '15m', '4h', '1d'];
const list = (v: string | null) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);

export function parseFlowRoute(hash: string): FlowRoute {
  const q = new URLSearchParams(hash.replace(/^#/, '').split('?')[1] ?? '');
  const step = q.get('step') as FlowStep | null;
  const mkt = q.get('mkt');
  return {
    step: step && STEPS.includes(step) ? step : 'assets',
    rec: q.get('rec'),
    syms: list(q.get('syms')).map((s) => s.toUpperCase()).slice(0, 6),
    tfs: list(q.get('tfs')).filter((x): x is MatrixTimeframe => (TFS as string[]).includes(x)),
    fams: list(q.get('fams')),
    sides: list(q.get('sides')).filter((x): x is 'long' | 'short' => x === 'long' || x === 'short'),
    mkt: mkt === 'spot' || mkt === 'perp' ? mkt : null,
    sref: q.get('sref'),
    study: q.get('study'),
    trial: q.get('trial'),
    strategy: q.get('strategy'),
  };
}

/** 路由 → hash(不带 #);空值不写,键顺序固定,刷新 / 分享链接稳定 */
export function flowHash(r: Partial<FlowRoute>): string {
  const q = new URLSearchParams();
  q.set('step', r.step ?? 'assets');
  const put = (k: string, v: string | null | undefined) => { if (v) q.set(k, v); };
  put('rec', r.rec);
  put('syms', r.syms?.join(','));
  put('tfs', r.tfs?.join(','));
  put('fams', r.fams?.join(','));
  put('sides', r.sides?.join(','));
  put('mkt', r.mkt);
  put('sref', r.sref);
  put('study', r.study);
  put('trial', r.trial);
  put('strategy', r.strategy);
  return `strategy-research?${q.toString()}`;
}

/** 某一步「做完了」:用于步骤条打勾(只看路由里有没有这一步的产出) */
export function stepDone(r: FlowRoute, s: FlowStep): boolean {
  if (s === 'assets') return r.syms.length > 0 || !!r.study || !!r.sref;
  if (s === 'scout') return !!r.study;
  if (s === 'refine') return !!r.strategy;
  if (s === 'validate') return !!r.strategy && STEPS.indexOf(r.step) > STEPS.indexOf('validate');
  return false;
}

// ---------------------------------------------------------------- 第 1 步:推荐卡片墙

export type Horizon = 'short' | 'mid' | 'long';
export const HORIZONS: Horizon[] = ['short', 'mid', 'long'];
export const HORIZON_TEXT: Record<Horizon, string> = tmap({ short: '短线', mid: '中线', long: '长线' });
/** 周期档 → 海选用的周期(这一版矩阵只跑 15m / 4h / 1d) */
export const HORIZON_TF: Record<Horizon, MatrixTimeframe> = { short: '15m', mid: '4h', long: '1d' };
/** 周期档 → 雷达档(后端 recommend.ts HORIZON_RADAR_TIER) */
export const HORIZON_RADAR: Record<Horizon, 'short' | 'swing' | 'weekly'> = { short: 'short', mid: 'swing', long: 'weekly' };
export const RADAR_TIER_TEXT: Record<'short' | 'swing' | 'weekly', string> = tmap({ short: '雷达短线档', swing: '雷达波段档', weekly: '雷达周线档' });
/** 雷达各档刷新节奏;超过两倍算过期(与后端同口径) */
const RADAR_EVERY_MS: Record<Horizon, number> = { short: 12 * 3_600_000, mid: 72 * 3_600_000, long: 7 * 86_400_000 };

export interface HorizonFitLite { eligible: boolean; reason: string | null; direction: 'long' | 'short' | 'both' | null; families: string[]; evidence: string[] }
export interface RecRowLite {
  symbol: string; market: 'spot' | 'perp'; quote_vol_24h: number | null; depth_usd_05: number | null;
  regime: 'bull' | 'bear' | 'range' | 'volatile' | null;
  scan: { rank: number; score: number; reasons: string[] } | null;
  radar?: Partial<Record<Horizon, { rank: number; fit: number; reasons: string[] }>>;
  horizons: Record<Horizon, HorizonFitLite>;
}
export interface RecLite {
  id: string; as_of: number;
  source: { universe_scan_at: number | null; regime_at: number | null; radar_at?: Partial<Record<Horizon, number>> };
  rows: RecRowLite[]; warnings: string[];
}

export interface RecCard { key: string; symbol: string; horizon: Horizon; row: RecRowLite; fit: HorizonFitLite; radar: { rank: number; fit: number; reasons: string[] } | null }
export const cardKey = (symbol: string, h: Horizon) => `${symbol}|${h}`;

/** 三列:每列适合的在前(雷达名次 → 扫描名次 → 成交额),不适合的在后 */
export function cardsByHorizon(r: RecLite): Record<Horizon, RecCard[]> {
  const out = { short: [], mid: [], long: [] } as Record<Horizon, RecCard[]>;
  for (const h of HORIZONS) {
    const cards = r.rows.filter((row) => row.horizons[h]?.reason !== 'not_requested').map((row) => ({ key: cardKey(row.symbol, h), symbol: row.symbol, horizon: h, row, fit: row.horizons[h], radar: row.radar?.[h] ?? null }));
    cards.sort((a, b) => Number(b.fit.eligible) - Number(a.fit.eligible) || (a.radar?.rank ?? 999) - (b.radar?.rank ?? 999) || (a.row.scan?.rank ?? 999) - (b.row.scan?.rank ?? 999) || (b.row.quote_vol_24h ?? 0) - (a.row.quote_vol_24h ?? 0));
    out[h] = cards;
  }
  return out;
}

/** 默认勾选:每列适合的前 2 张,总数不超过 6 个币 */
export function defaultPicks(r: RecLite): string[] {
  const by = cardsByHorizon(r), picks: string[] = [], syms = new Set<string>();
  for (const h of HORIZONS) for (const c of by[h].filter((x) => x.fit.eligible).slice(0, 2)) {
    if (!syms.has(c.symbol) && syms.size >= 6) continue;
    syms.add(c.symbol);
    picks.push(c.key);
  }
  return picks;
}

export interface ScoutPreset { syms: string[]; tfs: MatrixTimeframe[]; fams: string[]; sides: ('long' | 'short')[]; mkt: 'spot' | 'perp' }
/** 勾选的卡 → 海选预填:币(≤6)、周期(按档)、策略族(并集,只取海选支持的)、方向、市场 */
export function picksToScout(r: RecLite, picks: string[]): ScoutPreset {
  const cards = HORIZONS.flatMap((h) => cardsByHorizon(r)[h]).filter((c) => picks.includes(c.key) && c.fit.eligible);
  const syms = [...new Set(cards.map((c) => c.symbol))].slice(0, 6);
  const tfs = TFS.filter((tf) => cards.some((c) => HORIZON_TF[c.horizon] === tf));
  const fams = (FAMILIES as readonly string[]).filter((f) => cards.some((c) => c.fit.families.includes(f)));
  const mkt = cards[0]?.row.market ?? 'perp';
  const sides = (['long', 'short'] as const).filter((s) => cards.some((c) => c.fit.direction === s || c.fit.direction === 'both') && (s === 'long' || mkt === 'perp'));
  return { syms, tfs, fams, sides: sides.length ? [...sides] : ['long'], mkt };
}

/** 证据时效:雷达档用自己的时间,没有就用日线状态时间;超过两倍刷新节奏标过期 */
export function evidenceAge(r: RecLite, h: Horizon, now: number): { at: number | null; stale: boolean; source: 'radar' | 'regime' | 'scan' | null } {
  const radar = r.source.radar_at?.[h] ?? null;
  if (radar) return { at: radar, stale: now - radar > 2 * RADAR_EVERY_MS[h], source: 'radar' };
  if (r.source.regime_at) return { at: r.source.regime_at, stale: now - r.source.regime_at > 2 * 86_400_000, source: 'regime' };
  if (r.source.universe_scan_at) return { at: r.source.universe_scan_at, stale: now - r.source.universe_scan_at > 2 * 86_400_000, source: 'scan' };
  return { at: null, stale: false, source: null };
}

/** 成交额 / 深度:1.48B / 911.2M / 2.0M */
export function fmtUsdShort(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

/** 推荐失败 / 为空时的原因(给人看的一句话) */
export function emptyReason(r: RecLite | null, error: string | null): string | null {
  if (error) return t('推荐没拿到:{e}', { e: error });
  if (!r) return null;
  if (!r.rows.length) return r.warnings.length ? r.warnings.join(';') : t('这次没有可推荐的币');
  if (!r.rows.some((row) => HORIZONS.some((h) => row.horizons[h]?.eligible))) return t('推荐了 {n} 个币,但眼下都不适合研究(流动性、历史长度或行情不合)', { n: r.rows.length }) + (r.warnings.length ? `;${r.warnings.join(';')}` : '');
  return null;
}

// ---------------------------------------------------------------- 第 3 步:精修产出检测

/** 进精修之后被存 / 更新过的策略(最近的那条,不含已归档);没有返回 null */
export function savedSince<T extends { id: string; updated_at: number; status: string }>(list: readonly T[], since: number): T | null {
  return [...list].filter((s) => s.status !== 'archived' && s.updated_at > since).sort((a, b) => b.updated_at - a.updated_at)[0] ?? null;
}

// ---------------------------------------------------------------- 第 4 步:验收状态条

export type SegTone = 'ok' | 'warn' | 'bad' | 'idle';
export interface StatusSeg { key: 'backtest' | 'final' | 'forward' | 'gate'; title: string; value: string; note: string; tone: SegTone }

export type FinalState = 'passed' | 'failed' | 'candidate' | 'unvalidated';
/** 最终验收:批量验证 finalist 采用(描述前缀「[矩阵研究 」)= 通过;候补前缀 = 未经;海选详情里该策略的 finalist 没过 = 未通过;其余(精修 / 内置)= 未经 */
export function finalState(s: Pick<ResearchStrategy, 'id' | 'description'>, study?: MatrixStudyView | null): FinalState {
  if (s.description.startsWith('[矩阵研究 ')) return 'passed';
  if (study) {
    const adopted = Object.entries(study.adoptions).find(([, a]) => a.strategy_id === s.id);
    if (adopted) return 'passed';
    const mine = study.state.finalists.filter((f) => f.family.startsWith(`my:${s.id}@`) || f.family === `my:${s.id}`);
    if (mine.some((f) => f.passed === true)) return 'passed';
    if (mine.length && mine.every((f) => f.passed === false)) return 'failed';
  }
  if (s.description.startsWith(MATRIX_CANDIDATE_PREFIX)) return 'candidate';
  return 'unvalidated';
}
/** 描述前缀里的海选 id(`[矩阵研究 ms_x ·` / `[批量验证候补 ms_x ·`) */
export function studyIdOf(description: string): string | null {
  return /^\[(?:矩阵研究|批量验证候补) (ms_[A-Za-z0-9_]+)/.exec(description)?.[1] ?? null;
}

/** 上岗建议线:模拟盘满 10 笔且平均每笔 R > 0(只建议,不硬拦) */
export const DEPLOY_MIN_TRADES = 10;
export function forwardStats(run: StrategyRun | null): { closed: number; realized_r: number | null; avg_r: number | null; open: number } {
  if (!run) return { closed: 0, realized_r: null, avg_r: null, open: 0 };
  const s = run.stats;
  return { closed: s.closed, realized_r: s.realized_r, avg_r: s.closed && s.realized_r != null ? s.realized_r / s.closed : null, open: s.open_threads };
}
export function deployReady(run: StrategyRun | null): boolean {
  const f = forwardStats(run);
  return f.closed >= DEPLOY_MIN_TRADES && (f.avg_r ?? 0) > 0;
}

const signedPct = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
const signedR = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`);
/** 前向运行只认模拟盘 / 纸面;实盘运行也显示,但说清楚 */
export const isPaperRun = (run: StrategyRun) => run.execution.backend === 'paper' || run.execution.profile === 'demo';

export function statusSegments(s: Pick<ResearchStrategy, 'id' | 'description' | 'summary'>, final: FinalState, run: StrategyRun | null): StatusSeg[] {
  const sum = s.summary;
  const backtest: StatusSeg = sum && sum.trades != null
    ? { key: 'backtest', title: t('历史回测'), value: `${signedPct(sum.total_return)} · ${t('{n} 笔', { n: sum.trades })}`, note: sum.max_drawdown != null ? t('最大回撤 {d}', { d: `${(sum.max_drawdown * 100).toFixed(1)}%` }) : '', tone: (sum.total_return ?? 0) > 0 && sum.trades >= 30 ? 'ok' : 'warn' }
    : { key: 'backtest', title: t('历史回测'), value: t('还没回测'), note: t('在精修里跑一次回测'), tone: 'idle' };
  const finalSeg: StatusSeg = final === 'passed' ? { key: 'final', title: t('最终验收'), value: t('通过'), note: t('没看过的那段历史考过一次'), tone: 'ok' }
    : final === 'failed' ? { key: 'final', title: t('最终验收'), value: t('未通过'), note: t('没看过的那段历史没考过'), tone: 'bad' }
    : final === 'candidate' ? { key: 'final', title: t('最终验收'), value: t('未经最终验收'), note: t('海选候补:先用模拟盘看前向'), tone: 'warn' }
    : { key: 'final', title: t('最终验收'), value: t('未经最终验收'), note: t('精修出来的版本没考过;可以回海选考一次'), tone: 'warn' };
  const f = forwardStats(run);
  const forward: StatusSeg = !run
    ? { key: 'forward', title: t('模拟盘前向'), value: t('还没跑'), note: t('点下面「用模拟盘跑起来」'), tone: 'idle' }
    : { key: 'forward', title: isPaperRun(run) ? t('模拟盘前向') : t('实盘前向'), value: `${t('已平 {n} 笔', { n: f.closed })} · ${signedR(f.realized_r)}`, note: f.open ? t('持仓 {n} · {state}', { n: f.open, state: RUN_STATE[run.status] }) : RUN_STATE[run.status], tone: f.closed === 0 ? 'idle' : (f.avg_r ?? 0) > 0 ? 'ok' : 'warn' };
  const gate: StatusSeg = deployReady(run)
    ? { key: 'gate', title: t('上岗条件'), value: t('达到建议线'), note: t('模拟盘满 {n} 笔且平均每笔为正', { n: DEPLOY_MIN_TRADES }), tone: 'ok' }
    : { key: 'gate', title: t('上岗条件'), value: f.closed >= DEPLOY_MIN_TRADES ? t('期望还不为正') : t('还差 {n} 笔', { n: DEPLOY_MIN_TRADES - f.closed }), note: t('建议:模拟盘满 {n} 笔且期望 > 0(不硬拦)', { n: DEPLOY_MIN_TRADES }), tone: f.closed >= DEPLOY_MIN_TRADES ? 'warn' : 'idle' };
  return [backtest, finalSeg, forward, gate];
}
export const RUN_STATE: Record<StrategyRun['status'], string> = tmap({ running: '运行中', paused: '已暂停', stopped: '已停止', error: '出错停下' });

/** 一条策略的前向运行:没停的优先,其次最近更新的(停了也要能看到成绩) */
export function forwardRunOf(runs: readonly StrategyRun[] | undefined, strategyId: string): StrategyRun | null {
  const mine = (runs ?? []).filter((r) => r.strategy_id === strategyId).sort((a, b) => b.updated_at - a.updated_at);
  return mine.find((r) => r.status !== 'stopped') ?? mine[0] ?? null;
}

/** 策略周期 → 雷达档(运行币池跟随):15m 及以下 → 短线,1h/4h → 波段,12h/1d → 周线 */
export function radarTierOf(tf: string): 'short' | 'swing' | 'weekly' {
  const m = /^(\d+)([mhdw])$/i.exec(tf.trim());
  if (!m) return 'swing';
  const n = Number(m[1]), u = m[2]!.toLowerCase();
  const minutes = u === 'm' ? n : u === 'h' ? n * 60 : u === 'd' ? n * 1440 : n * 10080;
  return minutes <= 15 ? 'short' : minutes <= 240 ? 'swing' : 'weekly';
}
export const RADAR_TOP_N = 10;

// ---------------------------------------------------------------- 回测会怎么做 vs 模拟盘实际

export interface ParityRow {
  at: number; symbol: string; direction: string | null;
  plan: { entry: string | null; stop: string | null; target: string | null; rr: number | null };
  actual: 'opened' | 'pending' | 'rejected' | 'skipped' | 'waiting';
  reason: string | null; realized_r: number | null; closed: boolean;
}
/**
 * 运行事件 → 对照行:每个候选 = 回测规则在这根 K 线上会做的(入场参考 / 止损 / 目标);
 * 之后同币第一条处理事件 = 模拟盘实际(下单 / 待确认 / 被拒 / 跳过);下了单的再按 thread_id 找平仓 R。
 * 同一根 K 线的重复候选(临时失败重试)只算最后一次。
 */
export function parityRows(events: readonly StrategyRunEvent[], limit = 6): ParityRow[] {
  const ev = [...events].sort((a, b) => a.at - b.at);
  const exits = new Map<string, number | null>();
  for (const e of ev) if (e.kind === 'exit' && typeof e.data?.['thread_id'] === 'string') exits.set(e.data['thread_id'] as string, typeof e.data['realized_r'] === 'number' ? (e.data['realized_r'] as number) : null);
  const rows = new Map<string, ParityRow>();
  for (let i = 0; i < ev.length; i++) {
    const c = ev[i]!;
    if (c.kind !== 'candidate' || !c.symbol) continue;
    const d = c.data ?? {};
    const asOf = typeof d['as_of'] === 'number' ? (d['as_of'] as number) : c.at;
    const row: ParityRow = {
      at: asOf, symbol: c.symbol, direction: typeof d['direction'] === 'string' ? (d['direction'] as string) : null,
      plan: { entry: str(d['entry_ref']), stop: str(d['stop']), target: str(d['target']), rr: typeof d['rr'] === 'number' ? (d['rr'] as number) : null },
      actual: 'waiting', reason: null, realized_r: null, closed: false,
    };
    for (let j = i + 1; j < ev.length; j++) {
      const n = ev[j]!;
      if (n.symbol !== c.symbol) continue;
      if (n.kind === 'candidate') break;
      if (n.kind === 'order_opened' || n.kind === 'order_pending' || n.kind === 'order_rejected' || n.kind === 'skip' || n.kind === 'agent_skip') {
        row.actual = n.kind === 'order_opened' ? 'opened' : n.kind === 'order_pending' ? 'pending' : n.kind === 'order_rejected' ? 'rejected' : 'skipped';
        row.reason = n.kind === 'order_opened' ? null : n.message;
        const tid = n.data?.['thread_id'];
        if (typeof tid === 'string' && exits.has(tid)) { row.closed = true; row.realized_r = exits.get(tid) ?? null; }
        break;
      }
    }
    rows.set(`${c.symbol}|${asOf}`, row);
  }
  return [...rows.values()].sort((a, b) => b.at - a.at).slice(0, limit);
}
const str = (v: unknown) => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null);

// ---------------------------------------------------------------- 第 5 步:上岗后各桌拿到的规则

export const DESK_TEXT: Record<string, string> = tmap({ radar: '雷达桌', thread_manager: '线程管家桌', risk_sentinel: '风控哨兵桌', portfolio_manager: '仓位管理桌', executor: '执行桌' });
export interface DeskRules { desk: string; slices: BindingRoleSlice[] }
/** binding.roles 按楼层桌分(DESK_SLICES);一张桌可能拿两片,没分到规则的桌也列出来(空) */
export function deskRules(roles: readonly BindingRoleSlice[]): DeskRules[] {
  return Object.entries(DESK_SLICES).map(([desk, rs]) => ({ desk, slices: rs.map((r) => roles.find((x) => x.role === r)).filter((x): x is BindingRoleSlice => !!x) }));
}

/** IR 里的 Jev 判断要素(StrategyIR.judge,v2 IR 才有):有 → 实盘里 Jev 把关;没有 → 影子判断只记录 */
export function judgeQuestions(ir: unknown): string[] | null {
  const j = (ir as { judge?: { questions?: { key?: string }[] } } | null | undefined)?.judge;
  if (!j) return null;
  return (j.questions ?? []).map((q) => q.key ?? '').filter(Boolean);
}
