/**
 * 账户折算(2026-09-23 晚,交接六-4):把判断回放的逐事件净 R 换成真实账户盈亏。
 * 口径照搬 `packages/gateway/scripts/research-judgment/account-pnl.py`(那份脚本是这里的来源,两者数字应一致):
 *  - 每个行情段单独算(段与段不连续),都从 $10,000 起步,复利;
 *  - 事件按时间顺序处理(同一时刻按事件 id,先到先得):先把到期的持仓平掉(按平仓时间先后入账),再决定开不开新单;
 *    现货满仓经常触发,同一时刻的先后会让结果差几个百分点(旧脚本按 set 顺序,随 PYTHONHASHSEED 变,已改成按 id);
 *  - 每笔风险 = 当前已实现权益 × 1%;名义 = 风险 / 止损距离(|参考收盘 − 止损| / 参考收盘);
 *  - 单笔名义不超过当前权益(现货不加杠杆;名义被压小时,盈亏按比例缩小);
 *  - 总名义上限:现货 = 权益,永续 = 3 × 权益;超了这一单跳过(满仓跳过,不排队);
 *  - 这一笔的盈亏 = 净 R × 风险金额 × (实际名义 / 按风险算的名义),开仓时定下、平仓时入账;
 *    平仓时间 = 信号时间 + 持仓根数 × 1h;
 *  - 结算状态为空、no_fill、skipped 的事件不开仓;
 *  - 最大回撤只在平仓入账时按已实现权益记(不盯市),所以偏乐观;
 *  - 持有对照:同段内每个币「段内最后一根收盘 / 第一根开盘 − 1」,等权平均(不扣成本)。
 * 只是报告层的派生量,不改事件、不改结算、不改任何冻结的东西。
 */
import { H1, type JrEvent, type Management, type PeriodDef, type Venue } from './types.js';
import type { Bar } from './types.js';

export const ACCOUNT_START = 10_000;
export const ACCOUNT_RISK = 0.01;
export const PERP_GROSS_CAP = 3;

export const ACCOUNT_RULES = [
  `每个行情段单独从 $${ACCOUNT_START.toLocaleString('en-US')} 起步、复利;按信号时间顺序(同一时刻按事件 id 先到先得),先平掉已到期的持仓再开新单。`,
  `每笔风险 = 当前已实现权益 × ${ACCOUNT_RISK * 100}%,名义 = 风险 ÷ 止损距离(|参考收盘 − 止损| ÷ 参考收盘);单笔名义不超过当前权益(名义被压小时盈亏按比例缩小)。`,
  `总名义上限:现货 = 权益,永续 = ${PERP_GROSS_CAP} × 权益;超了这一单跳过(满仓跳过,不排队)。现货满仓常触发,同一时刻信号的先后能让段收益差几个百分点,表里「满仓跳过」笔数就是这部分。`,
  '每笔盈亏 = 净 R × 风险金额 × 实际名义 / 按风险算的名义,开仓时定下、平仓(信号时间 + 持仓根数 × 1h)时入账。',
  '最大回撤只在平仓入账时按已实现权益记,不盯市,偏乐观;持有对照 = 段内每个币末根收盘 ÷ 首根开盘 − 1 的等权平均,不扣成本。',
  '口径来源 scripts/research-judgment/account-pnl.py;判断回放没有经过生产的 portfolio/风控定仓、并发上限与票池,这是「如果每笔都按 1% 风险下」的折算,不是实盘账户。',
];

export interface AccountPeriod {
  period: string;
  /** 期末权益 / 起始 − 1 */
  return: number;
  end_equity: number;
  /** 实际开仓笔数(满仓跳过的不算) */
  trades: number;
  /** 因总名义上限跳过的笔数 */
  skipped_full: number;
  max_drawdown: number;
}

export interface AccountRow {
  arm: string;
  management: Management;
  periods: AccountPeriod[];
}

interface OpenPos { exit: number; pnl: number; notional: number }

/** 单个行情段的账户折算(纯函数)。events 应已属于该段;顺序按 (as_of, id) 重排,保证确定性。 */
export function accountPeriod(events: JrEvent[], follow: (e: JrEvent) => boolean, m: Management, venue: Venue, period: string, opts: { start?: number; risk?: number } = {}): AccountPeriod {
  const start = opts.start ?? ACCOUNT_START, risk = opts.risk ?? ACCOUNT_RISK;
  let eq = start, peak = eq, mdd = 0, n = 0, skipped = 0;
  const open: OpenPos[] = [];
  const settle = (upTo: number): void => {
    const due = open.filter((c) => c.exit <= upTo).sort((a, b) => a.exit - b.exit);
    for (const c of due) {
      eq += c.pnl;
      open.splice(open.indexOf(c), 1);
      peak = Math.max(peak, eq);
      mdd = Math.max(mdd, 1 - eq / peak);
    }
  };
  const timeline = events
    .filter((e) => follow(e))
    .filter((e) => { const s = e[m]; return !(s.status === null || s.status === undefined || s.status === 'no_fill' || s.status === 'skipped') && s.net_r !== null && s.bars_held !== null; })
    .sort((a, b) => a.as_of - b.as_of || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // 码点序,与 Python sorted 一致(不用 localeCompare)
  for (const e of timeline) {
    const s = e[m];
    settle(e.as_of);
    const stopPct = Math.abs(e.ref_close - e.stop) / e.ref_close;
    const riskUsd = eq * risk, byRisk = riskUsd / stopPct;
    const cap = venue === 'perp' ? eq * PERP_GROSS_CAP : eq;
    const used = open.reduce((a, c) => a + c.notional, 0);
    const notional = Math.min(byRisk, eq);
    if (used + notional > cap) { skipped++; continue; }
    open.push({ exit: e.as_of + s.bars_held! * H1, pnl: s.net_r! * riskUsd * (notional / byRisk), notional });
    n++;
  }
  settle(Infinity);
  return { period, return: eq / start - 1, end_equity: eq, trades: n, skipped_full: skipped, max_drawdown: mdd };
}

/** 一个臂在所有行情段上的账户折算。 */
export function accountRow(arm: string, events: JrEvent[], follow: (e: JrEvent) => boolean, m: Management, venue: Venue, periods: PeriodDef[] | { id: string }[]): AccountRow {
  return { arm, management: m, periods: periods.map((p) => accountPeriod(events.filter((e) => e.period === p.id), follow, m, venue, p.id)) };
}

/** 持有对照:段内每个币末根收盘 / 首根开盘 − 1(bar.close_time 落在 [from, to] 内),等权平均;没有数据的币不计入。 */
export function holdReturn(series: { symbol: string; bars: Bar[] }[], p: { from: number; to: number }): { return: number | null; symbols: number } {
  const rets: number[] = [];
  for (const s of series) {
    const bars = s.bars.filter((b) => p.from <= b.close_time && b.close_time <= p.to);
    if (bars.length) rets.push(Number(bars.at(-1)!.close) / Number(bars[0]!.open) - 1);
  }
  return { return: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null, symbols: rets.length };
}
