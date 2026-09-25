//! Binance REST 适配器(主账户通道)。
//!
//! - [`rest`]:签名、服务器时间偏移、令牌桶、错误分类 —— 所有端点共用的底座;
//! - [`futures`]:USDⓈ-M 合约(`fapi`);
//! - [`spot_sapi`]:现货与主/子账户联动(`api` / `sapi`),A1 的重点。
//!
//! **不实现任何提币端点**(设计 §16 Q7:主账户 API key 默认不勾提币,
//! 提币走 Binance UI 深链)。

pub mod futures;
pub mod rest;
pub mod spot_sapi;

pub use futures::{
    FuturesApi, NewOrderRequest, OrderSide, OrderType, PositionMode, PositionSide, RespType,
    TimeInForce, WorkingType,
};
pub use rest::{BinanceRest, sign_payload, urlencode};
pub use spot_sapi::{AccountType, ApiRestrictions, SpotApi, SubAccount};
