-- Pine 脚本目录(内部市场):任何 Pine 指标先登记成一行,过准入门后才能被 pine_series 原语引用。
-- admitted=1 只由 pine/admission.ts 的报告写入;admission_report_json 是留痕(因果/确定性/实测预热)。
CREATE TABLE pine_scripts(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  script TEXT NOT NULL,
  inputs_schema_json TEXT NOT NULL DEFAULT '{}',
  outputs_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL CHECK(source IN ('user','agent','community')),
  license TEXT,
  author TEXT,
  admitted INTEGER NOT NULL DEFAULT 0 CHECK(admitted IN (0,1)),
  admission_report_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX pine_scripts_name ON pine_scripts(name);
CREATE INDEX pine_scripts_admitted ON pine_scripts(admitted, updated_at);
