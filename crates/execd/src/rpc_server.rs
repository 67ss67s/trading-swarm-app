//! UDS JSON-RPC 服务端:NDJSON 帧、每连接一个读循环 + 一个写任务、每请求一个 task(响应可乱序)、
//! `exec.events.subscribe` 在连接内开一个回放+实时转发任务。

use std::sync::Arc;

use contracts_rs::records::ExecEvent;
use contracts_rs::rpc::{
    CredentialsStatusResult, EventMethod, EventsSubscribeParams, EventsSubscribeResult, ExchangeStatusResult,
    FrameDecoder, JsonRpcVersion, MainChannelStatus, MainKeyStatus, McpSessionState, Method, OauthStatus,
    RestGateState, RpcError, RpcFailure, RpcFrame, RpcId, RpcNotification, RpcRequest, RpcSuccess, SubChannelStatus,
    UserStreamState, WriterInfo, encode_frame,
};
use contracts_rs::ErrorKind;
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc, watch};

use crate::app::App;

/// 每连接的出站队列上限;积压到这个数还没消费完就断开(慢消费者保护)。
const OUTBOUND_QUEUE: usize = 1000;

pub async fn serve(app: Arc<App>, listener: UnixListener, mut shutdown: watch::Receiver<bool>) -> anyhow::Result<()> {
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        let app = app.clone();
                        let shutdown = shutdown.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_connection(app, stream, shutdown).await {
                                tracing::debug!(error = %e, "连接结束");
                            }
                        });
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "accept 失败");
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                }
            }
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    tracing::info!("停止接受新连接");
                    return Ok(());
                }
            }
        }
    }
}

async fn handle_connection(app: Arc<App>, stream: UnixStream, mut shutdown: watch::Receiver<bool>) -> anyhow::Result<()> {
    let (mut reader, mut writer) = stream.into_split();
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(OUTBOUND_QUEUE);

    let writer_task = tokio::spawn(async move {
        while let Some(bytes) = out_rx.recv().await {
            if writer.write_all(&bytes).await.is_err() {
                break;
            }
        }
        let _ = writer.shutdown().await;
    });

    let mut decoder = FrameDecoder::new();
    let mut buf = vec![0u8; 64 * 1024];
    let result: anyhow::Result<()> = async {
        loop {
            let n = tokio::select! {
                n = reader.read(&mut buf) => n?,
                _ = shutdown.changed() => { if *shutdown.borrow() { return Ok(()); } else { continue; } }
            };
            if n == 0 {
                return Ok(());
            }
            if let Err(e) = decoder.push(&buf[..n]) {
                send(&out_tx, &failure(None, RpcError::standard(contracts_rs::error_codes::INVALID_REQUEST, e.to_string()))).await;
                anyhow::bail!("帧超限,断开:{e}");
            }
            loop {
                let frame = match decoder.next_frame() {
                    Ok(Some(v)) => v,
                    Ok(None) => break,
                    Err(e) => {
                        send(&out_tx, &failure(None, RpcError::standard(-32700, e.to_string()))).await;
                        continue;
                    }
                };
                match RpcFrame::from_value(frame) {
                    Ok(RpcFrame::Request(req)) => {
                        if req.method == Method::EventsSubscribe {
                            handle_subscribe(app.clone(), req, out_tx.clone()).await;
                        } else {
                            let app = app.clone();
                            let out = out_tx.clone();
                            tokio::spawn(async move {
                                let resp = dispatch(&app, req).await;
                                send(&out, &resp).await;
                            });
                        }
                    }
                    Ok(other) => {
                        tracing::debug!(?other, "忽略非请求帧");
                    }
                    Err(e) => {
                        send(&out_tx, &failure(None, RpcError::standard(-32600, e))).await;
                    }
                }
            }
        }
    }
    .await;
    drop(out_tx);
    let _ = writer_task.await;
    result
}

async fn send<T: Serialize>(out: &mpsc::Sender<Vec<u8>>, frame: &T) -> bool {
    match encode_frame(frame) {
        Ok(bytes) => out.send(bytes).await.is_ok(),
        Err(e) => {
            tracing::error!(error = %e, "响应编码失败");
            false
        }
    }
}

fn failure(id: Option<RpcId>, error: RpcError) -> RpcFailure {
    RpcFailure { jsonrpc: JsonRpcVersion, id, error }
}

fn success<T: Serialize>(id: RpcId, result: &T) -> RpcFrame {
    match serde_json::to_value(result) {
        Ok(Value::Object(map)) => RpcFrame::Success(RpcSuccess { jsonrpc: JsonRpcVersion, id, result: map }),
        Ok(_) => RpcFrame::Failure(failure(Some(id), RpcError::from_kind(ErrorKind::Internal, "result 不是对象"))),
        Err(e) => RpcFrame::Failure(failure(Some(id), RpcError::from_kind(ErrorKind::Internal, e.to_string()))),
    }
}

fn parse_params<T: serde::de::DeserializeOwned>(params: &Map<String, Value>) -> Result<T, RpcError> {
    serde_json::from_value(Value::Object(params.clone()))
        .map_err(|e| RpcError::from_kind(ErrorKind::InvalidParams, format!("params 不合契约:{e}")))
}

fn to_frame<T: Serialize>(id: RpcId, r: Result<T, RpcError>) -> RpcFrame {
    match r {
        Ok(v) => success(id, &v),
        Err(e) => RpcFrame::Failure(failure(Some(id), e)),
    }
}

/// 除 events.subscribe 外的全部方法。
pub async fn dispatch(app: &Arc<App>, req: RpcRequest) -> RpcFrame {
    let id = req.id.clone();
    let params = &req.params;
    match req.method {
        Method::Health => to_frame(id, Ok(app.health())),
        Method::PolicyGet => to_frame(id, app.policy_get()),
        Method::PolicySet => to_frame(id, parse_params(params).and_then(|p| app.policy_set(p))),
        Method::EmergencyStop => to_frame(id, parse_params(params).and_then(|p| app.emergency_stop(p))),
        Method::IntentPropose => to_frame(id, parse_params(params).and_then(|p| app.intents.propose(p))),
        Method::IntentGet => to_frame(id, parse_params(params).and_then(|p| app.intents.get(p))),
        Method::IntentList => to_frame(id, parse_params(params).and_then(|p| app.intents.list(p))),
        Method::IntentReject => to_frame(id, parse_params(params).and_then(|p| app.intents.reject(p))),
        Method::IntentAuthorize => to_frame(id, parse_params(params).and_then(|p| app.intents.authorize(p))),
        Method::ExchangeStatus => to_frame(id, Ok(exchange_status_unconfigured(app))),
        Method::CredentialsStatus => to_frame(
            id,
            Ok(CredentialsStatusResult {
                main_api_key: MainKeyStatus { present: false, key_fingerprint: None, permissions: None, last_verified_at: None },
                oauth: OauthStatus::missing(),
            }),
        ),
        Method::EventsSubscribe => RpcFrame::Failure(failure(Some(id), RpcError::from_kind(ErrorKind::Internal, "subscribe 应在连接层处理"))),
        Method::AccountSnapshot
        | Method::OauthStart
        | Method::OauthStatus
        | Method::OauthRevoke
        | Method::CredentialsPublicKey
        | Method::CredentialsSet => RpcFrame::Failure(failure(
            Some(id),
            RpcError::from_kind(ErrorKind::Unavailable, format!("{} 在 A2/A3 交付", req.method)).with_retryable(false),
        )),
    }
}

fn exchange_status_unconfigured(app: &App) -> ExchangeStatusResult {
    ExchangeStatusResult {
        main: MainChannelStatus {
            configured: false,
            key_fingerprint: None,
            permissions: None,
            user_stream: UserStreamState::Unconfigured,
            time_offset_ms: None,
            rest_gate: RestGateState::Unconfigured,
            last_verified_at: None,
        },
        sub: SubChannelStatus {
            configured: false,
            oauth: OauthStatus::missing(),
            mcp_session: McpSessionState::None,
            tools_hash: None,
            tools_pinned_hash: None,
            tools_count: None,
            drift: false,
            subaccount_ref: None,
        },
        writer: WriterInfo { instance_id: app.instance_id.clone(), lease_epoch: app.lease_epoch, since: app.started_at },
    }
}

/// 回 current_seq → 回放 since_seq 之后的历史 → 实时转发;seq 单调、去重;慢消费者断开。
async fn handle_subscribe(app: Arc<App>, req: RpcRequest, out: mpsc::Sender<Vec<u8>>) {
    let id = req.id.clone();
    let params: EventsSubscribeParams = match parse_params(&req.params) {
        Ok(p) => p,
        Err(e) => {
            send(&out, &failure(Some(id), e)).await;
            return;
        }
    };
    // 先订阅再查库,不漏事件;重复的靠 seq 去重。
    let mut live = app.bus.subscribe();
    let current = match app.store.current_seq() {
        Ok(v) => v,
        Err(e) => {
            send(&out, &failure(Some(id), RpcError::from_kind(ErrorKind::Internal, e.to_string()))).await;
            return;
        }
    };
    if !send(&out, &success(id, &EventsSubscribeResult { ok: true, current_seq: current })).await {
        return;
    }
    let mut last = params.since_seq.unwrap_or(current);
    tokio::spawn(async move {
        // 历史回放(分页)
        loop {
            let batch = match app.store.events_since(last, 500) {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!(error = %e, "事件回放失败");
                    return;
                }
            };
            if batch.is_empty() {
                break;
            }
            for ev in batch {
                last = ev.seq;
                if !send(&out, &notification(ev)).await {
                    return;
                }
            }
        }
        // 实时
        loop {
            match live.recv().await {
                Ok(ev) => {
                    if ev.seq <= last {
                        continue;
                    }
                    if ev.seq > last + 1 {
                        // 中间有空洞(广播 channel 容量或并发 commit 顺序):从库补齐
                        if let Ok(missing) = app.store.events_since(last, 500) {
                            for m in missing {
                                if m.seq > last {
                                    last = m.seq;
                                    if !send(&out, &notification(m)).await {
                                        return;
                                    }
                                }
                            }
                        }
                        if ev.seq <= last {
                            continue;
                        }
                    }
                    last = ev.seq;
                    if !send(&out, &notification(ev)).await {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(lagged = n, "订阅者落后,从库重同步");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    });
}

fn notification(event: ExecEvent) -> RpcNotification {
    RpcNotification { jsonrpc: JsonRpcVersion, method: EventMethod, params: event }
}
