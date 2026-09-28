// 闸覆盖(09-12):16 道闸 + 4 条扩展判定,每条一个必然踩线的定向 case,14 条模型边 + 49 条事件边每条至少一个 case。
// 全程桩大脑 + 合成 K 线,零模型成本、零网络。

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { demo } from '@trade-gate/gateway';
import { ALL_GATE_ROWS, EXTENSION_GATE_INVENTORY, GATE_INVENTORY, evalStubBrain, gateCoverage, generateGateCases, runCases, writeGateReport, writeJson } from '../src/index.js';

async function runGateSet(): Promise<{ dir: string; casesDir: string }> {
  const root = mkdtempSync(join(tmpdir(), 'eval-gates-'));
  const casesDir = join(root, 'cases');
  for (const c of generateGateCases()) writeJson(join(casesDir, `${c.id}.json`), c);
  const outDir = join(root, 'run');
  await runCases({ casesDir, outDir, brain: 'stub', cacheDir: join(root, 'cache'), concurrency: 4 }, () => {}, evalStubBrain());
  return { dir: outDir, casesDir };
}

describe('闸清单', () => {
  it('覆盖判断图里登记的每一道闸,没有多余项', () => {
    const listed = GATE_INVENTORY.map((g) => g.guard).sort();
    expect(listed).toEqual(Object.keys(demo.JUDGMENT_GRAPH.guards).sort());
    for (const g of GATE_INVENTORY) expect(demo.JUDGMENT_GRAPH.guards[g.guard as demo.GuardId]!.gate_name).toBe(g.gate_name);
  });

  it('扩展判定不混进判断图那份清单,矩阵里各占一行', () => {
    const graphIds = new Set(Object.keys(demo.JUDGMENT_GRAPH.guards));
    for (const g of EXTENSION_GATE_INVENTORY) expect(graphIds.has(g.guard), `${g.guard} 已进判断图,应该从扩展清单挪进 GATE_INVENTORY`).toBe(false);
    expect(ALL_GATE_ROWS.length).toBe(GATE_INVENTORY.length + EXTENSION_GATE_INVENTORY.length);
    // 扩展判定按「闸名 + 理由关键词」认领,同一条拒绝可以同时记在基础行上(保护腿凭证就住在提交前重闸里)。
    const cov = gateCoverage([{ case_id: 'p', rejected: [{ name: '提交前重闸', reason: 'BTCUSDT 在 binance-live 通道上从没验证过能挂止损(执行页…)' }] }]);
    expect(cov.rows.find((r) => r.guard === 'protection_never_verified')!.rejections).toBe(1);
    expect(cov.rows.find((r) => r.guard === 'preflight')!.rejections).toBe(1);
    // 理由关键词不对就不算这条判定。
    const other = gateCoverage([{ case_id: 'q', rejected: [{ name: '提交前重闸', reason: 'BTCUSDT 已有持仓(可能是外部的)' }] }]);
    expect(other.rows.find((r) => r.guard === 'protection_never_verified')!.rejections).toBe(0);
    expect(other.missing).toContain('protection_never_verified');
  });

  it('gateCoverage 把没触发的闸列进 missing', () => {
    const cov = gateCoverage([{ case_id: 'x', rejected: [{ name: '紧急停止', reason: '系统紧急停止中,不允许开仓' }] }]);
    expect(cov.rows.find((r) => r.guard === 'halt')!.rejections).toBe(1);
    expect(cov.missing).toContain('paused');
    expect(cov.unlisted_guards).toEqual([]);
  });
});

describe('cases/v4-gates 定向集', () => {
  it('生成是纯函数,且每道闸/每条边都有认领它的 case', () => {
    const a = generateGateCases();
    const b = generateGateCases();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const covers = new Set(a.flatMap((c) => c.hidden.covers ?? []));
    for (const g of ALL_GATE_ROWS) expect(covers.has(`guard:${g.guard}`), `${g.guard} 没有认领它的 case`).toBe(true);
    for (const e of demo.JUDGMENT_GRAPH.model_edges) expect(covers.has(`model_edge:${e.id}`), `${e.id} 没有 case`).toBe(true);
    for (const e of demo.JUDGMENT_GRAPH.event_edges) expect(covers.has(`event_edge:${e.id}`), `${e.id} 没有 case`).toBe(true);
  });

  it('跑一遍:16 道闸 + 4 条扩展判定全部触发,模型边与事件边 100%,报告 PASS', async () => {
    const { dir, casesDir } = await runGateSet();
    try {
      const r = writeGateReport(dir, casesDir);
      const zero = r.coverage.rows.filter((x) => x.rejections === 0).map((x) => x.guard);
      expect(zero, `这些闸 0 次触发: ${zero.join(', ')}`).toEqual([]);
      expect(r.coverage.covered).toBe(ALL_GATE_ROWS.length);
      expect(r.edges.model_missing).toEqual([]);
      expect(r.edges.event_missing).toEqual([]);
      expect(r.edges.model_ratio).toBe(1);
      expect(r.edges.event_ratio).toBe(1);
      expect(r.problems).toEqual([]);
      expect(r.verdict).toBe('PASS');
      expect(r.markdown).toContain('闸 × 触发次数');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('09-12 晚新增的三道闸/判定', () => {
  it('两条「必然放行」的对照用例:事件封锁不拦平仓,entry_timing=pending 时限价放行', async () => {
    const { dir } = await runGateSet();
    try {
      const gatesOf = (id: string): { name: string; passed: boolean; reason: string }[] =>
        (JSON.parse(String(readFileSync(join(dir, 'episodes', `${id}.json`), 'utf8'))) as { gates: { name: string; passed: boolean; reason: string }[] }).gates;

      const exitGates = gatesOf('gate-event-blackout-exit-allowed');
      const exitBlackout = exitGates.find((g) => g.name === '事件封锁')!;
      expect(exitBlackout.passed, '事件封锁把平仓也拦了').toBe(true);
      expect(exitBlackout.reason).toContain('只拦开仓');

      const blocked = gatesOf('gate-event-blackout').find((g) => g.name === '事件封锁')!;
      expect(blocked.passed).toBe(false);

      const limit = gatesOf('gate-council-entry-timing-limit-allowed').find((g) => g.name === '策略共识')!;
      expect(limit.passed, '共识成立 + 限价入场应当放行').toBe(true);
      const market = gatesOf('gate-council-entry-timing').find((g) => g.name === '策略共识')!;
      expect(market.passed).toBe(false);
      expect(market.reason).toContain('入场时机未确认');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('向后兼容', () => {
  it('没写 gate_env 的 case 只跑 evaluateGates(闸条目与 09-12 之前一致)', async () => {
    const cases = generateGateCases();
    const plain = cases.find((c) => c.id.startsWith('evt-none-'))!;
    expect(plain.visible.gate_env).toBeUndefined();
    const root = mkdtempSync(join(tmpdir(), 'eval-gates-compat-'));
    try {
      const casesDir = join(root, 'cases');
      writeJson(join(casesDir, `${plain.id}.json`), plain);
      const outDir = join(root, 'run');
      await runCases({ casesDir, outDir, brain: 'stub', cacheDir: join(root, 'cache') }, () => {}, evalStubBrain());
      const ep = JSON.parse(String(require('node:fs').readFileSync(join(outDir, 'episodes', `${plain.id}.json`), 'utf8'))) as { gates: { name: string }[] };
      // NO_TRADE 只会评到 gates.ts 的前三条闸,扩展的那几道一条都不该出现。
      expect(ep.gates.map((g) => g.name)).toEqual(['紧急停止', '暂停', '证据新鲜度']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
