/**
 * 评审版新手引导(components/tour/*):首次自动弹、关闭后不再弹、Tour 按钮重开、非评审版不渲染;
 * 卡片定位 / 找目标退化 / 六步文案约束。
 * edition 是构建期常量,测试里用 vi.doMock + resetModules 切评审版 / 默认版。
 */
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
}
const brokenStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

async function load(judge: boolean) {
  vi.resetModules();
  vi.doMock('@/lib/edition', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../src/lib/edition')>();
    return { ...orig, IS_JUDGE: judge, EDITION: judge ? 'judge' : 'default' };
  });
  const store = await import('../src/components/tour/tour-store');
  const tour = await import('../src/components/tour/judge-tour');
  const tag = await import('../src/components/tour/status-tag');
  const steps = await import('../src/components/tour/steps');
  const { TooltipProvider } = await import('../src/components/ui/tooltip');
  store.resetTourForTest();
  return { store, tour, tag, steps, TooltipProvider };
}

afterEach(() => {
  vi.doUnmock('@/lib/edition');
});

describe('tour store', () => {
  let m: Awaited<ReturnType<typeof load>>;
  beforeEach(async () => {
    m = await load(true);
  });

  it('opens automatically on the first visit', () => {
    const s = memStorage();
    expect(m.store.maybeAutoStart(s)).toBe(true);
    expect(m.store.getTourState()).toEqual({ open: true, step: 0 });
  });

  it('does not open again once closed', () => {
    const s = memStorage();
    m.store.maybeAutoStart(s);
    m.store.setTourStep(3, 6);
    m.store.closeTour(s);
    expect(m.store.getTourState().open).toBe(false);
    expect(s.map.get(m.store.TOUR_SEEN_KEY)).toBe('1');
    m.store.resetTourForTest(); // 模拟刷新页面
    expect(m.store.maybeAutoStart(s)).toBe(false);
    expect(m.store.getTourState().open).toBe(false);
  });

  it('the Tour button reopens from step 1 after it was closed', () => {
    const s = memStorage();
    m.store.maybeAutoStart(s);
    m.store.setTourStep(4, 6);
    m.store.closeTour(s);
    const btn = m.tour.TourButton() as ReactElement<{ onClick: () => void }>;
    expect(btn).not.toBeNull();
    btn.props.onClick();
    expect(m.store.getTourState()).toEqual({ open: true, step: 0 });
  });

  it('survives storage that throws (private mode)', () => {
    expect(() => m.store.maybeAutoStart(brokenStorage)).not.toThrow();
    expect(() => m.store.closeTour(brokenStorage)).not.toThrow();
    expect(m.store.hasSeenTour(brokenStorage)).toBe(false);
    expect(m.store.hasSeenTour(null)).toBe(false);
  });

  it('clamps step navigation', () => {
    m.store.setTourStep(99, 6);
    expect(m.store.getTourState().step).toBe(5);
    m.store.setTourStep(-2, 6);
    expect(m.store.getTourState().step).toBe(0);
  });
});

describe('judge edition rendering', () => {
  it('renders the Tour button and the first step as a centered card when no target is on the page', async () => {
    const m = await load(true);
    const { JudgeTour, TourButton } = m.tour;
    const P = m.TooltipProvider;
    expect(renderToStaticMarkup(<TourButton />)).toContain('Tour');
    expect(renderToStaticMarkup(<P><JudgeTour /></P>)).toBe(''); // 没打开时什么都不画
    m.store.openTour(0);
    const html = renderToStaticMarkup(<P><JudgeTour /></P>);
    expect(html).toContain('Step 1 of 6');
    expect(html).toContain(m.steps.TOUR_STEPS[0]!.title);
    expect(html).toContain('data-placement="center"');
    expect(html).toContain('data-status-tag="live"');
    expect(html).toContain('data-status-tag="locked"'); // 第 1 步的图例
    expect(html).toContain('Skip');
  });

  it('last step carries the DevDay / paper-only note and a Done button', async () => {
    const m = await load(true);
    const P = m.TooltipProvider;
    const html = renderToStaticMarkup(<P><m.tour.TourStepView index={5} /></P>);
    expect(html).toContain('Step 6 of 6');
    expect(html).toContain('OKX DevDay');
    expect(html).toMatch(/paper/);
    expect(html).toContain('no real funds');
    expect(html).toContain('Done');
  });

  it('OKX.AI step is tagged Snapshot + Locked and links to the live listing', async () => {
    const m = await load(true);
    const P = m.TooltipProvider;
    const i = m.steps.TOUR_STEPS.findIndex((s) => s.id === 'okx-ai');
    const html = renderToStaticMarkup(<P><m.tour.TourStepView index={i} /></P>);
    expect(html).toContain('data-status-tag="snapshot"');
    expect(html).toContain('data-status-tag="locked"');
    expect(html).toContain('href="https://www.okx.ai/agents/13866"');
  });

  it('StatusTag shows in the judge edition', async () => {
    const m = await load(true);
    const P = m.TooltipProvider;
    expect(renderToStaticMarkup(<P><m.tag.StatusTag kind="live" /></P>)).toContain('LIVE');
  });
});

describe('default edition renders nothing', () => {
  it('no Tour button, no tour, no status tags', async () => {
    const m = await load(false);
    const P = m.TooltipProvider;
    expect(m.tour.TourButton()).toBeNull();
    m.store.openTour(0); // 即使状态被打开,默认版也不画
    expect(renderToStaticMarkup(<P><m.tour.JudgeTour /></P>)).toBe('');
    expect(renderToStaticMarkup(<P><m.tag.StatusTag kind="live" /></P>)).toBe('');
    expect(renderToStaticMarkup(<P><m.tag.StatusTag kind="snapshot" force /></P>)).toContain('Snapshot');
  });
});

describe('card placement and target lookup', () => {
  it('placeCard: below → above → right → corner, centered without a target', async () => {
    const { placeCard } = (await load(true)).tour;
    const vp = { width: 1200, height: 800 };
    const card = { width: 380, height: 240 };
    expect(placeCard(null, card, vp)).toMatchObject({ mode: 'center', top: 280, left: 410 });
    expect(placeCard({ top: 40, left: 100, width: 600, height: 40 }, card, vp)).toMatchObject({ mode: 'below', top: 92, left: 100 });
    expect(placeCard({ top: 600, left: 100, width: 600, height: 150 }, card, vp).mode).toBe('above');
    expect(placeCard({ top: 100, left: 20, width: 600, height: 650 }, card, vp).mode).toBe('right');
    const big = placeCard({ top: 0, left: 0, width: 1200, height: 800 }, card, vp);
    expect(big).toMatchObject({ mode: 'corner', top: 800 - 240 - 16, left: 1200 - 380 - 16 });
    // 窄屏:卡片不会被放到视口外
    const phone = placeCard({ top: 50, left: 300, width: 60, height: 20 }, { width: 343, height: 300 }, { width: 375, height: 700 });
    expect(phone.left).toBeGreaterThanOrEqual(16);
    expect(phone.left + 343).toBeLessThanOrEqual(375 - 16);
  });

  it('visibleShare: partly scrolled out vs taller than the viewport', async () => {
    const { visibleShare } = (await load(true)).tour;
    expect(visibleShare({ top: 700, bottom: 1000, height: 300 }, 800)).toBeCloseTo(1 / 3);
    expect(visibleShare({ top: -100, bottom: 1900, height: 2000 }, 800)).toBe(1);
    expect(visibleShare({ top: 900, bottom: 1000, height: 100 }, 800)).toBe(0);
  });

  it('findTarget falls back through selectors and never throws', async () => {
    const { findTarget } = (await load(true)).tour;
    const el = (w: number) => ({ getBoundingClientRect: () => ({ width: w, height: w }) }) as unknown as Element;
    const doc = {
      querySelector: (sel: string) => {
        if (sel === '[bad') throw new Error('SyntaxError');
        if (sel === '#zero') return el(0);
        if (sel === '#ok') return el(10);
        return null;
      },
    };
    expect(findTarget(['#missing'], doc)).toBeNull();
    expect(findTarget(['[bad', '#zero', '#ok'], doc)).not.toBeNull();
    expect(findTarget(['#zero'], doc)).toBeNull();
    expect(findTarget(['#ok'], null)).toBeNull();
  });
});

describe('tour content', () => {
  it('six steps, English only, 2–3 sentences each, real routes and data-tour anchors', async () => {
    const { steps } = await load(true);
    const { TOUR_STEPS } = steps;
    expect(TOUR_STEPS.map((s) => s.hash.split('?')[0])).toEqual(['floor', 'agent', 'strategy-research', 'trade', 'market', 'history']);
    for (const s of TOUR_STEPS) {
      const text = [s.title, ...s.body, ...(s.links ?? []).map((l) => l.label)].join(' ');
      expect(text, s.id).not.toMatch(/[一-鿿]/);
      const sentences = s.body.join(' ').split(/(?<=[.!?”])\s+(?=[A-Z“])/).length;
      expect(sentences, s.id).toBeGreaterThanOrEqual(2);
      expect(sentences, s.id).toBeLessThanOrEqual(3);
      expect(s.tags.length, s.id).toBeGreaterThan(0);
      expect(s.targets[0], s.id).toMatch(/^\[data-(tour|testid)=/);
    }
    expect(steps.TOUR_FOOTNOTE).not.toMatch(/[一-鿿]/);
  });

  it('agent step pre-fills the sample question without sending it', async () => {
    const { steps } = await load(true);
    const dispatched: string[] = [];
    vi.stubGlobal('window', { location: { hash: '#agent' }, dispatchEvent: (e: Event) => void dispatched.push(e.type), addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal('CustomEvent', class { constructor(public type: string) {} });
    try {
      const { takePendingQuestion } = await import('../src/lib/ask-agent');
      steps.TOUR_STEPS.find((s) => s.id === 'agent')!.onEnter!();
      expect(takePendingQuestion()).toBe(steps.TOUR_SAMPLE_QUESTION);
      expect(dispatched).toEqual(['tg:ask-agent']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
