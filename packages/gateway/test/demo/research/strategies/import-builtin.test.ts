// 五条内置策略导入研究台(apply-spec §7):译文能过 IR 检查、导入幂等、规则未编码的草稿没有版本、回测只跑一次。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validate } from '@trading-swarm/contracts';
import { openStateDb } from '../../../../src/state-db.js';
import { ResearchStore } from '../../../../src/demo/research/store.js';
import type { ResearchService } from '../../../../src/demo/research/service.js';
import { StrategyStore } from '../../../../src/demo/research/strategies/store.js';
import { StrategyService } from '../../../../src/demo/research/strategies/service.js';
import { BUILTIN_IMPORTS } from '../../../../src/demo/research/strategies/import-builtin.js';
import { checkIR } from '../../../../src/demo/research/strategy.js';
import { meta, report } from './fixtures.js';

const clean: (() => void)[] = [];
afterEach(() => { for (const f of clean.splice(0)) f(); vi.restoreAllMocks(); });
function setup() {
  const state = openStateDb(':memory:'); clean.push(() => state.close());
  let t = 1_000; const research = new ResearchStore(state.db), store = new StrategyStore(state.db, () => ++t);
  return { store, svc: new StrategyService(store, research, {} as ResearchService) };
}

describe('内置策略译文', () => {
  it('五条都在,四条有 IR 且过 checkIR(原语/参数/周期/出场周期全合格),funding 规则未编码', () => {
    expect(BUILTIN_IMPORTS.map((x) => x.builtin_id)).toEqual(['breakout_retest', 'mtf_alignment', 'vol_compression_expansion', 'range_mean_reversion', 'funding_oi_extreme']);
    for (const spec of BUILTIN_IMPORTS) {
      if (!spec.ir) { expect(spec.translation).toBe('none'); expect(spec.gaps.every((g) => g.severity === 'block')).toBe(true); continue; }
      const r = checkIR(spec.ir, spec.timeframe);
      expect(r.checks.filter((c) => !c.ok), spec.builtin_id).toEqual([]);
      expect(spec.ir.order?.direction).toBe('long');
      expect(spec.gaps.length).toBeGreaterThan(0);
    }
    expect(BUILTIN_IMPORTS.find((x) => x.builtin_id === 'range_mean_reversion')!.translation).toBe('partial');
  });
  it('breakout_retest 能进 CandidateV0 影子:无 Pine、无 universe.screen、入场原语 next_open_market、1h long-only;替代写进描述与缺口', () => {
    const b = BUILTIN_IMPORTS[0]!;
    const all = JSON.stringify(b.ir);
    expect(all).not.toMatch(/"pine_/);
    expect(b.ir!.universe).toBeUndefined();
    expect(b.ir!.entry.primitive).toBe('next_open_market');
    expect(b.timeframe).toBe('1h');
    expect(b.description).toContain('回踩确认用「突破信号 + 限价挂支撑」代替');
    expect(b.gaps.find((g) => g.code === 'retest_confirm_missing')?.message).toContain('structure_level');
  });
});

describe('importBuiltins(幂等)', () => {
  it('第一次建五条(origin=import、lab_strategy_id=内置 id),第二次全部命中不重复建', async () => {
    const { svc, store } = setup();
    const first = await svc.importBuiltins({});
    expect(validate('research-binding', first)).toEqual({ ok: true });
    expect(first.items.map((x) => [x.builtin_id, x.created, x.version, x.translation])).toEqual([
      ['breakout_retest', true, 1, 'full'], ['mtf_alignment', true, 1, 'full'], ['vol_compression_expansion', true, 1, 'full'], ['range_mean_reversion', true, 1, 'partial'], ['funding_oi_extreme', true, null, 'none'],
    ]);
    for (const it of first.items) {
      const s = store.require(it.strategy_id);
      expect(s).toMatchObject({ lab_strategy_id: it.builtin_id, origin: { source: 'import', session_id: null }, status: 'draft' });
    }
    const second = await svc.importBuiltins({});
    expect(second.items.map((x) => x.strategy_id)).toEqual(first.items.map((x) => x.strategy_id));
    expect(second.items.every((x) => !x.created)).toBe(true);
    expect(svc.list({}).strategies).toHaveLength(5);
    expect(svc.detail(first.items[0]!.strategy_id).versions).toHaveLength(1);
    // 归档后再导入会重新建(幂等键不含归档)
    svc.archive(first.items[0]!.strategy_id);
    const third = await svc.importBuiltins({ ids: ['breakout_retest'] });
    expect(third.items).toHaveLength(1);
    expect(third.items[0]!.created).toBe(true);
  });
  it('backtest=true:有 IR 的各跑一次并挂上报告(转 backtested),再跑不重复;funding 不回测', async () => {
    const { svc } = setup();
    const spy = vi.spyOn(svc, 'backtest').mockImplementation(async (id: string) => {
      const s = svc.store.require(id), ir = svc.store.versionIR(id, s.current_version)!;
      const r = report({ ir, title: s.name });
      svc.attachReport(r, meta(), { strategy_id: id, strategy_version: s.current_version });
      return { report_id: r.id };
    });
    const a = await svc.importBuiltins({ backtest: true });
    expect(spy).toHaveBeenCalledTimes(4);
    expect(a.items.filter((x) => x.report_id).length).toBe(4);
    expect(a.items.find((x) => x.builtin_id === 'funding_oi_extreme')!.report_id).toBeNull();
    expect(svc.store.require(a.items[0]!.strategy_id).status).toBe('backtested');
    const b = await svc.importBuiltins({ backtest: true });
    expect(spy).toHaveBeenCalledTimes(4);
    expect(b.items.map((x) => x.report_id)).toEqual(a.items.map((x) => x.report_id));
  });
  it('回测失败只记 error,不挡其它条', async () => {
    const { svc } = setup();
    vi.spyOn(svc, 'backtest').mockRejectedValue(new Error('okx_timeout'));
    const r = await svc.importBuiltins({ backtest: true, ids: ['breakout_retest', 'funding_oi_extreme'] });
    expect(r.items.map((x) => [x.builtin_id, x.error])).toEqual([['breakout_retest', 'okx_timeout'], ['funding_oi_extreme', null]]);
  });
  it('参数校验:未知字段 / 未知内置 id → 400 类错误', async () => {
    const { svc } = setup();
    await expect(svc.importBuiltins({ foo: 1 })).rejects.toThrow(/unknown_fields/);
    await expect(svc.importBuiltins({ ids: ['nope'] })).rejects.toThrow(/unknown_builtin/);
  });
});

describe('binding()(GET /:id/binding)', () => {
  it('导入的策略带译文缺口;规则未编码的草稿 binding=null 并说明缺什么', async () => {
    const { svc } = setup();
    const r = await svc.importBuiltins({});
    const br = svc.binding(r.items[0]!.strategy_id, null, 5);
    expect(validate('research-binding', br)).toEqual({ ok: true });
    expect(br.binding!.unmapped.some((u) => u.source === 'import' && u.code === 'retest_confirm_missing')).toBe(true);
    expect(br.lab_strategy_id).toBe('breakout_retest');
    const f = svc.binding(r.items[4]!.strategy_id);
    expect(f.binding).toBeNull();
    expect(f.version).toBeNull();
    expect(f.unmapped.map((u) => u.code)).toEqual(['funding_primitive_missing', 'oi_primitive_missing', 'funding_window_missing']);
    expect(() => svc.binding(r.items[0]!.strategy_id, '7')).toThrow(/not_found/);
    expect(() => svc.binding(r.items[0]!.strategy_id, 'x')).toThrow(/invalid_version/);
  });
});
