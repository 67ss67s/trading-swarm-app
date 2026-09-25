import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/* 工作区面板系统:整页一个 Workspace 外框,内部 Pane 用 1px 分割线联排,
   面板头是纤细工具条 —— 桌面终端范式,不做漂浮卡片。 */

export function Workspace({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("min-h-0 overflow-hidden rounded-md border bg-card", className)}>{children}</div>;
}

interface PaneProps {
  title: string;
  hint?: string;
  actions?: ReactNode;
  className?: string;
  contentClassName?: string;
  children: ReactNode;
}

export function Pane({ title, hint, actions, className, contentClassName, children }: PaneProps) {
  return (
    <section className={cn("flex min-h-0 min-w-0 flex-col", className)}>
      <header className="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/40 px-2.5 select-none">
        <h2 className="kicker text-[10.5px] text-foreground/85">{title}</h2>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
        <div className="ml-auto flex items-center gap-1">{actions}</div>
      </header>
      <div className={cn("min-h-0 flex-1", contentClassName)}>{children}</div>
    </section>
  );
}

/** 状态带单元格:label 上、num 值下,联排使用 */
export function StatCell({
  label,
  value,
  unit,
  sub,
  aside,
  className,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-center justify-between gap-2 px-3 py-2", className)}>
      <div className="min-w-0">
        <div className="text-[11px] text-muted-foreground select-none">{label}</div>
        <div className="num mt-0.5 truncate text-[17px]/6 font-semibold">
          {value}
          {unit ? <span className="ml-1 text-[11px] font-normal text-muted-foreground">{unit}</span> : null}
        </div>
        {sub ? <div className="num mt-0.5 flex items-center gap-1.5 text-[11px]">{sub}</div> : null}
      </div>
      {aside ? <div className="shrink-0">{aside}</div> : null}
    </div>
  );
}
