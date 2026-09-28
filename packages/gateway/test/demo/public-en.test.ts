// 英文评审版出口覆盖(TG_PUBLIC_DEMO=1 + TG_PUBLIC_LANG=en):每类替换在英文模式下生效、非英文模式原样返回;
// 以及喂给模型的清单布尔值 yes/no。只测出口投影与提示词拼接,不碰库。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_REGISTRY, CHAT_TOOL_CATALOG } from '../../src/demo/agent-registry.js';
import { STATUS_LABELS, TASK_STATE_LABELS } from '../../src/demo/asp-agent/services/index.js';
import { BOT_ROLES, type BotProfile } from '../../src/demo/bots.js';
import { buildContext } from '../../src/demo/context.js';
import { CALENDAR_2026 } from '../../src/demo/events-calendar.js';
import { ROLE_SPECS } from '../../src/demo/evolution.js';
import { RSS_SOURCES } from '../../src/demo/info.js';
import type { TfFeatures } from '../../src/demo/market.js';
import { flagWords, noWord, yesWord } from '../../src/demo/output-language.js';
import { ASP_PROFILE_EN, englishText, hasCjk, templateOf, translateSegments } from '../../src/demo/public-en.js';
import { TEMPLATE_EN } from '../../src/demo/public-en-templates.js';
import { BOT_EN } from '../../src/demo/public-en-tables.js';
import { publicView, redactPublicText } from '../../src/demo/public-view.js';
import { listPrimitives } from '../../src/demo/research/primitives/index.js';
import { RESEARCH_TOOLS } from '../../src/demo/research/tools.js';
import { scanChecklist } from '../../src/demo/review-metrics.js';
import { CONDITION_LABEL, LADDER, VARIANTS } from '../../src/demo/funnel.js';
import { DEFAULT_PLAYBOOK } from '../../src/demo/workflow.js';
import { HORIZON_LABEL } from '../../src/demo/screener.js';
import { FAMILY_LABEL, STATUS_LABEL } from '../../src/demo/strategies.js';
import { TIER_LABEL, type AccountView, type MarketView } from '../../src/demo/types.js';

const english = (): void => {
  vi.stubEnv('TG_PUBLIC_DEMO', '1');
  vi.stubEnv('TG_PUBLIC_LANG', 'en');
};
const chineseDemo = (): void => {
  vi.stubEnv('TG_PUBLIC_DEMO', '1');
  vi.stubEnv('TG_PUBLIC_LANG', '');
};

afterEach(() => vi.unstubAllEnvs());

const view = <T>(v: T): T => publicView(v) as T;

describe('公网英文模式:常量表出口覆盖', () => {
  const constants: [string, string[]][] = [
    ['FAMILY_LABEL', Object.values(FAMILY_LABEL)],
    ['STATUS_LABEL', Object.values(STATUS_LABEL)],
    ['TIER_LABEL', Object.values(TIER_LABEL)],
    ['HORIZON_LABEL', Object.values(HORIZON_LABEL)],
    ['asp STATUS_LABELS', Object.values(STATUS_LABELS)],
    ['asp TASK_STATE_LABELS', Object.values(TASK_STATE_LABELS)],
    ['CALENDAR_2026', CALENDAR_2026.map((c) => c.title)],
    ['RSS_SOURCES', RSS_SOURCES.map((s) => s.label)],
    ['evolution ROLE_SPECS', Object.values(ROLE_SPECS).map((r) => r.label)],
    ['AGENT_REGISTRY tagline/cadence/nodes', BOT_ROLES.flatMap((r) => [AGENT_REGISTRY[r].tagline, AGENT_REGISTRY[r].loop.cadence, ...AGENT_REGISTRY[r].loop.graph.nodes.map((n) => n.label)])],
    ['CHAT_TOOL_CATALOG summary/doc', Object.values(CHAT_TOOL_CATALOG).flatMap((t) => [t.summary, t.doc])],
    ['默认 playbook', [DEFAULT_PLAYBOOK]],
    ['内置策略名', ['突破-回踩', '多周期对齐', '波动压缩→扩张', '资金费率/OI 极值', '区间均值回归', '中线突破回踩', '长线突破回踩']],
  ];

  it.each(constants)('%s:英文模式下全部换成不含中文的英文', (_name, values) => {
    english();
    const out = view({ values }).values;
    const left = out.filter((v, i) => hasCjk(v) || (hasCjk(values[i]!) && v === values[i]));
    expect(left).toEqual([]);
  });

  it.each(constants)('%s:非英文模式原样返回', (_name, values) => {
    chineseDemo();
    expect(view({ values }).values).toEqual(values);
  });

  it('漏斗 /api/funnel:条件名、阶梯/质量变体标签(含 09-27 前的「F + …」旧标签)英文模式下全无中文', () => {
    english();
    const labels = [...Object.values(CONDITION_LABEL), ...LADDER.map((r) => r.label), ...VARIANTS.map((r) => r.label),
      '窗口内没有可用 K 线', '币安', 'OKX 上没有', '币安上没有',
      'F:突破位改用前 20 根(不含当根)', 'F + ATR 门槛 ×0.5', 'F + 距突破位 ≤ 2.0 ATR', 'F + 量比 ≥ 0.8', 'F + 量比只在突破那根查', 'F + 只看 1h(4h 强烈反向才否决)', 'F + 回踩窗口放宽到 12 根', 'F + 窗口 12 根 + 量比查突破那根', 'F + 窗口 12 + 量比突破根 + ATR ×0.5', 'F + 窗口 12 + 量比突破根 + ATR ×0.5 + 只看 1h', '底座:F + 窗口 12 + 量比查突破那根'];
    expect(labels.filter((l) => hasCjk(englishText(l)))).toEqual([]);
  });

  it('研究页 /api/research/primitives 与研究工具说明:英文模式下全无中文,非英文原样', () => {
    const body = { primitives: listPrimitives(), tools: RESEARCH_TOOLS };
    english();
    const collect = (root: unknown): string[] => {
      const out: string[] = [];
      const walk = (v: unknown): void => {
        if (typeof v === 'string') { if (hasCjk(v)) out.push(v); } else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(root);
      return out;
    };
    expect(collect(publicView(body))).toEqual([]);
    chineseDemo();
    const zh = collect(publicView(body));
    expect(zh.length).toBeGreaterThan(100);
    expect(zh).toEqual(collect(JSON.parse(JSON.stringify(body))).filter((x) => zh.includes(x)));
  });

  it('不设 TG_PUBLIC_DEMO 时即使 TG_PUBLIC_LANG=en 也不翻(本机行为不变)', () => {
    vi.stubEnv('TG_PUBLIC_LANG', 'en');
    expect(view({ t: FAMILY_LABEL.mean_reversion }).t).toBe(FAMILY_LABEL.mean_reversion);
  });
});

describe('公网英文模式:对象级覆盖', () => {
  const profile = (role: BotProfile['role']): Record<string, unknown> => ({
    role, name: '用户改过的名字', kind: 'llm_session', description: '用户改过的描述', model_pin: null, capabilities: [],
    memory_scope: { read: ['global'], write: [], note: '用户改过的记忆说明' }, approval_boundary: '用户改过的边界', enabled: true, note: '备注', sort_order: 1,
  });

  it('bot profile 按 role 强制覆盖(库里被编辑过也换),非英文原样', () => {
    english();
    for (const role of BOT_ROLES) {
      const out = view(profile(role)) as Record<string, unknown> & { memory_scope: { note: string | null; read: string[] } };
      expect(out['name']).toBe(BOT_EN[role].name);
      expect(out['description']).toBe(BOT_EN[role].description);
      expect(out['approval_boundary']).toBe(BOT_EN[role].approval_boundary);
      expect(out['note']).toBe(BOT_EN[role].note);
      expect(out.memory_scope.note).toBe(BOT_EN[role].memory_note);
      expect(out.memory_scope.read).toEqual(['global']);
    }
    chineseDemo();
    expect(view(profile('radar'))).toEqual(profile('radar'));
  });

  it('agent 名册卡的 tagline / cadence 与 /api/agents/:role 的 agent_md 换英文', () => {
    english();
    for (const role of BOT_ROLES) {
      const spec = AGENT_REGISTRY[role];
      const card = { role, name: spec.name, callsign: spec.callsign, tagline: '库里的中文口号', loop: { cadence: '中文节奏', graph: spec.loop.graph } };
      const detail = view({ agent: card, agent_md: `# ${spec.name}\n\n## 我是谁\n\n中文全文` });
      expect(detail.agent.tagline).not.toMatch(/[一-鿿]/);
      expect(detail.agent.loop.cadence).not.toMatch(/[一-鿿]/);
      expect(detail.agent.loop.graph.nodes.every((n) => !hasCjk(n.label))).toBe(true);
      expect(detail.agent_md.startsWith('# ')).toBe(true);
      expect(hasCjk(detail.agent_md)).toBe(false);
    }
    chineseDemo();
    const zh = { agent: { role: 'radar', callsign: 'RADAR', tagline: '筛选候选与市场信息', loop: { cadence: '按筛选周期' } }, agent_md: '中文全文' };
    expect(view(zh)).toEqual(zh);
  });

  it('研究策略按 TG_PUBLIC_STRATEGY_EN 覆盖表换 name/description,表外的不动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-en-'));
    const file = join(dir, 'en.json');
    writeFileSync(file, JSON.stringify({ strategies: { rs_a: { name: 'BTC daily MA60 filter', description: 'English description' } } }));
    english();
    vi.stubEnv('TG_PUBLIC_STRATEGY_EN', file);
    const body = { strategies: [{ id: 'rs_a', name: 'BTC 日线 MA60 主导多空', description: '中文说明' }, { id: 'rs_b', name: '别的策略', description: '中文' }], runs: [{ id: 'run1', strategy_id: 'rs_a', strategy_name: 'BTC 日线 MA60 主导多空' }] };
    const out = view(body);
    expect(out.strategies[0]).toEqual({ id: 'rs_a', name: 'BTC daily MA60 filter', description: 'English description' });
    expect(out.strategies[1]).toEqual(body.strategies[1]);
    expect(out.runs[0]!.strategy_name).toBe('BTC daily MA60 filter');
    chineseDemo();
    vi.stubEnv('TG_PUBLIC_STRATEGY_EN', file);
    expect(view(body)).toEqual(body);
  });
});

describe('公网英文模式:句式模板', () => {
  const cases: [string, string][] = [
    ['周线 筛选:建议观察 SUIUSDT/LINKUSDT(筛了 28 币,9 个失败)', 'Weekly screen: suggest watching SUIUSDT/LINKUSDT (screened 28 symbols, 9 failed)'],
    ['中线(3d) 筛选:没有契合度够高的候选(筛了 1 币)', 'Mid-term (3d) screen: no candidate with a high enough fit (screened 1 symbols)'],
    ['研究记录:8/8 版本 × 10 币:无 setup;8 币失败(机械期望,不是策略成绩);无晋升', 'Research log: 8/8 versions × 10 symbols: no setup; 8 symbols failed (mechanical expectancy, not strategy performance); no promotion'],
    ['过去 24h:5 次角色任务,¥0.000;4 条待阅;风控无告警;无平仓;总敞口 0.00×(ok)', 'Last 24h: 5 role tasks, ¥0.000; 4 pending review; no risk alerts; no closed trades; gross exposure 0.00× (ok)'],
    ['短线(12h):筛了 4 个币,取契合度前 4 个。应用只改 watchlist,不动风险/杠杆/执行。', 'Short-term (12h): screened 4 symbols, took the top 4 by fit. Applying only changes the watchlist; risk, leverage and execution are untouched.'],
    ['OKX 永续,24h 成交额第 12 / 653', 'OKX perp, 24h volume rank 12 / 653'],
    ['OKX 现货,24h 成交额第 134 / 653', 'OKX spot, 24h volume rank 134 / 653'],
    ['契合 0.63(2/4 条通过,1 条差一点)', 'Fit 0.63 (2/4 conditions passed, 1 near miss)'],
    ['模型总结失败(regime must be one of trend_up|trend_down|range|volatile|unclear; bias must be long|short|neutral),以下只有数值。', 'Model summary unavailable for this run.'],
    ['BTC 83,917, -0.67% 24h; taker ratio 0.8446 => mild sell-side flow [数据]', 'BTC 83,917, -0.67% 24h; taker ratio 0.8446 => mild sell-side flow [data]'],
    ['美国 CPI(9 月数据)', 'US CPI (September data)'],
    ['4 条交接待阅', '4 handoffs to review'],
    ['下次 短线(12h)筛选', 'next Short-term (12h) screen'],
    ['The scan list explicitly sets watch_eligible=否 (both fail) [E9]', 'The scan list explicitly sets watch_eligible=no (both fail) [E9]'],
    ['持仓计划: 主周期ATR/入场价格缺失，无法建立持仓契约', 'Holding plan: primary-timeframe ATR / entry price missing, cannot build the holding contract'],
    ['策略ATR尺度: 1h ATR=1.766428571429，选择1.5倍，实际1.160533764659倍；策略下限1倍;净盈亏比: 净RR=0.433381871133，需≥1.5；往返成本预算12bps',
      'Strategy ATR scale: 1h ATR=1.766428571429, chose 1.5×, actual 1.160533764659×; strategy floor 1×; Net reward/risk: net RR=0.433381871133, needs ≥1.5; round-trip cost budget 12bps'],
    ['/api/v5/market/candles?instId=AVAX-USDT-SWAP&bar=15m&limit=80 -> HTTP 429(限频熔断中,7s 后再试)', '/api/v5/market/candles?instId=AVAX-USDT-SWAP&bar=15m&limit=80 -> HTTP 429 (rate-limit breaker open, retry in 7s)'],
    ['事件窗口内:hack「尸检确认某新闻」(已开始 97 分钟,可信度 reported)', 'In event window: hack "尸检确认某新闻" (started 97 min ago, credibility reported)'],
    ['事件窗口内:vol_spike「AVAXUSDT 成交量异动:15m 量比 2.18,这根 +0.56%(ATR 0.69%)」(已开始 30 分钟,可信度 confirmed)', 'In event window: vol_spike "AVAXUSDT volume spike: 15m vol ratio 2.18, this bar +0.56% (ATR 0.69%)" (started 30 min ago, credibility confirmed)'],
    ['15m 回踩 EMA20 83932(距 0.03%,近 5 根 -0.16%),1h 偏空', '15m retest of EMA20 83932 (0.03% away, last 5 bars -0.16%), 1h bearish'],
    ['周末,传统市场休市,流动性偏低', 'Weekend: traditional markets closed, liquidity is thin'],
    ['美股开盘前 12 分钟,开盘前后波动通常放大', '12 min before the US equity open; volatility usually expands around the open'],
    ['美股刚收盘 5 分钟', 'US equities closed 5 min ago'],
    // 线上漏网:涨幅带正号
    ['15m 回踩 EMA20 92.01(距 0.10%,近 5 根 +0.51%),1h 偏空', '15m retest of EMA20 92.01 (0.10% away, last 5 bars +0.51%), 1h bearish'],
    ['信息员:高波动,偏中性', 'Info scout: high volatility, neutral bias'],
    ['试用中 · 剩 5 小时 · 到期转付费', 'On trial · 5h left · converts to paid at expiry'],
    ['进行中 · 至 09-30 08:00 UTC · 自动续费', 'Active · until 09-30 08:00 UTC · auto-renew'],
    ['已到期', 'Expired'],
    ['投递里挑不出信号对象', 'No signal object found in the delivery'],
    ['tg · 微观告警 自测', 'tg · Micro alerts (self-test)'],
    ['市场情报 自测', 'Market intel (self-test)'],
    ['[perp] SOLUSDT 触发:放量', '[perp] SOLUSDT trigger: volume spike'],
    ['周期 15m;ATR% 0.70%(门槛 0.15% → 达标);1h EMA20>EMA50(偏多)、4h EMA20>EMA50(偏多) → 同向(偏多);上方 20 根高 14.13,距 0.46 ATR(上限 1.5 → 在射程内);最近一根尚未收破突破位 14.12;量比 1.43(门槛 1.00)→ retest_confirmed=no;价在 EMA20 上;RSI14 60.9,ADX14 16.7(无趋势),BB宽 30 分位,squeeze=yes(6 根),距VWAP +1.02 ATR;watch_eligible=yes(1h/4h 同向 且 距突破位 ≤ 1.5 ATR 且 回踩未确认)',
      'Timeframe 15m; ATR% 0.70% (threshold 0.15% → met); 1h EMA20>EMA50 (bullish), 4h EMA20>EMA50 (bullish) → aligned (bullish); 20-bar high above 14.13,distance 0.46 ATR (limit 1.5 → within range); latest bar has not yet closed through breakout level 14.12; vol ratio 1.43 (threshold 1.00)→ retest_confirmed=no; price above EMA20; RSI14 60.9,ADX14 16.7 (no trend), BB width percentile 30, squeeze yes (6 bars), +1.02 ATR from VWAP; watch_eligible=yes(1h/4h aligned and distance to breakout level ≤ 1.5 ATR and retest unconfirmed)'],
    ['batch·均线趋势+波动率目标 ema50_200_vt 永续多 15m · 判断要素', 'batch·MA trend + volatility target ema50_200_vt perp long 15m · judgment factors'],
    ['<untrusted_data>一新钱包提走 HYPE —— Single wallet withdrew HYPE.</untrusted_data>', '<untrusted_data>Single wallet withdrew HYPE.</untrusted_data>'],
    ['<untrusted_data>某条中文新闻</untrusted_data>(已开始 181 分钟,窗口 360 分钟,可信度 reported,来源 panews)', '<untrusted_data>某条中文新闻</untrusted_data> (started 181 min ago, window 360 min, credibility reported, source panews)'],
    ['the scan records 回踩确认 no. [E9]', 'the scan records retest_confirmed=no. [E9]'],
    ['15m 收在 20 根高点上(首轮无前值对比)', '15m closed above the 20-bar high (first pass, no prior value to compare)'],
    // 09-27 扫描清单突破位改量前 20 根(不含当根),标签随之改名
    ['突破位(前 20 根高,不含当根) 63400,距 3.00 ATR(上限 1.5 → 已超出)', 'Breakout level (prior 20-bar high, excluding the current bar) 63400, distance 3.00 ATR (limit 1.5 → exceeded)'],
    ['突破位(前 20 根低,不含当根) 14.13,距 0.46 ATR(上限 1.5 → 在射程内)', 'Breakout level (prior 20-bar low, excluding the current bar) 14.13, distance 0.46 ATR (limit 1.5 → within range)'],
    ['1h 收盘 1.18 跌破前 20 根低点 1.20(量比 1.63)', '1h close 1.18 broke below the prior 20-bar low 1.20 (vol ratio 1.63)'],
    ['trade-gate · Alpha 多策略交易信号', 'trade-gate · Alpha 多策略交易信号'],
    ['重新审核中(资料有改动)', 'Re-review in progress (listing changed)'],
    ['重新审核中(资料有改动),等 OKX 审核结果', 'Re-review in progress (listing changed), awaiting the OKX review result'],
    ['改资料触发重新审批', 'Listing edit triggered a re-review'],
    ['注册 ASP 身份', 'Register the ASP identity'],
    ['已注册 #13866', 'Registered #13866'],
    ['最大回撤 0.9%', 'Max drawdown 0.9%'],
    ['盈亏因子 1.83', 'Profit factor 1.83'],
    ['年化 3.2% vs 持有 -3.4%', 'Annualized 3.2% vs buy-and-hold -3.4%'],
    ['样本外年化 3.9% / 样本内 2.9%', 'Out-of-sample annualized 3.9% / in-sample 2.9%'],
    ['每笔期望 0.13%', 'Expectancy per trade 0.13%'],
    ['日线多头排列(牛),价>EMA20, EMA20>EMA50, EMA50>EMA200;20 日 +5.3%,5 日 +3.6%;波动率处于近 100 日 74% 分位,日 ATR 2.94%,距 EMA200 +18.4%',
      'Daily bullish EMA stack (bull), Price>EMA20, EMA20>EMA50, EMA50>EMA200; 20d +5.3%, 5d +3.6%; volatility at the 74th percentile of the last 100 days, daily ATR 2.94%, +18.4% from EMA200'],
    ['价<EMA20, EMA20<EMA50', 'Price<EMA20, EMA20<EMA50'],
    ['price sits 2.35 ATR above the 20-bar high 1.22 (由 E9.ATR% 得 1.27, 距离 2.99% > 1.5x ATR 上限) [E9]', 'price sits 2.35 ATR above the 20-bar high 1.22 (derived from E9.ATR%: 1.27, distance 2.99% > 1.5x ATR cap) [E9]'],
    ['is 3.00 ATR away, above the 1.5 ATR追单 cap, so watch_eligible=no [E9]', 'is 3.00 ATR away, above the 1.5 ATR chase cap, so watch_eligible=no [E9]'],
    ['研究 0 问 / 0 run / 1 回测 / 0 改进环,完成率 —;过门槛 0,晋升 0', 'Research: 0 questions / 0 runs / 1 backtests / 0 improvement loops, completion —; passed gate 0, promoted 0'],
    ['255 次判断(198 次有动作,账本 198 行),还没结算', '255 judgments (198 with an action, 198 ledger rows), not settled yet'],
    ['OOS 成交不足 30 笔,还差 30;OOS 净期望 CI 下界须 > 0;DSR 须 > 0;非负 regime 还差 2 桶;OOS 净最大回撤须 ≤ 3R', 'OOS trades below 30, 30 short; OOS net-expectancy CI lower bound must be > 0; DSR must be > 0; 2 more non-negative regime buckets needed; OOS net max drawdown must be ≤ 3R'],
    ['在池 0 天,不满最短驻留 3 天,本轮不动', 'in the pool 0 days, below the 3-day minimum stay; unchanged this round'],
    ['没有找到通过门槛的策略。50 个可评估格子;主因分布:样本不足 48、执行不支持 2;另有 0 格不适用、0 格仅研究(3m/5m)',
      'No strategy passed the gate. 50 evaluable cells; main reasons: insufficient sample 48, execution unsupported 2; plus 0 cells not applicable, 0 cells research-only (3m/5m)'],
  ];

  it.each(cases)('%s', (zh, en) => {
    english();
    expect(view({ s: zh }).s).toBe(en);
    chineseDemo();
    expect(view({ s: zh }).s).toBe(zh);
  });

  it('我们自己的 ASP 简介换英文版;回测报告标题按策略英文表换', () => {
    english();
    const zh = 'Trading Swarm 是一个多 agent 交易团队。策略在研究台用全历史回测验证,运行时由代码按策略规则逐根 K 线扫描资产、计算入场 / 止损 / 目标,覆盖现货与永续。信号只描述规则触发的计划,不构成投资建议,请自行控制风险。';
    expect(view({ profileDescription: zh }).profileDescription).toBe(ASP_PROFILE_EN);
    const dir = mkdtempSync(join(tmpdir(), 'tg-en-'));
    const file = join(dir, 'en.json');
    writeFileSync(file, JSON.stringify({ strategies: { rs_a: { name: 'BTC daily MA60 filter' } } }));
    vi.stubEnv('TG_PUBLIC_STRATEGY_EN', file);
    expect(view({ reports: [{ id: 'bt1', title: 'BTC 日线 MA60 主导多空', strategy_id: 'rs_a' }] }).reports[0]!.title).toBe('BTC daily MA60 filter');
    chineseDemo();
    expect(view({ profileDescription: zh }).profileDescription).toBe(zh);
  });

  it('Pine 健康检查 hint 换英文', () => {
    english();
    expect(hasCjk(englishText('Pine 引擎由网关托管自动拉起(packages/pine-engine,AGPL-3.0 独立进程);状态看 GET /api/research/pine/health,TG_PINE_ENGINE=0 会关掉它,崩溃连续重启失败后标记 down,需重启网关'))).toBe(false);
  });

  it('数字模板:数字/币种/标识符换成 {n} 查表,英文按编号放回;切段翻译代码拼的长串', () => {
    english();
    expect(templateOf('试了 353 个版本(本格 3 个、这次研究 221 个)').tmpl).toBe('试了 {0} 个版本(本格 {1} 个、这次研究 {2} 个)');
    expect(view({ s: '市价:下一根 open' }).s).toBe('Market: next bar open');
    expect(view({ s: '没过:expectancy>0' }).s).toBe('Not passed: expectancy>0');
    const long = '每笔首腿保证金 = 100% 可用权益,永续 1 倍杠杆(名义 = 保证金 × 1),逐仓;加仓腿等权分摊首腿额度;吃单 0.05% / 挂单 0.02%';
    const out = view({ s: long }).s;
    expect(hasCjk(out)).toBe(false);
    expect(out).toContain('100%');
    expect(out).toContain('0.05%');
    chineseDemo();
    expect(view({ s: long }).s).toBe(long);
  });

  it('模板表:占位符一一对应、译文无中文', () => {
    const ph = (x: string): string => (x.match(/\{\d+\}/g) ?? []).sort().join(',');
    const bad = Object.entries(TEMPLATE_EN).filter(([k, v]) => hasCjk(v) || ph(k) !== ph(v)).map(([k]) => k);
    expect(bad).toEqual([]);
    expect(Object.keys(TEMPLATE_EN).length).toBeGreaterThan(900);
  });

  it('切段:有一段译不了就整串放弃;字符串里拼的 JSON 值逐个译,译不了的(买方原文)原样保留', () => {
    english();
    const missing: string[] = [];
    expect(translateSegments('市价:下一根 open;完全没见过的一句话', (t) => missing.push(t))).toBeNull();
    expect(missing).toEqual(['完全没见过的一句话']);
    const json = '{"note":"市价:下一根 open","request":"帮我看看这个没见过的想法"}';
    expect(translateSegments(json)).toBe('{"note":"Market: next bar open","request":"帮我看看这个没见过的想法"}');
  });

  it('策略 IR:带 strategy_id 的对象及内嵌 strategy_ir(含 versions[] 继承外层策略)按 ir_label/ir_description 覆盖', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-en-'));
    const file = join(dir, 'en.json');
    writeFileSync(file, JSON.stringify({ strategies: { rs_a: { name: 'BTC MA60', description: 'Strategy desc', ir_label: 'IR label EN', ir_description: 'IR desc EN' } } }));
    english();
    vi.stubEnv('TG_PUBLIC_STRATEGY_EN', file);
    const body = {
      strategy: { id: 'rs_a', name: '中文名', description: '中文说明' },
      versions: [{ strategy_id: 'rs_a', version: 1, note: '初始版本', strategy_ir: { label: '中文 IR', description: '中文 IR 说明', signal: [] } }],
      report: { id: 'bt1', strategy_id: 'rs_a', title: '中文名', description: '中文 IR 说明', strategy_ir: { label: '中文 IR', description: '中文 IR 说明' } },
    };
    const out = view(body);
    expect(out.strategy).toEqual({ id: 'rs_a', name: 'BTC MA60', description: 'Strategy desc' });
    expect(out.versions[0]!.strategy_ir).toEqual({ label: 'IR label EN', description: 'IR desc EN', signal: [] });
    expect(out.versions[0]!.note).toBe('Initial version');
    expect(out.report).toMatchObject({ title: 'BTC MA60', description: 'IR desc EN', strategy_ir: { label: 'IR label EN', description: 'IR desc EN' } });
    chineseDemo();
    vi.stubEnv('TG_PUBLIC_STRATEGY_EN', file);
    expect(view(body)).toEqual(body);
  });

  it('译不全的句子原样返回,不产出中英夹杂', () => {
    english();
    const mixed = '外媒：美国-中国贸易休战延长两个月 [数据]';
    expect(englishText(mixed)).toBe(mixed);
  });

  it('脱敏占位符在英文模式下也是英文', () => {
    english();
    expect(redactPublicText('path /Users/demo/x and 0x' + 'a'.repeat(40))).toBe('path [server path hidden] and [address hidden]');
    chineseDemo();
    expect(redactPublicText('path /Users/demo/x')).toBe('path [服务器路径已隐藏]');
  });
});

describe('喂给模型的清单布尔值(TG_PUBLIC_LANG=en 用 yes/no)', () => {
  const NOW = Date.UTC(2026, 7, 2, 23, 0);
  const feat = (tf: string): TfFeatures => ({
    tf, last_close: 63500, last_open_time: NOW - 900_000, ema20: 63400, ema50: 63200, atr14: 100, swing_high_20: 63600, swing_low_20: 63000,
    swing_high_50: 63800, swing_low_50: 62800, dist_to_high20_pct: 0.16, dist_to_low20_pct: 0.79, vol_ratio_20: 0.8, change_pct_last: 0.1, change_pct_5: 0.4, last_bars: '…',
  } as TfFeatures);

  it('scanChecklist:英文模式 watch_eligible=yes / 回踩确认 no,默认 是/否', () => {
    vi.stubEnv('TG_PUBLIC_LANG', 'en');
    expect(yesWord()).toBe('yes');
    expect(noWord()).toBe('no');
    const en = scanChecklist([feat('15m'), feat('1h'), feat('4h')])!;
    expect(en.text).toContain('watch_eligible=yes');
    expect(en.text).not.toMatch(/[=→ ](是|否)(?![一-鿿])/);
    vi.stubEnv('TG_PUBLIC_LANG', '');
    expect(scanChecklist([feat('15m'), feat('1h'), feat('4h')])!.text).toContain('watch_eligible=是');
  });

  it('系统提示里引用的清单值跟着切换', () => {
    const market = { symbol: 'BTCUSDT', last: '63515.0', mark: '63515.0', funding_rate: '0.0001', next_funding_at: NOW + 3_600_000, open_interest: '1000', as_of: NOW } as unknown as MarketView;
    const account = { equity: '10000', available: '9000', unrealized_pnl: '0', positions: [], open_orders: [], as_of: NOW, backend: 'demo' } as unknown as AccountView;
    const inputs = {
      now: NOW, symbol: 'BTCUSDT', trigger: { kind: 'kline_close' as const, detail: '15m 收盘' }, open_threads: [], account, market,
      features: [feat('15m'), feat('1h'), feat('4h')], oi_change_1h_pct: 0.5,
      ticker24h: { priceChangePercent: '1.2', highPrice: '64000', lowPrice: '62000', quoteVolume: '1000000000' },
      market_state: null, playbook_text: 'pb', last_judgment_summary: null, halted: false, mode: 'scan' as const, thread: null,
    };
    vi.stubEnv('TG_PUBLIC_LANG', 'en');
    const en = buildContext(inputs);
    expect(en.system_text).toContain('watch_eligible=yes');
    expect(en.system_text).toContain('watch_eligible=no');
    expect(en.system_text).not.toContain('watch_eligible=是');
    vi.stubEnv('TG_PUBLIC_LANG', '');
    expect(buildContext(inputs).system_text).toContain('watch_eligible=是');
    expect(flagWords('共识=是')).toBe('共识=是');
  });
});
