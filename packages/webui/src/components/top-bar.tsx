import { Command, OctagonAlert } from 'lucide-react';
import { api } from '@/api/client';
import { AgentSwitch } from '@/components/agent-run-controls';
import { AccountsMenu } from '@/components/accounts-menu';
import { ExecutionBadge } from '@/components/execution-panel';
import { ModelsPill } from '@/components/models/models-pill';
import { Button } from '@/components/ui/button';
import { NeedsYouBadge } from '@/components/approvals';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { pageLabel, type Page } from '@/lib/nav';
import { getLang, setLang, t, useLang } from '@/lib/i18n';
import { backendLabel, fmtSigned, fmtUsdt, pnlText } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AccountView, QueueView, UsageToday } from '@/api/types';

interface TopBarProps {
  page: Page;
  account: AccountView | null;
  queue: QueueView | null;
  halted: boolean;
  paused: boolean;
  /** v3.3:今日模型用量(老网关没有这个字段时为 null,整块不显示)。 */
  usage?: UsageToday | null;
  connected: boolean;
  onOpenCommand: () => void;
  onOpenHalt: () => void;
  onOpenResumeHalt: () => void;
}

/** 今日判断次数 / 花费。cap=0 = 不限;capped = 已到上限,警示色 + tooltip。 */
function UsageMeter({ usage }: { usage: UsageToday }) {
  const cap = Number(usage.cap) || 0;
  const judgments = Number(usage.judgments) || 0;
  const cost = usage.est_cny !== null && usage.est_cny !== undefined && Number.isFinite(Number(usage.est_cny)) ? `≈¥${Number(usage.est_cny).toFixed(2)}` : null;
  const text = `${t('今日判断')} ${judgments}${cap > 0 ? `/${cap}` : ''}${cost ? ` · ${cost}` : ''}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('num text-[11px]', usage.capped ? 'font-semibold text-warn' : 'text-muted-foreground')}>{text}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {usage.capped ? (
          <span>{t('已到每天上限,今天不再调模型')}</span>
        ) : (
          <span className="num">
            {t('输入')} {usage.input_tokens ?? 0} · {t('输出')} {usage.output_tokens ?? 0} tokens{cap > 0 ? ` · ${t('上限 {n} 次/天', { n: cap })}` : ` · ${t('没设上限')}`}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/** 中 / EN 一键切换:显示的是「点了会切到哪」。 */
function LangSwitch() {
  const lang = useLang();
  return (
    <Button
      variant="ghost"
      size="xs"
      className="w-8 px-0 font-semibold text-muted-foreground hover:text-foreground"
      title={lang === 'zh' ? 'Switch to English' : '切换成中文'}
      aria-label={lang === 'zh' ? 'Switch to English' : '切换成中文'}
      onClick={() => setLang(getLang() === 'zh' ? 'en' : 'zh')}
    >
      {lang === 'zh' ? 'EN' : '中'}
    </Button>
  );
}

function queueText(queue: QueueView | null): string {
  if (!queue) return '—';
  if (queue.running) {
    const stepText: Record<string, string> = { fetching: t('拉行情'), context: t('收集依据'), thinking: t('思考中'), validating: t('校验结果'), gating: t('过闸'), executing: t('执行中'), done: t('完成') };
    const kindText: Record<string, string> = { scan: t('扫描'), review: t('复查'), info: t('信息员'), chat: t('对话'), manual: t('手动') };
    const base = queue.running.symbol ? `${kindText[queue.running.kind] ?? t('判断')} ${queue.running.symbol}` : (kindText[queue.running.kind] ?? t('判断中'));
    const step = queue.running.step ? ` · ${stepText[queue.running.step] ?? queue.running.step}` : '';
    const label = `${base}${step}`;
    return queue.pending > 0 ? `${label} · ${t('排队 {n}', { n: queue.pending })}` : label;
  }
  return queue.pending > 0 ? t('排队 {n}', { n: queue.pending }) : t('空闲');
}

export function TopBar({ page, account, queue, halted, paused, usage, connected, onOpenCommand, onOpenHalt, onOpenResumeHalt }: TopBarProps) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-2.5 border-b bg-background px-2.5 select-none">
      <SidebarTrigger className="-ml-0.5" />
      <Separator orientation="vertical" className="!h-4" />
      <h1 className="text-[13px] font-semibold">{pageLabel(page)}</h1>

      <div className="ml-auto flex items-center gap-2">
        <div className="num flex items-center gap-2.5 text-[11px]">
          <span className="text-muted-foreground">
            {t('权益')} <span className="text-[12.5px] font-semibold text-foreground">{fmtUsdt(account?.equity)}</span>
          </span>
          <span className="text-muted-foreground">
            {t('未实现')} <span className={cn('text-[12.5px] font-semibold', pnlText(account?.unrealized_pnl))}>{fmtSigned(account?.unrealized_pnl)}</span>
          </span>
        </div>
        <Separator orientation="vertical" className="!h-4" />

        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className={cn('size-1.5 rounded-full', connected ? 'bg-up' : 'bg-down')} />
          {queueText(queue)}
        </span>

        {usage ? (
          <>
            <Separator orientation="vertical" className="!h-4" />
            <UsageMeter usage={usage} />
          </>
        ) : null}

        <Separator orientation="vertical" className="!h-4" />
        <NeedsYouBadge />
        {/* 09-20:三颗按钮(自动交易 / Agent 开关 / 已暂停)并成一颗;账户菜单装 OKX / 钱包 / MCP */}
        <AgentSwitch paused={paused} halted={halted} />
        <AccountsMenu />
        {/* §9.52 / 09-25 ③-8:顶栏只留模型连接胶囊(n 个可用 + 失效角色红点);回退主脑 / 副脑并进 #models 页「默认」一节,
            不再在顶栏放「大脑」弹层——它会让人以为改它就换了全部角色的模型 */}
        <ModelsPill />
        <ExecutionBadge />

        <Separator orientation="vertical" className="!h-4" />
        <Button
          variant={halted ? 'destructive' : 'outline'}
          size="xs"
          className={cn(!halted && 'border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive')}
          onClick={halted ? onOpenResumeHalt : onOpenHalt}
        >
          <OctagonAlert data-slot="icon" />
          {halted ? t('解除紧急停止') : t('紧急停止')}
        </Button>

        <Separator orientation="vertical" className="!h-4" />
        <LangSwitch />
        <Button variant="ghost" size="icon-xs" aria-label={t('命令面板')} title="⌘K" onClick={onOpenCommand}>
          <Command />
        </Button>
      </div>
    </header>
  );
}
