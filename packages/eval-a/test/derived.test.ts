// 派生数字身份(09-12):
// ① 09-04 的 13 个「幻觉」样本回归 —— 12 个是模型自算的浮盈 / 止损距离 / R 差值(假阳性,写出公式
//    并能复算就该放行),只有 1 个是真的凭空造数(仍判)。样本按 docs/eval/results-2026-09-04.md 里
//    记的数字复原(原始 run 目录在 .gitignore 里,不在仓库)。
// ② P1-16 对抗用例 —— 旧口径「只给编号 + 池子穷举」能被假标注洗白,现在必须判幻觉。

import { describe, expect, it } from 'vitest';
import type { Evidence, Judgment } from '../src/index.js';
import { checkDerived, derivedAnnotations, evidenceFields, hallucinationReport, hallucinatedNumbers } from '../src/index.js';

const ev = (ref: string, value: string, kind = 'market'): Evidence => ({ ref, kind, label: ref, value, observed_at: 0, source: 't', stale: false });
const J = (reason: string): Judgment => ({ action: 'HOLD', direction: 'long', confidence: 0.5, headline: 'h', thesis: 't', reasons: [reason], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null });

interface Sample {
  name: string;
  evidence: Evidence[];
  /** 带公式来源标注的写法(新 prompt 下模型应该写成这样)。 */
  reason: string;
  /** 09-04 那次实际写出来的、没有标注的写法。 */
  raw_reason: string;
}

/** 12 个假阳性:每个都能从它标注的公式里带符号复算回来。 */
const FALSE_POSITIVES: Sample[] = [
  {
    name: '止损距离 249.66(成交价 − 止损价)',
    evidence: [ev('E1', 'last 108208.5, mark 108210.0'), ev('E2', '成交 107958.84;止损 107709.18;止盈 108800.00')],
    reason: '止损距离 249.66(由 E2.成交-E2.止损 算出),不到一个 15m ATR [E2]',
    raw_reason: '止损距离 249.66,不到一个 15m ATR [E2]',
  },
  {
    name: '浮盈 66.34 USDT((现价 − 成交价) × 数量)',
    evidence: [ev('E1', 'last 108208.5, mark 108210.0'), ev('E3', '权益 10000 USDT, 可用 9500; 方向 多; 数量 0.05; 成交 106881.4')],
    reason: '当前浮盈 66.34 USDT(由 (E1.last-E3.成交)*E3.数量 算出),约半个 R [E3]',
    raw_reason: '当前浮盈 66.34 USDT,约半个 R [E3]',
  },
  {
    name: '距 20 根高点 339(取整)',
    evidence: [ev('E1', 'last 108208.5, mark 108210.0'), ev('E2', '20根高 108547.0 低 106881.4')],
    reason: '离 20 根高点还有 339(由 E2.20根高-E1.last 算出)点 [E2]',
    raw_reason: '离 20 根高点还有 339 点 [E2]',
  },
  {
    name: '距 20 根高点 339.52',
    evidence: [ev('E1', 'last 108208.5, mark 108210.0'), ev('E2', '20根高 108547.0 低 106881.4')],
    reason: '距突破位 339.52(由 E2.20根高-E1.last 算出) [E2]',
    raw_reason: '距突破位 339.52 [E2]',
  },
  {
    name: '距 20 根高点 340',
    evidence: [ev('E1', 'last 108208.5, mark 108210.0'), ev('E2', '20根高 108547.0 低 106881.4')],
    reason: '上方还有 340(由 E2.20根高-E1.last 算出)的空间 [E2]',
    raw_reason: '上方还有 340 的空间 [E2]',
  },
  {
    name: '距 20 根低点 1327',
    evidence: [ev('E1', 'last 108208.5, mark 108210.0'), ev('E2', '20根高 108547.0 低 106881.4')],
    reason: '距 20 根低点 1327(由 E1.last-E2.低 算出)点,结构仍完好 [E2]',
    raw_reason: '距 20 根低点 1327 点,结构仍完好 [E2]',
  },
  {
    name: '价在 EMA20 上方 331',
    evidence: [ev('E1', 'last 108208.5, mark 108210.0'), ev('E2', 'EMA20 107877.5 EMA50 107500.0')],
    reason: '价在 EMA20 上方 331(由 E1.last-E2.EMA20 算出) [E2]',
    raw_reason: '价在 EMA20 上方 331 [E2]',
  },
  {
    name: 'ATR 138(把 138.74 说成 138)',
    evidence: [ev('E2', 'ATR14 138.74 (0.13%)')],
    reason: '15m ATR 约 138(由 E2.ATR14 算出),波动偏低 [E2]',
    raw_reason: '15m ATR 约 138,波动偏低 [E2]',
  },
  {
    name: '浮盈 2.00R(两段距离相除)',
    evidence: [ev('E1', 'last 108457.0, mark 108457.0'), ev('E2', '成交 107958.84;止损 107709.18')],
    reason: '浮盈已到 2.00(由 (E1.last-E2.成交)/(E2.成交-E2.止损) 算出) 倍 R [E2]',
    raw_reason: '浮盈已到 2.00 倍 R [E2]',
  },
  {
    name: '距止损 0.231%(差 / 价 × 100)',
    evidence: [ev('E1', 'last 108208.5, mark 108210.0'), ev('E2', '成交 107958.84;止损 107709.18')],
    reason: '离止损还有 0.231%(由 (E2.成交-E2.止损)/E2.成交*100 算出) [E2]',
    raw_reason: '离止损还有 0.231% [E2]',
  },
  {
    name: '止损宽 1.80 ATR(差 / ATR)',
    evidence: [ev('E2', '成交 107958.84;止损 107709.18;ATR14 138.70')],
    reason: '止损宽度 1.80(由 (E2.成交-E2.止损)/E2.ATR14 算出) ATR [E2]',
    raw_reason: '止损宽度 1.80 ATR [E2]',
  },
  {
    name: '权益/名义 1.25(两数相除)',
    evidence: [ev('E3', '权益 10000 USDT, 名义 8000 USDT')],
    reason: '权益是名义的 1.25(由 E3.权益/E3.名义 算出)倍,杠杆很轻 [E3]',
    raw_reason: '权益是名义的 1.25 倍,杠杆很轻 [E3]',
  },
];

describe('09-04 的 13 个幻觉样本回归', () => {
  it('12 个假阳性:旧口径全判、写成公式后新口径全放行', () => {
    for (const s of FALSE_POSITIVES) {
      const rawOnly = hallucinationReport(J(s.raw_reason), s.evidence, null, 0);
      expect(rawOnly.raw.length, `${s.name}: 旧口径应当判它是幻觉`).toBeGreaterThan(0);
      expect(rawOnly.strict.map((n) => n.text), `${s.name}: 没标注时新口径维持旧判`).toEqual(rawOnly.raw.map((n) => n.text));

      const annotated = hallucinationReport(J(s.reason), s.evidence, null, 0);
      expect(annotated.raw.length, `${s.name}: 标注不改变旧口径`).toBeGreaterThan(0);
      expect(annotated.strict, `${s.name}: 新口径应当放行`).toEqual([]);
      expect(annotated.derived_weak, `${s.name}: 公式标注不该落到 weak`).toEqual([]);
      expect(annotated.derived_ok.map((d) => d.op), `${s.name}: 公式复算`).toEqual(['formula']);
      expect(annotated.derived_ok.map((d) => d.mode), `${s.name}: 模式`).toEqual(['formula']);
    }
  });

  it('第 13 个是真幻觉:两个口径都判', () => {
    const evidence = [ev('E1', 'last 108208.5, mark 108210.0')];
    const j: Judgment = { ...J('价在 108208.5 附近 [E1]'), thesis: '目标看到 112345' };
    const r = hallucinationReport(j, evidence, null, 0);
    expect(r.raw.map((n) => n.text)).toEqual(['112345']);
    expect(r.strict.map((n) => n.text)).toEqual(['112345']);
  });

  it('假阳性总数 12、真幻觉 1(新口径 13 → 1)', () => {
    const evidence = [ev('E1', 'last 108208.5, mark 108210.0')];
    const real = hallucinationReport({ ...J('价在 108208.5 附近 [E1]'), thesis: '目标看到 112345' }, evidence, null, 0);
    const cleared = FALSE_POSITIVES.filter((s) => hallucinationReport(J(s.reason), s.evidence, null, 0).strict.length === 0).length;
    expect(cleared).toBe(12);
    expect(cleared + real.strict.length).toBe(13);
    expect(real.strict.length).toBe(1);
  });
});

// ---------------------------------------------------------------- P1-16 对抗用例

describe('P1-16 假标注不再被洗白', () => {
  // 复审原文用的那条证据:mark 100; entry 90; qty 2。池子穷举能拼出 180 / 20 / 10 / 1.11 ……
  const E1 = ev('E1', 'mark 100; entry 90; qty 2');
  const MEM = ev('E2', '现价 4321;当时止损 4200', 'memory');

  const report = (reason: string, evidence: Evidence[] = [E1]) => hallucinationReport(J(reason), evidence, null, 0);

  it('假语义:资金费率 180.0% 只给编号 → 判幻觉(池子能拼出 90×2 也不算)', () => {
    const r = report('资金费率 180.0%(由 E1 算出),持多要付钱 [E1]');
    expect(r.derived_ok).toEqual([]);
    expect(r.strict.map((n) => n.text)).toEqual(['180.0']);
    expect(r.derived_weak).toHaveLength(1);
    expect(r.derived_weak[0]!.mode).toBe('pool');
    expect(r.derived_weak[0]!.ok).toBe(false);
    expect(r.derived_weak[0]!.verified).toBe(true);
  });

  it('假语义:资金费率写成公式也算不出来 → 判幻觉', () => {
    const r = report('资金费率 180.0%(由 E1.mark*E1.qty 算出) [E1]');
    expect(r.derived_ok).toEqual([]);
    expect(r.derived_bad).toHaveLength(1);
    expect(r.strict.map((n) => n.text)).toEqual(['180.0']);
  });

  it('假语义:引用的字段根本不存在 → 判幻觉', () => {
    const r = report('资金费率 180.0%(由 E1.资金费率*100 算出) [E1]');
    expect(r.derived_ok).toEqual([]);
    expect(r.derived_bad[0]!.reason).toContain('找不到字段');
    expect(r.strict.map((n) => n.text)).toEqual(['180.0']);
  });

  it('符号翻转:公式算出 +20 却写成 -20.0 → 判幻觉', () => {
    const bad = report('浮亏 -20.0 USDT(由 (E1.mark-E1.entry)*E1.qty 算出) [E1]');
    expect(bad.derived_ok).toEqual([]);
    expect(bad.derived_bad).toHaveLength(1);
    expect(bad.strict.map((n) => n.text)).toEqual(['-20.0']);
    // 写对方向的那条要放行(证明判的是符号,不是这个数本身)
    const good = report('浮亏 -20.0 USDT(由 (E1.entry-E1.mark)*E1.qty 算出) [E1]');
    expect(good.derived_ok.map((d) => d.op)).toEqual(['formula']);
    expect(good.strict).toEqual([]);
  });

  it('memory 证据:公式引用与只给编号都判幻觉', () => {
    const f = report('现价 4321(由 E2.现价 算出) [E2]', [E1, MEM]);
    expect(f.derived_ok).toEqual([]);
    expect(f.derived_bad[0]!.reason).toContain('记忆证据');
    expect(f.strict.map((n) => n.text)).toEqual(['4321']);
    const p = report('现价 4321(由 E2 算出) [E2]', [E1, MEM]);
    expect(p.derived_ok).toEqual([]);
    expect(p.derived_weak).toEqual([]);
    expect(p.strict.map((n) => n.text)).toEqual(['4321']);
  });

  it('无关常数:公式里塞一个证据里没有的字面量 → 判幻觉', () => {
    const r = report('浮盈 30.0 USDT(由 (E1.mark-E1.entry)*3 算出) [E1]');
    expect(r.derived_ok).toEqual([]);
    expect(r.derived_bad[0]!.reason).toContain('常数');
    expect(r.strict.map((n) => n.text)).toEqual(['30.0']);
    // 100 是百分号换算,允许
    const pct = report('浮盈率 11.1%(由 (E1.mark-E1.entry)/E1.entry*100 算出) [E1]');
    expect(pct.derived_ok.map((d) => d.op)).toEqual(['formula']);
  });

  it('多 ref 洗白:堆一串无关证据把池子撑大也不再判 ok', () => {
    const noise = [E1, ev('E4', 'ATR14 7.5 EMA20 61.2'), ev('E5', '24h量 3.4 持仓量 55.5'), ev('E6', '资金费 0.01 下次 8')];
    const r = report('资金费率 180.0%(由 E1,E4,E5,E6 算出) [E1]', noise);
    expect(r.derived_ok).toEqual([]);
    expect(r.strict.map((n) => n.text)).toEqual(['180.0']);
  });

  it('正向:合法公式复算相等 → ok=true、mode=formula', () => {
    const r = report('浮盈 20.0 USDT(由 (E1.mark-E1.entry)*E1.qty 算出) [E1]');
    expect(r.strict).toEqual([]);
    expect(r.derived_ok).toHaveLength(1);
    expect(r.derived_ok[0]).toMatchObject({ ok: true, verified: true, mode: 'formula', op: 'formula' });
  });

  it('同名字段有两个不同值 → 歧义,不给放行', () => {
    const amb = ev('E1', '成交 100;成交 120;数量 2');
    const r = report('浮盈 40.0(由 (E1.成交-E1.数量)*E1.数量 算出) [E1]', [amb]);
    expect(r.derived_ok).toEqual([]);
    expect(r.derived_bad[0]!.reason).toContain('多个不同的值');
  });
});

describe('evidenceFields 解析', () => {
  it('「标签 数字」串按分段取字段', () => {
    const f = evidenceFields('last 108208.5, mark 108210.0');
    expect(f.get('last')).toBe(108208.5);
    expect(f.get('mark')).toBe(108210.0);
  });

  it('中文标签、带单位、带括号补充都能取到', () => {
    const f = evidenceFields('成交 107958.84;止损 107709.18;ATR14 138.74 (0.13%);权益 10000 USDT');
    expect(f.get('成交')).toBe(107958.84);
    expect(f.get('atr14')).toBe(138.74);
    expect(f.get('权益')).toBe(10000);
  });

  it('同名不同值 → null(歧义)', () => {
    expect(evidenceFields('成交 100;成交 120').get('成交')).toBeNull();
    expect(evidenceFields('成交 100;成交 100').get('成交')).toBe(100);
  });

  it('冒号/等号写法也认', () => {
    const f = evidenceFields('mark=100; entry:90');
    expect(f.get('mark')).toBe(100);
    expect(f.get('entry')).toBe(90);
  });
});

describe('标注本身要经得起查', () => {
  const evidence = [ev('E1', 'last 108208.5, mark 108210.0'), ev('E2', '成交 107958.84;止损 107709.18')];

  it('引用了没登记的证据 → 仍判幻觉', () => {
    const r = hallucinationReport(J('止损距离 249.66(由 E2.成交-E99.止损 算出) [E2]'), evidence, null, 0);
    expect(r.strict.map((n) => n.text)).toEqual(['249.66']);
    expect(r.derived_bad[0]!.unknown_refs).toEqual(['E99']);
  });

  it('标了公式但算不出来 → 仍判幻觉', () => {
    const r = hallucinationReport(J('止损距离 501.37(由 E2.成交-E2.止损 算出) [E2]'), evidence, null, 0);
    expect(r.strict.map((n) => n.text)).toEqual(['501.37']);
    expect(r.derived_ok).toEqual([]);
  });

  it('标注只认紧贴数字后面的那个括号,全角半角都吃,公式里的嵌套括号也吃', () => {
    expect(derivedAnnotations('浮盈 66.34 USDT(由 E1,E3 算出)').map((a) => a.refs)).toEqual([['E1', 'E3']]);
    expect(derivedAnnotations('浮盈 66.34(由 E1、E3 算出)').map((a) => a.value)).toEqual([66.34]);
    expect(derivedAnnotations('(由 E1 算出)前面没有数字')).toEqual([]);
    const f = derivedAnnotations('浮盈 66.34(由 (E1.mark-E3.entry)*E3.qty 算出)');
    expect(f.map((a) => a.mode)).toEqual(['formula']);
    expect(f[0]!.refs).toEqual(['E1', 'E3']);
    expect(f[0]!.formula).toBe('(E1.mark-E3.entry)*E3.qty');
  });

  it('checkDerived 单独可用:公式 ok、只给编号只能到 weak', () => {
    const a = derivedAnnotations('止损距离 249.66(由 E2.成交-E2.止损 算出)')[0]!;
    expect(checkDerived(a, evidence)).toMatchObject({ ok: true, verified: true, mode: 'formula', op: 'formula' });
    const b = derivedAnnotations('止损距离 249.66(由 E2 算出)')[0]!;
    expect(checkDerived(b, evidence)).toMatchObject({ ok: false, verified: true, mode: 'pool', op: 'diff' });
  });

  it('旧口径函数保持原样(历史对照用)', () => {
    expect(hallucinatedNumbers(J('止损距离 249.66(由 E2.成交-E2.止损 算出) [E2]'), evidence, null, 0).map((n) => n.text)).toEqual(['249.66']);
  });
});
