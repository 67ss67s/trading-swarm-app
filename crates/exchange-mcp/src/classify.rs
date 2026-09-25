//! 工具分类启发式:探针用它把 `tools/list` 的结果自动标注成
//! 「写类 / 只读 / 账户身份类」,并在写类工具的 inputSchema 里找幂等字段。
//!
//! **这是启发式,不是权限墙。** 真正的权限墙在 execd 的 ActorContext 与 gate;
//! 这里的作用是:①A1 报告能一眼看出 clientOrderId 有没有;②探针 `call` 子命令
//! 默认拒绝执行看起来会动钱的工具。宁可误判成写类,不可漏判。

use serde_json::Value;

/// 名字/描述里出现这些词就当写类(动钱或改账户状态)。
pub const WRITE_PATTERNS: &[&str] = &[
    "order", "trade", "buy", "sell", "cancel", "amend", "replace", "modify",
    "transfer", "withdraw", "deposit", "convert", "swap", "borrow", "repay",
    "redeem", "subscribe", "stake", "leverage", "margin_type", "margintype",
    "position_mode", "positionmode", "close_position", "closeposition",
    "create", "place", "submit", "execute", "open_position", "openposition",
];

/// 这些词出现时**不**因为上面的宽泛词(order/trade/create…)判成写类——它们是查询。
pub const READ_OVERRIDES: &[&str] = &[
    "get_", "query_", "list_", "fetch_", "read_", "history", "status",
    "_info", "info_", "lookup", "search", "book", "ticker", "kline",
    "candles", "depth", "funding", "openorders", "open_orders",
];

/// 幂等/客户端订单号字段(归一化后比较:小写、去 `_`/`-`)。
pub const IDEMPOTENCY_FIELDS: &[&str] = &[
    "clientorderid",
    "newclientorderid",
    "origclientorderid",
    "clientoid",
    "clientid",
    "idempotencykey",
    "idempotency",
    "idempotencyid",
    "requestid",
    "orderlinkid",
];

/// 像是「账户/子账户信息」的工具——可能给出子账户稳定标识(A1 待答项)。
pub const IDENTITY_PATTERNS: &[&str] = &[
    "account", "subaccount", "sub_account", "profile", "wallet", "portfolio",
    "whoami", "user", "balance",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolClass {
    /// 会动钱或改账户状态。探针默认拒绝调用。
    Write,
    /// 看起来只读。
    Read,
}

impl ToolClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            ToolClass::Write => "write",
            ToolClass::Read => "read",
        }
    }
}

fn normalize(s: &str) -> String {
    s.to_ascii_lowercase().replace(['_', '-', '.', ' '], "")
}

/// 只按**名字**判(描述噪声大,只作为补充信号)。
pub fn classify_name(name: &str) -> ToolClass {
    let lower = name.to_ascii_lowercase();
    let flat = normalize(name);

    // 显式的只读前缀优先(get_order / query_order 是查不是下)。
    let looks_read = READ_OVERRIDES
        .iter()
        .any(|p| lower.starts_with(p) || lower.contains(p) || flat.contains(&normalize(p)));

    let hits_write = WRITE_PATTERNS.iter().any(|p| flat.contains(&normalize(p)));

    // 强写词:即便带 get/list 前缀也当写类(宁可误判)。
    let strong_write = ["cancel", "withdraw", "transfer", "placeorder", "createorder", "neworder", "closeposition", "borrow", "repay", "convert"]
        .iter()
        .any(|p| flat.contains(&normalize(p)));

    if strong_write {
        return ToolClass::Write;
    }
    if hits_write && !looks_read {
        return ToolClass::Write;
    }
    ToolClass::Read
}

/// 名字 + 描述一起判(描述里出现 place/submit/cancel 之类也算)。
pub fn classify(name: &str, description: Option<&str>) -> ToolClass {
    if classify_name(name) == ToolClass::Write {
        return ToolClass::Write;
    }
    let Some(desc) = description else {
        return ToolClass::Read;
    };
    let d = desc.to_ascii_lowercase();
    let phrases = [
        "place an order", "place order", "submit an order", "submit order",
        "create an order", "create order", "cancel an order", "cancel order",
        "transfer", "withdraw", "borrow", "repay", "convert",
        "下单", "撤单", "划转", "提币", "借", "还款",
    ];
    if phrases.iter().any(|p| d.contains(p)) {
        return ToolClass::Write;
    }
    ToolClass::Read
}

pub fn looks_like_identity(name: &str, description: Option<&str>) -> bool {
    let hay = format!("{} {}", name, description.unwrap_or_default()).to_ascii_lowercase();
    let flat = normalize(&hay);
    IDENTITY_PATTERNS.iter().any(|p| flat.contains(&normalize(p)))
}

/// 在 JSON Schema 里递归找幂等字段名。返回**原始拼写**,去重后排序。
pub fn find_idempotency_fields(schema: &Value) -> Vec<String> {
    let mut found = Vec::new();
    walk_properties(schema, &mut |name| {
        let flat = normalize(name);
        if IDEMPOTENCY_FIELDS.iter().any(|f| flat == *f) {
            found.push(name.to_string());
        }
    });
    found.sort();
    found.dedup();
    found
}

/// inputSchema 顶层 `properties` 的键(探针表格用),required 的排前面。
pub fn top_level_properties(schema: &Value) -> Vec<String> {
    let required: Vec<String> = schema
        .get("required")
        .and_then(|r| r.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    let mut props: Vec<String> = schema
        .get("properties")
        .and_then(|p| p.as_object())
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    props.sort_by_key(|p| (!required.contains(p), p.clone()));
    props
        .into_iter()
        .map(|p| if required.contains(&p) { format!("{p}*") } else { p })
        .collect()
}

/// 递归遍历 schema 的属性名(properties / items / oneOf / anyOf / allOf / $defs)。
fn walk_properties(schema: &Value, on_name: &mut impl FnMut(&str)) {
    match schema {
        Value::Object(map) => {
            if let Some(Value::Object(props)) = map.get("properties") {
                for (name, sub) in props {
                    on_name(name);
                    walk_properties(sub, on_name);
                }
            }
            for key in ["items", "additionalProperties", "not"] {
                if let Some(sub) = map.get(key) {
                    walk_properties(sub, on_name);
                }
            }
            for key in ["oneOf", "anyOf", "allOf", "prefixItems"] {
                if let Some(Value::Array(list)) = map.get(key) {
                    for sub in list {
                        walk_properties(sub, on_name);
                    }
                }
            }
            for key in ["$defs", "definitions"] {
                if let Some(Value::Object(defs)) = map.get(key) {
                    for sub in defs.values() {
                        walk_properties(sub, on_name);
                    }
                }
            }
        }
        Value::Array(items) => {
            for sub in items {
                walk_properties(sub, on_name);
            }
        }
        _ => {}
    }
}

/// 探针表格里的一行标注。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ToolAnnotation {
    pub name: String,
    pub class: ToolClass,
    pub description_line: String,
    pub top_level_properties: Vec<String>,
    /// 写类工具才有意义:能不能带客户端订单号(A1 的 go/no-go 关键项)。
    pub idempotency_fields: Vec<String>,
    pub looks_like_identity: bool,
}

pub fn annotate(tool: &Value) -> ToolAnnotation {
    let name = crate::snapshot::tool_name(tool).unwrap_or_default();
    let description = tool.get("description").and_then(|d| d.as_str());
    let schema = tool
        .get("inputSchema")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    ToolAnnotation {
        class: classify(&name, description),
        description_line: description
            .unwrap_or("")
            .lines()
            .next()
            .unwrap_or("")
            .chars()
            .take(96)
            .collect(),
        top_level_properties: top_level_properties(&schema),
        idempotency_fields: find_idempotency_fields(&schema),
        looks_like_identity: looks_like_identity(&name, description),
        name,
    }
}
