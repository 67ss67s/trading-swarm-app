/**
 * 研究问题原话里的周期 / 窗口 / 交易频率说法(2026-09-23 晚,纯函数,规划器与模式判定共用)。
 *
 * 起因:「创建一个BTC的MA 60主导的多空策略…在日线级别trigger 在15分钟级别进出场，可以高频率交易，回测周期只要2026年」
 * 被判成形态频率统计(「高频率交易」命中「频率」)、周期锁死日线、窗口被拉到全历史。
 */

const DAY = 86400000;
const TF_MS: Record<string, number> = { m: 60000, h: 3600000, d: DAY };
function tfMs(tf: string): number {
  const m = /^(\d+)(m|h|d)$/.exec(tf);
  return m ? Number(m[1]) * TF_MS[m[2]!]! : NaN;
}

// ── 周期 ─────────────────────────────────────────────────────────────────

/** 单周期叫法 → 代号(与旧 inferTimeframe 的优先级一致:英文代号 > 日线 > 4 小时 > 1 小时 > 30/15/5 分钟)。 */
function singleTimeframe(question: string): string | null {
  const code = /\b(1m|5m|15m|30m|1h|4h|1d)\b/i.exec(question)?.[1];
  if (code) return code.toLowerCase();
  if (/日线|日K|日k|daily|每日/.test(question)) return "1d";
  if (/4\s*小时|四小时|4H/.test(question)) return "4h";
  if (/小时线|1\s*小时|一小时|hourly/.test(question)) return "1h";
  if (/30\s*分钟|半小时/.test(question)) return "30m";
  if (/15\s*分钟/.test(question)) return "15m";
  if (/5\s*分钟/.test(question)) return "5m";
  return null;
}

/** 从左到右扫出所有周期提及(同一位置取最长叫法,「15分钟」不会再被当成「5分钟」)。 */
const TF_SCAN =
  /\b(1m|5m|15m|30m|1h|4h|1d)\b|(日线|日K|日k|日级别|daily)|(4\s*小时|四小时)|(小时线|1\s*小时|一小时|hourly)|(30\s*分钟|半小时)|(15\s*分钟)|(5\s*分钟)/gi;
export interface TimeframeMention {
  tf: string;
  index: number;
  end: number;
}
export function timeframeMentions(question: string): TimeframeMention[] {
  const out: TimeframeMention[] = [];
  for (const m of question.matchAll(TF_SCAN)) {
    const tf = m[1] ? m[1].toLowerCase() : m[2] ? "1d" : m[3] ? "4h" : m[4] ? "1h" : m[5] ? "30m" : m[6] ? "15m" : "5m";
    out.push({ tf, index: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/** 周期后面(或前面)紧跟的执行说法:「15分钟级别进出场」「在 15m 上执行」「进出场用 15 分钟」。 */
const EXEC_AFTER = /^\s*(?:级别|周期|K\s*线|k\s*线|线|图)?\s*(?:上|里|内|中)?\s*(?:的)?\s*(?:进出场|进场|入场|出场|离场|执行|开平仓|开仓|平仓|下单|做单)/i;
const EXEC_BEFORE = /(?:进出场|进场|入场|出场|离场|执行|开平仓|下单|做单)\s*(?:用|在|看|放在|于)?\s*$/;
/** 周期后面紧跟的方向 / 触发说法:「日线级别 trigger」「日线定方向」「日线趋势过滤」。 */
const DIRECTION_AFTER = /^\s*(?:级别|周期|K\s*线|k\s*线|线|图)?\s*(?:上|里|内)?\s*(?:的)?\s*(?:trigger|触发|定方向|方向|趋势|过滤|大方向|主导|做方向|判方向)/i;
const DIRECTION_BEFORE = /(?:trigger|触发|定方向|方向|趋势|过滤|大方向)\s*(?:用|在|看|于)?\s*$/i;

export interface MultiTimeframe {
  /** 执行周期(回测的 base 周期):进出场所在的较小周期 */
  base: string;
  /** 方向/触发周期:用 htf_ma_state / trend_state 的 htf 表达;没有明确说法时取提到的最大周期 */
  direction: string | null;
  /** 其余提到的周期(如「参考 4 小时级别的 MACD」):MACD 背离用 htf 参数精确表达,其余指标在执行周期上近似 */
  others: string[];
}

/**
 * 「X 级别 trigger / Y 级别进出场」这种多周期说法:至少两个不同周期,且其中一个带执行说法。
 * 执行周期必须是提到的周期里较小的那个(大周期执行 + 小周期定方向不是这类说法),否则返回 null 按单周期处理。
 */
export function multiTimeframe(question: string): MultiTimeframe | null {
  const mentions = timeframeMentions(question);
  const distinct = [...new Set(mentions.map((m) => m.tf))].filter((tf) => Number.isFinite(tfMs(tf)));
  if (distinct.length < 2) return null;
  const exec = mentions.find(
    (m) => EXEC_AFTER.test(question.slice(m.end, m.end + 16)) || EXEC_BEFORE.test(question.slice(Math.max(0, m.index - 8), m.index)),
  );
  if (!exec) return null;
  const base = exec.tf, baseMs = tfMs(base);
  const larger = distinct.filter((tf) => tfMs(tf) > baseMs);
  if (!larger.length) return null;
  const said = mentions.find(
    (m) =>
      m.tf !== base &&
      tfMs(m.tf) > baseMs &&
      (DIRECTION_AFTER.test(question.slice(m.end, m.end + 16)) || DIRECTION_BEFORE.test(question.slice(Math.max(0, m.index - 8), m.index))),
  );
  const direction = said?.tf ?? larger.sort((a, b) => tfMs(b) - tfMs(a))[0]!;
  return { base, direction, others: distinct.filter((tf) => tf !== base && tf !== direction) };
}

/** 用户明说的周期:多周期说法取执行周期,否则按单周期叫法;没说返回 null。 */
export function inferTimeframe(question: string): string | null {
  return multiTimeframe(question)?.base ?? singleTimeframe(question);
}

/** 研究回测每根决策最多看这么多根已收盘 K 线(checkIR 的 warmup 上限、engine viewBars 上限,都是 5000)。
 * 高周期均线 htf_ma_state 与带 htf 的 MACD 背离从整段已收盘 K 线计算,不受这个上限约束;只有 trend_state 仍受。 */
export const VIEW_BARS_CAP = 5000;

/** 原话里的均线周期:「MA 60」「SMA200」「EMA 21」「60 日均线」「均线60」。MA/均线按简单均线(sma)。 */
export function maMention(question: string): { ma: "sma" | "ema"; period: number; phrase: string } | null {
  const m = /\b(EMA|SMA|MA)\s*(\d{1,4})(?!\d)/i.exec(question) ?? /(均线|移动平均线?)\s*(\d{1,4})(?!\d)/.exec(question);
  if (m) { const period = Number(m[2]); return period >= 2 && period <= 1000 ? { ma: /^ema$/i.test(m[1]!) ? "ema" : "sma", period, phrase: m[0] } : null; }
  const d = /(\d{1,4})\s*(?:日|天|周期)?\s*(EMA|均线|移动平均线?)/i.exec(question);
  if (!d) return null;
  const period = Number(d[1]);
  return period >= 2 && period <= 1000 ? { ma: /ema/i.test(d[2]!) ? "ema" : "sma", period, phrase: d[0] } : null;
}

/**
 * 多周期说法的编译提示(拼在 compile_strategy 的 text 后面)。只写周期映射与原语用法,
 * 刻意不出现「限价 / 倍 / 止盈 / 做空 / 多空」这类会被订单原话规则识别的词,原话规则只认用户自己说的。
 * 2026-09-23 夜:方向门用 htf_ma_state(高周期均线上下,反向一侧 side=below),高周期 MACD 背离用 macd_divergence{htf}(顶背离反向触发 direction=bearish),
 * 都按高周期原生参数写、不再「参数 × 周期比」近似;只有没有高周期参数的其他指标原语仍按倍数近似。
 */
export function multiTimeframeHint(question: string, mt: MultiTimeframe | null = multiTimeframe(question)): string | null {
  if (!mt) return null;
  const baseMs = tfMs(mt.base);
  const reverse = DIRECTION_BOTH.test(question) || /做空|开空|空单/.test(question);
  const lines = [`多周期约定(代码按原话解析):回测执行周期 = ${mt.base},进出场与离场都在 ${mt.base} K 线上判定,不要把更大的周期当执行周期。`];
  if (mt.direction) {
    const dir = mt.direction, ratio = Math.round(tfMs(dir) / baseMs), maxSlow = Math.floor(VIEW_BARS_CAP / ratio) - 1, ma = maMention(question);
    const node = (period: number | string, kind: string, side: string) => `htf_ma_state{htf:"${dir}",period:${period},ma:"${kind}",side:"${side}"}`;
    lines.push(
      (ma
        ? `${dir} 级别只作方向/触发门:原话「${ma.phrase}」→ regime=${node(ma.period, ma.ma, "above")}(最近一根已收盘的 ${dir} K 线收盘在其均线之上才开多)` +
          (reverse ? `,反向一侧 order.short_regime=${node(ma.period, ma.ma, "below")}` : "") + "。"
        : `${dir} 级别只作方向/触发门:原话是「价格在 MA/EMA N 之上/之下」时用 regime=${node("N", "sma|ema", "above")}` +
          (reverse ? `,反向一侧 order.short_regime 同参数 side:"below"` : "") +
          `;原话只说趋势向上、没给均线时用 trend_state{htf:"${dir}"}(高周期 EMA 斜率定方向,另要求 ${mt.base} 上 ADX≥adx_min 且快慢 EMA 同向;只在向上时通过,ema_slow 受预热上限约束最多 ${maxSlow})。`) +
        `高周期均线从整段已收盘 K 线计算,不受 ${VIEW_BARS_CAP} 根视图上限约束:period 照原话写(按 ${dir} 根数),不要缩小,也不要换算成 ${mt.base} 根数。`,
    );
  }
  const divergence = /背离|divergence/i.test(question);
  for (const tf of mt.others) {
    const ratio = Math.round(tfMs(tf) / baseMs);
    if (ratio <= 1) continue;
    if (divergence)
      lines.push(
        `${tf} 级别的 MACD 背离:用 macd_divergence / macd_divergence_exit 加 htf:"${tf}"(在 ${tf} K 线上判背离,确认那根 ${tf} K 线收盘时触发),fast/slow/signal/swing_length/lookback 按 ${tf} 根数写(常用 12/26/9、swing_length 3、lookback 60),不要换算;` +
          `底背离开多触发 = signal:[macd_divergence{htf:"${tf}"}]` +
          (reverse ? `,顶背离反向触发 = order.short_signal:[macd_divergence{htf:"${tf}",direction:"bearish"}]` : `,顶背离离场 = exit:[macd_divergence_exit{htf:"${tf}"}]`) + "。",
      );
    lines.push(`${tf} 级别的其他指标条件:均线位置用 htf_ma_state{htf:"${tf}"} 精确表达;其余指标原语没有高周期参数,在 ${mt.base} 上把周期类参数乘以 ${ratio} 近似,并写进 unmapped 说明是近似。`);
  }
  if (reverse)
    lines.push('反向一侧:short_signal 用 signal 类原语(顶背离 = macd_divergence{direction:"bearish"},可带 htf);short_regime 用 htf_ma_state{side:"below"}(trend_state 只在向上时通过,不能当反向方向门)。');
  return lines.join("\n");
}

// ── 多空 ─────────────────────────────────────────────────────────────────

/** 原话要多空双向(「多空力量」是艾达透视指标的别名,不算)。 */
export const DIRECTION_BOTH = /多空(?!力量)|双向|\blong[\s/&_-]*(?:and\s*)?short\b/i;

// ── 交易频率 vs 信号出现频率 ─────────────────────────────────────────────

/** 「可以高频率交易」「交易频率高」「频繁交易」说的是交易节奏,不是「信号多久出现一次」。 */
export const TRADE_FREQUENCY =
  /(?:可以|能|要|想|允许|支持)?\s*(?:高|低|中)频(?:率)?\s*(?:地|的)?\s*(?:交易|操作|进出场?|买卖|开仓|下单|做单)?|(?:交易|操作|开仓|下单|做单|进出场)\s*(?:的)?\s*(?:频率|频次)|频繁(?:地)?\s*(?:交易|操作|进出|开仓)|high[\s-]*frequency(?:\s*trading)?|\bHFT\b/gi;
export function stripTradeFrequency(question: string): string {
  return question.replace(TRADE_FREQUENCY, " ");
}
/** 明确要造策略 / 回测:「创建/做一个/写一个…策略」「回测」「backtest」。 */
export const STRATEGY_BUILD =
  /(?:创建|新建|建立|建一个|做一个|做个|写一个|写个|编写|设计|搭建|构建|生成|帮我做|帮我写)[^,，。;；?？!！]{0,40}?策略|回测|backtest/i;
/** 交易动作:进出场/止损止盈/开平仓。 */
export const TRADE_ACTION = /进出场|进场|出场|入场|离场|止损|止盈|开仓|平仓/;
/** 真正在问信号出现频率的强说法。 */
export const SIGNAL_FREQUENCY_STRONG =
  /多久(?:出现|一次|才)|出现(?:过)?(?:多少|几)次|出现次数|出现(?:的)?频率|频率(?:多高|多少|如何|怎么样|是多少)|how often/i;

// ── 窗口 ─────────────────────────────────────────────────────────────────

export interface WindowPhrase {
  from_ms: number;
  to_ms: number;
  /** 原话片段 */
  phrase: string;
}

const CN: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  const m = /^([一二两三四五六七八九])?(十)?([一二三四五六七八九])?$/.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[2]) return CN[m[1]!]!;
  return (m[1] ? CN[m[1]]! : 1) * 10 + (m[3] ? CN[m[3]]! : 0);
}
const monthStart = (y: number, m: number) => Date.UTC(y, m - 1, 1);
const NOW_WORD = "(?:现在|今天|目前|当前|今|now)";
const SEP = "(?:到|至|~|～|—|–|-)";
/**
 * 用户显式指定的回测/研究区间(UTC)。只认年份、年月与「最近 N 个月/年/周」;「N 天」仍由旧规则处理。
 * 截止时间不超过 now;区间整个在未来、或写法不合法返回 null。
 */
export function parseWindowPhrase(question: string, now: number): WindowPhrase | null {
  const q = question.replace(/\s+/g, " ");
  const thisYear = new Date(now).getUTCFullYear();
  const okYear = (y: number) => y >= 2009 && y <= thisYear;
  const okMonth = (m: number) => m >= 1 && m <= 12;
  const done = (from_ms: number, end_ms: number, phrase: string): WindowPhrase | null => {
    const to_ms = Math.min(end_ms, now);
    return from_ms < to_ms ? { from_ms, to_ms, phrase: phrase.trim() } : null;
  };
  const YM = "(20\\d{2})\\s*(?:年|[-/.])\\s*(\\d{1,2})\\s*月?";
  // 年月 ~ 年月
  let m = new RegExp(`${YM}\\s*${SEP}\\s*${YM}(?![\\d/.-])`).exec(q);
  if (m) {
    const [y1, m1, y2, m2] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
    if (okYear(y1) && okYear(y2) && okMonth(m1) && okMonth(m2)) return done(monthStart(y1, m1), monthStart(y2, m2 + 1) - 1, m[0]);
  }
  // 年月以来 / 从年月到现在
  m = new RegExp(`${YM}\\s*(?:以来|至今|开始|起|(?:${SEP})\\s*${NOW_WORD})`).exec(q);
  if (m) {
    const [y, mo] = [Number(m[1]), Number(m[2])];
    if (okYear(y) && okMonth(mo)) return done(monthStart(y, mo), now, m[0]);
  }
  // 年份以来 / 从年份到现在
  m = new RegExp(`(20\\d{2})\\s*年?\\s*(?:以来|至今|开始|起|(?:${SEP})\\s*${NOW_WORD})`).exec(q);
  if (m && okYear(Number(m[1]))) return done(Date.UTC(Number(m[1]), 0, 1), now, m[0]);
  // 年份 ~ 年份
  m = new RegExp(`(?<!\\d)(20\\d{2})\\s*年?\\s*${SEP}\\s*(20\\d{2})\\s*年?(?![\\d/.-]|\\s*月)`).exec(q);
  if (m) {
    const [y1, y2] = [Number(m[1]), Number(m[2])];
    if (okYear(y1) && y2 >= y1 && y2 <= thisYear) return done(Date.UTC(y1, 0, 1), Date.UTC(y2 + 1, 0, 1) - 1, m[0]);
  }
  // 单月:2026年3月 / 2026-03
  m = new RegExp(`(?<!\\d)${YM}(?![\\d/.-])`).exec(q);
  if (m && (/年/.test(m[0]) || /-|\//.test(m[0]))) {
    const [y, mo] = [Number(m[1]), Number(m[2])];
    if (okYear(y) && okMonth(mo)) return done(monthStart(y, mo), monthStart(y, mo + 1) - 1, m[0]);
  }
  // 单年:2026年 / 只要2026 / 回测周期 2025
  m = /(?<!\d)(20\d{2})\s*年(?!\s*\d)|(?:只要|只看|只回测|只测|仅|限于?|回测周期(?:是|为|只要)?|回测区间(?:是|为)?)\s*(20\d{2})(?!\d)/.exec(q);
  if (m) {
    const y = Number(m[1] ?? m[2]);
    if (okYear(y)) return done(Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1) - 1, m[0]);
  }
  // 最近 N 个月 / 半年 / N 年 / N 周
  m = /(?:最近|近|过去)\s*(\d{1,3}|[一二两三四五六七八九十]{1,3}|半)\s*(?:个)?\s*(月|年|周|星期)(?!线|期|度)/.exec(q);
  if (m) {
    const unit = m[2]!;
    const n = m[1] === "半" ? (unit === "年" ? 0.5 : null) : cnNumber(m[1]!);
    if (n && n > 0) {
      const d = new Date(now);
      if (unit === "周" || unit === "星期") return done(now - n * 7 * DAY, now, m[0]);
      const months = unit === "年" ? Math.round(n * 12) : n;
      if (months > 0 && months <= 240) {
        d.setUTCMonth(d.getUTCMonth() - months);
        return done(d.getTime(), now, m[0]);
      }
    }
  }
  return null;
}
