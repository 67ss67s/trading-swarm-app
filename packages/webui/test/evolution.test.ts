/**
 * 进化方格纯逻辑:日期补齐 / 按月分组(周一起对齐)/ good 占比 / 颜色映射 / 键盘移动 / hash 解析,
 * 以及 /api/evolution/* 响应的防御式归一(状态写错落 none、缺字段不崩)。
 */
import { describe, expect, it } from 'vitest';
import type { EvoDay } from '../src/api/evolution';
import { adaptDaily, adaptDayDetail, adaptImproveJobs, normStatus } from '../src/api/evolution';
import { addDays, countStatuses, dateRange, fillDays, goodShare, groupByMonth, lastNDays, moveIndex, parseEvolutionHash, statusColor, weekdayMon0 } from '../src/components/evolution/grid-logic';

const day = (date: string, status: EvoDay['status'], headline: string | null = null): EvoDay => ({ date, status, score: null, headline });

describe('日期工具', () => {
  it('addDays 跨月跨年', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });
  it('dateRange 含两端,倒序为空', () => {
    expect(dateRange('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(dateRange('2026-10-02', '2026-10-01')).toEqual([]);
  });
  it('weekdayMon0:周一 = 0,周日 = 6', () => {
    expect(weekdayMon0('2026-09-21')).toBe(0); // 周一
    expect(weekdayMon0('2026-09-27')).toBe(6); // 周日
    expect(weekdayMon0('2026-09-01')).toBe(1); // 周二
  });
});

describe('补齐与最近 N 天', () => {
  it('fillDays 缺的日子补成灰格,保留已有数据', () => {
    const out = fillDays([day('2026-09-02', 'good', 'x')], '2026-09-01', '2026-09-03');
    expect(out.map((d) => d.status)).toEqual(['none', 'good', 'none']);
    expect(out[1]!.headline).toBe('x');
  });
  it('lastNDays 以 end 截止,长度 = n', () => {
    const out = lastNDays([day('2026-09-23', 'bad')], 30, '2026-09-23');
    expect(out).toHaveLength(30);
    expect(out[0]!.date).toBe('2026-08-25');
    expect(out[29]!.status).toBe('bad');
  });
  it('lastNDays 缺省 end 取数据里最晚一天', () => {
    const out = lastNDays([day('2026-09-10', 'ok'), day('2026-09-12', 'good')], 3);
    expect(out.map((d) => d.date)).toEqual(['2026-09-10', '2026-09-11', '2026-09-12']);
  });
});

describe('按月分组', () => {
  const seq = fillDays([day('2026-08-31', 'good'), day('2026-09-01', 'bad'), day('2026-09-02', 'good'), day('2026-09-03', 'ok')], '2026-08-30', '2026-09-05');
  const blocks = groupByMonth(seq);
  it('每月一块,首日按周一起补占位', () => {
    expect(blocks.map((b) => b.key)).toEqual(['2026-08', '2026-09']);
    // 2026-08-30 是周日 → 前面 6 个占位
    expect(blocks[0]!.cells.slice(0, 6).every((c) => c === null)).toBe(true);
    expect(blocks[0]!.cells[6]!.date).toBe('2026-08-30');
    // 2026-09-01 是周二 → 前面 1 个占位
    expect(blocks[1]!.cells[0]).toBeNull();
    expect(blocks[1]!.cells[1]!.date).toBe('2026-09-01');
    expect(blocks[1]!.year).toBe(2026);
    expect(blocks[1]!.month).toBe(9);
  });
  it('月计数与 good 占比只按已结算天算', () => {
    expect(blocks[0]!.counts).toEqual({ good: 1, ok: 0, bad: 0, none: 1 });
    expect(blocks[0]!.goodShare).toBe(1);
    expect(blocks[1]!.counts).toEqual({ good: 1, ok: 1, bad: 1, none: 2 });
    expect(blocks[1]!.goodShare).toBeCloseTo(1 / 3);
  });
  it('全灰月份 good 占比是 null 而不是 0', () => {
    expect(goodShare(countStatuses(fillDays([], '2026-07-01', '2026-07-31')))).toBeNull();
  });
  it('乱序输入也按日期升序排', () => {
    const b = groupByMonth([day('2026-09-03', 'ok'), day('2026-09-01', 'good')]);
    expect(b[0]!.cells.filter(Boolean).map((c) => c!.date)).toEqual(['2026-09-01', '2026-09-03']);
  });
});

describe('颜色映射', () => {
  it('四种状态各走自己的变量,并回退到主题 token', () => {
    expect(statusColor('good')).toContain('--evo-good');
    expect(statusColor('good')).toContain('--up');
    expect(statusColor('ok')).toContain('--warn');
    expect(statusColor('bad')).toContain('--down');
    expect(statusColor('none')).toContain('--evo-none');
  });
  it('未知状态落灰', () => {
    expect(statusColor('weird' as never)).toBe(statusColor('none'));
    expect(normStatus('GOOD')).toBe('none');
    expect(normStatus('ok')).toBe('ok');
  });
});

describe('键盘移动', () => {
  it('左右 ±1,上下 ±7,Home/End,越界夹住,无关键返回 null', () => {
    expect(moveIndex(5, 'ArrowLeft', 30)).toBe(4);
    expect(moveIndex(5, 'ArrowRight', 30)).toBe(6);
    expect(moveIndex(10, 'ArrowUp', 30)).toBe(3);
    expect(moveIndex(3, 'ArrowUp', 30)).toBe(0);
    expect(moveIndex(28, 'ArrowDown', 30)).toBe(29);
    expect(moveIndex(9, 'Home', 30)).toBe(0);
    expect(moveIndex(9, 'End', 30)).toBe(29);
    expect(moveIndex(9, 'Tab', 30)).toBeNull();
    expect(moveIndex(0, 'ArrowLeft', 0)).toBeNull();
  });
});

describe('hash 解析', () => {
  it('role / date / tab', () => {
    expect(parseEvolutionHash('#evolution?role=radar&date=2026-09-20')).toEqual({ tab: 'grid', role: 'radar', date: '2026-09-20' });
    expect(parseEvolutionHash('#evolution?tab=memory')).toEqual({ tab: 'memory', role: null, date: null });
    expect(parseEvolutionHash('#memory')).toEqual({ tab: 'memory', role: null, date: null });
    expect(parseEvolutionHash('#evolution?role=<x>&date=bad')).toEqual({ tab: 'grid', role: null, date: null });
  });
});

describe('接口归一', () => {
  it('adaptDaily:按契约取字段,坏行丢弃,缺 summary 时自己数', () => {
    const r = adaptDaily({
      version: 'evolution/v1',
      from: '2026-06-26',
      to: '2026-09-23',
      roles: [
        { role: 'thread_manager', label: '判断', metric_label: 'R', days: [{ date: '2026-09-23', status: 'good', score: 0.12, headline: 'h', events: 2 }, { date: 'bad-date', status: 'good' }], summary: { good: 3, ok: 1, bad: 0, none: 86, baseline_days: 4 } },
        { role: 'radar', days: [{ date: '2026-09-22', status: 'nope' }] },
        { label: '没有 role 的行' },
      ],
      today: { date: '2026-09-23', equity: '105449.56', judgments: { used: 300, cap: 300, cost_cny: 2.85, idle_share: 0.93 }, live_pool: { size: 0, reason: '没票' }, candidates: { open: 2, settled: 0 } },
    });
    expect(r.roles).toHaveLength(2);
    expect(r.roles[0]!.days).toEqual([{ date: '2026-09-23', status: 'good', score: 0.12, headline: 'h', events: 2 }]);
    expect(r.roles[0]!.summary.baseline_days).toBe(4);
    expect(r.roles[1]!.label).toBe('radar');
    expect(r.roles[1]!.days[0]!.status).toBe('none');
    expect(r.roles[1]!.summary).toEqual({ good: 0, ok: 0, bad: 0, none: 1, baseline_days: 0 });
    expect(r.today?.equity).toBe('105449.56');
    expect(r.today?.live_pool).toEqual({ size: 0, reason: '没票' });
    expect(r.today?.judgments?.idle_share).toBe(0.93);
  });
  it('adaptDaily:空对象 / null 不崩', () => {
    expect(adaptDaily(null)).toEqual({ version: '', from: '', to: '', roles: [], today: null });
  });
  it('adaptDayDetail:记录 / 事件 / 指标', () => {
    const d = adaptDayDetail({
      role: 'thread_manager', date: '2026-09-23', status: 'bad', score: '-0.3',
      baseline: { days: 4, mean: 0.01, note: '基线不足 5 天,按绝对线判' },
      metrics: [{ key: 'settled_r_model', label: '模型决定事后 R', value: 0.12, unit: 'R' }, 'junk'],
      records: [{ at: 1790150000000, kind: 'judgment', title: 'BTCUSDT scan → 不交易', ref: '#judgments?episode=e1' }, { at: 1, kind: 'x', title: 'no ref', ref: null }],
      events: [{ at: 1790150000000, kind: 'memory_proposed', title: 't', ref: null }],
    });
    expect(d.status).toBe('bad');
    expect(d.score).toBe(-0.3);
    expect(d.baseline?.note).toContain('基线不足');
    expect(d.metrics).toHaveLength(1);
    expect(d.records[0]!.ref).toBe('#judgments?episode=e1');
    expect(d.records[1]!.ref).toBeNull();
    expect(d.events[0]!.kind).toBe('memory_proposed');
  });
  it('adaptImproveJobs:取 finished_at 优先,summary 回退 message', () => {
    const j = adaptImproveJobs({ jobs: [{ id: 'imp_1', status: 'completed', label: 'EMA', strategy_id: null, created_at: 1, updated_at: 2, finished_at: 3, message: 'm', summary: null }, { nope: 1 }] });
    expect(j).toEqual([{ id: 'imp_1', status: 'completed', label: 'EMA', strategy_id: null, updated_at: 3, summary: 'm' }]);
  });
});
