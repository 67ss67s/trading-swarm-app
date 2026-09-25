//! R5:canonical_json / plan_hash / account_version / confirm_fields / clientOrderId 对拍
//! `packages/contracts/fixtures/hash/vectors.json` 与各 fixtures。

use std::collections::BTreeMap;
use std::fs;

use contracts_rs::records::Authorization;
use contracts_rs::{
    AccountSnapshot, ExecutableOrderPlan, account_version_of, canonical_json, confirm_fields, contracts_dir, plan_hash,
    sha256_hex,
};
use serde_json::Value;

#[derive(serde::Deserialize)]
struct Vectors {
    vectors: Vec<Vector>,
}

#[derive(serde::Deserialize)]
struct Vector {
    name: String,
    input: Value,
    canonical: String,
    sha256: String,
}

#[test]
fn canonical_and_sha256_match_python_arbiter() {
    let path = contracts_dir().join("fixtures/hash/vectors.json");
    let vectors: Vectors = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert!(vectors.vectors.len() >= 5);
    for v in vectors.vectors {
        let canonical = canonical_json(&v.input).unwrap_or_else(|e| panic!("{}: {e}", v.name));
        assert_eq!(canonical, v.canonical, "canonical 不一致:{}", v.name);
        assert_eq!(sha256_hex(&canonical), v.sha256, "sha256 不一致:{}", v.name);
    }
}

fn read_dir_json(sub: &str) -> Vec<(String, String)> {
    let dir = contracts_dir().join("fixtures").join(sub);
    let mut out: Vec<(String, String)> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false))
        .map(|e| (e.file_name().to_string_lossy().into_owned(), fs::read_to_string(e.path()).unwrap()))
        .collect();
    out.sort();
    out
}

#[test]
fn plan_fixtures_carry_their_own_hash() {
    for (name, text) in read_dir_json("plan") {
        let plan: ExecutableOrderPlan = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(plan_hash(&plan.economic).unwrap(), plan.plan_hash, "plan_hash 重算不一致:{name}");
    }
}

#[test]
fn account_version_of_consistent_snapshot_matches_fixture() {
    let text = fs::read_to_string(contracts_dir().join("fixtures/account_snapshot/sub_consistent.json")).unwrap();
    let snap: AccountSnapshot = serde_json::from_str(&text).unwrap();
    let version = account_version_of(&snap).unwrap().expect("四组件齐全");
    assert_eq!(Some(version), snap.account_version);
}

#[test]
fn confirm_fields_of_order_plan_equal_user_authorization_echo() {
    let plan: ExecutableOrderPlan = serde_json::from_str(
        &fs::read_to_string(contracts_dir().join("fixtures/plan/order_limit_with_protection.json")).unwrap(),
    )
    .unwrap();
    let auth: Authorization = serde_json::from_str(
        &fs::read_to_string(contracts_dir().join("fixtures/authorization/user_consumed.json")).unwrap(),
    )
    .unwrap();
    let derived: BTreeMap<String, String> = confirm_fields(&plan).unwrap();
    assert_eq!(Some(derived), auth.confirm_echo, "confirm_fields 与 fixture 的 confirm_echo 必须逐字相等");
}

#[test]
fn confirm_fields_for_transfer_and_protect_follow_table() {
    let plan: ExecutableOrderPlan = serde_json::from_str(
        &fs::read_to_string(contracts_dir().join("fixtures/plan/transfer_main_to_sub.json")).unwrap(),
    )
    .unwrap();
    let fields = confirm_fields(&plan).unwrap();
    assert_eq!(fields.get("asset").map(String::as_str), Some("USDT"));
    assert_eq!(fields.get("amount").map(String::as_str), Some("25"));
    assert_eq!(fields.get("from_account").map(String::as_str), Some("main"));
    assert_eq!(fields.get("to_account").map(String::as_str), Some("sub"));
    assert_eq!(fields.get("plan_hash").map(String::as_str), Some(plan.plan_hash.as_str()));
    assert_eq!(fields.len(), 5);

    let plan: ExecutableOrderPlan = serde_json::from_str(
        &fs::read_to_string(contracts_dir().join("fixtures/plan/protect_replace.json")).unwrap(),
    )
    .unwrap();
    let fields = confirm_fields(&plan).unwrap();
    assert_eq!(fields.get("symbol").map(String::as_str), Some("ETHUSDT"));
    assert_eq!(fields.get("position_side").map(String::as_str), Some("both"));
    let legs = fields.get("legs").expect("legs 以 canonical_json 字符串回填");
    assert!(legs.starts_with("[{\"close_position\":true"), "{legs}");
}
