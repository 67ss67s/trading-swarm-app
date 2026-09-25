import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArtifactBody } from '../src/components/research-workbench/artifacts';
import { SessionChat } from '../src/components/research-workbench/session-chat';
import { artifactExport } from '../src/components/research-workbench/artifact-export';
vi.mock('@/components/markdown', () => ({ Markdown: ({ text }: { text: string }) => text }));
import { describeIssue, formatValue, nearestPoint, legacyRawPoints, readableRuleText } from '../src/components/research-workbench/presentation';
import { foldLive, normalizePlan, resolvedPlanSteps, stepKey } from '../src/components/research-workbench/session-state';
import type { ResearchArtifact, ResearchInquiry, ResearchInquiryEvent, ResearchPlan, ResearchStep } from '../src/api/research-types';

const plan: ResearchPlan = {
  task_kind: 'market',
  steps: [{ key: 'price', title: '读取价格', tool: 'get_bars', status: 'pending' }],
};
function step(inquiry = 'old', status: ResearchStep['status'] = 'succeeded'): ResearchStep {
  return { id: `${inquiry}:price`, inquiry_id: inquiry, seq: 0, title: '读取价格', tool: 'get_bars', status };
}
function inquiry(id = 'old'): ResearchInquiry {
  return { id, session_id: 'session', question: 'BTC', status: 'completed', task_kind: 'market', created_at: 1, updated_at: 100, plan, steps: [step(id)] };
}
function event(seq: number, data: ResearchInquiryEvent['data'], overrides: Partial<ResearchInquiryEvent> = {}): ResearchInquiryEvent {
  return { seq, data, inquiry_id: 'old', session_id: 'session', at: 101, event: 'step.completed', ...overrides };
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freezeDeep); }
  return value;
}

describe('historical and live research state', () => {
  it('normalizes the raw API plan, retaining tool arguments and defaulting pending status', () => {
    const raw = freezeDeep({ task_kind: 'market', plan: [{ key: 'price', tool: 'get_bars', title: '读取价格', args: { symbol: 'BTC' } }] });
    const normalized = normalizePlan(raw)!;
    expect(normalized.steps).toEqual([{ ...raw.plan[0], status: 'pending' }]);
    expect(normalized.steps[0]).not.toBe(raw.plan[0]);
    expect(raw.plan[0]).not.toHaveProperty('status');
  });
  it('supports message plans and a missing plan without changing input', () => {
    expect(normalizePlan(null)).toBeNull();
    expect(normalizePlan('invalid')).toBeNull();
    expect(normalizePlan(freezeDeep(plan))).toEqual(plan);
  });
  it('resolves historical database step IDs without requiring a key column', () => {
    expect(stepKey(step('old:with:colon'))).toBe('price');
    expect(resolvedPlanSteps(plan, [step('old', 'failed')])[0]?.status).toBe('failed');
    expect(resolvedPlanSteps(plan, [step('new', 'running')])[0]?.status).toBe('running');
  });
  it('retains pending steps that have no execution row', () => {
    expect(resolvedPlanSteps(plan, [])[0]).toMatchObject({ key: 'price', status: 'pending' });
  });
  it('folds a frozen historical snapshot without mutating the cached database objects', () => {
    const base = freezeDeep(inquiry());
    const before = JSON.stringify(base);
    const view = foldLive(base, []);
    expect(view.plan?.steps[0]?.status).toBe('succeeded');
    expect(view.steps[0]?.key).toBe('price');
    expect(base.steps?.[0]).not.toHaveProperty('key');
    expect(JSON.stringify(base)).toBe(before);
  });
  it('isolates inquiry events and ignores stale events before the snapshot', () => {
    const view = foldLive(inquiry(), [
      event(1, { key: 'price', status: 'running' }, { at: 99 }),
      event(2, { key: 'price', status: 'failed' }, { inquiry_id: 'new' }),
    ]);
    expect(view.steps).toHaveLength(1);
    expect(view.steps[0]?.status).toBe('succeeded');
  });
  it('orders replay events by sequence and matches both the database ID and logical key', () => {
    const events = freezeDeep([
      event(3, { key: 'price', status: 'failed', summary: { rows: 2 } }),
      event(2, { step_id: 'old:price', status: 'running' }),
    ]);
    const view = foldLive(inquiry(), events);
    expect(view.steps).toHaveLength(1);
    expect(view.plan?.steps[0]?.status).toBe('failed');
    expect(view.steps[0]?.output_summary).toEqual({ rows: 2 });
    expect(events.map((e) => e.seq)).toEqual([3, 2]);
  });
  it('normalizes a live API plan and de-duplicates artifact notifications', () => {
    const view = foldLive(null, [
      event(1, { task_kind: 'market', plan: [{ key: 'price', title: '价格', tool: 'get_bars' }] }, { event: 'inquiry.plan' }),
      event(2, { id: 'artifact-1' }, { event: 'artifact.created' }),
      event(3, { id: 'artifact-1' }, { event: 'artifact.created' }),
    ]);
    expect(view.plan?.steps[0]?.status).toBe('pending');
    expect(view.status).toBe('running');
    expect(view.artifactIds).toEqual(['artifact-1']);
  });
});

describe('financial value presentation', () => {
  it.each([null, undefined, ''])('shows missing value %s without inventing zero', (value) => {
    expect(formatValue(value, 'fraction')).toBe('—');
  });
  it('distinguishes fractional rates, percentage points, period and decimal strings', () => {
    expect(formatValue('0.0001', 'fraction_per_8h')).toBe('0.0100% / 8h');
    expect(formatValue(0.12, 'fraction')).toBe('12.00%');
    expect(formatValue(0.12, '%')).toBe('0.12%');
    expect(formatValue(-0.004, 'fraction')).toBe('-0.40%');
    expect(formatValue(0, 'fraction')).toBe('0.00%');
  });
  it('does not format invalid numbers as financial values', () => {
    expect(formatValue(NaN, 'USD')).toBe('—');
    expect(formatValue(Infinity, 'fraction')).toBe('—');
    expect(formatValue('insufficient', 'fraction')).toBe('insufficient');
  });
});

describe('tooltip lookup', () => {
  it('uses time instead of row index for unsorted, irregular and sparse series', () => {
    const dense: [number, number][] = [[100, 1], [200, 2], [300, 3]];
    const sparse: [number, number][] = [[500, 8], [110, 9]];
    expect(nearestPoint(dense, 205)).toEqual([200, 2]);
    expect(nearestPoint(sparse, 205)).toEqual([110, 9]);
  });
  it('retains a null observation and skips invalid timestamps', () => {
    const points: [number | string, number | null][] = [['invalid', 7], ['100', 1], [200, null], [300, 3]];
    expect(nearestPoint(points, 202)).toEqual([200, null]);
    expect(nearestPoint([], 202)).toBeUndefined();
  });
});

describe('error meaning', () => {
  it.each([
    ['compile_strategy', 'invalid_contract: unmapped_required entry', '未完成', '策略规则'],
    ['render_artifact', 'SCHEMA_MISMATCH:unknown_field', '未完成', '数据格式'],
    ['research', 'BUDGET_EXHAUSTED', '预算已用完', '没有完成'],
    ['run_backtest', 'dependency_failed:compile', '未执行', '前置步骤'],
    ['research', 'TIMEOUT', '暂未完成', '超时'],
    ['research', 'CANCELLED', '已取消', '已停止'],
  ])('distinguishes execution problem for %s: %s', (metric, note, label, message) => {
    expect(describeIssue(metric, 'missing', note)).toMatchObject({ label, technical: true });
    expect(describeIssue(metric, 'missing', note).message).toContain(message);
  });
  it('limits truncated liquidations to actual coverage', () => {
    expect(describeIssue('get_liquidations', 'partial', 'truncated_to_recent_100')).toMatchObject({ label: '部分覆盖', technical: false });
    expect(describeIssue('get_liquidations', 'partial', 'truncated_to_recent_100').message).toContain('不能代表整个研究窗口或全市场');
  });
  it('preserves data unavailability and not-applicable semantics separately from failures', () => {
    expect(describeIssue('funding_avg', 'not_applicable', '现货没有资金费')).toEqual({ label: '不适用', message: '现货没有资金费', technical: false });
    expect(describeIssue('oi_change', 'missing').label).toBe('数据暂缺');
    expect(describeIssue('close', 'stale').label).toBe('数据已过期');
  });
});


describe('rendered artifacts and historical messages', () => {
  it('draws distinct line segments around explicit missing observations without mutating evidence', () => {
    const artifact = freezeDeep({ id: 'a', chat_id: null, run_id: null, kind: 'chart' as const, title: 'Funding', created_at: 1, content: {
      kind: 'chart', type: 'line', x: 'time', y_label: 'fraction_per_8h',
      series: [{ name: 'rate', points: [[100, 0.0001], [200, 0.0002], [300, null], [400, 0.0003], [500, 0.0004]] }],
    } });
    const before = JSON.stringify(artifact);
    const html = renderToStaticMarkup(createElement(ArtifactBody, { artifact, height: 250 }));
    const path = html.match(/<path[^>]* d="([^"]+)"/)?.[1];
    expect(path).toBeDefined();
    expect(path?.match(/M/g)).toHaveLength(2);
    expect(path?.match(/L/g)).toHaveLength(2);
    expect(html).toContain('% / 8h');
    expect(html).not.toContain('NaN');
    expect(JSON.stringify(artifact)).toBe(before);
  });
  it('renders historical plan counts from their own inquiry even while the same key is running elsewhere', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const old = inquiry('old');
    const current = { ...inquiry('new'), status: 'running' as const, steps: [step('new', 'running')] };
    client.setQueryData(['research', 'session', 'session'], {
      session: { id: 'session', title: 'BTC', created_at: 1, updated_at: 100 }, inquiries: [old, current],
      messages: [old, current].map((q, i) => ({ id: `m${i}`, session_id: 'session', inquiry_id: q.id, role: 'assistant', seq: i, created_at: 1, blocks: [{ kind: 'plan', ...plan }] })),
    });
    const props = { sessionId: 'session', sessionsUnavailable: false, context: {}, onClearContext: () => {}, onEnsureSession: async () => 'session', onOpenArtifact: () => {}, onOpenRun: () => {}, onOpenHistory: () => {}, panelOpen: false, onShowPanel: () => {}, narrow: false };
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(SessionChat, props)));
    expect(html).toContain('1/1 步完成');
    expect(html).toContain('0/1 步完成');
    client.clear();
  });
});


describe('legacy chart recovery', () => {
  const series = { field: 'rate', transformed: true, points: [[100, 1], [200, 2]] as [number, number | null][] };
  it('ignores other snapshots, sorts observations and preserves explicit gaps without mutation', () => {
    const rows = freezeDeep([{ ts: 200, rate: '0.0002' }, { ts: 150, close: 12 }, { ts: 100, rate: '0.0001' }, { ts: 300, rate: null }]);
    expect(legacyRawPoints(series, rows)).toEqual([[100, 0.0001], [200, 0.0002], [300, null]]);
    expect(rows[0]?.ts).toBe(200);
  });
  it('does not recover from a truncated table that cannot cover all plotted observations', () => {
    expect(legacyRawPoints(series, [{ ts: 100, rate: 0.0001 }])).toBeNull();
    expect(legacyRawPoints(series, [{ ts: 100, rate: 0.0001 }, { ts: 200, close: 100 }])).toBeNull();
  });
  it('supports close_time and refuses untransformed or unidentified series', () => {
    expect(legacyRawPoints(series, [{ close_time: 100, rate: 0 }, { close_time: 200, rate: 'bad' }])).toEqual([[100, 0], [200, null]]);
    expect(legacyRawPoints({ ...series, transformed: false }, [])).toBeNull();
    expect(legacyRawPoints({ points: series.points, transformed: true }, [])).toBeNull();
  });
});


describe('sparse chart visibility and comparison units', () => {
  it('keeps a lone observed funding point visible while retaining the null gaps', () => {
    const artifact = { id: 'sparse', chat_id: null, run_id: null, kind: 'chart' as const, title: 'Funding', created_at: 1, content: {
      kind: 'chart', type: 'line', x: 'time', y_label: 'fraction_per_8h',
      series: [{ name: 'rate', points: [[100, null], [200, 0.0001], [300, null]] }],
    } };
    const html = renderToStaticMarkup(createElement(ArtifactBody, { artifact, height: 250 }));
    expect(html.match(/<circle /g)).toHaveLength(1);
    expect(html).not.toContain('NaN');
  });
  it('formats asset comparison fractions and insufficient metrics using their typed units', () => {
    const artifact = freezeDeep({ id: 'compare', chat_id: null, run_id: null, kind: 'table' as const, title: 'Compare', created_at: 1, content: {
      kind: 'table', columns: ['指标', '数值', '单位', '状态'], rows: [],
      analysis: { benchmark: 'okx:spot:BTC-USDT', rows: [{ canonical_id: 'okx:spot:ETH-USDT', return: { value: 0.125, unit: 'fraction' }, max_drawdown: { value: 0.034, unit: 'fraction' }, residual_sharpe: { value: null, unit: 'ratio' } }] },
    } });
    const html = renderToStaticMarkup(createElement(ArtifactBody, { artifact, height: 250 }));
    expect(html).toContain('ETH');
    expect(html).toContain('12.50%');
    expect(html).toContain('3.40%');
    expect(html).toContain('>—</td>');
  });
});


describe('complete and safe artifact exports', () => {
  const artifact = (content: ResearchArtifact['content'], kind: ResearchArtifact['kind'] = 'table'): ResearchArtifact => ({
    id: 'evidence-1', chat_id: null, run_id: 'run-1', kind, title: 'Saved evidence', created_at: 1,
    snapshot_refs: ['snapshot-1', 'snapshot-2'], content,
  });
  it('exports every saved table row beyond the UI display limit without mutating the artifact', () => {
    const a = freezeDeep(artifact({ columns: ['row', 'value'], rows: Array.from({ length: 503 }, (_, i) => [i, `value-${i}`]) }));
    const csv = artifactExport(a, 'csv');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split('\r\n')).toHaveLength(504);
    expect(csv).toContain('"500","value-500"');
    expect(csv).toMatch(/"502","value-502"$/);
    expect((a.content as { rows: unknown[][] }).rows).toHaveLength(503);
  });
  it('neutralizes formula-like strings including whitespace while preserving actual numeric negatives', () => {
    const a = artifact({ columns: ['=header', 'safe'], rows: [['=SUM(A1:A2)', '+42', '-42', '@SUM(A1)', ' \t=1', -42, 0, null]] });
    expect(artifactExport(a, 'csv')).toBe('\ufeff"\'=header","safe"\r\n"\'=SUM(A1:A2)","\'+42","\'-42","\'@SUM(A1)","\' \t=1","-42","0",""');
  });
  it('escapes commas, quotes, newlines and structured cells without losing content', () => {
    const a = artifact({ columns: ['text', 'object'], rows: [['a,"b"\nnext', { nested: ['a,b', '"quoted"'] }]] });
    const encodedObject = JSON.stringify({ nested: ['a,b', '"quoted"'] }).replace(/"/g, '""');
    expect(artifactExport(a, 'csv')).toBe(`\ufeff"text","object"\r\n"a,""b""\nnext","${encodedObject}"`);
  });
  it('rejects CSV for non-tabular evidence and supports the legacy spec body', () => {
    expect(() => artifactExport(artifact({ text: 'report' }, 'markdown'), 'csv')).toThrow('没有可导出的表格');
    const a = artifact(undefined); a.spec = { columns: ['value'], rows: [[1]] };
    expect(artifactExport(a, 'csv')).toBe('\ufeff"value"\r\n"1"');
  });
  it('exports the entire artifact envelope and nested evidence as JSON', () => {
    const a = freezeDeep({ ...artifact({ text: 'report', artifact_refs: [{ id: 'table-1', title: 'Evidence' }], run_ids: ['run-1'], steps: [{ status: 'failed', error_code: 'BUDGET_EXHAUSTED' }] }, 'markdown'), availability: 'partial' as const, caption: 'Saved partial evidence' });
    expect(JSON.parse(artifactExport(a, 'json'))).toEqual(a);
  });
  it('exports report text plus artifact, snapshot and run evidence indexes as Markdown', () => {
    const a = artifact({ view: 'research_report', text: '# Observation\n\nIncomplete evidence', artifact_refs: [{ id: 'table-1', title: 'Evidence' }], run_ids: ['run-1'] }, 'markdown');
    const md = artifactExport(a, 'md');
    for (const value of ['# Observation', 'Incomplete evidence', '## 证据索引', 'evidence-1', 'snapshot-1, snapshot-2', 'table-1', 'run-1']) expect(md).toContain(value);
    expect(md).not.toContain('[object Object]');
    expect(artifactExport({ ...artifact('Legacy report', 'markdown'), snapshot_refs: [] }, 'md')).toContain('未关联快照');
  });
});

describe('structured revision evidence rendering', () => {
  it('renders an object report with named evidence and truthful step outcomes', () => {
    const artifact = freezeDeep({ id: 'report', chat_id: null, run_id: null, kind: 'markdown' as const, title: 'Report', created_at: 1, content: {
      view: 'research_report', text: '# 本轮观察\n候选未完成', artifact_refs: [{ id: 'draft-1', title: '候选草稿' }],
      steps: [{ id: 's1', title: '规则检查', status: 'succeeded' }, { id: 's2', title: '历史回测', status: 'failed' }, { id: 's3', title: '对照', status: 'skipped' }],
    } });
    const html = renderToStaticMarkup(createElement(ArtifactBody, { artifact, height: 250 }));
    for (const value of ['候选未完成', '查看证据', '候选草稿', '已完成', '未完成', '未执行']) expect(html).toContain(value);
    expect(html).not.toContain('[object Object]');
  });
  it('renders an object draft with rules, changed fields and failed checks', () => {
    const artifact = freezeDeep({ id: 'draft', chat_id: null, run_id: null, kind: 'table' as const, title: 'Draft', created_at: 1, content: {
      view: 'strategy_draft', valid: false, summary: '保留原版', rules: [{ category: 'stop', text: '距离 2 ATR（atr_stop multiple=2）' }],
      notes: ['候选与本轮已有草稿重复'], unmapped: ['规则未映射'], checks: { ok: false, reason: 'missing_exit' },
      columns: ['改动项', '原版', '候选'], rows: [['risk.stop.params.multiple', '2', '3']],
    } });
    const html = renderToStaticMarkup(createElement(ArtifactBody, { artifact, height: 250 }));
    for (const value of ['规则检查未通过', '保留原版', '近期平均波动幅度', '草稿重复', '规则未映射', 'missing_exit', 'risk.stop.params.multiple']) expect(html).toContain(value);
    expect(html).not.toContain('[object Object]');
  });
  it('keeps primary rule wording readable without erasing unrelated prose', () => {
    expect(readableRuleText('止损设为 2 ATR（atr_stop multiple=2）')).toBe('止损设为 2 近期平均波动幅度');
    expect(readableRuleText('达到 3 R 退出（fixed_r_target r=3）')).toBe('达到 3 初始止损距离的倍数 退出');
    expect(readableRuleText('普通文字（这是说明）')).toBe('普通文字（这是说明）');
  });
});
