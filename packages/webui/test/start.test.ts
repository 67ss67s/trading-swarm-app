/**
 * 2026-09-25 信息架构第二批:#start 清单完成度判断(components/start/logic.ts)+ 新导航分组 + 英文词条。
 */
import { describe, expect, it } from 'vitest';
import type { BrainOption, ExecutionView, ModelConnection, ModelsView } from '../src/api/types';
import { bootRedirect, evaluateStart, okxSimpleMode, startCoreComplete, startProgress, type StartInputs } from '../src/components/start/logic';
import { NAV, NAV_COLLAPSIBLE_GROUPS, NAV_GROUP_LABEL, NAV_GROUP_ORDER } from '../src/lib/nav';
import { EN } from '../src/lib/i18n-en';

function exec(over: Partial<ExecutionView> & { okx?: Partial<NonNullable<ExecutionView['okx']>> | null } = {}): ExecutionView {
  const { okx, ...rest } = over;
  return {
    exchange: 'okx',
    backend: 'okx',
    options: [],
    agent: {} as ExecutionView['agent'],
    connection: { status: 'connected', detail: null, checked_at: null } as unknown as ExecutionView['connection'],
    can_switch: true,
    switch_blocker: null,
    markets_supported: ['perp', 'spot'],
    protection: { state: 'unverified' } as unknown as ExecutionView['protection'],
    account_funded: null,
    ...rest,
    okx: okx === null ? null : ({ cli: 'okx', profile: 'okx-demo', demo: true, available: true, note: null, version: '1.0.0', acct_lv: 2, ...(okx ?? {}) } as NonNullable<ExecutionView['okx']>),
  };
}

const okConn = { id: 'mc', kind: 'openrouter', label: 'OR', base_url: null, cli: null, key_masked: 'x', status: 'ok', last_test: null, models_hint: [], created_at: 1, updated_at: 1 } as ModelConnection;
const models = (ok: boolean): ModelsView => ({ connections: ok ? [okConn] : [], bindings: [], effective: {}, cli_detected: [] }) as unknown as ModelsView;
const brains = (available: boolean): BrainOption[] => [
  { kind: 'claude', label: 'claude', available, models: [], default_model: null, note: '' },
  { kind: 'pi', label: 'pi', available, models: [], default_model: null, note: '' },
] as BrainOption[];

function inputs(over: Partial<StartInputs> = {}): StartInputs {
  return {
    execution: exec(),
    models: models(true),
    brains: brains(false),
    slots: { brain: 'claude', cheap_brain: 'pi' },
    workflow: { watchlist: ['BTCUSDT'], markets: ['perp', 'spot'] },
    agentPaused: false,
    agentStrategyKind: 'free',
    freeJudgmentConfirmed: true,
    matrixStudies: 0,
    historyThreads: 0,
    ...over,
  };
}

describe('evaluateStart', () => {
  it('fresh setup: exchange not connected blocks the account-dependent steps', () => {
    const s = evaluateStart(inputs({ execution: exec({ okx: { available: false, acct_lv: null } }), models: models(false), workflow: { watchlist: [], markets: ['perp'] }, agentPaused: true, freeJudgmentConfirmed: false }));
    expect(s.exchange).toBe('todo');
    expect(s.account_mode).toBe('blocked');
    expect(s.funding).toBe('blocked');
    expect(s.protection).toBe('blocked');
    expect(s.models).toBe('todo');
    expect(s.watchlist).toBe('todo');
    expect(s.strategy).toBe('todo');
    expect(s.agent).toBe('todo');
    expect(startCoreComplete(s)).toBe(false);
  });

  it('simple mode (acctLv=1) is only a problem when perps are wanted', () => {
    const simple = exec({ okx: { acct_lv: 1 } });
    expect(okxSimpleMode(simple)).toBe(true);
    const perp = evaluateStart(inputs({ execution: simple }));
    expect(perp.account_mode).toBe('todo');
    expect(perp.market).toBe('todo');
    const spotOnly = evaluateStart(inputs({ execution: simple, workflow: { watchlist: ['BTCUSDT'], markets: ['spot'] } }));
    expect(spotOnly.account_mode).toBe('done');
    expect(spotOnly.market).toBe('done');
    // 只做现货的模拟盘不用验保护单
    expect(spotOnly.protection).toBe('skipped');
  });

  it('demo skips funding; live needs funding and protection', () => {
    expect(evaluateStart(inputs()).funding).toBe('skipped');
    const live = evaluateStart(inputs({ execution: exec({ okx: { demo: false }, account_funded: false }), workflow: { watchlist: ['BTCUSDT'], markets: ['spot'] } }));
    expect(live.funding).toBe('todo');
    expect(live.protection).toBe('todo');
    const verified = evaluateStart(inputs({ execution: exec({ okx: { demo: false }, account_funded: true, protection: { state: 'verified' } as unknown as ExecutionView['protection'] }) }));
    expect(verified.funding).toBe('done');
    expect(verified.protection).toBe('done');
  });

  it('old gateway protection field (status only) still counts', () => {
    const s = evaluateStart(inputs({ execution: exec({ protection: { status: 'verified' } as unknown as ExecutionView['protection'] }) }));
    expect(s.protection).toBe('done');
  });

  it('binance: account mode skipped, exchange follows the connection', () => {
    const b = exec({ exchange: 'binance', backend: 'agent_mcp', okx: null, connection: { status: 'needs_auth' } as unknown as ExecutionView['connection'] });
    const s = evaluateStart(inputs({ execution: b }));
    expect(s.exchange).toBe('todo');
    expect(s.account_mode).toBe('skipped');
  });

  it('models: an ok connection, or a legacy slot CLI that starts', () => {
    expect(evaluateStart(inputs({ models: models(true), brains: brains(false) })).models).toBe('done');
    expect(evaluateStart(inputs({ models: models(false), brains: brains(true) })).models).toBe('done');
    expect(evaluateStart(inputs({ models: models(false), brains: brains(false) })).models).toBe('todo');
    // 老网关没有 /api/models(null)但 CLI 能起:按 CLI 判
    expect(evaluateStart(inputs({ models: null, brains: brains(true) })).models).toBe('done');
    expect(evaluateStart(inputs({ models: undefined, brains: undefined })).models).toBe('unknown');
  });

  it('strategy: a chosen strategy counts; free judgment needs one explicit confirm', () => {
    expect(evaluateStart(inputs({ agentStrategyKind: 'strategy', freeJudgmentConfirmed: false })).strategy).toBe('done');
    expect(evaluateStart(inputs({ agentStrategyKind: 'free', freeJudgmentConfirmed: false })).strategy).toBe('todo');
    expect(evaluateStart(inputs({ agentStrategyKind: 'free', freeJudgmentConfirmed: true })).strategy).toBe('done');
    expect(evaluateStart(inputs({ agentStrategyKind: undefined, freeJudgmentConfirmed: false })).strategy).toBe('unknown');
    // 接口失败(老网关)时只能靠本机确认
    expect(evaluateStart(inputs({ agentStrategyKind: null, freeJudgmentConfirmed: false })).strategy).toBe('todo');
  });

  it('optional steps follow their counts and never gate progress', () => {
    const s = evaluateStart(inputs({ matrixStudies: 2, historyThreads: 0 }));
    expect(s.matrix).toBe('done');
    expect(s.review).toBe('todo');
    const p = startProgress(s);
    // 可选项和 skipped(模拟盘入金)不计入必做
    expect(p.total).toBe(8);
    expect(p.done).toBe(7); // protection 没验(开着永续)
  });
});

describe('startCoreComplete / bootRedirect', () => {
  it('complete only when the four core steps are done', () => {
    expect(startCoreComplete(evaluateStart(inputs()))).toBe(true);
    expect(startCoreComplete(evaluateStart(inputs({ workflow: { watchlist: [], markets: ['perp'] } })))).toBe(false);
  });
  it('undecided while data is loading, but a definite todo decides early', () => {
    expect(startCoreComplete({ exchange: 'unknown', models: 'done', watchlist: 'done', strategy: 'done' })).toBeNull();
    expect(startCoreComplete({ exchange: 'unknown', models: 'todo', watchlist: 'done', strategy: 'done' })).toBe(false);
  });
  it('redirects incomplete boots to start and completed start boots back to the floor', () => {
    expect(bootRedirect(false, 'floor')).toBe('start');
    expect(bootRedirect(false, 'start')).toBeNull();
    expect(bootRedirect(true, 'start')).toBe('floor');
    expect(bootRedirect(true, 'trade')).toBeNull();
    expect(bootRedirect(null, 'floor')).toBeNull();
  });
});

describe('navigation (IA ②)', () => {
  it('groups by user journey with a collapsed advanced group', () => {
    const ids = (g: string) => NAV.filter((n) => n.group === g).map((n) => n.id);
    expect(NAV_GROUP_ORDER).toEqual(['ops', 'pick', 'review', 'settings', 'advanced']);
    // 09-25 楼层 v4 成为默认 #floor;09-28 旧楼层(#floor-legacy)所有版本都不进侧栏;09-29 OKX.AI(原信号市场)在交易下面
    expect(ids('ops')).toEqual(['floor', 'trade', 'market', 'agent']);
    expect(NAV.find((n) => n.id === 'market')?.label).toBe('OKX.AI');
    // 09-25 晚:研究台 + 批量验证合成「策略研究」,和「我的策略」同组放最前(旧路由保留,不单列);09-29 研究台回到侧栏
    expect(ids('pick')).toEqual(['strategy-research', 'research', 'my-strategies', 'screener', 'watch']);
    expect(ids('settings')).toEqual(['connect', 'models', 'settings']);
    expect(ids('advanced')).toEqual(['intel', 'events']); // 09-25 实盘部署台退出导航;09-28 日志页不进侧栏
    expect(NAV_COLLAPSIBLE_GROUPS).toEqual(['advanced']);
    expect(NAV.find((n) => n.id === 'start')?.group).toBe('start');
  });
  it('every nav label and group label has an English entry', () => {
    for (const n of NAV) expect(EN[n.label], n.label).toBeTruthy();
    for (const g of Object.values(NAV_GROUP_LABEL)) expect(EN[g], g).toBeTruthy();
  });
});
