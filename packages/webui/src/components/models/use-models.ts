/**
 * ['models'] 查询(GET /api/models)。App.tsx 的 SSE `models.changed` 直接把 ModelsView 写进这份缓存。
 * 老网关没这条路由:retry 0,调用方按 data 缺失处理(胶囊不画、横幅不出、角色卡回退两槽推断)。
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { ModelsView } from '@/api/types';

export const MODELS_QUERY_KEY = ['models'] as const;

export function useModels() {
  return useQuery<ModelsView>({ queryKey: MODELS_QUERY_KEY, queryFn: api.models, retry: 0, staleTime: 30_000 });
}
