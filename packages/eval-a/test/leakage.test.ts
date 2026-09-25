import { describe, expect, it } from 'vitest';
import { buildCase, detectLeakage, legitNumbers } from '../src/index.js';
import { synthCases } from './helpers/synthetic.js';

describe('future leakage detector', () => {
  it('passes a clean context and catches an injected future close price', async () => {
    const cases = await synthCases({ n: 2 });
    for (const c of cases) {
      const { built } = buildCase(c);
      expect(detectLeakage(c, built.context_text)).toEqual([]);
    }
    const c = cases.find((x) => x.tags.includes('base'))!;
    const { built } = buildCase(c);
    const legit = legitNumbers(c);
    const future = c.hidden.future_klines.map((k) => k.close).find((v) => !legit.has(String(Number(v))))!;
    expect(future).toBeDefined();
    const tampered = `${built.context_text}\n下一根收盘 ${future}`;
    const v = detectLeakage(c, tampered);
    expect(v.length).toBe(1);
    expect(v[0]).toContain(future);
  });

  it('catches a future bar smuggled into the visible klines', async () => {
    const [c0] = (await synthCases({ n: 1 })).filter((x) => x.tags.includes('base'));
    const c = structuredClone(c0!);
    c.visible.klines['15m']!.push(c.hidden.future_klines[3]!);
    const { built } = buildCase(c);
    const v = detectLeakage(c, built.context_text);
    expect(v.some((s) => s.includes('close_time') && s.includes('> as_of'))).toBe(true);
    expect(v.some((s) => s.includes('equals a hidden future bar'))).toBe(true);
  });

  it('catches a timestamp after as_of in the context', async () => {
    const [c] = (await synthCases({ n: 1 })).filter((x) => x.tags.includes('base'));
    const { built } = buildCase(c!);
    const later = new Date(c!.as_of + 3_600_000).toISOString();
    expect(detectLeakage(c!, `${built.context_text}\n${later}`).some((s) => s.includes('之后的时间'))).toBe(true);
    const shortStamp = new Date(c!.as_of + 2 * 3_600_000).toISOString().slice(5, 16).replace('T', ' ');
    expect(detectLeakage(c!, `${built.context_text}\n最近一根 ${shortStamp} O1 H1 L1 C1`).some((s) => s.includes(shortStamp))).toBe(true);
  });
});
