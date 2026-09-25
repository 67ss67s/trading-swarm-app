/**
 * 楼层 v4 外壳里的 React 件:审批金信封卡(真两步确认)、交接卡(真 ack)、紧急停止(掀罩 + 按住 2 秒)、像素 logo。
 * 审批口径同 components/approvals.tsx:先取一次性确认码(120 秒)→ 带 nonce 批;拒绝不需要确认码。
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiRequestError } from '@/api/client';
import type { BotHandoff, ConfirmToken, DemoIntent } from '@/api/types';
import { backendLabel, directionLabel, fmtPrice, fmtQty, relativeTime, useNow } from '@/lib/format';
import { t } from '@/lib/i18n';
import { ROLES } from './engine-b/roles';
import { isRole } from './snapshot';

function errText(e: unknown): { text: string; retake: boolean } {
  if (e instanceof ApiRequestError) {
    if (e.code === 'confirm_expired') return { text: t('确认过期了(120 秒),重新取一次'), retake: true };
    if (e.code === 'confirm_unknown') return { text: t('确认码用过了或者不存在,重新取一次'), retake: true };
    if (e.code === 'confirm_mismatch') return { text: t('你确认之前内容变了,已经重新拉一遍,再看一眼'), retake: true };
    return { text: e.message, retake: false };
  }
  return { text: e instanceof Error ? e.message : String(e), retake: false };
}

export function IntentCard({ it, onDone, onClose }: { it: DemoIntent; onDone: (approved: boolean) => void; onClose: () => void }) {
  const qc = useQueryClient();
  const now = useNow(1000);
  const [token, setToken] = useState<ConfirmToken | null>(null);
  const left = token ? Math.max(0, Math.floor((token.expires_at - now) / 1000)) : 0;
  useEffect(() => {
    if (token && left === 0) setToken(null);
  }, [token, left]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['intents'] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
    void qc.invalidateQueries({ queryKey: ['activity'] });
  };
  const arm = useMutation({ mutationFn: () => api.intentConfirmToken(it.id), onSuccess: setToken, onError: (e) => toast.error(t('取不到确认码'), { description: errText(e).text }) });
  const go = useMutation({
    mutationFn: () => {
      if (!token) throw new Error(t('先点一次取确认码'));
      return api.approveIntent(it.id, token.nonce);
    },
    onSuccess: () => {
      setToken(null);
      toast.success(t('已批准:金信封飞向 EXEC'));
      refresh();
      onDone(true);
    },
    onError: (e) => {
      const r = errText(e);
      toast.error(t('没执行'), { description: r.text });
      setToken(null);
      if (r.retake) arm.mutate();
    },
  });
  const reject = useMutation({
    mutationFn: () => api.rejectIntent(it.id),
    onSuccess: () => {
      toast.success(t('已拒绝:信封揉成了纸团'));
      refresh();
      onDone(false);
    },
    onError: (e) => toast.error(t('拒绝失败'), { description: errText(e).text }),
  });
  const tk = token?.intent;
  return (
    <div className="pcard" role="dialog" aria-label={t('待批订单')}>
      <div className="env">✉</div>
      <h4>
        {t('待你批准')} · {it.kind === 'open' ? t('开仓') : it.kind === 'close' ? t('平仓') : t('减仓')} {it.symbol}
      </h4>
      <div className="kv">
        <span>{t('方向')}</span>
        <b>{directionLabel(it.direction)}</b>
        <span>{t('数量')}</span>
        <b>{fmtQty(it.quantity)}</b>
        <span>{t('入场')}</span>
        <b>{it.entry === 'market' ? t('市价') : t('限价 {price}', { price: fmtPrice(it.limit_price) })}</b>
        <span>{t('止损 / 止盈')}</span>
        <b>
          {it.stop_price ? fmtPrice(it.stop_price) : '—'} / {it.take_profit_price ? fmtPrice(it.take_profit_price) : '—'}
        </b>
        <span>{t('通道')}</span>
        <b>{backendLabel(it.backend)}</b>
      </div>
      {it.sizing?.note ? <p className="hint">{it.sizing.note}</p> : null}
      <p className="hint">
        {it.principal === 'agent' ? 'agent' : t('手动')} · {relativeTime(it.at)} · {t('批准绑定 plan_hash,只能拒不能改经济字段')}
      </p>
      {tk ? (
        <div className="arm">
          {t('再看一遍。确认之后是真的下到 {backend}', { backend: backendLabel(tk.backend) })} · {tk.symbol} {directionLabel(tk.direction)} {fmtQty(tk.quantity)} · <b className="mono">{left}s</b>
        </div>
      ) : null}
      <div className="btns">
        {token ? (
          <button type="button" className="ok" disabled={go.isPending} onClick={() => go.mutate()}>
            {t('确认执行')}
          </button>
        ) : (
          <button type="button" className="ok" disabled={arm.isPending} onClick={() => arm.mutate()} title={t('第一步:取一个一次性确认码,把要点摆出来;这一步不下单')}>
            {t('批准…')}
          </button>
        )}
        <button type="button" className="no" disabled={reject.isPending} onClick={() => reject.mutate()}>
          {t('拒绝')}
        </button>
        <button type="button" onClick={onClose}>
          {t('稍后')}
        </button>
      </div>
    </div>
  );
}

export function HandoffCard({ h, onClose }: { h: BotHandoff; onClose: () => void }) {
  const qc = useQueryClient();
  const ack = useMutation({
    mutationFn: () => api.ackHandoff(h.handoff_id),
    onSuccess: () => {
      toast.success(t('已阅(不代表接手或授权)'));
      void qc.invalidateQueries({ queryKey: ['bots'] });
      onClose();
    },
    onError: (e) => toast.error(t('标记已阅失败'), { description: errText(e).text }),
  });
  const from = isRole(h.from_role) ? ROLES[h.from_role] : null;
  const to = isRole(h.to_role) ? ROLES[h.to_role] : null;
  return (
    <div className="pcard" role="dialog" aria-label={t('交接')} style={{ borderColor: from?.color ?? '#ffd23a' }}>
      <h4>
        <span style={{ color: from?.color }}>{from?.callsign ?? h.from_role}</span> → <span style={{ color: to?.color }}>{to?.callsign ?? h.to_role}</span>
      </h4>
      <p>{h.summary}</p>
      <p className="hint">
        {h.subject.type} · {h.subject.id} · {relativeTime(h.created_at)}
      </p>
      <div className="btns">
        <button type="button" className="ok" disabled={ack.isPending} onClick={() => ack.mutate()}>
          {t('已阅')}
        </button>
        <button type="button" onClick={onClose}>
          {t('稍后')}
        </button>
      </div>
    </div>
  );
}

/** 紧急停止:先掀保护罩,再按住红钮 2 秒;halted 时只显示状态 */
export function EStop({ halted, onFire }: { halted: boolean; onFire: () => void }) {
  const [open, setOpen] = useState(false);
  const [hold, setHold] = useState(false);
  const progRef = useRef<SVGCircleElement>(null);
  const raf = useRef(0);
  const lidTimer = useRef(0);
  const C = 2 * Math.PI * 15;
  useEffect(() => () => {
    cancelAnimationFrame(raf.current);
    window.clearTimeout(lidTimer.current);
  }, []);
  const stop = () => {
    cancelAnimationFrame(raf.current);
    setHold(false);
    if (progRef.current) progRef.current.style.strokeDashoffset = `${C}`;
  };
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    const t0 = performance.now();
    setHold(true);
    const tick = () => {
      const k = Math.min(1, (performance.now() - t0) / 2000);
      if (progRef.current) progRef.current.style.strokeDashoffset = `${C * (1 - k)}`;
      if (k >= 1) {
        stop();
        setOpen(false);
        onFire();
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };
  if (halted)
    return (
      <div className="estop halted" title={t('紧急停止生效中;解除在顶栏右上角')}>
        <div className="lid">{t('已紧急停止')}</div>
      </div>
    );
  return (
    <div className={`estop${open ? ' open' : ''}`}>
      <div
        className="lid"
        title={t('先掀开保护罩,再按住红钮 2 秒')}
        onClick={() => {
          setOpen(true);
          window.clearTimeout(lidTimer.current);
          lidTimer.current = window.setTimeout(() => setOpen(false), 6000);
        }}
      >
        {t('紧急停止')}
      </div>
      <button type="button" className={`btn${hold ? ' hold' : ''}`} title={t('按住 2 秒')} onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}>
        <svg viewBox="0 0 36 36">
          <circle className="trk" cx="18" cy="18" r="15" />
          <circle ref={progRef} className="prog" cx="18" cy="18" r="15" style={{ strokeDasharray: C, strokeDashoffset: C }} />
        </svg>
        <span>STOP</span>
      </button>
    </div>
  );
}

const LOGO = ['.....##......', '....####.....', '...######....', '..##.##.##...', '..########...', '...######....', '..#.#..#.#...', '.............', '.##.......##.', '##.#.....#.##', '.##.......##.', '.............', '.............'];
export function PixelLogo({ color }: { color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current?.getContext('2d');
    if (!c) return;
    c.clearRect(0, 0, 13, 13);
    LOGO.forEach((r, y) => [...r].forEach((ch, x) => {
      if (ch === '#') {
        c.fillStyle = y < 7 ? color : '#9be15d';
        c.fillRect(x, y, 1, 1);
      }
    }));
  }, [color]);
  return <canvas ref={ref} width={13} height={13} />;
}
