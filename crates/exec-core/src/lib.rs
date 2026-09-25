//! exec-core —— trading-swarm 执行核心的 **REST/主账户** 半边(工作包 A1)。
//!
//! 代码来源:从 8794(`~/Desktop/trade-switch-dev-8793`,实盘基线)的
//! `console-core/src/exchanges/binance.rs`、`console-api/src/{account_stream,network,market}.rs`
//! **复制**后剥离 `console_types` / `TradingCore` 依赖独立演进(不引用、不回改那边)。
//! 逐条来源与删改清单见 `README.md`。
//!
//! 边界(AGENTS.md 硬规则):凭证只进 execd —— 本 crate 是唯一持有主账户
//! API key/secret 的地方;不实现任何提币端点(设计 §16 Q7:默认不勾提币,
//! 提币走 Binance UI 深链)。
//!
//! 对外结构约定:金额/价格/数量一律**十进制字符串**,时间戳一律 **unix 毫秒整数**,
//! JSON 字段 `snake_case`。

pub mod account_stream;
pub mod binance;
pub mod demo_exec;
pub mod error;
pub mod filters;
pub mod ids;
pub mod network;
pub mod ratelimit;
pub mod secrets;

pub use demo_exec::{DemoError, DemoErrorKind, DemoExec};
pub use error::{BinanceError, BinanceErrorKind};
pub use filters::{SymbolRules, allocate_lots, decimal_text};
pub use ids::{ClientOrderId, Leg, is_foreign, is_local};
pub use ratelimit::{RestGate, RestRateLimiter};
pub use secrets::{MainCredentials, SecretString};
