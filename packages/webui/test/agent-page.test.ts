/**
 * 2026-09-25 Agent 页改版:意图一句话、执行通道、建议提问、工具动作映射、「今天」小结(components/agent/logic.ts)+ 英文词条齐全。
 */
import { describe, expect, it } from 'vitest';
import { channelOf, fmtCountdown, intentOf, suggestedPrompts, todaySummary, toolAction, type IntentInput } from '../src/components/agent/logic';
import { EN } from '../src/lib/i18n-en';

const sim = { kind: 'sim' as const, label: 'OKX 模拟盘' };

function intent(over: Partial<IntentInput> = {}): IntentInput {
  return { halted: false, paused: false, capped: false, strategy: { kind: 'free' }, watchCount: 4, timeframe: '15m', nextInMs: 151_000, channel: sim, ...over };
}

describe('channelOf', () => {
  it('分清模拟与实盘', () => {
    expect(channelOf({ backend: 'paper' }).kind).toBe('sim');
    expect(channelOf({ backend: 'demo' }).kind).toBe('sim');
    expect(channelOf({ backend: 'okx', exchange: 'okx', okx: { available: true, demo: true } })).toEqual({ kind: 'sim', label: 'OKX 模拟盘' });
    expect(channelOf({ backend: 'okx', exchange: 'okx', okx: { available: true, demo: false } })).toEqual({ kind: 'live', label: 'OKX 实盘' });
    expect(channelOf({ backend: 'okx', exchange: 'okx', okx: { available: false } }).kind).toBe('unknown');
    expect(channelOf({ backend: 'agent_mcp', exchange: 'binance' }).kind).toBe('live');
    expect(channelOf(null).kind).toBe('unknown');
  });
});

describe('intentOf', () => {
  it('自由判断:一句话里有盯几个币、倒计时、通道', () => {
    const i = intentOf(intent());
    expect(i.tone).toBe('ok');
    expect(i.title).toBe('自由判断中');
    expect(i.sentence).toContain('盯 4 个币(15m)');
    expect(i.sentence).toContain('下一次扫描 2:31 后');
    expect(i.sentence).toContain('单子下到OKX 模拟盘');
  });
  it('按策略运行:带名字版本与运行方式', () => {
    const i = intentOf(intent({ strategy: { kind: 'strategy', name: 'SOL 突破', version: 3, run_status: 'running', mode: 'confirm' } }));
    expect(i.title).toBe('按策略「SOL 突破 v3」运行');
    expect(i.sentence).toContain('每笔等你确认');
  });
  it('策略没在跑 → warn', () => {
    expect(intentOf(intent({ strategy: { kind: 'strategy', name: 'X', version: 1, run_status: 'error' } })).tone).toBe('warn');
  });
  it('停止 > 暂停 > 额度 的优先级', () => {
    expect(intentOf(intent({ halted: true, paused: true, capped: true })).tone).toBe('danger');
    expect(intentOf(intent({ paused: true, capped: true })).title).toBe('已暂停');
    expect(intentOf(intent({ capped: true })).title).toBe('今天的判断额度用完了');
  });
  it('没有倒计时也能成句', () => {
    expect(intentOf(intent({ nextInMs: null })).sentence).not.toContain('下一次扫描');
  });
  it('fmtCountdown', () => {
    expect(fmtCountdown(-5)).toBe('0:00');
    expect(fmtCountdown(65_000)).toBe('1:05');
    expect(fmtCountdown(2 * 3600_000 + 5 * 60_000)).toBe('2h05m');
  });
});

describe('suggestedPrompts', () => {
  it('五条,按策略研究流程排序', () => {
    const p = suggestedPrompts({ watchlist: ['BTCUSDT', 'SOLUSDT'] });
    expect(p.map((x) => x.id)).toEqual(['recommend', 'research', 'switch', 'why', 'review']);
    expect(p[0].text).toBe('推荐几个币,短中长线分别适合什么');
    expect(p[1].text).toBe('帮我研究 SOL 4h 适合什么策略');
    expect(p[3].text).toBe('今天为什么没开仓?');
  });
  it('观察列表里没有 SOL 时挑第一个非 BTC', () => {
    expect(suggestedPrompts({ watchlist: ['BTCUSDT', 'DOGE-USDT-SWAP'] })[1].text).toBe('帮我研究 DOGE 4h 适合什么策略');
    expect(suggestedPrompts({ watchlist: [] })[1].text).toContain('SOL');
  });
  it('已在跑策略时,第三条变成换一条', () => {
    expect(suggestedPrompts({ watchlist: [], strategy: { kind: 'strategy', name: 'A' } })[2].text).toContain('「A」');
  });
});

describe('toolAction', () => {
  it('已知工具映射成中文动作 + 参数摘要', () => {
    expect(toolAction({ name: 'recommend_assets', args: { symbols: ['SOLUSDT', 'DOGE'] }, ok: true })).toMatchObject({ verb: '推荐资产与周期', detail: 'SOL DOGE', group: 'research' });
    expect(toolAction({ name: 'set_agent_strategy', args: { kind: 'free' }, ok: true }).detail).toBe('回到自由判断');
    expect(toolAction({ name: 'propose_thread', args: { symbol: 'BTCUSDT', side: 'long' }, ok: true })).toMatchObject({ verb: '提议开仓', detail: 'BTCUSDT 做多', group: 'act' });
    expect(toolAction({ name: 'set_workflow', args: { patch: { timeframe: '1h', paused: true } }, ok: false })).toMatchObject({ detail: 'timeframe paused', ok: false });
    expect(toolAction({ name: 'start_matrix_study', args: { symbols: ['SOL'], timeframes: ['1h', '4h'] }, ok: true }).detail).toBe('SOL · 1h/4h');
    expect(toolAction({ name: 'get_state', args: {}, ok: true }).detail).toBeNull();
  });
  it('未知工具原样显示,不崩', () => {
    expect(toolAction({ name: 'mystery_tool', args: null, ok: true })).toMatchObject({ verb: 'mystery_tool', detail: null, raw: 'mystery_tool' });
  });
});

describe('todaySummary', () => {
  const start = 1_000_000;
  it('开仓按 id 去重,平仓只算今天,未结算单独计', () => {
    const s = todaySummary({
      now: start + 5_000,
      dayStart: start,
      openThreads: [
        { id: 'a', status: 'in_position', opened_at: start + 10, closed_at: null },
        { id: 'b', status: 'pending_entry', opened_at: null, closed_at: null },
        { id: 'c', status: 'in_position', opened_at: start - 10, closed_at: null },
      ],
      historyThreads: [
        { id: 'd', status: 'closed', opened_at: start + 1, closed_at: start + 2, pnl_num: 12.5, settled: true },
        { id: 'e', status: 'closed', opened_at: start - 100, closed_at: start + 3, pnl_num: -2.5 },
        { id: 'f', status: 'closed', opened_at: start - 100, closed_at: start + 4, pnl_num: 0, settled: false },
        { id: 'g', status: 'closed', opened_at: start - 100, closed_at: start - 1, pnl_num: 99 },
        { id: 'h', status: 'canceled', opened_at: null, closed_at: start + 5, pnl_num: 0 },
      ],
    });
    expect(s).toEqual({ opened: 2, closed: 3, realized: 10, unsettled: 1, holding: 2, pendingEntry: 1 });
  });
  it('没有历史时 realized 为 null', () => {
    expect(todaySummary({ now: start, dayStart: start, openThreads: [], historyThreads: null }).realized).toBeNull();
  });
});

describe('英文词条', () => {
  it('新文案都有英文', () => {
    const keys = [
      '自由判断中', '已暂停', '紧急停止中', '今天的判断额度用完了', '按策略「{name}」运行', '盯 {n} 个币', '下一次扫描 {t} 后', '单子下到{ch}',
      '推荐几个币', '推荐几个币,短中长线分别适合什么', '帮我研究 {sym} 4h 适合什么策略', '今天为什么没开仓?', '复盘最近的交易',
      '推荐资产与周期', '开始批量验证', '切换当前策略', '需要你处理', '今天', '开始清单', '批量验证', '我的策略', '复盘',
      '能看数据、能开研究、能切策略;下单要你确认', '立即扫描',
    ];
    for (const k of keys) expect(EN[k], k).toBeTruthy();
  });
});
