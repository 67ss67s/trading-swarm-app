import { demo } from '@trade-gate/gateway';

import type { EvalCase } from './types.js';

function decimalPlaces(value: string): number {
  return value.includes('.') ? value.length - value.indexOf('.') - 1 : 0;
}

function scaled(value: string, places: number): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  const sign = whole.startsWith('-') ? -1n : 1n;
  const unsignedWhole = whole.replace(/^-/, '') || '0';
  const digits = `${unsignedWhole}${fraction.padEnd(places, '0')}`;
  return sign * BigInt(digits || '0');
}

function fromScaled(value: bigint, places: number): string {
  const sign = value < 0n ? '-' : '';
  const digits = (value < 0n ? -value : value).toString().padStart(places + 1, '0');
  if (places === 0) return `${sign}${digits}`;
  return `${sign}${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

/** Exact decimal reflection p -> 2*pivot-p, retaining enough decimal places for both inputs. */
export function reflectDecimal(value: string, pivot: string): string {
  const places = Math.max(decimalPlaces(value), decimalPlaces(pivot));
  return fromScaled(2n * scaled(pivot, places) - scaled(value, places), places);
}

function negateDecimal(value: string): string {
  if (value.startsWith('-')) return value.slice(1);
  return /^0(?:\.0+)?$/.test(value) ? value : `-${value}`;
}

export function mirrorKline(kline: demo.Kline, pivot: string): demo.Kline {
  return {
    ...kline,
    open: reflectDecimal(kline.open, pivot),
    high: reflectDecimal(kline.low, pivot),
    low: reflectDecimal(kline.high, pivot),
    close: reflectDecimal(kline.close, pivot),
  };
}

function mirrorThread(thread: demo.StrategyThread, pivot: string): demo.StrategyThread {
  const reflect = (value: string | null): string | null => (value === null ? null : reflectDecimal(value, pivot));
  const zone = thread.entry.zone;
  return {
    ...thread,
    side: thread.side === 'long' ? 'short' : 'long',
    entry: {
      ...thread.entry,
      price: reflect(thread.entry.price),
      zone: zone ? [reflectDecimal(zone[1], pivot), reflectDecimal(zone[0], pivot)] : null,
    },
    stop_price: reflect(thread.stop_price),
    take_profits: thread.take_profits.map((price) => reflectDecimal(price, pivot)),
    filled_avg_price: reflect(thread.filled_avg_price),
  };
}

/** Mirrors all price-bearing visible/hidden fields while preserving timestamps and volume. */
export function mirrorCase(source: EvalCase, id = `${source.id}-mirror`): EvalCase {
  const pivot = source.visible.market.last;
  const mirrored = structuredClone(source);
  mirrored.id = id;
  mirrored.tags = [...new Set([...source.tags.filter((tag) => tag !== 'base'), 'mirror'])];
  mirrored.hidden.mirror_of = source.id;
  for (const [tf, klines] of Object.entries(source.visible.klines)) {
    mirrored.visible.klines[tf] = klines.map((kline) => mirrorKline(kline, pivot));
  }
  mirrored.hidden.future_klines = source.hidden.future_klines.map((kline) => mirrorKline(kline, pivot));
  mirrored.visible.market.last = reflectDecimal(source.visible.market.last, pivot);
  mirrored.visible.market.mark = reflectDecimal(source.visible.market.mark, pivot);
  mirrored.visible.ticker24h = {
    ...source.visible.ticker24h,
    priceChangePercent: negateDecimal(source.visible.ticker24h.priceChangePercent),
    highPrice: reflectDecimal(source.visible.ticker24h.lowPrice, pivot),
    lowPrice: reflectDecimal(source.visible.ticker24h.highPrice, pivot),
  };
  if (source.thread) mirrored.thread = mirrorThread(source.thread, pivot);
  mirrored.visible.account.positions = source.visible.account.positions.map((position) => ({
    ...position,
    side: position.side === 'long' ? 'short' : 'long',
    entry_price: reflectDecimal(position.entry_price, pivot),
    mark_price: reflectDecimal(position.mark_price, pivot),
  }));
  mirrored.visible.account.open_orders = source.visible.account.open_orders.map((order) => ({
    ...order,
    side: order.side === 'BUY' ? 'SELL' : order.side === 'SELL' ? 'BUY' : order.side,
    price: order.price === null ? null : reflectDecimal(order.price, pivot),
    stop_price: order.stop_price === null ? null : reflectDecimal(order.stop_price, pivot),
  }));
  if (mirrored.visible.market_state) {
    const state = mirrored.visible.market_state;
    state.bias = state.bias === 'long' ? 'short' : state.bias === 'short' ? 'long' : 'neutral';
    state.candidates = state.candidates.map((candidate) => ({ ...candidate, direction: candidate.direction === 'long' ? 'short' : 'long' }));
    state.majors = state.majors.map((major) =>
      major.symbol === source.symbol
        ? { ...major, last: reflectDecimal(major.last, pivot), change_24h_pct: negateDecimal(major.change_24h_pct) }
        : major,
    );
  }
  return mirrored;
}
