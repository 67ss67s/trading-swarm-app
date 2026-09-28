// 公网访客 SSE 名额释放:反代下客户端断开后,上游连接要等下一次写失败才 close。心跳缩到 10s(TG_SSE_HEARTBEAT_MS 可调),
// 心跳写不进去就立刻断开 → 刷新后旧连接最多一个心跳周期就释放名额。
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sseHeartbeatMs } from '../../src/demo/ops-config.js';
import { judgeLiveRoutes } from '../../src/demo/routes-judge-live.js';
import type { RouteContext } from '../../src/demo/http-extra.js';

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('SSE 心跳间隔', () => {
  it('默认 10 秒;TG_SSE_HEARTBEAT_MS 可调;越界报错', () => {
    expect(sseHeartbeatMs()).toBe(10_000);
    vi.stubEnv('TG_SSE_HEARTBEAT_MS', '3000');
    expect(sseHeartbeatMs()).toBe(3000);
    vi.stubEnv('TG_SSE_HEARTBEAT_MS', '10');
    expect(() => sseHeartbeatMs()).toThrow(/TG_SSE_HEARTBEAT_MS/);
  });
});

type Handler = (req: EventEmitter, res: FakeRes, url: URL, p: Record<string, string>) => Promise<void>;
class FakeRes extends EventEmitter {
  writes: string[] = [];
  destroyed = false;
  writable = true;
  writeHead(): this { return this; }
  write(chunk: string): boolean { this.writes.push(chunk); return this.writable; }
  destroy(): void { this.destroyed = true; this.emit('close'); }
}

function streamHandler(): { handler: Handler; rt: EventEmitter } {
  const routes = new Map<string, Handler>();
  const rt = Object.assign(new EventEmitter(), { strategyRuns: () => ({}) });
  judgeLiveRoutes({ route: (m: string, p: string, h: unknown) => routes.set(`${m} ${p}`, h as Handler), guarded: (h: unknown) => h, json: () => undefined, fail: () => undefined, readBody: async () => ({}), rt, store: {}, oauth: null, emit: () => undefined } as unknown as RouteContext);
  return { handler: routes.get('GET /api/judge/live/stream')!, rt };
}

describe('/api/judge/live/stream 心跳', () => {
  it('按 TG_SSE_HEARTBEAT_MS 写心跳;心跳写不进去就断开并摘掉监听', async () => {
    vi.useFakeTimers();
    vi.stubEnv('TG_SSE_HEARTBEAT_MS', '2000');
    const { handler, rt } = streamHandler();
    const req = new EventEmitter(), res = new FakeRes();
    await handler(req, res, new URL('http://x/api/judge/live/stream'), {});
    expect(rt.listenerCount('judge.live')).toBe(1);
    vi.advanceTimersByTime(1999);
    expect(res.writes.filter((w) => w === ': ping\n\n')).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(res.writes.filter((w) => w === ': ping\n\n')).toHaveLength(1);
    res.writable = false; // 客户端已走、缓冲写满
    vi.advanceTimersByTime(2000);
    expect(res.destroyed).toBe(true);
    expect(rt.listenerCount('judge.live')).toBe(0);
  });

  it('默认 10 秒一次(原来 15 秒)', async () => {
    vi.useFakeTimers();
    const { handler } = streamHandler();
    const res = new FakeRes();
    await handler(new EventEmitter(), res, new URL('http://x/api/judge/live/stream'), {});
    vi.advanceTimersByTime(10_000);
    expect(res.writes.filter((w) => w === ': ping\n\n')).toHaveLength(1);
    res.destroy();
  });
});
