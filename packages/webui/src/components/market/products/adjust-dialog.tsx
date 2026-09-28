/**
 * 调整产品:改价格 / 三段描述 → 「检查」(预检,不写链)→ 二次确认 → 提交(写链,触发 OKX 重新审核)。
 * 预检之后再改任何字段,都要重新检查才能提交。
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { aspProductsApi, type AspProduct, type DraftResponse } from '@/api/asp-products';
import { Button } from '@/components/ui/button';
import { JudgeLock } from '@/components/judge-lock';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/lib/i18n';
import { Findings } from './register-form';
import { KIND_LABEL, PRODUCTS_KEY, errText, fmtProductPrice, splitDescription } from './labels';

type Desc = [string, string, string];

export interface AdjustEdits {
  price?: string;
  description?: Desc;
}

/** 只把改动过的字段发给预检;都没改 = null。 */
export function diffEdits(p: Pick<AspProduct, 'price' | 'description'>, price: string, desc: Desc): AdjustEdits | null {
  const out: AdjustEdits = {};
  if (price.trim() !== p.price) out.price = price.trim();
  const orig = splitDescription(p.description);
  if (desc.some((d, i) => d !== orig[i])) out.description = desc;
  return out.price === undefined && out.description === undefined ? null : out;
}

const SECTION_LABEL = () => [t('核心能力(必填)'), t('买家需要提供'), t('交付说明')];

export function AdjustDialog({ product, onClose }: { product: AspProduct | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [price, setPrice] = useState('');
  const [desc, setDesc] = useState<Desc>(['', '', '']);
  const [draft, setDraft] = useState<{ edits: string; res: DraftResponse } | null>(null);
  const [step, setStep] = useState<'edit' | 'confirm'>('edit');

  useEffect(() => {
    if (!product) return;
    setPrice(product.price);
    setDesc(splitDescription(product.description));
    setDraft(null);
    setStep('edit');
    // 只在换产品 / 打开时重置;后台刷新产品数据不能冲掉正在编辑的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.key]);

  const edits = useMemo(() => (product ? diffEdits(product, price, desc) : null), [product, price, desc]);
  const editsSig = JSON.stringify(edits);
  const fresh = draft !== null && draft.edits === editsSig;
  const creating = !!product && !product.listing_id;

  const check = useMutation({
    mutationFn: () => aspProductsApi.draft(product!.key, edits ?? {}),
    retry: false,
    onSuccess: (res) => setDraft({ edits: editsSig, res }),
    onError: (err) => toast.error(t('检查失败'), { description: errText(err) }),
  });
  const apply = useMutation({
    mutationFn: () => aspProductsApi.apply(product!.key, draft!.res.service_payload),
    retry: false,
    onSuccess: (r) => {
      toast.success(t('已提交,等待 OKX 重新审核'), { description: r.tx_hash ? t('交易哈希 {h}', { h: r.tx_hash }) : (r.message ?? undefined) });
      void qc.invalidateQueries({ queryKey: PRODUCTS_KEY });
      void qc.invalidateQueries({ queryKey: ['market', 'asp'] });
      onClose();
    },
    onError: (err) => {
      // 写链结果不确定时也刷新一次,让页面显示真实状态
      void qc.invalidateQueries({ queryKey: PRODUCTS_KEY });
      toast.error(t('提交失败'), { description: errText(err) });
    },
  });

  const setSection = (i: number, v: string) => setDesc((d) => d.map((x, j) => (j === i ? v : x)) as Desc);
  const canCheck = !!product && (edits !== null || creating) && !check.isPending && price.trim() !== '';
  const canSubmit = fresh && draft!.res.validate.pass && draft!.res.service_payload !== null;
  const labels = SECTION_LABEL();

  return (
    <Dialog open={product !== null} onOpenChange={(o) => !o && !apply.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{creating ? t('上架:{name}', { name: product?.name ?? '' }) : t('调整:{name}', { name: product?.name ?? '' })}</DialogTitle>
          <DialogDescription>
            {product ? t('{kind} · 现价 {price}', { kind: KIND_LABEL[product.kind], price: fmtProductPrice(product) }) : ''}
          </DialogDescription>
        </DialogHeader>

        {step === 'edit' ? (
          <div className="flex flex-col gap-3 text-[12px]">
            <div className="flex flex-col gap-1.5">
              <Label>{product?.price_unit === 'month' ? t('月费(USDT,最多 2 位小数)') : t('每次费用(USDT,最多 2 位小数)')}</Label>
              <Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" className="h-8 w-40 text-[12px]" />
            </div>
            {labels.map((l, i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <Label>{l}</Label>
                <Textarea value={desc[i]} onChange={(e) => setSection(i, e.target.value)} rows={i === 0 ? 4 : 2} className="text-[12px]" />
              </div>
            ))}
            <p className="text-[10.5px] text-muted-foreground">{t('描述不能有链接、「测试」字样或保证收益类说法;中文按 2 个字符计,全文不超过 2000。')}</p>

            {fresh ? (
              <div className="flex flex-col gap-1.5">
                {draft!.res.validate.pass ? (
                  <p className="flex items-center gap-1.5 text-[11.5px] text-up">
                    <CheckCircle2 className="size-3.5" />
                    {t('检查通过,可以提交')}
                  </p>
                ) : (
                  <p className="flex items-center gap-1.5 text-[11.5px] text-destructive">
                    <AlertTriangle className="size-3.5" />
                    {t('有必须修改的问题')}
                  </p>
                )}
                <Findings items={draft!.res.validate.findings} />
                {draft!.res.warns.map((w, i) => (
                  <div key={i} className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
                    {w}
                  </div>
                ))}
              </div>
            ) : draft ? (
              <p className="text-[11px] text-muted-foreground">{t('内容改过了,请重新检查。')}</p>
            ) : null}

            <DialogFooter className="gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>
                {t('取消')}
              </Button>
              <JudgeLock feature="asp_publish">
                <Button variant="outline" size="sm" disabled={!canCheck} onClick={() => check.mutate()}>
                  <ShieldCheck data-slot="icon" />
                  {check.isPending ? t('检查中…') : t('检查')}
                </Button>
              </JudgeLock>
              <JudgeLock feature="asp_publish">
                <Button size="sm" disabled={!canSubmit} onClick={() => setStep('confirm')}>
                  {t('下一步:确认提交')}
                </Button>
              </JudgeLock>
            </DialogFooter>
            {!edits && !creating ? <p className="text-right text-[10.5px] text-muted-foreground">{t('还没有改动')}</p> : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3 text-[12.5px]">
            <div className="flex items-start gap-2 rounded border border-warn/40 bg-warn/10 p-3 text-warn">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div className="flex flex-col gap-1">
                <p className="font-medium">{t('提交后会写入链上,并触发 OKX 重新审核。')}</p>
                <p className="text-[11.5px]">{t('审核结果出来前,产品会显示为「审核中」;已有的订阅和订单照常交付。提交后不能撤回,只能再改一次。')}</p>
              </div>
            </div>
            <ul className="flex flex-col gap-1 text-[11.5px] text-muted-foreground">
              {edits?.price !== undefined ? <li>{t('价格:{a} → {b}', { a: product?.price ?? '—', b: edits.price })}</li> : null}
              {edits?.description ? <li>{t('描述:三段内容已修改')}</li> : null}
              {creating ? <li>{t('新上架这个产品')}</li> : null}
            </ul>
            <DialogFooter className="gap-2">
              <Button variant="outline" size="sm" disabled={apply.isPending} onClick={() => setStep('edit')}>
                {t('返回修改')}
              </Button>
              <JudgeLock feature="asp_publish">
                <Button variant="destructive" size="sm" disabled={apply.isPending || !canSubmit} onClick={() => apply.mutate()}>
                  {apply.isPending ? t('提交中…') : t('确认提交')}
                </Button>
              </JudgeLock>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
