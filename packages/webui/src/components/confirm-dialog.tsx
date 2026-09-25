/**
 * 全站确认弹窗(仿 8793 frontend-design/src/components/confirm-dialog.tsx,去掉 i18n
 * 和"以后不再输入"跳过逻辑——本项目只有紧急停止/解除这类高风险操作用得到 requireText,
 * 该输入的就一直要输入):
 * - danger:红色语义(紧急停止/撤单平仓这类);
 * - requireText:必须原样输入指定文本(比如 "HALT")按钮才可用;
 * - busy:请求中禁用,防止双击双发。
 */
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { t } from '@/lib/i18n';

export function ConfirmDialog({
  open,
  title,
  summary,
  danger,
  requireText,
  busy,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  summary: string;
  danger?: boolean;
  requireText?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const requireTextInputId = useId();
  const [text, setText] = useState('');
  useEffect(() => {
    if (!open) setText('');
  }, [open]);
  const unlocked = !requireText || text === requireText;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className={danger ? 'text-destructive' : undefined}>{title}</DialogTitle>
          <DialogDescription className="sr-only">{summary}</DialogDescription>
        </DialogHeader>
        {children ? <div className="flex flex-col gap-3 text-[13px]">{children}</div> : null}
        {requireText ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={requireTextInputId} className="text-[11px] font-medium text-foreground">
              {t('输入「{text}」确认:', { text: requireText })}
            </label>
            <Input
              id={requireTextInputId}
              autoFocus
              placeholder={requireText}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && unlocked && !busy) onConfirm();
                if (event.key === 'Escape') onCancel();
              }}
              className="num"
              spellCheck={false}
            />
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
            {t('取消')}
          </Button>
          <Button variant={danger ? 'destructive' : 'default'} size="sm" disabled={!unlocked || busy} onClick={onConfirm}>
            {busy ? t('处理中…') : summary}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
