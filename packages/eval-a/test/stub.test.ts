import { describe, expect, it } from 'vitest';
import { demo } from '@trading-swarm/gateway';
import { buildCase, stubJudge } from '../src/index.js';
import { synthCases } from './helpers/synthetic.js';

const judge = (c: Parameters<typeof buildCase>[0]) => {
  const { built } = buildCase(c);
  const raw = stubJudge(built.system_text, built.user_text);
  const v = demo.validateJudgment(demo.extractJson(raw), new Set(built.evidence.map((e) => e.ref)));
  return { raw, judgment: v.judgment, errors: v.errors, built };
};

describe('stub brain', () => {
  it('is deterministic, contract-valid and never opens on stale or halted cases', async () => {
    const cases = await synthCases({ n: 3 }, 3);
    const actions = new Set<string>();
    for (const c of cases) {
      const a = judge(c);
      const b = judge(c);
      expect(a.raw).toBe(b.raw);
      expect(a.errors).toEqual([]);
      actions.add(a.judgment!.action);
      if (c.tags.includes('stale') || c.tags.includes('halted')) expect(a.judgment!.action).not.toBe('PROPOSE');
      if (c.mode === 'review') expect(a.built.allowed_actions).toContain(a.judgment!.action);
      else expect(['NO_TRADE', 'WATCH', 'PROPOSE']).toContain(a.judgment!.action);
    }
    expect(actions.size).toBeGreaterThanOrEqual(2);
  });

  it('exits a long whose price is already through the stop', async () => {
    const cases = await synthCases({ n: 2 }, 5);
    const rev = cases.find((c) => c.mode === 'review' && c.thread!.status === 'in_position' && c.thread!.side === 'long') ?? cases.find((c) => c.mode === 'review' && c.thread!.status === 'in_position')!;
    const c = structuredClone(rev);
    const long = c.thread!.side === 'long';
    const stop = Number(c.thread!.stop_price);
    c.visible.market.last = c.visible.market.mark = (long ? stop * 0.995 : stop * 1.005).toFixed(2);
    const r = judge(c);
    expect(['INVALIDATE', 'EXIT']).toContain(r.judgment!.action);
  });
});
