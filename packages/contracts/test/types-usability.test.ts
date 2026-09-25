// R2 "type usability": one hand-written literal per record kind, `satisfies` its generated type —
// a compile-time check (via `tsc -b` / `npm run typecheck`) that the generated types are actually
// usable and that discriminated unions (Intent.params, ExecutableOrderPlan.economic, ...) narrow
// the way callers need them to. Each literal is also run through the real ajv validator so a
// generated type that's silently drifted from the schema (too loose, wrong field) still fails
// somewhere instead of only ever being caught by eyeballing this file.

import { describe, expect, it } from 'vitest';
import type {
  AccountSnapshot,
  Authorization,
  ExchangeOrderObservation,
  ExecEvent,
  ExecPolicy,
  ExecutableOrderPlan,
  ExecutionAttempt,
  Fill,
  Intent,
  PositionEffect,
} from '../src/index.js';
import { validate } from '../src/index.js';

const intent = {
  schema_version: 1,
  intent_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  account: 'sub',
  principal: 'model',
  surface: 'model',
  session_id: 'main',
  run_id: 'run-20260902-0001',
  origin: 'recipe:w4-judgment',
  idempotency_key: 'run-20260902-0001:BTCUSDT:1',
  params: {
    kind: 'open',
    product: 'usdm_perp',
    symbol: 'BTCUSDT',
    side: 'buy',
    position_side: 'both',
    size: { mode: 'hint', hint: 'full' },
    entry: { type: 'limit', price: '60000.5', time_in_force: 'gtc', post_only: false },
    stop: { price: '59000', trigger: 'mark_price' },
    take_profits: [{ price: '62000', pct: '50', trigger: 'mark_price' }],
    leverage: 2,
    margin_type: 'isolated',
    thesis: '4h 结构回踩支撑,量能收缩',
    evidence_refs: ['T7.E1', 'T7.E3'],
    invalidation: '收盘跌破 58800',
  },
  status: 'awaiting_approval',
  gate_rejections: [],
  current_plan_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  ttl_seconds: 600,
  created_at: 1788350000000,
  updated_at: 1788350001000,
  expires_at: 1788350600000,
} satisfies Intent;

// Discriminated-union narrowing sanity check: since `params.kind === 'open'`, `stop` (only on
// OpenParams) must be accessible without a cast.
void (intent.params.kind === 'open' ? intent.params.stop.trigger : undefined);

const plan = {
  schema_version: 1,
  plan_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  intent_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  version: 1,
  plan_hash: '474838171b83561288f58fc3ebdaf96c236f5ff4983b1556cac37ee8cc22433c',
  account: 'sub',
  channel: 'mcp',
  economic: {
    kind: 'order',
    product: 'usdm_perp',
    symbol: 'BTCUSDT',
    side: 'buy',
    position_side: 'both',
    position_mode: 'one_way',
    order_type: 'limit',
    qty: '0.002',
    price: '60000.5',
    time_in_force: 'gtc',
    reduce_only: false,
    close_position: false,
    leverage: 2,
    margin_type: 'isolated',
    protection: {
      stop: { order_type: 'stop_market', trigger_price: '59000', working_type: 'mark_price', close_position: true },
      take_profits: [
        { order_type: 'take_profit_market', trigger_price: '62000', qty: '0.001', working_type: 'mark_price', close_position: false },
      ],
    },
    max_naked_seconds: 20,
  },
  basis: {
    filters: {
      tick_size: '0.1',
      step_size: '0.001',
      min_qty: '0.001',
      max_qty: '1000',
      min_notional: '100',
      price_precision: 1,
      qty_precision: 3,
      observed_at: 1788349990000,
    },
    sizing: {
      method: 'risk_pct_by_stop_distance',
      equity: '1000',
      risk_pct: '0.25',
      stop_distance: '1000.5',
      reference_price: '60000.5',
      raw_qty: '0.0024987',
      rounding: 'down',
    },
    account_version: 'a18c8380c8cef8e3ed2ef66ee6d39cfcf4bd56c0271e3f7fe810478e065ac7ab',
    market_ref: { mark_price: '60010.2', last_price: '60008.9', observed_at: 1788349999000 },
    position_mode_observed: 'one_way',
    policy_version: 3,
    notes: ['risk 0.25% × 1000 = 2.5 USDT'],
  },
  authorization_ttl_seconds: 120,
  created_at: 1788350001000,
  expires_at: 1788350601000,
} satisfies ExecutableOrderPlan;

// Narrowing: `economic.kind === 'order'` must expose OrderEconomics-only fields like `protection`.
void (plan.economic.kind === 'order' ? plan.economic.protection : undefined);

const authorization = {
  schema_version: 1,
  authorization_id: '16fd2706-8baf-433b-82eb-8c7fada847da',
  intent_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  plan_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  plan_hash: '474838171b83561288f58fc3ebdaf96c236f5ff4983b1556cac37ee8cc22433c',
  by: 'user',
  principal: 'user',
  surface: 'rpc',
  actor_ref: 'ws-conn:7f3a',
  status: 'consumed',
  confirm_echo: {
    plan_hash: '474838171b83561288f58fc3ebdaf96c236f5ff4983b1556cac37ee8cc22433c',
    symbol: 'BTCUSDT',
    side: 'buy',
    qty: '0.002',
    order_type: 'limit',
    price: '60000.5',
    leverage: '2',
    reduce_only: 'false',
  },
  granted_at: 1788350100000,
  expires_at: 1788350220000,
  consumed_at: 1788350105000,
  consumed_by_attempt_id: '9b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b',
} satisfies Authorization;

const attempt = {
  schema_version: 1,
  attempt_id: '9b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b',
  intent_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  plan_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  plan_hash: '474838171b83561288f58fc3ebdaf96c236f5ff4983b1556cac37ee8cc22433c',
  attempt_no: 1,
  leg: 'entry',
  leg_index: 0,
  account: 'sub',
  channel: 'mcp',
  client_order_id: 'tg-0f8fad5bd9cb-e0-1',
  order_fingerprint: '{"symbol":"BTCUSDT"}',
  writer_instance_id: 'execd-mba-2026',
  lease_epoch: 7,
  fencing_token: '7:execd-mba-2026:1788350105000',
  stage: 'result_persisted',
  result: 'acked',
  created_at: 1788350105000,
  submitted_at: 1788350105120,
  deadline_at: 1788350125000,
  result_at: 1788350105480,
  exchange_order_id: '8389765123456789',
  tool_name: 'futures_place_order',
  tools_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
} satisfies ExecutionAttempt;

const exchangeOrder = {
  schema_version: 1,
  observation_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  account: 'sub',
  channel: 'mcp',
  source: 'mcp',
  product: 'usdm_perp',
  symbol: 'BTCUSDT',
  exchange_order_id: '8389765123456789',
  client_order_id: 'tg-0f8fad5bd9cb-e0-1',
  status: 'partially_filled',
  side: 'buy',
  position_side: 'both',
  order_type: 'limit',
  orig_qty: '0.002',
  executed_qty: '0.001',
  avg_price: '60000.5',
  price: '60000.5',
  cum_quote: '60.0005',
  reduce_only: false,
  close_position: false,
  time_in_force: 'gtc',
  origin: 'local',
  attempt_id: '9b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b',
  exchange_update_time: 1788350106000,
  exchange_create_time: 1788350105400,
  observed_at: 1788350106200,
  raw_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
} satisfies ExchangeOrderObservation;

const fill = {
  schema_version: 1,
  fill_id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
  account: 'sub',
  channel: 'mcp',
  source: 'mcp',
  product: 'usdm_perp',
  symbol: 'BTCUSDT',
  exchange_order_id: '8389765123456789',
  trade_id: '557711223',
  client_order_id: 'tg-0f8fad5bd9cb-e0-1',
  attempt_id: '9b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b',
  side: 'buy',
  position_side: 'both',
  qty: '0.001',
  price: '60000.5',
  quote_qty: '60.0005',
  commission: '0.01200010',
  commission_asset: 'USDT',
  realized_pnl: '0',
  is_maker: true,
  trade_time: 1788350106000,
  observed_at: 1788350106200,
} satisfies Fill;

const positionEffect = {
  schema_version: 1,
  effect_id: 'c3d4e5f6-a7b8-4c9d-ae0f-2a3b4c5d6e7f',
  intent_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  plan_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  kind: 'open',
  account: 'sub',
  symbol: 'BTCUSDT',
  status: 'pending',
  target_qty: '0.002',
  filled_qty: '0.001',
  remaining_qty: '0.001',
  remaining_canceled: false,
  avg_fill_price: '60000.5',
  first_fill_at: 1788350106000,
  protection_required: true,
  protection_confirmed: true,
  protection_confirmed_at: 1788350108000,
  protection_order_ids: ['8389765123456790'],
  naked_seconds: 2,
  position_qty_after: '0.001',
  evaluated_at: 1788350110000,
} satisfies PositionEffect;

const accountSnapshot = {
  schema_version: 1,
  account: 'sub',
  channel: 'mcp',
  computed_at: 1788350000000,
  consistency: 'consistent',
  account_version: 'a18c8380c8cef8e3ed2ef66ee6d39cfcf4bd56c0271e3f7fe810478e065ac7ab',
  span_ms: 350,
  components: {
    balances: {
      observed_at: 1788349999900,
      fetched_from: 1788349999650,
      fetched_to: 1788349999900,
      completeness: 'complete',
      source: 'mcp',
      data: [{ asset: 'USDT', wallet: 'usdm_futures', wallet_balance: '1000.5', available: '900' }],
    },
    positions: {
      observed_at: 1788349999950,
      fetched_from: 1788349999700,
      fetched_to: 1788349999950,
      completeness: 'complete',
      source: 'mcp',
      data: [],
    },
    open_orders: {
      observed_at: 1788350000000,
      fetched_from: 1788349999800,
      fetched_to: 1788350000000,
      completeness: 'complete',
      source: 'mcp',
      data: [],
    },
    position_mode: {
      observed_at: 1788349999650,
      fetched_from: 1788349999600,
      fetched_to: 1788349999650,
      completeness: 'complete',
      source: 'mcp',
      data: { mode: 'one_way' },
    },
  },
  summary: {
    quote_asset: 'USDT',
    wallet_balance: '1000.5',
    margin_balance: '1000.5',
    available_balance: '900',
    unrealized_pnl: '0',
    open_position_count: 0,
    open_order_count: 0,
  },
} satisfies AccountSnapshot;

const execPolicy = {
  schema_version: 1,
  version: 3,
  updated_at: 1788340000000,
  mode: 'run',
  authority: 'draft',
  emergency_stop: false,
  live_capped_enabled: false,
  symbol_allowlist: ['BTCUSDT', 'ETHUSDT'],
  product_allowlist: ['usdm_perp'],
  caps: {
    max_leverage: 2,
    risk_pct_per_trade: '0.25',
    max_order_notional: '200',
    max_position_notional: '400',
    max_daily_opens: 2,
    daily_loss_stop_pct: '1',
    symbol_cooldown_seconds: 3600,
    max_naked_seconds: 20,
    account_truth_max_age_ms: 15000,
    market_max_age_ms: 5000,
    authorization_ttl_market_seconds: 30,
    authorization_ttl_limit_seconds: 120,
    max_price_deviation_bps: 55,
    ntp_drift_block_ms: 2000,
    ntp_drift_halt_ms: 10000,
  },
  main_account: { manual_trading_enabled: true, transfers_enabled: false, withdraw_enabled: false },
  canary: { enabled: false },
} satisfies ExecPolicy;

const execEvent = {
  schema_version: 1,
  seq: 4181,
  event: 'intent.awaiting_approval',
  at: 1788350001000,
  account: 'sub',
  intent_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  plan_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  symbol: 'BTCUSDT',
  payload: {
    status: 'awaiting_approval',
    plan_hash: '474838171b83561288f58fc3ebdaf96c236f5ff4983b1556cac37ee8cc22433c',
    authorization_ttl_seconds: 120,
  },
} satisfies ExecEvent;

const literals: [string, unknown][] = [
  ['intent', intent],
  ['plan', plan],
  ['authorization', authorization],
  ['attempt', attempt],
  ['exchange_order', exchangeOrder],
  ['fill', fill],
  ['position_effect', positionEffect],
  ['account_snapshot', accountSnapshot],
  ['policy', execPolicy],
  ['events', execEvent],
] as const;

describe('R2: hand-written literals satisfy their generated type AND pass ajv', () => {
  for (const [schemaName, value] of literals) {
    it(`${schemaName}`, () => {
      const result = validate(schemaName as Parameters<typeof validate>[0], value);
      expect(result.ok, `literal satisfies the TS type but failed ajv: ${result.ok ? '' : result.errors.join('; ')}`).toBe(true);
    });
  }
});
