//! R4:Rust 构造"全字段"实例 → 本地 schema 校验(抓 Rust 多出的字段/类型错)→ 写到
//! `<repo>/target/roundtrip/<schema>/rust_*.json` 给 TS 侧用 ajv 再校验一次。
//!
//! 校验部分每次 `cargo test` 都跑;落盘部分是 `#[ignore]`(避免污染 target):
//! `CARGO_TARGET_DIR=target/a0-rust cargo test -p contracts-rs --test emit_roundtrip -- --ignored`

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use contracts_rs::account_snapshot::*;
use contracts_rs::enums::*;
use contracts_rs::intent::*;
use contracts_rs::plan::*;
use contracts_rs::records::*;
use contracts_rs::rpc::*;
use contracts_rs::scalars::*;
use contracts_rs::{account_version_of, plan_hash};
use serde::Serialize;
use serde_json::{Map, Value, json};

const T0: i64 = 1_788_350_000_000;

fn uuid(s: &str) -> Uuid {
    Uuid::new(s).unwrap()
}
fn dec(s: &str) -> Decimal {
    Decimal::new(s).unwrap()
}
fn udec(s: &str) -> UnsignedDecimal {
    UnsignedDecimal::new(s).unwrap()
}
fn sym(s: &str) -> Symbol {
    Symbol::new(s).unwrap()
}
fn asset(s: &str) -> Asset {
    Asset::new(s).unwrap()
}
fn coid(s: &str) -> ClientOrderId {
    ClientOrderId::new(s).unwrap()
}
fn hash(c: char) -> Hash256 {
    Hash256::new(std::iter::repeat_n(c, 64).collect::<String>()).unwrap()
}

fn intent_ids() -> (Uuid, Uuid, Uuid, Uuid) {
    (
        uuid("0f8fad5b-d9cb-469f-a165-70867728950e"),
        uuid("7c9e6679-7425-40de-944b-e07fc1f90ae7"),
        uuid("16fd2706-8baf-433b-82eb-8c7fada847da"),
        uuid("9b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b"),
    )
}

fn full_open_params() -> IntentParams {
    IntentParams::Open(OpenParams {
        product: Product::UsdmPerp,
        symbol: sym("BTCUSDT"),
        side: Side::Buy,
        position_side: Some(PositionSide::Long),
        size: SizeSpec::Qty { qty: udec("0.002") },
        entry: EntrySpec::Limit { price: udec("60000.5"), time_in_force: Some(TimeInForce::Gtx), post_only: Some(true) },
        stop: StopRef { price: udec("59000"), trigger: WorkingType::ContractPrice },
        take_profits: Some(vec![TakeProfitSpec { price: udec("62000"), pct: udec("50"), trigger: Some(WorkingType::MarkPrice) }]),
        leverage: Some(3),
        margin_type: Some(MarginType::Cross),
        thesis: Some("全字段实例".into()),
        evidence_refs: vec!["T1.E1".into()],
        invalidation: Some("跌破 58800".into()),
    })
}

fn full_intents() -> Vec<Intent> {
    let (iid, pid, aid, _) = intent_ids();
    let base = |params: IntentParams, status: IntentStatus| Intent {
        schema_version: 1,
        intent_id: iid.clone(),
        account: AccountRef::Sub,
        principal: Principal::Model,
        surface: Surface::Model,
        session_id: Some("main".into()),
        run_id: Some("run-1".into()),
        origin: Some("recipe:w4".into()),
        idempotency_key: Some("k1".into()),
        params,
        status,
        status_reason: Some("full".into()),
        gate_rejections: vec![GateRejection { gate: "policy.mode".into(), value: Some("halt_all".into()), limit: Some("run".into()), message: "m".into() }],
        current_plan_id: Some(pid.clone()),
        authorization_id: Some(aid.clone()),
        ttl_seconds: 600,
        created_at: T0,
        updated_at: T0,
        expires_at: Some(T0 + 1),
        terminal_at: Some(T0 + 2),
    };
    vec![
        base(full_open_params(), IntentStatus::AwaitingApproval),
        base(
            IntentParams::Open(OpenParams {
                product: Product::UsdmPerp,
                symbol: sym("ETHUSDT"),
                side: Side::Sell,
                position_side: None,
                size: SizeSpec::Notional { notional: udec("100") },
                entry: EntrySpec::Market { max_slippage_bps: Some(20) },
                stop: StopRef { price: udec("3100"), trigger: WorkingType::MarkPrice },
                take_profits: None,
                leverage: None,
                margin_type: None,
                thesis: None,
                evidence_refs: vec![],
                invalidation: None,
            }),
            IntentStatus::Proposed,
        ),
        base(
            IntentParams::Close(CloseParams {
                product: Product::UsdmPerp,
                symbol: sym("ETHUSDT"),
                position_side: Some(PositionSide::Short),
                pct: udec("50"),
                order: EntrySpec::Limit { price: udec("2950"), time_in_force: Some(TimeInForce::Ioc), post_only: Some(false) },
                reason: Some("r".into()),
                evidence_refs: Some(vec!["T2.E1".into()]),
            }),
            IntentStatus::Executing,
        ),
        base(
            IntentParams::CancelOrder(CancelOrderParams {
                product: Product::Spot,
                symbol: sym("BTCUSDT"),
                order_ref: OrderRef { exchange_order_id: Some("123".into()), client_order_id: Some(coid("tg-0f8fad5bd9cb-e0-1")) },
                reason: Some("r".into()),
            }),
            IntentStatus::ExecutionUnknown,
        ),
        base(
            IntentParams::Protect(ProtectParams {
                product: Product::UsdmPerp,
                symbol: sym("SOLUSDT"),
                position_side: Some(PositionSide::Both),
                stop: Some(StopRef { price: udec("150.25"), trigger: WorkingType::MarkPrice }),
                take_profits: Some(vec![TakeProfitSpec { price: udec("170"), pct: udec("100"), trigger: None }]),
                replace: true,
                reason: Some("r".into()),
            }),
            IntentStatus::Completed,
        ),
        base(
            IntentParams::Transfer(TransferParams {
                asset: asset("USDT"),
                amount: udec("25"),
                from_account: AccountRef::Main,
                from_wallet: Wallet::Spot,
                to_account: AccountRef::Sub,
                to_wallet: Wallet::UsdmFutures,
                reason: Some("注资".into()),
            }),
            IntentStatus::Recorded,
        ),
    ]
}

fn full_leg(order_type: ProtectionOrderType, close_position: bool) -> ProtectionLeg {
    ProtectionLeg {
        order_type,
        trigger_price: udec("59000"),
        price: Some(udec("58990")),
        qty: if close_position { None } else { Some(udec("0.001")) },
        working_type: WorkingType::MarkPrice,
        close_position,
    }
}

fn full_plans() -> Vec<ExecutableOrderPlan> {
    let (iid, pid, _, _) = intent_ids();
    let make = |economic: PlanEconomics| {
        let ph = plan_hash(&economic).unwrap();
        ExecutableOrderPlan {
            schema_version: 1,
            plan_id: pid.clone(),
            intent_id: iid.clone(),
            version: 2,
            plan_hash: ph,
            account: AccountRef::Sub,
            channel: Channel::Mcp,
            economic,
            basis: PlanBasis {
                filters: Some(SymbolFilters {
                    tick_size: udec("0.1"),
                    step_size: udec("0.001"),
                    min_qty: udec("0.001"),
                    max_qty: Some(udec("1000")),
                    min_notional: udec("100"),
                    price_precision: Some(1),
                    qty_precision: Some(3),
                    observed_at: T0,
                }),
                sizing: Some(SizingBasis {
                    method: SizingMethod::RiskPctByStopDistance,
                    equity: Some(udec("1000")),
                    risk_pct: Some(udec("0.25")),
                    stop_distance: Some(udec("1000.5")),
                    reference_price: Some(udec("60000.5")),
                    position_qty_before: Some(dec("-0.5")),
                    raw_qty: udec("0.0024987"),
                    rounding: Rounding::Down,
                }),
                account_version: Some(hash('a')),
                market_ref: Some(MarketRef { mark_price: Some(udec("60010.2")), last_price: Some(udec("60008.9")), observed_at: T0 }),
                position_mode_observed: Some(PositionMode::Hedge),
                policy_version: Some(3),
                notes: vec!["n".into()],
            },
            authorization_ttl_seconds: 120,
            created_at: T0,
            expires_at: T0 + 600_000,
        }
    };
    vec![
        make(PlanEconomics::Order(OrderEconomics {
            product: Product::UsdmPerp,
            symbol: sym("BTCUSDT"),
            side: Side::Buy,
            position_side: PositionSide::Long,
            position_mode: PositionMode::Hedge,
            order_type: OrderType::StopLimit,
            qty: udec("0.002"),
            price: Some(udec("60000.5")),
            time_in_force: Some(TimeInForce::Gtc),
            reduce_only: false,
            close_position: false,
            leverage: Some(2),
            margin_type: Some(MarginType::Isolated),
            trigger_price: Some(udec("60100")),
            working_type: Some(WorkingType::ContractPrice),
            protection: Protection {
                stop: Some(full_leg(ProtectionOrderType::StopMarket, true)),
                take_profits: vec![full_leg(ProtectionOrderType::TakeProfitLimit, false), full_leg(ProtectionOrderType::TakeProfitMarket, false)],
            },
            max_naked_seconds: 20,
        })),
        make(PlanEconomics::Protect(ProtectEconomics {
            product: Product::UsdmPerp,
            symbol: sym("ETHUSDT"),
            position_side: PositionSide::Both,
            legs: vec![full_leg(ProtectionOrderType::StopLimit, false)],
            replace_order_ids: vec!["1".into(), "2".into()],
        })),
        make(PlanEconomics::Cancel(CancelEconomics {
            product: Product::Spot,
            symbol: sym("ETHUSDT"),
            exchange_order_id: Some("123".into()),
            client_order_id: Some(coid("tg-0f8fad5bd9cb-e0-1")),
        })),
        make(PlanEconomics::Transfer(TransferEconomics {
            asset: asset("USDT"),
            amount: udec("25"),
            from_account: AccountRef::Sub,
            from_wallet: Wallet::UsdmFutures,
            to_account: AccountRef::Main,
            to_wallet: Wallet::Spot,
        })),
    ]
}

fn full_authorization() -> Authorization {
    let (iid, pid, aid, atid) = intent_ids();
    let mut echo = BTreeMap::new();
    echo.insert("plan_hash".to_string(), "a".repeat(64));
    echo.insert("symbol".to_string(), "BTCUSDT".to_string());
    Authorization {
        schema_version: 1,
        authorization_id: aid,
        intent_id: iid,
        plan_id: pid,
        plan_hash: hash('a'),
        by: AuthorizedBy::User,
        principal: Some(Principal::User),
        surface: Some(Surface::Rpc),
        actor_ref: Some("ws:1".into()),
        status: AuthorizationStatus::Consumed,
        status_reason: Some("r".into()),
        confirm_echo: Some(echo),
        granted_at: T0,
        expires_at: T0 + 120_000,
        consumed_at: Some(T0 + 1),
        consumed_by_attempt_id: Some(atid),
    }
}

fn full_attempt() -> ExecutionAttempt {
    let (iid, pid, _, atid) = intent_ids();
    ExecutionAttempt {
        schema_version: 1,
        attempt_id: atid,
        intent_id: iid,
        plan_id: pid,
        plan_hash: hash('a'),
        attempt_no: 1,
        leg: Leg::TakeProfit,
        leg_index: 1,
        account: AccountRef::Main,
        channel: Channel::Rest,
        client_order_id: coid("tg-0f8fad5bd9cb-t1-1"),
        order_fingerprint: "{}".into(),
        writer_instance_id: "w".into(),
        lease_epoch: 7,
        fencing_token: "7:w:1".into(),
        stage: AttemptStage::ResultPersisted,
        result: AttemptResult::Unknown,
        created_at: T0,
        submitted_at: Some(T0 + 1),
        deadline_at: T0 + 20_000,
        result_at: Some(T0 + 2),
        exchange_order_id: Some("999".into()),
        exchange_ref: Some("tran-1".into()),
        error: Some(ErrorInfo { kind: ErrorKind::TransportAmbiguous, message: "timeout".into(), retryable: false, exchange_code: Some(-1007), http_status: Some(504) }),
        tool_name: Some("futures_place_order".into()),
        tools_hash: Some(hash('b')),
    }
}

fn full_order() -> ExchangeOrderObservation {
    let (_, _, _, atid) = intent_ids();
    ExchangeOrderObservation {
        schema_version: 1,
        observation_id: uuid("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"),
        account: AccountRef::Sub,
        channel: Channel::Mcp,
        source: ObservationSource::Cache,
        product: Product::UsdmPerp,
        symbol: sym("BTCUSDT"),
        exchange_order_id: "1".into(),
        client_order_id: Some(coid("tg-0f8fad5bd9cb-e0-1")),
        status: ExchangeOrderStatus::PartiallyFilled,
        side: Side::Buy,
        position_side: PositionSide::Both,
        order_type: OrderType::TrailingStopMarket,
        orig_qty: udec("0.002"),
        executed_qty: udec("0.001"),
        avg_price: Some(udec("60000.5")),
        price: Some(udec("60000.5")),
        stop_price: Some(udec("59000")),
        cum_quote: Some(udec("60.0005")),
        reduce_only: false,
        close_position: Some(false),
        time_in_force: Some(TimeInForce::Fok),
        working_type: Some(WorkingType::MarkPrice),
        origin: OrderOrigin::Local,
        attempt_id: Some(atid),
        exchange_update_time: Some(T0),
        exchange_create_time: Some(T0),
        observed_at: T0,
        raw_hash: Some(hash('c')),
    }
}

fn full_fill() -> Fill {
    let (_, _, _, atid) = intent_ids();
    Fill {
        schema_version: 1,
        fill_id: uuid("b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e"),
        account: AccountRef::Sub,
        channel: Channel::Mcp,
        source: ObservationSource::Mcp,
        product: Product::UsdmPerp,
        symbol: sym("BTCUSDT"),
        exchange_order_id: "1".into(),
        trade_id: "t1".into(),
        client_order_id: Some(coid("tg-0f8fad5bd9cb-e0-1")),
        attempt_id: Some(atid),
        side: Side::Buy,
        position_side: Some(PositionSide::Both),
        qty: udec("0.001"),
        price: udec("60000.5"),
        quote_qty: Some(udec("60.0005")),
        commission: Some(dec("0.012")),
        commission_asset: Some(asset("USDT")),
        realized_pnl: Some(dec("-1.5")),
        is_maker: Some(true),
        trade_time: T0,
        observed_at: T0,
    }
}

fn full_effect() -> PositionEffect {
    let (iid, pid, _, atid) = intent_ids();
    PositionEffect {
        schema_version: 1,
        effect_id: uuid("c3d4e5f6-a7b8-4c9d-ae0f-2a3b4c5d6e7f"),
        intent_id: iid,
        plan_id: pid,
        kind: IntentKind::Open,
        account: AccountRef::Sub,
        symbol: Some(sym("BTCUSDT")),
        status: EffectStatus::Failed,
        target_qty: Some(udec("0.002")),
        filled_qty: udec("0.002"),
        remaining_qty: udec("0"),
        remaining_canceled: true,
        avg_fill_price: Some(udec("60000.5")),
        first_fill_at: Some(T0),
        protection_required: true,
        protection_confirmed: false,
        protection_confirmed_at: Some(T0),
        protection_order_ids: vec!["2".into()],
        naked_seconds: Some(21),
        compensation_close_attempt_id: Some(atid),
        position_qty_after: Some(dec("0")),
        exchange_ref: Some("x".into()),
        failure_reason: Some("naked".into()),
        evaluated_at: T0,
    }
}

fn component<T>(data: T) -> Component<T> {
    Component {
        observed_at: T0,
        fetched_from: T0 - 10,
        fetched_to: T0,
        completeness: Completeness::Complete,
        source: ObservationSource::Rest,
        error: Some(ErrorInfo { kind: ErrorKind::Stale, message: "m".into(), retryable: true, exchange_code: None, http_status: None }),
        data: Some(data),
    }
}

fn full_snapshot() -> AccountSnapshot {
    let mut snap = AccountSnapshot {
        schema_version: 1,
        account: AccountRef::Main,
        channel: Channel::Rest,
        computed_at: T0,
        consistency: Consistency::Consistent,
        consistency_reason: Some("ok".into()),
        account_version: None,
        span_ms: Some(10),
        components: AccountComponents {
            balances: component(vec![BalanceRow { asset: asset("USDT"), wallet: Wallet::UsdmFutures, wallet_balance: dec("1000.5"), available: dec("900"), unrealized_pnl: Some(dec("-1")) }]),
            positions: component(vec![PositionRow {
                symbol: sym("ETHUSDT"),
                product: Product::UsdmPerp,
                position_side: PositionSide::Both,
                qty: dec("-0.5"),
                entry_price: udec("2950.4"),
                mark_price: Some(udec("2975.4")),
                unrealized_pnl: Some(dec("-12.5")),
                leverage: Some(3),
                margin_type: Some(MarginType::Isolated),
                isolated_margin: Some(dec("491.7")),
                liquidation_price: Some(udec("3890.2")),
                notional: Some(dec("-1487.7")),
                exchange_update_time: Some(T0),
            }]),
            open_orders: component(vec![OrderRow {
                exchange_order_id: "1".into(),
                client_order_id: Some(coid("web_abc")),
                symbol: sym("ETHUSDT"),
                product: Product::UsdmPerp,
                side: Side::Buy,
                position_side: PositionSide::Both,
                order_type: OrderType::StopMarket,
                status: ExchangeOrderStatus::New,
                orig_qty: udec("0.5"),
                executed_qty: udec("0"),
                avg_price: Some(udec("0")),
                price: Some(udec("0")),
                stop_price: Some(udec("3100")),
                reduce_only: true,
                close_position: Some(true),
                time_in_force: Some(TimeInForce::Gtc),
                working_type: Some(WorkingType::MarkPrice),
                origin: OrderOrigin::Foreign,
                exchange_update_time: Some(T0),
                exchange_create_time: Some(T0),
            }]),
            position_mode: component(PositionModeData { mode: PositionMode::OneWay }),
            recent_fills: Some(component(vec![FillRow {
                trade_id: "t".into(),
                exchange_order_id: "1".into(),
                client_order_id: Some(coid("web_abc")),
                symbol: sym("ETHUSDT"),
                product: Product::UsdmPerp,
                side: Side::Sell,
                position_side: Some(PositionSide::Both),
                qty: udec("0.5"),
                price: udec("2950.4"),
                quote_qty: Some(udec("1475.2")),
                commission: Some(dec("0.59")),
                commission_asset: Some(asset("USDT")),
                realized_pnl: Some(dec("0")),
                is_maker: Some(false),
                trade_time: T0,
            }])),
            order_history: Some(component(vec![])),
            margin: Some(component(MarginInfo { margin_ratio: Some(udec("0.05")), maintenance_margin: Some(udec("10")), margin_balance: Some(dec("2487.5")), available_balance: Some(dec("2100.25")) })),
        },
        summary: Some(AccountSummary {
            quote_asset: asset("USDT"),
            wallet_balance: dec("2500"),
            margin_balance: Some(dec("2487.5")),
            available_balance: dec("2100.25"),
            unrealized_pnl: dec("-12.5"),
            today_realized_pnl: Some(dec("3.2")),
            open_position_count: 1,
            open_order_count: 1,
        }),
    };
    snap.account_version = account_version_of(&snap).unwrap();
    snap
}

fn full_policy() -> ExecPolicy {
    ExecPolicy {
        schema_version: 1,
        version: 4,
        updated_at: T0,
        mode: PolicyMode::HaltAll,
        authority: Authority::LiveCapped,
        emergency_stop: true,
        live_capped_enabled: false,
        symbol_allowlist: vec![sym("BTCUSDT")],
        product_allowlist: vec![Product::UsdmPerp, Product::Spot],
        caps: Caps {
            max_leverage: 2,
            risk_pct_per_trade: udec("0.25"),
            max_order_notional: udec("200"),
            max_position_notional: udec("400"),
            max_daily_opens: 2,
            daily_loss_stop_pct: udec("1"),
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
        main_account: MainAccountPolicy { manual_trading_enabled: true, transfers_enabled: true, withdraw_enabled: false },
        canary: CanaryPolicy { enabled: true, max_loss_quote: Some(udec("30")), max_notional_quote: Some(udec("150")), max_leverage: Some(2), funded_balance_quote: Some(udec("100")) },
    }
}

fn full_event() -> ExecEvent {
    let (iid, pid, _, atid) = intent_ids();
    let mut payload = Map::new();
    payload.insert("status".into(), json!("awaiting_approval"));
    ExecEvent {
        schema_version: 1,
        seq: 42,
        event: EventName::IntentAwaitingApproval,
        at: T0,
        account: Some(AccountRef::Sub),
        intent_id: Some(iid),
        plan_id: Some(pid),
        attempt_id: Some(atid),
        symbol: Some(sym("BTCUSDT")),
        payload,
    }
}

fn full_rpc_frames() -> Vec<RpcFrame> {
    let mut params = Map::new();
    params.insert("account".into(), json!("sub"));
    let mut result = Map::new();
    result.insert("ok".into(), json!(true));
    let mut details = Map::new();
    details.insert("expected".into(), json!("a".repeat(64)));
    vec![
        RpcFrame::Request(RpcRequest { jsonrpc: JsonRpcVersion, id: RpcId::Str("r1".into()), method: Method::AccountSnapshot, params }),
        RpcFrame::Success(RpcSuccess { jsonrpc: JsonRpcVersion, id: RpcId::Num(7), result }),
        RpcFrame::Failure(RpcFailure { jsonrpc: JsonRpcVersion, id: None, error: RpcError::from_kind(ErrorKind::Conflict, "c").with_details(details) }),
        RpcFrame::Notification(RpcNotification { jsonrpc: JsonRpcVersion, method: EventMethod, params: full_event() }),
    ]
}

/// (schema 名, 实例列表)
fn all_full_instances() -> Vec<(&'static str, Vec<Value>)> {
    fn vals<T: Serialize>(items: Vec<T>) -> Vec<Value> {
        items.into_iter().map(|x| serde_json::to_value(x).unwrap()).collect()
    }
    vec![
        ("intent", vals(full_intents())),
        ("plan", vals(full_plans())),
        ("authorization", vals(vec![full_authorization()])),
        ("attempt", vals(vec![full_attempt()])),
        ("exchange_order", vals(vec![full_order()])),
        ("fill", vals(vec![full_fill()])),
        ("position_effect", vals(vec![full_effect()])),
        ("account_snapshot", vals(vec![full_snapshot()])),
        ("policy", vals(vec![full_policy()])),
        ("events", vals(vec![full_event()])),
        ("rpc", vals(full_rpc_frames())),
    ]
}

#[test]
fn full_field_instances_pass_schema_locally() {
    let validators = common::all_validators();
    for (schema, instances) in all_full_instances() {
        let validator = &validators[schema];
        for (i, instance) in instances.iter().enumerate() {
            let errors = common::schema_errors(validator, instance);
            assert!(errors.is_empty(), "{schema}[{i}] Rust 全字段实例不过 schema:\n{}\n{instance}", errors.join("\n"));
            assert!(!instance.to_string().contains(":null") || schema == "rpc", "{schema}[{i}] 输出了 null");
        }
    }
}

/// 落盘给 TS 侧(R4 的另一半)。
#[test]
#[ignore]
fn emit_roundtrip() {
    let root: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/roundtrip");
    for (schema, instances) in all_full_instances() {
        let dir = root.join(schema);
        fs::create_dir_all(&dir).unwrap();
        for (i, instance) in instances.iter().enumerate() {
            let path = dir.join(format!("rust_full_{i}.json"));
            fs::write(&path, serde_json::to_string_pretty(instance).unwrap() + "\n").unwrap();
        }
    }
    // 最小实例:直接复用 fixtures 里最小的那份(Rust 读入再吐出)
    let minimal = common::fixture_files("intent");
    if let Some((_, text)) = minimal.iter().find(|(n, _)| n.contains("minimal")) {
        let intent: Intent = serde_json::from_str(text).unwrap();
        fs::write(root.join("intent/rust_minimal.json"), serde_json::to_string_pretty(&intent).unwrap() + "\n").unwrap();
    }
    println!("roundtrip 产物写到 {}", root.display());
}
