// Deterministic rule brain. It reads only the evidence text the model would see, applies the
// playbook mechanically, and quotes every number verbatim from the evidence line it cites — so
// the offline run exercises the whole checker (mix of actions, symmetric under mirroring, honest
// about STALE and halted) without any model.

import { demo } from '@trading-swarm/gateway';

interface StructureLine {
  ref: string;
  tf: string;
  close: string;
  bullish: boolean;
  aboveEma20: boolean;
  ema20: string;
  ema50: string;
  atr: string;
  atrPct: number;
  hi20: string;
  distHi: number;
  lo20: string;
  distLo: number;
  volRatio: number;
  stale: boolean;
}

interface Parsed {
  last: string;
  lastRef: string;
  marketStale: boolean;
  structures: Map<string, StructureLine>;
  allowed: string[];
  halted: boolean;
  thread: { side: 'long' | 'short'; status: 'pending_entry' | 'in_position'; limit: string | null; filled: string | null; stop: string | null; tp: string | null } | null;
  unrealized: number | null;
  accountRef: string;
}

const STRUCT_RE = /^(E\d+) \[(\S+) 结构\] 收 (\S+); EMA20([<>])EMA50\((偏多|偏空)\), 价在 EMA20 ([上下]); EMA20 (\S+) EMA50 (\S+); ATR14 (\S+) \(([-\d.]+)%\); 20根高 (\S+)\(距 ([-\d.]+)%\) 低 (\S+)\(距 ([-\d.]+)%\); .*?量比 ([\d.]+)(?: \(STALE\))?$/;

export function parseContext(user: string): Parsed {
  const lines = user.split('\n');
  const structures = new Map<string, StructureLine>();
  let last = '';
  let lastRef = 'E1';
  let marketStale = false;
  let accountRef = 'E1';
  let unrealized: number | null = null;
  for (const line of lines) {
    const m1 = /^(E\d+) \[最新价 \/ 标记价\] last (\S+), mark (\S+)( \(STALE\))?$/.exec(line);
    if (m1) {
      lastRef = m1[1]!;
      last = m1[2]!;
      if (m1[4]) marketStale = true;
      continue;
    }
    if (/^E\d+ \[(资金费率|持仓量 OI|24h 变动 \/ 高低)\]/.test(line) && / \(STALE\)$/.test(line)) marketStale = true;
    const ms = STRUCT_RE.exec(line);
    if (ms) {
      structures.set(ms[2]!, {
        ref: ms[1]!,
        tf: ms[2]!,
        close: ms[3]!,
        bullish: ms[4] === '>',
        aboveEma20: ms[6] === '上',
        ema20: ms[7]!,
        ema50: ms[8]!,
        atr: ms[9]!,
        atrPct: Number(ms[10]),
        hi20: ms[11]!,
        distHi: Number(ms[12]),
        lo20: ms[13]!,
        distLo: Number(ms[14]),
        volRatio: Number(ms[15]),
        stale: line.endsWith('(STALE)'),
      });
      continue;
    }
    const ma = /^(E\d+) \[账户\] .*浮盈亏 (-?[\d.]+) USDT/.exec(line);
    if (ma) {
      accountRef = ma[1]!;
      unrealized = Number(ma[2]);
    } else {
      const ma2 = /^(E\d+) \[账户\]/.exec(line);
      if (ma2) accountRef = ma2[1]!;
    }
  }
  const allowedM = /允许的 action:(.*?)。/.exec(user);
  const allowedRaw = allowedM?.[1] ?? '';
  const allowed = allowedRaw.includes('无') ? [] : allowedRaw.split('/').map((s) => s.trim()).filter(Boolean);
  const halted = /紧急停止/.test(user.split('## 任务')[1] ?? '');
  let thread: Parsed['thread'] = null;
  const th = /^(\S+) (做多|做空),状态 (待入场|持仓中)/m.exec(user);
  if (th) {
    const block = user.split('## 复查的线程')[1] ?? '';
    thread = {
      side: th[2] === '做多' ? 'long' : 'short',
      status: th[3] === '待入场' ? 'pending_entry' : 'in_position',
      limit: /限价 ([\d.]+)/.exec(block)?.[1] ?? null,
      filled: /成交 @ ([\d.]+)/.exec(block)?.[1] ?? null,
      stop: /止损 ([\d.]+)/.exec(block)?.[1] ?? null,
      tp: /止盈 ([\d.]+)/.exec(block)?.[1] ?? null,
    };
  }
  return { last, lastRef, marketStale, structures, allowed, halted, thread, unrealized, accountRef };
}

interface Out {
  action: string;
  direction: 'long' | 'short' | null;
  confidence: number;
  headline: string;
  thesis: string;
  reasons: string[];
  evidence_refs: string[];
  invalidation: string | null;
  invalidation_price: string | null;
  target_price: string | null;
  watch_conditions: string[];
  proposal: Record<string, unknown> | null;
}

function refsOf(reasons: string[]): string[] {
  const set = new Set<string>();
  for (const r of reasons) for (const m of r.matchAll(/\[(E\d+)\]/g)) set.add(m[1]!);
  return [...set].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function finish(o: Omit<Out, 'evidence_refs'>): string {
  return JSON.stringify({ ...o, evidence_refs: refsOf(o.reasons) });
}

const dec = (s: string): number => (s.includes('.') ? s.length - s.indexOf('.') - 1 : 0);

function scanJudgment(p: Parsed, tf: string): string {
  const s = p.structures.get(tf);
  const h1 = p.structures.get('1h');
  const h4 = p.structures.get('4h');
  if (!s || !h1 || !h4 || !p.last) {
    return finish({ action: 'NO_TRADE', direction: null, confidence: 0.1, headline: '证据不完整,不交易', thesis: '缺少多周期结构证据,无法按 playbook 判断。', reasons: [`证据登记不完整 [${p.lastRef}]`], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: ['等待完整证据'], proposal: null });
  }
  const trendReason = `1h EMA20 ${h1.ema20} ${h1.bullish ? '>' : '<'} EMA50 ${h1.ema50},4h EMA20 ${h4.ema20} ${h4.bullish ? '>' : '<'} EMA50 ${h4.ema50} [${h1.ref}][${h4.ref}]`;
  if (h1.bullish !== h4.bullish) {
    return finish({ action: 'NO_TRADE', direction: null, confidence: 0.2, headline: '1h 与 4h 方向相反,不交易', thesis: '多周期方向不一致,playbook 规定 NO_TRADE。', reasons: [trendReason], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: ['等 1h 与 4h EMA 同向'], proposal: null });
  }
  if (h4.atrPct < 0.4) {
    return finish({ action: 'NO_TRADE', direction: null, confidence: 0.2, headline: '波动不足,不交易', thesis: '4h ATR 占比不足 0.4%,没有波动。', reasons: [`4h ATR14 ${h4.atr} 仅占 ${h4.atrPct.toFixed(2)}% [${h4.ref}]`, trendReason], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: ['ATR% 回到 0.4% 以上'], proposal: null });
  }
  const long = h1.bullish;
  const dir: 'long' | 'short' = long ? 'long' : 'short';
  const dist = long ? s.distHi : s.distLo;
  const level = long ? s.hi20 : s.lo20;
  const withTrend = long ? s.aboveEma20 : !s.aboveEma20;
  // Proximity is judged in 1h-ATR units (the trend timeframe); the 15m ATR is a few tenths of a percent here.
  const near = dist <= 1.5 * h1.atrPct;
  const stale = p.marketStale || s.stale || h1.stale || h4.stale;
  const posReason = `${tf} 收 ${s.close},价在 EMA20 ${s.ema20} ${s.aboveEma20 ? '上' : '下'},距 20根${long ? '高' : '低'} ${level} ${dist.toFixed(2)}%,ATR14 ${s.atr},量比 ${s.volRatio.toFixed(2)} [${s.ref}]`;
  const watch = [`${tf} 收盘${long ? '站上' : '跌破'} ${level}`, '量比 ≥ 1.0', '1h/4h 保持同向'];
  // Volume ratio ≥ 0.6 is accepted (below the playbook's 1.0) with reduced confidence, so the offline run has a few PROPOSEs to settle.
  if (withTrend && near && s.volRatio >= 0.6 && !stale && p.allowed.includes('PROPOSE')) {
    const px = Number(p.last);
    const d = Math.max(1, dec(p.last));
    const atr = Number(s.atr);
    const swing = long ? Math.min(Number(s.lo20), Number(s.ema20)) : Math.max(Number(s.hi20), Number(s.ema20));
    let stopDist = Math.abs(px - (swing - (long ? 1 : -1) * 0.8 * atr));
    stopDist = Math.min(Math.max(stopDist, px * 0.0035), px * 0.048);
    const stop = long ? px - stopDist : px + stopDist;
    const tp1 = long ? px + 2 * stopDist : px - 2 * stopDist;
    const conf = Math.min(0.7, 0.45 + 0.1 * Math.min(1, (s.volRatio - 0.6) / 0.4) + Math.max(0, s.volRatio - 1) * 0.1);
    return finish({
      action: 'PROPOSE',
      direction: dir,
      confidence: Math.round(conf * 100) / 100,
      headline: `${long ? '多头' : '空头'}突破位就在眼前,市价${long ? '做多' : '做空'}`,
      thesis: `1h 与 4h 同向${long ? '偏多' : '偏空'},${tf} 价在 EMA20 ${long ? '上' : '下'}且贴近 20 根${long ? '高' : '低'}点 ${level},量比 ${s.volRatio.toFixed(2)} 达标,按突破-回踩 playbook ${long ? '做多' : '做空'}。`,
      reasons: [trendReason, posReason, `资金与 OI 证据新鲜,未标 STALE [${p.lastRef}]`],
      invalidation: `${tf} 收盘${long ? '跌回' : '升回'} 20根${long ? '低' : '高'} ${long ? s.lo20 : s.hi20} 另一侧`,
      invalidation_price: stop.toFixed(d),
      target_price: tp1.toFixed(d),
      watch_conditions: watch,
      proposal: { direction: dir, entry: 'market', limit_price: null, entry_zone: null, stop_price: stop.toFixed(d), take_profits: [tp1.toFixed(d)], rationale: `止损放在 swing ${long ? '低' : '高'}外 0.8 ATR,止盈 2 倍止损距离` },
    });
  }
  if (withTrend || near) {
    const why = stale ? '市场证据已 STALE,不能作为开仓依据' : !p.allowed.includes('PROPOSE') ? '当前不允许开仓' : !near ? `距 20根${long ? '高' : '低'}点仍有 ${dist.toFixed(2)}%` : s.volRatio < 0.6 ? `量比 ${s.volRatio.toFixed(2)} 不足` : '等待回踩确认';
    return finish({ action: 'WATCH', direction: dir, confidence: 0.35, headline: `${long ? '偏多' : '偏空'}结构成形,${stale ? '证据过期先观察' : '等突破确认'}`, thesis: `1h/4h 同向${long ? '偏多' : '偏空'},但${why},继续观察。`, reasons: [trendReason, posReason, `${why} [${s.ref}]`], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: watch, proposal: null });
  }
  return finish({ action: 'NO_TRADE', direction: null, confidence: 0.2, headline: '趋势方向与价格位置不符,不交易', thesis: `1h/4h 同向${long ? '偏多' : '偏空'},但 ${tf} 价格在 EMA20 ${s.aboveEma20 ? '上' : '下'}方且离 20 根${long ? '高' : '低'}点较远,夹在均线之间,不参与。`, reasons: [trendReason, posReason], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: watch, proposal: null });
}

function reviewJudgment(p: Parsed, tf: string): string {
  const t = p.thread!;
  const s = p.structures.get(tf);
  const h1 = p.structures.get('1h');
  const h4 = p.structures.get('4h');
  const last = Number(p.last);
  const long = t.side === 'long';
  const pick = (a: string, fallback: string): string => (p.allowed.includes(a) ? a : p.allowed.includes(fallback) ? fallback : 'HOLD');
  const priceReason = `最新价 ${p.last} [${p.lastRef}]`;
  const trendAgainst = h1 && h4 ? h1.bullish === h4.bullish && h1.bullish !== long : false;
  const trendReason = h1 && h4 ? `1h EMA20 ${h1.ema20} ${h1.bullish ? '>' : '<'} EMA50 ${h1.ema50},4h EMA20 ${h4.ema20} ${h4.bullish ? '>' : '<'} EMA50 ${h4.ema50} [${h1.ref}][${h4.ref}]` : `结构证据不完整 [${p.lastRef}]`;
  const base = { direction: t.side, invalidation: t.stop ? `${tf} 收盘${long ? '跌破' : '升破'}止损 ${t.stop}` : null, invalidation_price: t.stop, target_price: t.tp, watch_conditions: ['止损/止盈是否触及', '1h/4h 是否仍同向'] };
  if (t.status === 'in_position') {
    const stop = t.stop ? Number(t.stop) : null;
    const tp = t.tp ? Number(t.tp) : null;
    const entry = t.filled ? Number(t.filled) : null;
    if (stop !== null && (long ? last <= stop : last >= stop)) {
      return finish({ ...base, action: pick('INVALIDATE', 'EXIT'), confidence: 0.8, headline: '价格已穿越止损,论点失效', thesis: `最新价 ${p.last} 已在止损 ${t.stop} 的另一侧,失效条件成立,立即离场。`, reasons: [`${priceReason},止损 ${t.stop} 已被穿越`, trendReason], proposal: null });
    }
    if (tp !== null && (long ? last >= tp : last <= tp)) {
      return finish({ ...base, action: pick('EXIT', 'REDUCE'), confidence: 0.7, headline: '已到止盈位,落袋', thesis: `最新价 ${p.last} 已达到止盈 ${t.tp},按计划离场。`, reasons: [`${priceReason},止盈 ${t.tp} 已触及`], proposal: null });
    }
    if (trendAgainst) {
      return finish({ ...base, action: pick('EXIT', 'INVALIDATE'), confidence: 0.65, headline: '1h/4h 已同向反转,离场', thesis: `多周期结构已转为${long ? '偏空' : '偏多'},与持仓方向相反,论点不再成立。`, reasons: [trendReason, priceReason], proposal: null });
    }
    const stopDist = stop !== null && entry !== null ? Math.abs(entry - stop) : null;
    const gain = entry !== null ? (long ? last - entry : entry - last) : null;
    const weak = s ? (long ? !s.bullish : s.bullish) : false;
    if (stopDist !== null && gain !== null && gain >= stopDist && weak && p.allowed.includes('REDUCE')) {
      return finish({ ...base, action: 'REDUCE', confidence: 0.6, headline: '浮盈超 1R 且短周期转弱,减半', thesis: `最新价 ${p.last} 相对成交价 ${t.filled} 的浮盈已超过一倍止损距离,${tf} EMA20 ${s!.ema20} ${s!.bullish ? '>' : '<'} EMA50 ${s!.ema50} 结构转弱,减半锁定。`, reasons: [`${priceReason},成交 @ ${t.filled}`, `${tf} EMA20 ${s!.ema20} ${s!.bullish ? '>' : '<'} EMA50 ${s!.ema50} [${s!.ref}]`], proposal: null });
    }
    return finish({ ...base, action: 'HOLD', confidence: 0.55, headline: '论点未变,继续持有', thesis: `最新价 ${p.last} 仍在止损 ${t.stop ?? '无'} 与止盈 ${t.tp ?? '无'} 之间,多周期未反转,继续持有。`, reasons: [priceReason, trendReason], proposal: null });
  }
  // pending_entry
  const limit = t.limit ? Number(t.limit) : null;
  const atr1h = h1 ? Number(h1.atr) : null;
  if (limit !== null && atr1h !== null && Math.abs(last - limit) > 1.5 * atr1h) {
    return finish({ ...base, action: pick('INVALIDATE', 'HOLD'), confidence: 0.7, headline: '价格已远离入场区,撤单', thesis: `最新价 ${p.last} 距限价 ${t.limit} 已超过 1.5 个 1h ATR(${h1!.atr}),入场区失效。`, reasons: [`${priceReason},限价 ${t.limit}`, `1h ATR14 ${h1!.atr} [${h1!.ref}]`], proposal: null });
  }
  if (trendAgainst) {
    return finish({ ...base, action: pick('INVALIDATE', 'HOLD'), confidence: 0.65, headline: '结构已坏,撤单', thesis: `1h/4h 已同向转为${long ? '偏空' : '偏多'},挂单方向不再成立。`, reasons: [trendReason, priceReason], proposal: null });
  }
  return finish({ ...base, action: 'HOLD', confidence: 0.5, headline: '结构未坏,继续等成交', thesis: `最新价 ${p.last} 仍在入场区附近,1h/4h 方向未反转,继续等待。`, reasons: [priceReason, trendReason], proposal: null });
}

/**
 * 定向用例的脚本判断:playbook 里写 `[[STUB_JUDGMENT]] {…}` 就原样返回那个 JSON。
 * 闸覆盖用例需要「必然踩线」的判断(止损放错侧、信心 0.30、ADD …),规则桩推不出这些;脚本写在
 * playbook 里而不是 harness 里,是为了让它跟着 context 一起被记录下来,重放时看得见。
 */
export function scriptedJudgment(system: string): string | null {
  const m = /\[\[STUB_JUDGMENT\]\]\s*(\{[\s\S]*\})\s*\[\[\/STUB_JUDGMENT\]\]/.exec(system);
  return m ? m[1]! : null;
}

/** Pure function of the prompt text: same context → same JSON, byte for byte. */
export function stubJudge(_system: string, user: string): string {
  const scripted = scriptedJudgment(_system);
  if (scripted) return scripted;
  const p = parseContext(user);
  const tfM = /^E\d+ \[(\S+) 最近 4 根\]/m.exec(user);
  const tf = tfM?.[1] ?? '15m';
  if (p.thread && p.allowed.length) return reviewJudgment(p, tf);
  if (p.halted || p.allowed.length === 0) {
    return finish({ action: 'NO_TRADE', direction: null, confidence: 0.1, headline: '紧急停止中,不开仓', thesis: '系统处于紧急停止,只允许降低风险;无持仓,故不交易。', reasons: [`紧急停止,不开仓 [${p.lastRef}]`], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: ['等待解除紧急停止'], proposal: null });
  }
  return scanJudgment(p, tf);
}

export function evalStubBrain(): demo.Brain {
  return demo.stubBrain(stubJudge);
}
