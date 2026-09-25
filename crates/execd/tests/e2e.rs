//! 端到端:起一个 execd(临时目录 + 短 socket 路径),用 tokio UnixStream 当 gateway 打 JSON-RPC。

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use contracts_rs::rpc::{FrameDecoder, encode_frame};
use execd::{DataDir, Runtime};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::watch;

static SOCK_COUNTER: AtomicU64 = AtomicU64::new(0);

struct TestServer {
    socket: PathBuf,
    _dir: tempfile::TempDir,
    shutdown: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<anyhow::Result<()>>,
}

impl TestServer {
    async fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        // macOS UDS 路径上限 104 字节:socket 放 /tmp 下的短名字
        let n = SOCK_COUNTER.fetch_add(1, Ordering::Relaxed);
        let socket = PathBuf::from(format!("/tmp/tg-e2e-{}-{}.sock", std::process::id(), n));
        let data = DataDir::new(dir.path(), Some(socket.clone()));
        let runtime = Runtime::bootstrap(data).unwrap();
        let (tx, rx) = watch::channel(false);
        let handle = tokio::spawn(runtime.run(rx));
        for _ in 0..50 {
            if socket.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Self { socket, _dir: dir, shutdown: tx, handle }
    }

    async fn connect(&self) -> Client {
        Client { stream: UnixStream::connect(&self.socket).await.unwrap(), decoder: FrameDecoder::new(), next_id: 1 }
    }

    async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(2), self.handle).await;
        let _ = std::fs::remove_file(&self.socket);
    }
}

struct Client {
    stream: UnixStream,
    decoder: FrameDecoder,
    next_id: u64,
}

impl Client {
    async fn send_raw(&mut self, bytes: &[u8]) {
        self.stream.write_all(bytes).await.unwrap();
    }

    async fn recv_frame(&mut self) -> Value {
        loop {
            if let Some(v) = self.decoder.next_frame().unwrap() {
                return v;
            }
            let mut buf = vec![0u8; 65536];
            let n = tokio::time::timeout(Duration::from_secs(5), self.stream.read(&mut buf)).await.expect("超时没收到帧").unwrap();
            assert!(n > 0, "连接被关闭");
            self.decoder.push(&buf[..n]).unwrap();
        }
    }

    /// 发请求并等待**同 id** 的响应(中间的通知先缓存丢弃——测试里只有订阅用例会收到通知)。
    async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let req = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        self.send_raw(&encode_frame(&req).unwrap()).await;
        loop {
            let frame = self.recv_frame().await;
            if frame.get("id").and_then(Value::as_u64) == Some(id) {
                return frame;
            }
        }
    }

    async fn ok(&mut self, method: &str, params: Value) -> Value {
        let frame = self.call(method, params).await;
        assert!(frame.get("error").is_none(), "{method} 失败:{frame}");
        frame["result"].clone()
    }

    async fn err(&mut self, method: &str, params: Value) -> Value {
        let frame = self.call(method, params).await;
        assert!(frame.get("error").is_some(), "{method} 本该失败:{frame}");
        frame["error"].clone()
    }
}

fn open_params(symbol: &str) -> Value {
    json!({
        "kind": "open", "product": "usdm_perp", "symbol": symbol, "side": "buy",
        "size": {"mode": "hint", "hint": "half"},
        "entry": {"type": "market"},
        "stop": {"price": "59000", "trigger": "mark_price"},
        "evidence_refs": ["T1.E1"]
    })
}

fn propose(principal: &str, surface: &str, account: &str, params: Value, idem: Option<&str>) -> Value {
    let mut p = json!({"account": account, "principal": principal, "surface": surface, "params": params});
    if let Some(k) = idem {
        p["idempotency_key"] = json!(k);
    }
    p
}

async fn set_authority(c: &mut Client, authority: &str) -> Value {
    let cur = c.ok("exec.policy.get", json!({})).await["policy"].clone();
    let mut next = cur.clone();
    next["version"] = json!(cur["version"].as_u64().unwrap() + 1);
    next["authority"] = json!(authority);
    c.ok(
        "exec.policy.set",
        json!({"policy": next, "confirm": {"mode": next["mode"], "authority": authority}, "principal": "user", "surface": "rpc"}),
    )
    .await
}

#[tokio::test]
async fn health_and_default_policy() {
    let server = TestServer::start().await;
    let mut c = server.connect().await;
    let h = c.ok("exec.health", json!({})).await;
    assert_eq!(h["ok"], true);
    assert_eq!(h["db_ok"], true);
    assert_eq!(h["mode"], "run");
    assert_eq!(h["halted"], false);
    assert_eq!(h["open_intents"], 0);
    assert!(h["lease_epoch"].as_u64().unwrap() >= 1);
    assert_eq!(h["channels"]["main"]["state"], "unconfigured");
    let p = c.ok("exec.policy.get", json!({})).await["policy"].clone();
    assert_eq!(p["authority"], "observe");
    assert_eq!(p["version"], 0);
    assert_eq!(p["main_account"]["withdraw_enabled"], false);
    // 结果必须过契约
    let policy: contracts_rs::records::ExecPolicy = serde_json::from_value(p).unwrap();
    assert!(!policy.live_capped_enabled);
    server.stop().await;
}

#[tokio::test]
async fn policy_set_validation_and_emergency_tightening() {
    let server = TestServer::start().await;
    let mut c = server.connect().await;
    let cur = c.ok("exec.policy.get", json!({})).await["policy"].clone();
    let mut next = cur.clone();
    next["version"] = json!(1);
    next["authority"] = json!("draft");
    // confirm 回填错 → conflict
    let e = c.err("exec.policy.set", json!({"policy": next, "confirm": {"mode": "run", "authority": "observe"}, "principal": "user", "surface": "rpc"})).await;
    assert_eq!(e["data"]["kind"], "conflict");
    assert_eq!(e["code"], 1006);
    // version 错 → conflict
    let mut stale = next.clone();
    stale["version"] = json!(7);
    let e = c.err("exec.policy.set", json!({"policy": stale, "confirm": {"mode": "run", "authority": "draft"}, "principal": "user", "surface": "rpc"})).await;
    assert_eq!(e["data"]["kind"], "conflict");
    // 正确
    let r = c.ok("exec.policy.set", json!({"policy": next, "confirm": {"mode": "run", "authority": "draft"}, "principal": "user", "surface": "rpc"})).await;
    assert_eq!(r["policy"]["version"], 1);
    assert_eq!(r["policy"]["authority"], "draft");
    // 紧急停:收紧 ok,放松 forbidden
    let r = c.ok("exec.emergency_stop", json!({"mode": "flatten_only", "reason": "test", "principal": "user", "surface": "rpc"})).await;
    assert_eq!(r["policy"]["mode"], "flatten_only");
    assert_eq!(r["policy"]["emergency_stop"], true);
    let e = c.err("exec.emergency_stop", json!({"mode": "stop_opening", "reason": "loosen", "principal": "user", "surface": "rpc"})).await;
    assert_eq!(e["data"]["kind"], "forbidden");
    let h = c.ok("exec.health", json!({})).await;
    assert_eq!(h["halted"], true);
    // 放松要走 policy.set(把 emergency_stop 关掉、mode 回 run)
    let cur = c.ok("exec.policy.get", json!({})).await["policy"].clone();
    let mut relax = cur.clone();
    relax["version"] = json!(cur["version"].as_u64().unwrap() + 1);
    relax["mode"] = json!("run");
    relax["emergency_stop"] = json!(false);
    let r = c.ok("exec.policy.set", json!({"policy": relax, "confirm": {"mode": "run", "authority": "draft"}, "principal": "user", "surface": "rpc"})).await;
    assert_eq!(r["policy"]["emergency_stop"], false);
    server.stop().await;
}

#[tokio::test]
async fn propose_observe_records_draft_stays_proposed_halt_rejects() {
    let server = TestServer::start().await;
    let mut c = server.connect().await;
    // observe:agent 提议 → recorded
    let r = c.ok("exec.intent.propose", propose("model", "model", "sub", open_params("BTCUSDT"), None)).await;
    assert_eq!(r["intent"]["status"], "recorded");
    assert_eq!(r["intent"]["kind"], Value::Null, "kind 不在顶层,在 params 里");
    assert_eq!(r["intent"]["params"]["kind"], "open");
    let intent: contracts_rs::Intent = serde_json::from_value(r["intent"].clone()).unwrap();
    assert!(intent.status.is_terminal());
    // 用户提议不受 observe 约束 → proposed
    let r = c.ok("exec.intent.propose", propose("user", "rpc", "main", json!({"kind":"close","product":"usdm_perp","symbol":"ETHUSDT","pct":"100","order":{"type":"market"}}), None)).await;
    assert_eq!(r["intent"]["status"], "proposed");
    let user_intent_id = r["intent"]["intent_id"].as_str().unwrap().to_owned();
    // draft:agent 提议停在 proposed
    set_authority(&mut c, "draft").await;
    let r = c.ok("exec.intent.propose", propose("model", "model", "sub", open_params("ETHUSDT"), None)).await;
    assert_eq!(r["intent"]["status"], "proposed");
    let draft_intent_id = r["intent"]["intent_id"].as_str().unwrap().to_owned();
    // halt_all:拒绝并带 gate_rejections
    c.ok("exec.emergency_stop", json!({"mode": "halt_all", "reason": "test", "principal": "user", "surface": "rpc"})).await;
    let r = c.ok("exec.intent.propose", propose("model", "model", "sub", open_params("SOLUSDT"), None)).await;
    assert_eq!(r["intent"]["status"], "rejected");
    assert_eq!(r["gate_rejections"][0]["gate"], "policy.emergency_stop");
    assert_eq!(r["intent"]["gate_rejections"].as_array().unwrap().len(), 1);
    // list / get
    let l = c.ok("exec.intent.list", json!({"status": ["proposed"]})).await;
    let ids: Vec<&str> = l["intents"].as_array().unwrap().iter().map(|i| i["intent_id"].as_str().unwrap()).collect();
    assert!(ids.contains(&user_intent_id.as_str()) && ids.contains(&draft_intent_id.as_str()));
    let g = c.ok("exec.intent.get", json!({"intent_id": draft_intent_id})).await;
    assert_eq!(g["intent"]["status"], "proposed");
    assert_eq!(g["attempts"].as_array().unwrap().len(), 0);
    assert!(g.get("plan").is_none());
    // reject:合法(proposed→rejected)与非法(rejected→rejected)
    let r = c.ok("exec.intent.reject", json!({"intent_id": draft_intent_id, "reason": "改主意", "principal": "user", "surface": "rpc"})).await;
    assert_eq!(r["intent"]["status"], "rejected");
    let e = c.err("exec.intent.reject", json!({"intent_id": draft_intent_id, "reason": "再拒一次", "principal": "user", "surface": "rpc"})).await;
    assert_eq!(e["data"]["kind"], "invalid_transition");
    assert_eq!(e["code"], 1008);
    let e = c.err("exec.intent.get", json!({"intent_id": "00000000-0000-4000-8000-000000000000"})).await;
    assert_eq!(e["data"]["kind"], "not_found");
    let h = c.ok("exec.health", json!({})).await;
    assert_eq!(h["open_intents"], 1, "只剩用户那条 proposed");
    server.stop().await;
}

#[tokio::test]
async fn propose_validation_and_idempotency() {
    let server = TestServer::start().await;
    let mut c = server.connect().await;
    // agent 不能写主账户
    let e = c.err("exec.intent.propose", propose("model", "model", "main", open_params("BTCUSDT"), None)).await;
    assert_eq!(e["data"]["kind"], "forbidden");
    // transfer 必须 user+rpc
    let transfer = json!({"kind":"transfer","asset":"USDT","amount":"25","from_account":"main","from_wallet":"spot","to_account":"sub","to_wallet":"usdm_futures"});
    let e = c.err("exec.intent.propose", propose("model", "model", "sub", transfer.clone(), None)).await;
    assert_eq!(e["data"]["kind"], "forbidden");
    let r = c.ok("exec.intent.propose", propose("user", "rpc", "main", transfer, None)).await;
    assert_eq!(r["intent"]["status"], "proposed");
    // 契约不合(float qty)→ invalid_params(-32602)
    let mut bad = open_params("BTCUSDT");
    bad["size"] = json!({"mode": "qty", "qty": 0.002});
    let e = c.err("exec.intent.propose", propose("model", "model", "sub", bad, None)).await;
    assert_eq!(e["code"], -32602);
    assert_eq!(e["data"]["kind"], "invalid_params");
    // 幂等:同键同内容 → 同 intent;同键不同内容 → conflict
    let a = c.ok("exec.intent.propose", propose("model", "model", "sub", open_params("BTCUSDT"), Some("k1"))).await;
    let b = c.ok("exec.intent.propose", propose("model", "model", "sub", open_params("BTCUSDT"), Some("k1"))).await;
    assert_eq!(a["intent"]["intent_id"], b["intent"]["intent_id"]);
    let e = c.err("exec.intent.propose", propose("model", "model", "sub", open_params("ETHUSDT"), Some("k1"))).await;
    assert_eq!(e["data"]["kind"], "conflict");
    // 未实现的方法明确 unavailable
    let e = c.err("exec.account.snapshot", json!({"account": "sub"})).await;
    assert_eq!(e["data"]["kind"], "unavailable");
    let e = c.err("exec.intent.authorize", json!({"intent_id": a["intent"]["intent_id"], "plan_hash": "0".repeat(64), "principal": "user", "surface": "rpc", "confirm_echo": {}})).await;
    assert_eq!(e["data"]["kind"], "unavailable");
    server.stop().await;
}

#[tokio::test]
async fn events_subscribe_replays_history_then_streams_live() {
    let server = TestServer::start().await;
    let mut producer = server.connect().await;
    producer.ok("exec.intent.propose", propose("model", "model", "sub", open_params("BTCUSDT"), None)).await;
    producer.ok("exec.intent.propose", propose("model", "model", "sub", open_params("ETHUSDT"), None)).await;

    let mut sub = server.connect().await;
    let r = sub.ok("exec.events.subscribe", json!({"since_seq": 0})).await;
    let current = r["current_seq"].as_u64().unwrap();
    assert!(current >= 4, "两次 propose 至少 4 条事件(created+recorded ×2):{current}");
    // 回放
    let mut seqs = Vec::new();
    for _ in 0..current {
        let f = sub.recv_frame().await;
        assert_eq!(f["method"], "exec.event");
        seqs.push(f["params"]["seq"].as_u64().unwrap());
    }
    assert_eq!(seqs, (1..=current).collect::<Vec<_>>(), "回放必须按 seq 连续单调");
    assert_eq!(seqs.len(), current as usize);
    // 实时
    producer.ok("exec.emergency_stop", json!({"mode": "halt_all", "reason": "live", "principal": "user", "surface": "rpc"})).await;
    let f = sub.recv_frame().await;
    assert_eq!(f["params"]["seq"].as_u64().unwrap(), current + 1);
    assert_eq!(f["params"]["event"], "halt.changed");
    let f = sub.recv_frame().await;
    assert_eq!(f["params"]["seq"].as_u64().unwrap(), current + 2);
    assert_eq!(f["params"]["event"], "policy.changed");
    // 事件形状过契约
    let ev: contracts_rs::records::ExecEvent = serde_json::from_value(f["params"].clone()).unwrap();
    assert_eq!(ev.seq, current + 2);
    server.stop().await;
}

#[tokio::test]
async fn bad_frames_and_oversize_are_handled() {
    let server = TestServer::start().await;
    let mut c = server.connect().await;
    c.send_raw(b"not json\n").await;
    let f = c.recv_frame().await;
    assert_eq!(f["error"]["code"], -32700);
    assert_eq!(f["id"], Value::Null);
    c.send_raw(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"exec.nope\",\"params\":{}}\n").await;
    let f = c.recv_frame().await;
    assert_eq!(f["error"]["code"], -32600);
    // 连接仍可用
    let h = c.ok("exec.health", json!({})).await;
    assert_eq!(h["ok"], true);
    // 超大帧:发 > 4 MiB 不带换行 → 服务端回错误并断开
    let mut big = server.connect().await;
    let chunk = vec![b'x'; 5 * 1024 * 1024];
    let _ = big.stream.write_all(&chunk).await;
    let f = big.recv_frame().await;
    assert_eq!(f["error"]["code"], -32600);
    let mut buf = [0u8; 16];
    let n = tokio::time::timeout(Duration::from_secs(5), big.stream.read(&mut buf)).await.expect("应被断开").unwrap_or(0);
    assert_eq!(n, 0, "超限后连接应关闭");
    server.stop().await;
}

#[tokio::test]
async fn twenty_concurrent_clients_and_second_instance_is_locked_out() {
    let server = TestServer::start().await;
    let mut handles = Vec::new();
    for i in 0..20 {
        let socket = server.socket.clone();
        handles.push(tokio::spawn(async move {
            let mut c = Client { stream: UnixStream::connect(&socket).await.unwrap(), decoder: FrameDecoder::new(), next_id: 1 };
            let r = c.ok("exec.intent.propose", propose("model", "model", "sub", open_params("BTCUSDT"), Some(&format!("k-{i}")))).await;
            r["intent"]["intent_id"].as_str().unwrap().to_owned()
        }));
    }
    let mut ids = Vec::new();
    for h in handles {
        ids.push(h.await.unwrap());
    }
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 20);
    // 第二实例同一数据目录 → 锁失败
    let data2 = DataDir::new(server._dir.path(), Some(PathBuf::from(format!("/tmp/tg-e2e-second-{}.sock", std::process::id()))));
    let err = Runtime::bootstrap(data2).err().expect("第二实例必须失败");
    assert!(err.to_string().contains("只允许一个实例"), "{err}");
    server.stop().await;
}

#[test]
fn migrations_idempotent_on_file_db() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("exec.sqlite");
    let mut conn = execd::db::open(&path).unwrap();
    assert_eq!(execd::db::migrate(&mut conn).unwrap(), 1);
    drop(conn);
    let mut conn = execd::db::open(&path).unwrap();
    assert_eq!(execd::db::migrate(&mut conn).unwrap(), 0);
    let tables = execd::db::table_names(&conn).unwrap();
    assert!(tables.contains(&"ops_queue".to_string()));
    let _ = Arc::new(());
}
