/**
 * 页面级错误边界:任何一页渲染抛错,只黑这一页并把错误原文显示出来(带「重试」和「清本机偏好」),
 * 而不是整个应用卸载成一片黑(2026-09-06 楼层页在 Jacky 的浏览器里就是这样黑掉的,无头浏览器里复现不了,
 * 因为差别在 localStorage)。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '@/lib/i18n';

interface State {
  error: Error | null;
  info: string | null;
}

export class PageErrorBoundary extends Component<{ page: string; children: ReactNode }, State> {
  override state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info: info.componentStack ?? null });
    console.error(`[page:${this.props.page}]`, error, info.componentStack);
  }

  override componentDidUpdate(prev: { page: string }): void {
    if (prev.page !== this.props.page && this.state.error) this.setState({ error: null, info: null });
  }

  override render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    const clearLocal = () => {
      try {
        for (const k of Object.keys(window.localStorage)) if (k.startsWith('tg.') || k.startsWith('trade-')) window.localStorage.removeItem(k);
      } catch {
        /* ignore */
      }
      this.setState({ error: null, info: null });
    };
    return (
      <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto rounded-md border border-destructive/40 bg-card p-4 text-[12px]">
        <div className="text-[13px] font-semibold text-destructive">{t('这一页渲染出错了,别的页不受影响')}</div>
        <pre className="whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[11px]">{error.message}</pre>
        {info ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[10px] text-muted-foreground">{info.trim()}</pre> : null}
        <div className="flex gap-2">
          <button type="button" className="rounded border px-2 py-1 hover:bg-accent" onClick={() => this.setState({ error: null, info: null })}>
            {t('重试')}
          </button>
          <button type="button" className="rounded border px-2 py-1 hover:bg-accent" onClick={clearLocal} title={t('清掉本机存的楼层外观、折叠状态、tab 记忆等偏好,再重试')}>
            {t('清本机偏好再重试')}
          </button>
        </div>
        <div className="text-[11px] text-muted-foreground">{t('把上面的错误原文发给我就能定位。')}</div>
      </div>
    );
  }
}
