/**
 * 「策略研究」流程页(#strategy-research):流程简介与步骤切换、URL 状态、推荐卡勾选带入海选、海选默认不迭代、
 * 精修带入、验收状态条(通过 / 候补 / 前向笔数)、回测 vs 模拟盘对照、上岗分桌、导航变化、英文词条齐全。
 * 推荐夹具 = 18811 上 POST /api/recommendations 的真实返回裁剪(ZEC 高波动不适合、SNDK/XRP 适合);海选夹具复用 matrix-study-v2.fixture.json。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ResearchStrategy } from '@trade-gate/contracts';
import type { StrategyRun, StrategyRunEvent } from '../src/api/types';
import { unwrapMatrixStudyView } from '../src/api/matrix-study';
import { FlowIntro } from '../src/components/strategy-research/flow-intro';
import { StatusBar, runRequest } from '../src/components/strategy-research/step-validate';
import {
  STEPS, cardsByHorizon, deployReady, deskRules, defaultPicks, emptyReason, evidenceAge, finalState, flowHash, forwardRunOf, judgeQuestions,
  parityRows, parseFlowRoute, picksToScout, radarTierOf, savedSince, statusSegments, stepDone, studyIdOf, type RecLite,
} from '../src/components/strategy-research/model';
import { STRATEGY_RESEARCH_EN } from '../src/components/strategy-research/i18n-en';
import { MatrixStudyCreate, SCOUT_ITERATE, submitSpec } from '../src/components/matrix-study/create';
import { CellDrawer, MatrixStudyBody } from '../src/components/matrix-study/detail';
import { MatrixFlowContext, type MatrixFlow } from '../src/components/matrix-study/shared';
import { AGENT_QUICK_LINKS } from '../src/components/agent/quick-links';
import { toolAction, toolHref } from '../src/components/agent/logic';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { HIDDEN_PAGE_LABEL, NAV, pageLabel } from '../src/lib/nav';
import { EN } from '../src/lib/i18n-en';
import { normalizeSpec } from '../../gateway/src/demo/research/matrix-study/spec';

const wrap = (el: ReactElement) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TooltipProvider, null, el)));
const NOW = 1790349595146;
const H = 3_600_000;

const fit = (eligible: boolean, extra: Partial<RecLite['rows'][number]['horizons']['short']> = {}) => ({ eligible, reason: eligible ? null : 'regime', direction: eligible ? ('long' as const) : null, families: eligible ? ['breakout', 'ema_cross'] : [], evidence: ['24h 永续成交额 911.2M'], ...extra });
const rec: RecLite = {
  id: 'rec-muh3xkir63a015', as_of: NOW,
  source: { universe_scan_at: NOW - 15 * H, regime_at: NOW - 39 * H, radar_at: { short: NOW - 7 * H, mid: NOW - 68 * H, long: NOW - 20 * 24 * H } },
  warnings: [],
  rows: [
    { symbol: 'ZECUSDT', market: 'perp', quote_vol_24h: 1480535991.6, depth_usd_05: null, regime: 'volatile', scan: null, radar: { short: { rank: 1, fit: 1, reasons: [] } }, horizons: { short: fit(false), mid: fit(false), long: fit(false, { reason: 'history' }) } },
    { symbol: 'SNDKUSDT', market: 'perp', quote_vol_24h: 911188823.35, depth_usd_05: 2_100_000, regime: 'bull', scan: null, radar: { short: { rank: 2, fit: 1, reasons: [] }, mid: { rank: 1, fit: 1, reasons: [] } }, horizons: { short: fit(true), mid: fit(true, { families: ['breakout', 'ma_trend', 'ema_cross', 'pullback'] }), long: fit(false, { reason: 'history' }) } },
    { symbol: 'XRPUSDT', market: 'perp', quote_vol_24h: 729413385.24, depth_usd_05: null, regime: 'bull', scan: { rank: 4, score: 0.8, reasons: [] }, radar: { short: { rank: 3, fit: 1, reasons: [] }, mid: { rank: 5, fit: 0.86, reasons: [] }, long: { rank: 7, fit: 0.71, reasons: [] } }, horizons: { short: fit(true), mid: fit(true, { families: ['breakout', 'ma_trend'] }), long: fit(true, { families: ['ma_trend', 'pullback'] }) } },
  ],
};

describe('流程简介与步骤切换', () => {
  it('五步都在,当前步高亮,每步写「在做什么 → 产出什么」', () => {
    const route = parseFlowRoute('#strategy-research?step=scout&syms=SOLUSDT&tfs=4h');
    const html = wrap(createElement(FlowIntro, { route, go: () => undefined }));
    expect(STEPS).toEqual(['assets', 'scout', 'refine', 'validate', 'deploy']);
    for (const title of ['选资产', '海选', '精修', '验收', '上岗']) expect(html).toContain(title);
    expect(html.match(/data-step="/g)?.length).toBe(5);
    expect(html).toMatch(/aria-current="step"[^>]*data-step="scout"|data-step="scout"[^>]*aria-current="step"/);
    expect(html.match(/aria-current="step"/g)?.length).toBe(1);
    expect(html).toContain('几种打法一次全回测');
    expect(html).toContain('一张结果地图和候选');
    // 流程简介一句话,不写成技术说明
    expect(html).toContain('从推荐的币开始');
    expect(html).not.toMatch(/iterate|manifest|IR/);
  });
  it('做完的步打勾:选了资产 → 第 1 步完成;有 study → 海选完成;有 strategy → 精修完成', () => {
    const r = parseFlowRoute('#strategy-research?step=validate&syms=SOLUSDT&tfs=4h&study=ms_1&trial=mt_1&strategy=rs_1');
    expect(stepDone(r, 'assets')).toBe(true);
    expect(stepDone(r, 'scout')).toBe(true);
    expect(stepDone(r, 'refine')).toBe(true);
    expect(stepDone(r, 'validate')).toBe(false);
    expect(stepDone({ ...r, step: 'deploy' }, 'validate')).toBe(true);
    expect(stepDone(parseFlowRoute('#strategy-research'), 'assets')).toBe(false);
  });
});

describe('URL 状态', () => {
  it('round-trip:刷新后解析出同一份状态;空值不写', () => {
    const h = flowHash({ step: 'refine', rec: 'rec_1', syms: ['SOLUSDT', 'XRPUSDT'], tfs: ['15m', '4h'], fams: ['breakout'], sides: ['long'], mkt: 'perp', study: 'ms_x', trial: 'mt_y', strategy: 'rs_z', sref: null });
    expect(h).toBe('strategy-research?step=refine&rec=rec_1&syms=SOLUSDT%2CXRPUSDT&tfs=15m%2C4h&fams=breakout&sides=long&mkt=perp&study=ms_x&trial=mt_y&strategy=rs_z');
    const r = parseFlowRoute(`#${h}`);
    expect(r).toMatchObject({ step: 'refine', rec: 'rec_1', syms: ['SOLUSDT', 'XRPUSDT'], tfs: ['15m', '4h'], study: 'ms_x', trial: 'mt_y', strategy: 'rs_z', sref: null });
    expect(flowHash(r)).toBe(h);
  });
  it('坏值落缺省:未知 step → 选资产;非法周期 / 方向丢掉;资产最多 6 个', () => {
    const r = parseFlowRoute('#strategy-research?step=bogus&tfs=4h,2h&sides=long,up&syms=a,b,c,d,e,f,g&mkt=x');
    expect(r.step).toBe('assets');
    expect(r.tfs).toEqual(['4h']);
    expect(r.sides).toEqual(['long']);
    expect(r.syms).toHaveLength(6);
    expect(r.mkt).toBeNull();
  });
});

describe('第 1 步:推荐卡片墙 → 海选', () => {
  it('三列按档分,适合的在前(雷达名次优先),不适合的排后', () => {
    const by = cardsByHorizon(rec);
    expect(by.short.map((c) => [c.symbol, c.fit.eligible])).toEqual([['SNDKUSDT', true], ['XRPUSDT', true], ['ZECUSDT', false]]);
    expect(by.mid[0]!.symbol).toBe('SNDKUSDT');
    expect(by.long.filter((c) => c.fit.eligible).map((c) => c.symbol)).toEqual(['XRPUSDT']);
  });
  it('默认勾选每列前两张适合的;勾选 → 海选预填(币去重、周期按档、族取并集、只留海选支持的)', () => {
    const picks = defaultPicks(rec);
    expect(picks).toEqual(['SNDKUSDT|short', 'XRPUSDT|short', 'SNDKUSDT|mid', 'XRPUSDT|mid', 'XRPUSDT|long']);
    const p = picksToScout(rec, ['SNDKUSDT|mid', 'XRPUSDT|long']);
    expect(p).toEqual({ syms: ['SNDKUSDT', 'XRPUSDT'], tfs: ['4h', '1d'], fams: ['breakout', 'ma_trend', 'ema_cross', 'pullback'], sides: ['long'], mkt: 'perp' });
    // 不适合的卡即使在勾选里也不带
    expect(picksToScout(rec, ['ZECUSDT|short']).syms).toEqual([]);
    // 带进第 2 步的地址
    const h = flowHash({ step: 'scout', ...p });
    expect(parseFlowRoute(`#${h}`)).toMatchObject({ step: 'scout', syms: ['SNDKUSDT', 'XRPUSDT'], tfs: ['4h', '1d'], mkt: 'perp' });
  });
  it('海选表单拿到带入的币(只读胶囊)与周期,不展示迭代', () => {
    const p = picksToScout(rec, ['SNDKUSDT|mid', 'XRPUSDT|long']);
    const html = wrap(createElement(MatrixStudyCreate, { flow: true, from: null, preset: { symbols: p.syms, timeframes: p.tfs, families: p.fams, sides: p.sides, market: p.mkt } }));
    expect(html).toContain('新建海选');
    expect(html).toContain('data-testid="scout-symbols"');
    expect(html).toMatch(/SNDK<\/span>/);
    expect(html).toMatch(/XRP<\/span>/);
    expect(html).toContain('开始海选');
    expect(html).toContain('挑出候选');
    expect(html).not.toContain('自动诊断改进');
    expect(html).not.toContain('迭代');
  });
  it('证据时效:雷达档超过两倍刷新节奏标过期;推荐为空 / 失败给原因', () => {
    expect(evidenceAge(rec, 'short', NOW)).toMatchObject({ source: 'radar', stale: false });
    expect(evidenceAge(rec, 'long', NOW)).toMatchObject({ source: 'radar', stale: true });
    expect(emptyReason(null, 'HTTP 503')).toBe('推荐没拿到:HTTP 503');
    expect(emptyReason({ ...rec, rows: [], warnings: ['还没有每日全市场扫描'] }, null)).toBe('还没有每日全市场扫描');
    expect(emptyReason({ ...rec, rows: [rec.rows[0]!] }, null)).toContain('都不适合研究');
    expect(emptyReason(rec, null)).toBeNull();
  });
});

describe('第 2 步:海选默认不迭代', () => {
  it('提交规格固定 iterate.generations = 0;独立页不带(沿用后端缺省)', () => {
    const cur = { symbols: [], timeframes: ['4h' as const], families: ['breakout'], market: 'perp' as const, sides: ['long' as const], arms: ['code' as const], recommendation_id: null };
    expect(SCOUT_ITERATE).toEqual({ generations: 0 });
    expect(submitSpec(cur, ['SOLUSDT'], [], true).iterate).toEqual({ generations: 0 });
    expect(submitSpec(cur, ['SOLUSDT'], [], false).iterate).toBeUndefined();
  });
  it('后端 normalizeSpec 接受 generations = 0,其它迭代参数取缺省', () => {
    const cur = { symbols: ['SOLUSDT', 'XRPUSDT'], timeframes: ['4h'], families: ['breakout'], market: 'perp', sides: ['long'], arms: ['code'], recommendation_id: null };
    const spec = normalizeSpec(submitSpec(cur as never, cur.symbols, [], true), { now: NOW });
    expect(spec.iterate.generations).toBe(0);
    expect(spec.iterate.top_k).toBe(3);
  });
  it('流程模式的海选详情:没有分工说明;旧迭代记录折叠;抽屉里是「精修这一组」', () => {
    const study = unwrapMatrixStudyView(JSON.parse(readFileSync(new URL('./matrix-study-v2.fixture.json', import.meta.url), 'utf8')) as unknown);
    const calls: [string, string][] = [];
    const flow: MatrixFlow = { onRefine: (s, t) => calls.push([s, t]), onValidate: () => undefined, onBack: () => undefined };
    const body = wrap(createElement(MatrixFlowContext.Provider, { value: flow }, createElement(MatrixStudyBody, { s: study })));
    expect(body).not.toContain('批量验证是海选');
    if (study.state.generations.length) {
      expect(body).toContain('旧版迭代记录(历史研究)');
      expect(body).toContain('data-testid="legacy-iterations"');
    }
    const cand = study.manifest.cells.find((c) => study.state.cells[c.id]?.tier === 'paper_candidate')!;
    const drawer = wrap(createElement(MatrixFlowContext.Provider, { value: flow }, createElement(CellDrawer, { def: cand, r: study.state.cells[cand.id], s: study })));
    expect(drawer).toContain('精修这一组');
    expect(drawer).not.toContain('在研究台继续打磨');
    // 独立页不受影响
    const plain = wrap(createElement(CellDrawer, { def: cand, r: study.state.cells[cand.id], s: study }));
    expect(plain).toContain('在研究台继续打磨');
  });
});

describe('第 3 步:精修带入', () => {
  it('「精修这一组」→ step=refine 带上 study + trial', () => {
    const base = parseFlowRoute('#strategy-research?step=scout&syms=BTCUSDT&tfs=4h&study=ms_2257523047004ff6aa99');
    const next = parseFlowRoute(`#${flowHash({ ...base, step: 'refine', study: 'ms_2257523047004ff6aa99', trial: 'mt_5506b13c0769b74b9e4e95ac' })}`);
    expect(next).toMatchObject({ step: 'refine', study: 'ms_2257523047004ff6aa99', trial: 'mt_5506b13c0769b74b9e4e95ac', syms: ['BTCUSDT'] });
  });
  it('研究台主体可嵌入:embedded 时不读写地址栏;带入走 props', () => {
    const src = readFileSync(new URL('../src/pages/research.tsx', import.meta.url), 'utf8');
    expect(src).toContain('export function ResearchWorkbench(');
    expect(src).toMatch(/export function ResearchPage\(\) \{\s*return <ResearchWorkbench \/>;/);
    expect(src).toContain("const hashQuery = () => (embedded ? '' : window.location.hash.split('?')[1] ?? '');");
    // 所有改地址栏的地方都被 embedded 挡住
    for (const m of src.matchAll(/replaceState\(null, '', '#research'\)/g)) expect(src.slice(Math.max(0, m.index! - 40), m.index)).toMatch(/embedded/);
  });
  it('存进我的策略的检测:只认进这一步之后更新的、没归档的,取最近一条', () => {
    const since = 1000;
    const list = [
      { id: 'a', updated_at: 900, status: 'draft' }, { id: 'b', updated_at: 1500, status: 'draft' },
      { id: 'c', updated_at: 2000, status: 'archived' }, { id: 'd', updated_at: 1800, status: 'backtested' },
    ];
    expect(savedSince(list, since)?.id).toBe('d');
    expect(savedSince(list.slice(0, 1), since)).toBeNull();
  });
});

const strat = (over: Partial<ResearchStrategy> = {}): ResearchStrategy => ({
  id: 'rs_1', name: 'SOL 4h 突破', description: '', status: 'backtested', symbol: 'SOLUSDT', timeframe: '4h', watchlist: false, alerts: false, current_version: 2,
  created_at: 0, updated_at: 0, origin: { session_id: 's1', inquiry_id: null, source: 'research_loop' },
  summary: { total_return: 0.23, sharpe: 1.1, max_drawdown: 0.12, win_rate: 0.5, trades: 64, score: 70, score_label: 'good', sparkline: [], report_id: 'r1', backtested_at: 0 },
  lab_strategy_id: null, published_listing_id: null, ...over,
} as ResearchStrategy);
const run = (over: Partial<StrategyRun['stats']> = {}, extra: Partial<StrategyRun> = {}): StrategyRun => ({
  id: 'run_1', strategy_id: 'rs_1', strategy_name: 'x', version: 2, latest_version: 2, ir_hash: 'h', timeframe: '4h', mode: 'auto', market: 'perp', direction: 'long', leverage: 1,
  symbols: ['SOLUSDT'], risk_pct: 0.5, max_open: 3, publish_asp: false, status: 'running', error: null, execution: { backend: 'okx', profile: 'demo', label: 'OKX 模拟盘' },
  created_at: 0, updated_at: 10, last_scan_at: null, next_scan_at: null,
  stats: { scans: 3, candidates: 2, orders: 1, pending_approval: 0, skipped: 0, rejected: 0, open_threads: 1, closed: 3, realized_r: 1.2, published: 0, today_orders: 0, ...over }, ...extra,
});

describe('第 4 步:验收状态条', () => {
  it('批量验证 finalist 采用的 → 最终验收「通过」;前向显示笔数与 R;不到 10 笔「还差」', () => {
    const s = strat({ description: '[矩阵研究 ms_2257523047004ff6aa99 · horizon=mid(中线 4h) · breakout/long/code · 来源:内置] 留出段 5.0%' });
    expect(studyIdOf(s.description)).toBe('ms_2257523047004ff6aa99');
    const final = finalState(s);
    expect(final).toBe('passed');
    const segs = statusSegments(s, final, run());
    expect(segs.map((g) => g.key)).toEqual(['backtest', 'final', 'forward', 'gate']);
    expect(segs[0]).toMatchObject({ value: '+23.0% · 64 笔', tone: 'ok' });
    expect(segs[1]).toMatchObject({ value: '通过', tone: 'ok' });
    expect(segs[2]).toMatchObject({ title: '模拟盘前向', value: '已平 3 笔 · +1.20R', tone: 'ok' });
    expect(segs[3]).toMatchObject({ value: '还差 7 笔', tone: 'idle' });
    const html = wrap(createElement(StatusBar, { segs }));
    expect(html.match(/data-seg="/g)?.length).toBe(4);
    expect(html).toContain('建议:模拟盘满 10 笔且期望 &gt; 0(不硬拦)');
  });
  it('候补 → 「未经最终验收」;精修出来的也是未经;海选里没过的 → 未通过', () => {
    const cand = strat({ description: '[批量验证候补 ms_2257523047004ff6aa99 · 未经最终验收 · horizon=mid] 选择段 3%' });
    expect(finalState(cand)).toBe('candidate');
    expect(statusSegments(cand, 'candidate', null)[1]).toMatchObject({ value: '未经最终验收', note: '海选候补:先用模拟盘看前向', tone: 'warn' });
    expect(finalState(strat())).toBe('unvalidated');
    expect(statusSegments(strat(), 'unvalidated', null)[1]!.value).toBe('未经最终验收');
    const study = unwrapMatrixStudyView(JSON.parse(readFileSync(new URL('./matrix-study-v2.fixture.json', import.meta.url), 'utf8')) as unknown);
    const failed = { ...study, state: { ...study.state, finalists: [{ ...(study.state.finalists[0] ?? {}), id: 'f1', family: 'my:rs_1@v2', passed: false } as never] } };
    expect(finalState(strat(), failed)).toBe('failed');
  });
  it('前向:没跑 / 满 10 笔期望为正 = 达到建议线 / 满 10 笔期望为负', () => {
    expect(statusSegments(strat(), 'passed', null)[2]).toMatchObject({ value: '还没跑', tone: 'idle' });
    expect(deployReady(run({ closed: 10, realized_r: 2 }))).toBe(true);
    expect(statusSegments(strat(), 'passed', run({ closed: 12, realized_r: 2 }))[3]).toMatchObject({ value: '达到建议线', tone: 'ok' });
    expect(statusSegments(strat(), 'passed', run({ closed: 12, realized_r: -1 }))[3]).toMatchObject({ value: '期望还不为正', tone: 'warn' });
    expect(statusSegments(strat(), 'passed', run({ closed: 0, realized_r: null, open_threads: 0 }))[2]).toMatchObject({ value: '已平 0 笔 · —', tone: 'idle' });
    // 选运行:没停的优先,否则最近停掉的(成绩要能看到)
    expect(forwardRunOf([run({}, { id: 'old', status: 'stopped', updated_at: 99 }), run({}, { id: 'live', updated_at: 5 })], 'rs_1')?.id).toBe('live');
    expect(forwardRunOf([run({}, { id: 'old', status: 'stopped', updated_at: 99 })], 'rs_1')?.id).toBe('old');
  });
  it('「用模拟盘跑起来」:mode=auto,币池跟随与周期对应的雷达档;实盘带 LIVE', () => {
    const pf = { strategy_id: 'rs_1', version: 2, timeframe: '15m', deployable: true, blockers: [], warnings: [], watchlist: [], requires_live_confirm: false, execution: { backend: 'okx', profile: 'demo', label: 'OKX 模拟盘' }, asp: { identity: false, active: false, publisher_enabled: false }, existing_run: null, defaults: { mode: 'auto', market: 'perp', leverage: 1, symbols: ['SOLUSDT'], risk_pct: 0.5, max_open: 3, publish_asp: false } } as const;
    expect(runRequest('rs_1', pf as never, true, '')).toEqual({ strategy_id: 'rs_1', version: 2, mode: 'auto', market: 'perp', symbols: ['SOLUSDT'], risk_pct: 0.5, max_open: 3, publish_asp: false, symbols_source: { kind: 'radar', tier: 'short', top_n: 10 } });
    expect(runRequest('rs_1', pf as never, false, '')).not.toHaveProperty('symbols_source');
    expect(runRequest('rs_1', { ...pf, requires_live_confirm: true } as never, true, ' LIVE ')).toMatchObject({ confirm: 'LIVE' });
    expect([radarTierOf('15m'), radarTierOf('1h'), radarTierOf('4h'), radarTierOf('1d'), radarTierOf('5m')]).toEqual(['short', 'swing', 'swing', 'weekly', 'short']);
  });
  it('回测会怎么做 vs 模拟盘实际:候选配处理结果,重试只算一次,下单的配平仓 R', () => {
    const ev = (kind: StrategyRunEvent['kind'], at: number, data: Record<string, unknown> | null = null, message = '', symbol: string | null = 'DOGEUSDT'): StrategyRunEvent => ({ id: `${kind}${at}`, run_id: 'run_1', at, kind, symbol, message, data });
    const rows = parityRows([
      ev('candidate', 1, { entry_ref: '0.0942', stop: '0.0931', target: '0.0963', rr: 2, as_of: 100, direction: 'long' }),
      ev('order_rejected', 2, { thread_id: null }, '标记价不可用'),
      ev('candidate', 3, { entry_ref: '0.0957', stop: '0.0935', target: '0.1000', rr: 2, as_of: 200, direction: 'long' }),
      ev('skip', 4, { transient: true }, '临时失败,15 秒后重试'),
      ev('candidate', 5, { entry_ref: '0.0957', stop: '0.0935', target: '0.1000', rr: 2, as_of: 200, direction: 'long' }),
      ev('order_opened', 6, { thread_id: 'thr-1' }, '组合经理过闸,已交执行'),
      ev('exit', 7, { thread_id: 'thr-1', closed: true, realized_r: -0.1043 }, '已平仓'),
      ev('candidate', 8, { entry_ref: '0.0960', stop: '0.0940', target: '0.1000', rr: 2, as_of: 300, direction: 'long' }),
    ]);
    expect(rows.map((r) => [r.at, r.actual, r.realized_r])).toEqual([[300, 'waiting', null], [200, 'opened', -0.1043], [100, 'rejected', null]]);
    expect(rows[2]!.reason).toBe('标记价不可用');
    expect(rows[1]!.plan).toEqual({ entry: '0.0957', stop: '0.0935', target: '0.1000', rr: 2 });
    expect(parityRows([])).toEqual([]);
  });
});

describe('第 5 步:上岗', () => {
  it('binding.roles 按楼层桌分(DESK_SLICES),线程管家桌拿判断 + 持仓两片', () => {
    const slice = (role: string) => ({ role, title: role, summary: '', rules: [] }) as never;
    const desks = deskRules([slice('radar'), slice('judge'), slice('holding'), slice('risk'), slice('execution')]);
    expect(desks.map((d) => [d.desk, d.slices.length])).toEqual([['radar', 1], ['thread_manager', 2], ['risk_sentinel', 1], ['portfolio_manager', 1], ['executor', 1]]);
  });
  it('Jev:IR 带 judge → 把关;不带 → 影子', () => {
    expect(judgeQuestions({ judge: { questions: [{ key: 'take' }, { key: 'quality' }] } })).toEqual(['take', 'quality']);
    expect(judgeQuestions({ label: 'x' })).toBeNull();
    expect(judgeQuestions(null)).toBeNull();
  });
});

describe('导航与入口', () => {
  it('侧栏:「策略研究」一个入口,和我的策略同组放最前;研究台 / 批量验证不再单列,深链标题还在', () => {
    const pick = NAV.filter((n) => n.group === 'pick').map((n) => n.id);
    expect(pick[0]).toBe('strategy-research');
    expect(pick[1]).toBe('refine'); // 09-28:精修单独成页「优化」(#refine),紧跟策略研究
    expect(pick[2]).toBe('my-strategies');
    expect(pageLabel('refine')).toBe('优化');
    expect(EN['优化']).toBe('Refine');
    expect(NAV.some((n) => n.id === 'research' || n.id === 'matrix-study')).toBe(false);
    expect(pageLabel('strategy-research')).toBe('策略研究');
    expect(HIDDEN_PAGE_LABEL.research).toBe('研究台');
    expect(pageLabel('matrix-study')).toBe('批量验证');
    expect(EN['策略研究']).toBe('Strategy Research');
  });
  it('App 只加了路由注册', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain("import { StrategyResearchPage } from '@/pages/strategy-research';");
    expect(app).toContain("'strategy-research'");
    expect(app).toContain("{page === 'strategy-research' ? <StrategyResearchPage /> : null}");
  });
  it('入口都跳 #strategy-research 的对应步骤', () => {
    expect(AGENT_QUICK_LINKS.map((l) => l.href)).toContain('#strategy-research');
    expect(AGENT_QUICK_LINKS.map((l) => l.href)).not.toContain('#matrix-study');
    const card = readFileSync(new URL('../src/components/chat/recommendation-card.tsx', import.meta.url), 'utf8');
    expect(card).toContain('strategy-research?step=assets&rec=');
    const detail = readFileSync(new URL('../src/components/my-strategies/strategy-detail.tsx', import.meta.url), 'utf8');
    expect(detail).toContain('strategy-research?step=scout&sref=');
    expect(detail).toContain("t('用海选测这条')");
    const sw = readFileSync(new URL('../src/components/agent-strategy/current-strategy.tsx', import.meta.url), 'utf8');
    expect(sw).toContain('href="#strategy-research"');
    expect(toolHref('recommend_assets', {}, { recommendation_id: 'rec_1' })).toBe('#strategy-research?step=assets&rec=rec_1');
    expect(toolHref('start_matrix_study', { symbols: ['SOL'] }, { id: 'ms_1' })).toBe('#strategy-research?step=scout&study=ms_1');
    expect(toolHref('get_matrix_study', { id: 'ms_2' })).toBe('#strategy-research?step=scout&study=ms_2');
    expect(toolHref('adopt_matrix_finalist', {}, { strategy_id: 'rs_9', version: 1 })).toBe('#strategy-research?step=validate&strategy=rs_9');
    expect(toolAction({ name: 'start_matrix_study', args: {}, ok: true, result: { id: 'ms_1' } })).toMatchObject({ verb: '开始海选', href: '#strategy-research?step=scout&study=ms_1' });
    expect(toolAction({ name: 'get_state', args: {}, ok: true }).href).toBeNull();
  });
});

describe('英文', () => {
  it('流程页每条中文都有英文(t() 与 tmap 表)', () => {
    const dir = new URL('../src/components/strategy-research/', import.meta.url);
    const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && f !== 'i18n-en.ts').map((f) => readFileSync(new URL(f, dir), 'utf8'))
      .concat(['../src/pages/strategy-research.tsx'].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8')));
    const missing: string[] = [];
    for (const src of files) {
      for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) if (/[一-鿿]/.test(m[1]!) && !EN[m[1]!]) missing.push(m[1]!);
      for (const b of src.matchAll(/tmap\(\{([\s\S]*?)\}\)/g)) for (const m of b[1]!.matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)) if (/[一-鿿]/.test(m[1]!) && !EN[m[1]!]) missing.push(m[1]!);
    }
    expect(missing).toEqual([]);
    expect(STRATEGY_RESEARCH_EN['海选']).toBe('Scout');
    expect(STRATEGY_RESEARCH_EN['精修']).toBe('Refine');
    expect(STRATEGY_RESEARCH_EN['验收']).toBe('Validate');
    expect(STRATEGY_RESEARCH_EN['上岗']).toBe('Deploy');
    for (const k of ['开始海选', '查看海选进度', '开海选,跑完回报', '去策略研究', '用海选测这条', '精修这一组', '旧版迭代记录(历史研究)', '新建海选', '回到海选']) expect(EN[k], k).toBeTruthy();
  });
});
