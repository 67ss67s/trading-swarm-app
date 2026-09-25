//! `tools/list` 快照钉版与漂移守卫(设计 §12:会话重建后工具集变了 → 写路径 HALT)。
//!
//! 哈希口径(必须稳定,否则守卫会误报):
//! 1. 工具数组按 `name` 升序排序;
//! 2. 每个 JSON 对象的键递归按字典序排序(数组保持原顺序——schema 里 `required`、`enum` 的顺序有语义);
//! 3. 紧凑序列化(无空格)后 sha256,取十六进制。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// 一次工具清单的钉版快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolsSnapshot {
    pub captured_at_ms: i64,
    pub protocol_version: String,
    pub server_info: Value,
    /// 见模块文档的口径。
    pub tools_hash: String,
    pub tools: Vec<Value>,
}

impl ToolsSnapshot {
    pub fn new(protocol_version: String, server_info: Value, tools: Vec<Value>) -> Self {
        let tools_hash = compute_tools_hash(&tools);
        Self {
            captured_at_ms: crate::auth::now_ms(),
            protocol_version,
            server_info,
            tools_hash,
            tools,
        }
    }

    pub fn tool_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.tools.iter().filter_map(tool_name).collect();
        names.sort();
        names
    }

    pub fn find(&self, name: &str) -> Option<&Value> {
        self.tools
            .iter()
            .find(|t| tool_name(t).as_deref() == Some(name))
    }

    /// 重新计算哈希并与记录值比对(防手改文件)。
    pub fn verify_hash(&self) -> bool {
        compute_tools_hash(&self.tools) == self.tools_hash
    }
}

pub fn tool_name(tool: &Value) -> Option<String> {
    tool.get("name").and_then(|n| n.as_str()).map(|s| s.to_string())
}

/// 稳定哈希:排序 + 规范化 + 紧凑 JSON + sha256。
pub fn compute_tools_hash(tools: &[Value]) -> String {
    let mut sorted: Vec<&Value> = tools.iter().collect();
    sorted.sort_by(|a, b| {
        tool_name(a)
            .unwrap_or_default()
            .cmp(&tool_name(b).unwrap_or_default())
    });
    let canonical: Vec<Value> = sorted.into_iter().map(canonicalize).collect();
    let text = serde_json::to_string(&Value::Array(canonical)).unwrap_or_default();
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// 递归键排序。数组顺序保留(schema 里数组顺序有语义)。
pub fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sorted: Vec<(&String, &Value)> = map.iter().collect();
            sorted.sort_by(|a, b| a.0.cmp(b.0));
            let mut out = serde_json::Map::new();
            for (k, v) in sorted {
                out.insert(k.clone(), canonicalize(v));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        other => other.clone(),
    }
}

/// 漂移报告。任何一项非空 = 写路径必须 HALT 直到人确认 adapter 兼容。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DriftReport {
    pub hash_changed: bool,
    /// 线上多出来的工具。
    pub added: Vec<String>,
    /// 线上少掉的工具(adapter 可能直接失灵)。
    pub removed: Vec<String>,
    /// 名字还在但 `inputSchema` 变了(最危险:参数语义可能改了)。
    pub input_schema_changed: Vec<String>,
    /// 名字还在、schema 没变,但描述/标注变了(只提示)。
    pub description_changed: Vec<String>,
    pub unchanged: usize,
    pub saved_hash: String,
    pub live_hash: String,
}

impl DriftReport {
    /// 是否构成「必须 HALT」的漂移。描述变化不算。
    pub fn is_breaking(&self) -> bool {
        !self.added.is_empty()
            || !self.removed.is_empty()
            || !self.input_schema_changed.is_empty()
    }

    pub fn summary(&self) -> String {
        if !self.hash_changed {
            return "工具快照一致".to_string();
        }
        format!(
            "工具漂移:新增 {:?},删除 {:?},inputSchema 变化 {:?},描述变化 {:?}",
            self.added, self.removed, self.input_schema_changed, self.description_changed
        )
    }
}

/// 比对钉版快照与线上快照。
pub fn drift_check(saved: &ToolsSnapshot, live: &ToolsSnapshot) -> DriftReport {
    use std::collections::BTreeMap;

    let index = |snap: &ToolsSnapshot| -> BTreeMap<String, Value> {
        snap.tools
            .iter()
            .filter_map(|t| tool_name(t).map(|n| (n, canonicalize(t))))
            .collect()
    };
    let old = index(saved);
    let new = index(live);

    let mut report = DriftReport {
        hash_changed: saved.tools_hash != live.tools_hash,
        saved_hash: saved.tools_hash.clone(),
        live_hash: live.tools_hash.clone(),
        ..Default::default()
    };

    for name in new.keys() {
        if !old.contains_key(name) {
            report.added.push(name.clone());
        }
    }
    for (name, old_tool) in &old {
        let Some(new_tool) = new.get(name) else {
            report.removed.push(name.clone());
            continue;
        };
        let old_schema = old_tool.get("inputSchema").cloned().unwrap_or(Value::Null);
        let new_schema = new_tool.get("inputSchema").cloned().unwrap_or(Value::Null);
        if old_schema != new_schema {
            report.input_schema_changed.push(name.clone());
            continue;
        }
        if old_tool != new_tool {
            report.description_changed.push(name.clone());
            continue;
        }
        report.unchanged += 1;
    }
    report.added.sort();
    report.removed.sort();
    report.input_schema_changed.sort();
    report.description_changed.sort();
    report
}
