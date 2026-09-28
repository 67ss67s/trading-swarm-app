/**
 * 楼层 v4 修复轮 1:真议会驱动「开会」、每桌策略片 / 模型、当前策略卡数据源、顶栏币种芯片、8-bit 音效表。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpisodeSummary, ModelsView } from '../src/api/types';
import type { AgentStrategyView } from '../src/api/agent-strategy';
import type { ResearchStrategy } from '@trade-gate/contracts';
import { buildFloorModel, currentStrategy, deriveCouncilMeetings, deskInfo, pickMeetings } from '../src/components/floor-v4/snapshot';
import { COINS_KEY, COINS_MAX, addCoin, effectiveCoins, loadCoins, moveCoin, normCoins, removeCoin, saveCoins } from '../src/components/floor-v4/coins';
import { SFX, createSfx } from '../src/components/floor-v4/sound';

const NOW = Date.UTC(2026, 8, 25, 6, 0, 0);

function ep(id: string, at: number, council: EpisodeSummary['council'], has_intent = false): EpisodeSummary {
  return { id, at, symbol: 'SOLUSDT', thread_id: null, trigger: 'scan', action: null, direction: null, headline: null, confidence: null, reasons: [], from_state: 'idle', to_state: null, has_intent, council } as unknown as EpisodeSummary;
}
const council = (reached: boolean, agreeing = 2, required = 2) => ({ reached, direction: reached ? ('long' as const) : null, agreeing, required, abstaining: 0, gate_effective: true, entry_timing: null });

describe('council-driven meetings', () => {
  it('an episode with a strategy council = a meeting (HELM, THREAD, LAB, SENTINEL; + EXEC when it produced an intent)', () => {
    const ms = deriveCouncilMeetings([ep('a', NOW - 60_000, council(true), true), ep('b', NOW - 120_000, council(false, 1, 3)), ep('c', NOW - 30_000, null)], NOW);
    expect(ms.map((m) => m.id)).toEqual(['council:a', 'council:b']);
    expect(ms[0]!.roles).toEqual(['gate_captain', 'thread_manager', 'strategy_lab', 'risk_sentinel', 'executor']);
    expect(ms[0]!.topic).toContain('2/2');
    expect(ms[1]!.roles).not.toContain('executor');
    expect(ms[1]!.topic).toContain('1/3');
  });
  it('old councils (> 6h) are ignored', () => {
    expect(deriveCouncilMeetings([ep('a', NOW - 7 * 3600_000, council(true))], NOW)).toEqual([]);
  });
  it('council off (all null) → falls back to the activity inference', () => {
    const acts = ['proposal', 'proposal_blocked', 'approved'].map((kind, i) => ({ id: `x${i}`, at: NOW - 60_000 + i * 1000, kind, level: 'info', symbol: 'BTCUSDT', thread_id: 't1', episode_id: null, title: kind, detail: null, data: {} }));
    const fallback = pickMeetings({ now: NOW, episodes: [ep('a', NOW - 1000, null)], activity: acts as never });
    const real = pickMeetings({ now: NOW, episodes: [ep('a', NOW - 1000, council(true))], activity: acts as never });
    expect(real.map((m) => m.id)).toEqual(['council:a']);
    expect(fallback.every((m) => !m.id.startsWith('council:'))).toBe(true);
  });
});

const view = (over: Partial<AgentStrategyView> = {}): AgentStrategyView => ({
  kind: 'strategy', strategy_id: 's1', version: 3, name: 'Trend', run_id: 'r1', run_status: 'running', mode: 'agent', since: 0,
  slices: [
    { role: 'judge', title: '判断', summary: 'j', rules: [{ text: 'r1', executor: 'code' }, { text: 'r2', executor: 'code' }] },
    { role: 'holding', title: '持仓', summary: 'h', rules: [{ text: 'h1', executor: 'code' }] },
    { role: 'execution', title: '执行', summary: 'e', rules: [] },
  ] as never,
  role_engines: { judge: 'decision', holding: 'code' },
  legacy_pool_ignored: [],
  ...over,
});

describe('desk slices + current strategy', () => {
  it('THREAD desk gets judge + holding slices with their engines; desks without a mapping get null', () => {
    const d = deskInfo('thread_manager', view());
    expect(d?.kind).toBe('strategy');
    expect(d?.slices.map((s) => [s.title, s.engine, s.rules.length])).toEqual([['判断', 'decision', 2], ['持仓', 'code', 1]]);
    expect(deskInfo('reviewer', view())).toBeNull();
    expect(deskInfo('thread_manager', null)).toBeNull();
    expect(deskInfo('radar', view({ kind: 'free' }))).toEqual({ kind: 'free', strategy: null, slices: [] });
  });
  it('current strategy card comes from AgentStrategyView; falls back to my-strategies when the view is missing', () => {
    const fb = { id: 's1', name: 'Trend', symbol: 'BTCUSDT', current_version: 3, status: 'paper' } as ResearchStrategy;
    expect(currentStrategy(view(), fb)).toMatchObject({ kind: 'strategy', name: 'Trend', version: 3, symbol: 'BTCUSDT', run: 'running' });
    expect(currentStrategy(view({ kind: 'free' }), fb)?.kind).toBe('free');
    expect(currentStrategy(null, fb, new Set(['s1']))).toMatchObject({ kind: 'strategy', run: 'running' });
    expect(currentStrategy(null, null)).toBeNull();
  });
  it('buildFloorModel: free mode → no draggable strategy; strategy mode → pinned strategy object; agents carry brain + desk', () => {
    const strategies = [{ id: 's1', name: 'Trend', symbol: 'BTCUSDT', current_version: 3, status: 'paper', updated_at: 1 }, { id: 's2', name: 'Other', symbol: 'ETHUSDT', current_version: 1, status: 'live', updated_at: 2 }] as ResearchStrategy[];
    const free = buildFloorModel({ now: NOW, agentStrategy: view({ kind: 'free' }), strategies });
    expect(free.strategyObj).toBeNull();
    expect(free.current?.kind).toBe('free');
    const m = buildFloorModel({ now: NOW, agentStrategy: view(), strategies });
    expect(m.strategyObj?.id).toBe('s1');
    expect(m.agents.find((a) => a.role === 'thread_manager')?.desk?.slices).toHaveLength(2);
    const noView = buildFloorModel({ now: NOW, strategies });
    expect(noView.strategyObj?.id).toBe('s2');
    const models = { effective: { judge: { source: 'binding', name: 'glm-5.3' } }, connections: [], bindings: [] } as unknown as ModelsView;
    const withModels = buildFloorModel({ now: NOW, models });
    const thread = withModels.agents.find((a) => a.role === 'thread_manager');
    expect(thread?.brain === null || typeof thread?.brain?.name === 'string').toBe(true);
  });
});

describe('top-bar coins', () => {
  // vitest 跑在 node 环境:给一个内存版 localStorage
  beforeAll(() => {
    const mem = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) } });
  });
  afterAll(() => vi.unstubAllGlobals());
  beforeEach(() => window.localStorage.removeItem(COINS_KEY));
  it('first load = first 5 of the watchlist; stored list wins afterwards (even empty)', () => {
    const wl = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XAGUSDT', 'DOGEUSDT'];
    expect(effectiveCoins(loadCoins(), wl)).toEqual(wl.slice(0, 5));
    saveCoins(['DOGEUSDT', 'BTCUSDT']);
    expect(effectiveCoins(loadCoins(), wl)).toEqual(['DOGEUSDT', 'BTCUSDT']);
    saveCoins([]);
    expect(effectiveCoins(loadCoins(), wl)).toEqual([]);
  });
  it('corrupt storage → null (falls back to watchlist)', () => {
    window.localStorage.setItem(COINS_KEY, '{oops');
    expect(loadCoins()).toBeNull();
  });
  it('add / remove / reorder; dedupe, upper-case, cap at 12', () => {
    expect(addCoin(['BTCUSDT'], 'btcusdt')).toEqual(['BTCUSDT']);
    expect(addCoin(['BTCUSDT'], 'SOLUSDT')).toEqual(['BTCUSDT', 'SOLUSDT']);
    expect(removeCoin(['BTCUSDT', 'SOLUSDT'], 'BTCUSDT')).toEqual(['SOLUSDT']);
    expect(moveCoin(['A', 'B', 'C'].map((x) => `${x}USDT`), 'CUSDT', 'AUSDT')).toEqual(['CUSDT', 'AUSDT', 'BUSDT']);
    expect(moveCoin(['AUSDT', 'BUSDT', 'CUSDT'], 'AUSDT', 'CUSDT')).toEqual(['BUSDT', 'CUSDT', 'AUSDT']);
    const many = Array.from({ length: 20 }, (_, i) => `C${i}USDT`);
    expect(normCoins(many)).toHaveLength(COINS_MAX);
    expect(normCoins(['not a symbol', 'ETHUSDT'])).toEqual(['ETHUSDT']);
  });
});

describe('8-bit sfx', () => {
  it('every kind has a short phrase (< 0.5 s) and playing while off is a no-op', () => {
    for (const notes of Object.values(SFX)) {
      expect(notes.length).toBeGreaterThan(0);
      expect(Math.max(...notes.map((n) => n.at + n.d))).toBeLessThan(0.5);
    }
    const s = createSfx(false);
    expect(() => s.play('envelope')).not.toThrow();
    expect(s.isOn()).toBe(false);
  });
});
