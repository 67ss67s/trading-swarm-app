/**
 * 回测报告的数字口径与指标定义表。
 * 契约里收益 / 回撤 / 胜率 / 敞口 / 单笔收益一律是**小数**(0.0737 = 7.37%);drawdown 是正数幅度,
 * max_drawdown 正负都可能 —— 视图统一显示成红色负数。null / NaN 一律 '—'。
 */
import type { BacktestAsset, BacktestMetrics, BacktestReport, BacktestScoreLabel } from '@trade-gate/contracts';
import { getLang, t, tmap } from '@/lib/i18n';

export type MetricKey = keyof BacktestMetrics;

/** kind 决定格式与配色:
 *  ret     有正负的收益(小数)→ +7.37% 红绿
 *  dd      回撤(小数)→ 永远 −x.xx% 红色
 *  frac    0..1 的占比(胜率 / 敞口 / 回撤时间占比)→ 7.37% 中性色
 *  ratio   比率(夏普 / 盈亏比)→ 0.95 中性色
 *  signed  有正负的比率(alpha 以外的无量纲,比如 beta)→ 0.95 中性色
 *  int     计数
 *  dur     毫秒时长
 *  usd     金额 → +$737 红绿
 *  fee     手续费 → $12.30 中性色 */
export type MetricKind = 'ret' | 'dd' | 'frac' | 'ratio' | 'signed' | 'int' | 'dur' | 'usd' | 'fee';

export interface MetricDef {
  key: MetricKey;
  label: string;
  kind: MetricKind;
  /** tooltip:这个数怎么算、怎么读 */
  help: string;
  /** 是否是「越低越差」的负向指标(比如平均亏损):显示红色 */
  negative?: boolean;
}

function def(key: MetricKey, label: string, kind: MetricKind, help: string, negative?: boolean): MetricDef {
  return { key, label, kind, help, negative };
}

/** 截图那 12 项(两行 × 6),顺序与 Horizon 一致。用函数返回,保证每次读到当前语言。 */
export function primaryMetricDefs(): MetricDef[] {
  return [
    def('total_return', t('总收益'), 'ret', t('整个回测窗口的累计收益 = 期末权益 / 初始资金 − 1,已扣手续费与滑点。')),
    def('max_drawdown', t('最大回撤'), 'dd', t('权益从历史高点回落的最大幅度。永远显示为负数。')),
    def('sharpe', t('夏普比率'), 'ratio', t('每根 K 线收益的均值 / 标准差,按周期年化。无成交或波动为 0 时不计算。')),
    def('win_rate', t('胜率'), 'frac', t('盈利笔数 / 总成交笔数(按平仓后的净盈亏判定)。')),
    def('profit_factor', t('盈亏因子'), 'ratio', t('全部盈利单的盈利总额 / 全部亏损单的亏损总额。没有亏损单时不计算。')),
    def('sortino', t('索提诺比率'), 'ratio', t('和夏普一样,但分母只用下跌波动(负收益的标准差),不惩罚上涨波动。')),
    def('avg_win', t('平均盈利'), 'ret', t('盈利单的平均单笔收益率。')),
    def('avg_loss', t('平均亏损'), 'ret', t('亏损单的平均单笔收益率(负数)。'), true),
    def('risk_reward', t('盈亏比'), 'ratio', t('平均盈利 / |平均亏损|。没有盈利单或亏损单时不计算。')),
    def('max_win_streak', t('最长连胜'), 'int', t('按平仓顺序连续盈利的最多笔数。')),
    def('time_in_drawdown', t('回撤时间占比'), 'frac', t('权益低于历史高点的 K 线根数占全部根数的比例。')),
    def('max_loss_streak', t('最长连亏'), 'int', t('按平仓顺序连续亏损的最多笔数。')),
  ];
}

/** 「更多指标」:契约里其余全部 BacktestMetrics 字段。 */
export function moreMetricDefs(): MetricDef[] {
  return [
    def('cagr', t('年化收益 CAGR'), 'ret', t('复合年增长率 =(1 + 总收益)^(1 / 年数)− 1,年数按窗口实际跨度算。')),
    def('calmar', t('卡玛比率'), 'ratio', t('年化收益 / |最大回撤|。')),
    def('volatility', t('年化波动率'), 'frac', t('每根 K 线收益的标准差,按周期年化。')),
    def('expectancy', t('单笔期望'), 'ret', t('全部成交的平均单笔收益率(胜率 × 平均盈利 + 败率 × 平均亏损)。')),
    def('best_trade', t('最佳单笔'), 'ret', t('收益率最高的一笔。')),
    def('worst_trade', t('最差单笔'), 'ret', t('收益率最低的一笔。')),
    def('trades', t('成交笔数'), 'int', t('窗口内平仓完成的交易笔数(未平仓的不计)。')),
    def('avg_holding_ms', t('平均持仓时长'), 'dur', t('从入场成交到出场成交的平均时长。')),
    def('time_in_market', t('持仓时间占比'), 'frac', t('有持仓的 K 线根数占全部根数的比例。')),
    def('exposure', t('平均敞口'), 'frac', t('持仓市值 / 净值的逐根均值;带杠杆时可以超过 100%。')),
    def('fees', t('手续费合计'), 'fee', t('全部成交的手续费之和(按执行参数里的费率)。')),
    def('net_pnl', t('净盈亏'), 'usd', t('期末权益 − 初始资金,已扣手续费与滑点。')),
    def('benchmark_return', t('持有基准收益'), 'ret', t('同一窗口买入并一直持有标的(篮子按同样权重)的收益,不扣费。')),
    def('excess_return', t('超额收益'), 'ret', t('总收益 − 持有基准收益。')),
    def('alpha', t('Alpha'), 'ret', t('相对持有基准回归得到的截距(剔除 beta 暴露后的收益)。')),
    def('beta', t('Beta'), 'signed', t('策略收益对持有基准收益的回归斜率:1 = 同涨同跌,0 = 无关。')),
    def('max_drawdown_duration_ms', t('最长回撤时长'), 'dur', t('权益从创出高点到重新站上该高点(或窗口结束)的最长时间。')),
  ];
}

export function allMetricDefs(): MetricDef[] {
  return [...primaryMetricDefs(), ...moreMetricDefs()];
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const MINUS = '−';

/** 小数 → 带符号百分比,两位小数:0.0737 → +7.37% */
export function pctSigned(v: unknown, digits = 2): string {
  const n = num(v);
  if (n === null) return '—';
  const s = Math.abs(n * 100).toFixed(digits);
  if (Number(s) === 0) return `${(0).toFixed(digits)}%`;
  return `${n > 0 ? '+' : MINUS}${s}%`;
}

/** 小数 → 不带正号的百分比(占比类):0.332 → 33.20% */
export function pctPlain(v: unknown, digits = 2): string {
  const n = num(v);
  if (n === null) return '—';
  return `${n < 0 ? MINUS : ''}${Math.abs(n * 100).toFixed(digits)}%`;
}

/** 回撤:永远负号(0 显示 0.00%) */
export function pctDrawdown(v: unknown, digits = 2): string {
  const n = num(v);
  if (n === null) return '—';
  const s = Math.abs(n * 100).toFixed(digits);
  return Number(s) === 0 ? `${(0).toFixed(digits)}%` : `${MINUS}${s}%`;
}

export function ratio(v: unknown, digits = 2): string {
  const n = num(v);
  if (n === null) return '—';
  return `${n < 0 ? MINUS : ''}${Math.abs(n).toFixed(digits)}`;
}

const usdFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const usdFmt2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 金额:+$737 / −$1,204;|v|<100 时保留两位小数 */
export function usdSigned(v: unknown): string {
  const n = num(v);
  if (n === null) return '—';
  const abs = Math.abs(n);
  const body = abs < 100 ? usdFmt2.format(abs) : usdFmt.format(abs);
  if (abs === 0) return '$0';
  return `${n > 0 ? '+' : MINUS}$${body}`;
}

export function usdPlain(v: unknown): string {
  const n = num(v);
  if (n === null) return '—';
  return `$${usdFmt2.format(n)}`;
}

export function durationMs(v: unknown): string {
  const n = num(v);
  if (n === null || n < 0) return '—';
  const h = n / 3_600_000;
  if (h < 1) return t('{n} 分钟', { n: Math.round(n / 60_000) });
  if (h < 48) return t('{n} 小时', { n: Math.round(h * 10) / 10 });
  const d = h / 24;
  if (d < 90) return t('{n} 天', { n: Math.round(d * 10) / 10 });
  return t('{n} 个月', { n: Math.round((d / 30.44) * 10) / 10 });
}

export function formatMetric(defn: Pick<MetricDef, 'kind'>, v: unknown): string {
  switch (defn.kind) {
    case 'ret':
      return pctSigned(v);
    case 'dd':
      return pctDrawdown(v);
    case 'frac':
      return pctPlain(v);
    case 'ratio':
    case 'signed':
      return ratio(v);
    case 'int': {
      const n = num(v);
      return n === null ? '—' : String(Math.round(n));
    }
    case 'dur':
      return durationMs(v);
    case 'usd':
      return usdSigned(v);
    case 'fee':
      return usdPlain(v);
  }
}

/** 语义色:收益 / 金额按正负红绿,回撤永远红,其余中性;null 灰。 */
export function metricTone(defn: Pick<MetricDef, 'kind' | 'negative'>, v: unknown): string {
  const n = num(v);
  if (n === null) return 'text-muted-foreground';
  if (defn.kind === 'dd') return n === 0 ? 'text-foreground' : 'text-down';
  if (defn.kind === 'ret' || defn.kind === 'usd') {
    if (n === 0) return 'text-foreground';
    return n > 0 ? 'text-up' : 'text-down';
  }
  return 'text-foreground';
}

export function toneOf(v: unknown): string {
  const n = num(v);
  if (n === null) return 'text-muted-foreground';
  if (n === 0) return 'text-foreground';
  return n > 0 ? 'text-up' : 'text-down';
}

// ---------------------------------------------------------------------------
// 日期

function locale(): string {
  return getLang() === 'en' ? 'en-US' : 'zh-CN';
}

/** 2020-01-01(UTC,回测 K 线都是 UTC 收盘) */
export function ymd(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function ymdhm(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${ymd(ms)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** 窗口跨度:6.7 年 / 45 天 */
export function spanLabel(fromMs: number, toMs: number): string {
  const days = (toMs - fromMs) / 86_400_000;
  if (days >= 365) return t('{n} 年', { n: Math.round((days / 365.25) * 10) / 10 });
  if (days >= 60) return t('{n} 个月', { n: Math.round(days / 30.44) });
  return t('{n} 天', { n: Math.round(days) });
}

export function monthShort(m: number): string {
  if (getLang() === 'en') return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m] ?? String(m + 1);
  return `${m + 1}月`; // i18n-ignore(en 在上一行已返回)
}

export function dateLocale(): string {
  return locale();
}

// ---------------------------------------------------------------------------
// 标签

export const SCORE_LABEL: Record<BacktestScoreLabel, string> = tmap({
  excellent: '优秀',
  good: '良好',
  fair: '一般',
  needs_work: '待改进',
  poor: '较差',
});

export function scoreTone(label: BacktestScoreLabel): { text: string; stroke: string } {
  if (label === 'excellent' || label === 'good') return { text: 'text-up', stroke: 'var(--up)' };
  if (label === 'fair') return { text: 'text-primary', stroke: 'var(--primary)' };
  if (label === 'needs_work') return { text: 'text-warn', stroke: 'var(--warn)' };
  return { text: 'text-down', stroke: 'var(--down)' };
}

export const CONFIDENCE_LABEL = tmap({ low: '低置信', medium: '中等置信', high: '高置信' });

export const SEGMENT_LABEL = tmap({ in_sample: '样本内', out_of_sample: '样本外' });

export function segmentLabel(name: string): string {
  return (SEGMENT_LABEL as Record<string, string>)[name] ?? name;
}

export const EXIT_REASON_LABEL: Record<string, string> = tmap({
  signal_exit: '信号离场',
  stop_loss: '止损',
  take_profit: '止盈',
  trailing_stop: '移动止损',
  time_exit: '到期离场',
  end_of_data: '窗口结束平仓',
  liquidation: '强平',
  manual: '手动',
});

export function exitReasonLabel(r: string): string {
  return EXIT_REASON_LABEL[r] ?? r;
}

export const SCORE_COMPONENT_LABEL: Record<string, string> = tmap({
  return: '收益',
  risk: '风险',
  consistency: '一致性',
  edge: '超额',
  robustness: '稳健性',
  sample: '样本量',
  drawdown: '回撤',
  trades: '成交数',
});

export function scoreComponentLabel(k: string): string {
  return SCORE_COMPONENT_LABEL[k] ?? k;
}

export const ASSET_STATUS_LABEL = tmap({ completed: '已完成', failed: '计算失败', data_missing: '数据缺失' });

// ---------------------------------------------------------------------------
// 资产与颜色

/** 资产色(dark surface 上经 dataviz 校验:明度带 / 色度 / 对比度通过,蓝紫一对 deutan ΔE 6.2 → 必须配图例 + 线型次编码)。
 *  顺序固定按资产在报告里的位置,颜色跟实体走,不跟排名。 */
export const ASSET_COLORS = ['#b58530', '#3f9ac2', '#a468e0', '#2aa76e', '#97a3b4', '#c94b3e'];

/** 单资产模式:策略线用站点 primary(荧光绿),基准用中性灰虚线 */
export const STRATEGY_COLOR = '#a6e146';
export const BENCHMARK_COLOR = '#aab4c3';

export function assetColor(report: Pick<BacktestReport, 'assets'>, key: string): string {
  const i = report.assets.findIndex((a) => a.key === key);
  return ASSET_COLORS[(i < 0 ? 0 : i) % ASSET_COLORS.length]!;
}

export function completedAssets(report: Pick<BacktestReport, 'assets'>): BacktestAsset[] {
  return report.assets.filter((a) => a.status === 'completed');
}

/** 默认资产:primary_key 对应的资产(即便它缺数据也选它,好把原因亮出来);没有就取第一个。 */
export function defaultAssetKey(report: Pick<BacktestReport, 'assets' | 'primary_key'>): string {
  return report.assets.find((a) => a.key === report.primary_key)?.key ?? report.assets[0]?.key ?? '';
}

export function hexAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * 每笔收益的稳健中心(与 gateway research/analyzer.ts centerStats 同口径):中位数(偶数取中间两个均值)、
 * 截尾均值(排序后两端各截 floor(n × 10%) 个;n < 10 时不截尾,截尾均值 = 均值)。平均值旁边必须同时给这两个。
 */
export function tradeCenter(values: number[], trim = 0.1): { n: number; median: number | null; trimmed_mean: number | null; trimmed_each_side: number } {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b), n = xs.length;
  if (!n) return { n, median: null, trimmed_mean: null, trimmed_each_side: 0 };
  const k = Math.floor(n * trim + 1e-9), kept = xs.slice(k, n - k);
  return { n, median: (xs[Math.floor((n - 1) / 2)]! + xs[Math.floor(n / 2)]!) / 2, trimmed_mean: kept.reduce((a, b) => a + b, 0) / kept.length, trimmed_each_side: k };
}
