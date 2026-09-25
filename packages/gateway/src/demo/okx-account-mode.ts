/**
 * §9.40 OKX 账户模式切换(acctLv 1 简单 / 2 单币种保证金 / 3 跨币种保证金 / 4 组合保证金)。
 *
 * okx CLI 1.4.7 没封装 `POST /api/v5/account/set-account-level`,只能网关自己签名直打。
 * 这是网关「不读 key」边界(okx-atk 设计 §1)的**第二个明确例外**,范围限定为:
 *   - 只在 `setAccountLevel()` 这一个调用里读 `~/.okx/config.toml` 的 profile 三件套;
 *   - 读到的 key 只进 HMAC 与请求头,不进日志、不进事件、不回显、不缓存到模块变量;
 *   - 只打这一个端点(以及配套的只读 `GET /api/v5/account/config`),不做任何下单类请求。
 * 实测(2026-09-21):从简单模式第一次切出 OKX 回 51070(必须网页/App 做合约测评),之后 2/3/4 互切放行。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { okxConfigPath } from './execution-okx.js';
import { configureOkxProxy } from './okx-proxy.js';

export type AcctLv = 1 | 2 | 3 | 4;
export const ACCT_LV_LABEL: Record<AcctLv, string> = { 1: '简单模式', 2: '单币种保证金', 3: '跨币种保证金', 4: '组合保证金' };

export interface OkxProfileSecrets {
  name: string;
  api_key: string;
  secret_key: string;
  passphrase: string;
  demo: boolean;
  site: string;
}

/** okx config 只有 `default_profile = "x"` + `[profiles.x]` 段 + `key = "value"`;不引 TOML 依赖,够用就好。 */
export function parseOkxToml(text: string): { default_profile: string | null; profiles: Record<string, Record<string, string | boolean>> } {
  const out: { default_profile: string | null; profiles: Record<string, Record<string, string | boolean>> } = { default_profile: null, profiles: {} };
  let cur: Record<string, string | boolean> | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      const parts = sec[1]!.split('.');
      if (parts[0] === 'profiles' && parts[1]) {
        cur = out.profiles[parts[1]] ??= {};
      } else {
        cur = null;
      }
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    // 值:带引号的取到配对引号为止(passphrase 可能含 #),裸值剥掉行尾注释
    let v: string | boolean = kv[2]!.trim();
    const q = v[0];
    if (q === '"' || q === "'") {
      const end = v.indexOf(q, 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else {
      v = v.split('#', 1)[0]!.trim();
      if (v === 'true' || v === 'false') v = v === 'true';
    }
    if (cur) cur[kv[1]!] = v;
    else if (kv[1] === 'default_profile') out.default_profile = String(v);
  }
  return out;
}

export function readProfileSecrets(profile?: string | null, file = okxConfigPath()): OkxProfileSecrets {
  const cfg = parseOkxToml(fs.readFileSync(file, 'utf8'));
  const name = profile ?? cfg.default_profile;
  if (!name || !cfg.profiles[name]) throw new Error(`okx 配置里找不到 profile「${name ?? '(默认)'}」`);
  const p = cfg.profiles[name]!;
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  if (!s('api_key') || !s('secret_key') || !s('passphrase')) throw new Error(`profile「${name}」缺 api_key/secret_key/passphrase`);
  return { name, api_key: s('api_key'), secret_key: s('secret_key'), passphrase: s('passphrase'), demo: p['demo'] === true || p['demo'] === 'true', site: s('site') || 'global' };
}

/** OKX 各站点的 REST 基址(和 okx CLI 的 site 取值对齐)。 */
export function okxRestBase(site: string): string {
  switch (site) {
    case 'eea':
      return 'https://eea.okx.com';
    case 'us':
      return 'https://app.okx.com';
    case 'tr':
      return 'https://tr.okx.com';
    default:
      return 'https://www.okx.com';
  }
}

export function signOkx(secret: string, ts: string, method: string, path: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(ts + method + path + body).digest('base64');
}

export interface OkxApiResult {
  code: string;
  msg: string;
  data: unknown[];
}

export type OkxFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

async function signedCall(sec: OkxProfileSecrets, method: 'GET' | 'POST', path: string, body: Record<string, unknown> | null, fetchFn: OkxFetch, timeoutMs: number): Promise<OkxApiResult> {
  const ts = new Date().toISOString();
  const raw = body ? JSON.stringify(body) : '';
  const headers: Record<string, string> = {
    'OK-ACCESS-KEY': sec.api_key,
    'OK-ACCESS-SIGN': signOkx(sec.secret_key, ts, method, path, raw),
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-PASSPHRASE': sec.passphrase,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (sec.demo) headers['x-simulated-trading'] = '1';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(okxRestBase(sec.site) + path, { method, headers, body: body ? raw : undefined, signal: ctrl.signal });
    const text = await res.text();
    try {
      const j = JSON.parse(text) as Partial<OkxApiResult>;
      return { code: String(j.code ?? res.status), msg: String(j.msg ?? ''), data: Array.isArray(j.data) ? j.data : [] };
    } catch {
      return { code: String(res.status), msg: `HTTP ${res.status} 非 JSON 响应`, data: [] };
    }
  } finally {
    clearTimeout(timer);
  }
}

export interface SetAccountLevelResult {
  ok: boolean;
  /** OKX 业务码;成功 '0' */
  code: string;
  msg: string;
  /** 切换后现查的 acctLv(查不到 null) */
  acct_lv: AcctLv | null;
}

/** 已知业务码的中文解释;其余原样透出 OKX 的 msg。 */
export function explainAccountLevelError(code: string, msg: string): string {
  switch (code) {
    case '51070':
      return '不满足切换条件:从简单模式第一次切出必须在 OKX 网页/App 完成合约风险测评;已离开简单模式后 2/3/4 之间才能由这里切';
    case '51071':
    case '51072':
    case '51073':
    case '51074':
      return `OKX 拒绝(${code}):${msg || '账户当前状态不允许切换(持仓/挂单/借币/资产门槛)'}`;
    case '50111':
    case '50113':
      return `API key 无效或没权限(${code}):请重新 okx config init`;
    default:
      return `OKX 拒绝(${code}):${msg || '未知原因'}`;
  }
}

/**
 * 切账户模式。`profile` 不传用 config 的 default_profile。不做任何缓存,每次现读配置。
 * `fetchFn` 只在测试里注入;真实路径用全局 fetch(已由 configureOkxProxy 接上代理)。
 */
export async function setAccountLevel(target: AcctLv, profile?: string | null, fetchFn: OkxFetch = globalThis.fetch as unknown as OkxFetch, configFile?: string): Promise<SetAccountLevelResult> {
  configureOkxProxy();
  const sec = readProfileSecrets(profile, configFile);
  const r = await signedCall(sec, 'POST', '/api/v5/account/set-account-level', { acctLv: String(target) }, fetchFn, 20_000);
  let acct_lv: AcctLv | null = null;
  try {
    const cfg = await signedCall(sec, 'GET', '/api/v5/account/config', null, fetchFn, 15_000);
    const lv = Number((cfg.data[0] as { acctLv?: string } | undefined)?.acctLv);
    acct_lv = lv === 1 || lv === 2 || lv === 3 || lv === 4 ? lv : null;
  } catch {
    /* 只读回查失败不影响主结果 */
  }
  return { ok: r.code === '0', code: r.code, msg: r.msg, acct_lv };
}
