/**
 * 事件区的日历源(设计:docs/design/strategy-loop-v2-and-events-2026-09-12.md §5)。
 *
 * 两类:
 * 1. **静态宏观日历**(FOMC / CPI / NFP)——官方发布时间是公开的固定事实,做成静态表,零网络、零模型。
 * 2. **可配置订阅源**(代币解锁 / 上币公告)——**默认空**。不硬编任何第三方地址:接哪家由用户在
 *    `TG_DEMO_EVENT_FEEDS` 里给 JSON 数组,没有配置就一条都不抓。
 *
 * ## 静态表的来源与核对
 * - FOMC 会议日程:美联储官网 https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
 *   (`expected_at` = 会议第二天的利率决议发布时刻,14:00 美东)。
 * - CPI 发布日程:美国劳工统计局 https://www.bls.gov/schedule/news_release/cpi.htm(08:30 美东)。
 * - NFP(就业报告)发布日程:https://www.bls.gov/schedule/news_release/empsit.htm(08:30 美东)。
 * - **最后核对日期:2026-09-12 06:41 UTC**（逐条双官方页面结果及采集摘要见 内部评审记录）。表里只留 2026 年该日之后剩下的场次。美东夏令时 2026-11-01 结束,
 *   所以 11 月起同样的美东时刻对应的 UTC 晚一小时——下面每条都直接写死 UTC,不做 DST 计算。
 * - 官方偶尔改期(尤其是 BLS 遇到政府关门)。这张表是**兜底**,不是真理:上线前/跨年前必须照上面三个
 *   链接复核一遍,过期了就换成订阅源。`CALENDAR_LAST_VERIFIED_AT` 会跟事件一起出到接口上,前端可以提示。
 */

import type { EventConfidence, EventKind } from './events.js';

/** 静态表最后一次照官网核对的时刻(unix 毫秒,UTC)。 */
export const CALENDAR_LAST_VERIFIED_AT = Date.parse('2026-09-12T06:41:16.516Z');

export interface CalendarEntry {
  metric?: string;
  subkind: 'fomc' | 'cpi' | 'nfp' | 'ppi' | 'pce' | 'gdp' | 'claims' | 'retail';
  /** 事件发生时刻(UTC,unix 毫秒)。 */
  expected_at: number;
  /** 给人看的标题。 */
  title: string;
  /** 官方来源页面。 */
  source_ref: string;
}

const FOMC_SRC = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
const CPI_SRC = 'https://www.bls.gov/schedule/news_release/cpi.htm';
const NFP_SRC = 'https://www.bls.gov/schedule/news_release/empsit.htm';

/** 2026 年 09-12 之后剩下的场次。上面注释里写了来源与核对日期。 */
export const CALENDAR_2026: CalendarEntry[] = [
  // FOMC 利率决议:会议次日 14:00 美东(9/10 月 EDT = UTC−4,12 月 EST = UTC−5)。
  { subkind: 'fomc', expected_at: Date.parse('2026-09-16T18:00:00Z'), title: 'FOMC 利率决议(9 月)', source_ref: FOMC_SRC },
  { subkind: 'fomc', expected_at: Date.parse('2026-10-28T18:00:00Z'), title: 'FOMC 利率决议(10 月)', source_ref: FOMC_SRC },
  { subkind: 'fomc', expected_at: Date.parse('2026-12-09T19:00:00Z'), title: 'FOMC 利率决议(12 月)', source_ref: FOMC_SRC },
  // CPI:08:30 美东。
  { subkind: 'cpi', expected_at: Date.parse('2026-10-14T12:30:00Z'), title: '美国 CPI(9 月数据)', source_ref: CPI_SRC },
  { subkind: 'cpi', expected_at: Date.parse('2026-11-10T13:30:00Z'), title: '美国 CPI(10 月数据)', source_ref: CPI_SRC },
  { subkind: 'cpi', expected_at: Date.parse('2026-12-10T13:30:00Z'), title: '美国 CPI(11 月数据)', source_ref: CPI_SRC },
  // NFP(非农就业):08:30 美东。
  { subkind: 'nfp', expected_at: Date.parse('2026-10-02T12:30:00Z'), title: '美国非农就业(9 月数据)', source_ref: NFP_SRC },
  { subkind: 'nfp', expected_at: Date.parse('2026-11-06T13:30:00Z'), title: '美国非农就业(10 月数据)', source_ref: NFP_SRC },
  { subkind: 'nfp', expected_at: Date.parse('2026-12-04T13:30:00Z'), title: '美国非农就业(11 月数据)', source_ref: NFP_SRC },
];

/** `now` 之后 `horizonMs` 内的场次(默认 30 天),按时间升序。 */
export function calendarEntriesWithin(now: number, horizonMs = 30 * 86_400_000, table: CalendarEntry[] = CALENDAR_2026): CalendarEntry[] {
  return table.filter((e) => e.expected_at >= now && e.expected_at <= now + horizonMs).sort((a, b) => a.expected_at - b.expected_at);
}

// ---------------------------------------------------------------- 可配置订阅源(默认空)

export interface EventFeedSource {
  /** 稳定标识,也是事件的 `source`。 */
  name: string;
  /** 抓回来的条目算哪一类事件。 */
  kind: Extract<EventKind, 'exchange' | 'onchain' | 'news'>;
  url: string;
  format: 'rss' | 'json';
  /** 只收多少小时内的条目(默认 24)。 */
  max_age_hours?: number;
  /** 整源钉死一个 subkind(例如某个解锁日历源全是 unlock);不给就走关键词分类器。 */
  subkind?: string;
  /** 整源钉死可信度;不给按 kind 取默认(exchange=confirmed,其余 reported)。 */
  confidence?: EventConfidence;
}

/**
 * 解锁/上币的订阅源。**默认空数组**——设计上刻意不硬编第三方(哪家的数据、什么授权、会不会变,都不是我们能担保的)。
 * 用 `TG_DEMO_EVENT_FEEDS` 给 JSON 数组开启,例如:
 * `[{"name":"binance_announcements","kind":"exchange","url":"https://…/rss","format":"rss","subkind":"listing"}]`
 * 解析不了就当没配(不抛,不让一行坏 env 挡住启动)。
 */
export function loadEventFeedSources(raw = process.env['TG_DEMO_EVENT_FEEDS']): EventFeedSource[] {
  if (!raw || !raw.trim()) return [];
  try {
    const arr = JSON.parse(raw) as Partial<EventFeedSource>[];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s) => typeof s?.name === 'string' && typeof s?.url === 'string' && /^https?:\/\//.test(s.url))
      .map((s) => ({
        name: s.name!,
        kind: s.kind === 'onchain' || s.kind === 'news' ? s.kind : 'exchange',
        url: s.url!,
        format: s.format === 'json' ? 'json' : 'rss',
        ...(typeof s.max_age_hours === 'number' && s.max_age_hours > 0 ? { max_age_hours: s.max_age_hours } : {}),
        ...(typeof s.subkind === 'string' && s.subkind ? { subkind: s.subkind } : {}),
        ...(s.confidence === 'confirmed' || s.confidence === 'reported' || s.confidence === 'rumor' ? { confidence: s.confidence } : {}),
      }));
  } catch {
    return [];
  }
}
