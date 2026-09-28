/**
 * 评审版锁定(lib/edition.ts lockReason / friendlyError):接入 / 模型 / 执行 / 保护单 / 紧急停止这些入口
 * 在 judge 版返回英文原因、技术报错换友好文案;默认版一律 null / 原样(Jacky 本机行为不变)。
 */
import { describe, expect, it } from 'vitest';
import { FRIENDLY_MARKET_ERROR, FRIENDLY_TECH_ERROR, TOO_MANY_REQUESTS, friendlyError, lockReason, LOCK_REASONS, type LockedFeature } from '../src/lib/edition';

const MINE: LockedFeature[] = [
  'wallet_connect',
  'exchange_credentials',
  'account_switch',
  'model_connection_edit',
  'execution_switch',
  'protection_verify',
  'emergency_stop',
  'execution_policy',
  'execution_channel',
];

describe('judge lock — connect / models / execution / halt', () => {
  it('judge edition returns an English reason for every locked feature', () => {
    for (const f of MINE) {
      const r = lockReason(f, 'judge');
      expect(r, f).toBe(LOCK_REASONS[f]);
      expect(r).toMatch(/judge edition/);
      expect(r).not.toMatch(/[一-鿿]/); // 评审只看英文
    }
  });

  it('default edition never locks anything', () => {
    for (const f of MINE) expect(lockReason(f, 'default'), f).toBeNull();
    // 不传 edition = 构建时的版本;测试环境没设 VITE_EDITION → 默认版
    for (const f of MINE) expect(lockReason(f), f).toBeNull();
  });

  it('friendlyError hides raw CLI errors in the judge edition only', () => {
    expect(friendlyError('spawn onchainos ENOENT', undefined, 'judge')).toBe(FRIENDLY_TECH_ERROR);
    expect(friendlyError('spawn onchainos ENOENT', undefined, 'default')).toBe('spawn onchainos ENOENT');
    expect(friendlyError('pi exit 1: timed out after 90s', undefined, 'judge')).toBe(FRIENDLY_TECH_ERROR);
    expect(friendlyError('Error: /Users/x/.okx/config.toml not found', 'custom', 'judge')).toBe('custom');
  });

  it('friendlyError turns raw exchange market-data errors (URL + HTTP 429 / OKX code) into a market-unavailable note', () => {
    const raw = 'Error:/api/v5/market/candles?instId=AVAX-USDT-SWAP&bar=1H&limit=220 -> HTTP 429';
    expect(friendlyError(raw, undefined, 'judge')).toBe(FRIENDLY_MARKET_ERROR);
    expect(friendlyError('/api/v5/market/candles?instId=SUI-USDT-SWAP -> HTTP 429(限频熔断中,8s 后再试)', undefined, 'judge')).toBe(FRIENDLY_MARKET_ERROR);
    expect(friendlyError('/api/v5/public/instruments -> OKX 50011 Too Many Requests', undefined, 'judge')).toBe(FRIENDLY_MARKET_ERROR);
    expect(friendlyError(raw, undefined, 'default')).toBe(raw);
    // 不是行情 / 限频的 HTTP 错误不能被说成限频
    expect(friendlyError('GET /api/market/catalog -> HTTP 404', undefined, 'judge')).toBe('GET /api/market/catalog -> HTTP 404');
    expect(friendlyError('This OKX.AI view is not included in the read-only snapshot.', undefined, 'judge')).toBe('This OKX.AI view is not included in the read-only snapshot.');
    expect(friendlyError(raw, 'custom', 'judge')).toBe('custom');
  });

  it('our own 429 (nginx limit_req / gateway visitor limit) is not blamed on the exchange', () => {
    expect(friendlyError('HTTP 429', undefined, 'judge')).toBe(TOO_MANY_REQUESTS);
    expect(friendlyError('Too Many Requests', undefined, 'judge')).toBe(TOO_MANY_REQUESTS);
    expect(friendlyError('Too many live connections from this visitor. Close other tabs and retry.', undefined, 'judge')).toBe(TOO_MANY_REQUESTS);
    expect(friendlyError('<html><head><title>429 Too Many Requests</title></head></html>', undefined, 'judge')).toBe(TOO_MANY_REQUESTS);
    expect(friendlyError(TOO_MANY_REQUESTS, undefined, 'judge')).toBe(TOO_MANY_REQUESTS);
    // 交易所那边的 429 仍是行情限频
    expect(friendlyError('/api/v5/market/candles?instId=BTC-USDT-SWAP -> HTTP 429', undefined, 'judge')).toBe(FRIENDLY_MARKET_ERROR);
    expect(friendlyError('/api/v5/market/candles -> HTTP 429(本机节流:排队预计 31s,超过上限)', undefined, 'judge')).toBe(FRIENDLY_MARKET_ERROR);
    expect(friendlyError('HTTP 429', undefined, 'default')).toBe('HTTP 429');
  });

  it('friendlyError leaves plain business messages and empty values alone', () => {
    expect(friendlyError('Insufficient balance', undefined, 'judge')).toBe('Insufficient balance');
    expect(friendlyError(null, undefined, 'judge')).toBeNull();
    expect(friendlyError(undefined, undefined, 'judge')).toBeUndefined();
    expect(friendlyError('', undefined, 'judge')).toBe('');
  });
});
