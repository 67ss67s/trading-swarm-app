// §9.47 StrategyBinding 编译:六个角色切片、几何规则与订单门现行口径一致、模型只做入场过滤、unmapped 不静默丢。
import { describe, expect, it } from 'vitest';
import { validate, type StrategyBinding, type StrategyIR } from '@trading-swarm/contracts';
import { compileBinding } from '../../../../src/demo/research/strategies/compile-binding.js';
import { BUILTIN_IMPORTS, builtinImportSpec } from '../../../../src/demo/research/strategies/import-builtin.js';
import { DEFAULT_ORDER_GATE } from '../../../../src/demo/research/order-gate.js';
import { defaultIR } from './fixtures.js';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const irOf = (id: string) => clone(builtinImportSpec(id)!.ir!);
const compile = (ir: StrategyIR, timeframe = '1h', over: Partial<Parameters<typeof compileBinding>[0]> = {}) => compileBinding({ strategy_id: 'rs_test', version: 1, ir, timeframe, symbol: 'BTCUSDT', now: 1_000, ...over });
const slice = (b: StrategyBinding, role: string) => b.roles.find((r) => r.role === role)!;
const codes = (b: StrategyBinding) => b.unmapped.map((u) => u.code);
const minStopAtr = (DEFAULT_ORDER_GATE as { min_stop_atr?: number | null }).min_stop_atr ?? null;

describe('compileBinding(§9.47)', () => {
  it('突破-回踩译文:六片按序、契约合格、哈希只随内容变', () => {
    const b = compile(irOf('breakout_retest'));
    expect(validate('research-binding', { strategy_id: 'rs_test', version: 1, lab_strategy_id: null, binding: b, unmapped: b.unmapped })).toEqual({ ok: true });
    expect(b.roles.map((r) => r.role)).toEqual(['radar', 'judge', 'geometry', 'risk', 'holding', 'execution']);
    expect(b.horizon).toBe('intraday');
    expect(b.confirm_timeframe).toBe('4h');
    expect(b.trigger.primitives.map((p) => p.primitive)).toEqual(['donchian_breakout', 'volume_surge', 'indicator_cross']);
    expect(b.trigger.regime?.primitive).toBe('htf_structure_regime');
    expect(slice(b, 'radar').rules.filter((r) => r.ref?.startsWith('signal[')).length).toBe(3);
    // 编译时间不进哈希;同 IR 同哈希,改一个参数哈希变
    expect(compile(irOf('breakout_retest'), '1h', { now: 9_999 }).content_hash).toBe(b.content_hash);
    const other = irOf('breakout_retest');
    other.signal[1]!.params.multiple = 3;
    expect(compile(other).content_hash).not.toBe(b.content_hash);
  });

  it('几何:止损=失效线、止损太近不做的倍数取订单门缺省、止盈只取图上价位、盈亏比只展示', () => {
    const b = compile(irOf('breakout_retest'));
    expect(b.stop.primitive.primitive).toBe('pivot_stop');
    expect(b.stop.is_invalidation).toBe(true);
    expect(b.stop.buffer_atr).toBe(0.1);
    expect(b.stop.min_stop_atr).toBe(minStopAtr);
    expect(b.libs.order_gate).toBe(minStopAtr === null ? 'legacy' : 'structure');
    if (minStopAtr !== null) {
      expect(slice(b, 'geometry').rules.some((r) => r.text.includes(`${minStopAtr}×ATR(14)`) && r.text.includes('不做'))).toBe(true);
      expect(b.targets).toEqual([{ source: { primitive: 'pivot_target', params: { swing_length: 3 } }, size_pct: 1, kind: 'chart' }]);
      expect(b.target_policy).toBe('chart');
      expect(slice(b, 'geometry').rules.some((r) => r.text.includes('算不出就不设止盈'))).toBe(true);
      expect(b.min_rr).toBeNull();
      expect(b.evidence_plan.indicators.some((x) => x.id === 'atr(period=14)@1h')).toBe(true);
    }
  });

  it('用户硬约束盈亏比 / 指标止盈 / 信号离场三种止盈口径', () => {
    const rr = irOf('breakout_retest');
    rr.order!.min_rr = 2;
    const b1 = compile(rr);
    expect(b1.min_rr).toBe(2);
    expect(slice(b1, 'geometry').rules.some((r) => r.ref === 'order.min_rr' && r.text.includes('≥ 2'))).toBe(true);
    const mr = compile(irOf('range_mean_reversion'));
    expect(mr.targets).toEqual([{ source: { primitive: 'indicator_level', params: { indicator: 'ema', args: { period: 20 } } }, size_pct: 1, kind: 'indicator' }]);
    expect(mr.max_holding_bars).toBe(24);
    if (minStopAtr !== null) {
      const vol = compile(irOf('vol_compression_expansion'));
      expect(vol.targets).toEqual([]);
      expect(vol.target_policy).toBe('signal_exit');
      expect(vol.signal_exits.map((x) => x.primitive)).toEqual(['indicator_cross_exit']);
      expect(vol.trail?.primitive).toBe('chandelier_trail');
    }
  });

  it('模型只做入场过滤:只有 judge 片里有 model 规则,持仓期不叫模型,不能改价位', () => {
    for (const spec of BUILTIN_IMPORTS.filter((x) => x.ir)) {
      const b = compile(clone(spec.ir!), spec.timeframe);
      expect(b.model).toMatchObject({ entry_filter: 'on', exit_discretion: 'off' });
      expect(b.model.forbidden).toEqual(expect.arrayContaining(['改止损', '改止盈', '改入场价']));
      for (const r of b.roles) for (const x of r.rules) if (x.executor === 'model') expect(r.role, `${spec.builtin_id}:${x.text}`).toBe('judge');
      expect(slice(b, 'judge').rules.filter((x) => x.executor === 'model')).toHaveLength(1);
      expect(slice(b, 'holding').rules.some((x) => x.text.includes('模型不管仓'))).toBe(true);
    }
  });

  it('证据由 IR 原语推导并去重(不手填)', () => {
    const b = compile(irOf('mtf_alignment'), '15m');
    const ids = b.evidence_plan.indicators.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining(['donchian(period=20)@15m', 'ema(period=20)@15m', 'ema(period=50)@15m', 'adx(period=14)@1h', 'ema(period=20)@1h', 'ema(period=50)@1h']));
    expect(new Set(ids).size).toBe(ids.length);
    expect(b.evidence_plan.structure).toEqual(expect.arrayContaining(['swing_pivots', 'htf_trend@1h']));
    expect(b.confirm_timeframe).toBe('4h');
  });

  it('实盘不支持的不近似:做空 / 超杠杆 / scalp / Pine / 不设止损 / 筛选池 → block,不能下发', () => {
    const short = irOf('breakout_retest');
    short.order = { ...short.order!, direction: 'short', leverage: 25 };
    const b = compile(short);
    expect(b.deployable).toBe(false);
    expect(codes(b)).toEqual(expect.arrayContaining(['direction_not_long', 'leverage_over_cap']));
    const scalp = compile(irOf('mtf_alignment'), '5m');
    expect(scalp.horizon).toBeNull();
    expect(codes(scalp)).toContain('horizon_scalp');
    const pine = irOf('breakout_retest');
    pine.signal.push({ primitive: 'pine_series_cross', params: {} });
    expect(compile(pine).unmapped.find((u) => u.path === 'signal[3]')?.severity).toBe('block');
    const nostop = irOf('breakout_retest');
    nostop.risk.stop = { primitive: 'no_stop', params: {} };
    expect(codes(compile(nostop))).toContain('no_stop');
    const screen = irOf('breakout_retest');
    screen.universe = { screen: { top_n: 3 } };
    expect(codes(compile(screen))).toContain('universe_screen');
    // 限价入场能下发,只标 CandidateV0 的差距(warn)
    const ok = compile(irOf('breakout_retest'));
    expect(ok.deployable).toBe(true);
    expect(ok.unmapped.find((u) => u.code === 'v0_limit_entry')?.severity).toBe('warn');
    expect(ok.entry).toMatchObject({ type: 'limit', expiry_bars: 12, price: { primitive: 'structure_level' }, on_new_signal: { unfilled: 'replace', filled: 'ignore' } });
  });

  it('不带 order 块的旧 IR 按现货做多、下一根开盘市价解析(与研究回放同一个 resolveOrder)', () => {
    const b = compile(defaultIR(), '4h');
    expect(b).toMatchObject({ market: 'spot', direction: 'long', horizon: 'swing', entry: { type: 'market', price: null, expiry_bars: null } });
    expect(b.targets.map((t) => t.source.primitive)).toEqual(['structure_target']);
    expect(b.trail?.primitive).toBe('chandelier_trail');
    expect(b.signal_exits.map((x) => x.primitive)).toEqual(['trend_break']);
    expect(b.risk).toMatchObject({ leverage: 1, leverage_cap: 20 });
  });

  it('导入译文的缺口(known_gaps)原样并进 unmapped,source=import', () => {
    const spec = builtinImportSpec('breakout_retest')!;
    const b = compile(clone(spec.ir!), '1h', { known_gaps: spec.gaps });
    const imported = b.unmapped.filter((u) => u.source === 'import');
    expect(imported.map((u) => u.code)).toContain('retest_confirm_missing');
    expect(imported.every((u) => u.severity === 'warn')).toBe(true);
    expect(b.deployable).toBe(true);
  });
});
