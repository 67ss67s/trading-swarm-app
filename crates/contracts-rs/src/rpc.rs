//! `rpc.json` —— gateway ↔ execd 的 UDS JSON-RPC 2.0 契约(NDJSON 帧,单帧 ≤ 4 MiB)。

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::account_snapshot::AccountSnapshot;
use crate::enums::{AccountRef, ErrorKind, GateRejection, IntentKind, IntentStatus, PolicyMode, Principal, Surface};
use crate::intent::{Intent, IntentParams};
use crate::plan::ExecutableOrderPlan;
use crate::records::{Authorization, ExchangeOrderObservation, ExecEvent, ExecPolicy, ExecutionAttempt, Fill, PositionEffect};
use crate::scalars::{Hash256, TimestampMs, Uuid};

/// 单帧上限(README §8)。
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
/// execd → gateway 唯一的通知方法名。
pub const EVENT_METHOD: &str = "exec.event";

// ---------------------------------------------------------------------------
// 帧
// ---------------------------------------------------------------------------

/// 常量 `"2.0"`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct JsonRpcVersion;

impl Serialize for JsonRpcVersion {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str("2.0")
    }
}

impl<'de> Deserialize<'de> for JsonRpcVersion {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = String::deserialize(d)?;
        if v == "2.0" { Ok(JsonRpcVersion) } else { Err(serde::de::Error::custom(format!("jsonrpc 必须是 \"2.0\",实得 {v:?}"))) }
    }
}

/// 请求 id:字符串(1..64)或非负整数。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcId {
    Num(u64),
    Str(String),
}

impl fmt::Display for RpcId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RpcId::Num(n) => write!(f, "{n}"),
            RpcId::Str(s) => f.write_str(s),
        }
    }
}

macro_rules! methods {
    ($($variant:ident => $text:literal),+ $(,)?) => {
        /// `rpc.json#/$defs/Method`。
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum Method {
            $( #[serde(rename = $text)] $variant ),+
        }

        impl Method {
            pub const ALL: &'static [Method] = &[$(Method::$variant),+];
            pub fn as_str(self) -> &'static str {
                match self { $(Method::$variant => $text),+ }
            }
            pub fn parse(text: &str) -> Option<Self> {
                match text { $($text => Some(Method::$variant)),+, _ => None }
            }
        }

        impl fmt::Display for Method {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

methods!(
    Health => "exec.health",
    IntentPropose => "exec.intent.propose",
    IntentGet => "exec.intent.get",
    IntentList => "exec.intent.list",
    IntentAuthorize => "exec.intent.authorize",
    IntentReject => "exec.intent.reject",
    AccountSnapshot => "exec.account.snapshot",
    ExchangeStatus => "exec.exchange.status",
    PolicyGet => "exec.policy.get",
    PolicySet => "exec.policy.set",
    EmergencyStop => "exec.emergency_stop",
    EventsSubscribe => "exec.events.subscribe",
    OauthStart => "exec.oauth.start",
    OauthStatus => "exec.oauth.status",
    OauthRevoke => "exec.oauth.revoke",
    CredentialsPublicKey => "exec.credentials.public_key",
    CredentialsSet => "exec.credentials.set",
    CredentialsStatus => "exec.credentials.status",
);

impl Method {
    /// 写类方法:超时不等于失败,调用方必须回查(README §8)。
    pub fn is_write(self) -> bool {
        matches!(
            self,
            Method::IntentPropose
                | Method::IntentAuthorize
                | Method::IntentReject
                | Method::PolicySet
                | Method::EmergencyStop
                | Method::OauthStart
                | Method::OauthRevoke
                | Method::CredentialsSet
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcRequest {
    pub jsonrpc: JsonRpcVersion,
    pub id: RpcId,
    pub method: Method,
    pub params: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcSuccess {
    pub jsonrpc: JsonRpcVersion,
    pub id: RpcId,
    pub result: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcErrorData {
    pub kind: ErrorKind,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: RpcErrorData,
}

impl RpcError {
    /// 按 ErrorKind 构造(code 与默认 retryable 查表)。
    pub fn from_kind(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            code: kind.code(),
            message: message.into(),
            data: RpcErrorData { kind, retryable: kind.retryable_default(), details: None },
        }
    }

    pub fn with_details(mut self, details: Map<String, Value>) -> Self {
        self.data.details = Some(details);
        self
    }

    pub fn with_retryable(mut self, retryable: bool) -> Self {
        self.data.retryable = retryable;
        self
    }

    /// JSON-RPC 标准错误(解析失败/非法请求/未知方法)。
    pub fn standard(code: i64, message: impl Into<String>) -> Self {
        let kind = ErrorKind::from_code(code).unwrap_or(ErrorKind::Internal);
        Self { code, message: message.into(), data: RpcErrorData { kind, retryable: false, details: None } }
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{} {}] {}", self.code, self.data.kind, self.message)
    }
}

impl std::error::Error for RpcError {}

/// `id` 可为 null(解析失败时);这是契约里**唯一**允许输出 null 的地方。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcFailure {
    pub jsonrpc: JsonRpcVersion,
    pub id: Option<RpcId>,
    pub error: RpcError,
}

/// 常量 `"exec.event"`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EventMethod;

impl Serialize for EventMethod {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(EVENT_METHOD)
    }
}

impl<'de> Deserialize<'de> for EventMethod {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = String::deserialize(d)?;
        if v == EVENT_METHOD { Ok(EventMethod) } else { Err(serde::de::Error::custom(format!("通知方法只能是 {EVENT_METHOD:?},实得 {v:?}"))) }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcNotification {
    pub jsonrpc: JsonRpcVersion,
    pub method: EventMethod,
    pub params: ExecEvent,
}

/// 一行 NDJSON 里可能出现的四种帧。反序列化按字段存在性判别:
/// `method`+`id` → Request;`method` 无 `id` → Notification;`result` → Success;`error` → Failure。
#[derive(Debug, Clone, PartialEq)]
pub enum RpcFrame {
    Request(RpcRequest),
    Success(RpcSuccess),
    Failure(RpcFailure),
    Notification(RpcNotification),
}

impl Serialize for RpcFrame {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            RpcFrame::Request(x) => x.serialize(s),
            RpcFrame::Success(x) => x.serialize(s),
            RpcFrame::Failure(x) => x.serialize(s),
            RpcFrame::Notification(x) => x.serialize(s),
        }
    }
}

impl<'de> Deserialize<'de> for RpcFrame {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(d)?;
        RpcFrame::from_value(value).map_err(serde::de::Error::custom)
    }
}

impl RpcFrame {
    pub fn from_value(value: Value) -> Result<Self, String> {
        let Some(obj) = value.as_object() else {
            return Err("帧必须是 JSON 对象".into());
        };
        let has = |k: &str| obj.contains_key(k);
        let frame = if has("method") {
            if has("id") {
                RpcFrame::Request(serde_json::from_value(value).map_err(|e| format!("Request 不合法:{e}"))?)
            } else {
                RpcFrame::Notification(serde_json::from_value(value).map_err(|e| format!("Notification 不合法:{e}"))?)
            }
        } else if has("result") {
            RpcFrame::Success(serde_json::from_value(value).map_err(|e| format!("Success 不合法:{e}"))?)
        } else if has("error") {
            RpcFrame::Failure(serde_json::from_value(value).map_err(|e| format!("Failure 不合法:{e}"))?)
        } else {
            return Err("帧既没有 method 也没有 result/error".into());
        };
        Ok(frame)
    }

    pub fn id(&self) -> Option<&RpcId> {
        match self {
            RpcFrame::Request(x) => Some(&x.id),
            RpcFrame::Success(x) => Some(&x.id),
            RpcFrame::Failure(x) => x.id.as_ref(),
            RpcFrame::Notification(_) => None,
        }
    }
}

// ---------------------------------------------------------------------------
// NDJSON 编解码
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CodecError {
    #[error("帧超过 {max} 字节上限(至少 {bytes} 字节)")]
    FrameTooLarge { bytes: usize, max: usize },
    #[error("帧不是合法 JSON:{0}")]
    InvalidJson(String),
    #[error("序列化失败:{0}")]
    Serialize(String),
}

/// 一帧 = 紧凑 JSON + `\n`。
pub fn encode_frame<T: Serialize>(frame: &T) -> Result<Vec<u8>, CodecError> {
    let mut bytes = serde_json::to_vec(frame).map_err(|e| CodecError::Serialize(e.to_string()))?;
    if bytes.len() + 1 > MAX_FRAME_BYTES {
        return Err(CodecError::FrameTooLarge { bytes: bytes.len() + 1, max: MAX_FRAME_BYTES });
    }
    bytes.push(b'\n');
    Ok(bytes)
}

/// 增量按行切帧;空行跳过;单帧超限报错(调用方应断开连接)。
#[derive(Debug, Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
    max: usize,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self { buf: Vec::new(), max: MAX_FRAME_BYTES }
    }

    pub fn with_max(max: usize) -> Self {
        Self { buf: Vec::new(), max }
    }

    /// 喂入一段字节;若当前未闭合的行已超限立即报错。
    pub fn push(&mut self, chunk: &[u8]) -> Result<(), CodecError> {
        self.buf.extend_from_slice(chunk);
        let pending = match self.buf.iter().rposition(|b| *b == b'\n') {
            Some(pos) => self.buf.len() - pos - 1,
            None => self.buf.len(),
        };
        if pending > self.max {
            return Err(CodecError::FrameTooLarge { bytes: pending, max: self.max });
        }
        Ok(())
    }

    /// 取出下一完整帧(JSON Value);没有完整行返回 Ok(None)。
    pub fn next_frame(&mut self) -> Result<Option<Value>, CodecError> {
        loop {
            let Some(pos) = self.buf.iter().position(|b| *b == b'\n') else {
                return Ok(None);
            };
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let line = &line[..line.len() - 1];
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if line.iter().all(|b| b.is_ascii_whitespace()) {
                continue;
            }
            if line.len() > self.max {
                return Err(CodecError::FrameTooLarge { bytes: line.len(), max: self.max });
            }
            return serde_json::from_slice::<Value>(line).map(Some).map_err(|e| CodecError::InvalidJson(e.to_string()));
        }
    }

    /// 取出当前全部完整帧。
    pub fn drain_frames(&mut self) -> Result<Vec<Value>, CodecError> {
        let mut out = Vec::new();
        while let Some(frame) = self.next_frame()? {
            out.push(frame);
        }
        Ok(out)
    }

    pub fn pending_bytes(&self) -> usize {
        self.buf.len()
    }
}

// ---------------------------------------------------------------------------
// 方法 params / result
// ---------------------------------------------------------------------------

/// 空 params(`{}`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelState {
    Ok,
    Degraded,
    Down,
    Unconfigured,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelHealth {
    pub state: ChannelState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_ok_at: Option<TimestampMs>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Channels {
    pub main: ChannelHealth,
    pub sub: ChannelHealth,
}

pub type HealthParams = Empty;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HealthResult {
    pub ok: bool,
    pub version: String,
    pub writer_instance_id: String,
    pub lease_epoch: u64,
    pub started_at: TimestampMs,
    pub now: TimestampMs,
    pub db_ok: bool,
    pub mode: PolicyMode,
    pub halted: bool,
    pub open_intents: u32,
    pub unknown_attempts: u32,
    pub channels: Channels,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntentProposeParams {
    pub account: AccountRef,
    pub principal: Principal,
    pub surface: Surface,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    pub params: IntentParams,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntentProposeResult {
    pub intent: Intent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<ExecutableOrderPlan>,
    pub gate_rejections: Vec<GateRejection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntentGetParams {
    pub intent_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntentBundle {
    pub intent: Intent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<ExecutableOrderPlan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization: Option<Authorization>,
    pub attempts: Vec<ExecutionAttempt>,
    pub orders: Vec<ExchangeOrderObservation>,
    pub fills: Vec<Fill>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect: Option<PositionEffect>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntentListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Vec<IntentStatus>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<AccountRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<IntentKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<TimestampMs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntentListResult {
    pub intents: Vec<Intent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntentAuthorizeParams {
    pub intent_id: Uuid,
    pub plan_hash: Hash256,
    pub principal: Principal,
    pub surface: Surface,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_ref: Option<String>,
    pub confirm_echo: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntentAuthorizeResult {
    pub intent: Intent,
    pub authorization: Authorization,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntentRejectParams {
    pub intent_id: Uuid,
    pub reason: String,
    pub principal: Principal,
    pub surface: Surface,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntentRejectResult {
    pub intent: Intent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountSnapshotParams {
    pub account: AccountRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_age_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force_refresh: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountSnapshotResult {
    pub snapshot: AccountSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OauthState {
    Missing,
    Fresh,
    Expiring,
    Expired,
    Revoked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OauthStatus {
    pub state: OauthState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<TimestampMs>,
    pub has_refresh: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scopes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub obtained_at: Option<TimestampMs>,
}

impl OauthStatus {
    pub fn missing() -> Self {
        Self { state: OauthState::Missing, expires_at: None, has_refresh: false, scopes: None, client_id: None, obtained_at: None }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MainKeyPermissions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reading: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spot_margin_trading: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub futures: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub universal_transfer: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub withdrawals: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ip_restricted: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UserStreamState {
    Connected,
    Stale,
    Disconnected,
    Unconfigured,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestGateState {
    Ready,
    Wait,
    Banned,
    Unconfigured,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MainChannelStatus {
    pub configured: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<MainKeyPermissions>,
    pub user_stream: UserStreamState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_offset_ms: Option<i64>,
    pub rest_gate: RestGateState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_verified_at: Option<TimestampMs>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpSessionState {
    Active,
    None,
    Lost,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubChannelStatus {
    pub configured: bool,
    pub oauth: OauthStatus,
    pub mcp_session: McpSessionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_hash: Option<Hash256>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_pinned_hash: Option<Hash256>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_count: Option<u32>,
    pub drift: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subaccount_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WriterInfo {
    pub instance_id: String,
    pub lease_epoch: u64,
    pub since: TimestampMs,
}

pub type ExchangeStatusParams = Empty;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExchangeStatusResult {
    pub main: MainChannelStatus,
    pub sub: SubChannelStatus,
    pub writer: WriterInfo,
}

pub type PolicyGetParams = Empty;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyGetResult {
    pub policy: ExecPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyConfirm {
    pub mode: String,
    pub authority: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicySetParams {
    pub policy: ExecPolicy,
    pub confirm: PolicyConfirm,
    pub principal: Principal,
    pub surface: Surface,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicySetResult {
    pub policy: ExecPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmergencyMode {
    StopOpening,
    FlattenOnly,
    HaltAll,
}

impl EmergencyMode {
    pub fn as_policy_mode(self) -> PolicyMode {
        match self {
            EmergencyMode::StopOpening => PolicyMode::StopOpening,
            EmergencyMode::FlattenOnly => PolicyMode::FlattenOnly,
            EmergencyMode::HaltAll => PolicyMode::HaltAll,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmergencyStopParams {
    pub mode: EmergencyMode,
    pub reason: String,
    pub principal: Principal,
    pub surface: Surface,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmergencyStopResult {
    pub policy: ExecPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventsSubscribeParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since_seq: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventsSubscribeResult {
    pub ok: bool,
    pub current_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OauthStartParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scopes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_browser: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OauthStartResult {
    pub authorize_url: String,
    pub state: String,
    pub expires_at: TimestampMs,
}

pub type OauthStatusParams = Empty;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OauthStatusResult {
    pub oauth: OauthStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OauthRevokeParams {
    pub principal: Principal,
    pub surface: Surface,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OauthRevokeResult {
    pub ok: bool,
}

/// 常量算法名。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SealedAlg {
    #[serde(rename = "ecdh-p256-hkdf-sha256-aes256gcm")]
    EcdhP256HkdfSha256Aes256Gcm,
}

/// 浏览器用 execd 公钥封好的密文;gateway 只转发,TS 进程拿不到明文(AGENTS.md 规矩 1)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SealedSecret {
    pub alg: SealedAlg,
    pub ephemeral_public_key: String,
    pub iv: String,
    pub ciphertext: String,
}

pub type CredentialsPublicKeyParams = Empty;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CredentialsPublicKeyResult {
    pub alg: SealedAlg,
    pub public_key: String,
    pub expires_at: TimestampMs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    MainApiKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CredentialsSetParams {
    pub kind: CredentialKind,
    pub sealed: SealedSecret,
    pub principal: Principal,
    pub surface: Surface,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CredentialsSetResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<MainKeyPermissions>,
}

pub type CredentialsStatusParams = Empty;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MainKeyStatus {
    pub present: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<MainKeyPermissions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_verified_at: Option<TimestampMs>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CredentialsStatusResult {
    pub main_api_key: MainKeyStatus,
    pub oauth: OauthStatus,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_discrimination_by_keys() {
        let req: RpcFrame = serde_json::from_str(r#"{"jsonrpc":"2.0","id":"a","method":"exec.health","params":{}}"#).unwrap();
        assert!(matches!(req, RpcFrame::Request(_)));
        let ok: RpcFrame = serde_json::from_str(r#"{"jsonrpc":"2.0","id":7,"result":{"ok":true}}"#).unwrap();
        assert!(matches!(ok, RpcFrame::Success(_)));
        let fail: RpcFrame = serde_json::from_str(r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error","data":{"kind":"invalid_params","retryable":false}}}"#).unwrap();
        assert!(matches!(fail, RpcFrame::Failure(RpcFailure { id: None, .. })));
        assert!(serde_json::from_str::<RpcFrame>(r#"{"jsonrpc":"2.0","id":1,"method":"exec.nope","params":{}}"#).is_err());
        assert!(serde_json::from_str::<RpcFrame>(r#"{"jsonrpc":"1.0","id":1,"result":{}}"#).is_err());
    }

    #[test]
    fn failure_null_id_is_emitted_as_null() {
        let f = RpcFailure { jsonrpc: JsonRpcVersion, id: None, error: RpcError::standard(-32700, "parse error") };
        let text = serde_json::to_string(&f).unwrap();
        assert!(text.contains("\"id\":null"), "{text}");
    }

    #[test]
    fn ndjson_codec_splits_lines_and_enforces_limit() {
        let mut dec = FrameDecoder::with_max(64);
        dec.push(b"{\"a\":1}\n\n{\"b\":").unwrap();
        assert_eq!(dec.next_frame().unwrap(), Some(serde_json::json!({"a":1})));
        assert_eq!(dec.next_frame().unwrap(), None);
        dec.push(b"2}\r\n").unwrap();
        assert_eq!(dec.next_frame().unwrap(), Some(serde_json::json!({"b":2})));
        let big = vec![b'x'; 65];
        assert!(matches!(dec.push(&big), Err(CodecError::FrameTooLarge { .. })));
        let mut dec = FrameDecoder::with_max(64);
        dec.push(b"not json\n").unwrap();
        assert!(matches!(dec.next_frame(), Err(CodecError::InvalidJson(_))));
        let bytes = encode_frame(&serde_json::json!({"k":"v"})).unwrap();
        assert_eq!(bytes, b"{\"k\":\"v\"}\n");
    }

    #[test]
    fn method_table_is_complete() {
        assert_eq!(Method::ALL.len(), 18);
        assert_eq!(Method::parse("exec.intent.propose"), Some(Method::IntentPropose));
        assert!(Method::IntentPropose.is_write());
        assert!(!Method::Health.is_write());
    }
}
