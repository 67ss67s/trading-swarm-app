# execd —— 执行服务(A0 骨架)

唯一凭证持有者与账户写者(设计 §3)。A0 交付的是"能跑、能存、能订阅"的骨架;六记录状态机的 plan 物化/授权/派发/对账在 A2。

## 启动与目录

```
CARGO_TARGET_DIR=target/a0-rust cargo run -p execd -- [--data-dir ~/.trade-gate] [--socket <path>] [--log-level info]
```

`<data-dir>/`:`exec.sqlite`(WAL,0600,只有 execd 打开)、`run/execd.sock`(0600)、`run/execd.lock`(flock 单实例)、`secrets/`(0700)、`logs/`。第二个实例同目录启动会失败并指出持有者 pid。

启动顺序:建目录 → 抢锁 → 开库 + 迁移(`migrations/0001_init.sql`,幂等)→ 两条 lane(`main`/`sub`)的 `writer_lease` epoch+1 → 删旧 socket → 监听。SIGINT/SIGTERM 优雅退出并删 socket。

## RPC(NDJSON JSON-RPC 2.0,契约 `packages/contracts/schema/rpc.json`)

| 方法 | A0 状态 |
|---|---|
| `exec.health` | ✅ 真实值(writer/epoch/db/mode/halted/open_intents/unknown_attempts;两通道 unconfigured) |
| `exec.policy.get` / `exec.policy.set` | ✅ 无行时返回默认(Observe + 金丝雀保守上限);set 要求 confirm 逐字回填 + version 严格 +1 + v1 不变量(withdraw 恒 false、live_capped 关) |
| `exec.emergency_stop` | ✅ 只能收紧(run < stop_opening < flatten_only < halt_all),置 emergency_stop;放松走 policy.set |
| `exec.intent.propose` | ✅ A0 范围:契约/语义校验(agent 不能写 main、transfer 只许 user+rpc…)→ 幂等键(同键同内容返原 intent,不同内容 conflict + corruption.detected)→ 落 proposed → halt/emergency 下 rejected(gate_rejections)/ agent 提议在 Observe 下 recorded;**不做 plan 物化** |
| `exec.intent.get` / `exec.intent.list` / `exec.intent.reject` | ✅(reject 只走 transitions 表允许的边,否则 invalid_transition) |
| `exec.events.subscribe` | ✅ 回 current_seq → 回放 since_seq 之后的历史 → 实时推送;seq 单调去重;出站积压 1000 条断开 |
| `exec.exchange.status` / `exec.credentials.status` | ✅ 返回"未配置"的合法结果 |
| `exec.intent.authorize` / `exec.account.snapshot` / `exec.oauth.*` / `exec.credentials.public_key|set` | ⏳ `unavailable`(A2/A3) |

不变量:每次状态迁移与它的事件在同一事务;广播在 commit 之后;非法迁移不会写库。

## 表(`docs/contracts/README.md` §9)

intents / plans / authorizations / attempts / exchange_orders / fills / position_effects / account_snapshots / ops_queue / writer_lease / events / policy / kv / schema_migrations。

## 测试

`CARGO_TARGET_DIR=target/a0-rust cargo test -p execd`(6 单元 + 8 端到端:health/默认 policy、set 校验与紧急停、propose 在 observe/draft/halt 的三种去向、校验与幂等、订阅回放+实时、坏帧/超大帧、20 并发 + 第二实例锁、迁移幂等)。

## A2 扩展点

1. `intents.rs::propose` 里 `next_status` 之后接 plan 物化(sizing + filters → `plans` 表 + `awaiting_approval`);
2. `IntentService::authorize` 用 `contracts_rs::confirm_fields` 比对 `confirm_echo`,写 `authorizations`;
3. `ops_queue` 领取/租约/优先级 + 两条通道的 executor(`exec-core::BinanceRest`、`exchange-mcp::McpClient::call_write`);
4. reconciler 写 `exchange_orders`/`fills`/`position_effects`,`attempt_result` 走 `unknown` 收敛;
5. `app.rs::health` 的 channels 由通道健康替换。
