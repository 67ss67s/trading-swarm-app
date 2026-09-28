/**
 * 「策略研究」第 1 步的推荐接口(§9.53 A,后端 routes-recommendations.ts / recommend.ts;纯代码计算、零模型费):
 *   POST /api/recommendations {horizons?, market?, top_n?} → AssetRecommendation(现算并落库)
 *   GET  /api/recommendations/:id                         → 同一份(地址栏 rec= 刷新时用,不重算)
 * 放在组件目录里,不动 api/client.ts 与 api/recommend.ts(别人在动)。
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RecLite } from './model';

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<RecLite> {
  const res = await fetch(path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON(网关重启时的 HTML)按状态码报 */ }
  if (!res.ok) {
    const e = json as { error?: string | { message?: string }; message?: string } | null;
    throw new Error(typeof e?.error === 'string' ? e.error : e?.error?.message ?? e?.message ?? `HTTP ${res.status}`);
  }
  return json as RecLite;
}

export const recommendApi = {
  create: (top_n = 10) => call('POST', '/api/recommendations', { top_n }),
  get: (id: string) => call('GET', `/api/recommendations/${encodeURIComponent(id)}`),
};

/** 有 rec(地址栏)就按 id 取;没有就现算一份,算完由页面把 id 写回地址栏 */
export function useFlowRecommendation(rec: string | null) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['strategy-research', 'recommendation', rec ?? 'new'],
    queryFn: async () => {
      const r = rec ? await recommendApi.get(rec) : await recommendApi.create();
      if (!rec) qc.setQueryData(['strategy-research', 'recommendation', r.id], r);
      return r;
    },
    staleTime: rec ? Infinity : 5 * 60_000,
    retry: 0,
  });
  return q;
}
