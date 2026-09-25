/**
 * 「今天的全市场扫描」:后端每天把 OKX 全集零模型扫一遍,存成 universe='okx_all' 的一次筛选,
 * 落在 horizon='daily'(不占雷达 short/swing/weekly 的排程),经现有 /api/screener/latest / history 取;雷达三个周期也一起看(给「今天的雷达候选」合并用)。
 * 盯盘参数页(观察列表的「雷达候选」标记)和筛选页顶部共用。
 */
import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { ScreenHorizon, ScreenRow, WatchCandidate } from '@/api/types';
import { pickMarketScan } from './watch-logic';

// 'daily' = 每日全市场扫描(后端 universe-okx.ts);api/types.ts 的 ScreenHorizon 还没收 daily,这里放宽
const HORIZONS = ['short', 'swing', 'weekly', 'daily'] as ScreenHorizon[];

export interface MarketScan {
  screen: ScreenRow | null;
  candidates: WatchCandidate[];
  loading: boolean;
  /** 三个周期各自最新一次筛选(给「今天的雷达候选」合并用),含全市场扫描 */
  sources: { screen: ScreenRow | null; candidates: WatchCandidate[] }[];
}

export function useMarketScan(): MarketScan {
  const latest = useQueries({
    queries: HORIZONS.map((h) => ({ queryKey: ['screener', 'latest', h], queryFn: () => api.screenerLatest(h), retry: false, staleTime: 60_000 })),
  });
  const history = useQueries({
    queries: HORIZONS.map((h) => ({ queryKey: ['screener', 'history', h], queryFn: () => api.screenerHistory(h, 20), retry: false, staleTime: 60_000 })),
  });
  const screens: (ScreenRow | null | undefined)[] = [...latest.map((q) => q.data?.screen), ...history.flatMap((q) => q.data?.screens ?? [])];
  const scan = pickMarketScan(screens);
  const fromLatest = scan ? latest.find((q) => q.data?.screen?.id === scan.id)?.data : undefined;
  const detailQ = useQuery({
    queryKey: ['screener', 'detail', scan?.id ?? ''],
    queryFn: () => api.screen(scan!.id),
    enabled: Boolean(scan && !fromLatest),
    retry: false,
    staleTime: 60_000,
  });
  const candidates = fromLatest ? fromLatest.candidates : (detailQ.data?.candidates ?? []);
  const sources = latest.map((q) => ({ screen: q.data?.screen ?? null, candidates: q.data?.candidates ?? [] }));
  if (scan && !fromLatest) sources.push({ screen: scan, candidates });
  return { sources, screen: scan, candidates, loading: latest.some((q) => q.isLoading) || (Boolean(scan && !fromLatest) && detailQ.isLoading) };
}
