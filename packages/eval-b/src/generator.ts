import { demo } from '@trading-swarm/gateway';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { mirrorCase } from './mirror.js';
import type { EvalCase } from './types.js';
import { errorMessage, mulberry32, parseUtcDate, sha256, shuffled, stableJson } from './util.js';

type RawKline = [number, string, string, string, string, string, number, ...unknown[]];
export type HistoricalData = Record<string, Record<string, demo.Kline[]>>;

export interface GenerateOptions {
  symbols: string[];
  timeframe: string;
  from: number;
  to: number;
  count: number;
  seed: number;
  set: string;
}

const HISTORY_COUNTS: Readonly<Record<string, number>> = { '15m': 60, '1h': 120, '4h': 80 };
const FUTURE_BARS = 48;

function rawToKline(raw: RawKline): demo.Kline {
  return {
    open_time: Number(raw[0]),
    open: String(raw[1]),
    high: String(raw[2]),
    low: String(raw[3]),
    close: String(raw[4]),
    volume: String(raw[5]),
    close_time: Number(raw[6]),
  };
}

function normalizeRaw(value: unknown): RawKline[] {
  if (!Array.isArray(value)) throw new Error('Binance klines response is not an array');
  return value.map((row, index) => {
    if (!Array.isArray(row) || row.length < 7) throw new Error(`invalid raw kline at index ${index}`);
    return row as RawKline;
  });
}

async function fetchRawPull(symbol: string, timeframe: string, endTime: number, cacheDir: string): Promise<RawKline[]> {
  const base = process.env['TG_EVAL_BINANCE_BASE'] ?? 'https://fapi.binance.com';
  const query = `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(timeframe)}&endTime=${endTime}&limit=1500`;
  const key = sha256(`${base}${query}`).slice(0, 20);
  const cacheFile = path.join(cacheDir, `${symbol}-${timeframe}-${endTime}-${key}.json`);
  try {
    return normalizeRaw(JSON.parse(await readFile(cacheFile, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${base}${query}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`${query} -> HTTP ${response.status}`);
    const raw = normalizeRaw(await response.json());
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFile, stableJson(raw), 'utf8');
    return raw;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRange(symbol: string, timeframe: string, start: number, end: number, cacheDir: string): Promise<demo.Kline[]> {
  const rows = new Map<number, demo.Kline>();
  let cursor = end;
  for (let page = 0; page < 100 && cursor >= start; page++) {
    const raw = await fetchRawPull(symbol, timeframe, cursor, cacheDir);
    if (raw.length === 0) break;
    for (const row of raw) {
      const kline = rawToKline(row);
      // Binance includes the candle containing endTime. It is not closed as of endTime.
      if (kline.close_time <= end && kline.close_time >= start) rows.set(kline.open_time, kline);
    }
    const earliest = Number(raw[0]?.[0]);
    if (!Number.isFinite(earliest) || earliest <= start) break;
    cursor = earliest - 1;
  }
  return [...rows.values()].sort((a, b) => a.open_time - b.open_time);
}

export async function loadHistoricalData(options: GenerateOptions, cacheDir: string): Promise<HistoricalData> {
  const frames = [...new Set([options.timeframe, '1h', '4h'])];
  const maxLookback = Math.max(...frames.map((tf) => (HISTORY_COUNTS[tf] ?? 120) * demo.tfToMs(tf)));
  const end = options.to + (FUTURE_BARS + 4) * demo.tfToMs(options.timeframe);
  const data: HistoricalData = {};
  for (const symbol of options.symbols) {
    data[symbol] = {};
    for (const timeframe of frames) {
      data[symbol]![timeframe] = await fetchRange(symbol, timeframe, options.from - maxLookback - demo.tfToMs(timeframe), end, cacheDir);
    }
  }
  return data;
}

function fixedPrice(value: number, reference: string): string {
  const places = reference.includes('.') ? reference.length - reference.indexOf('.') - 1 : 0;
  return value.toFixed(Math.max(places, 1));
}

function requiredCount(tf: string): number {
  return HISTORY_COUNTS[tf] ?? 120;
}

function historyAt(klines: demo.Kline[], asOf: number, count: number): demo.Kline[] {
  // This is the final containment boundary: no bar with close_time > as_of enters visible.
  return klines.filter((kline) => kline.close_time <= asOf).slice(-count);
}

function futureAt(klines: demo.Kline[], asOf: number, count: number): demo.Kline[] {
  return klines.filter((kline) => kline.close_time > asOf).slice(0, count);
}

function accountAt(symbol: string, asOf: number): demo.AccountView {
  return {
    backend: 'paper',
    equity: '10000',
    available: '10000',
    unrealized_pnl: '0',
    positions: [],
    open_orders: [],
    as_of: asOf,
  };
}

function makeVisible(symbol: string, timeframe: string, asOf: number, data: HistoricalData): EvalCase['visible'] {
  const byFrame = data[symbol];
  if (!byFrame) throw new Error(`missing historical data for ${symbol}`);
  const frames = [...new Set([timeframe, '1h', '4h'])];
  const klines: Record<string, demo.Kline[]> = {};
  for (const tf of frames) {
    const history = historyAt(byFrame[tf] ?? [], asOf, requiredCount(tf));
    if (history.length < requiredCount(tf)) throw new Error(`${symbol} ${tf} has ${history.length}/${requiredCount(tf)} bars at ${asOf}`);
    klines[tf] = history;
  }
  const baseHistory = klines[timeframe]!;
  const last = baseHistory.at(-1)!;
  const day = (byFrame[timeframe] ?? []).filter((kline) => kline.close_time <= asOf && kline.close_time > asOf - 24 * 3_600_000);
  const first = day[0] ?? last;
  const high = Math.max(...day.map((kline) => Number(kline.high)));
  const low = Math.min(...day.map((kline) => Number(kline.low)));
  const quoteVolume = day.reduce((sum, kline) => sum + Number(kline.volume) * Number(kline.close), 0);
  const change = ((Number(last.close) - Number(first.open)) / Number(first.open)) * 100;
  const nextFunding = Math.ceil((asOf + 1) / (8 * 3_600_000)) * 8 * 3_600_000;
  return {
    klines,
    market: {
      symbol,
      last: last.close,
      mark: last.close,
      funding_rate: '0.000100',
      next_funding_at: nextFunding,
      open_interest: symbol.startsWith('BTC') ? '85000' : '1250000',
      as_of: asOf,
      klines_tf: timeframe,
    },
    ticker24h: {
      priceChangePercent: change.toFixed(2),
      highPrice: fixedPrice(high, last.close),
      lowPrice: fixedPrice(low, last.close),
      quoteVolume: quoteVolume.toFixed(2),
    },
    oi_change_1h_pct: Number((((Number(last.close) / Number(first.open)) - 1) * 20).toFixed(2)),
    market_state: null,
    account: accountAt(symbol, asOf),
    playbook_text: demo.DEFAULT_PLAYBOOK,
    last_judgment_summary: null,
    halted: false,
    stale_all: false,
  };
}

function caseId(symbol: string, timeframe: string, asOf: number): string {
  return `scan-${symbol.toLowerCase()}-${timeframe}-${new Date(asOf).toISOString().replace(/[-:.TZ]/g, '').slice(0, 12)}`;
}

function baseCase(symbol: string, timeframe: string, asOf: number, set: string, data: HistoricalData): EvalCase {
  const visible = makeVisible(symbol, timeframe, asOf, data);
  return {
    id: caseId(symbol, timeframe, asOf),
    set,
    tags: ['scan', 'base'],
    symbol,
    timeframe,
    as_of: asOf,
    mode: 'scan',
    thread: null,
    visible,
    hidden: {
      future_klines: futureAt(data[symbol]![timeframe]!, asOf, FUTURE_BARS),
      horizon_bars: FUTURE_BARS,
      rubric: { expected_any_of: ['NO_TRADE', 'WATCH', 'PROPOSE'], note: '基础扫描' },
      mirror_of: null,
    },
  };
}

function staleVariant(source: EvalCase): EvalCase {
  const result = structuredClone(source);
  result.id = `${source.id}-stale`;
  result.tags = ['scan', 'stale'];
  result.visible.stale_all = true;
  result.visible.market.as_of -= 10 * 60_000;
  result.visible.account.as_of -= 10 * 60_000;
  result.hidden.rubric = { must_not: ['PROPOSE'], note: '全部市场/结构证据过期' };
  return result;
}

function haltedVariant(source: EvalCase): EvalCase {
  const result = structuredClone(source);
  result.id = `${source.id}-halted`;
  result.tags = ['scan', 'halted'];
  result.visible.halted = true;
  result.hidden.rubric = { must_not: ['PROPOSE', 'ADD'], note: '紧急停止只允许不增加风险' };
  return result;
}

function makeThread(source: EvalCase, ordinal: number): demo.StrategyThread {
  const history = source.visible.klines[source.timeframe]!;
  const entry = Number(source.visible.market.last);
  const feature = demo.tfFeatures(source.timeframe, history);
  const higher = demo.tfFeatures('1h', source.visible.klines['1h']!);
  const side: demo.Direction = higher.ema20 >= higher.ema50 ? 'long' : 'short';
  const risk = Math.max(entry * 0.004, feature.atr14 * 1.2);
  const stop = side === 'long' ? entry - risk : entry + risk;
  const target = side === 'long' ? entry + 2 * risk : entry - 2 * risk;
  const thread = demo.newThread({
    id: `thr-eval-b-${sha256(source.id).slice(0, 12)}`,
    symbol: source.symbol,
    side,
    source: 'agent',
    timeframe: source.timeframe,
    thesis: '结构方向一致，等待既定失效或目标条件',
    invalidation_text: '价格触及既定止损则论点失效',
    watch_conditions: ['结构是否维持', '价格是否触及保护位'],
    entry: { type: 'limit', price: source.visible.market.last, zone: [source.visible.market.last, source.visible.market.last] },
    stop_price: fixedPrice(stop, source.visible.market.last),
    take_profits: [fixedPrice(target, source.visible.market.last)],
    qty: source.symbol.startsWith('BTC') ? '0.01' : '0.2',
    margin_usdt: '500',
    leverage: 3,
    margin_mode: 'cross',
    now: source.as_of,
  });
  if (ordinal % 2 === 0) {
    thread.status = 'in_position';
    thread.filled_avg_price = source.visible.market.last;
    thread.opened_at = source.as_of;
  }
  return thread;
}

function attachThreadAccount(evalCase: EvalCase): void {
  const thread = evalCase.thread;
  if (!thread) return;
  const account = evalCase.visible.account;
  if (thread.status === 'in_position') {
    const entry = Number(thread.filled_avg_price ?? thread.entry.price ?? evalCase.visible.market.last);
    const mark = Number(evalCase.visible.market.mark);
    const qty = Number(thread.qty);
    const pnl = (thread.side === 'long' ? mark - entry : entry - mark) * qty;
    account.positions = [{
      symbol: thread.symbol,
      side: thread.side,
      qty: thread.qty,
      entry_price: fixedPrice(entry, evalCase.visible.market.last),
      mark_price: evalCase.visible.market.mark,
      unrealized_pnl: pnl.toFixed(2),
      leverage: thread.leverage,
    }];
    account.unrealized_pnl = pnl.toFixed(2);
    account.available = (10_000 - Number(thread.margin_usdt ?? '0')).toFixed(2);
  }
}

function reviewPair(source: EvalCase, ordinal: number, data: HistoricalData, length: number): EvalCase[] {
  const baseBars = data[source.symbol]![source.timeframe]!;
  const startIndex = baseBars.findIndex((kline) => kline.close_time === source.as_of);
  if (startIndex < 0) throw new Error(`as_of bar missing for ${source.id}`);
  const originalThread = makeThread(source, ordinal);
  const originals: EvalCase[] = [];
  const mirrors: EvalCase[] = [];
  for (let step = 0; step < length; step++) {
    const asOf = baseBars[startIndex + step]?.close_time;
    if (asOf === undefined) throw new Error(`not enough review bars after ${source.id}`);
    const id = `${source.id}-review-${step + 1}`;
    const evalCase: EvalCase = {
      id,
      set: source.set,
      tags: ['review', `chain:${source.id}:${step + 1}`],
      symbol: source.symbol,
      timeframe: source.timeframe,
      as_of: asOf,
      mode: 'review',
      thread: structuredClone(originalThread),
      visible: makeVisible(source.symbol, source.timeframe, asOf, data),
      hidden: {
        future_klines: futureAt(baseBars, asOf, FUTURE_BARS),
        horizon_bars: FUTURE_BARS,
        rubric: { expected_any_of: demo.allowedReviewActions(originalThread), note: '连续线程复查' },
        mirror_of: null,
      },
    };
    evalCase.visible.last_judgment_summary = step === 0 ? null : '上一步认为论点仍需按新证据复查';
    attachThreadAccount(evalCase);
    originals.push(evalCase);

    const mirrored = mirrorCase(evalCase, `${id}-mirror`);
    mirrored.tags = ['review', 'mirror', `chain:${source.id}-mirror:${step + 1}`];
    mirrored.hidden.rubric = { expected_any_of: mirrored.thread ? demo.allowedReviewActions(mirrored.thread) : [], note: '镜像连续线程复查' };
    mirrors.push(mirrored);
  }
  return [...originals, ...mirrors];
}

function validateDataset(options: GenerateOptions, data: HistoricalData): void {
  if (options.from >= options.to) throw new Error('--from must be earlier than --to');
  if (!Number.isInteger(options.count) || options.count < 1) throw new Error('--n must be a positive integer');
  if (options.symbols.length === 0) throw new Error('--symbols must contain at least one symbol');
  for (const symbol of options.symbols) {
    if (!data[symbol]?.[options.timeframe]) throw new Error(`missing ${symbol} ${options.timeframe} data`);
  }
}

/** Pure deterministic case generation from already-cached historical data. */
export function generateCasesFromData(options: GenerateOptions, data: HistoricalData): EvalCase[] {
  validateDataset(options, data);
  const random = mulberry32(options.seed);
  const bases: EvalCase[] = [];
  for (const [symbolIndex, symbol] of options.symbols.entries()) {
    const allocation = Math.floor(options.count / options.symbols.length) + (symbolIndex < options.count % options.symbols.length ? 1 : 0);
    const baseBars = data[symbol]![options.timeframe]!;
    const candidates = baseBars.filter((kline) => {
      if (kline.close_time < options.from || kline.close_time >= options.to) return false;
      if (futureAt(baseBars, kline.close_time, FUTURE_BARS + 2).length < FUTURE_BARS + 2) return false;
      return [...new Set([options.timeframe, '1h', '4h'])].every(
        (tf) => historyAt(data[symbol]![tf] ?? [], kline.close_time, requiredCount(tf)).length === requiredCount(tf),
      );
    });
    const selected = shuffled(candidates, random).slice(0, allocation).sort((a, b) => a.close_time - b.close_time);
    if (selected.length < allocation) throw new Error(`${symbol} only has ${selected.length}/${allocation} eligible as_of bars`);
    bases.push(...selected.map((kline) => baseCase(symbol, options.timeframe, kline.close_time, options.set, data)));
  }
  bases.sort((a, b) => a.as_of - b.as_of || a.symbol.localeCompare(b.symbol));
  const cases: EvalCase[] = [];
  for (const [ordinal, base] of bases.entries()) {
    cases.push(base, staleVariant(base), haltedVariant(base), mirrorCase(base));
    cases.push(...reviewPair(base, ordinal, data, 2 + ((options.seed + ordinal) % 2)));
  }
  const ids = new Set<string>();
  for (const evalCase of cases) {
    if (ids.has(evalCase.id)) throw new Error(`duplicate case id ${evalCase.id}`);
    ids.add(evalCase.id);
  }
  return cases;
}

export async function writeCases(cases: EvalCase[], outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const expected = new Set(cases.map((evalCase) => `${evalCase.id}.json`));
  const existing = await readdir(outDir);
  const extras = existing.filter((name) => name.endsWith('.json') && !expected.has(name));
  if (extras.length) throw new Error(`output contains stale case files; use an empty directory (${extras.slice(0, 3).join(', ')})`);
  await Promise.all(cases.map((evalCase) => writeFile(path.join(outDir, `${evalCase.id}.json`), stableJson(evalCase), 'utf8')));
}

export async function generateCases(options: GenerateOptions, cacheDir: string, outDir: string): Promise<EvalCase[]> {
  try {
    const data = await loadHistoricalData(options, cacheDir);
    const cases = generateCasesFromData(options, data);
    await writeCases(cases, outDir);
    return cases;
  } catch (error) {
    throw new Error(`case generation failed: ${errorMessage(error)}`, { cause: error });
  }
}

export function generationOptionsFromStrings(input: {
  symbols: string;
  timeframe: string;
  from: string;
  to: string;
  count: string;
  seed: string;
  set: string;
}): GenerateOptions {
  const symbols = [...new Set(input.symbols.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean))];
  for (const symbol of symbols) {
    if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) throw new Error(`invalid USDT symbol: ${symbol}`);
  }
  // Fail early for unsupported interval syntax using the production helper.
  demo.tfToMs(input.timeframe);
  return {
    symbols,
    timeframe: input.timeframe,
    from: parseUtcDate(input.from),
    to: parseUtcDate(input.to),
    count: Number(input.count),
    seed: Number(input.seed),
    set: input.set,
  };
}
