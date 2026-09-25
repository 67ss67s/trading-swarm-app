import { describe, it, expect } from "vitest";
import {
  closedAt,
  forward,
  featureRows,
  replayHumans,
  normalizeSignals,
  settleLeg,
  snapshot,
  rsi,
  HOUR,
  type BridgeSignal,
  type RawMessage,
  type Leg,
} from "./trader-study.js";
import { simulateOutcome } from "./outcome.js";
import { TRADER_SIGNAL_REGISTRY } from "./trader-signals.js";
import type { Kline } from "./types.js";
const bar = (
  i: number,
  o = 100,
  h = 102,
  l = 98,
  c = 100,
  step = HOUR,
): Kline => ({
  open_time: i * step,
  close_time: (i + 1) * step - 1,
  open: String(o),
  high: String(h),
  low: String(l),
  close: String(c),
  volume: "10",
});
const leg: Leg = {
  entry: "limit",
  price: 100,
  stop: 95,
  targets: [{ price: 105, weight: 1 }],
  break_even: false,
};
const raw: RawMessage = {
  id: 9,
  source_message_id: "x",
  raw_text: "BTC 方向：做多 入场100 止损95",
  received_at: "2026-07-01 00:00:00.000000",
  trader: "舒琴",
};
const signal: BridgeSignal = {
  id: 1,
  symbol: "BTCUSDT",
  side: "long",
  entry: '{"type":"limit","price":100}',
  stop_loss: '{"price":95}',
  take_profit: '[{"price":105}]',
  metadata: '{"action_type":"open","candidate_id":"x"}',
  raw_payload: "{}",
  raw_text: raw.raw_text,
  received_at: raw.received_at,
};
describe("交易员特征时间与语料审计", () => {
  it("特征只看已收盘；未来极值不能进入均线、ATR或摆动点", () => {
    const h = Array.from({ length: 260 }, (_, i) => bar(i));
    const t = 260 * HOUR - 1;
    const data = {
      bars: {
        "1h": h,
        "15m": [bar(1039, 100, 102, 98, 100, HOUR / 4)],
        "4h": h,
        "1d": [],
      },
      funding: [{ at: t + 1, rate: "0.1" }],
      tick: 0.1,
    };
    const a = snapshot(data, t, 101);
    expect(a?.level_values.sma200).toBe("100");
    expect(a?.funding_rate).toBeNull();
    data.bars["1h"].push(bar(260, 10000, 11000, 9000, 10000));
    expect(snapshot(data, t, 101)).toEqual(a);
  });
  it("200均线暖身不足为null，RSI无波动=50", () => {
    expect(rsi(Array.from({ length: 15 }, (_, i) => bar(i)))).toBe(50);
    expect(rsi([bar(0)])).toBeNull();
    expect(closedAt([bar(0), bar(1)], HOUR - 1)).toHaveLength(1);
  });
  it("前瞻窗必须完整连续，发布根不能成交", () => {
    const bs = Array.from({ length: 25 }, (_, i) => bar(i));
    expect(forward(bs, 1, 24)[0]?.open_time).toBe(HOUR);
    expect(
      forward(
        bs.filter((_, i) => i !== 4),
        1,
        24,
      ),
    ).toEqual([]);
    expect(forward(bs, 2 * HOUR, 24)).toEqual([]);
  });
  it("回连原文、原文市价覆盖bridge，时区不依赖进程TZ", () => {
    const rows = normalizeSignals(
      [{ ...raw, raw_text: "BTC 100市价直接做多 再挂98 止损95" }],
      [{ ...signal, entry: '{"type":"zone","prices":[100,98]}' }],
    );
    expect(rows[0]).toMatchObject({
      raw_id: 9,
      market_first: true,
      levels: [100, 98],
      at: Date.parse("2026-07-01T00:00:00Z"),
    });
  });
  it("北京时间原发布时间与接收时间分别保留、延迟转发标记", () => {
    const rows = normalizeSignals(
      [{ ...raw, raw_text: "买了100 BTC\n📅 2026-06-01 08:00:00 (Beijing)" }],
      [signal],
    );
    expect(rows[0]?.at).toBe(Date.parse("2026-06-01T00:00:00Z"));
    expect(rows[0]?.flags).toContain("delayed_forward");
    expect(rows[0]?.market_first).toBe(true);
  });
  it("相同计划24h内去重；复盘不冒充新开单", () => {
    const x = {
      ...raw,
      id: 10,
      source_message_id: "y",
      received_at: "2026-07-01 00:01:00",
    };
    const rows = normalizeSignals(
      [raw, x],
      [
        signal,
        {
          ...signal,
          id: 2,
          metadata: '{"action_type":"open","candidate_id":"y"}',
        },
      ],
    );
    expect(rows[1]?.excluded).toBe("duplicate_plan_24h");
    expect(
      normalizeSignals(
        [{ ...raw, raw_text: "恭喜止盈利润！ Captain Hook BTC 做多100" }],
        [signal],
      )[0]?.excluded,
    ).toBe("retrospective_repost");
  });
  it("原文首档70%覆盖bridge等分，直接多属于市价", () => {
    const text =
      "BTC 做多\n78400附近直接多 再挂77000\n第一止盈80000 止盈70%仓位移动保本损\n第二止盈81000\n第三止盈82000";
    const p = normalizeSignals(
      [{ ...raw, raw_text: text }],
      [
        {
          ...signal,
          take_profit:
            '[{"price":80000,"size_pct":0.3333},{"price":81000,"size_pct":0.3333},{"price":82000,"size_pct":0.3333}]',
        },
      ],
    )[0]!;
    expect(p.targets.map((t) => t.weight)).toEqual([
      0.7, 0.15000000000000002, 0.15000000000000002,
    ]);
    expect(p.market_first).toBe(true);
  });
  it("开头ETH做多的已止盈复盘仍排除；未建模提前失效条件排除", () => {
    expect(
      normalizeSignals(
        [{ ...raw, raw_text: "ETH做多现价止盈50%仓位利润！汇报利润" }],
        [signal],
      )[0]?.excluded,
    ).toBe("retrospective_repost");
    expect(
      normalizeSignals(
        [{ ...raw, raw_text: "不能提前涨到110，否则失效\nBTC 挂单做多100" }],
        [signal],
      )[0]?.excluded,
    ).toBe("unmodeled_conditional_invalidation");
  });
  it("晚到转发不占及时信号的去重键", () => {
    const a = {
      ...raw,
      raw_text: "BTC 100做多 📅 2026-06-01 08:00:00 (Beijing)",
      received_at: "2026-06-01 00:06:00",
    };
    const b = {
      ...raw,
      id: 10,
      source_message_id: "y",
      received_at: "2026-06-01 00:01:00",
    };
    const xs = normalizeSignals(
      [a, b],
      [
        signal,
        {
          ...signal,
          id: 2,
          metadata: '{"action_type":"open","candidate_id":"y"}',
        },
      ],
    );
    expect(xs[0]?.excluded).toBe("delayed_forward");
    expect(xs[1]?.excluded).toBeNull();
  });
  it("调用整条特征管线时，下一根开盘不能改变发布时特征", () => {
    const at = 260 * HOUR - 1,
      p = { ...normalizeSignals([raw], [signal])[0]!, at, market_first: true };
    const h = Array.from({ length: 260 }, (_, i) => bar(i));
    const quarters = Array.from({ length: 1200 }, (_, i) =>
      bar(i, 100, 102, 98, 100, HOUR / 4),
    );
    const data = {
      bars: { "1h": h, "15m": quarters, "4h": h, "1d": [] },
      funding: [],
      tick: 0.1,
    };
    const x = featureRows([p], () => data)[0]!;
    data.bars["15m"][1040] = bar(1040, 110, 112, 108, 110, HOUR / 4);
    const y = featureRows([p], () => data)[0]!;
    expect(x.snapshot).toEqual(y.snapshot);
    expect(x.net_direction_component_bps! + x.net_timing_24h_bps!).toBeCloseTo(
      x.net_forward_24h_bps!,
      10,
    );
    expect(x.per_level[0]?.snapshot).toEqual(y.per_level[0]?.snapshot);
  });
  it("缺止损保持null，不捏造默认风险", () =>
    expect(
      normalizeSignals([raw], [{ ...signal, stop_loss: "null" }])[0]?.stop,
    ).toBeNull());
});
describe("同harness保守分档成交", () => {
  it("人肉基线使用已登记trial计数，空样本不伪造可用起点", () => {
    const x = replayHumans([], 0, 180 * 24 * HOUR, { human_shuqin: 7 })[0]!;
    expect(x.stats.trial_count).toBe(7);
    expect(x.common_crypto_stats.trial_count).toBe(7);
    expect(x.available_from).toBeNull();
  });
  it("恰好触价未成交，市场化限价不可计maker", () => {
    expect(
      settleLeg(leg, "long", [bar(0, 102, 103, 100, 102)], 2, 0.1, [])?.filled,
    ).toBe(false);
    expect(
      settleLeg(leg, "long", [bar(0, 99, 103, 98, 100)], 2, 0.1, []),
    ).toMatchObject({ filled: false, rejected: true, net_r: 0 });
  });
  it("单档结果与共享simulateOutcome同成本同结果", () => {
    const bars = [bar(0, 102, 103, 99, 100), bar(1, 101, 106, 100, 105)];
    const x = settleLeg(leg, "long", bars, 2, 0.1, [])!;
    const y = simulateOutcome({
      direction: "long",
      entry: "limit",
      limit_price: 100,
      stop: 95,
      tp: 105,
      bars,
      atr: 2,
      costs: { tick: 0.1 },
    });
    expect(x.net_r).toBeCloseTo(y.net_r!);
    expect(x.gross_r).toBe(y.gross_r);
  });
  it("成交根不兑现TP；同根SL/TP先SL", () => {
    expect(
      settleLeg(leg, "long", [bar(0, 102, 106, 99, 100)], 2, 0.1, [])?.gross_r,
    ).toBe(0);
    expect(
      settleLeg(leg, "long", [bar(0, 102, 106, 94, 100)], 2, 0.1, [])?.gross_r,
    ).toBe(-1);
  });
  it("首档止盈后下一根保本，分母仍为初始5点风险", () => {
    const l = {
      ...leg,
      entry: "market" as const,
      targets: [
        { price: 105, weight: 0.5 },
        { price: 110, weight: 0.5 },
      ],
      break_even: true,
    };
    const x = settleLeg(
      l,
      "long",
      [bar(0, 100, 106, 99, 104), bar(1, 104, 108, 99, 102)],
      2,
      0.1,
      [],
    )!;
    expect(x.gross_r).toBeCloseTo(0.5);
    expect(x.net_r).toBeLessThan(0.5);
  });
  it("无效计划即使未成交也不能贡献零收益有效样本", () => {
    expect(
      settleLeg(
        { ...leg, price: 90, stop: 95, targets: [{ price: 80, weight: 1 }] },
        "long",
        [bar(0)],
        2,
        0.1,
        [],
      ),
    ).toBeNull();
  });
  it("止盈数组顺序不改变组合最终退出时刻", () => {
    const a = {
        ...leg,
        entry: "market" as const,
        price: 67000,
        stop: 69000,
        targets: [
          { price: 65388, weight: 0.5 },
          { price: 66188, weight: 0.5 },
        ],
      },
      bs = [
        bar(0, 67000, 67050, 66800, 66900, HOUR / 4),
        bar(1, 66000, 66050, 65000, 65200, HOUR / 4),
      ];
    const x = settleLeg(a, "short", bs, 100, 0.1, [])!,
      y = settleLeg(
        { ...a, targets: [...a.targets].reverse() },
        "short",
        bs,
        100,
        0.1,
        [],
      )!;
    expect(x.exit_at).toBe(y.exit_at);
    expect(x.exit_at).toBe(HOUR / 2 - 1);
    expect(x.net_r).toBe(y.net_r);
  });
  it("空头与多头镜像、跨结算资金费符号相反", () => {
    const l = { ...leg, entry: "market" as const };
    const short = { ...l, stop: 105, targets: [{ price: 95, weight: 1 }] };
    const bs = [bar(0, 100, 101, 99, 100)];
    expect(
      settleLeg(l, "long", bs, 2, 0.1, [{ at: HOUR / 2, rate: "0.001" }])!
        .funding_r,
    ).toBeCloseTo(
      -settleLeg(short, "short", bs, 2, 0.1, [{ at: HOUR / 2, rate: "0.001" }])!
        .funding_r,
    );
  });
  it("离线族在暖身不足时拒绝，不能产生伪信号", () => {
    for (const fn of Object.values(TRADER_SIGNAL_REGISTRY))
      expect(
        fn({
          bars: {},
          params: {},
          derivatives: null,
          regime: null,
          timeframe: "1h",
          confirmation: [],
          state: { armed: false, last_at: -1, compression_bars: 0 },
        }),
      ).toBeNull();
  });
});
