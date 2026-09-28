/**
 * Jev 判断流的纯函数(有单测,test/judge-live.test.tsx)。文案 key = 中文原文,英文在 ./i18n-en.ts。
 */
import type { JudgeLiveItem, JudgeLiveRecord, JudgeLiveSummary } from '@/api/judge-live';
import { t, tmap } from '@/lib/i18n';

export const QUESTION_LABEL: Record<string, string> = tmap({
  take: '该不该做',
  quality: '候选质量',
  support_holds: '支撑守得住',
  resistance_breaks: '突破阻力',
  retreat_risk: '回撤触损',
  regime_fit: '行情相容',
});
export const ANSWER_LABEL: Record<string, string> = tmap({ yes: '是', no: '否', poor: '差', fair: '一般', good: '好', excellent: '很好' });
export const MODE_LABEL: Record<JudgeLiveRecord['mode'], string> = tmap({ shadow: '影子', gate: '挡单' });
export const STATUS_LABEL: Record<JudgeLiveRecord['status'], string> = tmap({ ok: '已判断', uncertain: '拿不准', error: '出错', skipped: '没调用' });
export const REASON_LABEL: Record<string, string> = tmap({
  decision_model_unbound: '决策模型没绑定',
  decision_model_unavailable: '决策模型不可用',
  shadow_budget_exhausted: '今天的影子判断预算用完了',
  shadow_busy: '同时在判断的太多,这条跳过',
  judge_runtime_missing: '判断运行时缺失,按不跟处理',
  judge_history_missing: 'K 线历史不够',
  judge_timeout_or_cancelled: '判断超时或被取消',
  margin_abstain: '概率贴着门槛,拿不准',
  rule_skip: '没过规则门槛',
  model_revision_mismatch: '模型版本对不上',
  cancelled: '已取消',
});
export const FEATURE_LABEL: Record<string, string> = tmap({
  direction: '方向', stop_distance_atr: '止损距离(ATR)', reward_risk: '盈亏比', reference: '参考价', support: '支撑', resistance: '阻力', stop: '止损', target: '目标',
  trend: '趋势', volatility: '波动率', volume_ratio: '量比', market_regime: '行情状态',
  ob_imbalance_05: '盘口失衡(±0.5%)', ob_wall_up: '上方挂单墙', ob_wall_down: '下方挂单墙', spread_bps: '价差(bp)', liq_long_5m: '近 5 分钟多头清算', liq_short_5m: '近 5 分钟空头清算',
});
const VALUE_LABEL: Record<string, string> = tmap({ long: '多', short: '空', up: '向上', down: '向下', volatile: '剧烈波动' });

export function questionLabel(key: string): string { return QUESTION_LABEL[key] ?? key; }
export function answerLabel(label: string): string { return ANSWER_LABEL[label] ?? label; }
export function reasonLabel(code: string): string { return REASON_LABEL[code] ?? code; }

export interface ProbSegment { label: string; name: string; p: number }
export interface QuestionRow { key: string; name: string; instructions: string; segments: ProbSegment[]; top: ProbSegment | null; passed: boolean | null }
/** 每个问题一行:按标签顺序的概率段(是/否,或 差/一般/好/很好)+ 最高的那个标签;规则判定过没过(影子也照规则算) */
export function questionRows(item: Pick<JudgeLiveRecord, 'questions' | 'answers' | 'predicates'>): QuestionRow[] {
  return item.questions.map(q => {
    const probs = item.answers.find(a => a.question_key === q.key)?.probabilities ?? null;
    const segments = probs ? q.labels.map(l => ({ label: l, name: answerLabel(l), p: clamp01(probs[l] ?? 0) })) : [];
    const top = segments.reduce<ProbSegment | null>((best, s) => (!best || s.p > best.p ? s : best), null);
    const preds = item.predicates.filter(p => p.question_key === q.key);
    return { key: q.key, name: questionLabel(q.key), instructions: q.instructions, segments, top, passed: preds.length ? preds.every(p => p.passed) : null };
  });
}
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function pct(p: number | null | undefined): string { return p == null || !Number.isFinite(p) ? '—' : `${Math.round(p * 100)}%`; }
/** 美元十进制字符串;很小的数保留有效位 */
export function fmtUsd(v: string | null | undefined): string {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toPrecision(2).replace(/\.?0+$/, '')}`;
  return `$${n.toFixed(2)}`;
}
export function fmtR(r: number | null | undefined): string { return r == null || !Number.isFinite(r) ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`; }

/** 一条判断的结论:跟 / 不跟 / 没调用 / 出错(影子判断只是「Jev 会怎么选」) */
export function verdict(item: Pick<JudgeLiveRecord, 'status' | 'action' | 'mode'>): { text: string; tone: 'up' | 'down' | 'muted' | 'warn' } {
  if (item.status === 'skipped' && item.mode === 'shadow') return { text: t('没调用'), tone: 'muted' };
  if (item.status === 'error') return { text: item.mode === 'gate' ? t('出错 · 不跟') : t('出错'), tone: 'warn' };
  if (item.action === 'follow') return { text: t('跟'), tone: 'up' };
  if (item.action === 'skip') return { text: item.status === 'uncertain' ? t('拿不准 · 不跟') : t('不跟'), tone: 'down' };
  return { text: '—', tone: 'muted' };
}
export function directionText(d: 'long' | 'short'): string { return d === 'long' ? t('多') : t('空'); }

export function featureValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
  if (typeof v === 'string') return VALUE_LABEL[v] ?? v;
  if (typeof v === 'object' && 'price' in (v as object)) { const w = v as { price: string; notional: string }; return t('{price}(约 {usd} U)', { price: w.price, usd: Math.round(Number(w.notional)) }); }
  return JSON.stringify(v);
}
export function stateRows(state: JudgeLiveRecord['state']): { key: string; name: string; value: string }[] {
  if (!state) return [];
  return [...Object.entries(state.candidate), ...Object.entries(state.features)].map(([k, v]) => ({ key: k, name: FEATURE_LABEL[k] ?? k, value: featureValue(v) }));
}
/** 盘口 / 清算两项可用性 + 是否带进问题 */
export function microBadges(state: JudgeLiveRecord['state']): { key: 'book' | 'liquidations' | 'used'; text: string; ok: boolean }[] {
  const m = state?.micro;
  if (!m) return [{ key: 'book', text: t('盘口:不知道'), ok: false }, { key: 'liquidations', text: t('清算:不知道'), ok: false }];
  return [
    { key: 'book', text: m.book ? t('盘口:可用') : t('盘口:不可用'), ok: m.book },
    { key: 'liquidations', text: m.liquidations ? t('清算:可用') : t('清算:不可用'), ok: m.liquidations },
    { key: 'used', text: m.used ? t('已带进问题') : t('没带进问题'), ok: m.used },
  ];
}
export function microNote(note: string | null | undefined): string | null {
  if (!note) return null;
  const map: Record<string, string> = { no_recording: t('录制器没覆盖这个币/时段'), no_source: t('没接录制源'), liquidation_coverage_missing: t('清算录制覆盖不全'), book_stale_or_missing: t('盘口快照过期或缺失') };
  const head = note.split(':')[0]!;
  return map[head] ?? note;
}

export function outcomeText(item: JudgeLiveItem): string | null {
  const o = item.outcome;
  if (o === undefined) return null;
  if (!o) return t('没关联到线程');
  if (o.closed) return o.realized_r == null ? t('已平仓,等结算') : t('已平仓 {r}', { r: fmtR(o.realized_r) });
  return o.opened ? t('持仓中') : t('挂单中');
}

export function summaryLine(s: JudgeLiveSummary | undefined): { calls: string; cost: string; ratio: string; modes: string } {
  if (!s) return { calls: '—', cost: '—', ratio: '—', modes: '—' };
  const x = s.today;
  return {
    calls: String(x.calls),
    cost: Number(x.reserved_usd) > 0 ? t('{cost}(另预留 {reserved})', { cost: fmtUsd(x.cost_usd), reserved: fmtUsd(x.reserved_usd) }) : fmtUsd(x.cost_usd),
    ratio: x.follow + x.skip ? t('跟 {f} / 不跟 {s}({pct})', { f: x.follow, s: x.skip, pct: pct(x.follow_ratio) }) : '—',
    modes: t('影子 {a} · 挡单 {b}', { a: x.shadow, b: x.gate }),
  };
}
/** 影子判断和实际结果的对照:一句话 */
export function comparisonLine(s: JudgeLiveSummary | undefined): string | null {
  if (!s) return null;
  const { follow, skip } = s.comparison;
  if (!follow.closed && !skip.closed) return follow.judged + skip.judged ? t('影子判断还没有能对上的平仓结果') : null;
  return t('近 30 天:Jev 说跟的平仓 {fn} 笔、平均 {fr};说不跟的平仓 {sn} 笔、平均 {sr}', { fn: follow.closed, fr: fmtR(follow.avg_r), sn: skip.closed, sr: fmtR(skip.avg_r) });
}
