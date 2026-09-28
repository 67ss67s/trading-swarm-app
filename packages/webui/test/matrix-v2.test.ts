/**
 * 批量验证 v2:三档渲染、notes 去重 / 过程事件进技术信息、结论按三档改写、抽屉(评分卡 / 运气折扣 / 存为候补 / 去研究台)、候补来源标签。
 * 夹具 = 18811 上真实研究 ms_2257523047004ff6aa99,用 v2 后端读视图重算后的返回(只读拷库重算,裁掉 train / segments)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ResearchStrategy } from '@trade-gate/contracts';
import { unwrapMatrixStudyView, type MatrixStudyView } from '../src/api/matrix-study';
import { canAdoptCandidate, conclusionHead, mapTone, researchLink, splitNotes } from '../src/components/matrix-study/explain';
import { CellDrawer, MatrixStudyBody } from '../src/components/matrix-study/detail';
import { SOURCE_TEXT, displayName, strategySource } from '../src/components/agent-strategy/switch-list';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { EN } from '../src/lib/i18n-en';

const study = unwrapMatrixStudyView(JSON.parse(readFileSync(new URL('./matrix-study-v2.fixture.json', import.meta.url), 'utf8')) as unknown);
const wrap = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TooltipProvider, null, el)));

describe('三档', () => {
  it('格子按三档上色;旧后端(没有 tier)仍按 v1', () => {
    const cand = study.manifest.cells.find((c) => study.state.cells[c.id]?.tier === 'paper_candidate')!;
    const fail = study.manifest.cells.find((c) => study.state.cells[c.id]?.tier === 'fail')!;
    expect(mapTone(cand.applicability, study.state.cells[cand.id])).toBe('candidate');
    expect(mapTone(fail.applicability, study.state.cells[fail.id])).toBe('fail');
    expect(mapTone('applicable', { ...study.state.cells[cand.id]!, tier: 'pending' })).toBe('waiting');
    expect(mapTone('applicable', { ...study.state.cells[cand.id]!, tier: 'pass' })).toBe('pass');
    const { tier: _t, ...v1 } = study.state.cells[cand.id]!;
    expect(mapTone('applicable', v1)).toBe('near');
  });
  it('整页:三档图例、候补格子数与结论一致,结论按三档说', () => {
    const html = wrap(createElement(MatrixStudyBody, { s: study }));
    const n = study.state.conclusion!.paper_candidates!;
    expect(n).toBe(35);
    expect(html.match(/data-tone="candidate"/g)?.length).toBe(n);
    expect(html).toContain('候补 · 可纸面观察');
    expect(html).toContain('等最终验收');
    expect(html).toContain(`没有能直接上实盘的,但有 ${n} 组值得先用模拟盘看看`);
    expect(html).not.toContain('这次没有找到能用的策略');
    expect(html).toContain('批量验证是海选');
  });
  it('没有候补时仍是「这次没有找到能用的策略」;有通过时说通过', () => {
    const c = study.state.conclusion!;
    expect(conclusionHead({ ...c, paper_candidates: 0 }).title).toBe('这次没有找到能用的策略');
    expect(conclusionHead({ ...c, paper_candidates: undefined }).title).toBe('这次没有找到能用的策略');
    expect(conclusionHead({ ...c, kind: 'passed', finalist_ids: ['a'], paper_candidates: 2 })).toMatchObject({ tone: 'pass', title: '找到 1 条通过最终验收的策略' });
  });
});

describe('notes 去重,过程事件进技术信息', () => {
  it('splitNotes', () => {
    const r = splitNotes(study.state.notes);
    expect(r.notes).toEqual(['4h:资产池只有 3 个资产,少于设计要求的 4 个,结论只作观察', '1d:资产池只有 3 个资产,少于设计要求的 4 个,结论只作观察']);
    expect(r.tech).toEqual(['进程重启,研究中断;可 resume 从断点继续(已完成的评估不重跑、计数不清零)', 'resume → queued']);
  });
  it('整页:资产池提示只出现一次,resume → queued 只在折叠里', () => {
    const html = wrap(createElement(MatrixStudyBody, { s: study }));
    expect(html.split('4h:资产池只有 3 个资产').length - 1).toBe(1);
    const outside = html.replace(/<details[\s\S]*?<\/details>/g, '');
    expect(outside).not.toContain('resume → queued');
    expect(html).toContain('resume → queued');
  });
});

describe('抽屉', () => {
  const cand = study.manifest.cells.find((c) => study.state.cells[c.id]?.tier === 'paper_candidate')!;
  const r = study.state.cells[cand.id]!;
  it('候补格:指标表、运气折扣、存为候补策略、在研究台继续打磨', () => {
    expect(canAdoptCandidate(study, r)).toBe(true);
    const html = wrap(createElement(CellDrawer, { def: cand, r, s: study }));
    for (const k of ['选择段收益', '同等仓位持有', '最大回撤', '夏普', '胜率', '交易笔数', '盈亏比', '手续费占毛收益', '运气折扣', '存为候补策略', '在研究台继续打磨']) expect(html).toContain(k);
    expect(html).toContain(r.scorecard!.luck.text);
    expect(html).toContain(`>${r.scorecard!.score.value}<`);
    expect(html).toContain(researchLink(study.id, r.tier_trial_id!).replace(/&/g, '&amp;'));
  });
  it('已存过的候补显示「去我的策略里用模拟盘跑起来」链接;未通过格不给存', () => {
    const saved: MatrixStudyView = { ...study, candidate_adoptions: { [r.tier_trial_id!]: { strategy_id: 'rs_x', version: 3 } } };
    const html = wrap(createElement(CellDrawer, { def: cand, r, s: saved }));
    expect(html).toContain('已存为候补策略 v3');
    expect(html).toContain('#my-strategies?id=rs_x');
    expect(html).not.toContain('>存为候补策略<');
    const fail = study.manifest.cells.find((c) => study.state.cells[c.id]?.tier === 'fail' && study.state.cells[c.id]?.verdict === 'fail')!;
    expect(canAdoptCandidate(study, study.state.cells[fail.id])).toBe(false);
    expect(wrap(createElement(CellDrawer, { def: fail, r: study.state.cells[fail.id], s: study }))).not.toContain('存为候补策略');
    expect(canAdoptCandidate({ status: 'running' }, r)).toBe(false);
  });
});

describe('候补策略的来源标签与英文', () => {
  const rs = (description: string) => ({ id: 'x', name: '', description, status: 'draft', symbol: 'BTCUSDT', timeframe: '4h', watchlist: false, alerts: false, current_version: 1, created_at: 0, updated_at: 0, origin: { session_id: null, inquiry_id: null, source: 'manual' }, summary: null, lab_strategy_id: null, published_listing_id: null }) as ResearchStrategy;
  it('「[批量验证候补 …」→ 批量验证 · 候补;finalist 的「[矩阵研究 …」不变', () => {
    const d = '[批量验证候补 ms_1 · 未经最终验收 · horizon=mid(中线 4h) · breakout/short/code · 来源:手动研究] 选择段 6.8%';
    expect(strategySource(rs(d))).toBe('matrix_candidate');
    expect(SOURCE_TEXT.matrix_candidate).toBe('批量验证 · 候补');
    expect(displayName(rs(d))).toBe('BTC · 4h · 突破');
    expect(strategySource(rs('[矩阵研究 ms_1 · horizon=mid(中线 4h) · breakout/long/code · 来源:x]'))).toBe('matrix');
  });
  it('新文案都有英文', () => {
    const files = ['../src/components/matrix-study/detail.tsx', '../src/components/matrix-study/explain.ts', '../src/components/matrix-study/shared.tsx', '../src/components/agent-strategy/switch-list.ts'];
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) if (/[一-鿿]/.test(m[1]!) && !EN[m[1]!]) missing.push(m[1]!);
    }
    for (const k of ['候补 · 可纸面观察', '等最终验收', '批量验证 · 候补', '优秀', '良好', '一般', '待改进', '差']) if (!EN[k]) missing.push(k);
    expect(missing).toEqual([]);
  });
});
