//! 测试共用:把 `packages/contracts/schema/*.json` 装进 jsonschema(Draft 2020-12),
//! 跨文件 `$ref` 通过按 `$id` 路径尾段找本地文件的 retriever 解析。

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use jsonschema::{Draft, Retrieve, Uri, Validator};
use serde_json::Value;

pub fn contracts_dir() -> PathBuf {
    contracts_rs::contracts_dir()
}

pub fn schema_dir() -> PathBuf {
    contracts_dir().join("schema")
}

pub fn fixtures_dir() -> PathBuf {
    contracts_dir().join("fixtures")
}

/// `https://trade-gate.dev/schema/common.json` → `<schema_dir>/common.json`。
struct LocalRetriever {
    dir: PathBuf,
}

impl Retrieve for LocalRetriever {
    fn retrieve(&self, uri: &Uri<String>) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        let path = uri.path().as_str();
        let file = path.rsplit('/').next().unwrap_or(path);
        let full = self.dir.join(file);
        let text = fs::read_to_string(&full).map_err(|e| format!("读不到 {}:{e}", full.display()))?;
        Ok(serde_json::from_str(&text)?)
    }
}

/// 所有 schema 名(不含 .json)。
pub fn schema_names() -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(schema_dir())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false))
        .map(|e| e.path().file_stem().unwrap().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

pub fn load_schema(name: &str) -> Value {
    let path = schema_dir().join(format!("{name}.json"));
    serde_json::from_str(&fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

pub fn validator_for(name: &str) -> Validator {
    let schema = load_schema(name);
    jsonschema::options()
        .with_draft(Draft::Draft202012)
        .with_retriever(LocalRetriever { dir: schema_dir() })
        .build(&schema)
        .unwrap_or_else(|e| panic!("schema {name} 编译失败:{e}"))
}

pub fn all_validators() -> BTreeMap<String, Validator> {
    schema_names().into_iter().map(|n| (n.clone(), validator_for(&n))).collect()
}

/// 校验并把错误压成一行行文本。
pub fn schema_errors(validator: &Validator, instance: &Value) -> Vec<String> {
    validator
        .iter_errors(instance)
        .map(|e| format!("{}: {}", e.instance_path(), e))
        .collect()
}

/// 某个 fixtures 子目录下的 (文件名, 文本),按名排序。
pub fn fixture_files(sub: &str) -> Vec<(String, String)> {
    let dir = fixtures_dir().join(sub);
    if !dir.exists() {
        return Vec::new();
    }
    let mut out: Vec<(String, String)> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false))
        .map(|e| (e.file_name().to_string_lossy().into_owned(), fs::read_to_string(e.path()).unwrap()))
        .collect();
    out.sort();
    out
}

/// fixtures 目录名 → schema 名(目录名与 schema 名一致;这里只是留一个映射点)。
pub fn schema_for_fixture_dir(dir: &str) -> &str {
    dir
}
