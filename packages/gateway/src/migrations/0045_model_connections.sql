-- §9.52 模型连接与角色底层。只存元数据;密钥单独放 <状态库目录>/secrets/model-keys.json(600),永不进库。
CREATE TABLE model_connections (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('openrouter','anthropic','deepseek','zai','openai','openai_compatible','cli')),
  label TEXT NOT NULL,
  base_url TEXT,
  cli TEXT CHECK(cli IS NULL OR cli IN ('pi','claude','codex')),
  key_masked TEXT,
  status TEXT NOT NULL DEFAULT 'untested' CHECK(status IN ('untested','ok','error')),
  last_test_json TEXT,
  models_hint_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- 一个角色一行;没有行 = 回退旧槽位(chat/judge/research → 主脑,filter/reviewer/utility → 副脑,decision → 未设置)。
CREATE TABLE model_role_bindings (
  role TEXT PRIMARY KEY CHECK(role IN ('chat','judge','research','filter','reviewer','utility','decision')),
  connection_id TEXT NOT NULL REFERENCES model_connections(id),
  model TEXT,
  updated_at INTEGER NOT NULL
);
