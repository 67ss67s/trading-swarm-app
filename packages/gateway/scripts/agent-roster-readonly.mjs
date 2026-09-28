// 真库只读验收:不迁移、不构造 DemoStore/Runtime/AspAgent、不启动模型或 CLI。
// 先 npm run typecheck,再 node packages/gateway/scripts/agent-roster-readonly.mjs [数据库路径]
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BOT_ROLES } from '../dist/demo/bots.js';
import { systemPrompt } from '../dist/demo/chat.js';
import { aspReadonlyChatTools } from '../dist/demo/asp-agent/chat-read.js';

const path = process.argv[2] ?? join(homedir(), '.trade-gate-okx', 'demo', 'state.sqlite');
const db = new DatabaseSync(path, { readOnly: true });
try {
  db.exec('PRAGMA query_only=ON');
  console.log(JSON.stringify({ database: path, read_only: true, prompts: BOT_ROLES.map((role) => ({ role, characters: systemPrompt(false, role).length, bytes: Buffer.byteLength(systemPrompt(false, role)) })) }, null, 2));
  const tools = aspReadonlyChatTools({ db, kvGet: (key) => db.prepare('SELECT value FROM demo_kv WHERE key=?').get(key)?.value ?? null });
  console.log(JSON.stringify({ tool: 'get_asp_overview', result: tools.get_asp_overview() }, null, 2));
  console.log(JSON.stringify({ sqlite_total_changes: db.prepare('SELECT total_changes() AS n').get().n }));
} finally { db.close(); }
