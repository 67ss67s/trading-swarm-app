/**
 * 把报告里的 equity 点整理成图表要的线(纯函数,方便测试):
 *   单资产模式  策略面积线(primary 色)+ 可选持有基准虚线;0 笔成交时基准强制画出
 *   全部叠加    每个完成的资产一条策略线(资产色),基准开着时每个资产一条同色淡虚线
 * 状态不是 completed 的资产不画线(不画假线),放进 missing 让视图说明原因。
 */
import type { BacktestAsset, BacktestReport } from '@trading-swarm/contracts';
import { BENCHMARK_COLOR, STRATEGY_COLOR, assetColor, hexAlpha } from './format';

export const ALL_ASSETS = '__all__';

export interface LinePoint {
  /** 秒(lightweight-charts UTCTimestamp) */
  time: number;
  value: number;
}

export interface PnlLine {
  id: string;
  assetKey: string;
  label: string;
  role: 'strategy' | 'benchmark';
  color: string;
  dashed: boolean;
  area: boolean;
  points: LinePoint[];
}

export interface PointInfo {
  pnl: number;
  bench: number | null;
  dd: number;
}

export interface PnlSeries {
  lines: PnlLine[];
  missing: BacktestAsset[];
  /** 资产 → 秒 → 当根读数(十字光标 tooltip 用) */
  lookup: Map<string, Map<number, PointInfo>>;
  /** 画了持有基准但不是用户打开的(0 笔成交时强制) */
  forcedBenchmark: boolean;
}

function dedupe(asset: BacktestAsset, pick: (p: BacktestAsset['equity'][number]) => number | null): LinePoint[] {
  const bySec = new Map<number, number>();
  for (const p of asset.equity) {
    const v = pick(p);
    if (v === null || !Number.isFinite(v)) continue;
    bySec.set(Math.floor(p.at / 1000), v);
  }
  return [...bySec.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
}

function lookupOf(asset: BacktestAsset): Map<number, PointInfo> {
  const m = new Map<number, PointInfo>();
  for (const p of asset.equity) m.set(Math.floor(p.at / 1000), { pnl: p.pnl_pct, bench: p.benchmark_pct, dd: Math.abs(p.drawdown) });
  return m;
}

function hasBenchmark(asset: BacktestAsset): boolean {
  return asset.equity.some((p) => p.benchmark_pct !== null);
}

export function buildPnlSeries(report: Pick<BacktestReport, 'assets'>, mode: string, compare: boolean): PnlSeries {
  const lines: PnlLine[] = [];
  const missing: BacktestAsset[] = [];
  const lookup = new Map<string, Map<number, PointInfo>>();
  let forcedBenchmark = false;
  const targets = mode === ALL_ASSETS ? report.assets : report.assets.filter((a) => a.key === mode);
  const overlay = mode === ALL_ASSETS;
  for (const asset of targets) {
    if (asset.status !== 'completed' || asset.equity.length === 0) {
      missing.push(asset);
      continue;
    }
    lookup.set(asset.key, lookupOf(asset));
    const color = overlay ? assetColor(report, asset.key) : STRATEGY_COLOR;
    lines.push({
      id: `${asset.key}:strategy`,
      assetKey: asset.key,
      label: asset.label,
      role: 'strategy',
      color,
      dashed: false,
      area: !overlay,
      points: dedupe(asset, (p) => p.pnl_pct),
    });
    const noTrades = (asset.metrics?.trades ?? asset.trades.length) === 0;
    const showBench = (compare || noTrades) && hasBenchmark(asset);
    if (showBench) {
      if (!compare) forcedBenchmark = true;
      lines.push({
        id: `${asset.key}:benchmark`,
        assetKey: asset.key,
        label: asset.label,
        role: 'benchmark',
        color: overlay ? hexAlpha(color, 0.6) : BENCHMARK_COLOR,
        dashed: true,
        area: false,
        points: dedupe(asset, (p) => p.benchmark_pct),
      });
    }
  }
  return { lines, missing, lookup, forcedBenchmark };
}

/** 回撤水下图:-drawdown(小数),单资产。 */
export function underwaterPoints(asset: BacktestAsset): LinePoint[] {
  return dedupe(asset, (p) => -Math.abs(p.drawdown));
}

/** 导出 CSV:当前画出的资产的权益序列。 */
export function equityCsv(assets: BacktestAsset[]): string {
  const rows: (string | number)[][] = [['date_utc', 'asset', 'equity', 'pnl_pct', 'benchmark_pct', 'drawdown', 'exposure']];
  for (const a of assets) {
    for (const p of a.equity) rows.push([new Date(p.at).toISOString(), a.key, p.equity, p.pnl_pct, p.benchmark_pct ?? '', p.drawdown, p.exposure]);
  }
  return '﻿' + rows.map((r) => r.map((c) => (typeof c === 'number' ? String(c) : `"${String(c).replace(/"/g, '""')}"`)).join(',')).join('\r\n');
}

export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
