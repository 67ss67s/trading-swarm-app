# 契约(packages/contracts)—— 唯一契约源与两语言对拍规则

> 设计依据:`docs/design/trading-swarm-design-v1-2026-09-02.md` §2(硬规则②"契约只有一份")、§5.1(六种执行记录)、§6.2(AccountSnapshot)、§10(policy)、§12(失败矩阵)。本文是实施口径,schema 文件本身是最终裁判。

## 1. 布局

```
packages/contracts/
  schema/            JSON Schema 2020-12(源)。$id = https://trading-swarm.dev/schema/<name>.json,跨文件用相对 $ref
    common.json        共享基础类型与全部枚举
    intent.json        Intent(params 按 kind 判别:open/close/cancel_order/protect/transfer)
    plan.json          ExecutableOrderPlan(economic 进哈希,basis 不进)
    authorization.json Authorization(by=user 必带 confirm_echo)
    attempt.json       ExecutionAttempt(clientOrderId 调用前持久化)
    exchange_order.json ExchangeOrderObservation(不可变观察)
    fill.json          Fill(不可变观察)
    position_effect.json PositionEffect(经济完成定义)
    account_snapshot.json AccountSnapshot(分组件 observed_at/completeness,account_version)
    policy.json        ExecPolicy(execd 持有的 policy 子集)
    events.json        ExecEvent(execd 事件信封 + 事件名枚举)
    rpc.json           ExecutionService:UDS JSON-RPC 帧 + 每个方法的 params/result
  transitions/       状态转移表(机器可读),两种语言都由它生成测试
  tables/            其他两语言共用的小表:error_codes / confirm_fields / client_order_id
  fixtures/          对拍语料:<schema>/*.json 必须合法;invalid/<schema>/*.json 必须不合法;hash/vectors.json 哈希向量
  scripts/           generate.ts(TS 生成)、canonical_ref.py(python 第三方仲裁)、validate_fixtures.py
  src/               TS 包:generated/ 类型 + ajv 校验器 + canonical/hash + transitions + rpc 帮助函数
crates/contracts-rs/ Rust 包:手写 serde 结构(与 schema 逐字段对拍)+ 同样的 canonical/hash/transitions
```

## 2. 命名与类型约定(schema 与两语言都遵守)

| 约定 | 说明 | TS | Rust |
|---|---|---|---|
| 字段 `snake_case` | JSON、SQL 列同名 | 生成类型保留 snake_case | `#[serde(rename_all = "snake_case")]` 或逐字段 |
| 枚举值小写 `snake_case` | 如 `awaiting_approval`、`usdm_perp` | 字符串字面量联合 | `enum` + `rename_all = "snake_case"` |
| 金额/价格/数量 = 十进制字符串 | `Decimal`/`UnsignedDecimal`,永不 float | `string` | `String`(执行层内部再转 `rust_decimal`,契约层不转) |
| 时间 = unix 毫秒整数 | `TimestampMs` ≤ 2^53-1 | `number` | `i64`/`u64` |
| `additionalProperties: false` | 所有对象 | ajv 严格拒绝 | `#[serde(deny_unknown_fields)]` |
| 可选字段 | schema 里不在 `required` | `?:` | `Option<T>` + `#[serde(default, skip_serializing_if = "Option::is_none")]` |
| **绝不输出 null** | 可选字段缺省就省略 | 序列化前删 undefined/null | `skip_serializing_if` |
| 判别联合 | `params.kind`、`economic.kind`、`size.mode`、`entry.type` | `oneOf` → TS 联合 | `#[serde(tag = "kind")]` 等内部标签 |
| `schema_version` | 每条记录 `const 1` | 字面量 `1` | `u8` + 校验 |

## 3. canonical_json 与三个哈希

`canonical_json(v)`:①递归删除对象中值为 `null`/`undefined` 的成员;②对象成员按 key 码位升序;③紧凑输出(无空白);④字符串按 JSON 标准转义,**非 ASCII 不转义**;⑤不允许浮点数。TS:自写排序 + `JSON.stringify`;Rust:`serde_json::Value`(默认 `BTreeMap`,天然有序)+ `to_string`;Python 仲裁:`json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False)`。`fixtures/hash/vectors.json` 是三方必须逐条相等的向量。

- **plan_hash** = `sha256_hex(canonical_json(plan.economic))`。审批、authorization、attempt 都引用它;economic 任一字段变化 → 新 plan(version+1)。
- **account_version** = `sha256_hex(canonical_json({balances, positions, open_orders, position_mode}))`,其中每个成员取对应组件的 `data`(缺失组件 → 不参与且 consistency 不能是 consistent)。
- **tools_hash**(MCP 工具快照)= `sha256_hex(canonical_json(tools 按 name 升序的数组))`,见 `crates/exchange-mcp`。

## 4. confirm_fields(结构化确认)

`tables/confirm_fields.json` 规定每种 `economic.kind` 需要回填的字段 + 永远回填的 `plan_hash`。派生函数 `confirm_fields(plan) -> Map<string,string>`:按表取 `economic` 对应字段,值转字符串(布尔 `true/false`、整数十进制、字符串原样、数组/对象写 `canonical_json`),缺省字段不出现。execd 在 `exec.intent.authorize` 里要求 `confirm_echo` 与派生 map **逐字相等**(多字段、少字段、任何差异都 → `conflict`)。UI 显示的就是这张 map。

## 5. clientOrderId

`tables/client_order_id.json`:`tg-{intent12}-{leg_code}{leg_index}-{attempt_no}`,≤36 字符;`tg-` 开头 = 本机(local),`ts_` 开头 = 8794(foreign),其余 = foreign。开仓前发现 foreign 活动 → 强制对账后才允许继续(设计 §8.4)。

## 6. 状态转移表与生成测试

每张表:`states`、`initial`、`terminal`、`transitions[{from,to,event,note?}]`。语义:自环不是转移;同一 `(from,to)` 可有多个 `event`;终态无出边。两种语言各实现 `can_transition(machine, from, to) -> bool` 与 `next_state(machine, from, event) -> Option<state>`,并**由表生成**下列测试(不许手写枚举):

1. 对 `states × states` 的每个有序对,`can_transition` 的结果 == 表中是否存在该边;
2. 终态没有出边;非终态至少一条出边;
3. 每个状态从 `initial` 可达;
4. `(from,event)` 唯一(同一起点同一事件只能到一个终点);
5. `next_state` 对表中每条边返回 `to`,对不存在的事件返回 None;
6. schema 的枚举(`common.json` 的 IntentStatus 等)与表的 `states` 集合相等。

四张表:`intent_status`、`authorization_status`、`attempt_result`、`exchange_order_status`(后者用于校验观察序列单调性)。

## 7. 双向 round-trip(CI 必绿)

| # | 方向 | 做法 | 抓什么 |
|---|---|---|---|
| R1 | schema → TS | `json-schema-to-typescript` 生成 `src/generated/*.ts`,CI 用 `generate:check` 比对无 diff;ajv 编译全部 schema | 生成物漂移 |
| R2 | fixtures → TS | 全部 `fixtures/<schema>/*.json` 通过 ajv;`fixtures/invalid/**` 全部不通过;fixtures 作为常量赋给生成类型能过 `tsc` | schema 与类型一致 |
| R3 | fixtures → Rust | 每个 fixture `serde_json::from_str::<T>()`(`deny_unknown_fields`)成功 → 再序列化 → `canonical_json` 与原文的 `canonical_json` **字节相等**;`jsonschema` crate 用同一份 schema 校验 Rust 输出 | Rust 少字段(反序列化失败)、多字段/类型错(schema 拒) |
| R4 | Rust → TS | Rust 测试为每种记录构造"全字段"实例写到 `target/roundtrip/<schema>/*.json`(`cargo test -p contracts-rs -- --ignored emit_roundtrip` 或 build 脚本),TS 测试读取并用 ajv 校验(`additionalProperties:false` 抓 Rust 多出的字段) | Rust 多字段 |
| R5 | 哈希 | 两边对 `fixtures/hash/vectors.json` 逐条断言 `canonical` 与 `sha256` | 规范化差异 |
| R6 | 表 | 第 6 节的生成测试两边各跑一遍;`tables/error_codes.json` 的映射两边一致 | 状态机漂移 |
| R7 | 仲裁 | `python3 scripts/validate_fixtures.py` 与 `canonical_ref.py` 作为第三方裁判 | 两边同时错 |

## 8. RPC 框架约定(rpc.json)

- 传输:UDS `~/.trading-swarm/run/execd.sock`(0600),NDJSON,每帧一行,≤4 MiB;gateway 是唯一客户端(v1 不做多客户端鉴权,靠文件权限)。
- 请求 `id` 由 gateway 生成(字符串 uuid 或自增整数);execd 按到达顺序处理,可并发,响应无序。
- 通知:execd → gateway `{"jsonrpc":"2.0","method":"exec.event","params":<ExecEvent>}`;订阅后先补发 `since_seq` 之后的历史事件,再实时推。
- 错误:`error.code` 按 `tables/error_codes.json`;`error.data.kind` 是 `ErrorKind`;`retryable` 由服务端给出(默认见表)。
- 幂等:`exec.intent.propose` 带 `idempotency_key` 时同键返回同一 intent;同键不同内容 → `conflict` 并发 `corruption.detected` 事件。
- 超时:gateway 侧每个请求默认 10s(`exec.account.snapshot` 强刷 30s);超时**不等于失败**——对写类方法(propose/authorize)超时后必须 `exec.intent.get` 回查。
- 版本:`exec.health.version` 是 execd 语义版本;契约不兼容变更 = `schema_version` 升 2 且方法名带后缀(`exec.v2.*`),v1 不预留兼容层。

## 9. 存储(A0 交付 schema 与迁移;两库都是 SQLite WAL,只有各自进程打开)

**exec.sqlite(execd 独占)**:`schema_migrations(version pk, applied_at)`、`intents(intent_id pk, account, kind, principal, surface, status, idempotency_key, json, created_at, updated_at, terminal_at; unique(principal, idempotency_key))`、`plans(plan_id pk, intent_id fk, version, plan_hash, json, created_at; unique(intent_id, version))`、`authorizations(authorization_id pk, intent_id, plan_id, plan_hash, by, status, json, granted_at, expires_at)`、`attempts(attempt_id pk, intent_id, plan_id, attempt_no, leg, leg_index, client_order_id unique, channel, stage, result, json, created_at, deadline_at, result_at; unique(intent_id, leg, leg_index, attempt_no))`、`exchange_orders(observation_id pk, account, exchange_order_id, client_order_id, status, observed_at, json; index(account, exchange_order_id, observed_at))`、`fills(fill_id pk, account, exchange_order_id, trade_id, json, trade_time; unique(account, exchange_order_id, trade_id))`、`position_effects(effect_id pk, intent_id unique, status, json, evaluated_at)`、`account_snapshots(id pk autoinc, account, account_version, consistency, computed_at, json)`(只留最近 N 条)、`ops_queue(op_id pk, kind, subject_id, priority, lane, state, lease_owner, lease_epoch, lease_until, attempt, checkpoint, created_at; unique(kind, subject_id))`、`writer_lease(lane pk, instance_id, epoch, until)`、`events(seq pk autoinc, event, at, account, intent_id, json)`、`policy(id pk check(id=1), version, json, updated_at)`、`kv(key pk, value)`。事务边界:状态迁移 + 事件写入同一事务;attempt 的 `before_submit` 行必须在网络调用前 commit。

**state.sqlite(gateway 独占)**:`schema_migrations`、`events(seq pk, event, at, json, source: gateway|execd, exec_seq)`、`runs`、`trace_events`、`tool_calls`、`llm_usage`、`journal`、`lessons`、`monitors`、`cron_jobs`、`cron_runs`、`incidents`、`kv`。A0 只建表与迁移器,不写业务。

## 10. 变更流程

改 schema → 跑 `python3 scripts/validate_fixtures.py` → `npm run generate` → 两边测试 → 若是不兼容变更同时改 `schema_version`。任何一方"顺手"改 TS 类型或 Rust 结构而不改 schema,都算契约漂移,CI 应拒。
