#!/usr/bin/env node
// mock/server.mjs — 纯 Node 24 内置模块实现的假网关,给 webui 开发/联调用。
// 不依赖任何 npm 包。实现 docs/demo/README.md §3 描述的全部 HTTP + SSE 接口,
// 用一个会自己演化的循环模拟"判断 episode",数据全部是假的。
//
// 跑法: node mock/server.mjs   (或 `npm run mock --workspace packages/webui`)
// 监听 127.0.0.1:18800,和真实网关同一个端口/口径,webui 的 vite dev 代理直接能用。

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 18800);
const HOST = '127.0.0.1';
const SYMBOL = 'BTCUSDT';
const TIMEFRAME = '1h';
const EPISODE_EVERY_MS = 20_000; // demo 用 20s 代表"1h K 线收盘",真实网关会是 3600000
const MARKET_TICK_MS = 2500;
const STEP_SIZE = 0.001;
const RISK_BUDGET_PCT = 0.5; // %
const START_EQUITY = 10_000;

// ---------------------------------------------------------------------------
// 小工具

function fmt2(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}
function fmtQty(n) {
  return (Math.round(n / STEP_SIZE) * STEP_SIZE).toFixed(3);
}
function floorToStep(n, step) {
  return Math.floor(n / step) * step;
}
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function pick(arr, i) {
  return arr[((i % arr.length) + arr.length) % arr.length];
}
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function id(prefix, n) {
  return `${prefix}-${String(n).padStart(5, '0')}`;
}

let idSeq = { episode: 0, intent: 0, revision: 0 };

// ---------------------------------------------------------------------------
// K 线生成:300 根 1h 蜡烛,最后一根是"正在形成"的当前蜡烛,market tick 会更新它。

function generateInitialKlines(n, endMs) {
  const hourMs = 3_600_000;
  const startOpenTime = endMs - (n - 1) * hourMs;
  let price = 63_000 + (Math.random() - 0.5) * 4000;
  const out = [];
  for (let i = 0; i < n; i++) {
    const openTime = startOpenTime + i * hourMs;
    const open = price;
    const drift = (Math.random() - 0.5) * open * 0.012;
    const close = Math.max(1000, open + drift);
    const high = Math.max(open, close) + Math.random() * open * 0.004;
    const low = Math.max(1, Math.min(open, close) - Math.random() * open * 0.004);
    const volume = 80 + Math.random() * 420;
    out.push({
      open_time: openTime,
      open: fmt2(open),
      high: fmt2(high),
      low: fmt2(low),
      close: fmt2(close),
      volume: volume.toFixed(3),
      close_time: openTime + hourMs - 1,
    });
    price = close;
  }
  return out;
}

const now0 = Date.now();
const klines = generateInitialKlines(300, now0);

function lastKline() {
  return klines[klines.length - 1];
}

function rollKline(nowMs) {
  const last = lastKline();
  const hourMs = 3_600_000;
  klines.push({
    open_time: last.close_time + 1,
    open: last.close,
    high: last.close,
    low: last.close,
    close: last.close,
    volume: '0.000',
    close_time: last.close_time + 1 + hourMs - 1,
  });
  if (klines.length > 500) klines.shift();
}

function updateFormingCandle(price) {
  const last = lastKline();
  last.close = fmt2(price);
  last.high = fmt2(Math.max(Number(last.high), price));
  last.low = fmt2(Math.min(Number(last.low), price));
  last.volume = (Number(last.volume) + Math.random() * 2).toFixed(3);
}

// ---------------------------------------------------------------------------
// 全局状态

const state = {
  lastPrice: Number(lastKline().close),
  positions: [], // { side, qty, entry_price, leverage }
  openOrders: [], // AccountView.open_orders 形状
  realizedEquity: START_EQUITY,
  opensToday: 0,
  fundingRate: 0.0001,
};

let strategy = {
  id: 'strat-btcusdt-1h',
  symbol: SYMBOL,
  timeframe: TIMEFRAME,
  state: 'researching',
  version: 1,
  direction: null,
  thesis: '刚开始跟踪 BTCUSDT,还没有形成明确论点。',
  entry_plan: null,
  invalidation: null,
  invalidation_price: null,
  target_price: null,
  watch_conditions: ['等待突破近期区间,并有放量确认'],
  risk_budget_pct: RISK_BUDGET_PCT.toFixed(2),
  updated_at: now0,
  created_at: now0,
};

const revisions = []; // StrategyRevision[]
const episodes = new Map(); // id -> Episode(full)
const episodeOrder = []; // id[],新的在前
const intents = new Map(); // id -> DemoIntent
const intentOrder = [];
const logs = []; // 新的在前

const loop = {
  running: true,
  paused: false,
  halted: false,
  every_ms: EPISODE_EVERY_MS,
  next_at: Date.now() + EPISODE_EVERY_MS,
  last_episode_id: null,
  brain: 'zai/glm-5.3',
  backend: 'paper',
  auto_approve: false, // 故意默认关着,好让 UI 的"确认/拒绝"按钮有的用
};

let runningEpisodeId = null;

// ---------------------------------------------------------------------------
// SSE

const subscribers = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of subscribers) {
    try {
      res.write(payload);
    } catch {
      subscribers.delete(res);
    }
  }
}

function addLog(level, scope, message, data) {
  const entry = { at: Date.now(), level, scope, message, ...(data !== undefined ? { data } : {}) };
  logs.unshift(entry);
  if (logs.length > 1000) logs.length = 1000;
  broadcast('log', entry);
}

// ---------------------------------------------------------------------------
// 账户视图

function computeAccountView() {
  const mark = state.lastPrice;
  let unrealizedTotal = 0;
  let marginUsed = 0;
  const positions = state.positions.map((p) => {
    const sign = p.side === 'long' ? 1 : -1;
    const upnl = (mark - p.entry_price) * p.qty * sign;
    unrealizedTotal += upnl;
    marginUsed += (mark * p.qty) / p.leverage;
    return {
      symbol: SYMBOL,
      side: p.side,
      qty: fmtQty(p.qty),
      entry_price: fmt2(p.entry_price),
      mark_price: fmt2(mark),
      unrealized_pnl: fmt2(upnl),
      leverage: p.leverage,
    };
  });
  const equity = state.realizedEquity + unrealizedTotal;
  const available = equity - marginUsed;
  return {
    backend: loop.backend,
    equity: fmt2(equity),
    available: fmt2(available),
    unrealized_pnl: fmt2(unrealizedTotal),
    positions,
    open_orders: state.openOrders,
    as_of: Date.now(),
  };
}

function broadcastAccount() {
  broadcast('account.updated', computeAccountView());
}

function nextFundingBoundary(nowMs) {
  const hourMs = 3_600_000;
  const boundary = 8 * hourMs;
  return Math.ceil(nowMs / boundary) * boundary;
}

function computeMarketView() {
  return {
    symbol: SYMBOL,
    last: fmt2(state.lastPrice),
    mark: fmt2(state.lastPrice),
    funding_rate: state.fundingRate.toFixed(6),
    next_funding_at: nextFundingBoundary(Date.now()),
    open_interest: (128_000 + Math.sin(Date.now() / 9_000_000) * 5000).toFixed(3),
    as_of: Date.now(),
    klines_tf: TIMEFRAME,
  };
}

// ---------------------------------------------------------------------------
// 策略变更

function updateStrategy(patch, episodeId, action, reason) {
  const from = strategy.state;
  strategy = { ...strategy, ...patch, updated_at: Date.now() };
  strategy.version += 1;
  const to = strategy.state;
  const rev = {
    strategy_id: strategy.id,
    version: strategy.version,
    at: Date.now(),
    episode_id: episodeId,
    from_state: from,
    to_state: to,
    action,
    reason,
    snapshot: strategy,
  };
  revisions.unshift(rev);
  broadcast('strategy.changed', strategy);
  addLog('info', 'strategy', `策略状态 ${from} → ${to}(${reason})`);
  return { from, to };
}

function resetToResearching(episodeId) {
  updateStrategy(
    {
      direction: null,
      thesis: '上一轮结束了,重新开始观察 BTCUSDT,还没有新论点。',
      entry_plan: null,
      invalidation: null,
      invalidation_price: null,
      target_price: null,
      watch_conditions: ['等待新的结构信号'],
      state: 'researching',
    },
    episodeId,
    'NO_TRADE',
    '新一轮研究开始',
  );
}

// ---------------------------------------------------------------------------
// 持仓操作(paper 撮合,直接按 mark 成交)

function openPosition(direction, qty, entryPrice, leverage = 5) {
  const existing = state.positions.find((p) => p.side === direction);
  if (existing) {
    const totalQty = existing.qty + qty;
    existing.entry_price = (existing.entry_price * existing.qty + entryPrice * qty) / totalQty;
    existing.qty = totalQty;
  } else {
    state.positions.push({ side: direction, qty, entry_price: entryPrice, leverage });
  }
}

function reducePosition(direction, qty) {
  const p = state.positions.find((x) => x.side === direction);
  if (!p) return 0;
  const closedQty = Math.min(qty, p.qty);
  const sign = p.side === 'long' ? 1 : -1;
  const realized = (state.lastPrice - p.entry_price) * closedQty * sign;
  p.qty -= closedQty;
  state.realizedEquity += realized;
  if (p.qty <= 1e-9) {
    state.positions = state.positions.filter((x) => x !== p);
    state.openOrders = [];
  }
  return realized;
}

function attachProtectiveOrders(direction, stopPrice, takeProfitPrice) {
  const closeSide = direction === 'long' ? 'SELL' : 'BUY';
  state.openOrders = state.openOrders.filter((o) => o.type !== 'STOP_MARKET' && o.type !== 'TAKE_PROFIT_MARKET');
  if (stopPrice) {
    state.openOrders.push({
      client_order_id: `tg-demo-${randomUUID().slice(0, 8)}`,
      type: 'STOP_MARKET',
      side: closeSide,
      qty: fmtQty(state.positions.find((p) => p.side === direction)?.qty ?? 0),
      price: null,
      stop_price: fmt2(stopPrice),
      reduce_only: true,
      status: 'NEW',
    });
  }
  if (takeProfitPrice) {
    state.openOrders.push({
      client_order_id: `tg-demo-${randomUUID().slice(0, 8)}`,
      type: 'TAKE_PROFIT_MARKET',
      side: closeSide,
      qty: fmtQty(state.positions.find((p) => p.side === direction)?.qty ?? 0),
      price: null,
      stop_price: fmt2(takeProfitPrice),
      reduce_only: true,
      status: 'NEW',
    });
  }
}

function checkProtectiveTriggers() {
  if (state.positions.length === 0 || state.openOrders.length === 0) return;
  const mark = state.lastPrice;
  for (const order of [...state.openOrders]) {
    const stop = Number(order.stop_price);
    const isStop = order.type === 'STOP_MARKET';
    const p = state.positions.find((x) => (x.side === 'long' ? order.side === 'SELL' : order.side === 'BUY'));
    if (!p) continue;
    const triggered = p.side === 'long' ? (isStop ? mark <= stop : mark >= stop) : isStop ? mark >= stop : mark <= stop;
    if (triggered) {
      const realized = reducePosition(p.side, p.qty);
      addLog(
        isStop ? 'warn' : 'info',
        'execution',
        `${isStop ? '止损' : '止盈'}触发,市价平仓,已实现盈亏 ${fmt2(realized)}`,
      );
      broadcastAccount();
    }
  }
}

// ---------------------------------------------------------------------------
// 证据 / 上下文构建(给 episode 用)

function sma(values, period) {
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function buildEvidence(nowMs) {
  const closes = klines.map((k) => Number(k.close));
  const highs = klines.map((k) => Number(k.high));
  const lows = klines.map((k) => Number(k.low));
  const volumes = klines.map((k) => Number(k.volume));
  const ema20 = sma(closes, 20);
  const ema50 = sma(closes, 50);
  const recentHigh20 = Math.max(...highs.slice(-20));
  const recentLow20 = Math.min(...lows.slice(-20));
  const last = state.lastPrice;
  const distToHigh = ((recentHigh20 - last) / last) * 100;
  const distToLow = ((last - recentLow20) / last) * 100;
  const volRel = volumes.at(-1) / sma(volumes, 20);
  let atr = 0;
  for (let i = klines.length - 14; i < klines.length; i++) {
    if (i <= 0) continue;
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    atr += tr;
  }
  atr /= 14;

  const account = computeAccountView();
  const staleE6 = Math.random() < 0.2;

  const evidence = [
    {
      ref: 'E1',
      kind: 'technical',
      label: '短期/长期均线关系(EMA20 vs EMA50)',
      value: `EMA20=${fmt2(ema20)},EMA50=${fmt2(ema50)},${ema20 > ema50 ? '短期在上,偏多头排列' : '短期在下,偏空头排列'}`,
      observed_at: nowMs,
      source: 'binance_fapi_klines_1h',
      stale: false,
    },
    {
      ref: 'E2',
      kind: 'technical',
      label: '波动率(ATR14)',
      value: `${fmt2(atr)} 美元,约合现价 ${fmt2((atr / last) * 100)}%`,
      observed_at: nowMs,
      source: 'binance_fapi_klines_1h',
      stale: false,
    },
    {
      ref: 'E3',
      kind: 'technical',
      label: '距近 20 根高低点距离',
      value: `距高点 ${fmt2(distToHigh)}%,距低点 ${fmt2(distToLow)}%`,
      observed_at: nowMs,
      source: 'binance_fapi_klines_1h',
      stale: false,
    },
    {
      ref: 'E4',
      kind: 'technical',
      label: '成交量相对水平',
      value: `最新一根是近 20 根均值的 ${fmt2(volRel)} 倍`,
      observed_at: nowMs,
      source: 'binance_fapi_klines_1h',
      stale: false,
    },
    {
      ref: 'E5',
      kind: 'market',
      label: '资金费率',
      value: `${(state.fundingRate * 100).toFixed(4)}%`,
      observed_at: nowMs,
      source: 'binance_fapi_premium_index',
      stale: false,
    },
    {
      ref: 'E6',
      kind: 'market',
      label: '持仓量(OI)',
      value: `${(128_000 + Math.sin(nowMs / 9_000_000) * 5000).toFixed(0)} BTC`,
      observed_at: staleE6 ? nowMs - 40 * 60_000 : nowMs,
      source: 'binance_fapi_open_interest',
      stale: staleE6,
    },
    {
      ref: 'E7',
      kind: 'account',
      label: '当前持仓',
      value: account.positions.length ? `${account.positions[0].side === 'long' ? '多' : '空'} ${account.positions[0].qty}` : '空仓',
      observed_at: nowMs,
      source: 'paper_account',
      stale: false,
    },
    {
      ref: 'E8',
      kind: 'account',
      label: '权益 / 可用',
      value: `权益 ${account.equity},可用 ${account.available}`,
      observed_at: nowMs,
      source: 'paper_account',
      stale: false,
    },
  ];
  return evidence;
}

function buildContextText(trigger, evidence, hasPosition) {
  const evLines = evidence.map((e) => `- [${e.ref}] ${e.label}: ${e.value}${e.stale ? '(数据偏旧)' : ''}`).join('\n');
  return `# 段 1:身份与红线
你是 BTCUSDT 1 小时周期的交易研究助手。只输出结构化判断,不直接下单;数量/风险/执行由代码决定。
不允许在没有持仓时提议第二笔仓位;不允许突破风险预算。

# 段 2:Playbook
突破-回踩策略:关注近期区间的高低点,放量突破后等回踩不破位再考虑入场;止损设在结构位外侧。

# 段 4:市场
${SYMBOL} 现价 ${fmt2(state.lastPrice)},资金费率 ${(state.fundingRate * 100).toFixed(4)}%。

# 段 5:账户
${hasPosition ? '当前有持仓,处于管理阶段。' : '当前空仓。'}

# 段 6:触发
本次触发:${trigger.detail}(${trigger.kind})

# 段 7:当前策略
状态 ${strategy.state},版本 v${strategy.version}。论点:${strategy.thesis}

# 段 8:证据与任务
${evLines}

请基于以上证据给出本次判断(NO_TRADE/WATCH/PROPOSE/HOLD/ADD/REDUCE/EXIT/INVALIDATE 之一),用一句话讲清楚,并列出 2-5 条引用证据编号的理由。now=${new Date().toISOString()}`;
}

// ---------------------------------------------------------------------------
// 判断 episode 的核心逻辑

const NO_POSITION_POOL = ['NO_TRADE', 'WATCH', 'NO_TRADE', 'WATCH', 'PROPOSE', 'NO_TRADE'];
const POSITION_POOL = ['HOLD', 'HOLD', 'ADD', 'HOLD', 'REDUCE', 'HOLD', 'EXIT', 'HOLD', 'INVALIDATE'];

function decideAction(episodeIndex, hasPosition) {
  const pool = hasPosition ? POSITION_POOL : NO_POSITION_POOL;
  let action = pick(pool, episodeIndex);
  // 小概率故意选一个当前上下文不允许的动作,用来演示"这次判断没有改变策略状态"那一行
  if (Math.random() < 0.12) {
    action = hasPosition ? 'PROPOSE' : pickRandom(['ADD', 'REDUCE', 'EXIT']);
  }
  return action;
}

function sizeByRisk(entryPrice, stopPrice) {
  const account = computeAccountView();
  const equityNum = Number(account.equity);
  const riskUsdt = equityNum * (RISK_BUDGET_PCT / 100);
  const stopDistance = Math.abs(entryPrice - stopPrice);
  const rawQty = stopDistance > 0 ? riskUsdt / stopDistance : STEP_SIZE;
  let qty = floorToStep(rawQty, STEP_SIZE);
  if (qty <= 0) qty = STEP_SIZE;
  const notionalCap = equityNum * 3;
  if (qty * entryPrice > notionalCap) qty = floorToStep(notionalCap / entryPrice, STEP_SIZE);
  return {
    qty,
    sizing: {
      equity: account.equity,
      risk_pct: RISK_BUDGET_PCT.toFixed(2),
      risk_usdt: fmt2(riskUsdt),
      stop_distance: fmt2(stopDistance),
      raw_qty: rawQty.toFixed(6),
      step_size: STEP_SIZE.toString(),
      note: '按权益 × 风险预算 / 止损距离算出数量,已按最小下单精度向下取整,并受名义上限钳制',
    },
  };
}

function progressIntent(intentId) {
  const intent = intents.get(intentId);
  if (!intent) return;
  const delays = [700, 1200];
  setTimeout(() => {
    if (intent.status !== 'approved' && intent.status !== 'pending_approval') return;
    intent.status = 'submitted';
    intent.client_order_id = intent.client_order_id ?? `tg-demo-${randomUUID().slice(0, 8)}`;
    broadcast('intent.changed', intent);
    addLog('info', 'execution', `订单已提交:${intent.kind} ${intent.direction} ${intent.quantity} ${SYMBOL}`);
  }, delays[0]);
  setTimeout(() => {
    if (intent.status !== 'submitted') return;
    fillIntent(intent);
  }, delays[0] + delays[1]);
}

function fillIntent(intent) {
  const price = state.lastPrice;
  if (intent.kind === 'open') {
    // 这笔 intent 到底是"第一次开仓"(PROPOSE)还是"加仓"(ADD)取决于成交前有没有仓位;
    // 只有第一次开仓才把策略状态推进到 active,ADD 的目标状态(managing)在 reducer 阶段已经定了。
    const isInitialOpen = state.positions.length === 0;
    openPosition(intent.direction, Number(intent.quantity), price);
    if (intent.stop_price || intent.take_profit_price) {
      attachProtectiveOrders(intent.direction, intent.stop_price ? Number(intent.stop_price) : null, intent.take_profit_price ? Number(intent.take_profit_price) : null);
    }
    if (isInitialOpen) {
      updateStrategy({ state: 'active' }, intent.episode_id, 'PROPOSE', '开仓成交,进入持仓管理');
    }
  } else if (intent.kind === 'reduce') {
    reducePosition(intent.direction, Number(intent.quantity));
  } else if (intent.kind === 'close') {
    reducePosition(intent.direction, Number(intent.quantity));
    // 只有从"离场中"(EXIT 触发)平完仓才算正常 closed;
    // 从 invalidated 触发的平仓仍然停在 invalidated,下一轮再统一重置回 researching。
    if (state.positions.length === 0 && strategy.state === 'closing') {
      updateStrategy({ state: 'closed' }, intent.episode_id, 'EXIT', '仓位已全部平掉');
    }
  }
  intent.status = 'filled';
  broadcast('intent.changed', intent);
  broadcastAccount();
  addLog('info', 'execution', `成交:${intent.kind} ${intent.direction} ${intent.quantity} ${SYMBOL} @ ${fmt2(price)}`);
}

function createIntent(episodeId, kind, direction, qty, sizing, entry, limitPrice, stopPrice, takeProfitPrice) {
  idSeq.intent += 1;
  const intent = {
    id: id('in', idSeq.intent),
    episode_id: episodeId,
    at: Date.now(),
    kind,
    symbol: SYMBOL,
    direction,
    quantity: fmtQty(qty),
    entry,
    limit_price: limitPrice !== undefined && limitPrice !== null ? fmt2(limitPrice) : null,
    stop_price: stopPrice !== undefined && stopPrice !== null ? fmt2(stopPrice) : null,
    take_profit_price: takeProfitPrice !== undefined && takeProfitPrice !== null ? fmt2(takeProfitPrice) : null,
    sizing,
    status: loop.auto_approve ? 'approved' : 'pending_approval',
    client_order_id: null,
    backend: loop.backend,
    receipts: [],
    error: null,
  };
  intents.set(intent.id, intent);
  intentOrder.unshift(intent.id);
  broadcast('intent.changed', intent);
  addLog(
    'info',
    'execution',
    loop.auto_approve ? `已自动批准执行:${kind} ${direction} ${intent.quantity} ${SYMBOL}` : `新的待确认执行:${kind} ${direction} ${intent.quantity} ${SYMBOL},等待人工确认`,
  );
  if (loop.auto_approve) progressIntent(intent.id);
  return intent;
}

function finishEpisode(epId) {
  const ep = episodes.get(epId);
  if (!ep) return;

  // 上一轮结束的话,先重置回研究中,再走本轮判断
  if (strategy.state === 'closed' || strategy.state === 'invalidated') {
    resetToResearching(epId);
  }

  const hasPosition = state.positions.length > 0;
  const stateBefore = strategy.state;
  const episodeIndex = idSeq.episode;
  const action = decideAction(episodeIndex, hasPosition);
  const direction = hasPosition ? state.positions[0].side : action === 'PROPOSE' ? pickRandom(['long', 'short']) : strategy.direction;
  const confidence = clamp(0.45 + Math.random() * 0.5, 0, 0.97);

  // 小概率模拟模型输出没通过 schema 校验 → fail-closed NO_TRADE
  if (Math.random() < 0.07) {
    ep.judgment = null;
    ep.judgment_raw = '{"action":"PROPOSE","confidence":1.4,}'; // 故意的坏 JSON,演示校验失败
    ep.schema_errors = ['confidence 超出 0..1 范围', 'JSON 解析失败,尾部多了一个逗号'];
    ep.reducer = { from: stateBefore, to: stateBefore, accepted: true, reason: '模型输出未通过校验,已按不交易处理' };
    ep.gates = [{ name: 'schema_valid', passed: false, reason: '模型输出没通过校验' }];
    ep.status = 'done';
    ep.error = null;
    ep.strategy_after = { state: stateBefore, version: strategy.version };
    finalizeEpisode(ep, {
      action: 'NO_TRADE',
      direction: null,
      headline: '模型输出没通过校验,已按不交易处理',
      confidence: null,
      reasons: [],
      reducer: ep.reducer,
      schema_errors: ep.schema_errors,
      error: null,
    });
    return;
  }

  const mark = state.lastPrice;
  const evReasons = ep.evidence.slice(0, 2 + Math.floor(Math.random() * 3)).map((e) => `[${e.ref}] ${e.label}${e.stale ? ',但这条数据偏旧' : ''}`);

  let judgment = {
    action,
    direction,
    confidence,
    headline: '',
    thesis: '',
    reasons: evReasons,
    evidence_refs: ep.evidence.map((e) => e.ref),
    invalidation: strategy.invalidation,
    invalidation_price: strategy.invalidation_price,
    target_price: strategy.target_price,
    watch_conditions: strategy.watch_conditions,
    proposal: null,
  };

  let reducerAccepted = true;
  let reducerReason = '接受本次判断';
  let toState = stateBefore;

  switch (action) {
    case 'NO_TRADE': {
      judgment.headline = '暂时没有值得动手的信号,继续等待。';
      break;
    }
    case 'WATCH': {
      judgment.headline = '关注中,还没到入场条件。';
      judgment.thesis = '价格在区间内震荡,等待方向选择后再考虑介入。';
      const entryDir = pickRandom(['long', 'short']);
      judgment.watch_conditions = ['等待放量突破近期区间', '突破后回踩不破位再确认'];
      toState = 'watching';
      updateStrategy(
        { state: 'watching', thesis: judgment.thesis, watch_conditions: judgment.watch_conditions, direction: null },
        epId,
        action,
        '进入观察,等待更明确的信号',
      );
      break;
    }
    case 'PROPOSE': {
      if (hasPosition || !['watching', 'ready'].includes(stateBefore)) {
        reducerAccepted = false;
        reducerReason = hasPosition ? '已经有持仓,不能再提议新的一笔' : '还没进入观察阶段,不能直接提议开仓';
        judgment.headline = '模型提议开仓,但当前上下文不允许,已忽略。';
        break;
      }
      const stopDistPct = 0.006 + Math.random() * 0.01;
      const stopPrice = direction === 'long' ? mark * (1 - stopDistPct) : mark * (1 + stopDistPct);
      const targetPrice = direction === 'long' ? mark * (1 + stopDistPct * 2.2) : mark * (1 - stopDistPct * 2.2);
      judgment.headline = `提议${direction === 'long' ? '做多' : '做空'},结构位置不错。`;
      judgment.thesis = `价格${direction === 'long' ? '突破' : '跌破'}近期区间且量能配合,风险回报比可以接受。`;
      judgment.invalidation = `价格${direction === 'long' ? '跌破' : '突破'} ${fmt2(stopPrice)} 则论点失效`;
      judgment.invalidation_price = fmt2(stopPrice);
      judgment.target_price = fmt2(targetPrice);
      judgment.proposal = {
        direction,
        entry: 'market',
        limit_price: null,
        stop_price: fmt2(stopPrice),
        take_profit_price: fmt2(targetPrice),
        rationale: judgment.thesis,
      };
      toState = 'ready';
      updateStrategy(
        {
          state: 'ready',
          direction,
          thesis: judgment.thesis,
          entry_plan: `${direction === 'long' ? '突破' : '跌破'}结构位后市价入场`,
          invalidation: judgment.invalidation,
          invalidation_price: judgment.invalidation_price,
          target_price: judgment.target_price,
          watch_conditions: [],
        },
        epId,
        action,
        '提议开仓,进入准备入场',
      );
      state.opensToday += 1;
      const { qty, sizing } = sizeByRisk(mark, stopPrice);
      const intent = createIntent(epId, 'open', direction, qty, sizing, 'market', null, stopPrice, targetPrice);
      ep.intent = intent;
      break;
    }
    case 'HOLD': {
      if (!hasPosition || !['active', 'managing'].includes(stateBefore)) {
        reducerAccepted = false;
        reducerReason = '当前没有持仓,没有可以维持的仓位';
        judgment.headline = '模型判断继续持有,但当前没有仓位,已忽略。';
        break;
      }
      judgment.headline = '继续持有,论点还没被打破。';
      judgment.thesis = strategy.thesis;
      break;
    }
    case 'ADD': {
      if (!hasPosition || !['active', 'managing'].includes(stateBefore)) {
        reducerAccepted = false;
        reducerReason = '当前没有持仓,不能加仓';
        judgment.headline = '模型建议加仓,但当前没有仓位,已忽略。';
        break;
      }
      judgment.headline = '论点继续验证,加一点仓位。';
      toState = 'managing';
      updateStrategy({ state: 'managing' }, epId, action, '加仓,进入管理阶段');
      const pos = state.positions.find((p) => p.side === direction);
      const addQty = Math.max(STEP_SIZE, floorToStep((pos?.qty ?? STEP_SIZE) * 0.4, STEP_SIZE));
      const stopPrice = strategy.invalidation_price ? Number(strategy.invalidation_price) : direction === 'long' ? mark * 0.99 : mark * 1.01;
      const { sizing } = sizeByRisk(mark, stopPrice);
      const intent = createIntent(epId, 'open', direction, addQty, sizing, 'market', null, stopPrice, strategy.target_price ? Number(strategy.target_price) : null);
      ep.intent = intent;
      break;
    }
    case 'REDUCE': {
      if (!hasPosition || !['active', 'managing'].includes(stateBefore)) {
        reducerAccepted = false;
        reducerReason = '当前没有持仓,不能减仓';
        judgment.headline = '模型建议减仓,但当前没有仓位,已忽略。';
        break;
      }
      judgment.headline = '先落袋一部分,控制风险。';
      toState = 'managing';
      updateStrategy({ state: 'managing' }, epId, action, '减仓,继续管理剩余仓位');
      const pos = state.positions.find((p) => p.side === direction);
      const reduceQty = Math.max(STEP_SIZE, floorToStep((pos?.qty ?? STEP_SIZE) * 0.35, STEP_SIZE));
      const { sizing } = sizeByRisk(mark, strategy.invalidation_price ? Number(strategy.invalidation_price) : mark);
      const intent = createIntent(epId, 'reduce', direction, reduceQty, sizing, 'market', null, null, null);
      ep.intent = intent;
      break;
    }
    case 'EXIT': {
      if (!hasPosition || !['active', 'managing'].includes(stateBefore)) {
        reducerAccepted = false;
        reducerReason = '当前没有持仓,没有可以离场的仓位';
        judgment.headline = '模型建议离场,但当前没有仓位,已忽略。';
        break;
      }
      judgment.headline = '目标达到,或者论点不再成立,离场。';
      toState = 'closing';
      updateStrategy({ state: 'closing' }, epId, action, '离场中');
      const pos = state.positions.find((p) => p.side === direction);
      const { sizing } = sizeByRisk(mark, mark);
      const intent = createIntent(epId, 'close', direction, pos?.qty ?? STEP_SIZE, sizing, 'market', null, null, null);
      ep.intent = intent;
      break;
    }
    case 'INVALIDATE': {
      if (!['watching', 'ready', 'active', 'managing'].includes(stateBefore)) {
        reducerAccepted = false;
        reducerReason = '当前没有可失效的论点';
        judgment.headline = '模型判断论点失效,但当前没有活跃论点,已忽略。';
        break;
      }
      judgment.headline = '前提条件被破坏,论点失效。';
      toState = 'invalidated';
      updateStrategy({ state: 'invalidated' }, epId, action, '论点失效');
      if (hasPosition) {
        const pos = state.positions[0];
        const { sizing } = sizeByRisk(mark, mark);
        const intent = createIntent(epId, 'close', pos.side, pos.qty, sizing, 'market', null, null, null);
        ep.intent = intent;
      }
      break;
    }
  }

  ep.judgment = judgment;
  ep.judgment_raw = JSON.stringify(judgment);
  ep.schema_errors = [];
  ep.reducer = { from: stateBefore, to: reducerAccepted ? toState : stateBefore, accepted: reducerAccepted, reason: reducerReason };
  ep.gates = [
    { name: 'halted', passed: !loop.halted, reason: loop.halted ? '系统已紧急停止' : '正常' },
    { name: 'position_conflict', passed: !(action === 'PROPOSE' && hasPosition), reason: action === 'PROPOSE' && hasPosition ? '已有持仓,不能再开新仓' : '正常' },
    { name: 'daily_trade_cap', passed: state.opensToday <= 2, reason: state.opensToday > 2 ? '今天开仓次数已达上限' : '正常' },
  ];
  ep.status = 'done';
  ep.error = null;
  ep.strategy_after = { state: strategy.state, version: strategy.version };

  finalizeEpisode(ep, {
    action,
    direction: judgment.direction,
    headline: judgment.headline,
    confidence,
    reasons: judgment.reasons,
    reducer: ep.reducer,
    schema_errors: [],
    error: null,
  });
}

function toSummary(ep, override) {
  return {
    id: ep.id,
    at: ep.at,
    trigger: ep.trigger,
    action: override.action,
    direction: override.direction,
    headline: override.headline,
    confidence: override.confidence,
    reasons: override.reasons,
    from_state: ep.strategy_before.state,
    to_state: ep.strategy_after ? ep.strategy_after.state : ep.strategy_before.state,
    reducer: override.reducer,
    schema_errors: override.schema_errors,
    error: override.error,
    has_intent: !!ep.intent,
    intent: ep.intent ?? null,
    status: ep.status,
  };
}

function finalizeEpisode(ep, override) {
  runningEpisodeId = null;
  loop.last_episode_id = ep.id;
  const summary = toSummary(ep, override);
  broadcast('episode.finished', summary);
  addLog('info', 'episode', `判断完成:${ep.trigger.detail} → ${override.action}${override.headline ? ' · ' + override.headline : ''}`);
}

function startEpisode(trigger) {
  if (runningEpisodeId) return null;
  idSeq.episode += 1;
  const epId = id('ep', idSeq.episode);
  const nowMs = Date.now();
  const evidence = buildEvidence(nowMs);
  const hasPosition = state.positions.length > 0;
  const ep = {
    id: epId,
    at: nowMs,
    as_of: nowMs,
    trigger,
    strategy_before: { state: strategy.state, version: strategy.version },
    evidence,
    context_text: buildContextText(trigger, evidence, hasPosition),
    context_hash: `sha256-mock-${epId}`,
    prompt_version: 'demo-v1',
    model: loop.brain,
    judgment: null,
    judgment_raw: null,
    schema_errors: [],
    reducer: null,
    gates: [],
    intent: null,
    usage: {
      input_tokens: 900 + Math.floor(Math.random() * 600),
      output_tokens: 120 + Math.floor(Math.random() * 200),
      latency_ms: 0,
      cost_estimate: '0.0021',
    },
    status: 'running',
    error: null,
    strategy_after: null,
  };
  episodes.set(epId, ep);
  episodeOrder.unshift(epId);
  if (episodeOrder.length > 500) {
    const dropped = episodeOrder.pop();
    episodes.delete(dropped);
  }
  runningEpisodeId = epId;
  broadcast('episode.started', { id: epId, trigger });
  addLog('info', 'episode', `开始判断:${trigger.detail}`);

  const latency = 1200 + Math.random() * 1800;
  setTimeout(() => {
    ep.usage.latency_ms = Math.round(latency);
    // 极小概率模拟整条流水线炸掉(不是 schema 问题,是"系统"问题)
    if (Math.random() < 0.03) {
      ep.status = 'failed';
      ep.error = '拉取行情数据超时,本次判断放弃';
      ep.strategy_after = { state: strategy.state, version: strategy.version };
      finalizeEpisode(ep, {
        action: null,
        direction: null,
        headline: null,
        confidence: null,
        reasons: [],
        reducer: null,
        schema_errors: [],
        error: ep.error,
      });
      addLog('error', 'episode', ep.error);
      return;
    }
    finishEpisode(epId);
  }, latency);

  return epId;
}

// ---------------------------------------------------------------------------
// 定时器:行情 tick + 判断循环

let episodeTimer = null;

function scheduleEpisodeLoop() {
  if (episodeTimer) clearInterval(episodeTimer);
  loop.next_at = Date.now() + loop.every_ms;
  episodeTimer = setInterval(() => {
    loop.next_at = Date.now() + loop.every_ms;
    broadcast('loop.state', loop);
    if (loop.paused || loop.halted || runningEpisodeId) {
      addLog('info', 'loop', loop.halted ? '已紧急停止,跳过本轮' : loop.paused ? '已暂停,跳过本轮' : '上一轮还没判断完,跳过本轮');
      return;
    }
    if (idSeq.episode > 0 && idSeq.episode % 30 === 0) state.opensToday = 0;
    rollKline(Date.now());
    const hasPosition = state.positions.length > 0;
    const trigger = hasPosition && Math.random() < 0.4 ? { kind: 'position_review', detail: '持仓复查' } : { kind: 'kline_close', detail: `${TIMEFRAME} K 线收盘,收盘价 ${fmt2(state.lastPrice)}` };
    startEpisode(trigger);
  }, loop.every_ms);
}

setInterval(() => {
  const changePct = (Math.random() - 0.5) * 0.0025;
  state.lastPrice = Math.max(1000, state.lastPrice * (1 + changePct));
  updateFormingCandle(state.lastPrice);
  checkProtectiveTriggers();
  broadcast('market.tick', computeMarketView());
  broadcastAccount();
}, MARKET_TICK_MS);

scheduleEpisodeLoop();

// ---------------------------------------------------------------------------
// HTTP 路由

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.end(text);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function overviewPayload() {
  const summaries = episodeOrder.slice(0, 10).map((eid) => {
    const ep = episodes.get(eid);
    if (ep.status === 'running') {
      return toSummary(ep, { action: null, direction: null, headline: null, confidence: null, reasons: [], reducer: null, schema_errors: [], error: null });
    }
    // 用已经落盘的 judgment/reducer 重建 summary(避免再存一份 override)
    return toSummary(ep, {
      action: ep.judgment ? ep.judgment.action : ep.error ? null : 'NO_TRADE',
      direction: ep.judgment ? ep.judgment.direction : null,
      headline: ep.judgment ? ep.judgment.headline : ep.error,
      confidence: ep.judgment ? ep.judgment.confidence : null,
      reasons: ep.judgment ? ep.judgment.reasons : [],
      reducer: ep.reducer,
      schema_errors: ep.schema_errors,
      error: ep.error,
    });
  });
  return {
    loop,
    strategy,
    account: computeAccountView(),
    market: computeMarketView(),
    recent_episodes: summaries,
    // v2/v3
    workflow,
    market_state: marketState,
    threads: mockThreads.filter((t) => t.status === 'pending_entry' || t.status === 'in_position'),
    markets: Object.fromEntries(workflow.watchlist.map((sym) => [sym, { ...computeMarketView(), symbol: sym, last: fmt2(symPrice(sym)), mark: fmt2(symPrice(sym)) }])),
    queue: { pending: 0, running: runningEpisodeId ? { kind: 'scan', symbol: SYMBOL, step: 'thinking', episode_id: runningEpisodeId } : null },
  };
}

function episodeSummaryFromStore(ep) {
  if (ep.status === 'running') {
    return toSummary(ep, { action: null, direction: null, headline: null, confidence: null, reasons: [], reducer: null, schema_errors: [], error: null });
  }
  return toSummary(ep, {
    action: ep.judgment ? ep.judgment.action : ep.error ? null : 'NO_TRADE',
    direction: ep.judgment ? ep.judgment.direction : null,
    headline: ep.judgment ? ep.judgment.headline : ep.error,
    confidence: ep.judgment ? ep.judgment.confidence : null,
    reasons: ep.judgment ? ep.judgment.reasons : [],
    reducer: ep.reducer,
    schema_errors: ep.schema_errors,
    error: ep.error,
  });
}


// ---------------------------------------------------------------------------
// v2/v3 假数据(docs/demo/v2-agent-loop.md §3 + docs/demo/v3-ui-contract.md):
// 工作流 / 线程 / 对话 / 活动流 / 复盘 / 行情状态 / 全币种。只求形状对、页面能打开,不模拟真实逻辑。

const SYMBOL_BASES = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'TON', 'SUI', 'APT', 'ARB', 'OP', 'NEAR', 'LTC', 'BCH', 'UNI', 'AAVE', 'PEPE', 'WIF', 'TIA', 'SEI', 'INJ', 'FIL', 'ATOM', 'ETC', 'TRX', 'XLM', 'HBAR', 'RENDER', 'FET', 'TAO', 'ORDI', 'JUP', 'ENA', 'W', 'STRK', 'PYTH'];
const SYMBOL_PRICE = { BTC: 1, ETH: 0.038, SOL: 0.0016, BNB: 0.0092, XRP: 0.0000085, DOGE: 0.0000025, ADA: 0.0000062, AVAX: 0.00035, LINK: 0.00022, DOT: 0.00006 };
function symPrice(sym) {
  const base = sym.replace(/USDT$/, '');
  const f = SYMBOL_PRICE[base] ?? (0.00001 + ((base.charCodeAt(0) * 7 + (base.charCodeAt(1) ?? 0) * 3) % 900) / 100000);
  return state.lastPrice * f;
}
const mockSymbols = SYMBOL_BASES.map((b) => {
  const p = symPrice(`${b}USDT`);
  const pp = p >= 1000 ? 1 : p >= 10 ? 2 : p >= 0.1 ? 4 : 6;
  return { symbol: `${b}USDT`, status: 'TRADING', price_precision: pp, qty_precision: p >= 100 ? 3 : 0, step_size: p >= 100 ? '0.001' : '1', tick_size: (1 / 10 ** pp).toFixed(pp), min_qty: p >= 100 ? '0.001' : '1', min_notional: '5' };
});

const workflow = {
  watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'],
  timeframe: '15m',
  info_every_ms: 30 * 60_000,
  risk_pct: '0.5',
  leverage: 3,
  margin_mode: 'cross',
  max_open_threads: 3,
  max_opens_per_day: 4,
  daily_loss_stop_pct: '3',
  auto_approve: false,
  brain: 'pi',
  cheap_brain: 'pi',
  playbook_text: '突破-回踩(单一策略):1h/4h 同向,突破 20 根高/低点后回踩确认,量比 ≥ 1.0;止损放在最近 swing 之外,第一止盈 ≥ 1.5 倍止损距离。',
  paused: false,
  narrate: true,
  scan_mode: 'triggered',
  heartbeat_every_ms: 30 * 60_000,
  fast_move_pct: '0.8',
  review_every_close: false,
  updated_at: now0,
};
const WORKFLOW_FIELDS = Object.keys(workflow);
function applyWorkflowPatch(patch) {
  const errors = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!WORKFLOW_FIELDS.includes(k) || k === 'updated_at') continue;
    if (k === 'leverage' && !(Number.isFinite(Number(v)) && Number(v) >= 1 && Number(v) <= 10)) { errors.push('leverage 必须是 1–10 的数字'); continue; }
    if (k === 'watchlist' && (!Array.isArray(v) || v.length === 0)) { errors.push('watchlist 至少一个 USDT 永续,如 BTCUSDT'); continue; }
    if (k === 'risk_pct' && !(Number(v) >= 0.1 && Number(v) <= 2)) { errors.push('risk_pct 只能在 0.1–2 之间'); continue; }
    if (k === 'scan_mode' && v !== 'triggered' && v !== 'every_close') { errors.push('scan_mode 只能是 triggered/every_close'); continue; }
    workflow[k] = v;
  }
  workflow.updated_at = Date.now();
  broadcast('workflow.changed', workflow);
  return { workflow, errors };
}

function makeThread(i, sym, side, status, pnl, reason, minsAgo, holdMin, source = 'agent') {
  const p = symPrice(sym);
  const entry = p * (1 + (i % 5) * 0.001);
  const stop = side === 'long' ? entry * 0.988 : entry * 1.012;
  const tp = side === 'long' ? entry * 1.02 : entry * 0.98;
  const createdAt = Date.now() - minsAgo * 60_000;
  const closedAt = status === 'pending_entry' || status === 'in_position' ? null : createdAt + holdMin * 60_000;
  const qty = p >= 100 ? Number((300 / entry).toFixed(3)) : Math.round(300 / entry);
  const pnlNum = pnl;
  const exit = closedAt ? entry + (side === 'long' ? 1 : -1) * (pnlNum / Math.max(qty, 1e-9)) : null;
  return {
    id: `thr-mock${String(i).padStart(3, '0')}`,
    symbol: sym,
    side,
    status,
    source,
    timeframe: '15m',
    thesis: `${sym} ${side === 'long' ? '放量突破 20 根高点后回踩确认' : '跌破 20 根低点后反抽不过'},1h/4h 同向。`,
    invalidation_text: side === 'long' ? '收盘跌回突破位下方' : '收盘站回突破位上方',
    watch_conditions: ['下一根 15m 收盘是否守住', '量比是否回到 1 以上'],
    entry: { type: 'limit', price: fmt2(entry), zone: [fmt2(entry * 0.998), fmt2(entry * 1.002)] },
    stop_price: fmt2(stop),
    take_profits: [fmt2(tp), fmt2(side === 'long' ? entry * 1.035 : entry * 0.965)],
    qty: String(qty),
    margin_usdt: '100.00',
    leverage: 3,
    margin_mode: 'cross',
    entry_client_order_id: `tgd-mock${i}-e1`,
    protection_client_order_ids: [`tgd-mock${i}-sl`, `tgd-mock${i}-tp`],
    filled_avg_price: status === 'pending_entry' || status === 'canceled' ? null : fmt2(entry),
    realized_pnl: closedAt && status === 'closed' ? fmt2(pnlNum) : null,
    close_reason: closedAt ? reason : null,
    attention: null,
    episode_ids: [],
    intent_ids: [],
    created_at: createdAt,
    updated_at: closedAt ?? createdAt,
    opened_at: status === 'pending_entry' || status === 'canceled' ? null : createdAt + 4 * 60_000,
    closed_at: closedAt,
    version: 3,
    // HistoryThread 扩展字段(/api/history 用)
    hold_ms: closedAt ? holdMin * 60_000 : 0,
    pnl_num: closedAt && status === 'closed' ? pnlNum : 0,
    exit_price: exit ? fmt2(exit) : null,
    episode_count: 3 + (i % 6),
    r_multiple: closedAt && status === 'closed' ? Number((pnlNum / Math.abs((entry - stop) * qty)).toFixed(2)) : null,
  };
}
const mockThreads = [
  makeThread(1, 'SOLUSDT', 'long', 'in_position', 0, null, 70, 0),
  makeThread(2, 'ETHUSDT', 'short', 'pending_entry', 0, null, 20, 0),
  makeThread(3, 'SOLUSDT', 'long', 'closed', -43.75, '复查离场', 200, 26),
  makeThread(4, 'BTCUSDT', 'long', 'closed', 61.2, '止盈触发 @ 82100', 380, 95, 'manual'),
  makeThread(5, 'BNBUSDT', 'short', 'closed', -28.4, '止损触发 @ 731.2', 540, 41),
  makeThread(6, 'ETHUSDT', 'long', 'closed', 18.9, '止盈触发 @ 2482', 760, 130),
  makeThread(7, 'DOGEUSDT', 'long', 'canceled', 0, '结构坏了,撤单', 900, 12),
  makeThread(8, 'XRPUSDT', 'short', 'closed', 9.3, '复查离场', 1300, 58, 'chat'),
  makeThread(9, 'BTCUSDT', 'short', 'closed', -35.0, '止损触发 @ 80950', 1700, 22),
];
function historyPayload() {
  const closed = mockThreads.filter((t) => t.status !== 'pending_entry' && t.status !== 'in_position').sort((a, b) => (b.closed_at ?? 0) - (a.closed_at ?? 0));
  const real = closed.filter((t) => t.status === 'closed');
  const wins = real.filter((t) => t.pnl_num > 0);
  const losses = real.filter((t) => t.pnl_num < 0);
  const sum = (arr) => arr.reduce((a, t) => a + t.pnl_num, 0);
  const grossWin = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  const bucket = (key) => {
    const m = new Map();
    for (const t of real) {
      const k = key(t);
      const b = m.get(k) ?? { count: 0, wins: 0, pnl: 0 };
      b.count++;
      if (t.pnl_num > 0) b.wins++;
      b.pnl += t.pnl_num;
      m.set(k, b);
    }
    return [...m.entries()].map(([k, b]) => ({ key: k, count: b.count, wins: b.wins, pnl: fmt2(b.pnl) }));
  };
  const best = real.length ? real.reduce((a, t) => (t.pnl_num > a.pnl_num ? t : a)) : null;
  const worst = real.length ? real.reduce((a, t) => (t.pnl_num < a.pnl_num ? t : a)) : null;
  const equity = [];
  let eq = START_EQUITY - sum(real);
  const start = Date.now() - 30 * 3_600_000;
  const events = [...real].sort((a, b) => (a.closed_at ?? 0) - (b.closed_at ?? 0));
  let ei = 0;
  for (let t = start; t <= Date.now(); t += 5 * 60_000) {
    while (ei < events.length && (events[ei].closed_at ?? 0) <= t) eq += events[ei++].pnl_num;
    equity.push({ at: t, equity: Number((eq + Math.sin(t / 3_000_000) * 6).toFixed(2)), unrealized: Number((Math.sin(t / 1_700_000) * 4).toFixed(2)) });
  }
  return {
    stats: {
      count: real.length,
      wins: wins.length,
      losses: losses.length,
      flat: real.length - wins.length - losses.length,
      win_rate: real.length ? wins.length / real.length : 0,
      total_pnl: fmt2(sum(real)),
      avg_pnl: fmt2(real.length ? sum(real) / real.length : 0),
      avg_hold_ms: real.length ? real.reduce((a, t) => a + t.hold_ms, 0) / real.length : 0,
      profit_factor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : null,
      best: best ? { thread_id: best.id, symbol: best.symbol, pnl: fmt2(best.pnl_num) } : null,
      worst: worst ? { thread_id: worst.id, symbol: worst.symbol, pnl: fmt2(worst.pnl_num) } : null,
      by_symbol: bucket((t) => t.symbol).map(({ key, ...b }) => ({ symbol: key, ...b })),
      by_source: bucket((t) => t.source).map(({ key, ...b }) => ({ source: key, ...b })),
      by_close_reason: bucket((t) => (t.close_reason ?? '').replace(/ @.*$/, '') || '其它').map(({ key, ...b }) => ({ reason: key, ...b })),
    },
    threads: closed,
    equity,
  };
}

const marketState = {
  id: 'ms-mock-1',
  as_of: Date.now() - 6 * 60_000,
  model: 'mock',
  regime: 'range',
  bias: 'neutral',
  summary: 'BTC 在 80.5k–82.5k 区间来回,资金费率中性,ETH 相对偏弱;没有明显宏观催化,等美股开盘后的方向。',
  key_points: ['BTC 4h EMA20 与 EMA50 缠绕', 'SOL 相对强势,1h 放量', '恐惧贪婪 52,中性'],
  majors: workflow.watchlist.map((sym) => ({ symbol: sym, last: fmt2(symPrice(sym)), change_24h_pct: (Math.sin(sym.length) * 2).toFixed(2), funding_rate: '0.000100', oi_change_1h_pct: '0.4', long_short_ratio: '1.12', taker_buy_sell_ratio: '1.03' })),
  sentiment: { fng: 52, fng_label: 'Neutral' },
  top_movers: [{ symbol: 'SOLUSDT', change_24h_pct: '4.1', quote_volume: '1200000000' }],
  news: [
    { ref: 'N1', title: 'ETF 净流入连续第三日为正', source: 'CoinDesk', published_at: Date.now() - 50 * 60_000, relevance: 'medium', digest: '现货 ETF 资金面偏暖。' },
    { ref: 'N2', title: '美联储官员讲话前市场观望', source: 'Cointelegraph', published_at: Date.now() - 120 * 60_000, relevance: 'low', digest: '波动率偏低。' },
  ],
  candidates: [{ symbol: 'SOLUSDT', direction: 'long', why: '1h 放量突破,4h 偏多' }],
  risk_events: [],
  info_refs: ['N1', 'N2'],
  usage: { input_tokens: 5200, output_tokens: 610, latency_ms: 14200, cost_estimate: '≈¥0.03' },
  error: null,
};

const chatMessages = [
  { id: 'msg-m1', at: Date.now() - 40 * 60_000, role: 'user', text: '现在为什么不开单?', tool_calls: [], episode_id: null, kind: 'chat' },
  { id: 'msg-m2', at: Date.now() - 40 * 60_000 + 12_000, role: 'agent', text: 'BTC 1h 与 4h 方向相反,量比 0.7,不满足突破-回踩条件;SOL 已经有一条持仓线程。等 4h 收盘看 EMA20 能否站回 EMA50 之上。', tool_calls: [{ name: 'get_state', args: {}, result: { ok: true }, ok: true }], episode_id: null, kind: 'chat' },
  { id: 'msg-m3', at: Date.now() - 30 * 60_000, role: 'agent', text: '旁白 · 刚看了 BTCUSDT(15m K 线收盘):不交易 —— 1h/4h 方向相反,量比不足。下次看:4h EMA20 能否上穿 EMA50', tool_calls: [], episode_id: 'ep-mock-1', kind: 'narration' },
  { id: 'msg-m4', at: Date.now() - 15 * 60_000, role: 'agent', text: '旁白 · 刚复查了 SOLUSDT(15m K 线收盘):继续持有 —— 多头结构未破。下次看:是否收盘跌破 104.4', tool_calls: [], episode_id: 'ep-mock-2', kind: 'narration' },
];
function pushChat(m) {
  chatMessages.push(m);
  if (chatMessages.length > 500) chatMessages.shift();
  broadcast('chat.message', m);
}

const activity = [];
function pushActivity(kind, level, title, extra = {}) {
  const item = { id: `act-${randomUUID().slice(0, 8)}`, at: extra.at ?? Date.now(), kind, level, symbol: extra.symbol ?? null, thread_id: extra.thread_id ?? null, episode_id: extra.episode_id ?? null, title, detail: extra.detail ?? null, data: extra.data ?? {} };
  activity.unshift(item);
  if (activity.length > 1000) activity.length = 1000;
  if (!extra.silent) broadcast('activity', item);
  return item;
}
(() => {
  const m = 60_000;
  const seed = [
    ['info_update', 'info', '信息员更新:区间震荡,偏中性', { at: Date.now() - 400 * m, detail: 'BTC 在 80.5k–82.5k 区间来回,资金费率中性。' }],
    ['trigger', 'info', 'SOLUSDT 触发器:突破 20 根高点,量比 2.3', { at: Date.now() - 205 * m, symbol: 'SOLUSDT' }],
    ['proposal', 'info', 'SOLUSDT 出策略:做多,限价回踩区', { at: Date.now() - 204 * m, symbol: 'SOLUSDT', thread_id: 'thr-mock003', episode_id: 'ep-mock-1', detail: '1h/4h 同向,突破后回踩 EMA20;止损 103.8,止盈 106.8 / 108.5。' }],
    ['thread_opened', 'info', 'SOLUSDT 做多 已挂限价单 @ 105.00', { at: Date.now() - 204 * m, symbol: 'SOLUSDT', thread_id: 'thr-mock003' }],
    ['entry_filled', 'success', 'SOLUSDT 做多 已成交 @ 104.99', { at: Date.now() - 200 * m, symbol: 'SOLUSDT', thread_id: 'thr-mock003', data: { price: '104.99', qty: '42' } }],
    ['protection_placed', 'info', 'SOLUSDT 止损 103.80 / 止盈 106.80 已挂', { at: Date.now() - 200 * m + 5000, symbol: 'SOLUSDT', thread_id: 'thr-mock003' }],
    ['thread_closed', 'danger', 'SOLUSDT 做多 复查离场 @ 103.95', { at: Date.now() - 174 * m, symbol: 'SOLUSDT', thread_id: 'thr-mock003', episode_id: 'ep-mock-3', data: { pnl: '-43.75' }, detail: '1h 收盘跌回 105 下方,论点失效,主动离场。' }],
    ['proposal_blocked', 'warn', 'BTCUSDT 提议做多被闸拦下:日内开仓已达上限', { at: Date.now() - 120 * m, symbol: 'BTCUSDT', episode_id: 'ep-mock-4' }],
    ['workflow_changed', 'info', '工作流已更新:timeframe, scan_mode', { at: Date.now() - 90 * m }],
    ['trigger', 'info', 'SOLUSDT 触发器:回踩 EMA20 站稳', { at: Date.now() - 72 * m, symbol: 'SOLUSDT' }],
    ['proposal', 'info', 'SOLUSDT 出策略:做多', { at: Date.now() - 71 * m, symbol: 'SOLUSDT', thread_id: 'thr-mock001', episode_id: 'ep-mock-5' }],
    ['approval_needed', 'warn', 'SOLUSDT 做多 等你确认(自动执行已关)', { at: Date.now() - 71 * m, symbol: 'SOLUSDT', thread_id: 'thr-mock001' }],
    ['approved', 'info', 'SOLUSDT 做多 已批准', { at: Date.now() - 70 * m, symbol: 'SOLUSDT', thread_id: 'thr-mock001' }],
    ['entry_filled', 'success', 'SOLUSDT 做多 已成交 @ 105.31', { at: Date.now() - 66 * m, symbol: 'SOLUSDT', thread_id: 'thr-mock001', data: { price: '105.31' } }],
    ['chat_action', 'info', '对话里让 agent 看了 ETHUSDT', { at: Date.now() - 40 * m, symbol: 'ETHUSDT' }],
    ['thread_opened', 'info', 'ETHUSDT 做空 已挂限价单', { at: Date.now() - 20 * m, symbol: 'ETHUSDT', thread_id: 'thr-mock002' }],
    ['brain_error', 'warn', 'BTCUSDT 模型输出不合契约,修了一次', { at: Date.now() - 8 * m, symbol: 'BTCUSDT' }],
  ];
  for (const [kind, level, title, extra] of seed) pushActivity(kind, level, title, { ...extra, silent: true });
  activity.sort((a, b) => b.at - a.at);
})();

function regimePayload(symbol) {
  const h = new Date().getUTCHours();
  const dow = new Date().getUTCDay();
  const minToUsOpen = (() => {
    const d = new Date();
    const open = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 13, 30));
    let diff = (open.getTime() - d.getTime()) / 60_000;
    if (diff < -30) diff += 24 * 60;
    return Math.round(diff);
  })();
  const session = dow === 0 || dow === 6 ? 'weekend' : Math.abs(minToUsOpen) <= 30 ? 'us_open_window' : h >= 13 && h < 21 ? 'us' : h >= 7 && h < 13 ? 'london' : h >= 0 && h < 7 ? 'asia' : 'off';
  const sessionText = { weekend: '周末,成交清淡,假突破多', us_open_window: '美股开盘窗口(±30 分钟),历史上波动放大', us: '美股时段,与美股联动最强', london: '欧洲时段,方向常在这里定', asia: '亚洲时段,通常震荡', off: '清淡时段' }[session];
  const regime = symbol.startsWith('SOL') ? 'bull' : symbol.startsWith('ETH') ? 'bear' : 'range';
  return {
    symbol,
    as_of: Date.now(),
    daily: { regime, ema_stack: regime === 'bull' ? '20>50>200' : regime === 'bear' ? '20<50<200' : '50>20>200', ret_20d_pct: regime === 'bull' ? 8.3 : regime === 'bear' ? -6.1 : 1.2, vol_pct_rank: 0.62, atr_pct: 2.1, text: `${symbol} 日线${regime === 'bull' ? '多头排列,20 日 +8.3%' : regime === 'bear' ? '空头排列,20 日 −6.1%' : 'EMA 缠绕,20 日 +1.2%'},波动率处于近 100 日 62% 分位` },
    session: { name: session, text: sessionText, minutes_to_us_open: minToUsOpen > 0 ? minToUsOpen : null },
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function v2Routes(method, path, url, req, res) {
  if (method === 'GET' && path === '/api/workflow') return sendJson(res, 200, workflow);
  if (method === 'POST' && path === '/api/workflow') return readJson(req).then((body) => sendJson(res, 200, applyWorkflowPatch(body)));
  if (method === 'GET' && path === '/api/symbols') return sendJson(res, 200, { symbols: mockSymbols });
  if (method === 'GET' && path === '/api/positions') return sendJson(res, 200, computeAccountView().positions);
  if (method === 'GET' && path === '/api/orders/open') return sendJson(res, 200, computeAccountView().open_orders);
  if (method === 'GET' && path === '/api/market-state') return sendJson(res, 200, marketState);
  if (method === 'GET' && path === '/api/market-state/history') return sendJson(res, 200, { history: [marketState] });
  if (method === 'GET' && path === '/api/info/events') return sendJson(res, 200, { events: [] });
  if (method === 'POST' && path === '/api/info/run-now') {
    marketState.as_of = Date.now();
    setTimeout(() => {
      broadcast('market_state.updated', marketState);
      pushActivity('info_update', 'info', `信息员更新:${marketState.regime},偏 ${marketState.bias}`, { detail: marketState.summary });
    }, 1500);
    return sendJson(res, 202, { queued: true, job_id: 'info' });
  }
  if (method === 'POST' && path === '/api/scan-now') return sendJson(res, 202, { queued: workflow.watchlist.length, job_ids: workflow.watchlist.map((s) => `scan:${s}`) });
  if (method === 'GET' && path === '/api/threads') {
    const status = url.searchParams.get('status') ?? 'open';
    const list = status === 'open' ? mockThreads.filter((t) => t.status === 'pending_entry' || t.status === 'in_position') : status === 'all' ? mockThreads : mockThreads.filter((t) => status.split(',').includes(t.status));
    return sendJson(res, 200, { threads: list });
  }
  const threadMatch = path.match(/^\/api\/threads\/([^/]+)(?:\/(close|review))?$/);
  if (threadMatch) {
    const t = mockThreads.find((x) => x.id === threadMatch[1]);
    if (!t) return sendError(res, 404, 'not_found', 'thread not found');
    if (method === 'GET' && !threadMatch[2]) {
      const eps = Array.from({ length: t.episode_count ?? 3 }, (_, i) => ({
        id: `ep-${t.id}-${i}`,
        at: t.created_at + i * 15 * 60_000,
        symbol: t.symbol,
        thread_id: t.id,
        trigger: { kind: i === 0 ? 'breakout' : i % 2 ? 'kline_close' : 'retest', detail: i === 0 ? '突破 20 根高点' : '15m K 线收盘' },
        action: i === 0 ? 'PROPOSE' : t.closed_at && i === (t.episode_count ?? 3) - 1 ? 'EXIT' : 'HOLD',
        direction: t.side,
        headline: i === 0 ? '放量突破后回踩确认,提议入场' : t.closed_at && i === (t.episode_count ?? 3) - 1 ? '收盘跌回突破位,论点失效离场' : '结构未破,继续持有',
        confidence: 0.6 + (i % 3) * 0.1,
        reasons: ['1h 与 4h 同向 [E5]', '量比 2.3 [E6]'],
        from_state: i === 0 ? 'researching' : 'active',
        to_state: 'active',
        reducer: null,
        schema_errors: [],
        error: null,
        has_intent: i === 0,
        intent: null,
        status: 'done',
      }));
      return sendJson(res, 200, { thread: t, episodes: eps.reverse(), intents: [] });
    }
    if (method === 'POST' && threadMatch[2] === 'close') {
      t.status = t.status === 'pending_entry' ? 'canceled' : 'closed';
      t.closed_at = Date.now();
      t.close_reason = '用户手动平仓';
      t.realized_pnl = t.status === 'closed' ? fmt2((Math.random() - 0.5) * 40) : null;
      t.pnl_num = Number(t.realized_pnl ?? 0);
      t.hold_ms = t.closed_at - t.created_at;
      t.updated_at = Date.now();
      broadcast('thread.changed', t);
      pushActivity(t.status === 'closed' ? 'thread_closed' : 'thread_canceled', t.status === 'closed' ? (t.pnl_num >= 0 ? 'success' : 'danger') : 'info', `${t.symbol} ${t.side === 'long' ? '做多' : '做空'} ${t.status === 'closed' ? '已平仓' : '已撤单'}`, { symbol: t.symbol, thread_id: t.id, data: { pnl: t.realized_pnl } });
      return sendJson(res, 200, t);
    }
    if (method === 'POST' && threadMatch[2] === 'review') return sendJson(res, 202, { queued: true, job_id: `review:${t.id}` });
  }
  if (method === 'POST' && path === '/api/orders') {
    return readJson(req).then((body) => {
      if (!body.symbol || !body.side || !body.action || !body.type) return sendError(res, 400, 'bad_request', 'symbol/side/action/type 必填');
      if (body.action === 'open' && !body.sl) return sendError(res, 400, 'bad_request', '手动开仓必须带止损(sl)');
      const t = makeThread(100 + mockThreads.length, String(body.symbol).toUpperCase(), body.side, body.type === 'limit' ? 'pending_entry' : 'in_position', 0, null, 0, 0, 'manual');
      t.stop_price = body.sl ? String(body.sl) : t.stop_price;
      mockThreads.unshift(t);
      broadcast('thread.changed', t);
      pushActivity('manual_order', 'info', `${t.symbol} ${t.side === 'long' ? '做多' : '做空'} 手动${body.type === 'limit' ? '限价' : '市价'}单已提交`, { symbol: t.symbol, thread_id: t.id });
      return sendJson(res, 200, { thread: t, intent: null, message: 'ok' });
    });
  }
  if (method === 'GET' && path === '/api/chat/messages') {
    const limit = Number(url.searchParams.get('limit') ?? '100');
    const kind = url.searchParams.get('kind') ?? 'all';
    const list = chatMessages.filter((m) => (kind === 'all' ? true : (m.kind ?? (m.text.startsWith('旁白 · ') ? 'narration' : 'chat')) === kind));
    return sendJson(res, 200, { messages: list.slice(-limit) });
  }
  if (method === 'POST' && path === '/api/chat/messages') {
    return readJson(req).then((body) => {
      const text = String(body.text ?? '').trim();
      if (!text) return sendError(res, 400, 'bad_request', 'text 必填');
      pushChat({ id: `msg-${randomUUID().slice(0, 8)}`, at: Date.now(), role: 'user', text, tool_calls: [], episode_id: null, kind: 'chat' });
      setTimeout(() => {
        pushChat({
          id: `msg-${randomUUID().slice(0, 8)}`,
          at: Date.now(),
          role: 'agent',
          text: `(mock)收到:「${text}」。真网关这里会读判断记录/账户状态后回答;需要动钱的只会提议,不会直接下单。`,
          tool_calls: [{ name: 'get_state', args: {}, result: { equity: computeAccountView().equity }, ok: true }],
          episode_id: null,
          kind: 'chat',
        });
        pushActivity('chat_action', 'info', `对话:${text.slice(0, 24)}`, {});
      }, 1800);
      return sendJson(res, 202, { accepted: true, queued: true });
    });
  }
  if (method === 'POST' && path === '/api/chat/reset') {
    chatMessages.length = 0;
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'GET' && path === '/api/history') return sendJson(res, 200, historyPayload());
  if (method === 'GET' && path === '/api/activity') {
    const limit = Number(url.searchParams.get('limit') ?? '200');
    const before = Number(url.searchParams.get('before') ?? '0');
    return sendJson(res, 200, { activity: activity.filter((a) => (before ? a.at < before : true)).slice(0, limit) });
  }
  if (method === 'GET' && path === '/api/market/regime') return sendJson(res, 200, regimePayload((url.searchParams.get('symbol') ?? SYMBOL).toUpperCase()));
  return null;
}

// 每 45 秒冒一条旁白 + 活动,让「动态」和「日志」页看得到实时进来的东西
setInterval(() => {
  const sym = pick(workflow.watchlist, Math.floor(Date.now() / 45_000));
  pushChat({ id: `msg-${randomUUID().slice(0, 8)}`, at: Date.now(), role: 'agent', text: `旁白 · 刚看了 ${sym}(${workflow.timeframe} K 线收盘):先观察 —— 结构未破但量能不足。下次看:量比能否回到 1 以上`, tool_calls: [], episode_id: null, kind: 'narration' });
  pushActivity('trigger', 'info', `${sym} 触发器:心跳(${Math.round(workflow.heartbeat_every_ms / 60_000)} 分钟)`, { symbol: sym });
}, 45_000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    res.end();
    return;
  }

  try {
    const v2 = v2Routes(method, path, url, req, res);
    if (v2 !== null) return await v2;

    if (method === 'GET' && path === '/api/overview') {
      return sendJson(res, 200, overviewPayload());
    }

    if (method === 'GET' && path === '/api/episodes') {
      const limit = Number(url.searchParams.get('limit') ?? '50');
      const before = url.searchParams.get('before');
      let ids = episodeOrder;
      if (before) {
        const idx = episodeOrder.indexOf(before);
        ids = idx >= 0 ? episodeOrder.slice(idx + 1) : episodeOrder;
      }
      const list = ids.slice(0, limit).map((eid) => episodeSummaryFromStore(episodes.get(eid)));
      return sendJson(res, 200, list);
    }

    const episodeDetailMatch = path.match(/^\/api\/episodes\/([^/]+)$/);
    if (method === 'GET' && episodeDetailMatch) {
      const ep = episodes.get(episodeDetailMatch[1]);
      if (!ep) return sendError(res, 404, 'not_found', '找不到这条判断记录');
      return sendJson(res, 200, ep);
    }

    if (method === 'GET' && path === '/api/strategy') {
      return sendJson(res, 200, { ...strategy, revisions });
    }

    if (method === 'GET' && path === '/api/intents') {
      const limit = Number(url.searchParams.get('limit') ?? '50');
      const list = intentOrder.slice(0, limit).map((iid) => intents.get(iid));
      return sendJson(res, 200, list);
    }

    if (method === 'GET' && path === '/api/market/klines') {
      const tf = url.searchParams.get('tf') ?? TIMEFRAME;
      const limit = Number(url.searchParams.get('limit') ?? '300');
      const symbol = (url.searchParams.get('symbol') ?? SYMBOL).toUpperCase();
      const endTime = Number(url.searchParams.get('end_time') ?? '0');
      // 别的币按价格比例缩放同一份 K 线;end_time 只是切到那之前(mock 只有 1h 一套数据)
      const f = symPrice(symbol) / state.lastPrice;
      const scaled = klines.map((k) => ({ ...k, open: fmt2(Number(k.open) * f), high: fmt2(Number(k.high) * f), low: fmt2(Number(k.low) * f), close: fmt2(Number(k.close) * f) }));
      const cut = endTime ? scaled.filter((k) => k.open_time <= endTime) : scaled;
      return sendJson(res, 200, { symbol, tf, klines: cut.slice(-limit) });
    }

    if (method === 'GET' && path === '/api/logs') {
      const limit = Number(url.searchParams.get('limit') ?? '200');
      return sendJson(res, 200, { logs: logs.slice(0, limit) });
    }

    if (method === 'POST' && path === '/api/run-now') {
      if (runningEpisodeId) return sendError(res, 409, 'episode_running', '已经有一次判断在进行中');
      if (loop.halted) return sendError(res, 409, 'halted', '系统已紧急停止,不能再触发判断');
      const epId = startEpisode({ kind: 'manual', detail: '用户点击"立即判断"' });
      return sendJson(res, 200, { episode_id: epId });
    }

    if (method === 'POST' && path === '/api/pause') {
      loop.paused = true;
      broadcast('loop.state', loop);
      addLog('info', 'loop', '已暂停');
      return sendJson(res, 200, loop);
    }

    if (method === 'POST' && path === '/api/resume') {
      const body = (await readBody(req)) ?? {};
      if (loop.halted) {
        if (body.confirm !== 'RESUME') {
          return sendError(res, 400, 'confirm_required', '系统处于紧急停止状态,恢复需要 body {confirm:"RESUME"}');
        }
        loop.halted = false;
        addLog('info', 'loop', '已从紧急停止状态恢复');
      }
      loop.paused = false;
      broadcast('loop.state', loop);
      addLog('info', 'loop', '已恢复');
      return sendJson(res, 200, loop);
    }

    if (method === 'POST' && path === '/api/halt') {
      const body = (await readBody(req)) ?? {};
      if (body.confirm !== 'HALT') {
        return sendError(res, 400, 'confirm_required', '需要 body {confirm:"HALT"} 才会执行紧急停止');
      }
      const cancelledCount = state.openOrders.length;
      state.openOrders = [];
      let realizedTotal = 0;
      for (const p of [...state.positions]) {
        realizedTotal += reducePosition(p.side, p.qty);
      }
      loop.halted = true;
      broadcast('loop.state', loop);
      broadcastAccount();
      addLog('warn', 'loop', `紧急停止:撤掉 ${cancelledCount} 个挂单,市价平掉所有持仓,已实现盈亏 ${fmt2(realizedTotal)}`);
      return sendJson(res, 200, loop);
    }

    if (method === 'POST' && path === '/api/settings') {
      const body = (await readBody(req)) ?? {};
      if (typeof body.auto_approve === 'boolean') loop.auto_approve = body.auto_approve;
      if (typeof body.every_ms === 'number' && body.every_ms >= 2000) {
        loop.every_ms = body.every_ms;
        scheduleEpisodeLoop();
      }
      broadcast('loop.state', loop);
      addLog('info', 'settings', `设置已更新:auto_approve=${loop.auto_approve}, every_ms=${loop.every_ms}`);
      return sendJson(res, 200, loop);
    }

    const approveMatch = path.match(/^\/api\/intents\/([^/]+)\/approve$/);
    if (method === 'POST' && approveMatch) {
      const intent = intents.get(approveMatch[1]);
      if (!intent) return sendError(res, 404, 'not_found', '找不到这条执行记录');
      if (intent.status !== 'pending_approval') return sendError(res, 409, 'invalid_state', `当前状态是 ${intent.status},不能确认`);
      intent.status = 'approved';
      broadcast('intent.changed', intent);
      addLog('info', 'execution', `用户确认执行:${intent.kind} ${intent.direction} ${intent.quantity} ${SYMBOL}`);
      progressIntent(intent.id);
      return sendJson(res, 200, intent);
    }

    const rejectMatch = path.match(/^\/api\/intents\/([^/]+)\/reject$/);
    if (method === 'POST' && rejectMatch) {
      const intent = intents.get(rejectMatch[1]);
      if (!intent) return sendError(res, 404, 'not_found', '找不到这条执行记录');
      if (intent.status !== 'pending_approval') return sendError(res, 409, 'invalid_state', `当前状态是 ${intent.status},不能拒绝`);
      intent.status = 'rejected';
      broadcast('intent.changed', intent);
      addLog('info', 'execution', `用户拒绝执行:${intent.kind} ${intent.direction} ${intent.quantity} ${SYMBOL}`);
      return sendJson(res, 200, intent);
    }

    if (method === 'GET' && path === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      res.write('\n');
      subscribers.add(res);
      res.write(`event: loop.state\ndata: ${JSON.stringify(loop)}\n\n`);
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(ping);
        }
      }, 15_000);
      req.on('close', () => {
        clearInterval(ping);
        subscribers.delete(res);
      });
      return;
    }

    return sendError(res, 404, 'not_found', `没有这个接口:${method} ${path}`);
  } catch (err) {
    console.error(err);
    return sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[mock] trading-swarm demo mock gateway 监听 http://${HOST}:${PORT}`);
  console.log(`[mock] auto_approve=${loop.auto_approve},每 ${loop.every_ms / 1000}s 一轮判断`);
  addLog('info', 'system', 'mock 网关已启动');
});
