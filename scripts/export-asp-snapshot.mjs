#!/usr/bin/env node
// 信号市场(OKX.AI / ASP)只读快照导出:在本机跑,只读 GET 本机网关(默认 18811),把信号市场页用到的读接口
// 响应存成一个 JSON(见 packages/gateway/src/demo/asp-snapshot.ts),给评审版服务器的 TG_PUBLIC_ASP_SNAPSHOT 用。
//
// 用法:node scripts/export-asp-snapshot.mjs [--base http://127.0.0.1:18811] [--out asp-snapshot.json] [--redact-content]
//   --redact-content  交付/信号正文只留前 160 字摘要(默认保留全文)
//
// 脱敏:去掉设备 ID、邮箱、本机路径、进程号、CLI 原始 stderr/报错、任何 key/token/secret/私密字段;
// 钱包地址保留(链上公开)。
import { writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = opt('--base', 'http://127.0.0.1:18811').replace(/\/$/, '');
const OUT = path.resolve(opt('--out', 'asp-snapshot.json'));
const REDACT_CONTENT = args.includes('--redact-content');
const CONTENT_CHARS = 160;
const CATALOG_PAGE_SIZE = 60; // 与 webui components/market/catalog.tsx 一致
const CATALOG_DEFAULT = { category: 'ALL', sort: 'hot' };
const DETAIL_LIMIT = 60;

// ---------------------------------------------------------------- 脱敏

const NULL_KEY = /^(?:thisDeviceId|device_?id)$/i; // 前端认这个键,留键置空
const DROP_KEY = /^(?:devices?|email|login_type|account_id|uid|api_?key|secret.*|.*_secret|.*password.*|passphrase|.*token.*|private_?key|mnemonic|seed|session.*|stderr|stdout|raw|raw_.*|cli|cli_.*|command|commands|args|argv|pid|path|.*_path|home|cwd|dir|directory|env|headers|cookie)$/i;
const ERROR_KEY = /^(?:error|errors|last_error|raw_message|hint|detail)$/i;
const CONTENT_KEY = /^(?:content|text|body|message_text|deliverable|deliverable_text|payload_text|summary_text|markdown)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LOCAL_PATH = /\/(?:Users|home|root|private|tmp|var|opt|etc)\/[^\s"'<>),]+/g;
const CLI_NOISE = /Command failed|execFile|spawn |ENOENT|\bat .+\(.+:\d+:\d+\)|--data\b|stderr|onchainos |okx-a2a |okx-trade-cli/i;

export function redactString(text) {
  return text.replace(EMAIL, '[email hidden]').replace(LOCAL_PATH, '[path hidden]').replace(/\bpid=\d+/g, '').replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}/g, '[key hidden]');
}

export function redact(value, key = '', depth = 0) {
  if (depth > 40) return null;
  if (typeof value === 'string') {
    if (ERROR_KEY.test(key) && CLI_NOISE.test(value)) return '[CLI error hidden]';
    let s = redactString(value);
    if (REDACT_CONTENT && CONTENT_KEY.test(key) && s.length > CONTENT_CHARS) s = `${s.slice(0, CONTENT_CHARS)}…`;
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, key, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (NULL_KEY.test(k)) {
        out[k] = null;
        continue;
      }
      if (DROP_KEY.test(k)) continue;
      out[k] = redact(v, k, depth + 1);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- 抓取

async function get(p) {
  const res = await fetch(BASE + p, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${p} → HTTP ${res.status}`);
  return res.json();
}

const qs = (o) => {
  const entries = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}` : '';
};

async function main() {
  const endpoints = {};
  const failures = [];
  const grab = async (p) => {
    try {
      endpoints[p] = redact(await get(p));
      return endpoints[p];
    } catch (e) {
      failures.push(`${p}: ${e.message}`);
      return null;
    }
  };

  await grab('/api/market/status');
  await grab('/api/okx/account');
  const asp = await grab('/api/market/asp');
  await grab('/api/market/settings');
  await grab('/api/market/asp/deliveries?limit=200');
  await grab('/api/market/asp/deliveries?limit=100');
  const subs = await grab('/api/market/subscriptions');
  await grab('/api/market/inbox');
  await grab('/api/market/inbox?limit=300');
  await grab('/api/asp-services');
  const products = await grab('/api/asp-services/products');
  await grab('/api/asp-services/provider-tasks');

  const ownId = asp?.identity?.agentId;
  if (ownId) await grab(`/api/market/asp/${encodeURIComponent(ownId)}`);
  for (const s of subs?.subscriptions ?? []) {
    if (!s?.job_id) continue;
    await grab(`/api/market/subscriptions/${encodeURIComponent(s.job_id)}/scorecard`);
  }
  for (const item of products?.items ?? products?.products ?? []) {
    if (item?.key) await grab(`/api/asp-services/products/${encodeURIComponent(item.key)}/customers`);
  }

  // 目录:默认视图翻页 + 各分类第一页;前 DETAIL_LIMIT 个 agent 的详情
  const first = await grab(`/api/market/catalog${qs({ ...CATALOG_DEFAULT, page: 1, page_size: CATALOG_PAGE_SIZE })}`);
  const pages = first ? Math.max(1, Math.ceil((first.total ?? 0) / CATALOG_PAGE_SIZE)) : 1;
  for (let page = 2; page <= Math.min(pages, 10); page++) await grab(`/api/market/catalog${qs({ ...CATALOG_DEFAULT, page, page_size: CATALOG_PAGE_SIZE })}`);
  for (const c of first?.categories ?? []) {
    if (c?.id && c.id !== 'ALL') await grab(`/api/market/catalog${qs({ category: c.id, sort: 'hot', page: 1, page_size: CATALOG_PAGE_SIZE })}`);
  }
  for (const a of (first?.agents ?? []).slice(0, DETAIL_LIMIT)) {
    if (a?.agent_id) await grab(`/api/market/catalog/${encodeURIComponent(a.agent_id)}`);
  }

  const snapshot = { version: 1, as_of: Date.now(), source: `okx-devday ${new URL(BASE).port || BASE} (read-only export${REDACT_CONTENT ? ', content redacted' : ''})`, endpoints };
  const text = JSON.stringify(snapshot);
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, OUT); // 原子替换:服务器按 mtime 热加载,不会读到半截文件
  const counts = Object.fromEntries(Object.entries(endpoints).map(([k, v]) => {
    const arr = v && typeof v === 'object' ? Object.values(v).find(Array.isArray) : null;
    return [k, Array.isArray(v) ? v.length : arr ? arr.length : 1];
  }));
  console.log(JSON.stringify({ out: OUT, bytes: Buffer.byteLength(text), endpoints: Object.keys(endpoints).length, counts, failures }, null, 2));
  if (!Object.keys(endpoints).length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
