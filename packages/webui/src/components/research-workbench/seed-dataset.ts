/**
 * 策略构建「算约束用的数据」:从海选带进来一组(币 · 周期 · 现货/永续)时,下拉框要选同一个币的数据集。
 * 数据集的 symbol 有两种写法(OKX instId `BTC-USDT-SWAP` / 行情导入的 `BTCUSDT`),先统一成 `BTCUSDT` 再比。
 * 优先级:同币同周期同市场 → 同币同周期 → 同币同市场 → 同币;一个同币的都没有就返回 null,由界面明说,不拿别的币顶上。
 */
import type { ResearchDatasetSummary } from '@/api/research-types';

export interface SeedAsset { symbol: string; timeframe: string; market: 'spot' | 'perp' }

const TF_MS: Record<string, number> = { '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };

/** `BTC-USDT-SWAP` / `btc/usdt` / `BTCUSDT` → `BTCUSDT` */
export function normalizeSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/SWAP$/, '');
}

function marketOf(d: ResearchDatasetSummary): 'spot' | 'perp' {
  return (d.market as string) === 'perp' || /-SWAP$/i.test(d.symbol) ? 'perp' : 'spot';
}

export function matchSeedDataset(datasets: readonly ResearchDatasetSummary[], seed: SeedAsset): ResearchDatasetSummary | null {
  const want = normalizeSymbol(seed.symbol), tf = TF_MS[seed.timeframe] ?? null;
  const same = datasets.filter((d) => normalizeSymbol(d.symbol) === want);
  if (!same.length) return null;
  const rank = (d: ResearchDatasetSummary) => (d.timeframe_ms === tf ? 0 : 2) + (marketOf(d) === seed.market ? 0 : 1);
  return same.reduce((best, d) => (rank(d) < rank(best) ? d : best));
}
