/**
 * 预览交付:本地生成一份「买家会收到什么」,不真发、不记账。
 *   策略信号 → /api/market/asp/preview;订阅产品 → 逐个频道预览;按次产品 → 可填一个示例需求再生成。
 * 调付费决策模型的按次产品,生成前必须明确确认(会按次计费);网关回 409 时同样转为确认。
 */
import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Send } from 'lucide-react';
import { api } from '@/api/client';
import { AspApiError, aspProductsApi, type AspProduct, type PreviewResult } from '@/api/asp-products';
import { Button } from '@/components/ui/button';
import { JudgeLock } from '@/components/judge-lock';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/lib/i18n';
import { ErrorNote } from '../shared';
import { PAID_PREVIEW, STRATEGY_KEY, channelsOf, splitDescription } from './labels';

async function runPreview(p: AspProduct, request: string, allowPaid: boolean): Promise<PreviewResult[]> {
  if (p.key === STRATEGY_KEY) {
    const r = await api.marketAspPreview();
    return [{ title: null, summary: r.blocked_reason, text: r.text }];
  }
  if (p.kind === 'subscription') return Promise.all(channelsOf(p.key).map((c) => aspProductsApi.previewChannel(c)));
  return [await aspProductsApi.previewListing(p.key, { description: request, ...(allowPaid ? { allow_paid: true } : {}) })];
}

export function PreviewDialog({ product, onClose }: { product: AspProduct | null; onClose: () => void }) {
  const [request, setRequest] = useState('');
  const [needPaid, setNeedPaid] = useState(false);
  const m = useMutation({
    mutationFn: (a: { p: AspProduct; allowPaid: boolean }) => runPreview(a.p, request, a.allowPaid),
    retry: false,
    onError: (err) => {
      if (err instanceof AspApiError && err.status === 409) setNeedPaid(true);
    },
  });
  const oneTime = product?.kind === 'one_time' && product.key !== STRATEGY_KEY;
  const paid = !!product && (PAID_PREVIEW.has(product.key) || needPaid);

  // 换产品时清空;订阅类 / 策略信号 打开就生成(不花钱)
  useEffect(() => {
    setRequest('');
    setNeedPaid(false);
    m.reset();
    if (product && product.kind === 'subscription') m.mutate({ p: product, allowPaid: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.key]);

  const example = product ? splitDescription(product.description)[1] : '';
  const paidError = m.error instanceof AspApiError && m.error.status === 409;

  return (
    <Dialog open={product !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('预览交付:{name}', { name: product?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('这是买家会收到的内容示例,只在本地生成,不会真的发出去。')}</DialogDescription>
        </DialogHeader>
        {oneTime ? (
          <div className="flex flex-col gap-2">
            <Textarea value={request} onChange={(e) => setRequest(e.target.value)} rows={3} className="text-[12px]" placeholder={example || t('写一个买家可能提的需求(可空)')} />
            {paid ? (
              <p className="flex items-start gap-1.5 rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-[11px] text-warn">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                {t('这个产品会调用付费的决策模型,每生成一次预览都会按次扣费。')}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <JudgeLock feature="asp_publish">
                <Button size="sm" variant={paid ? 'destructive' : 'default'} disabled={!product || m.isPending} onClick={() => product && m.mutate({ p: product, allowPaid: paid })}>
                  <Send data-slot="icon" />
                  {paid ? t('确认付费并生成预览') : t('生成预览')}
                </Button>
              </JudgeLock>
            </div>
          </div>
        ) : product?.key === STRATEGY_KEY && !m.data && !m.isPending && !m.isError ? (
          <JudgeLock feature="asp_publish" className="w-fit">
            <Button size="sm" className="w-fit" onClick={() => m.mutate({ p: product, allowPaid: false })}>
              <Send data-slot="icon" />
              {t('生成一条示例')}
            </Button>
          </JudgeLock>
        ) : null}
        {m.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : paidError ? (
          <p className="text-[11px] text-warn">{t('这个产品需要确认付费后才能预览,点上面的按钮继续。')}</p>
        ) : m.isError ? (
          <ErrorNote err={m.error} />
        ) : m.data ? (
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
            {m.data.map((r, i) => (
              <div key={i} className="flex flex-col gap-1">
                {r.summary ? <p className="text-[11.5px] text-muted-foreground">{r.summary}</p> : null}
                <pre className="whitespace-pre-wrap break-all rounded border bg-muted/30 p-3 text-[11px]">{r.text || t('(空)')}</pre>
              </div>
            ))}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
