import { demo } from '@trading-swarm/gateway';

interface Structure {
  ref: string;
  timeframe: string;
  direction: demo.Direction;
  atrPct: number;
  distHighPct: number;
  distLowPct: number;
  volumeRatio: number;
}

function pricePlaces(value: string): number {
  return Math.max(1, value.includes('.') ? value.length - value.indexOf('.') - 1 : 1);
}

function parseStructures(user: string): Structure[] {
  const structures: Structure[] = [];
  for (const line of user.split('\n')) {
    const header = /^(E\d+) \[([^\]]+) 结构\] /.exec(line);
    if (!header) continue;
    const atr = /ATR14 [-+]?\d+(?:\.\d+)? \(([-+]?\d+(?:\.\d+)?)%\)/.exec(line);
    const distances = /20根高 [-+]?\d+(?:\.\d+)?\(距 ([-+]?\d+(?:\.\d+)?)%\) 低 [-+]?\d+(?:\.\d+)?\(距 ([-+]?\d+(?:\.\d+)?)%\)/.exec(line);
    const volume = /量比 ([-+]?\d+(?:\.\d+)?)/.exec(line);
    structures.push({
      ref: header[1]!,
      timeframe: header[2]!,
      direction: line.includes('EMA20>EMA50') ? 'long' : 'short',
      atrPct: Number(atr?.[1] ?? '0'),
      distHighPct: Number(distances?.[1] ?? '999'),
      distLowPct: Number(distances?.[2] ?? '999'),
      volumeRatio: Number(volume?.[1] ?? '0'),
    });
  }
  return structures;
}

function baseJudgment(input: {
  action: demo.Action;
  direction: demo.Direction | null;
  headline: string;
  thesis: string;
  reason: string;
  refs: string[];
  watch?: string[];
}): Omit<demo.Judgment, 'proposal'> & { proposal: null } {
  return {
    action: input.action,
    direction: input.direction,
    confidence: input.action === 'HOLD' ? 0.62 : input.action === 'NO_TRADE' ? 0.24 : 0.52,
    headline: input.headline,
    thesis: input.thesis,
    reasons: [input.reason],
    evidence_refs: input.refs,
    invalidation: null,
    invalidation_price: null,
    target_price: null,
    watch_conditions: input.watch ?? ['等待结构与成交量共同确认'],
    proposal: null,
  };
}

function reviewJudgment(user: string, mark: number, structures: Structure[]): demo.Judgment {
  const held = user.includes('状态 持仓中');
  const pending = user.includes('状态 待入场');
  const side: demo.Direction = user.includes(' 做空,状态') ? 'short' : 'long';
  const protection = /止损 (\d+(?:\.\d+)?);止盈 ([^;]+)/.exec(user);
  const stop = Number(protection?.[1] ?? 'NaN');
  const target = Number(/\d+(?:\.\d+)?/.exec(protection?.[2] ?? '')?.[0] ?? 'NaN');
  const ref = structures[0]?.ref ?? 'E1';
  const stopped = Number.isFinite(stop) && (side === 'long' ? mark <= stop : mark >= stop);
  const targeted = Number.isFinite(target) && (side === 'long' ? mark >= target : mark <= target);
  if (user.includes('系统处于紧急停止')) {
    return baseJudgment({
      action: held ? 'EXIT' : 'INVALIDATE',
      direction: side,
      headline: '紧急停止并降低风险',
      thesis: '系统停止期间撤销等待或退出持仓',
      reason: `紧急停止要求只降低风险 [E1]`,
      refs: ['E1'],
      watch: [],
    });
  }
  if (stopped) {
    return baseJudgment({
      action: held ? 'INVALIDATE' : 'INVALIDATE',
      direction: side,
      headline: '保护条件已经触发',
      thesis: '既定失效条件成立，原论点不再有效',
      reason: `当前市场已越过保护条件 [E1]`,
      refs: ['E1'],
      watch: [],
    });
  }
  if (targeted && held) {
    return baseJudgment({
      action: 'REDUCE',
      direction: side,
      headline: '目标区域已到达',
      thesis: '价格兑现部分目标，降低风险并保留剩余敞口',
      reason: `当前市场已进入目标区域 [E1]`,
      refs: ['E1'],
      watch: ['观察剩余结构是否延续'],
    });
  }
  return baseJudgment({
    action: 'HOLD',
    direction: side,
    headline: pending ? '挂单论点仍然成立' : '持仓论点仍然成立',
    thesis: '新证据尚未破坏既定结构论点',
    reason: `结构与当前市场尚未触发失效条件 [${ref}]`,
    refs: [ref],
    watch: ['继续观察结构与保护条件'],
  });
}

function deterministicResponse(_system: string, user: string): string {
  const markText = /last (\d+(?:\.\d+)?), mark/.exec(user)?.[1] ?? '0';
  const mark = Number(markText);
  const structures = parseStructures(user);
  if (user.includes('## 复查的线程')) return JSON.stringify(reviewJudgment(user, mark, structures));
  if (user.includes('(STALE)')) {
    return JSON.stringify(baseJudgment({
      action: 'NO_TRADE',
      direction: null,
      headline: '证据过期不建立仓位',
      thesis: '市场和结构证据已经过期，等待新快照',
      reason: '过期证据不能支撑开仓 [E1]',
      refs: ['E1'],
    }));
  }
  if (user.includes('系统处于紧急停止')) {
    return JSON.stringify(baseJudgment({
      action: 'NO_TRADE',
      direction: null,
      headline: '紧急停止不建立仓位',
      thesis: '系统停止期间不增加任何市场风险',
      reason: '紧急停止状态禁止开仓 [E1]',
      refs: ['E1'],
      watch: [],
    }));
  }
  const byTf = new Map(structures.map((structure) => [structure.timeframe, structure]));
  const fast = byTf.values().next().value as Structure | undefined;
  const oneHour = byTf.get('1h') ?? fast;
  const fourHour = byTf.get('4h') ?? oneHour;
  const direction = oneHour?.direction ?? 'long';
  const aligned = Boolean(oneHour && fourHour && oneHour.direction === fourHour.direction);
  const fastAligned = Boolean(fast && fast.direction === direction);
  const distance = direction === 'long' ? oneHour?.distHighPct ?? 999 : oneHour?.distLowPct ?? 999;
  const near = distance <= Math.max(0.8, (oneHour?.atrPct ?? 0) * 1.8);
  const liquid = (fast?.volumeRatio ?? 0) >= 0.7;
  const refs = [...new Set([oneHour?.ref, fourHour?.ref, fast?.ref].filter((ref): ref is string => Boolean(ref)))];
  if (aligned && fastAligned && near && liquid && mark > 0) {
    const stopPct = Math.min(0.03, Math.max(0.005, ((oneHour?.atrPct ?? 0.5) * 1.2) / 100));
    const stop = direction === 'long' ? mark * (1 - stopPct) : mark * (1 + stopPct);
    const target = direction === 'long' ? mark * (1 + stopPct * 2) : mark * (1 - stopPct * 2);
    const places = pricePlaces(markText);
    const stopText = stop.toFixed(places);
    const targetText = target.toFixed(places);
    return JSON.stringify({
      action: 'PROPOSE',
      direction,
      confidence: 0.68,
      headline: direction === 'long' ? '多周期偏多并靠近确认位' : '多周期偏空并靠近确认位',
      thesis: direction === 'long' ? '均线方向一致且价格靠近上方确认区域' : '均线方向一致且价格靠近下方确认区域',
      reasons: [`多周期结构方向一致且位置接近确认区域 [${refs[0] ?? 'E1'}]`],
      evidence_refs: refs.length ? refs : ['E1'],
      invalidation: '价格反向越过保护位则失效',
      invalidation_price: stopText,
      target_price: targetText,
      watch_conditions: ['观察突破或回踩能否延续'],
      proposal: {
        direction,
        entry: 'market',
        limit_price: null,
        entry_zone: null,
        stop_price: stopText,
        take_profit_price: targetText,
        take_profits: [targetText],
        rationale: '结构一致且位置接近确认区域',
      },
    });
  }
  if (aligned || near) {
    const ref = oneHour?.ref ?? fast?.ref ?? 'E1';
    return JSON.stringify(baseJudgment({
      action: 'WATCH',
      direction: null,
      headline: '方向可观察但确认不足',
      thesis: '部分结构条件存在，仍需等待位置或成交量确认',
      reason: `结构已有方向但开仓条件尚未齐备 [${ref}]`,
      refs: [ref],
    }));
  }
  const ref = oneHour?.ref ?? fast?.ref ?? 'E1';
  return JSON.stringify(baseJudgment({
    action: 'NO_TRADE',
    direction: null,
    headline: '多周期结构没有共识',
    thesis: '当前结构冲突，无法形成可执行优势',
    reason: `不同周期方向尚未形成共识 [${ref}]`,
    refs: [ref],
  }));
}

export function deterministicStubBrain(): demo.Brain {
  return demo.stubBrain(deterministicResponse);
}
