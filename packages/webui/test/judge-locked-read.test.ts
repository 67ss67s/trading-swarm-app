/**
 * 评审版公网访客读「仅所有者可见」接口(/api/models、/api/execution、/api/brains …)时,网关回 200 + 锁定占位
 * `{locked:true, code:'judge_locked'}`(gateway public-gate.ts ownerOnlyRead)。09-26 评审版首页因此整页黑屏:
 * okConnectionCount 拿占位当 ModelsView,view.connections.filter 抛 TypeError。
 * 这里钉住两层:请求层把占位当错误抛出;模型逻辑对缺字段的 view 不崩。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, isJudgeLocked, isJudgeLockedBody, resetLockedPaths } from '../src/api/client';
import { listSep, quote, setLang } from '../src/lib/i18n';
import { brokenRoles, needsModelSetup, okConnectionCount, roleBindingBroken } from '../src/components/models/logic';

const LOCKED = { locked: true, code: 'judge_locked', status: 'demo', message: 'Locked in the review demo: account, wallet, model and execution details are owner-only.' };

afterEach(() => {
  vi.unstubAllGlobals();
  resetLockedPaths();
  setLang('zh');
});

describe('judge_locked placeholder', () => {
  it('request layer rejects the placeholder as a judge_locked error instead of returning it as data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(LOCKED), { status: 200, headers: { 'content-type': 'application/json' } })));
    const err = await api.models().then(() => null, (e: unknown) => e);
    expect(isJudgeLocked(err)).toBe(true);
    expect((err as Error).message).toContain('owner-only');
    await expect(api.execution()).rejects.toMatchObject({ code: 'judge_locked' });
  });

  it('ordinary bodies that merely have a locked field are not mistaken for the placeholder', () => {
    expect(isJudgeLockedBody(LOCKED)).toBe(true);
    expect(isJudgeLockedBody({ locked: true })).toBe(false);
    expect(isJudgeLockedBody({ locked: false, code: 'judge_locked' })).toBe(false);
    expect(isJudgeLockedBody(null)).toBe(false);
  });

  it('model logic tolerates a view without connections / bindings / effective', () => {
    const v = LOCKED as never;
    expect(okConnectionCount(v)).toBe(0);
    expect(roleBindingBroken(v, 'judge')).toBe(false);
    expect(brokenRoles(v)).toEqual([]);
    expect(needsModelSetup(v, [], { brain: 'pi', cheap_brain: 'pi' })).toBe(false);
  });
});

describe('locked endpoints are not polled again', () => {
  it('after a 403 judge_locked, later GETs of the same path fail locally without hitting the network', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'judge_locked', message: 'Locked in the review demo.' }, locked: true }), { status: 403, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.execution()).rejects.toMatchObject({ code: 'judge_locked' });
    await expect(api.execution()).rejects.toMatchObject({ code: 'judge_locked' });
    await expect(api.execution()).rejects.toMatchObject({ code: 'judge_locked' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 别的路径照常出网
    await expect(api.models()).rejects.toMatchObject({ code: 'judge_locked' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('other errors are not remembered', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'internal', message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.execution()).rejects.toMatchObject({ code: 'internal' });
    await expect(api.execution()).rejects.toMatchObject({ code: 'internal' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('language-aware list separator and quotes', () => {
  it('uses 、 and 「」 in Chinese, comma and curly quotes in English', () => {
    setLang('zh');
    expect(['a', 'b'].join(listSep())).toBe('a、b');
    expect(quote('hi')).toBe('「hi」');
    setLang('en');
    expect(['Breakout', 'MA trend'].join(listSep())).toBe('Breakout, MA trend');
    expect(quote('Recommend a few coins')).toBe('\u201cRecommend a few coins\u201d');
  });
});

describe('our own rate limit', () => {
  it('a 429 from nginx (HTML body) or the gateway visitor limit becomes a retry hint, not an exchange error', async () => {
    const { TOO_MANY_REQUESTS } = await import('../src/lib/edition');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><head><title>429 Too Many Requests</title></head><body></body></html>', { status: 429, headers: { 'content-type': 'text/html' } })));
    await expect(api.overview()).rejects.toMatchObject({ status: 429, code: 'rate_limited', message: TOO_MANY_REQUESTS });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'demo_rate_limited', message: 'Too many live connections from this visitor.' } }), { status: 429, headers: { 'content-type': 'application/json' } })));
    await expect(api.overview()).rejects.toMatchObject({ status: 429, code: 'demo_rate_limited', message: TOO_MANY_REQUESTS });
  });
});
