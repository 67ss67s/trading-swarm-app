/**
 * 评审版新手引导(2026-09-26,OKX DevDay 评审用):六步,每步跳到对应页面并高亮关键区域。
 *
 *   - 只在评审版生效(IS_JUDGE);首次访问自动弹出,关闭 / 走完记进 localStorage(tour-store.ts)
 *   - 顶栏 TourButton 随时从第 1 步重开
 *   - 高亮 = 目标元素外一圈描边 + 其余区域压暗;压暗层 pointer-events: none,评审照样能点页面(比如点「发送」)
 *   - 目标元素找不到(数据没加载、窄屏被折叠)→ 退化成居中卡片,不报错
 * 用现有 shadcn 组件(Button / Badge / Tooltip),不引新依赖;文案英文、不走 t()。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Compass, ExternalLink, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IS_JUDGE } from '@/lib/edition';
import { cn } from '@/lib/utils';
import { StatusTag, type StatusKind } from './status-tag';
import { TOUR_FOOTNOTE, TOUR_STEPS, type TourLink, type TourStep } from './steps';
import { closeTour, maybeAutoStart, reopenTour, setTourStep, useTourState } from './tour-store';

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

// 服务端渲染(测试)时没有 layout effect,用 useEffect 代替,免得 React 警告
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const GAP = 12;
const EDGE = 16;
const PAD = 6;

/** 卡片放哪:目标下方 → 上方 → 右侧 → 左侧;都放不下(目标太大,比如楼层场景)就贴视口右下角;没目标就居中。 */
export function placeCard(target: Box | null, card: { width: number; height: number }, viewport: { width: number; height: number }, corner = false): { top: number; left: number; mode: 'center' | 'below' | 'above' | 'right' | 'left' | 'corner' } {
  const clampX = (x: number) => Math.min(Math.max(EDGE, x), Math.max(EDGE, viewport.width - card.width - EDGE));
  const clampY = (y: number) => Math.min(Math.max(EDGE, y), Math.max(EDGE, viewport.height - card.height - EDGE));
  if (corner) return { top: clampY(viewport.height - card.height - EDGE), left: clampX(viewport.width - card.width - EDGE), mode: 'corner' };
  if (!target) return { top: clampY((viewport.height - card.height) / 2), left: clampX((viewport.width - card.width) / 2), mode: 'center' };
  const bottom = target.top + target.height;
  const right = target.left + target.width;
  if (viewport.height - bottom - GAP - EDGE >= card.height) return { top: bottom + GAP, left: clampX(target.left), mode: 'below' };
  if (target.top - GAP - EDGE >= card.height) return { top: target.top - GAP - card.height, left: clampX(target.left), mode: 'above' };
  if (viewport.width - right - GAP - EDGE >= card.width) return { top: clampY(target.top), left: right + GAP, mode: 'right' };
  if (target.left - GAP - EDGE >= card.width) return { top: clampY(target.top), left: target.left - GAP - card.width, mode: 'left' };
  return { top: clampY(viewport.height - card.height - EDGE), left: clampX(viewport.width - card.width - EDGE), mode: 'corner' };
}

/** 依次试选择器,返回第一个在页面上、且有尺寸的元素 */
export function findTarget(selectors: readonly string[], doc: Pick<Document, 'querySelector'> | null = typeof document === 'undefined' ? null : document): Element | null {
  if (!doc) return null;
  for (const sel of selectors) {
    try {
      const el = doc.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    } catch {
      /* 选择器写错也别炸 */
    }
  }
  return null;
}

/** 当前 hash 的页面段(? 前) */
function currentPage(): string {
  try {
    return window.location.hash.slice(1).split('?')[0] ?? '';
  } catch {
    return '';
  }
}

function goHash(hash: string): void {
  try {
    if (window.location.hash.slice(1) !== hash) window.location.hash = hash;
  } catch {
    /* 沙箱 */
  }
}

/** 目标在视口里露出的比例(按「它能露出的最大高度」算:比视口还高的元素露满一屏就算 1) */
export function visibleShare(r: { top: number; bottom: number; height: number }, viewportHeight: number): number {
  const shown = Math.max(0, Math.min(viewportHeight, r.bottom) - Math.max(0, r.top));
  const possible = Math.min(r.height, viewportHeight);
  return possible > 0 ? shown / possible : 0;
}

function sameBox(a: Box | null, b: Box | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.top - b.top) < 1 && Math.abs(a.left - b.left) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
}

/** 顶栏按钮:随时重开引导(默认版不渲染) */
export function TourButton() {
  if (!IS_JUDGE) return null;
  return (
    <Button variant="ghost" size="xs" className="gap-1 px-1.5 text-muted-foreground hover:text-foreground" title="Take the 2-minute tour" aria-label="Take the tour" data-tour-button onClick={reopenTour}>
      <Compass data-slot="icon" />
      Tour
    </Button>
  );
}

/** 挂在 App 根上;默认版什么都不渲染 */
export function JudgeTour() {
  return IS_JUDGE ? <TourRoot /> : null;
}

function TourRoot() {
  const s = useTourState();
  useEffect(() => {
    // 首次访问:等外壳先画出来再弹,免得和默认首页跳转抢 hash
    const id = window.setTimeout(() => maybeAutoStart(), 600);
    return () => window.clearTimeout(id);
  }, []);
  if (!s.open) return null;
  const index = Math.min(s.step, TOUR_STEPS.length - 1);
  return <TourStepView key={index} index={index} />;
}

export function TourStepView({ index }: { index: number }) {
  const step = TOUR_STEPS[index]!;
  const total = TOUR_STEPS.length;
  const last = index === total - 1;
  const [target, setTarget] = useState<Box | null>(null);
  const [cardSize, setCardSize] = useState({ width: 360, height: 260 });
  const [viewport, setViewport] = useState(() => (typeof window === 'undefined' ? { width: 1280, height: 800 } : { width: window.innerWidth, height: window.innerHeight }));
  const cardRef = useRef<HTMLDivElement | null>(null);

  // 进这一步:跳页 → 轮询找目标(页面数据是异步来的)→ 找到后滚进视口、执行 onEnter;之后跟着滚动 / 缩放重新量
  useEffect(() => {
    goHash(step.hash);
    let entered = false;
    // 前 2.5 秒内目标没露出一半就再滚一次(页面数据陆续加载会把目标往下推);之后不再抢滚动
    const scrollUntil = Date.now() + 2500;
    let prev: Box | null = null;
    const enter = () => {
      if (entered) return;
      entered = true;
      try {
        step.onEnter?.();
      } catch {
        /* 引导不能因为预填失败而卡住 */
      }
    };
    const measure = () => {
      const el = findTarget(step.targets);
      let next: Box | null = null;
      if (el) {
        enter();
        let r = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        if (Date.now() < scrollUntil && visibleShare(r, vh) < 0.5) {
          try {
            el.scrollIntoView({ block: r.height > vh * 0.8 ? 'start' : 'center', inline: 'nearest' });
          } catch {
            /* 老浏览器 */
          }
          r = el.getBoundingClientRect();
        }
        // 裁到视口里,免得描边画到屏幕外
        const top = Math.max(0, r.top);
        const left = Math.max(0, r.left);
        const bottom = Math.min(vh, r.bottom);
        const right = Math.min(vw, r.right);
        if (bottom - top > 4 && right - left > 4) next = { top, left, width: right - left, height: bottom - top };
      }
      if (!sameBox(prev, next)) {
        prev = next;
        setTarget(next);
      }
      setViewport((v) => (v.width === window.innerWidth && v.height === window.innerHeight ? v : { width: window.innerWidth, height: window.innerHeight }));
    };
    const first = window.setTimeout(measure, 80);
    const poll = window.setInterval(measure, 300);
    // 目标一直等不到(比如数据还没来):onEnter 照样执行一次(预填问题会在对话框挂载时被取走)
    const fallback = window.setTimeout(enter, 2500);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(poll);
      window.clearTimeout(fallback);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step]);

  useIsoLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const next = { width: el.offsetWidth, height: el.offsetHeight };
    if (next.width && next.height && (next.width !== cardSize.width || next.height !== cardSize.height)) setCardSize(next);
  });

  // 评审从卡片里的链接(或侧栏)点去别的页:不压暗、卡片缩到右下角,给一个「回到这一步」
  // 初值按「已经跳到这一步的页」算(跳转在 effect 里,hashchange 稍后才到),免得第一帧误判成离开
  const [page, setPage] = useState(() => step.hash.split('?')[0]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeTour();
    };
    const onHash = () => setPage(currentPage());
    window.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  const away = page !== step.hash.split('?')[0];

  const pos = away ? placeCard(null, cardSize, viewport, true) : placeCard(target, cardSize, viewport);
  const go = (n: number) => setTourStep(n, total);

  return (
    <div data-judge-tour={step.id} className="pointer-events-none fixed inset-0 z-[60]">
      {away ? null : target ? (
        <div
          aria-hidden
          className="absolute rounded-lg ring-2 ring-primary transition-all duration-200 ease-out motion-reduce:transition-none"
          style={{ top: target.top - PAD, left: target.left - PAD, width: target.width + PAD * 2, height: target.height + PAD * 2, boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.42)' }}
        />
      ) : (
        <div aria-hidden className="absolute inset-0 bg-black/40" />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby="judge-tour-title"
        className="pointer-events-auto absolute flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2.5 rounded-xl border bg-popover p-4 text-popover-foreground shadow-2xl animate-in fade-in zoom-in-95 duration-200"
        style={{ top: pos.top, left: pos.left }}
        data-placement={pos.mode}
      >
        <div className="flex items-center gap-1.5">
          <span className="num text-[11px] text-muted-foreground">
            Step {index + 1} of {total}
          </span>
          {step.tags.map((k) => (
            <StatusTag key={k} kind={k} force />
          ))}
          <Button variant="ghost" size="icon-xs" className="ml-auto -mr-1.5" aria-label="Close tour" title="Close (Esc)" onClick={() => closeTour()}>
            <X />
          </Button>
        </div>
        <h2 id="judge-tour-title" className="text-[15px] leading-snug font-semibold">
          {step.title}
        </h2>
        <div className="flex flex-col gap-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
          {step.body.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
        {step.links?.length ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
            {step.links.map((l) => (
              <TourLinkView key={l.label} link={l} />
            ))}
          </div>
        ) : null}
        {away ? (
          <button type="button" className="inline-flex w-fit items-center gap-1 text-[12px] font-medium text-primary underline-offset-2 hover:underline" onClick={() => goHash(step.hash)}>
            <ArrowLeft className="size-3" />
            Back to this step
          </button>
        ) : null}
        {index === 0 ? <TagLegend /> : null}
        {last ? <p className="rounded-md border border-primary/30 bg-primary/5 px-2.5 py-2 text-[11.5px] leading-snug text-foreground/90">{TOUR_FOOTNOTE}</p> : null}
        <div className="mt-0.5 flex items-center gap-2">
          <div className="flex items-center gap-1" aria-hidden>
            {TOUR_STEPS.map((s, i) => (
              <span key={s.id} className={cn('h-1.5 rounded-full transition-all', i === index ? 'w-4 bg-primary' : 'w-1.5 bg-muted-foreground/30')} />
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {index > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => go(index - 1)}>
                <ArrowLeft data-slot="icon" />
                Back
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => closeTour()}>
                Skip
              </Button>
            )}
            {last ? (
              <Button size="sm" onClick={() => closeTour()}>
                Done
              </Button>
            ) : (
              <Button size="sm" onClick={() => go(index + 1)}>
                Next
                <ArrowRight data-slot="icon" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TourLinkView({ link }: { link: TourLink }) {
  const external = /^https?:\/\//.test(link.href);
  return (
    <a
      href={link.href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      onClick={() => {
        try {
          link.before?.();
        } catch {
          /* ignore */
        }
      }}
      className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
    >
      {link.label}
      {external ? <ExternalLink className="size-3" /> : <ArrowRight className="size-3" />}
    </a>
  );
}

const LEGEND: { kind: StatusKind; text: string }[] = [
  { kind: 'live', text: 'real model calls, OKX market data, paper fills' },
  { kind: 'snapshot', text: 'read-only copy of our OKX.AI agent' },
  { kind: 'locked', text: 'private in this edition' },
];

function TagLegend() {
  return (
    <div className="flex flex-col gap-1 rounded-md bg-muted/50 px-2.5 py-2 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground/80">Look for these tags as you go:</span>
      {LEGEND.map((l) => (
        <span key={l.kind} className="flex items-center gap-1.5">
          <StatusTag kind={l.kind} force />
          {l.text}
        </span>
      ))}
    </div>
  );
}
