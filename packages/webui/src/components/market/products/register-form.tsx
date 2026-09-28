/**
 * 没有 ASP 身份时的注册表单(流程不变:校验 → 确认 → 上链注册;注册后还要「上架」才对外可见)。
 */
import { forwardRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { friendlyError } from '@/lib/edition';
import { api } from '@/api/client';
import type { MarketPricing, MarketRegisterForm, MarketValidateFinding } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { JudgeLock } from '@/components/judge-lock';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

const PRICING_LABEL: Record<MarketPricing, string> = tmap({
  per_call: '按次收费',
  monthly: '月订阅',
  monthly_trial: '月订阅 + 72 小时试用',
});

const EMPTY_FORM: MarketRegisterForm = {
  name: '',
  description: '',
  service_name: '',
  service_type: 'A2A',
  pricing: 'monthly_trial',
  fee: '0',
  service_description: '',
};

export function Findings({ items }: { items: { field?: string | null; code?: string; severity: string; message: string }[] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-1">
      {items.map((f, i) => (
        <div key={i} className={cn('rounded border px-2 py-1 text-[11px]', f.severity === 'block' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-warn/40 bg-warn/10 text-warn')}>
          {f.field ? <span className="font-medium">{f.field} · </span> : null}
          {f.message}
        </div>
      ))}
    </div>
  );
}

export const RegisterForm = forwardRef<HTMLDivElement, { onRegistered: () => void }>(function RegisterForm({ onRegistered }, ref) {
  const [form, setForm] = useState<MarketRegisterForm>(EMPTY_FORM);
  const [avatar, setAvatar] = useState<File | null>(null);
  const [findings, setFindings] = useState<MarketValidateFinding[]>([]);
  const [validated, setValidated] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const set = <K extends keyof MarketRegisterForm>(k: K, v: MarketRegisterForm[K]) => {
    setValidated(false);
    setForm((f) => ({ ...f, [k]: v }));
  };
  const validate = useMutation({
    mutationFn: () => api.marketAspValidate(form),
    onSuccess: (r) => {
      setFindings(r.findings);
      setValidated(r.pass);
      r.pass ? toast.success(t('校验通过')) : toast.error(t('有必须修的问题'));
    },
    onError: (err) => toast.error(t('校验失败'), { description: friendlyError(err instanceof Error ? err.message : String(err)) }),
  });
  const register = useMutation({
    mutationFn: () => api.marketAspRegister(form, avatar!),
    retry: false,
    onSuccess: (r) => {
      setConfirmOpen(false);
      if (!r.ok) {
        if (r.findings) setFindings(r.findings);
        toast.error(t('注册失败'), { description: r.message ?? undefined });
        return;
      }
      toast.success(t('ASP 身份已注册:#{id}', { id: r.agent_id ?? '?' }), { description: t('还没对外可见,点「上架」发布') });
      onRegistered();
    },
    onError: (err) => toast.error(t('注册失败'), { description: friendlyError(err instanceof Error ? err.message : String(err)) }),
  });
  const blocks = findings.filter((f) => f.severity === 'block').length;
  const canRegister = validated && blocks === 0 && avatar !== null;

  return (
    <div ref={ref} className="flex flex-col gap-4 p-4 text-[12px]">
      <div className="rounded border bg-muted/20 p-2.5 text-[11px] text-muted-foreground">
        {t('注册卖家身份:在 XLayer 链上为这个钱包登记一个身份(OKX 付手续费,一个钱包只能注册一个)。名称中文 2–12 / 英文 3–25 字,描述不超过 500 字,头像必须是图片;不能有链接、名人名、「保证收益」类说法,否则 OKX 审核会拒。')}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label>{t('品牌名')}</Label>
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} className="h-7 text-[11.5px]" placeholder="trade-gate" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t('头像(图片文件)')}</Label>
          <Input type="file" accept="image/*" onChange={(e) => setAvatar(e.target.files?.[0] ?? null)} className="h-7 text-[11.5px]" />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label>{t('身份描述(≤ 500 字)')}</Label>
          <Textarea value={form.description} onChange={(e) => set('description', e.target.value)} rows={3} className="text-[12px]" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t('服务名(5–30 字,名词短语)')}</Label>
          <Input value={form.service_name} onChange={(e) => set('service_name', e.target.value)} className="h-7 text-[11.5px]" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t('类型')}</Label>
          <Input value="A2A" disabled className="h-7 text-[11.5px]" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t('定价')}</Label>
          <Select value={form.pricing} onValueChange={(v) => set('pricing', v as MarketPricing)}>
            <SelectTrigger className="h-7 text-[11.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PRICING_LABEL) as MarketPricing[]).map((p) => (
                <SelectItem key={p} value={p} className="text-[12px]">
                  {PRICING_LABEL[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{form.pricing === 'per_call' ? t('每次费用(USDT,0 = 免费)') : t('每月费用(USDT,0 = 免费)')}</Label>
          <Input value={form.fee} onChange={(e) => set('fee', e.target.value)} type="number" min={0} step={0.01} className="h-7 text-[11.5px]" />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label>{t('服务描述(三段:核心能力 / 买家需提供 / 交付说明)')}</Label>
          <Textarea
            value={form.service_description}
            onChange={(e) => set('service_description', e.target.value)}
            rows={6}
            className="text-[12px]"
            placeholder={t('[核心能力] … \n[买家需提供] … \n[交付说明] 每条信号一段说明 + 一段结构化数据(标的 / 方向 / 价位 / 止损 / 止盈 / 有效期);真实交易可跟单,观点仅供参考;平仓附真实盈亏。')}
          />
        </div>
      </div>
      <Findings items={findings} />
      <div className="flex flex-wrap items-center gap-2">
        <JudgeLock feature="asp_register">
          <Button size="sm" variant="outline" disabled={validate.isPending} onClick={() => validate.mutate()}>
            <ShieldCheck data-slot="icon" />
            {t('校验(OKX QA)')}
          </Button>
        </JudgeLock>
        <JudgeLock feature="asp_register">
          <Button size="sm" disabled={!canRegister || register.isPending} onClick={() => setConfirmOpen(true)}>
            {t('注册 ASP 身份')}
          </Button>
        </JudgeLock>
        {!avatar ? <span className="text-[10.5px] text-muted-foreground">{t('先选头像')}</span> : null}
      </div>
      <ConfirmDialog open={confirmOpen} title={t('在 XLayer 上注册 ASP 身份?')} summary={t('链上写入')} busy={register.isPending} onCancel={() => setConfirmOpen(false)} onConfirm={() => register.mutate()}>
        <p>{t('会以「{name}」注册一个 ASP 身份并挂一个服务「{svc}」({pricing},{fee} USDT)。OKX 付 gas;注册后要再点「上架」才对外可见。', { name: form.name, svc: form.service_name, pricing: PRICING_LABEL[form.pricing], fee: form.fee })}</p>
      </ConfirmDialog>
    </div>
  );
});
