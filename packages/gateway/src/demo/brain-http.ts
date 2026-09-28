import { reserveHttpModel, visitorContext } from './public-demo.js';
import { assertRealModelsAllowed } from './model-guard.js';
// §9.52 HTTP 大脑:用 API key 直连模型服务,实现和 CLI 大脑同一个 `Brain` 接口,调用方无感。
// 两种线协议:OpenAI 兼容 `POST {base}/chat/completions`(openrouter/deepseek/zai/openai/openai_compatible)
// 与 Anthropic `POST {base}/v1/messages`。出站沿用 OKX 那套全局代理(configureOkxProxy → Node 24 fetch 继承 HTTPS_PROXY)。
//
// 密钥纪律:key 只在这里进请求头;任何错误信息先过 redact(key 本身 + 常见 key 形状)再往外抛,
// 调用方(runtime.log / API 响应)拿到的永远是脱敏后的文本。
// 不用 @anthropic-ai/sdk:网关不装模型 SDK(brain.ts 开头的约定),七种连接共用一条 fetch + 代理路径。

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Brain, BrainResult } from './brain.js';
import { configureOkxProxy } from './okx-proxy.js';

/** HTTP 连接的种类(ModelConnection.kind 去掉 cli)。 */
export type HttpConnectionKind = 'openrouter' | 'anthropic' | 'deepseek' | 'zai' | 'openai' | 'openai_compatible';

/** BrainResult + 服务端报的美元花费(openrouter 直接给 usage.cost;其它家没有 = null)。 */
export interface HttpBrainResult extends BrainResult {
  cost_usd: number | null;
}

export interface HttpBrainOptions {
  kind: HttpConnectionKind;
  base_url: string;
  /** openai_compatible 本地服务可以没有 key。 */
  api_key: string | null;
  model: string;
  /** 测试注入;缺省走全局 fetch(先 configureOkxProxy)。 */
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** 429/5xx/连接被掐的重试次数,缺省 2(契约:≤2 次)。 */
  maxRetries?: number;
  /** 每次出站前调用(openai_compatible:重解析 DNS 防 rebinding);抛错 = 本次不发,按 network 失败处理。 */
  guardUrl?: (url: string) => Promise<void>;
}

/** HTTP 调用失败。`auth`=401/403(key 失效/无权限),`network`=连不上/被掐;都视为「绑定失效」。 */
export class HttpBrainError extends Error {
  constructor(message: string, readonly status: number | null, readonly kind: 'auth' | 'network' | 'timeout' | 'http' | 'bad_response') {
    super(message);
    this.name = 'HttpBrainError';
  }
}

/** 常见 API key 形状:sk-or-v1-…、sk-ant-…、sk-…,以及 zai 的 `<32hex>.<16位>`。兜底用,不依赖知道具体 key。 */
const KEY_SHAPES = [/sk-[A-Za-z0-9_-]{16,}/g, /\b[a-f0-9]{32}\.[A-Za-z0-9]{12,}\b/g];

/**
 * 把已知 key 与看起来像 key 的串从文本里抹掉。
 * 所有非空已知 key 都精确替换(不设长度下限:短 key 宁可误伤正文也不能漏);长的先换,避免被短 key 拆碎后漏掉。
 */
export function redactKeyText(text: string, keys: (string | null | undefined)[] = []): string {
  let out = String(text ?? '');
  const known = [...new Set(keys.map((k) => (k ?? '').trim()).filter((k) => k.length > 0))].sort((a, b) => b.length - a.length);
  for (const t of known) out = out.split(t).join('[redacted]');
  for (const re of KEY_SHAPES) out = out.replace(re, '[redacted]');
  return out;
}

// ------------------------------------------------------------------ 出站地址安全(SSRF)
//
// 只有 openai_compatible 连接能自定义 base_url(内置 provider 一律用缺省地址,见 model-connections.ts)。
// 规则:必须 https;不许 userinfo / fragment;host 解析出的每个 IP 都不能落在私网 / 回环 / link-local /
// 云元数据 / CGNAT / 组播 / 保留段。唯一例外:host 是 localhost / 127.0.0.1 / ::1 且连接没有 api_key
// (本机无鉴权推理服务,如 ollama)—— 此时允许 http 与回环。
// 创建、修改、以及每次出站前都过一遍(出站前重解析,挡 DNS rebinding)。
// 198.18.0.0/15 不拦:本机 Clash fake-IP 把所有域名解析到这一段,拦了就一条自定义连接都用不了。

export type LookupFn = (host: string) => Promise<string[]>;

/** 缺省 DNS:系统解析器,返回全部地址。 */
export const defaultLookup: LookupFn = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

export type UnsafeBaseUrlCode = 'bad_request' | 'base_url_insecure' | 'base_url_blocked' | 'base_url_unresolvable';
export class UnsafeBaseUrlError extends Error {
  readonly status = 400;
  constructor(message: string, readonly code: UnsafeBaseUrlCode) {
    super(message);
    this.name = 'UnsafeBaseUrlError';
  }
}

const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

const V4_BLOCKS: [string, number, string][] = [
  ['0.0.0.0', 8, '0.0.0.0/8'],
  ['10.0.0.0', 8, '私网'],
  ['100.64.0.0', 10, 'CGNAT'],
  ['127.0.0.0', 8, '回环'],
  ['169.254.0.0', 16, 'link-local / 云元数据'],
  ['172.16.0.0', 12, '私网'],
  ['192.0.0.0', 24, 'IETF 保留 / 元数据'],
  ['192.168.0.0', 16, '私网'],
  ['224.0.0.0', 4, '组播'],
  ['240.0.0.0', 4, '保留 / 广播'],
];
const V6_BLOCKS: [string, number, string][] = [
  ['::', 128, '未指定地址'],
  ['::1', 128, '回环'],
  ['fc00::', 7, '私网(ULA / 云元数据)'],
  ['fe80::', 10, 'link-local'],
  ['fec0::', 10, 'site-local'],
  ['ff00::', 8, '组播'],
];

const v4Int = (ip: string): number | null => {
  const n = ip.split('.').map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return ((n[0]! << 24) >>> 0) + (n[1]! << 16) + (n[2]! << 8) + n[3]!;
};

function inV4(ip: string): string | null {
  const v = v4Int(ip);
  if (v === null) return '非法 IPv4';
  for (const [net, bits, why] of V4_BLOCKS) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((v & mask) >>> 0) === ((v4Int(net)! & mask) >>> 0)) return why;
  }
  return null;
}

/** IPv6 → 8 个 16 位段(支持 :: 与结尾点分 IPv4);非法 → null。 */
function v6Words(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const v = v4Int(tail[1]!);
    if (v === null) return null;
    s = `${s.slice(0, -tail[1]!.length)}${(v >>> 16).toString(16)}:${(v & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (x: string): number[] => (x ? x.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)) : []);
  const head = part(halves[0]!);
  const rest = halves.length === 2 ? part(halves[1]!) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : head.length !== 8) return null;
  const w = [...head, ...Array<number>(halves.length === 2 ? fill : 0).fill(0), ...rest];
  return w.length === 8 && w.every((x) => Number.isInteger(x)) ? w : null;
}

function inV6(ip: string): string | null {
  const w = v6Words(ip);
  if (!w) return '非法 IPv6';
  const v4 = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  // 内嵌 IPv4:映射(::ffff:a.b.c.d)、兼容(::a.b.c.d)、NAT64(64:ff9b::/96)、6to4(2002::/16)按内嵌地址判。
  const zero5 = w.slice(0, 5).every((x) => x === 0);
  if (zero5 && w[5] === 0xffff) return inV4(v4(w[6]!, w[7]!));
  if (zero5 && w[5] === 0 && (w[6] !== 0 || w[7]! > 1)) return inV4(v4(w[6]!, w[7]!));
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return inV4(v4(w[6]!, w[7]!));
  if (w[0] === 0x2002) return inV4(v4(w[1]!, w[2]!));
  for (const [net, bits, why] of V6_BLOCKS) {
    const nw = v6Words(net)!;
    let hit = true;
    for (let i = 0, left = bits; i < 8 && left > 0; i++, left -= 16) {
      const mask = left >= 16 ? 0xffff : (0xffff << (16 - left)) & 0xffff;
      if ((w[i]! & mask) !== (nw[i]! & mask)) {
        hit = false;
        break;
      }
    }
    if (hit) return why;
  }
  return null;
}

/** 这个 IP 能不能作为出站目标;不能 → 原因(私网 / 回环 / …)。 */
export function blockedIpReason(ip: string): string | null {
  const v = isIP(ip);
  if (v === 4) return inV4(ip);
  if (v === 6) return inV6(ip);
  return '不是 IP';
}

const hostOf = (u: URL): string => u.hostname.replace(/^\[|\]$/g, '').toLowerCase();

/** 语法层校验(不查 DNS);返回规范化后的地址(去掉结尾斜杠)。 */
export function checkBaseUrlSyntax(raw: string, hasKey: boolean): string {
  const s = String(raw ?? '').trim();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new UnsafeBaseUrlError('base_url 不是合法地址', 'bad_request');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UnsafeBaseUrlError('base_url 只能是 https', 'bad_request');
  if (u.username || u.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(s)) throw new UnsafeBaseUrlError('base_url 不能带用户名/密码', 'bad_request');
  if (u.hash || s.includes('#')) throw new UnsafeBaseUrlError('base_url 不能带 #fragment', 'bad_request');
  const host = hostOf(u);
  const localExempt = !hasKey && LOCAL_NAMES.has(host);
  if (u.protocol === 'http:' && !localExempt) {
    throw new UnsafeBaseUrlError(
      LOCAL_NAMES.has(host) ? '带 api_key 的连接必须用 https(本机 http 只允许不带 key 的服务)' : 'base_url 必须 https(只有 localhost / 127.0.0.1 / ::1 且不带 api_key 时可用 http)',
      'base_url_insecure',
    );
  }
  if (!localExempt) {
    if (isIP(host)) {
      const why = blockedIpReason(host);
      if (why) throw new UnsafeBaseUrlError(`base_url 指向不允许的地址 ${host}(${why})`, 'base_url_blocked');
    } else if (host === 'localhost' || host.endsWith('.localhost')) {
      throw new UnsafeBaseUrlError(`base_url 指向本机 ${host}(回环;只有不带 api_key 时允许 localhost)`, 'base_url_blocked');
    }
  }
  return s.replace(/\/+$/, '');
}

/** 语法 + DNS:host 的每个解析结果都必须是公网地址(本机无 key 例外)。返回规范化地址。 */
export async function assertSafeBaseUrl(raw: string, opts: { hasKey: boolean; lookup?: LookupFn }): Promise<string> {
  const normalized = checkBaseUrlSyntax(raw, opts.hasKey);
  const host = hostOf(new URL(normalized));
  if (isIP(host) || (!opts.hasKey && LOCAL_NAMES.has(host))) return normalized;
  let addrs: string[];
  try {
    addrs = await (opts.lookup ?? defaultLookup)(host);
  } catch (e) {
    throw new UnsafeBaseUrlError(`base_url 的域名 ${host} 解析失败:${(e as Error).message}`, 'base_url_unresolvable');
  }
  if (!addrs.length) throw new UnsafeBaseUrlError(`base_url 的域名 ${host} 没有解析结果`, 'base_url_unresolvable');
  for (const a of addrs) {
    const why = blockedIpReason(a);
    if (why) throw new UnsafeBaseUrlError(`base_url 的域名 ${host} 解析到不允许的地址 ${a}(${why})`, 'base_url_blocked');
  }
  return normalized;
}

/** fetch 用 redirect:'manual' 后:3xx(Node)或 opaqueredirect(浏览器,status 0)都算重定向,一律当失败。 */
export const isRedirectResponse = (res: Response): boolean => res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);

const trimSlash = (s: string): string => s.replace(/\/+$/, '');
const approxTokens = (s: string): number => Math.ceil(s.length / 3);

/** Anthropic 的 base 可能写成 https://api.anthropic.com 或 …/v1,两种都接。 */
function anthropicUrl(base: string): string {
  const b = trimSlash(base);
  return /\/v1$/.test(b) ? `${b}/messages` : `${b}/v1/messages`;
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** 从服务端错误体里挑一句人话(OpenAI/Anthropic/OpenRouter 都是 {error:{message}})。 */
function errorDetail(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const m = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message;
    if (typeof m === 'string' && m.trim()) return m.trim().slice(0, 300);
  } catch {
    /* 不是 JSON */
  }
  return body.trim().slice(0, 300);
}

/** 公网演示访客发起的调用:输出 token 硬上限(也是演示花费预留的依据)。 */
const VISITOR_MAX_OUTPUT_TOKENS = 4096;

export function httpBrain(opts: HttpBrainOptions): Brain & { complete(system: string, user: string, o?: { timeoutMs?: number }): Promise<HttpBrainResult> } {
  const name = `${opts.kind}:${opts.model}`;
  const key = opts.api_key?.trim() || null;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 2;
  const redact = (t: string): string => redactKeyText(t, [key]);
  const isAnthropic = opts.kind === 'anthropic';

  const request = (system: string, user: string): { url: string; init: RequestInit } => {
    if (isAnthropic) {
      return {
        url: anthropicUrl(opts.base_url),
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) },
          body: JSON.stringify({ model: opts.model, max_tokens: visitorContext() ? VISITOR_MAX_OUTPUT_TOKENS : 16_000, system, messages: [{ role: 'user', content: user }] }),
        },
      };
    }
    const body: Record<string, unknown> = { model: opts.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: false };
    // OpenRouter:显式要用量记账,响应里带 usage.cost(美元)。
    if (visitorContext()) body['max_tokens'] = VISITOR_MAX_OUTPUT_TOKENS; // 公网演示访客:输出硬上限,花费预留按它算
    if (opts.kind === 'openrouter') body['usage'] = { include: true };
    return {
      url: `${trimSlash(opts.base_url)}/chat/completions`,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(opts.kind === 'openrouter' ? { 'x-title': 'Trading Swarm' } : {}) },
        body: JSON.stringify(body),
      },
    };
  };

  const parse = (raw: string, system: string, user: string): Omit<HttpBrainResult, 'latency_ms'> => {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new HttpBrainError(redact(`响应不是 JSON:${raw.slice(0, 200)}`), 200, 'bad_response');
    }
    let text = '';
    let input = 0;
    let output = 0;
    let cost: number | null = null;
    if (isAnthropic) {
      const content = Array.isArray(j['content']) ? (j['content'] as { type?: string; text?: string }[]) : [];
      text = content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
      const u = (j['usage'] ?? {}) as { input_tokens?: number; output_tokens?: number };
      input = Number(u.input_tokens ?? 0);
      output = Number(u.output_tokens ?? 0);
    } else {
      const choice = (Array.isArray(j['choices']) ? j['choices'][0] : null) as { message?: { content?: unknown } } | null;
      const c = choice?.message?.content;
      text = typeof c === 'string' ? c : Array.isArray(c) ? (c as { text?: string }[]).map((p) => p.text ?? '').join('') : '';
      const u = (j['usage'] ?? {}) as { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      input = Number(u.prompt_tokens ?? 0);
      output = Number(u.completion_tokens ?? 0);
      cost = typeof u.cost === 'number' && Number.isFinite(u.cost) ? u.cost : null;
    }
    text = text.trim();
    if (!text) throw new HttpBrainError('模型返回了空内容', 200, 'bad_response');
    return {
      text,
      model: name,
      input_tokens: input || approxTokens(system + user),
      output_tokens: output || approxTokens(text),
      cost_usd: cost,
    };
  };

  return {
    name,
    async complete(system, user, o) {
      const started = Date.now();
      const budget = o?.timeoutMs ?? 120_000;
      const fetchFn = opts.fetchFn ?? (configureOkxProxy(), globalThis.fetch.bind(globalThis));
      const { url, init } = request(system, user);
      let last: HttpBrainError | null = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const left = budget - (Date.now() - started);
        if (left <= 0) break;
        if (opts.guardUrl) {
          try {
            await opts.guardUrl(url);
          } catch (e) {
            throw new HttpBrainError(redact(`出站地址被拒:${(e as Error).message}`), null, 'network');
          }
        }
        assertRealModelsAllowed(`http ${name}`);
        reserveHttpModel(name, system + user, VISITOR_MAX_OUTPUT_TOKENS);
        let res: Response | null = null;
        try {
          // 不跟随重定向:跟随会把 Authorization / x-api-key 带到新地址,而新地址没过 SSRF 校验。
          res = await fetchFn(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(left) });
        } catch (e) {
          const err = e as Error & { cause?: { message?: string } };
          if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new HttpBrainError(`请求超时(${budget}ms)`, null, 'timeout');
          // 连不上 / 连接被掐:模型还没产出,重试不重复计费。
          last = new HttpBrainError(redact(`连不上 ${new URL(url).host}:${err.cause?.message ?? err.message}`), null, 'network');
        }
        let wait = 1_000 * 2 ** attempt;
        if (res && isRedirectResponse(res)) {
          await res.body?.cancel().catch(() => undefined);
          throw new HttpBrainError(`${res.status} 服务端要求重定向,已拒绝跟随(不把凭证发往新地址);请把 base_url 改成最终地址`, res.status, 'http');
        }
        if (res) {
          const body = await res.text().catch(() => '');
          if (res.ok) return { ...parse(body, system, user), latency_ms: Date.now() - started };
          const detail = redact(`${res.status} ${errorDetail(body)}`);
          if (res.status === 401 || res.status === 403) throw new HttpBrainError(detail, res.status, 'auth');
          last = new HttpBrainError(detail, res.status, 'http');
          if (res.status !== 429 && res.status < 500) throw last; // 400/404 等:重试也没用
          wait = Math.min(10_000, retryAfterMs(res) ?? wait);
        }
        if (attempt >= maxRetries || Date.now() - started + wait >= budget) break;
        await sleep(wait);
      }
      throw last ?? new HttpBrainError(`请求超时(${budget}ms)`, null, 'timeout');
    },
  };
}
