/**
 * 服务「交易计划把关」(plan_gate):买方给一笔计划(symbol/side/entry/stop/targets/timeframe/market),
 * 先过确定性代码门槛,全部硬门槛通过才问 Jev(deps.judge,钉住的决策连接 + 每 job 原子预算),
 * 结论只有 follow / skip / uncertain + 每条门槛数值 + 一句话依据。只给分析与依据,不下指令、不碰交易所。
 *
 * 硬门槛(不过 = skip,且不花 Jev 的钱):止损方向、加权盈亏比 ≥1.5、止损距离 0.5–4 ATR(14)、入场离最新收盘 ≤3 ATR 且计划未失效。
 * 软门槛(不过 = 最多 uncertain):日线状态顺势、24h 成交额(可选依赖)。
 * Jev 没绑定 / 调用失败 → 只按代码门槛给结论,并在交付里写明「Jev 未参与」。
 */
import { atr14, BARS_LIMIT, closedBars, JEV_TIMEFRAMES, parsePlan, serviceCandidate, TF_MS, weightedRR } from './jev-probability.js';
import { deliverable, num, pct } from './render.js';
import { ServiceInputError, type PerCallService, type ServiceDeps } from './types.js';
import type { JudgeResult } from '../../research/judge/types.js';

export interface PlanGateParams { symbol: string; side: 'long' | 'short'; entry: number; stop: number; targets: number[]; timeframe: string; market: 'spot' | 'perp' }
export interface PlanGateDeps extends ServiceDeps {
  /** 可选:24h 成交额(USDT);取不到返回 null → 流动性门槛记为 n/a */
  quoteVolume24h?(symbol: string, market: 'spot' | 'perp'): Promise<number | null>;
}
export const PLAN_GATE_LIMITS = { min_rr: 1.5, stop_atr_min: 0.5, stop_atr_max: 4, max_entry_drift_atr: 3, min_quote_vol_24h: 2_000_000 } as const;

export type GateStatus = 'pass' | 'fail' | 'warn' | 'n/a';
export interface GateRow { key: string; label: string; hard: boolean; status: GateStatus; value: number | string | null; threshold: string; note: string }
export type PlanVerdict = 'follow' | 'skip' | 'uncertain';

const VERDICT_TEXT: Record<PlanVerdict, string> = { follow: '可跟随 follow', skip: '不跟随 skip', uncertain: '不确定 uncertain' };
const STATUS_MARK: Record<GateStatus, string> = { pass: '✓', fail: '✗', warn: '!', 'n/a': '—' };

export const planGateService: PerCallService<PlanGateParams> = {
  key: 'plan_gate',
  validate(job) {
    const p = parsePlan(job, { inferSide: false });
    if (!p.symbol) throw new ServiceInputError('symbol_missing', '缺少标的 / symbol is required');
    if (!p.side) throw new ServiceInputError('side_missing', '缺少方向(long / short) / side is required');
    if (p.entry === null) throw new ServiceInputError('entry_missing', '缺少入场价 / entry is required');
    if (p.stop === null) throw new ServiceInputError('stop_missing', '缺少止损价 / stop is required');
    if (!(JEV_TIMEFRAMES as readonly string[]).includes(p.timeframe)) throw new ServiceInputError('timeframe_invalid', `timeframe 只能是 ${JEV_TIMEFRAMES.join(' / ')}`);
    return { symbol: p.symbol, side: p.side, entry: p.entry, stop: p.stop, targets: p.targets, timeframe: p.timeframe, market: p.market };
  },
  async handle(job, params, deps: PlanGateDeps) {
    const tf_ms = TF_MS[params.timeframe]!;
    const { bars, as_of } = closedBars(await deps.bars(params.symbol, params.timeframe, BARS_LIMIT, params.market), tf_ms, deps.now());
    const last = Number(bars.at(-1)!.close), atr = atr14(bars), dir = params.side === 'long' ? 1 : -1;
    if (!(atr > 0)) throw new Error('atr_unavailable');
    const { entry, stop } = params, risk = Math.abs(entry - stop);
    const { rr, valid } = weightedRR(params.side, entry, stop, params.targets);
    const L = PLAN_GATE_LIMITS, gates: GateRow[] = [];

    const sideOk = (entry - stop) * dir > 0;
    gates.push({ key: 'stop_side', label: '止损方向 / stop side', hard: true, status: sideOk ? 'pass' : 'fail', value: stop, threshold: params.side === 'long' ? 'stop < entry' : 'stop > entry', note: sideOk ? '' : '止损在入场的错误一侧' });

    gates.push({
      key: 'reward_risk', label: '加权盈亏比 / weighted RR', hard: true,
      status: rr === null ? 'fail' : rr >= L.min_rr ? 'pass' : 'fail', value: rr, threshold: `≥ ${L.min_rr}`,
      note: !params.targets.length ? '没给目标位,无法计算' : valid.length < params.targets.length ? `${params.targets.length - valid.length} 个目标在错误一侧,已忽略` : '等权',
    });

    const stopAtr = risk / atr;
    gates.push({ key: 'stop_atr', label: '止损距离 / stop distance (ATR14)', hard: true, status: stopAtr >= L.stop_atr_min && stopAtr <= L.stop_atr_max ? 'pass' : 'fail', value: stopAtr, threshold: `${L.stop_atr_min}–${L.stop_atr_max} ATR`, note: stopAtr < L.stop_atr_min ? '太近,容易被正常波动扫掉' : stopAtr > L.stop_atr_max ? '太远,单笔风险过大' : '' });

    const drift = Math.abs(entry - last) / atr;
    const invalidated = (last - stop) * dir <= 0 ? '最新收盘已越过止损' : valid.length && (last - valid[0]!) * dir >= 0 ? '最新收盘已到达第一目标' : '';
    gates.push({ key: 'entry_fresh', label: '计划时效 / entry freshness', hard: true, status: !invalidated && drift <= L.max_entry_drift_atr ? 'pass' : 'fail', value: drift, threshold: `|entry − close| ≤ ${L.max_entry_drift_atr} ATR`, note: invalidated || (drift > L.max_entry_drift_atr ? '入场离现价太远,计划可能已陈旧' : `最新收盘 ${num(last, 6)}`) });

    const regime = await deps.regime(params.symbol).catch(() => null);
    const aligned = regime && (regime.regime === 'bull' && params.side === 'long' || regime.regime === 'bear' && params.side === 'short');
    const counter = regime && (regime.regime === 'bull' && params.side === 'short' || regime.regime === 'bear' && params.side === 'long');
    gates.push({
      key: 'regime', label: '日线顺势 / daily regime', hard: false,
      status: !regime ? 'n/a' : aligned || regime.regime === 'range' ? 'pass' : 'warn', value: regime?.regime ?? null, threshold: '顺势或震荡',
      note: !regime ? '日线状态取不到' : counter ? '逆日线方向' : regime.regime === 'volatile' ? '日线高波动' : regime.regime === 'range' ? '震荡市,方向中性' : '顺势',
    });

    const qv = deps.quoteVolume24h ? await deps.quoteVolume24h(params.symbol, params.market).catch(() => null) : null;
    gates.push({ key: 'liquidity', label: '24h 成交额 / liquidity', hard: false, status: qv === null ? 'n/a' : qv >= L.min_quote_vol_24h ? 'pass' : 'warn', value: qv, threshold: `≥ ${L.min_quote_vol_24h} USDT`, note: qv === null ? '未检查' : qv < L.min_quote_vol_24h ? '成交额偏低,滑点风险' : '' });

    const hardFail = gates.filter((g) => g.hard && g.status === 'fail');
    const warns = gates.filter((g) => g.status === 'warn');

    // Jev:硬门槛全过才问(省钱);没绑定 / 失败 → 只看代码门槛
    let jev: JudgeResult | null = null, jevNote = '';
    if (hardFail.length) jevNote = '硬门槛未过,未调用 Jev';
    else if (!deps.judge) jevNote = 'Jev 未绑定';
    else {
      try {
        const candidate = serviceCandidate({ symbol: params.symbol, as_of, timeframe_ms: tf_ms, direction: params.side, entry, stop, target: valid[0] ?? null, reward_risk: rr });
        jev = await deps.judge(candidate, bars, `asp:plan_gate:${job.job_id}`);
        if (!jev) jevNote = 'Jev 不可用';
        else if (jev.status === 'error') { jevNote = `Jev 调用失败(${jev.reason_codes.join(',')})`; }
      } catch (e) { jev = null; jevNote = `Jev 调用失败(${(e as Error).message})`; }
    }
    const jevUsed = !!jev && jev.status !== 'error';
    const take = jevUsed ? jev!.answers.find((a) => a.question_key === 'take')?.probabilities['yes'] ?? null : null;

    let verdict: PlanVerdict, basis: string;
    const warnText = warns.map((g) => g.note || g.key).join('、');
    if (hardFail.length) { verdict = 'skip'; basis = `硬门槛未过:${hardFail.map((g) => `${g.label.split(' /')[0]}${g.note ? `(${g.note})` : ''}`).join('、')}`; }
    else if (jevUsed && jev!.status === 'uncertain') { verdict = 'uncertain'; basis = `代码门槛通过,Jev 落在阈值边缘(take=${pct(take)})`; }
    else if (jevUsed && jev!.action === 'skip') { verdict = 'skip'; basis = `代码门槛通过,但 Jev 判断不支持(take=${pct(take)})`; }
    else if (warns.length) { verdict = 'uncertain'; basis = `硬门槛通过${jevUsed ? `、Jev 支持(take=${pct(take)})` : ''},但有软门槛提示:${warnText}`; }
    else { verdict = 'follow'; basis = `硬门槛全部通过(盈亏比 ${num(rr)}、止损 ${num(stopAtr)} ATR)${jevUsed ? `,Jev 支持(take=${pct(take)})` : ''}`; }
    if (!jevUsed) basis += `;Jev 未参与(${jevNote}),结论只基于代码门槛`;

    const summary = `${params.symbol} ${params.side} ${params.timeframe} 计划把关 / plan gate: ${VERDICT_TEXT[verdict]}`;
    const lines = [
      `计划 / plan: ${params.side} 入场 ${num(entry, 6)} 止损 ${num(stop, 6)} 目标 ${params.targets.length ? params.targets.map((t) => num(t, 6)).join('/') : '—'} · ${params.market} ${params.timeframe} · ATR14 ${num(atr, 6)}`,
      ...gates.map((g) => `${STATUS_MARK[g.status]} ${g.label}: ${typeof g.value === 'number' ? num(g.value) : g.value ?? '—'}(${g.threshold})${g.note ? ` ${g.note}` : ''}`),
      jevUsed
        ? `Jev(AI 模型生成 / AI-generated): ${jev!.answers.map((a) => `${a.question_key} ${Object.entries(a.probabilities).map(([l, p]) => `${l} ${pct(p)}`).join('/')}`).join(' · ')} · 模型 ${jev!.model_revision ?? '—'} · 成本 ${jev!.cost_usd === null ? '未知' : `$${jev!.cost_usd}`}`
        : `Jev 未参与 / Jev not involved: ${jevNote}`,
      `依据 / basis: ${basis}`,
    ];
    return deliverable(job, 'plan_gate', '【交易计划把关 / Trade Plan Gate】 Trading Swarm', summary, lines, {
      verdict, basis, as_of,
      plan: { symbol: params.symbol, side: params.side, entry, stop, targets: params.targets, valid_targets: valid, timeframe: params.timeframe, market: params.market },
      market_state: { last_close: last, atr14: atr, regime: regime ? { regime: regime.regime, text: regime.text, as_of: regime.as_of } : null, quote_vol_24h: qv },
      gates, limits: L,
      jev: jevUsed
        ? { involved: true, status: jev!.status, action: jev!.action, take_yes: take, answers: jev!.answers, predicates: jev!.predicates, model_revision: jev!.model_revision, cost_usd: jev!.cost_usd, cost_status: jev!.cost_status, decision_id: jev!.decision_id }
        : { involved: false, note: jevNote, reason_codes: jev?.reason_codes ?? [] },
      method: '确定性代码门槛(止损方向/加权盈亏比/ATR 止损距离/计划时效/日线状态/流动性)+ 硬门槛全过才调用 Jev(research/judge 同一路径)',
    });
  },
};
