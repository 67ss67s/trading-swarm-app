// OkxCliBackend(docs/design/okx-atk-2026-09-20.md §4)。okx CLI 用注入的假 spawn 顶掉:
// 必须注入假 spawn，不读取或修改真实配置；这里测的是**我们对 CLI 输出的解释**
// ——张数换算、算法单 algoId 的 KV 往返、错误码分类、写超时的 ambiguous 口径。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OkxCliBackend, attachedAlgoIdOf, coversWindow, extractFailure, mapOrderState, parseOkxConfigShow, type OkxKv, type OkxRunResult, type OkxSpawnFn } from '../../src/demo/execution-okx.js';
import { resetInstruments, setInstruments, toClOrdId, type OkxInstrument } from '../../src/demo/okx/instruments.js';
import { hasLiveStop } from '../../src/demo/threads.js';

const BTC: OkxInstrument = { symbol: 'BTCUSDT', instId: 'BTC-USDT-SWAP', instFamily: 'BTC-USDT', ctVal: '0.01', ctValCcy: 'BTC', lotSz: '0.01', minSz: '0.01', tickSz: '0.1', state: 'live' };
const XRP: OkxInstrument = { symbol: 'XRPUSDT', instId: 'XRP-USDT-SWAP', instFamily: 'XRP-USDT', ctVal: '100', ctValCcy: 'XRP', lotSz: '0.1', minSz: '0.1', tickSz: '0.0001', state: 'live' };

/** 一条假 CLI 规则:命中 `match`(全部子串都在 argv 里)就吐 `out`。 */
interface Rule {
  match: string[];
  /** 这些子串出现在 argv 里就不算命中(`swap orders` 与 `swap algo orders` 只差一个词)。 */
  not?: string[];
  out?: unknown;
  /** 非 0 退出码 + 这段 stderr。 */
  fail?: { code: number; stderr: string };
  timeout?: boolean;
}

function memKv(): OkxKv & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => map.set(k, v) };
}

function fakeSpawn(rules: Rule[], calls: string[][] = []): OkxSpawnFn {
  return async (_bin, args, _timeoutMs): Promise<OkxRunResult> => {
    calls.push(args);
    const rule = rules.find((r) => r.match.every((m) => args.includes(m)) && (!args.includes('spot') || r.match.includes('spot')) && !(r.not ?? []).some((m) => args.includes(m)));
    if (!rule && args.includes('spot') && args.includes('orders')) return { code: 0, stdout: '[]', stderr: '' };
    if (!rule) return { code: 1, stdout: '', stderr: `no fake rule for: ${args.join(' ')}` };
    if (rule.timeout) return { code: 124, stdout: '', stderr: '', timedOut: true };
    if (rule.fail) return { code: rule.fail.code, stdout: '', stderr: rule.fail.stderr };
    return { code: 0, stdout: JSON.stringify(rule.out ?? []), stderr: '' };
  };
}

function backend(rules: Rule[], opts: { kv?: OkxKv; calls?: string[][]; demo?: boolean | null; live?: boolean } = {}): { b: OkxCliBackend; kv: OkxKv & { map: Map<string, string> }; calls: string[][] } {
  const kv = (opts.kv as ReturnType<typeof memKv>) ?? memKv();
  const calls = opts.calls ?? [];
  const b = new OkxCliBackend({
    bin: '/nonexistent/okx',
    profile: 'tg-demo',
    demo: opts.demo === undefined ? true : opts.demo,
    live: opts.live ?? false,
    kv,
    log: () => {},
    spawnFn: fakeSpawn(rules, calls),
    algoResolveDelayMs: 0,
  });
  return { b, kv, calls };
}

beforeEach(() => {
  resetInstruments();
  setInstruments([BTC, XRP]);
  setInstruments([{ ...BTC, instId: 'BTC-USDT', ctVal: '1', lotSz: '0.00001', minSz: '0.0001' }], Date.now(), 'spot');
});
afterEach(() => {
  resetInstruments();
});

describe('start():模拟盘双保险与持仓模式闸', () => {
  it('profile 不是模拟盘且没有 TG_OKX_LIVE 时拒绝启动', async () => {
    const { b } = backend([{ match: ['account', 'config'], out: [{ posMode: 'net_mode' }] }], { demo: false });
    await expect(b.start()).rejects.toThrow(/不是模拟盘/);
  });

  it('demo 读不出来(null)一样按实盘处理,拒绝启动', async () => {
    const { b } = backend([{ match: ['account', 'config'], out: [{ posMode: 'net_mode' }] }], { demo: null });
    await expect(b.start()).rejects.toThrow(/拒绝启动/);
  });

  it('显式 TG_OKX_LIVE 才放行非模拟盘', async () => {
    const { b, calls } = backend([{ match: ['account', 'config'], out: [{ posMode: 'net_mode', acctLv: '2' }] }], { demo: false, live: true });
    await b.start();
    // live=1 且 profile 自己就不是 demo:这是唯一不带 --demo 的组合。
    expect(calls[0]).toEqual(['--profile', 'tg-demo', '--json', 'account', 'config']);
  });

  it('long_short_mode 报错并给出改法,不自动改账户设置', async () => {
    const { b } = backend([{ match: ['account', 'config'], out: [{ posMode: 'long_short_mode' }] }]);
    await expect(b.start()).rejects.toThrow(/set-position-mode --posMode net_mode/);
  });
});

describe('account():张数 → 币,算法单当挂单', () => {
  const rules: Rule[] = [
    { match: ['account', 'balance'], out: [{ totalEq: '9999', details: [{ ccy: 'USDT', eq: '5123.4567', availBal: '4000.1', upl: '12.345' }, { ccy: 'BTC', eq: '1' }] }] },
    { match: ['account', 'positions'], out: [{ instId: 'BTC-USDT-SWAP', pos: '-13', avgPx: '80000', markPx: '79500', upl: '65.1234', lever: '5' }, { instId: 'XRP-USDT-SWAP', pos: '0' }] },
    { match: ['swap', 'orders'], not: ['algo'], out: [{ instId: 'BTC-USDT-SWAP', clOrdId: 'tgd123e1', ordType: 'limit', side: 'buy', sz: '5', px: '70000', reduceOnly: 'false', state: 'live' }] },
    { match: ['algo', 'orders', 'conditional'], out: [{ instId: 'BTC-USDT-SWAP', algoId: 'A1', ordType: 'conditional', side: 'buy', sz: '13', slTriggerPx: '82000', reduceOnly: 'true', state: 'live' }] },
    { match: ['algo', 'orders', 'oco'], out: [] },
  ];

  it('权益取 USDT 明细、持仓正负定方向、张数换成币', async () => {
    const { b } = backend(rules);
    const a = await b.account();
    expect(a.backend).toBe('okx');
    expect(a.equity).toBe('5123.46');
    expect(a.available).toBe('4000.10');
    expect(a.unrealized_pnl).toBe('12.35');
    expect(a.positions).toHaveLength(1);
    expect(a.positions[0]).toMatchObject({ symbol: 'BTCUSDT', side: 'short', qty: '0.13', entry_price: '80000', leverage: 5 });
  });

  it('普通挂单与算法单都进 open_orders,算法单的 stop_price 取 slTriggerPx', async () => {
    const { b, kv } = backend(rules);
    kv.set('okx.algo.rev.v1:A1', 'tgd123s1');
    const a = await b.account();
    expect(a.open_orders).toHaveLength(2);
    expect(a.open_orders[0]).toMatchObject({ symbol: 'BTCUSDT', type: 'LIMIT', side: 'BUY', qty: '0.05', price: '70000', stop_price: null });
    // 算法单没有客户端 id:KV 反查得到内部 cid 就用它。
    expect(a.open_orders[1]).toMatchObject({ client_order_id: 'tgd123s1', stop_price: '82000', reduce_only: true, qty: '0.13' });
  });

  // review #8:OKX 的 `conditional` / `sell` 在 runtime 的词表里不存在。
  it('带 slTriggerPx 的算法单翻成 STOP_MARKET + 大写方向,hasLiveStop 能认出来', async () => {
    const { b } = backend(rules);
    const a = await b.account();
    const algo = a.open_orders[1]!;
    expect(algo).toMatchObject({ type: 'STOP_MARKET', side: 'BUY', reduce_only: true, stop_price: '82000' });
    const t = { symbol: 'BTCUSDT', side: 'short' as const, stop_price: '82000', protection_client_order_ids: [] as string[] };
    expect(hasLiveStop(t as never, a.open_orders)).toBe(true);
  });

  it('OCO 同时带 TP/SL 仍是止损;只有 TP 的单不冒充止损', async () => {
    const { b } = backend([
      ...rules.filter((r) => !r.match.includes('conditional') && !r.match.includes('oco')),
      { match: ['algo', 'orders', 'conditional'], out: [{ instId: 'BTC-USDT-SWAP', algoId: 'T1', ordType: 'conditional', side: 'sell', sz: '13', tpTriggerPx: '90000', state: 'live' }] },
      { match: ['algo', 'orders', 'oco'], out: [{ instId: 'BTC-USDT-SWAP', algoId: 'O1', ordType: 'oco', side: 'buy', sz: '13', slTriggerPx: '82000', tpTriggerPx: '70000', state: 'live' }] },
    ]);
    const a = await b.account();
    const tp = a.open_orders.find((o) => o.client_order_id === 'T1')!;
    const oco = a.open_orders.find((o) => o.client_order_id === 'O1')!;
    expect(tp).toMatchObject({ type: 'TAKE_PROFIT_MARKET', stop_price: '90000' });
    expect(oco).toMatchObject({ type: 'STOP_MARKET', stop_price: '82000' });
    // 只有止盈的那张不能让巡检以为止损还在。
    const t = { symbol: 'BTCUSDT', side: 'long' as const, stop_price: '90000', protection_client_order_ids: [] as string[] };
    expect(hasLiveStop(t as never, [tp])).toBe(false);
  });

  it('算法单带 algoClOrdId 时直接当 client_order_id(不用 KV)', async () => {
    const { b } = backend([
      ...rules.filter((r) => !r.match.includes('conditional')),
      { match: ['algo', 'orders', 'conditional'], out: [{ instId: 'BTC-USDT-SWAP', algoId: 'A1', algoClOrdId: 'tgdabc123s1', ordType: 'conditional', side: 'buy', sz: '13', slTriggerPx: '82000', state: 'live' }] },
    ]);
    const a = await b.account();
    expect(a.open_orders[1]!.client_order_id).toBe('tgdabc123s1');
  });

  // review #9:吞成 [] 就等于对巡检说「现在没有保护单」,巡检会照着补挂一张。
  it('算法单查询失败 → 整个账户快照失败,不给一份「没有保护单」的新鲜视图', async () => {
    const { b } = backend([
      ...rules.filter((r) => !r.match.includes('oco')),
      { match: ['algo', 'orders', 'oco'], fail: { code: 1, stderr: 'network down' } },
    ]);
    await expect(b.account()).rejects.toThrow();
  });

  // review #10:ctVal=0.01 的 BTC 合约,100 张是 1 BTC,不是 100 BTC。
  it('合约规格缺失时账户读取硬失败,不把张数当币数量', async () => {
    // 表非空(所以不会去补拉),但里面没有 BTC:1:1 回退会把 13 张说成 13 BTC。
    setInstruments([XRP]);
    const { b } = backend(rules);
    await expect(b.account()).rejects.toThrow(/合约规格/);
  });

  it('KV 里没有反查映射时退回 algoId 当 client_algo_id', async () => {
    const { b } = backend(rules);
    const a = await b.account();
    expect(a.open_orders[1]!.client_order_id).toBe('A1');
  });

  it('15 秒内复用缓存,invalidateAccount 后重新读', async () => {
    const calls: string[][] = [];
    const { b } = backend(rules, { calls });
    await b.account();
    await b.account();
    const first = calls.length;
    expect(first).toBe(8); // balance + positions + perp/spot 各自普通单与两种算法单
    b.invalidateAccount();
    await b.account();
    expect(calls.length).toBe(first + 8);
    expect(b.accountStalenessMs()).toBe(45_000);
  });
});

describe('openWithProtection:附带止损/止盈,归属只认父订单详情', () => {
  // review #4:附带腿的 algoId **只能**从父订单详情的 attachAlgoOrds[] 读回。
  // CLI 的 `swap place` 不支持 --attachAlgoClOrdId(dist 里 buildAttachAlgoOrds 只拼 tp/sl 价格),
  // 所以拿不到就是 unknown —— 不许再去算法单列表里挑「最新的 reduceOnly 单」。
  const rules = (attach: unknown[] | null, extra: Rule[] = []): Rule[] => [
    { match: ['swap', 'place'], out: [{ ordId: 'O1', clOrdId: 'tgd123e1', sCode: '0', sMsg: '' }] },
    { match: ['swap', 'get'], out: [{ ordId: 'O1', state: 'filled', avgPx: '80010', accFillSz: '13', ...(attach ? { attachAlgoOrds: attach } : {}) }] },
    ...extra,
  ];

  it('止损+止盈一起下 = 一张 OCO,两条腿回同一个 algoId 并写进 KV', async () => {
    const calls: string[][] = [];
    const { b, kv } = backend(rules([{ attachAlgoId: 'AG9', slTriggerPx: '78000', tpTriggerPx: '85000' }], [
      { match: ['algo', 'orders'], out: [{ algoId: 'AG9', ordType: 'oco', side: 'sell', slTriggerPx: '78000', tpTriggerPx: '85000', cTime: '1' }] },
    ]), { calls });
    const r = await b.openWithProtection({
      symbol: 'BTCUSDT', direction: 'long', qty: '0.13', entry: 'market', limit_price: null,
      client_order_id: 'tgd-abc123-e1', stop_price: '78000', stop_client_algo_id: 'tgd-abc123-s1',
      take_profit: { trigger_price: '85000', client_algo_id: 'tgd-abc123-t1' },
    });
    const place = calls.find((c) => c.includes('place'))!;
    expect(place).toContain('--slTriggerPx');
    expect(place[place.indexOf('--slTriggerPx') + 1]).toBe('78000');
    expect(place[place.indexOf('--tpTriggerPx') + 1]).toBe('85000');
    expect(place[place.indexOf('--sz') + 1]).toBe('13'); // 0.13 BTC / ctVal 0.01
    expect(place[place.indexOf('--clOrdId') + 1]).toBe('tgdabc123e1');
    expect(place).toContain('--slTriggerPxType');
    expect(r.entry.outcome).toBe('filled');
    expect(r.entry.avg_price).toBe('80010');
    expect(r.entry.executed_qty).toBe('0.13');
    expect(r.stop).toMatchObject({ outcome: 'submitted', algo_id: 'AG9' });
    expect(r.tp).toMatchObject({ outcome: 'submitted', algo_id: 'AG9' });
    expect(kv.get(`okx.algo.v1:${toClOrdId('tgd-abc123-s1')}`)).toBe('AG9');
    expect(kv.get(`okx.algo.v1:${toClOrdId('tgd-abc123-t1')}`)).toBe('AG9');
    expect(kv.get('okx.algo.rev.v1:AG9')).toBe(toClOrdId('tgd-abc123-t1'));
  });

  it('没有止盈时查 conditional,tp 腿是 skipped', async () => {
    const { b } = backend(rules([{ attachAlgoId: 'AG1', slTriggerPx: '82000' }], [
      { match: ['algo', 'orders'], out: [{ algoId: 'AG1', ordType: 'conditional', side: 'buy', slTriggerPx: '82000', cTime: '1' }] },
    ]));
    const r = await b.openWithProtection({
      symbol: 'BTCUSDT', direction: 'short', qty: '0.13', entry: 'market', limit_price: null,
      client_order_id: 'tgd-abc123-e1', stop_price: '82000', stop_client_algo_id: 'tgd-abc123-s1',
    });
    expect(r.stop.algo_id).toBe('AG1');
    expect(r.tp).toMatchObject({ outcome: 'skipped', algo_id: null, error: null });
  });

  it('父订单详情里没有 attachAlgoOrds → stop 是 unknown 而不是 submitted(不能当成挂上了)', async () => {
    const { b } = backend(rules(null));
    const r = await b.openWithProtection({
      symbol: 'BTCUSDT', direction: 'long', qty: '0.13', entry: 'market', limit_price: null,
      client_order_id: 'tgd-abc123-e1', stop_price: '78000', stop_client_algo_id: 'tgd-abc123-s1',
    });
    expect(r.stop.outcome).toBe('unknown');
    expect(r.stop.algo_id).toBeNull();
    expect(r.stop.error).toMatch(/attachAlgoOrds/);
  });

  // 这条就是旧「最新 reduceOnly 单」回退的反例:列表里摆着一张别人的止损。
  it('归属不明时绝不认领算法单列表里的旧单,也不去查那个列表', async () => {
    const calls: string[][] = [];
    const { b, kv } = backend(rules(null, [
      { match: ['algo', 'orders'], out: [{ algoId: 'SOMEONE_ELSE', ordType: 'conditional', reduceOnly: 'true', cTime: '999999' }] },
    ]), { calls });
    const r = await b.openWithProtection({
      symbol: 'BTCUSDT', direction: 'long', qty: '0.13', entry: 'market', limit_price: null,
      client_order_id: 'tgd-abc123-e1', stop_price: '78000', stop_client_algo_id: 'tgd-abc123-s1',
    });
    expect(r.stop.outcome).toBe('unknown');
    expect(r.stop.algo_id).toBeNull();
    // 别人的 algoId 既没被当成我们的,也没被写进 KV。
    expect(kv.get(`okx.algo.v1:${toClOrdId('tgd-abc123-s1')}`)).toBeNull();
    expect(calls.some((c) => c.includes('algo') && c.includes('orders'))).toBe(false);
  });

  // 2026-09-21 真 key 实测:attachAlgoId 不是成交后真正生成的算法单 id(查不到、撤单 51400)。
  it('attachAlgoId 在挂单列表里不存在时,按方向/触发价/时间唯一匹配到真实 algoId 并写进 KV', async () => {
    const { b, kv } = backend(rules([{ attachAlgoId: 'ATTACH1', slTriggerPx: '78000' }], [
      { match: ['algo', 'orders'], out: [
        { algoId: 'OTHER', ordType: 'conditional', side: 'buy', slTriggerPx: '78000', cTime: '5000' },
        { algoId: 'REAL1', ordType: 'conditional', side: 'sell', slTriggerPx: '78000', cTime: '5000' },
      ] },
    ]));
    const r = await b.openWithProtection({
      symbol: 'BTCUSDT', direction: 'long', qty: '0.13', entry: 'market', limit_price: null,
      client_order_id: 'tgd-abc123-e1', stop_price: '78000', stop_client_algo_id: 'tgd-abc123-s1',
    });
    expect(r.stop).toMatchObject({ outcome: 'submitted', algo_id: 'REAL1' });
    expect(kv.get(`okx.algo.v1:${toClOrdId('tgd-abc123-s1')}`)).toBe('REAL1');
    expect(await b.algoOrderExists('BTCUSDT', 'tgd-abc123-s1')).toBe(true);
  });

  it('挂单列表里没有能唯一归属的条件单 → stop 是 unknown,不把撤不掉的 attachAlgoId 当成已挂上', async () => {
    const { b, kv } = backend(rules([{ attachAlgoId: 'ATTACH1', slTriggerPx: '78000' }], [
      { match: ['algo', 'orders'], out: [
        { algoId: 'X1', ordType: 'conditional', side: 'sell', slTriggerPx: '78000', cTime: '5000' },
        { algoId: 'X2', ordType: 'conditional', side: 'sell', slTriggerPx: '78000', cTime: '5000' },
      ] },
    ]));
    const r = await b.openWithProtection({
      symbol: 'BTCUSDT', direction: 'long', qty: '0.13', entry: 'market', limit_price: null,
      client_order_id: 'tgd-abc123-e1', stop_price: '78000', stop_client_algo_id: 'tgd-abc123-s1',
    });
    expect(r.stop.outcome).toBe('unknown');
    expect(r.stop.error).toMatch(/ATTACH1/);
    expect(kv.get(`okx.algo.v1:${toClOrdId('tgd-abc123-s1')}`)).toBeNull();
  });

  it('老返回体的 linkedAlgoOrd.algoId 也认', async () => {
    const { b } = backend([
      { match: ['swap', 'place'], out: [{ ordId: 'O1', sCode: '0' }] },
      { match: ['swap', 'get'], out: [{ state: 'filled', avgPx: '1', accFillSz: '13', linkedAlgoOrd: { algoId: 'LK1' } }] },
    ]);
    const r = await b.openWithProtection({
      symbol: 'BTCUSDT', direction: 'long', qty: '0.13', entry: 'market', limit_price: null,
      client_order_id: 'tgd-abc123-e1', stop_price: '78000', stop_client_algo_id: 'tgd-abc123-s1',
    });
    expect(r.stop).toMatchObject({ outcome: 'submitted', algo_id: 'LK1' });
  });

  it('下单被拒时三条腿都是 failed,不会假装挂了保护', async () => {
    const { b } = backend([{ match: ['swap', 'place'], out: [{ sCode: '51008', sMsg: 'Insufficient balance' }] }]);
    const r = await b.openWithProtection({
      symbol: 'BTCUSDT', direction: 'long', qty: '0.13', entry: 'market', limit_price: null,
      client_order_id: 'tgd-abc123-e1', stop_price: '78000', stop_client_algo_id: 'tgd-abc123-s1',
    });
    expect(r.entry.outcome).toBe('failed');
    expect(r.entry.error).toMatch(/51008/);
    expect(r.entry.error).toMatch(/余额不足/);
    expect(r.stop.outcome).toBe('failed');
  });

});

describe('placeStop:张数取当前持仓', () => {
  it('按现查的持仓张数挂 conditional,algoId 写进 KV', async () => {
    const calls: string[][] = [];
    const { b, kv } = backend([
      { match: ['account', 'positions'], out: [{ instId: 'BTC-USDT-SWAP', pos: '-13' }] },
      { match: ['algo', 'place'], out: [{ algoId: 'AG7', sCode: '0' }] },
    ], { calls });
    const r = await b.placeStop('BTCUSDT', 'short', '82000', 'tgd-abc123-s2');
    const args = calls.find((c) => c.includes('place') && c.includes('algo'))!;
    // 独立挂的腿带得上客户端 id:CLI 的 --clOrdId → OKX 的 algoClOrdId(review #4)。
    expect(args[args.indexOf('--clOrdId') + 1]).toBe(toClOrdId('tgd-abc123-s2'));
    expect(args[args.indexOf('--sz') + 1]).toBe('13');
    expect(args[args.indexOf('--side') + 1]).toBe('buy'); // 空头的保护腿是买
    expect(args).toContain('--reduceOnly');
    expect(args).toContain('--cxlOnClosePos');
    expect(args).toContain('--slOrdPx=-1');
    expect(r.outcome).toBe('submitted');
    expect(kv.get(`okx.algo.v1:${toClOrdId('tgd-abc123-s2')}`)).toBe('AG7');
  });

  it('没有持仓时直接失败,不会挂一张裸的反向单', async () => {
    const { b } = backend([{ match: ['account', 'positions'], out: [{ instId: 'BTC-USDT-SWAP', pos: '0' }] }]);
    const r = await b.placeStop('BTCUSDT', 'long', '78000', 'tgd-abc123-s1');
    expect(r.outcome).toBe('failed');
    expect(r.error).toMatch(/没有持仓/);
  });

  it('placeTakeProfit 走 tpTriggerPx', async () => {
    const calls: string[][] = [];
    const { b } = backend([
      { match: ['account', 'positions'], out: [{ instId: 'BTC-USDT-SWAP', pos: '13' }] },
      { match: ['algo', 'place'], out: [{ algoId: 'AG8', sCode: '0' }] },
    ], { calls });
    await b.placeTakeProfit('BTCUSDT', 'long', '90000', 'tgd-abc123-t1');
    const args = calls.find((c) => c.includes('algo') && c.includes('place'))!;
    expect(args[args.indexOf('--tpTriggerPx') + 1]).toBe('90000');
    expect(args).not.toContain('--slTriggerPx');
  });

  it.each(['long', 'short'] as const)('首档部分止盈 %s:币数量转张数,保持 reduceOnly 与余仓止损独立', async side => {
    const { b, calls } = backend([
      { match: ['account', 'positions'], out: [{ instId: 'BTC-USDT-SWAP', pos: side === 'long' ? '13' : '-13', mgnMode: 'isolated' }] },
      { match: ['algo', 'place'], out: [{ algoId: 'partial1', sCode: '0' }] },
    ]);
    const r = await b.placePartialTakeProfit('BTCUSDT', side, side === 'long' ? '90000' : '70000', '0.039', 'tgd-partial-t1');
    expect(r.outcome).toBe('submitted');
    const args = calls.find(c => c.includes('place'))!;
    expect(args[args.indexOf('--sz') + 1]).toBe('3.9');
    expect(args[args.indexOf('--side') + 1]).toBe(side === 'long' ? 'sell' : 'buy');
    expect(args).toEqual(expect.arrayContaining(['--reduceOnly', '--cxlOnClosePos', '--tpOrdPx=-1', 'isolated']));
  });

  it('部分止盈数量超过当前仓位时拒绝,不放大全平', async () => {
    const { b, calls } = backend([{ match: ['account', 'positions'], out: [{ instId: 'BTC-USDT-SWAP', pos: '1' }] }]);
    expect((await b.placePartialTakeProfit('BTCUSDT', 'long', '90000', '0.039', 'tgd-partial-t1')).outcome).toBe('failed');
    expect(calls.some(c => c.includes('place'))).toBe(false);
  });

  it('现货部分止盈只卖指定币数量,不会取全余额', async () => {
    const { b, calls } = backend([
      { match: ['account', 'balance'], out: [{ details: [{ ccy: 'BTC', availBal: '0.13', cashBal: '0.13' }] }] },
      { match: ['spot', 'algo', 'place'], out: [{ algoId: 'spot-partial', sCode: '0' }] },
    ]);
    expect((await b.placePartialTakeProfit('BTCUSDT', 'long', '90000', '0.039', 'tgd-partial-t1', 'spot')).outcome).toBe('submitted');
    const args = calls.find(c => c.includes('place'))!;
    expect(args[args.indexOf('--sz') + 1]).toBe('0.039');
    expect(args).toEqual(expect.arrayContaining(['spot', 'cash', 'sell']));
  });
});

describe('算法单自验证', () => {
  const algos: Rule[] = [
    { match: ['algo', 'orders', 'conditional'], out: [{ algoId: 'AG1', instId: 'BTC-USDT-SWAP', ordType: 'conditional' }] },
    { match: ['algo', 'orders', 'oco'], out: [{ algoId: 'AG2', instId: 'BTC-USDT-SWAP', ordType: 'oco' }] },
  ];

  it('KV 里没有映射 → null(查不到,不是「没挂」)', async () => {
    const { b } = backend(algos);
    expect(await b.algoOrderExists('BTCUSDT', 'tgd-abc123-s1')).toBeNull();
  });

  it('有映射且列表里在 → true;不在 → false', async () => {
    const { b, kv } = backend(algos);
    kv.set(`okx.algo.v1:${toClOrdId('tgd-abc123-s1')}`, 'AG1');
    kv.set(`okx.algo.v1:${toClOrdId('tgd-abc123-s2')}`, 'AGX');
    expect(await b.algoOrderExists('BTCUSDT', 'tgd-abc123-s1')).toBe(true);
    expect(await b.algoOrderExists('BTCUSDT', 'tgd-abc123-s2')).toBe(false);
  });

  it('列表查失败 → null,不是空数组', async () => {
    const { b, kv } = backend([{ match: ['algo', 'orders', 'conditional'], fail: { code: 1, stderr: 'boom' } }]);
    kv.set(`okx.algo.v1:${toClOrdId('tgd-abc123-s1')}`, 'AG1');
    expect(await b.algoOrderExists('BTCUSDT', 'tgd-abc123-s1')).toBeNull();
    expect(await b.listAlgoOrders('BTCUSDT')).toBeNull();
  });

  it('listAlgoOrders 合并两种 ordType,KV 反查不到就用 algoId', async () => {
    const { b, kv } = backend(algos);
    kv.set('okx.algo.rev.v1:AG1', 'tgdabc123s1');
    expect(await b.listAlgoOrders('BTCUSDT')).toEqual([
      { client_algo_id: 'tgdabc123s1', algo_id: 'AG1' },
      { client_algo_id: 'AG2', algo_id: 'AG2' },
    ]);
  });

  it('cancelAlgoOrder 没有 algoId 映射时不瞎撤', async () => {
    const { b } = backend([]);
    expect(await b.cancelAlgoOrder('BTCUSDT', 'tgd-abc123-s1')).toMatchObject({ ok: false });
  });
});

describe('getOrder:状态映射与 51603', () => {
  it.each([
    ['live', 'NEW'],
    ['partially_filled', 'PARTIALLY_FILLED'],
    ['filled', 'FILLED'],
    ['canceled', 'CANCELED'],
    ['mmp_canceled', 'CANCELED'],
  ])('%s → %s', async (state, want) => {
    const { b } = backend([{ match: ['swap', 'get'], out: [{ state, avgPx: '80000', accFillSz: '13' }] }]);
    const r = await b.getOrder('BTCUSDT', 'tgd-abc123-e1', true);
    expect(r).toMatchObject({ status: want, avg_price: '80000', executed_qty: '0.13' });
  });

  it('51603(订单不存在)→ null', async () => {
    const { b } = backend([{ match: ['swap', 'get'], out: { code: '51603', msg: 'Order does not exist' } }]);
    expect(await b.getOrder('BTCUSDT', 'tgd-abc123-e1', true)).toBeNull();
  });

  it('其它错误往上抛(读不到 ≠ 没有)', async () => {
    const { b } = backend([{ match: ['swap', 'get'], out: { code: '50111', msg: 'Invalid key' } }]);
    await expect(b.getOrder('BTCUSDT', 'tgd-abc123-e1', true)).rejects.toThrow(/50111/);
  });

  it('30 秒缓存;fresh=true 强制重读', async () => {
    const calls: string[][] = [];
    const { b } = backend([{ match: ['swap', 'get'], out: [{ state: 'filled', avgPx: '1', accFillSz: '1' }] }], { calls });
    await b.getOrder('BTCUSDT', 'tgd-abc123-e1');
    await b.getOrder('BTCUSDT', 'tgd-abc123-e1');
    expect(calls).toHaveLength(1);
    await b.getOrder('BTCUSDT', 'tgd-abc123-e1', true);
    expect(calls).toHaveLength(2);
  });

  it('查单用的 clOrdId 与下单时同一套正向算法(不反解)', async () => {
    const calls: string[][] = [];
    const { b } = backend([{ match: ['swap', 'get'], out: [{ state: 'live' }] }], { calls });
    await b.getOrder('BTCUSDT', 'tgd-abc123-e1', true);
    expect(calls[0]).toContain('tgdabc123e1');
    expect(calls[0]).toContain('BTC-USDT-SWAP');
  });
});

describe('closePosition / cancelOrder 的「已经不在了」口径', () => {
  const pos = (extra: Record<string, unknown> = {}): Rule => ({ match: ['account', 'positions'], out: [{ instId: 'BTC-USDT-SWAP', pos: '-13', ...extra }] });

  it.each(['51023', '51169'])('无持仓码 %s → closed:true', async (code) => {
    const { b } = backend([pos(), { match: ['swap', 'close'], out: { code, msg: 'position does not exist' } }]);
    expect(await b.closePosition('BTCUSDT', 'tgd-abc123-x1')).toMatchObject({ closed: true, error: null });
  });

  // review #1:51024 是「账户被限制」,仓位很可能还在 —— 报成已平会让 runtime 直接结束线程。
  it('51024(账户受限)不算已平,原始错误必须留着', async () => {
    const { b } = backend([pos(), { match: ['swap', 'close'], out: { code: '51024', msg: 'account restricted' } }]);
    const r = await b.closePosition('BTCUSDT', 'tgd-abc123-x1');
    expect(r.closed).toBe(false);
    expect(r.error).toMatch(/51024/);
    expect(r.ambiguous).toBeUndefined();
  });

  it('别的错误不算已平', async () => {
    const { b } = backend([pos(), { match: ['swap', 'close'], out: { code: '51000', msg: 'bad param' } }]);
    expect(await b.closePosition('BTCUSDT', 'tgd-abc123-x1')).toMatchObject({ closed: false });
  });

  // review #7:命令已经发出去了,20 秒没回来 —— 这是未知,不是失败。
  it('平仓写超时 → ambiguous:true(调用方保持 unknown)', async () => {
    const { b } = backend([pos(), { match: ['swap', 'close'], timeout: true }]);
    const r = await b.closePosition('BTCUSDT', 'tgd-abc123-x1');
    expect(r).toMatchObject({ closed: false, ambiguous: true });
    expect(r.error).toMatch(/超时/);
  });

  it('50004 同样是 ambiguous', async () => {
    const { b } = backend([pos(), { match: ['swap', 'close'], out: { code: '50004', msg: 'endpoint request timeout' } }]);
    expect(await b.closePosition('BTCUSDT', 'tgd-abc123-x1')).toMatchObject({ closed: false, ambiguous: true });
  });

  it('close 带上 autoCxl,mgnMode 取仓位实际的模式', async () => {
    const calls: string[][] = [];
    const { b } = backend([pos({ mgnMode: 'isolated' }), { match: ['swap', 'close'], out: [{ instId: 'BTC-USDT-SWAP', posSide: 'net' }] }], { calls });
    await b.closePosition('BTCUSDT', 'tgd-abc123-x1');
    const args = calls.find((c) => c.includes('close'))!;
    expect(args).toContain('--autoCxl');
    // review #6:仓位是 isolated 开的,就得按 isolated 平,不能用实例字段里的 cross。
    expect(args[args.indexOf('--mgnMode') + 1]).toBe('isolated');
  });

  it('cancelOrder:51400/51401 当撤成功', async () => {
    const { b } = backend([{ match: ['swap', 'cancel'], not: ['algo'], out: { code: '51401', msg: 'already canceled' } }]);
    expect(await b.cancelOrder('BTCUSDT', 'tgd-abc123-e1')).toMatchObject({ ok: true });
  });

  it('cancelOrder:普通单撤不掉时按 KV 当算法单再撤一次', async () => {
    const calls: string[][] = [];
    const { b, kv } = backend([
      { match: ['swap', 'cancel'], not: ['algo'], out: { code: '51002', msg: 'not a normal order' } },
      { match: ['algo', 'cancel'], out: [{ algoId: 'AG1', sCode: '0' }] },
    ], { calls });
    kv.set(`okx.algo.v1:${toClOrdId('tgd-abc123-s1')}`, 'AG1');
    expect(await b.cancelOrder('BTCUSDT', 'tgd-abc123-s1')).toMatchObject({ ok: true });
    expect(calls.some((c) => c.includes('AG1'))).toBe(true);
  });
});

describe('结算:窗口过滤、手续费保号、资金费求和、覆盖证明', () => {
  const start = 1_700_000_000_000;
  const end = start + 3_600_000;
  const fills = [
    { instId: 'BTC-USDT-SWAP', ts: String(start + 1000), side: 'buy', fillPx: '80000', fillSz: '13', fillPnl: '0', fee: '-0.42', posSide: 'net' },
    { instId: 'BTC-USDT-SWAP', ts: String(start + 2000), side: 'sell', fillPx: '81000', fillSz: '13', fillPnl: '13.0', fee: '-0.43' },
    { instId: 'BTC-USDT-SWAP', ts: String(end + 5000), side: 'sell', fillPx: '82000', fillSz: '13', fillPnl: '99', fee: '-1' },
    { instId: 'ETH-USDT-SWAP', ts: String(start + 1500), side: 'buy', fillPx: '3000', fillSz: '1', fillPnl: '0', fee: '-0.1' },
  ];
  const bills = [
    { instId: 'BTC-USDT-SWAP', type: '8', ts: String(start + 500), pnl: '-0.12' },
    { instId: 'BTC-USDT-SWAP', type: '8', ts: String(start + 1500), pnl: '-0.08' },
    { instId: 'BTC-USDT-SWAP', type: '2', ts: String(start + 1600), pnl: '99' },
    { instId: 'ETH-USDT-SWAP', type: '8', ts: String(start + 1600), pnl: '-5' },
    { instId: 'BTC-USDT-SWAP', type: '8', ts: String(end + 9000), pnl: '-7' },
  ];

  it('只留窗口内、同一合约的成交;张数换币、commission = -fee、side 大写', async () => {
    const { b } = backend([{ match: ['swap', 'fills'], out: fills }, { match: ['account', 'bills'], out: bills }]);
    const s = (await b.settlement('BTCUSDT', start, end))!;
    expect(s.trades).toHaveLength(2);
    expect(s.trades[0]).toMatchObject({ side: 'BUY', price: '80000', qty: '0.13', commission: '0.42', realized_pnl: '0' });
    expect(s.trades[1]!.side).toBe('SELL');
    expect(Number(s.funding)).toBeCloseTo(-0.2, 8);
  });

  // review #12:OKX 的 fee 正数 = maker 返佣。内部算 `realized - commission + funding`,
  // 取绝对值会把「多赚 0.02」记成「少赚 0.02」,净差 0.04。
  it('正的 fee(返佣)→ 负的 commission,不反向记成支出', async () => {
    const maker = [{ instId: 'BTC-USDT-SWAP', ts: String(start + 10), side: 'buy', fillPx: '80000', fillSz: '13', fillPnl: '0', fee: '0.02', tradeId: 'T1' }];
    const { b } = backend([{ match: ['swap', 'fills'], out: maker }, { match: ['account', 'bills'], out: [] }]);
    const s = (await b.settlement('BTCUSDT', start, end))!;
    expect(s.trades[0]!.commission).toBe('-0.02');
  });

  it('同一 tradeId 只算一次', async () => {
    const dup = [
      { instId: 'BTC-USDT-SWAP', ts: String(start + 10), side: 'buy', fillPx: '80000', fillSz: '13', fillPnl: '0', fee: '-0.1', tradeId: 'T1' },
      { instId: 'BTC-USDT-SWAP', ts: String(start + 10), side: 'buy', fillPx: '80000', fillSz: '13', fillPnl: '0', fee: '-0.1', tradeId: 'T1' },
    ];
    const { b } = backend([{ match: ['swap', 'fills'], out: dup }, { match: ['account', 'bills'], out: [] }]);
    expect((await b.settlement('BTCUSDT', start, end))!.trades).toHaveLength(1);
  });

  // review #11:CLI 的 `swap fills` 不透传 begin/end/after,只能拿最新一页。
  // 整页塞满且最旧一条仍晚于窗口起点 = 开仓那笔的手续费已经被挤到上一页了。
  it('fills 整页塞满且没覆盖到窗口起点 → 返回 null(不给一份少算手续费的结算)', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ instId: 'BTC-USDT-SWAP', ts: String(start + 1000 + i), side: 'buy', fillPx: '80000', fillSz: '1', fillPnl: '0', fee: '-0.01', tradeId: `T${i}` }));
    const { b } = backend([{ match: ['swap', 'fills'], out: full }, { match: ['account', 'bills'], out: [] }]);
    expect(await b.settlement('BTCUSDT', start, end)).toBeNull();
  });

  it('整页塞满但最旧一条已经早于窗口起点 → 覆盖成立,照常结算', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ instId: 'BTC-USDT-SWAP', ts: String(start - 5000 + i), side: 'buy', fillPx: '80000', fillSz: '1', fillPnl: '0', fee: '-0.01', tradeId: `T${i}` }));
    const { b } = backend([{ match: ['swap', 'fills'], out: full }, { match: ['account', 'bills'], out: [] }]);
    expect(await b.settlement('BTCUSDT', start, end)).not.toBeNull();
  });

  it('bills 整页塞满且没覆盖起点 → funding:null(不报成 0),成交照给', async () => {
    const fullBills = Array.from({ length: 100 }, (_, i) => ({ instId: 'ETH-USDT-SWAP', type: '8', ts: String(start + 1000 + i), pnl: '-1', billId: `B${i}` }));
    const { b } = backend([{ match: ['swap', 'fills'], out: fills }, { match: ['account', 'bills'], out: fullBills }]);
    const s = (await b.settlement('BTCUSDT', start, end))!;
    expect(s.trades).toHaveLength(2);
    expect(s.funding).toBeNull();
  });

  it('bills 显式要满一页(--limit 100),好让覆盖判断有意义', async () => {
    const calls: string[][] = [];
    const { b } = backend([{ match: ['swap', 'fills'], out: [] }, { match: ['account', 'bills'], out: [] }], { calls });
    await b.settlement('BTCUSDT', start, end);
    const args = calls.find((c) => c.includes('bills'))!;
    expect(args[args.indexOf('--limit') + 1]).toBe('100');
  });

  it('fills 读不到 → 整个 settlement 为 null(调用方不得当成「没有盈亏」)', async () => {
    const { b } = backend([{ match: ['swap', 'fills'], fail: { code: 1, stderr: 'network down' } }]);
    expect(await b.settlement('BTCUSDT', start, end)).toBeNull();
  });

  it('fills 正常但 bills 失败 → funding: null,成交照给', async () => {
    const { b } = backend([{ match: ['swap', 'fills'], out: fills }, { match: ['account', 'bills'], fail: { code: 1, stderr: 'boom' } }]);
    const s = (await b.settlement('BTCUSDT', start, end))!;
    expect(s.trades).toHaveLength(2);
    expect(s.funding).toBeNull();
  });

  it('超过 3 天/7 天的窗口分别带上 --archive', async () => {
    const calls: string[][] = [];
    const { b } = backend([{ match: ['swap', 'fills'], out: [] }, { match: ['account', 'bills'], out: [] }], { calls });
    await b.settlement('BTCUSDT', Date.now() - 10 * 86_400_000, Date.now());
    expect(calls.find((c) => c.includes('fills'))).toContain('--archive');
    expect(calls.find((c) => c.includes('bills'))).toContain('--archive');
  });
});

describe('写操作超时 = ambiguous → unknown', () => {
  it('placeEntry 超时时 outcome 是 unknown,不是 failed', async () => {
    const { b } = backend([{ match: ['swap', 'place'], timeout: true }]);
    const r = await b.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.13', entry: 'market', limit_price: null, client_order_id: 'tgd-abc123-e1' });
    expect(r.outcome).toBe('unknown');
    expect(r.error).toMatch(/超时/);
  });

  it('读操作超时只是失败,不制造歧义', async () => {
    const { b } = backend([{ match: ['swap', 'get'], timeout: true }]);
    await expect(b.getOrder('BTCUSDT', 'tgd-abc123-e1', true)).rejects.toThrow(/超时/);
    expect(b.transportHealth().transport_errors).toBe(1);
  });

  it('spawn 失败是 transport,不是 ambiguous(根本没发出去)', async () => {
    const b = new OkxCliBackend({
      bin: '/nonexistent/okx', profile: null, demo: true, kv: memKv(), log: () => {},
      spawnFn: async () => ({ code: 1, stdout: '', stderr: '', spawnError: 'ENOENT' }),
    });
    const r = await b.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.13', entry: 'market', limit_price: null, client_order_id: 'tgd-abc123-e1' });
    expect(r.outcome).toBe('failed');
  });

  it('数量不足一张时本地就拒,不发请求', async () => {
    const calls: string[][] = [];
    const { b } = backend([], { calls });
    const r = await b.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.00001', entry: 'market', limit_price: null, client_order_id: 'tgd-abc123-e1' });
    expect(r.outcome).toBe('failed');
    expect(r.error).toMatch(/不足一张/);
    expect(calls).toHaveLength(0);
  });
});

describe('错误码解析与状态映射', () => {
  it('extractFailure 认顶层 {code,msg} 与逐单 [{sCode,sMsg}]', () => {
    expect(extractFailure({ code: '51008', msg: 'no money' })).toEqual({ code: '51008', msg: 'no money' });
    expect(extractFailure([{ sCode: '0' }, { sCode: '51000', sMsg: 'bad' }])).toEqual({ code: '51000', msg: 'bad' });
    expect(extractFailure([{ sCode: '0', ordId: 'O1' }])).toBeNull();
    expect(extractFailure({ code: '0', data: [] })).toBeNull();
    expect(extractFailure([['1789840800000', '1']])).toBeNull();
  });

  it('50111/50113 带上「跑 okx config init」的提示', async () => {
    const { b } = backend([{ match: ['account', 'balance'], out: { code: '50111', msg: 'Invalid Api-Key' } }]);
    await expect(b.account()).rejects.toThrow(/config init/);
  });

  it('未知 state 原样大写,不冒充已知状态', () => {
    expect(mapOrderState('unknown_state')).toBe('UNKNOWN_STATE');
  });
});

describe('protectionCapability:只有人工标记过才算 verified', () => {
  it('默认 unverified', () => {
    const { b } = backend([]);
    expect(b.protectionCapability()).toBe('unverified');
  });
  it('KV okx.protection.verified=1 → verified', () => {
    const kv = memKv();
    kv.set('okx.protection.verified', '1');
    const { b } = backend([], { kv });
    expect(b.protectionCapability()).toBe('verified');
  });
});

describe('setMarginType / setLeverage(review #6)', () => {
  it('setMarginType 不发下单请求,只改后续下单的 tdMode', async () => {
    const calls: string[][] = [];
    const { b } = backend([{ match: ['swap', 'place'], out: [{ ordId: 'O1', sCode: '0' }] }, { match: ['swap', 'get'], out: [{ state: 'live' }] }], { calls });
    expect(await b.setMarginType('BTCUSDT', 'isolated')).toMatchObject({ ok: true });
    expect(calls).toHaveLength(0); // 没设过杠杆就没有要重设的东西
    await b.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.13', entry: 'limit', limit_price: '70000', client_order_id: 'tgd-abc123-e1' });
    const args = calls[0]!;
    expect(args[args.indexOf('--tdMode') + 1]).toBe('isolated');
  });

  it('保证金模式按 symbol 存:ETH 设 cross 不会把 BTC 的 isolated 改掉', async () => {
    const calls: string[][] = [];
    const { b } = backend([{ match: ['swap', 'place'], out: [{ ordId: 'O1', sCode: '0' }] }, { match: ['swap', 'get'], out: [{ state: 'live' }] }], { calls });
    await b.setMarginType('BTCUSDT', 'isolated');
    await b.setMarginType('XRPUSDT', 'cross');
    await b.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.13', entry: 'limit', limit_price: '70000', client_order_id: 'tgd-abc123-e1' });
    const btc = calls.find((c) => c.includes('BTC-USDT-SWAP'))!;
    expect(btc[btc.indexOf('--tdMode') + 1]).toBe('isolated');
  });

  it('setLeverage 带 instId/lever/mgnMode', async () => {
    const calls: string[][] = [];
    const { b } = backend([{ match: ['swap', 'leverage'], out: [{ lever: '5' }] }], { calls });
    expect(await b.setLeverage('BTCUSDT', 5)).toMatchObject({ ok: true });
    expect(calls[0]).toEqual(['--profile', 'tg-demo', '--demo', '--json', 'swap', 'leverage', '--instId', 'BTC-USDT-SWAP', '--lever', '5', '--mgnMode', 'cross']);
  });

  // runtime 的顺序是 setLeverage → setMarginType(Binance 口径,不改)。OKX 的杠杆按
  // (instId, mgnMode) 存,所以第一次那下改的是 cross 的杠杆;模式变成 isolated 要重设一次。
  it('先 setLeverage 后 setMarginType(isolated):在新模式下把杠杆重设一次', async () => {
    const calls: string[][] = [];
    const { b } = backend([{ match: ['swap', 'leverage'], out: [{ lever: '5' }] }], { calls });
    await b.setLeverage('BTCUSDT', 5);
    await b.setMarginType('BTCUSDT', 'isolated');
    const levCalls = calls.filter((c) => c.includes('leverage'));
    expect(levCalls).toHaveLength(2);
    expect(levCalls[0]![levCalls[0]!.indexOf('--mgnMode') + 1]).toBe('cross');
    expect(levCalls[1]![levCalls[1]!.indexOf('--mgnMode') + 1]).toBe('isolated');
  });

  it('模式没变(cross)时不白跑一次重设', async () => {
    const calls: string[][] = [];
    const { b } = backend([{ match: ['swap', 'leverage'], out: [{ lever: '5' }] }], { calls });
    await b.setLeverage('BTCUSDT', 5);
    await b.setMarginType('BTCUSDT', 'cross');
    expect(calls.filter((c) => c.includes('leverage'))).toHaveLength(1);
  });
});

describe('ctVal=100 的币(XRP):张数换算不靠浮点', () => {
  it('1234 XRP → 12.3 张,回来还是 1230 XRP(向下取整到 lotSz)', async () => {
    const calls: string[][] = [];
    const { b } = backend([{ match: ['swap', 'place'], out: [{ ordId: 'O1', sCode: '0' }] }, { match: ['swap', 'get'], out: [{ state: 'filled', avgPx: '2', accFillSz: '12.3' }] }], { calls });
    const r = await b.placeEntry({ symbol: 'XRPUSDT', direction: 'long', qty: '1234', entry: 'market', limit_price: null, client_order_id: 'tgd-abc123-e1' });
    const args = calls[0]!;
    expect(args[args.indexOf('--sz') + 1]).toBe('12.3');
    expect(args[args.indexOf('--instId') + 1]).toBe('XRP-USDT-SWAP');
    expect(r.outcome).toBe('filled');
  });
});

describe('profile 发现:解析 okx config show(掩码版),网关不打开凭证文件', () => {
  // review #5:`okx config show --json` 走的是 printJson(readFullConfig()) —— **未掩码**,
  // 会把 api_key/secret_key/passphrase 原样吐出来。只有人类可读的那一份走 maskSecret()。
  const masked = [
    'Config: /Users/x/.okx/config.toml',
    '',
    'default_profile: tg-demo',
    '',
    '[tg-demo]',
    '  api_key:    ****abcd',
    '  demo:       true',
    '  base_url:   (default)',
    '',
    '[live]',
    '  api_key:    ****efgh',
    '  demo:       false',
    '  base_url:   (default)',
    '',
  ].join('\n');

  it('解析出 profile / default_profile / demo,结构里根本没有放 key 的地方', () => {
    const cfg = parseOkxConfigShow(masked);
    expect(cfg.exists).toBe(true);
    expect(cfg.profiles).toEqual(['tg-demo', 'live']);
    expect(cfg.defaultProfile).toBe('tg-demo');
    expect(cfg.demo).toEqual({ 'tg-demo': true, live: false });
    expect(JSON.stringify(cfg)).not.toMatch(/api_key|abcd|efgh/);
  });

  // review #14:`default` 是合法 profile 名,旧解析器把它当容器段跳过了。
  it('名叫 default 的 profile 不被跳过,demo 标志读得到', () => {
    const cfg = parseOkxConfigShow([
      'default_profile: default',
      '[default]',
      '  api_key:    ****zzzz',
      '  demo:       true',
    ].join('\n'));
    expect(cfg.profiles).toEqual(['default']);
    expect(cfg.defaultProfile).toBe('default');
    expect(cfg.demo['default']).toBe(true);
  });

  it('没有 profile 时不抛,exists=false', () => {
    expect(parseOkxConfigShow('Config: /Users/x/.okx/config.toml\n\ndefault_profile: (not set)\n\nNo profiles found.')).toMatchObject({ exists: false, profiles: [], defaultProfile: null });
  });
});

describe('--demo 强制(review #3)', () => {
  it('没有 TG_OKX_LIVE 时,每条命令都带 --demo', async () => {
    const calls: string[][] = [];
    const { b } = backend([{ match: ['account', 'balance'], out: [{ totalEq: '1' }] }, { match: ['swap', 'leverage'], out: [{ lever: '5' }] }], { calls });
    await b.setLeverage('BTCUSDT', 5);
    expect(calls[0]!.slice(0, 4)).toEqual(['--profile', 'tg-demo', '--demo', '--json']);
  });

  it('profile 是模拟盘时,即使 TG_OKX_LIVE=1 也还是 --demo(不替用户升实盘)', async () => {
    const calls: string[][] = [];
    const { b } = backend([{ match: ['swap', 'leverage'], out: [] }], { calls, demo: true, live: true });
    await b.setLeverage('BTCUSDT', 5);
    expect(calls[0]).toContain('--demo');
  });

  it('只有「live=1 且 profile 本身 demo=false」才不带 --demo', async () => {
    const calls: string[][] = [];
    const { b } = backend([{ match: ['swap', 'leverage'], out: [] }], { calls, demo: false, live: true });
    await b.setLeverage('BTCUSDT', 5);
    expect(calls[0]).not.toContain('--demo');
  });
});

describe('50004:请求结果未知,不是拒单(review #2)', () => {
  it('下单收到 50004 → unknown,沿原 CID 对账', async () => {
    const { b } = backend([{ match: ['swap', 'place'], out: { code: '50004', msg: 'endpoint request timeout' } }]);
    const r = await b.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.13', entry: 'market', limit_price: null, client_order_id: 'tgd-abc123-e1' });
    expect(r.outcome).toBe('unknown');
    expect(r.error).toMatch(/50004/);
  });

  it('纯文本里只印出 50004 的分支同样是 unknown', async () => {
    const { b } = backend([{ match: ['swap', 'place'], fail: { code: 1, stderr: 'Error: request failed\nCode: 50004' } }]);
    const r = await b.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.13', entry: 'market', limit_price: null, client_order_id: 'tgd-abc123-e1' });
    expect(r.outcome).toBe('unknown');
  });

  it('读操作收到 50004 不制造歧义(没有写出去的东西要对账)', async () => {
    const { b } = backend([{ match: ['account', 'balance'], out: { code: '50004', msg: 'endpoint request timeout' } }]);
    await expect(b.account()).rejects.toThrow(/50004/);
  });

  it('openWithProtection 撞上 50004 时三条腿都是 unknown,不是 failed', async () => {
    const { b } = backend([{ match: ['swap', 'place'], out: { code: '50004', msg: 'timeout' } }]);
    const r = await b.openWithProtection({
      symbol: 'BTCUSDT', direction: 'long', qty: '0.13', entry: 'market', limit_price: null,
      client_order_id: 'tgd-abc123-e1', stop_price: '78000', stop_client_algo_id: 'tgd-abc123-s1',
      take_profit: { trigger_price: '85000', client_algo_id: 'tgd-abc123-t1' },
    });
    expect(r.entry.outcome).toBe('unknown');
    expect(r.stop.outcome).toBe('unknown');
    expect(r.tp.outcome).toBe('unknown');
  });
});

describe('纯函数:覆盖证明与附带单归属', () => {
  it('coversWindow:没满页 = 覆盖;满页看最旧一条', () => {
    expect(coversWindow([{ ts: '100' }], 100, 50)).toBe(true);
    const full = Array.from({ length: 100 }, (_, i) => ({ ts: String(200 + i) }));
    expect(coversWindow(full, 100, 50)).toBe(false);
    expect(coversWindow(full.concat(), 100, 500)).toBe(true);
  });

  it('attachedAlgoIdOf:attachAlgoOrds → linkedAlgoOrd → null', () => {
    expect(attachedAlgoIdOf({ attachAlgoOrds: [{ attachAlgoId: 'A1' }] })).toBe('A1');
    expect(attachedAlgoIdOf({ attachAlgoOrds: [{ algoId: 'A2' }] })).toBe('A2');
    expect(attachedAlgoIdOf({ linkedAlgoOrd: { algoId: 'A3' } })).toBe('A3');
    expect(attachedAlgoIdOf({ attachAlgoOrds: [] })).toBeNull();
    expect(attachedAlgoIdOf(null)).toBeNull();
    expect(attachedAlgoIdOf({ ordId: 'O1' })).toBeNull();
  });
});

describe('netCheck', () => {
  it('前 n-1 次打公共行情、最后一次打签名 balance,超时算 transport', async () => {
    const calls: string[][] = [];
    const { b } = backend([
      { match: ['market', 'ticker'], out: [{ last: '80000' }] },
      { match: ['account', 'balance'], timeout: true },
    ], { calls });
    const r = await b.netCheck(3);
    expect(r.backend).toBe('okx');
    expect(r.runs).toHaveLength(3);
    expect(r.ok).toBe(2);
    expect(r.transport_errors).toBe(1);
    expect(calls.filter((c) => c.includes('ticker'))).toHaveLength(2);
    expect(r.verdict).toMatch(/连接被掐/);
  });
});

describe('spot CLI:现金交易与市场隔离', () => {
  const entry = { symbol: 'BTCUSDT', market: 'spot' as const, direction: 'long' as const, qty: '0.13', entry: 'market' as const, limit_price: null, client_order_id: 'tgd-spot-e1' };
  const balance = (available: string): Rule => ({ match: ['account', 'balance'], out: [{ details: [{ ccy: 'BTC', availBal: available, frozenBal: '0' }] }] });
  const place: Rule = { match: ['spot', 'place'], not: ['algo'], out: [{ ordId: 'SP1', sCode: '0' }] };
  const get = (attach = false): Rule => ({ match: ['spot', 'get'], out: [{ ordId: 'SP1', state: 'filled', avgPx: '80000', accFillSz: '0.13', ...(attach ? { attachAlgoOrds: [{ attachAlgoId: 'SA1' }] } : {}) }] });

  it('买入使用现金模式和 base 币数量,不进行合约张数换算', async () => {
    const { b, calls } = backend([place, get()]);
    expect(await b.placeEntry(entry)).toMatchObject({ outcome: 'filled', avg_price: '80000' });
    expect(await b.getOrder('BTCUSDT', entry.client_order_id, true, 'spot')).toMatchObject({ executed_qty: '0.13' });
    const args = calls[0]!;
    for (const [flag, value] of [['--instId', 'BTC-USDT'], ['--sz', '0.13'], ['--side', 'buy'], ['--tdMode', 'cash'], ['--tgtCcy', 'base_ccy']]) expect(args[args.indexOf(flag!) + 1]).toBe(value);
    expect(args).not.toContain('--reduceOnly');
  });

  it.each([true, false])('附带保护只认父单归属(found=%s)', async (found) => {
    const { b, kv, calls } = backend([place, get(found), { match: ['spot', 'algo', 'orders'], out: found ? [{ algoId: 'SA1', side: 'sell', slTriggerPx: '78000', cTime: '1' }] : [] }]);
    const result = await b.openWithProtection({ ...entry, stop_price: '78000', stop_client_algo_id: 'tgd-spot-s1' });
    expect(result.entry.outcome).toBe('filled');
    expect(result.stop.outcome).toBe(found ? 'submitted' : 'unknown');
    expect(kv.get('okx.algo.v1:spot:tgdspots1')).toBe(found ? 'SA1' : null);
    expect(kv.get('okx.algo.v1:tgdspots1')).toBeNull();
    expect(calls[0]![calls[0]!.indexOf('--slTriggerPxType') + 1]).toBe('last');
    // 有 attachAlgoId 才去挂单列表核真实 algoId(09-21);没有归属线索时绝不查列表。
    expect(calls.some(c => c.includes('algo') && c.includes('orders'))).toBe(found);
  });

  it('独立止损卖出当前可用余额,不能带 swap 的 reduceOnly/cxlOnClosePos', async () => {
    const { b, calls, kv } = backend([balance('0.130009'), { match: ['spot', 'algo', 'place'], out: [{ algoId: 'SA2', sCode: '0' }] }]);
    expect(await b.placeStop('BTCUSDT', 'long', '78000', 'tgd-spot-s2', 'spot')).toMatchObject({ outcome: 'submitted' });
    const args = calls.find(c => c.includes('place'))!;
    expect(args[args.indexOf('--sz') + 1]).toBe('0.13');
    expect(args[args.indexOf('--side') + 1]).toBe('sell');
    expect(args).not.toContain('--reduceOnly');
    expect(args).not.toContain('--cxlOnClosePos');
    expect(kv.get('okx.algo.v1:spot:tgdspots2')).toBe('SA2');
  });

  it('平仓先撤普通单和保护单再卖出', async () => {
    const { b, calls } = backend([
      { match: ['spot', 'orders'], not: ['algo'], out: [{ instId: 'BTC-USDT', ordId: 'REST1', clOrdId: 'rest1' }] },
      { match: ['spot', 'algo', 'orders', 'conditional'], out: [{ instId: 'BTC-USDT', algoId: 'SA3' }] },
      { match: ['spot', 'cancel'], out: [{ sCode: '0' }] }, balance('0.13'), place, get(),
    ]);
    expect(await b.closePosition('BTCUSDT', 'tgd-spot-x1', 'spot')).toMatchObject({ closed: true });
    const sell = calls.findIndex(c => c.includes('place'));
    const cancels = calls.map((c, i) => c.includes('cancel') ? i : -1).filter(i => i >= 0);
    expect(cancels.length).toBe(2);
    expect(cancels.every(i => i < sell)).toBe(true);
    expect(calls[sell]![calls[sell]!.indexOf('--side') + 1]).toBe('sell');
  });

  it('余额不足 minSz 视为已平仓,不提交零数量单', async () => {
    const { b, calls } = backend([balance('0.00001')]);
    expect(await b.closePosition('BTCUSDT', 'dust', 'spot')).toMatchObject({ closed: true });
    expect(calls.some(c => c.includes('place'))).toBe(false);
  });

  it('结算数量直接是币、返佣保号、无资金费且不查询 bills', async () => {
    const start = Date.now() - 60_000;
    const { b, calls } = backend([{ match: ['spot', 'fills'], out: [{ instId: 'BTC-USDT', ts: String(start + 10), side: 'buy', fillPx: '80000', fillSz: '0.13', fee: '0.02', tradeId: 'ST1' }] }]);
    const s = await b.settlement('BTCUSDT', start, Date.now(), true, 'spot');
    expect(s).toMatchObject({ funding: null, trades: [{ qty: '0.13', commission: '-0.02' }] });
    expect(calls.some(c => c.includes('bills'))).toBe(false);
  });

  it('满页成交无法覆盖开仓时间时不生成不完整结算', async () => {
    const start = Date.now() - 60_000;
    const { b } = backend([{ match: ['spot', 'fills'], out: Array.from({ length: 100 }, (_, i) => ({ instId: 'BTC-USDT', ts: String(start + i + 1), tradeId: `ST${i}`, side: 'buy', fillPx: '80000', fillSz: '0.1', fee: '-0.01' })) }]);
    expect(await b.settlement('BTCUSDT', start, Date.now(), true, 'spot')).toBeNull();
  });

  it('简单模式仅开放现货,永续在本地拒绝且不 spawn 下单', async () => {
    const { b, calls } = backend([{ match: ['account', 'config'], out: [{ acctLv: '1', posMode: 'net_mode' }] }, place, get()]);
    await b.start();
    expect(b.marketsSupported()).toEqual(['spot']);
    const result = await b.placeEntry({ ...entry, market: 'perp' });
    expect(result).toMatchObject({ outcome: 'failed', error: 'perp_unavailable_account_mode' });
    expect(calls.some(c => c.includes('swap'))).toBe(false);
    expect((await b.placeEntry(entry)).outcome).toBe('filled');
  });

  it('spot 算法单查询失败必须让整个账户快照失败', async () => {
    const { b } = backend([
      balance('0'), { match: ['account', 'positions'], out: [] }, { match: ['swap', 'orders'], out: [] },
      { match: ['spot', 'algo', 'orders', 'oco'], fail: { code: 1, stderr: 'spot snapshot failure' } },
    ]);
    await expect(b.account()).rejects.toThrow(/spot snapshot failure/);
  });
});


describe('spot account holdings', () => {
  it('available + frozen 生成一倍现货多仓,近期成交提供成本,小额 dust 不生成仓位', async () => {
    const { b } = backend([
      { match: ['account', 'balance'], out: [{ details: [{ ccy: 'USDT', eq: '1000', availBal: '900' }, { ccy: 'BTC', availBal: '0.1', frozenBal: '0.03' }] }] },
      { match: ['account', 'positions'], out: [] }, { match: ['swap', 'orders'], out: [] },
      { match: ['spot', 'fills'], out: [{ instId: 'BTC-USDT', ts: String(Date.now() - 1000), side: 'buy', fillPx: '80000', fillSz: '0.13', fee: '-1', tradeId: 'cost1' }] },
    ]);
    const mark = vi.spyOn(b, 'markPrice').mockResolvedValue('81000');
    try {
      const a = await b.account();
      expect(a.positions).toMatchObject([{ market: 'spot', symbol: 'BTCUSDT', side: 'long', qty: '0.13', leverage: 1, entry_price: '80000', mark_price: '81000', unrealized_pnl: '130' }]);
      expect(await b.spotHoldings()).toMatchObject([{ ccy: 'BTC', total: '0.13', available: '0.1', usdt_value: '10530' }]);
      expect(mark).toHaveBeenCalledWith('BTCUSDT', 'spot');
    } finally { mark.mockRestore(); }
  });
});

describe('spot protective order normalization', () => {
  it('spot conditional sell 识别为 STOP_MARKET,同币 perp 不能借用现货止损', async () => {
    const { b } = backend([
      { match: ['account', 'balance'], out: [{ details: [{ ccy: 'USDT', eq: '1000', availBal: '900' }] }] },
      { match: ['account', 'positions'], out: [] }, { match: ['swap', 'orders'], out: [] },
      { match: ['spot', 'algo', 'orders', 'conditional'], out: [{ instId: 'BTC-USDT', algoId: 'SPOTSL', ordType: 'conditional', side: 'sell', sz: '0.13', slTriggerPx: '78000', state: 'live' }] },
    ]);
    const a = await b.account();
    expect(a.open_orders).toMatchObject([{ market: 'spot', type: 'STOP_MARKET', side: 'SELL', reduce_only: true }]);
    const t = { symbol: 'BTCUSDT', market: 'spot', side: 'long', qty: '0.13', stop_price: '78000', protection_client_order_ids: [] };
    expect(hasLiveStop(t as never, a.open_orders)).toBe(true);
    expect(hasLiveStop({ ...t, market: 'perp' } as never, a.open_orders)).toBe(false);
  });
});


describe('spot settlement historical coverage', () => {
  it('超过3天不能用忽略archive的CLI最新一页冒充完整历史', async () => {
    const { b } = backend([{ match: ['spot', 'fills'], out: [] }]);
    expect(await b.settlement('BTCUSDT', Date.now() - 4 * 86400000, Date.now(), true, 'spot')).toBeNull();
  });
});

describe('spot stop quantity coverage', () => {
  it('现货条件单必须覆盖整条线程数量,自有CID也不能把不足额止损当完整保护', () => {
    const thread = { symbol: 'BTCUSDT', market: 'spot', side: 'long', qty: '0.13', stop_price: '78000', protection_client_order_ids: ['owned-stop'] };
    const order = { symbol: 'BTCUSDT', market: 'spot', client_order_id: 'owned-stop', type: 'STOP_MARKET', side: 'SELL', qty: '0.12', price: null, stop_price: '78000', reduce_only: true, status: 'NEW' };
    expect(hasLiveStop(thread as never, [order] as never)).toBe(false);
    expect(hasLiveStop(thread as never, [{ ...order, qty: '0.13' }] as never)).toBe(true);
  });
});
