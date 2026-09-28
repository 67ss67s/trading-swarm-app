// 回归:runtime.ts openThreadFromProposal 建线程时,持仓计划特征周期集合(holdingTimeframes)以前只按
// horizon 推算(没绑策略时 15m 工作周期 → intraday → 持仓周期 1h/4h),不包含模型在
// proposal.risk_plan.atr_timeframe 里选的周期。模型选了工作周期本身(15m)当 ATR 周期时,
// buildHoldingPlan 在 planFeatures 里找不到 15m 特征 → 返回 null → holdingEntryGates 判「持仓计划:
// 主周期ATR/入场价格缺失，无法建立持仓契约」→ episode 失败(09-26 评审站 94 次 PROPOSE 因此作废)。
// 修法(本测试要验证的那一处):把 risk_plan.atr_timeframe 也并入要拉的特征周期集合
// (runtime.ts 里搜「模型在 risk_plan 里选的 ATR 周期也要拉上」)。
//
// **重要边界(务必读完再改这条测试)**:holding-policy.ts::holdingEntryGates 里还有一道独立的
// 「策略ATR尺度」闸:`allowedTf = holdingTimeframes(plan.horizon, t.timeframe)`,与本处 planTfs 的
// 兜底集合用的是**完全相同**的 (horizon, entryTf) 两个入参、完全相同的函数。这意味着:任何需要靠本次
// 修复才被拉到特征的 atr_timeframe(即不在 baseline holdingTimeframes(horizon, entryTf) 里的那个),
// 结构上**必然**不在 allowedTf 里 —— 修复只是把"崩在 buildHoldingPlan 返回 null → 持仓契约缺失"这个
// 含糊报错,换成"策略ATR尺度: xxx 不在允许周期内"这个更准确的闸拒绝;**并不会**让线程真的建出来
// (holdingEntryGates 在非 opts.run 的路径——agent/chat——上是无条件跑的)。已用 atr_timeframe='1h'
// (在 allowedTf 内)实测过全链路能正常建线程/成交,证明这不是本测试搭法的问题。
// 因此这条测试只断言「不再因『持仓契约』这个具体原因失败」,不断言线程建成;如果之后有人在
// holding-policy.ts 里把 allowedTf 也补上 chosen atr_timeframe,应该回来把线程建成的断言加回去。
//
// 搭法与 runtime.test.ts 一致:真实 DemoRuntime + 内存 sqlite + PaperBackend + 本地假行情服务器
// (对任意 interval 都会应声给出足够根数的 K 线,15m/1h/4h 都覆盖到)+ 脚本化 stub brain。
// TG_DEMO_MARKET_BASE 必须在 dynamic-import runtime.ts 之前设好(market.ts 在模块顶层读它)。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';
import type { Judgment, Trigger } from '../../src/demo/types.js';

let server: FakeMarketServer;
let DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;

beforeAll(async () => {
  server = await startFakeMarketServer(50000, 100);
  process.env['TG_DEMO_MARKET_BASE'] = server.url;
  ({ DemoRuntime } = await import('../../src/demo/runtime.js'));
});

afterAll(async () => {
  await server.close();
  delete process.env['TG_DEMO_MARKET_BASE'];
});

type RT = InstanceType<typeof DemoRuntime>;

async function drained(rt: RT): Promise<void> {
  const start = Date.now();
  for (;;) {
    const v = rt.queueView();
    if (v.pending === 0 && v.running === null) return;
    if (Date.now() - start > 5000) throw new Error('queue did not drain within 5s');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// 模型没绑策略(strategy_id 不给),止损 1%(≥ 0.5% 下限)、止盈 3%,毛盈亏比 3、扣成本后仍远高于 1.5 下限。
// risk_plan.atr_timeframe 选的是工作周期本身 15m —— 这正是以前只拉 1h/4h 时会漏掉的那个周期。
function proposeJudgment(mark: number): Judgment {
  const stop = (mark * 0.99).toFixed(2);
  const tp = (mark * 1.03).toFixed(2);
  return {
    action: 'PROPOSE', direction: 'long', confidence: 0.75, headline: '桩:测试做多(15m ATR)', thesis: '回归测试:risk_plan.atr_timeframe=15m',
    reasons: ['测试原因 [E1]'], evidence_refs: ['E1'], invalidation: '跌破止损', invalidation_price: stop, target_price: tp, watch_conditions: [],
    proposal: {
      direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: stop, take_profit_price: tp, take_profits: [tp],
      rationale: '测试', risk_plan: { atr_timeframe: '15m', stop_atr_multiple: '1.5' },
    },
  };
}

function scriptFor(user: string): string {
  const markMatch = /mark (\d+(?:\.\d+)?)/.exec(user);
  const mark = markMatch ? Number(markMatch[1]) : 0;
  return JSON.stringify(proposeJudgment(mark));
}

function mkRuntime(): { rt: RT; store: DemoStore; state: StateDb; backend: PaperBackend } {
  const state = openStateDb(':memory:');
  const store = new DemoStore(state);
  const backend = new PaperBackend(10_000);
  const brain = stubBrain((_system, user) => scriptFor(user));
  const rt = new DemoRuntime({ store, backend, brains: { stub: brain }, marketPollMs: 600_000, accountPollMs: 600_000 });
  return { rt, store, state, backend };
}

let activeRt: RT | null = null;
let activeState: StateDb | null = null;

afterEach(async () => {
  if (activeRt) await activeRt.stop();
  if (activeState) activeState.close();
  activeRt = null;
  activeState = null;
});

const T = (detail: string): Trigger => ({ kind: 'manual', detail });

describe('holding plan 特征周期要覆盖 risk_plan.atr_timeframe(09-26 回归)', () => {
  it('无激活策略,15m 工作周期,模型 risk_plan.atr_timeframe=15m → 不再因「持仓契约」缺失而失败(15m 特征已被拉取)', async () => {
    const { rt, store, state } = mkRuntime();
    activeRt = rt;
    activeState = state;
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], auto_approve: true, timeframe: '15m' });

    expect(rt.scan('BTCUSDT', T('holding plan atr tf regression'))).toBe(true);
    await drained(rt);

    const summaries = store.episodes(10).filter((e) => e.symbol === 'BTCUSDT' && e.action === 'PROPOSE');
    expect(summaries).toHaveLength(1);
    const ep = store.episode(summaries[0]!.id)!;
    // 这是本次修复的目标症状:修复前 ep.error 含「持仓契约」(buildHoldingPlan 因缺 15m 特征返回
    // null);修复后 15m 特征已被拉到,buildHoldingPlan 能正常算出 atr_timeframe=15m 的持仓计划,
    // 不再以这个理由失败(episode 仍可能因下面说的独立「策略ATR尺度」闸被拒,但不是这个原因)。
    expect(ep.error ?? '').not.toContain('持仓契约');
    expect(ep.gates.some((g) => g.name === '持仓计划' && !g.passed)).toBe(false);
    expect(ep.holding_plan?.atr_timeframe).toBe('15m');
  });
});
