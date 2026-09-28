import type { ReadCacheMeta } from '@/api/types';
import { IS_JUDGE } from '@/lib/edition';
import { fmtDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { friendlyMarketError, judgeCacheNoteText } from './judge';
/** 未知不能显示成「未注册／无订阅」；旧快照保留并标明时间。评审版只显示「Snapshot as of …」,不露刷新失败原文。 */
export function CacheNote({ cache, asOf }: { cache?: ReadCacheMeta; asOf?: unknown }) {
  if (IS_JUDGE) {
    const text = judgeCacheNoteText(cache, asOf, fmtDateTime);
    return text ? <p role="status" className="px-3 py-2 text-[11px] text-muted-foreground">{text}</p> : null;
  }
  if (!cache) return null;
  return <p role="status" className="px-3 py-2 text-[11px] text-muted-foreground">
    {cache.fetched_at === null ? t('正在加载远端状态') : t('数据时间：{at}', { at: fmtDateTime(cache.fetched_at) })}
    {cache.stale && cache.fetched_at !== null ? ` · ${t('数据已过期')}` : ''}
    {cache.refreshing ? ` · ${t('后台刷新中')}` : ''}
    {cache.error ? ` · ${t('刷新失败：{error}', { error: friendlyMarketError(cache.error) })}` : ''}
  </p>;
}
export const cachePollMs = (query: { state: { data?: { cache?: ReadCacheMeta } } }) => query.state.data?.cache?.refreshing ? 2_000 : 30_000;
