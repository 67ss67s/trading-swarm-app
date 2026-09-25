/** ['execution'] 的标准订阅方式:顶栏徽章、接入页、Agent「执行」摘要、开始清单共用同一份缓存。 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

export function useExecutionQuery() {
  return useQuery({ queryKey: ['execution'], queryFn: api.execution, refetchInterval: 30_000, retry: 0, staleTime: 10_000 });
}
