/**
 * 09-25 批量验证(原「矩阵研究」)改版 + Agent 当前策略弹层:
 *   explain.ts 的白话映射、预计用时;switch-list.ts 的排序 / 来源 / 自动名;
 *   详情页用 18811 上真实研究 ms_bc80efa8e3c24301921b 的返回(裁掉 train / segments)整页渲染;
 *   新文案都有英文。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ResearchStrategy } from '@trade-gate/contracts';
import { unwrapMatrixStudyView, type MatrixEstimate, type MatrixStudyView } from '../src/api/matrix-study';
import { causePlain, durationRange, estimateWallMs, gatePlain, groupGenerations, judgeRows, mainCause, mapTone, nextSteps, parseDiagnosis, plainChange, topCells } from '../src/components/matrix-study/explain';
import { MatrixStudyBody } from '../src/components/matrix-study/detail';
import { displayName, isPlaceholderName, sortByQuality, strategySource } from '../src/components/agent-strategy/switch-list';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { EN } from '../src/lib/i18n-en';
import { NAV, HIDDEN_PAGE_LABEL } from '../src/lib/nav';

const raw = JSON.parse(readFileSync(new URL('./matrix-study-judge.fixture.json', import.meta.url), 'utf8')) as unknown;
const study = unwrapMatrixStudyView(raw);

describe('主因与下一步', () => {
  it('样本不足翻成人话并给建议', () => {
    expect(causePlain('insufficient_evidence')).toEqual({ title: '样本不足', detail: '这段历史里交易太少,不够下结论' });
    expect(nextSteps('insufficient_evidence').join()).toContain('换更短的周期');
    expect(mainCause({ insufficient_evidence: 18, unsupported_execution: 2, cost_dominated: 0, underperform_hold: 0 })).toBe('insufficient_evidence');
    expect(mainCause({ insufficient_evidence: 0 })).toBeNull();
  });
  it('门槛名翻白话', () => {
    expect(gatePlain('selection_trades>=30')).toBe('交易至少 30 笔');
    expect(gatePlain('max_drawdown<=0.35')).toBe('最大回撤不超过 35%');
    expect(gatePlain('beats_exposure_matched_hold')).toBe('跑赢同等仓位的持有');
    expect(gatePlain('unknown_gate')).toBe('unknown_gate');
  });
});

describe('迭代记录白话', () => {
  it('诊断码 → 中文短标题,原文保留', () => {
    const d = parseDiagnosis('stop_tight:77% 的交易被止损打出;exposure:在场时间 9%,空仓 91%;fees:手续费+滑点合计 980;sample:只有 21 笔平仓');
    expect(d.map((x) => x.title)).toEqual(['止损太紧', '在场时间太短', '手续费吃掉利润', '交易太少']);
    expect(d[1]!.text).toBe('在场时间 9%,空仓 91%');
    expect(parseDiagnosis('concentration:前 20%;worst_exit:亏损;trade_center:x;decay:y').map((x) => x.title)).toEqual(['利润集中在少数几笔', '某种离场方式亏得最多', '多数交易其实不赚', '前段赚钱、后段变差']);
  });
  it('改法去掉生成器前缀和 IR 路径', () => {
    expect(plainChange('diagnosis:止损过紧:止损出场占比高且合计亏损,ATR 倍数放宽 1.5 倍给正常波动留空间(risk.stop.params.multiple)'))
      .toEqual({ how: '按诊断改', text: '止损过紧:止损出场占比高且合计亏损,ATR 倍数放宽 1.5 倍给正常波动留空间' });
    const swap = plainChange('swap:仓位:加波动率目标 50%(每笔 100% 可用资金 × min(1, 目标/入场前 20 天实现波动);批量研究里它压回撤最明显)(risk.sizing)');
    expect(swap).toEqual({ how: '换一个部件', text: '仓位:加波动率目标 50%' });
    expect(plainChange('生成器没有产出新变体').how).toBeNull();
  });
  it('按格子分组,保持出现顺序', () => {
    const g = groupGenerations(study.state.generations);
    expect(g.map((x) => x.cell_id)).toEqual(['ETHUSDT|4h|mean_reversion|short|code', 'BTCUSDT|4h|mean_reversion|short|code', 'BTCUSDT|4h|my:rs_0b4164ef089b462288a8@v1|long|code']);
    expect(g[0]!.gens.map((x) => x.n)).toEqual([1, 2, 3]);
  });
});

describe('结果地图 / Jev 效果 / 和持有比(真实返回)', () => {
  it('格子上色档', () => {
    const na = study.manifest.cells.find((c) => c.applicability === 'not_applicable')!;
    expect(mapTone(na.applicability, study.state.cells[na.id])).toBe('na');
    const near = study.manifest.cells.find((c) => study.state.cells[c.id]?.verdict === 'near')!;
    expect(mapTone(near.applicability, study.state.cells[near.id])).toBe('near');
    expect(mapTone('applicable', undefined)).toBe('pending');
  });
  it('Jev 行:只取代码 + Jev 判断的格子;全部跳过的不可用', () => {
    const rows = judgeRows(study);
    expect(rows.length).toBe(10); // 2 资产 × (均值回归 多/空 + 均线金叉 多/空 + 我的策略 多)
    expect(rows.every((r) => r.cell.arm === 'code_judge')).toBe(true);
    expect(rows.filter((r) => !r.usable).map((r) => r.cell.id)).toEqual(['BTCUSDT|4h|ema_cross|short|code_judge', 'ETHUSDT|4h|ema_cross|short|code_judge']);
    expect(rows.find((r) => r.cell.id === 'BTCUSDT|4h|mean_reversion|long|code_judge')!.tone).toBe('flat'); // 区间跨 0
  });
  it('收益最高的几组按选择段收益排序,只要有成交的', () => {
    const top = topCells(study, 5);
    expect(top.length).toBe(5);
    for (let i = 1; i < top.length; i++) expect(top[i - 1]!.r.selection!.total_return).toBeGreaterThanOrEqual(top[i]!.r.selection!.total_return);
    expect(top.every((x) => x.r.selection!.trades > 0)).toBe(true);
  });
  it('整页渲染:结论只出现一次,有结果地图和 Jev 效果,技术 id 在折叠里', () => {
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TooltipProvider, null, createElement(MatrixStudyBody, { s: study }))));
    expect(html.match(/这次没有找到能用的策略/g)?.length).toBe(1);
    // 后端结论原文只在「系统原话」折叠里出现一次(之前进度条和结论卡各一遍)
    expect(html.split(study.state.conclusion!.text).length - 1).toBe(1);
    expect(html).toContain('样本不足');
    expect(html).toContain('下一步可以试试');
    expect(html).toContain('结果地图');
    expect(html).toContain('Jev 判断的效果');
    expect(html).toContain('收益最高的几组');
    expect(html).toContain('自动诊断改进的过程');
    expect(html).toContain('在场时间太短');
    // mt_ 开头的试验 id 只出现在 <details> 折叠里
    const outside = html.replace(/<details[\s\S]*?<\/details>/g, '');
    expect(outside).not.toMatch(/mt_[0-9a-f]{6}/);
  });
  it('没有 Jev 组的研究不显示 Jev 效果', () => {
    const noJudge: MatrixStudyView = { ...study, manifest: { ...study.manifest, spec: { ...study.manifest.spec, arms: ['code'] }, cells: study.manifest.cells.filter((c) => c.arm === 'code') } };
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TooltipProvider, null, createElement(MatrixStudyBody, { s: noJudge }))));
    expect(html).not.toContain('Jev 判断的效果');
  });
});

describe('预计用时', () => {
  const est = { cells: { total: 10, applicable: 10, not_applicable: 0, research_only: 0 }, matrix_trials: 100, iteration_trials_max: 50, variants: 100, judge_calls: 1000, judge_usd: '0.02', data: { series: 2, bars: 1000, cold_fetch_ms_upper: 60_000 }, within_budget: true, warnings: [] } as MatrixEstimate;
  const hist = (wall: number, trials: number, calls: number) => ({ status: 'completed', state: { usage: { wall_ms: wall, judge_calls: calls } }, ledger: { trial_count: trials } }) as unknown as MatrixStudyView;
  it('按最近研究的速度估,没有历史返回 null', () => {
    expect(estimateWallMs(est, [])).toBeNull();
    const w = estimateWallMs(est, [hist(100_000, 200, 0), hist(700_000, 100, 1000)])!;
    // 每次试验 0.5s、每次判断 (700 - 50)/1000 = 0.65s → 下限 50 + 650 = 700s
    expect(Math.round(w.low / 1000)).toBe(700);
    expect(w.high).toBeGreaterThan(w.low);
  });
  it('说人话', () => {
    expect(durationRange(10_000, 30_000)).toBe('不到 1 分钟');
    expect(durationRange(120_000, 150_000)).toBe('大约 2–3 分钟');
    expect(durationRange(180_000, 180_000)).toBe('大约 3 分钟');
  });
});

describe('Agent 当前策略弹层列表', () => {
  const rs = (over: Partial<ResearchStrategy>) => ({ id: 'x', name: 'n', description: '', status: 'backtested', symbol: 'BTCUSDT', timeframe: '1h', watchlist: false, alerts: false, current_version: 1, created_at: 0, updated_at: 0, origin: { session_id: null, inquiry_id: null, source: 'manual' }, summary: null, lab_strategy_id: null, published_listing_id: null, ...over }) as ResearchStrategy;
  const sum = (score_label: string | null) => ({ total_return: null, sharpe: null, max_drawdown: null, win_rate: null, trades: null, score: null, score_label, sparkline: [], report_id: null, backtested_at: null }) as ResearchStrategy['summary'];
  it('按 good > fair > poor 排,没评分垫底,同档保持原顺序', () => {
    const list = [rs({ id: 'p', summary: sum('poor') }), rs({ id: 'none' }), rs({ id: 'f1', summary: sum('fair') }), rs({ id: 'g', summary: sum('good') }), rs({ id: 'f2', summary: sum('fair') }), rs({ id: 'e', summary: sum('excellent') })];
    expect(sortByQuality(list).map((s) => s.id)).toEqual(['e', 'g', 'f1', 'f2', 'p', 'none']);
  });
  it('来源:内置 / 批量验证 / 研究台;判断不了不标', () => {
    expect(strategySource(rs({ origin: { session_id: null, inquiry_id: null, source: 'import' } }))).toBe('builtin');
    expect(strategySource(rs({ description: '[矩阵研究 ms_1 · horizon=mid(中线 4h) · breakout/long/code · 来源:手动研究] 留出段 3.0%' }))).toBe('matrix');
    expect(strategySource(rs({ origin: { session_id: 's', inquiry_id: 'i', source: 'research_loop' } }))).toBe('research');
    expect(strategySource(rs({}))).toBeNull();
  });
  it('占位名换成「资产 · 周期 · 策略族」', () => {
    expect(isPlaceholderName('未指定策略')).toBe(true);
    expect(isPlaceholderName('  ')).toBe(true);
    expect(displayName(rs({ name: '未指定策略', symbol: 'SOLUSDT', timeframe: '15m' }))).toBe('SOL · 15m');
    expect(displayName(rs({ name: '', symbol: 'ETHUSDT', timeframe: '4h', description: '[矩阵研究 ms_1 · horizon=mid(中线 4h) · breakout/long/code · 来源:x]' }))).toBe('ETH · 4h · 突破');
    expect(displayName(rs({ name: 'EMA 金叉' }))).toBe('EMA 金叉');
  });
});

describe('改名与导航', () => {
  it('对用户叫「批量验证」,路由不变;实盘部署台不在导航里', () => {
    // 09-25 晚:批量验证并进「策略研究」流程页,侧栏不再单列;#matrix-study 深链的顶栏标题仍叫「批量验证」
    expect(NAV.some((n) => n.id === 'matrix-study')).toBe(false);
    expect(HIDDEN_PAGE_LABEL['matrix-study']).toBe('批量验证');
    expect(EN['批量验证']).toBe('Batch Validation');
    expect(NAV.some((n) => n.id === 'strategies')).toBe(false);
  });
  it('本次改动的文件里,中文文案都有英文', () => {
    const files = ['create.tsx', 'detail.tsx', 'explain.ts', 'shared.tsx', 'list.tsx'].map((f) => `../src/components/matrix-study/${f}`)
      .concat(['../src/components/agent-strategy/current-strategy.tsx', '../src/components/agent-strategy/switch-list.ts', '../src/components/my-strategies/deploy-panel.tsx']);
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) if (/[一-鿿]/.test(m[1]!) && !EN[m[1]!]) missing.push(m[1]!);
    }
    expect(missing).toEqual([]);
  });
});
