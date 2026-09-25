/**
 * 黑盒决策规范化(契约 §9.37;设计 docs/design/attribution-and-tiers-2026-09-12.md §3)。
 *
 * 判据只有两条,但都是硬的:
 *  1. 三栏(代码允许 → 模型选 → 闸后执行)每一栏都填得出来,不靠自由文本;
 *  2. **每一个 reason code 都在枚举里** —— 这才是「不是黑盒」的定义,不然只是换了个地方写散文。
 */
import { describe, expect, it } from 'vitest';
import {
  buildDecisionRecord,
  opportunityCountsFrom,
  strategyVersionHash,
  type DecisionRecordInputs,
} from '../../src/demo/attribution.js';
import { DECISION_RECORD_VERSION, DECISION_REASON_CODES, isDecisionReasonCode } from '../../src/demo/types.js';
import type { DecisionRecord, Episode, GateResult, Judgment } from '../../src/demo/types.js';

const NOW = 1_760_000_000_000;

function episode(over: Partial<Episode> = {}): Episode {
  return {
    id: 'ep-1',
    at: NOW,
    as_of: NOW,
    symbol: 'BTCUSDT',
    thread_id: null,
    trigger: { kind: 'bar_close', detail: '15m 收盘' },
    strategy_before: { state: 'researching', version: 0 },
    evidence: [],
    context_text: '',
    context_hash: 'ctx',
    prompt_version: 'p1',
    model: 'stub',
    judgment: null,
    judgment_raw: null,
    schema_errors: [],
    reducer: null,
    gates: [],
    intent: null,
    usage: null,
    status: 'done',
    error: null,
    strategy_after: null,
    ...over,
  } as unknown as Episode;
}

function judgment(over: Partial<Judgment> = {}): Judgment {
  return {
    action: 'PROPOSE',
    direction: 'long',
    confidence: 0.72,
    headline: '突破回踩站稳',
    thesis: '',
    reasons: [],
    evidence_refs: [],
    watch_conditions: [],
    invalidation: null,
    proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: '98', take_profit_price: '104' },
    ...over,
  } as unknown as Judgment;
}

function inputs(over: Partial<DecisionRecordInputs> = {}): DecisionRecordInputs {
  return { tier: 'short', entry_style: 'free', council_mode: 'off', council_required: 2, ...over };
}

const pass = (name: string): GateResult => ({ name, passed: true, reason: '通过' });
const block = (name: string, reason = '拒'): GateResult => ({ name, passed: false, reason });

/** 一条记录里出现的所有 reason code。 */
function allCodes(dr: DecisionRecord): string[] {
  return [...dr.allowed.codes, ...dr.model.codes, ...dr.executed.codes];
}

describe('reason code 是枚举,不是自由文本', () => {
  it('枚举里没有重复项', () => {
    expect(new Set(DECISION_REASON_CODES).size).toBe(DECISION_REASON_CODES.length);
  });

  it('isDecisionReasonCode 只认枚举成员', () => {
    for (const c of DECISION_REASON_CODES) expect(isDecisionReasonCode(c)).toBe(true);
    for (const bad of ['gate_blocked ', '闸拒了', '', null, 42, undefined, 'GATE_PASS']) {
      expect(isDecisionReasonCode(bad)).toBe(false);
    }
  });

  it('造出来的每条记录,三栏里的每个 code 都在枚举里', () => {
    const cases: Episode[] = [
      episode(),
      episode({ judgment: judgment(), gates: [pass('信心下限')] }),
      episode({ judgment: judgment(), gates: [block('每日开仓上限')] }),
      episode({ judgment: judgment(), gates: [block('短线容量上限')] }),
      episode({ judgment: judgment(), graph: { version: 'g1', node: 'scan', edge: 'propose', guards: [], illegal_action: 'TELEPORT' } }),
      episode({ schema_errors: ['action 不合法'] }),
    ];
    for (const ep of cases) {
      const dr = buildDecisionRecord(ep, inputs());
      for (const c of allCodes(dr)) expect(isDecisionReasonCode(c)).toBe(true);
      expect(allCodes(dr).length).toBeGreaterThan(0);
    }
  });

  it('每一栏的 code 都去过重', () => {
    const dr = buildDecisionRecord(episode({ judgment: judgment(), gates: [block('短线容量上限'), block('中线容量上限')] }), inputs());
    expect(new Set(dr.executed.codes).size).toBe(dr.executed.codes.length);
  });
});

describe('三栏:代码允许 → 模型选 → 闸后执行', () => {
  it('版本号与 tier 落在记录上', () => {
    const dr = buildDecisionRecord(episode(), inputs({ tier: 'long' }));
    expect(dr.version).toBe(DECISION_RECORD_VERSION);
    expect(dr.at).toBe(NOW);
    expect(dr.tier).toBe('long');
  });

  it('一栏:entry_style 决定允许的入场方式,limit_only 只剩 limit', () => {
    expect(buildDecisionRecord(episode(), inputs({ entry_style: 'free' })).allowed).toMatchObject({ entry_styles: ['market', 'limit'], codes: expect.arrayContaining(['code_entry_free']) });
    expect(buildDecisionRecord(episode(), inputs({ entry_style: 'prefer_limit' })).allowed.codes).toContain('code_entry_prefer_limit');
    const only = buildDecisionRecord(episode(), inputs({ entry_style: 'limit_only' })).allowed;
    expect(only.entry_styles).toEqual(['limit']);
    expect(only.codes).toContain('code_entry_limit_only');
  });

  it('一栏:没有 strategy_refs 时标 code_no_strategy;有就记下 id@version@hash', () => {
    expect(buildDecisionRecord(episode(), inputs()).allowed.codes).toContain('code_no_strategy');
    const withRefs = buildDecisionRecord(episode({ strategy_refs: [{ id: 'breakout_retest', version: 2, content_hash: 'abc' }] }), inputs());
    expect(withRefs.allowed.codes).not.toContain('code_no_strategy');
    expect(withRefs.allowed.strategies).toEqual([{ id: 'breakout_retest', version: 2, content_hash: 'abc' }]);
    expect(withRefs.strategy_version_hash).toBe(strategyVersionHash([{ id: 'breakout_retest', version: 2, content_hash: 'abc' }]));
  });

  it('一栏:议会关掉 → council 为 null 且标 code_council_off', () => {
    const dr = buildDecisionRecord(episode(), inputs({ council_mode: 'off' }));
    expect(dr.allowed.council).toBeNull();
    expect(dr.allowed.codes).toContain('code_council_off');
  });

  it('一栏:议会达成 / 未达成共识各自一个码,票数与门槛取共识里的真值', () => {
    const council = {
      version: 'c1', at: NOW, symbol: 'BTCUSDT', mode: 'advise', verdicts: [], text: '',
      consensus: { reached: true, direction: 'long', agreeing: ['a', 'b'], dissenting: [], neutral: [], abstaining: [], required: 2, voting: ['a', 'b'], gate_effective: true, gate_reason: '', entry_timing: 'confirmed' },
    } as unknown as NonNullable<Episode['strategy_council']>;
    const reached = buildDecisionRecord(episode({ strategy_council: council }), inputs({ council_mode: 'advise', council_required: 99 }));
    expect(reached.allowed.council).toEqual({ reached: true, direction: 'long', agreeing: 2, required: 2 });
    expect(reached.allowed.codes).toContain('code_council_consensus');

    const noConsensus = { ...council, consensus: { ...council.consensus, reached: false, direction: null, agreeing: [] } } as typeof council;
    const dr = buildDecisionRecord(episode({ strategy_council: noConsensus }), inputs({ council_mode: 'require' }));
    expect(dr.allowed.council).toMatchObject({ reached: false, direction: null, agreeing: 0 });
    expect(dr.allowed.codes).toContain('code_council_no_consensus');
  });

  it('二栏:模型输出合法 / 非法被修复 / 压根没输出,三种码互斥', () => {
    expect(buildDecisionRecord(episode({ judgment: judgment() }), inputs()).model.codes).toEqual(['model_within_allowed']);

    const illegal = buildDecisionRecord(episode({ judgment: judgment(), graph: { version: 'g1', node: 'scan', edge: 'no_trade', guards: [], illegal_action: 'TELEPORT' } }), inputs());
    expect(illegal.model.codes).toEqual(['model_illegal_repaired']);
    expect(illegal.model.illegal_action).toBe('TELEPORT');

    const none = buildDecisionRecord(episode({ schema_errors: ['action 不合法'] }), inputs());
    expect(none.model.codes).toEqual(['model_no_output', 'model_failclosed']);
    expect(none.model.action).toBeNull();
  });

  it('二栏:模型选的动作/方向/入场/信心原样记下', () => {
    const dr = buildDecisionRecord(episode({ judgment: judgment({ confidence: 0.42 }) }), inputs());
    expect(dr.model).toMatchObject({ action: 'PROPOSE', direction: 'long', entry: 'market', confidence: 0.42 });
  });

  it('三栏:全闸通过 → gate_pass 且 executed.action = 模型选的那个', () => {
    const dr = buildDecisionRecord(episode({ judgment: judgment(), gates: [pass('信心下限'), pass('止损距离')] }), inputs());
    expect(dr.executed.passed).toBe(true);
    expect(dr.executed.codes).toContain('gate_pass');
    expect(dr.executed.action).toBe('PROPOSE');
    expect(dr.executed.blocked_by).toEqual([]);
  });

  it('三栏:有闸没过 → gate_blocked,blocked_by 是闸名(不是自由文本),executed.action = null', () => {
    const dr = buildDecisionRecord(episode({ judgment: judgment(), gates: [pass('信心下限'), block('每日开仓上限', '今日已开 4/4')] }), inputs());
    expect(dr.executed.passed).toBe(false);
    expect(dr.executed.codes).toContain('gate_blocked');
    expect(dr.executed.blocked_by).toEqual(['每日开仓上限']);
    expect(dr.executed.action).toBeNull();
  });

  it('三栏:分层闸单独给码,这样被闸拒的分布能把分层拒和别的拒分开数', () => {
    const daily = buildDecisionRecord(episode({ judgment: judgment(), gates: [block('短线每日开仓上限')] }), inputs());
    expect(daily.executed.codes).toContain('gate_tier_daily_cap');
    const cap = buildDecisionRecord(episode({ judgment: judgment(), gates: [block('中线容量上限')] }), inputs());
    expect(cap.executed.codes).toContain('gate_tier_capacity');
    const style = buildDecisionRecord(episode({ judgment: judgment(), gates: [block('长线入场方式')] }), inputs());
    expect(style.executed.codes).toContain('gate_tier_entry_style');
    // 全局同名闸不算分层拒
    const global = buildDecisionRecord(episode({ judgment: judgment(), gates: [block('每日开仓上限'), block('入场方式')] }), inputs());
    expect(global.executed.codes).not.toContain('gate_tier_daily_cap');
    expect(global.executed.codes).not.toContain('gate_tier_entry_style');
  });

  it('三栏:一行闸都没有 → gate_not_applicable(NO_TRADE 之类)', () => {
    const dr = buildDecisionRecord(episode({ judgment: judgment({ action: 'NO_TRADE', proposal: null }) }), inputs());
    expect(dr.executed.codes).toContain('gate_not_applicable');
    expect(dr.executed.codes).toContain('exec_none');
  });

  it('三栏:落了意图 → exec_intent / 等人批 → exec_awaiting_approval', () => {
    const sent = buildDecisionRecord(episode({ judgment: judgment(), gates: [pass('信心下限')], intent: { id: 'int-1', status: 'sent' } as unknown as Episode['intent'] }), inputs());
    expect(sent.executed.codes).toContain('exec_intent');
    expect(sent.executed.intent_id).toBe('int-1');
    const waiting = buildDecisionRecord(episode({ judgment: judgment(), gates: [pass('信心下限')], intent: { id: 'int-2', status: 'pending_approval' } as unknown as Episode['intent'] }), inputs());
    expect(waiting.executed.codes).toContain('exec_awaiting_approval');
  });

  it('evidence_plan_hash 原样带过来;没有就是 null', () => {
    expect(buildDecisionRecord(episode({ evidence_plan_hash: 'ev-abc' }), inputs()).evidence_plan_hash).toBe('ev-abc');
    expect(buildDecisionRecord(episode(), inputs()).evidence_plan_hash).toBeNull();
  });
});

describe('strategyVersionHash', () => {
  it('与顺序无关,内容变了就变', () => {
    const a = [{ id: 'x', version: 1, content_hash: 'h1' }, { id: 'y', version: 2, content_hash: 'h2' }];
    expect(strategyVersionHash(a)).toBe(strategyVersionHash([...a].reverse()));
    expect(strategyVersionHash(a)).not.toBe(strategyVersionHash([{ id: 'x', version: 2, content_hash: 'h1' }, a[1]!]));
    expect(strategyVersionHash([])).toBeNull();
    expect(strategyVersionHash(undefined)).toBeNull();
  });
});

describe('opportunityCountsFrom', () => {
  const withRecord = (id: string, at: number, strategies: string[], blocked: string[]): Episode =>
    episode({
      id,
      decision_record: {
        version: DECISION_RECORD_VERSION,
        at,
        tier: 'short',
        allowed: { actions: [], entry_styles: [], council: null, strategies: strategies.map((s) => ({ id: s, version: 1, content_hash: 'h' })), codes: [] },
        model: { action: null, direction: null, entry: null, confidence: null, illegal_action: null, codes: [] },
        executed: { action: null, passed: blocked.length === 0, blocked_by: blocked, intent_id: null, codes: [] },
        evidence_plan_hash: null,
        strategy_version_hash: null,
      },
    });

  it('只数点名了这条策略的记录;被闸拒按闸名累加', () => {
    const eps = [
      withRecord('e1', NOW, ['a'], []),
      withRecord('e2', NOW + 1, ['a', 'b'], ['信心下限']),
      withRecord('e3', NOW + 2, ['a'], ['信心下限', '每日开仓上限']),
      withRecord('e4', NOW + 3, ['b'], ['信心下限']),
    ];
    const a = opportunityCountsFrom(eps, 'a');
    expect(a.opportunities).toBe(3);
    expect(a.blocked).toEqual({ 信心下限: 2, 每日开仓上限: 1 });
    expect(opportunityCountsFrom(eps, 'b').opportunities).toBe(2);
  });

  it('没有 decision_record 的 episode 完全不参与统计,coverage_from 只认有记录的最早那条', () => {
    const eps = [episode({ id: 'old' }), withRecord('e1', NOW + 500, ['a'], []), withRecord('e2', NOW + 100, ['a'], [])];
    const a = opportunityCountsFrom(eps, 'a');
    expect(a.opportunities).toBe(2);
    expect(a.coverage_from).toBe(NOW + 100);
    expect(opportunityCountsFrom([episode()], 'a')).toEqual({ opportunities: 0, blocked: {}, coverage_from: null });
  });
});
