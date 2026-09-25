/**
 * 可读规则卡(第四轮):把一条策略翻成六行中文——信号 / 入场 / 止损 / 仓位 / 出场 / 趋势过滤。
 *
 * 来源优先级:后端 compile 的 `rules` → 本地按 policy 模板翻译 → 本地按 IR 原语名兜底。
 * 兜底只列原语名与参数,并明说「后端还没给可读翻译」,不编造规则含义。
 * IR JSON、hash、规范全文都收在「查看规则表示」折叠里,答案层默认只看六行中文。
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { researchApi } from '@/api/client';
import type { OrderGateParams, ResearchCompileResponse, ResearchExecution, ResearchPolicy, ResearchRuleCard, ResearchSpecReport, StrategyIR } from '@/api/research-types';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

export type RuleCategory = ResearchRuleCard['category'];

const CATEGORY_LABEL: Record<RuleCategory, string> = tmap({ signal: '信号', entry: '入场', stop: '止损', sizing: '仓位', exit: '出场', regime: '趋势过滤' });
export const RULE_ORDER: RuleCategory[] = ['signal', 'entry', 'stop', 'sizing', 'exit', 'regime'];

const fmtNum = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2));

/**
 * policy(第一轮预置模板)没有 IR,按字段直接翻成中文句子。
 * 口径按 donchian_close_long_v1 的机械解释写,不加后端没有的语义。
 */
export function rulesFromPolicy(p: ResearchPolicy, execution?: ResearchExecution): ResearchRuleCard[] {
  const unit = (execution?.sizing_mode ?? 'unit_notional') === 'unit_notional';
  return [
    { category: 'signal', primitive: 'donchian_close_break', text: t('收盘价突破前 {n} 根的最高收盘价,且这根成交量在 {n} 根均量的 {m} 倍以上', { n: p.lookback, m: fmtNum(p.volume_multiple) }) },
    { category: 'entry', primitive: 'next_open', text: t('信号出现后在下一根开盘买入;不在同一根里回看成交') },
    { category: 'stop', primitive: 'atr_stop', text: t('按近期价格波动设置退出距离:{m} 倍 ATR({n}),换算成价格写在逐笔交易里', { m: fmtNum(p.stop_atr), n: p.atr_period }) },
    { category: 'sizing', primitive: unit ? 'unit_notional' : 'risk_fraction', text: unit ? t('每笔使用相同金额进行比较(已剔除仓位因素)') : t('每笔按账户风险比例定量,止损距离越远买得越少') },
    { category: 'exit', primitive: 'fixed_r_target', text: t('目标盈利为初始风险的 {r} 倍;最长持有 {n} 根还没走到就按收盘退出', { r: fmtNum(p.take_profit_r), n: p.holding_bars }) },
    { category: 'regime', primitive: 'none', text: t('这条策略没有趋势过滤:任何行情状态下信号都会被执行'), optional: true },
  ];
}

/** IR 兜底:后端没返回 rules 时只如实列原语与参数,不猜它的含义。 */
export function rulesFromIr(ir: StrategyIR): ResearchRuleCard[] {
  const one = (category: RuleCategory, nodes: { primitive: string; params: Record<string, unknown>; optional?: boolean }[]): ResearchRuleCard[] =>
    nodes.map((n) => ({ category, primitive: n.primitive, text: `${n.primitive}(${Object.entries(n.params ?? {}).map(([k, v]) => `${k}=${String(v)}`).join(', ')})`, optional: n.optional }));
  return [
    ...one('signal', ir.signal ?? []),
    ...one('entry', ir.entry ? [ir.entry] : []),
    ...one('stop', ir.risk?.stop ? [ir.risk.stop] : []),
    ...one('sizing', ir.risk?.sizing ? [ir.risk.sizing] : []),
    ...one('exit', ir.exit ?? []),
    ...one('regime', ir.regime ? [ir.regime] : []),
  ];
}

export interface RulesSource {
  rules: ResearchRuleCard[];
  /** 六行中文来自后端;false = 本地翻译(policy)或原语名兜底(IR) */
  fromBackend: boolean;
  /** 只有原语名、没有可读翻译 */
  rawOnly: boolean;
}

/**
 * 给任意 run 拿规则卡:有 strategy_ir 就打一次零模型 compile(缓存到 policy_hash),
 * 没有(老模板 run)就本地翻 policy。后端接口缺失时静默退回本地兜底。
 */
export function useRunRules(args: {
  ir: StrategyIR | null | undefined;
  policy: ResearchPolicy | null | undefined;
  execution: ResearchExecution;
  orderGate?: OrderGateParams;
  timeframe: string;
  datasetId?: string | null;
  cacheKey: string;
}): { source: RulesSource; compiled: ResearchCompileResponse | null } {
  const { ir, policy, execution, orderGate, timeframe, datasetId, cacheKey } = args;
  const q = useQuery({
    queryKey: ['research', 'rules', cacheKey],
    queryFn: () => researchApi.strategyRules({ ir: ir!, timeframe, ...(datasetId ? { dataset_id: datasetId } : {}), execution, ...(orderGate ? { order_gate: orderGate } : {}) }),
    enabled: !!ir && !!cacheKey,
    retry: false,
    staleTime: 10 * 60_000,
  });
  const compiled = q.data ?? null;
  const source = useMemo<RulesSource>(() => {
    if (compiled?.rules?.length) return { rules: compiled.rules, fromBackend: true, rawOnly: false };
    if (policy) return { rules: rulesFromPolicy(policy, execution), fromBackend: false, rawOnly: false };
    if (ir) return { rules: rulesFromIr(ir), fromBackend: false, rawOnly: true };
    return { rules: [], fromBackend: false, rawOnly: false };
  }, [compiled, policy, ir, execution]);
  return { source, compiled };
}

/** 六行中文规则卡;`extra` 放「查看规则表示」折叠里的原始表示(IR JSON / hash / 原语目录)。 */
export function RulesCard({ source, title, hint, extra, className }: { source: RulesSource; title?: string; hint?: string; extra?: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const byCat = new Map<RuleCategory, ResearchRuleCard[]>();
  for (const r of source.rules) byCat.set(r.category, [...(byCat.get(r.category) ?? []), r]);
  return (
    <div className={cn('rounded-md border', className)}>
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
        <span className="kicker text-foreground/85">{title ?? t('这条策略的规则')}</span>
        {hint ? <span className="text-[10.5px] text-muted-foreground">{hint}</span> : null}
        {source.rawOnly ? <span className="ml-auto text-[10.5px] text-warn">{t('后端还没给可读翻译,以下是原语与参数原文')}</span> : null}
      </div>
      {!source.rules.length ? (
        <div className="px-3 py-3 text-[11.5px] text-muted-foreground">{t('这条策略没有可读规则:既没有模板参数,也没有策略 IR。')}</div>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2 text-[11.5px]">
          {RULE_ORDER.filter((c) => byCat.has(c)).map((c) => (
            <div key={c} className="col-span-2 grid grid-cols-[64px_1fr] gap-x-3">
              <dt className="text-muted-foreground">{CATEGORY_LABEL[c]}</dt>
              <dd className="space-y-0.5">
                {byCat.get(c)!.map((r, i) => (
                  <div key={`${r.primitive}-${i}`} className={cn(source.rawOnly && 'num')}>
                    {r.text}
                    {r.optional ? <span className="ml-1 text-[10px] text-muted-foreground">{t('可选')}</span> : null}
                  </div>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {extra ? (
        <div className="border-t">
          <button type="button" className="flex w-full items-center gap-1 px-3 py-1 text-[10.5px] text-muted-foreground hover:text-foreground" onClick={() => setOpen((v) => !v)}>
            <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
            {t('查看规则表示')}
          </button>
          {open ? <div className="border-t px-3 py-2">{extra}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 策略规范校验:block 红、warn 黄;规范全文折叠可看。
 * 后端没给 spec 时整块不渲染(不显示「通过」,因为根本没校验)。
 */
export function SpecReport({ spec }: { spec: ResearchSpecReport | undefined }) {
  const [showText, setShowText] = useState(false);
  if (!spec) return null;
  const blocks = spec.violations.filter((v) => v.severity === 'block');
  const warns = spec.violations.filter((v) => v.severity === 'warn');
  return (
    <div className={cn('rounded-md border', blocks.length ? 'border-down/40' : warns.length ? 'border-warn/40' : 'border-up/40')}>
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
        <span className="kicker text-foreground/85">{t('策略规范')}</span>
        <span className="num text-[10.5px] text-muted-foreground">{spec.version}</span>
        <span className={cn('ml-auto text-[10.5px]', blocks.length ? 'text-down' : warns.length ? 'text-warn' : 'text-up')}>
          {blocks.length ? t('{n} 条不允许', { n: blocks.length }) : warns.length ? t('{n} 条提醒', { n: warns.length }) : t('没有违例')}
        </span>
      </div>
      {spec.violations.length ? (
        <ul className="divide-y">
          {[...blocks, ...warns].map((v, i) => (
            <li key={`${v.code}-${i}`} className="flex items-start gap-2 px-3 py-1.5 text-[11px]">
              <span className={cn('mt-0.5 inline-block size-2 shrink-0 rounded-full', v.severity === 'block' ? 'bg-down' : 'bg-warn')} />
              <span className="num w-40 shrink-0 text-muted-foreground">{v.code}{v.field ? ` · ${v.field}` : ''}</span>
              <span className={v.severity === 'block' ? 'text-down' : ''}>{v.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {spec.text ? (
        <div className="border-t">
          <button type="button" className="flex w-full items-center gap-1 px-3 py-1 text-[10.5px] text-muted-foreground hover:text-foreground" onClick={() => setShowText((v) => !v)}>
            <ChevronRight className={cn('size-3 transition-transform', showText && 'rotate-90')} />
            {t('规范全文')}
          </button>
          {showText ? <pre className="max-h-64 overflow-auto border-t bg-muted/30 p-3 text-[10.5px] whitespace-pre-wrap">{spec.text}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

/** spec 里是否有 block 级违例(用来禁用「用这条策略新建实验」) */
export function hasSpecBlock(spec: ResearchSpecReport | undefined): boolean {
  return !!spec?.violations.some((v) => v.severity === 'block');
}
