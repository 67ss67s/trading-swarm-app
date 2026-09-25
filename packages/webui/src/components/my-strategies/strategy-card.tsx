/**
 * 「我的策略」卡片(网格视图)与紧凑行(列表视图),以及两者共用的 ⋯ 菜单。
 * 三种形态(测试覆盖):
 *   1. 有回测:收益曲线面积图 + 右下大字总收益 + 底部 夏普 / 最大回撤(红)/ 胜率(绿)/ 交易数;
 *   2. 草稿未回测:点阵底 + 转圈弧 +「还没有回测 / 跑一次回测看看表现」+ 底部「继续构建 →」;
 *   3. 0 笔交易:平线 + 0.0%,夏普/胜率显示 —,回撤 0.0%,交易数 0。
 * 组件本身只管展示,写操作通过 actions 回调交给页面(useStrategyActions)。
 */
import { useState, type MouseEvent, type ReactNode } from 'react';
import type { StrategyRun } from '@/api/types';
import { RunPill } from './run-panel';
import { motion, useReducedMotion } from 'motion/react';
import { ArrowRight, ArrowUpRight, Bell, BellOff, Eye, EyeOff, MoreHorizontal, Pencil, RefreshCw, Share, Archive } from 'lucide-react';
import type { ResearchStrategy } from '@trading-swarm/contracts';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { TableCell, TableRow } from '@/components/ui/table';
import { relativeTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { EquityArea, toneOf } from './equity-area';
import { StrategyGlyph } from './strategy-glyph';
import { STATUS_LABEL, assetLine, fmtDrawdown, fmtReturn, fmtSharpe, fmtTrades, fmtWinRate, hasBacktest, statusTone } from './model';

export interface StrategyCardActions {
  open: (s: ResearchStrategy) => void;
  share: (s: ResearchStrategy) => void;
  rename: (s: ResearchStrategy) => void;
  toggleWatchlist: (s: ResearchStrategy) => void;
  toggleAlerts: (s: ResearchStrategy) => void;
  rebacktest: (s: ResearchStrategy) => void;
  archive: (s: ResearchStrategy) => void;
  continueBuilding: (s: ResearchStrategy) => void;
}

/** 正在重新回测的策略 id(卡片上显示转圈) */
export type BusySet = ReadonlySet<string>;

function stop(fn: () => void) {
  return (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={stop(onClick)}
      className="inline-flex size-7 items-center justify-center rounded-full bg-muted/70 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}

function MenuItem({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={stop(onClick)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-accent [&_svg]:size-3.5',
        danger ? 'text-destructive hover:bg-destructive/10' : 'text-foreground',
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/** ⋯ 菜单:重命名 / 关注 / 提醒 / 重新回测 / 归档(归档的二次确认由页面弹 ConfirmDialog) */
export function StrategyMenu({ strategy, actions, triggerClassName }: { strategy: ResearchStrategy; actions: StrategyCardActions; triggerClassName?: string }) {
  const [open, setOpen] = useState(false);
  // 点菜单项先收起菜单再执行(否则弹窗和菜单叠在一起抢焦点)
  const run = (fn: (s: ResearchStrategy) => void) => () => {
    setOpen(false);
    fn(strategy);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('更多操作')}
          title={t('更多操作')}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-full bg-muted/70 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [&_svg]:size-3.5',
            triggerClassName,
          )}
        >
          <MoreHorizontal />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-1" onClick={(e) => e.stopPropagation()}>
        <MenuItem icon={<Pencil />} label={t('重命名')} onClick={run(actions.rename)} />
        <MenuItem
          icon={strategy.watchlist ? <EyeOff /> : <Eye />}
          label={strategy.watchlist ? t('移出关注') : t('加入关注')}
          onClick={run(actions.toggleWatchlist)}
        />
        <MenuItem
          icon={strategy.alerts ? <BellOff /> : <Bell />}
          label={strategy.alerts ? t('关闭提醒') : t('开启提醒')}
          onClick={run(actions.toggleAlerts)}
        />
        <MenuItem icon={<RefreshCw />} label={hasBacktest(strategy) ? t('重新回测') : t('运行回测')} onClick={run(actions.rebacktest)} />
        <div className="my-1 h-px bg-border" />
        <MenuItem icon={<Archive />} label={t('归档')} danger onClick={run(actions.archive)} />
      </PopoverContent>
    </Popover>
  );
}

/** 状态小胶囊:草稿/已回测不显示(副标题已经说明),模拟盘及以后才亮出来 */
export function StatusPill({ status, always }: { status: ResearchStrategy['status']; always?: boolean }) {
  if (!always && (status === 'draft' || status === 'backtested')) return null;
  return <span className={cn('inline-flex h-4.5 shrink-0 items-center rounded-full border px-1.5 text-[10px] font-medium', statusTone(status))}>{STATUS_LABEL[status]}</span>;
}

function subtitle(s: ResearchStrategy, now: number): string {
  if (!hasBacktest(s) && s.status === 'draft') return `${t('草稿')} · ${relativeTime(s.updated_at, now)}`;
  return assetLine(s);
}

/** 草稿中部:点阵底 + 转圈弧 */
function NotBacktested({ busy }: { busy?: boolean }) {
  const reduced = useReducedMotion();
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-1 overflow-hidden text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60 [background-image:radial-gradient(circle,var(--border)_1px,transparent_1.2px)] [background-size:14px_14px] [mask-image:radial-gradient(ellipse_at_center,black_35%,transparent_75%)]"
      />
      <motion.svg
        viewBox="0 0 48 48"
        className="relative mb-1 size-12"
        aria-hidden
        animate={reduced ? undefined : { rotate: 360 }}
        transition={reduced ? undefined : { repeat: Infinity, ease: 'linear', duration: busy ? 1.1 : 3.2 }}
      >
        <path d="M8 26 A16 16 0 0 1 40 26" fill="none" stroke="var(--primary)" strokeWidth="5" strokeLinecap="round" />
      </motion.svg>
      <div className="relative text-[13px] font-semibold text-foreground">{busy ? t('回测运行中…') : t('还没有回测')}</div>
      <div className="relative text-[11.5px] text-muted-foreground">{t('跑一次回测看看表现')}</div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-0.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={cn('num text-[13px] font-semibold', value !== '—' && tone === 'up' && 'text-up', value !== '—' && value !== '0.0%' && tone === 'down' && 'text-down')}>{value}</span>
    </div>
  );
}

export function StrategyCard({ strategy: s, actions, busy, now = Date.now(), run = null }: { strategy: ResearchStrategy; actions: StrategyCardActions; busy?: boolean; now?: number; run?: StrategyRun | null }) {
  const tested = hasBacktest(s);
  const sum = s.summary;
  const tone = toneOf(sum?.total_return);
  return (
    <article
      role="link"
      tabIndex={0}
      data-testid="strategy-card"
      data-shape={tested ? ((sum?.trades ?? 0) === 0 ? 'zero-trades' : 'backtested') : 'draft'}
      onClick={() => actions.open(s)}
      onKeyDown={(e) => {
        // 只认卡片本身的回车;里面按钮上的回车冒泡上来不算
        if (e.key === 'Enter' && e.target === e.currentTarget) actions.open(s);
      }}
      className="group flex h-[292px] cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-[0_8px_24px_-12px_color-mix(in_oklab,var(--primary)_35%,transparent)] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <header className="flex items-start gap-2.5 px-4 pt-4">
        <StrategyGlyph id={s.id} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <h3 className="truncate text-[15px] font-semibold leading-tight" title={s.name}>
              {s.name || t('未命名')}
            </h3>
            <StatusPill status={s.status} />
            {run ? <RunPill run={run} /> : null}
          </div>
          <div className="num mt-1 truncate text-[11.5px] text-muted-foreground">{subtitle(s, now)}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {tested ? (
            <IconButton label={t('分享')} onClick={() => actions.share(s)}>
              <Share />
            </IconButton>
          ) : null}
          <StrategyMenu strategy={s} actions={actions} />
          <IconButton label={t('打开')} onClick={() => actions.open(s)}>
            <ArrowUpRight />
          </IconButton>
        </div>
      </header>

      {tested && sum ? (
        <>
          <div className="relative mt-2 min-h-0 flex-1">
            <EquityArea values={sum.sparkline} tone={tone} className="absolute inset-0" />
            <div className="pointer-events-none absolute right-4 bottom-1 flex flex-col items-end leading-none">
              <span className={cn('num text-[30px] font-light tracking-tight', tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-foreground')}>
                {fmtReturn(sum.total_return)}
              </span>
              <span className="mt-1 text-[11px] text-muted-foreground">{t('总收益')}</span>
            </div>
            {busy ? <div className="absolute top-1 left-4 text-[11px] text-primary">{t('回测运行中…')}</div> : null}
          </div>
          <footer className="grid grid-cols-4 gap-1 px-3 pt-3 pb-4">
            <Stat label={t('夏普')} value={fmtSharpe(sum.sharpe, sum.trades)} />
            <Stat label={t('最大回撤')} value={fmtDrawdown(sum.max_drawdown)} tone="down" />
            <Stat label={t('胜率')} value={fmtWinRate(sum.win_rate, sum.trades)} tone="up" />
            <Stat label={t('交易数')} value={fmtTrades(sum.trades)} />
          </footer>
        </>
      ) : (
        <>
          <div className="min-h-0 flex-1">
            <NotBacktested busy={busy} />
          </div>
          <footer className="flex justify-center pt-1 pb-4">
            <button
              type="button"
              onClick={stop(() => actions.continueBuilding(s))}
              className="inline-flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-primary [&_svg]:size-3.5 [&_svg]:transition-transform hover:[&_svg]:translate-x-0.5"
            >
              {t('继续构建')}
              <ArrowRight />
            </button>
          </footer>
        </>
      )}
    </article>
  );
}

/** 列表视图的一行(紧凑表格) */
export function StrategyRow({ strategy: s, actions, busy, now = Date.now(), run = null }: { strategy: ResearchStrategy; actions: StrategyCardActions; busy?: boolean; now?: number; run?: StrategyRun | null }) {
  const tested = hasBacktest(s);
  const sum = s.summary;
  const tone = toneOf(sum?.total_return);
  return (
    <TableRow className="cursor-pointer" onClick={() => actions.open(s)} data-testid="strategy-row">
      <TableCell className="w-[40%] max-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <StrategyGlyph id={s.id} size={24} />
          <div className="min-w-0">
            <div className="truncate font-medium" title={s.name}>
              {s.name || t('未命名')}
            </div>
            <div className="num truncate text-[11px] text-muted-foreground">{subtitle(s, now)}</div>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <StatusPill status={s.status} always />
        {run ? <RunPill run={run} /> : null}
      </TableCell>
      <TableCell className="h-9 w-24 py-0">
        {tested && sum ? <EquityArea values={sum.sparkline} tone={tone} className="h-7" /> : <span className="text-[11px] text-muted-foreground">{busy ? t('回测运行中…') : t('未回测')}</span>}
      </TableCell>
      <TableCell className={cn('num text-right', tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : '')}>{tested ? fmtReturn(sum?.total_return) : '—'}</TableCell>
      <TableCell className="num text-right">{tested ? fmtSharpe(sum?.sharpe, sum?.trades) : '—'}</TableCell>
      <TableCell className="num text-right text-down">{tested ? fmtDrawdown(sum?.max_drawdown) : '—'}</TableCell>
      <TableCell className="num text-right text-up">{tested ? fmtWinRate(sum?.win_rate, sum?.trades) : '—'}</TableCell>
      <TableCell className="num text-right">{tested ? fmtTrades(sum?.trades) : '—'}</TableCell>
      <TableCell className="text-right text-[11px] whitespace-nowrap text-muted-foreground">{relativeTime(s.updated_at, now)}</TableCell>
      <TableCell className="w-0 text-right">
        <div className="flex items-center justify-end gap-1">
          {tested ? (
            <IconButton label={t('分享')} onClick={() => actions.share(s)}>
              <Share />
            </IconButton>
          ) : (
            <IconButton label={t('继续构建')} onClick={() => actions.continueBuilding(s)}>
              <ArrowRight />
            </IconButton>
          )}
          <StrategyMenu strategy={s} actions={actions} />
        </div>
      </TableCell>
    </TableRow>
  );
}
