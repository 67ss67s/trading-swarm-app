/** Presentation only: retain raw values and units; never change stored research results. */
export const METRIC_LABELS: Record<string, string> = {
  price_change: '价格变化', oi_change: '持仓量变化', funding_avg: '平均资金费率', funding_last: '最近一期资金费率',
  funding_pctile_vs_window: '最近费率在历史窗口的位置', liquidation_count: '已记录强平事件',
  buy_and_hold_return: '直接持有收益', strategy_net_return: '策略扣费后收益', close: '价格', price: '价格',
  oi_value_usd: '持仓名义金额', rate: '已结算资金费率', funding_rate: '已结算资金费率',
  get_liquidations: '已发生的强平', get_liquidation_estimates: '潜在清算区域', render_artifact: '图表生成',
  revise_strategy: '生成修订规则', run_strategy_revision: '验证候选版本', compare_strategy_runs: '对照原版与候选', build_research_report: '整理研究报告',
  compile_strategy: '策略规则检查', run_backtest: '历史回测', compare_buy_and_hold: '持有基准比较',
  research: '本次研究', symbol: '资产', beta: '大盘敏感度 β', alpha_annualized: '年化超额收益',
  residual_sharpe: '剔除大盘后的风险收益比', r_squared: '大盘解释比例', raw_return: '区间收益',
  return: '区间收益', max_drawdown: '最大回撤', residual_return: '剔除大盘后的收益', ts: '时间', close_time: '时间', oi_contracts: '未平仓合约数',
};
export const humanMetricName = (name: string): string => {
  if (METRIC_LABELS[name]) return METRIC_LABELS[name];
  const assetMetric = /^(okx:(?:spot|perp):[^:]+):([^:]+)$/.exec(name);
  return assetMetric ? `${assetMetric[1]!.replace(/^okx:(?:spot|perp):/, '').replace(/-USDT(?:-SWAP)?$/, '')} · ${METRIC_LABELS[assetMetric[2]!] ?? assetMetric[2]}` : name;
};
export function formatValue(value: unknown, unit?: string): string {
  if (value === null || value === undefined || value === '') return '—';
  const v = Number(value);
  if (!Number.isFinite(v)) return typeof value === 'string' ? value : '—';
  if (unit === 'fraction_per_year') return `${(v * 100).toFixed(2)}% / 年`;
  if (unit?.startsWith('fraction_per_')) return `${(v * 100).toFixed(4)}% / ${unit.slice('fraction_per_'.length)}`;
  if (unit === 'fraction') return `${(v * 100).toFixed(2)}%`;
  if (unit === '%' || unit === 'percent') return `${v.toFixed(2)}%`;
  if (unit === 'count') return `${v.toLocaleString('zh-CN')} 条`;
  if (unit === 'USD') return `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (unit === 'bps') return `${v.toFixed(2)} bps`;
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}
export function describeIssue(metric: string, availability: string, note?: string | null): { label: string; message: string; technical: boolean } {
  const raw = note ?? '';
  if (/BUDGET_EXHAUSTED/i.test(raw)) return { label: '预算已用完', message: '这一步没有完成，已有的结果仍可查看。', technical: true };
  if (/dependency_failed/i.test(raw)) return { label: '未执行', message: '前置步骤未完成，因此这一步尚未运行。', technical: true };
  if (/invalid_contract|SCHEMA_MISMATCH|schema|unmapped_required|must have|must NOT|unknown_field/i.test(raw)) return {
    label: '未完成', message: metric === 'compile_strategy' ? '策略规则暂时未通过检查，本轮没有执行这套策略。' : metric === 'render_artifact' ? '这张图的数据格式暂时不兼容，其余结果仍可查看。' : '执行参数未通过检查，这一步没有完成。', technical: true,
  };
  if (/TIMEOUT/i.test(raw)) return { label: '暂未完成', message: '处理超时，已有结果已保留。', technical: true };
  if (/CANCELLED/i.test(raw)) return { label: '已取消', message: '已停止后续研究，已完成的结果保留。', technical: true };
  const truncated = /truncated_to_recent_(\d+)/.exec(raw);
  if (truncated) return { label: '部分覆盖', message: `仅覆盖最近 ${truncated[1]} 条记录，不能代表整个研究窗口或全市场。`, technical: false };
  if (availability === 'not_applicable') return { label: '不适用', message: raw || '这项分析不适用于当前资产类型。', technical: false };
  if (availability === 'partial') return { label: '部分覆盖', message: raw || '只有部分时段或市场的数据，结论限于已有覆盖。', technical: false };
  if (availability === 'stale') return { label: '数据已过期', message: raw || '目前只能查看上次快照，不能作为最新市场状态。', technical: false };
  return { label: '数据暂缺', message: raw || '尚未接入所需数据，本次不生成这项分析。', technical: false };
}

/** Irregular/sparse series must be compared by timestamp, never by array index. */
export function nearestPoint(points: [number | string, number | null][], time: number): [number | string, number | null] | undefined {
  return points.reduce<[number | string, number | null] | undefined>((best, point) =>
    !Number.isFinite(Number(point[0])) ? best : !best || Math.abs(Number(point[0]) - time) < Math.abs(Number(best[0]) - time) ? point : best, undefined);
}

/** Recover legacy normalized series only when the retained rows cover every plotted timestamp. */
export function legacyRawPoints(series: { field?: string; transformed?: boolean; points: [number | string, number | null][] }, rows?: Record<string, unknown>[]): [number, number | null][] | null {
  if (!series.transformed || !series.field || !rows) return null;
  const field = series.field;
  const raw = rows.filter((r) => Object.hasOwn(r, field) && (r.ts ?? r.close_time) != null && Number.isFinite(Number(r.ts ?? r.close_time)))
    .map((r) => [Number(r.ts ?? r.close_time), r[field] == null || r[field] === '' || !Number.isFinite(Number(r[field])) ? null : Number(r[field])] as [number, number | null])
    .sort((a, b) => a[0] - b[0]);
  const available = new Set(raw.map(([ts]) => ts));
  return raw.length && series.points.every(([ts]) => available.has(Number(ts))) ? raw : null;
}

export function unitLabel(unit?: string): string {
  if (unit?.startsWith('fraction_per_')) return `% / ${unit.slice('fraction_per_'.length)}`;
  return unit === 'fraction' || unit === 'percent' ? '%' : unit ?? '';
}

/** Primary rule copy; exact parameters stay in the expandable original text. */
export function readableRuleText(text: string): string {
  return text.replace(/（[a-z_]+ [^）]*）$/, '').replace(/\bATR\b/g, '近期平均波动幅度').replace(/\bR\b/g, '初始止损距离的倍数').trim();
}
