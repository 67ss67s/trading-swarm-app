/**
 * Pine 引擎(@trade-gate/pine-engine,由网关托管的 PineTS 子进程,见 engine-host.ts)HTTP 客户端。
 *
 * 职责:把 {script, inputs, bars, timeframe} 送进引擎,拿回每个 plot 的、与 bars 一一对齐的序列。
 * 地址从托管器拿(临时端口,每次启动都可能不同),不写死端口。
 * 两条路径共用一份缓存:
 *   - runPine()      异步,给路由 / 准入 / agent 工具用;引擎正在启动时会等它就绪;
 *   - runPineSync()  同步(子进程 fetch),给策略原语 compute() 用——原语接口是同步的,
 *                    而一次回测里同一 (script, inputs, bars) 只会真跑一次,之后全部命中缓存。
 * 缓存键 = (script_hash, inputs_hash, dataset_id 或 bars_hash)。
 *
 * 引擎没起 / 超时 → 抛 PROVIDER_ERROR 并带状态说明,绝不返回空序列冒充「没有信号」。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ResearchBar } from '@trade-gate/contracts';
import { pineEngineHealth, pineEngineHost } from './engine-host.js';
import { PINE_SOURCES } from './inputs-schema.js';

/** 引擎缺席时统一的错误说明——告诉 agent / 前端引擎归谁管、怎么看状态。 */
export const PINE_ENGINE_HINT =
  'Pine 引擎由网关托管自动拉起(packages/pine-engine,AGPL-3.0 独立进程);' +
  '状态看 GET /api/research/pine/health,TG_PINE_ENGINE=0 会关掉它,崩溃连续重启失败后标记 down,需重启网关';

export function pineEngineError(detail: string): Error {
  return new Error(`PROVIDER_ERROR:pine_engine_unavailable:${PINE_ENGINE_HINT};原因:${detail}`);
}

/** 当前可用地址;不可用时抛带状态的 PROVIDER_ERROR。 */
export function pineEngineUrl(): string {
  const url = pineEngineHost()?.url();
  if (url) return url;
  const h = pineEngineHealth();
  const why = h.status === 'disabled' ? '已被 TG_PINE_ENGINE=0 关闭'
    : h.status === 'starting' ? '引擎正在启动(稍后重试)'
    : `引擎不可用(${h.last_error ?? 'down'})`;
  throw pineEngineError(why);
}

/** 异步路径:引擎正在启动就等一会儿再取地址。 */
async function readyUrl(): Promise<string> {
  const host = pineEngineHost();
  if (host && host.health().status === 'starting') await host.ready();
  return pineEngineUrl();
}

export interface PineRunInput {
  script: string;
  inputs?: Record<string, unknown>;
  bars: ResearchBar[];
  timeframe?: string;
  symbol?: string;
  /** 有 dataset_id 时用它做缓存键,省掉逐根哈希。 */
  dataset_id?: string;
}
export interface PineRunResult {
  /** plot 名 → 与 bars 等长的序列,预热段是 null。 */
  series: Record<string, (number | null)[]>;
  bars: number;
  warnings: string[];
  engine_version?: string;
}
/** 准入测试与原语都只依赖这个函数形状,单元测试直接塞 mock。 */
export type PineRunner = (input: PineRunInput) => Promise<PineRunResult>;
export type PineRunnerSync = (input: PineRunInput) => PineRunResult;

const sha = (v: unknown): string =>
  createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v ?? null)).digest('hex').slice(0, 24);

/** bars 指纹:根数 + 首尾时间 + 全部 close/high/low/volume 的滚动哈希,够区分不同数据集。 */
function barsHash(bars: ResearchBar[]): string {
  const h = createHash('sha256');
  h.update(String(bars.length));
  for (const b of bars) h.update(`${b.open_time}|${b.open}|${b.high}|${b.low}|${b.close}|${b.volume}`);
  return h.digest('hex').slice(0, 24);
}

/**
 * IR 里的 inputs 是 [{name,value}] 数组(策略 IR 的 checkIR 只会挨个字段对 schema,
 * 自由形状的对象过不了那道检查),引擎侧要的是 {name: value};这里做一次转换。
 */
export function inputsRecord(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    const out: Record<string, unknown> = {};
    for (const item of raw) {
      const pair = item as { name?: unknown; value?: unknown };
      if (pair && typeof pair.name === 'string') out[pair.name] = pair.value;
    }
    return out;
  }
  return raw as Record<string, unknown>;
}

/** inputs 规范化:键排序后序列化,保证 {a:1,b:2} 与 {b:2,a:1} 同一份缓存。 */
export function canonicalInputs(inputs?: Record<string, unknown>): string {
  const entries = Object.entries(inputs ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

export function pineCacheKey(input: PineRunInput): string {
  const data = input.dataset_id ? `ds:${input.dataset_id}:${input.bars.length}` : `bars:${barsHash(input.bars)}`;
  return `${sha(input.script)}|${sha(canonicalInputs(input.inputs))}|${data}|${input.timeframe ?? ''}`;
}

/**
 * 把 inputs 注入脚本:目录里的脚本按约定用 `name = input.int(默认值, "标题")` 声明参数,
 * 注入时按**变量名**或**标题**定位,替换第一个实参(默认值)。找不到的键直接报错——
 * 静默忽略会让「改了参数却没生效」的回测结果无法解释。
 * 值是拼进源码的,所以只收有限数字 / 布尔 / 字符串;input.source 只收 open/high/low/close… 这几个裸标识符,
 * 数字型 input 收到数字字符串时转成数字——别的一律报错,不让参数变成一段注入的表达式。
 */
export function applyInputs(script: string, inputs?: Record<string, unknown>): string {
  let out = script;
  for (const [key, value] of Object.entries(inputs ?? {})) {
    const byName = new RegExp(`(^[ \\t]*${escapeRe(key)}\\s*=\\s*input(?:\\.\\w+)?\\s*\\()([^,()]*)`, 'm');
    const byTitle = new RegExp(`(input(?:\\.\\w+)?\\s*\\()([^,()]*)(\\s*,\\s*["']${escapeRe(key)}["'])`);
    const nameHit = byName.exec(out), titleHit = nameHit ? null : byTitle.exec(out);
    const head = nameHit?.[1] ?? titleHit?.[1];
    if (!head) throw new Error(`SCHEMA_MISMATCH:pine_input_unknown:${key}`);
    const literal = inputLiteral(key, value, head);
    if (nameHit) out = out.replace(byName, (_m, h: string) => `${h}${literal}`);
    else out = out.replace(byTitle, (_m, h: string, _d: string, tail: string) => `${h}${literal}${tail}`);
  }
  return out;
}
function inputLiteral(key: string, value: unknown, head: string): string {
  const kind = /input\.(\w+)/.exec(head)?.[1] ?? '';
  if (kind === 'source') {
    if (typeof value === 'string' && PINE_SOURCES.includes(value as (typeof PINE_SOURCES)[number])) return value;
    throw new Error(`SCHEMA_MISMATCH:pine_input_invalid:${key}:source 只能是 ${PINE_SOURCES.join('/')}`);
  }
  if ((kind === 'int' || kind === 'float') && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return String(Number(value));
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  throw new Error(`SCHEMA_MISMATCH:pine_input_invalid:${key}:只接受数字/布尔/字符串,收到 ${JSON.stringify(value)}`);
}
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** bars → 引擎的 candles(time 为秒级 open time)。 */
export function toCandles(bars: ResearchBar[]): { time: number; open: number; high: number; low: number; close: number; volume: number }[] {
  return bars.map((b) => ({
    time: Math.floor(b.open_time / 1000),
    open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close),
    volume: Number(b.volume ?? 0),
  }));
}

function shape(payload: unknown, barCount: number): PineRunResult {
  const body = payload as { ok?: boolean; error?: string; detail?: string; series?: Record<string, unknown>; warnings?: unknown[]; version?: string };
  if (!body || body.ok !== true) throw new Error(`PROVIDER_ERROR:pine_script_failed:${String(body?.error ?? 'unknown')}${body?.detail ? '\n' + body.detail : ''}`);
  const series: Record<string, (number | null)[]> = {};
  for (const [name, raw] of Object.entries(body.series ?? {})) {
    if (!Array.isArray(raw)) continue;
    const row = raw.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
    // 引擎保证与 candles 对齐;短了补 null、长了截断,原语按索引取值必须安全。
    while (row.length < barCount) row.push(null);
    series[name] = row.slice(0, barCount);
  }
  return { series, bars: barCount, warnings: (body.warnings ?? []).map(String).slice(0, 20) };
}

const cache = new Map<string, PineRunResult>();
const CACHE_LIMIT = 64;
function remember(key: string, value: PineRunResult): PineRunResult {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, value);
  return value;
}
export function pineCached(key: string): PineRunResult | undefined { return cache.get(key); }
export function clearPineCache(): void { cache.clear(); }

/** 异步跑一段序列(路由 / 准入 / agent 工具)。 */
export async function runPine(
  input: PineRunInput,
  opts: { timeoutMs?: number; signal?: AbortSignal; noCache?: boolean } = {},
): Promise<PineRunResult> {
  const key = pineCacheKey(input);
  // 准入测试的「跑两次必须一致」必须真跑两次,所以它走 noCache。
  const hit = opts.noCache ? undefined : cache.get(key);
  if (hit) return hit;
  const body = JSON.stringify({
    source: applyInputs(input.script, input.inputs),
    candles: toCandles(input.bars),
    symbol: input.symbol ?? 'TEST-USDT',
    interval: input.timeframe ?? '1h',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
  opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  let payload: unknown;
  const base = await readyUrl();
  try {
    const res = await fetch(`${base}/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (e) {
    throw pineEngineError(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
  const shaped = shape(payload, input.bars.length);
  return opts.noCache ? shaped : remember(key, shaped);
}

/**
 * 同步跑一段序列。Node 没有同步 HTTP,所以借一个 `node -e` 子进程发请求——
 * 只在原语 compute() 里用,并且一次回测同一 (script,inputs,bars) 只发一次,之后走缓存。
 */
export function runPineSync(input: PineRunInput, opts: { timeoutMs?: number } = {}): PineRunResult {
  const key = pineCacheKey(input);
  const hit = cache.get(key);
  if (hit) return hit;
  const request = JSON.stringify({
    url: `${pineEngineUrl()}/run`,
    body: {
      source: applyInputs(input.script, input.inputs),
      candles: toCandles(input.bars),
      symbol: input.symbol ?? 'TEST-USDT',
      interval: input.timeframe ?? '1h',
    },
  });
  const script = `let raw='';process.stdin.on('data',c=>raw+=c).on('end',async()=>{const r=JSON.parse(raw);try{const res=await fetch(r.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(r.body)});process.stdout.write(JSON.stringify({__http:res.status,...(await res.json())}));}catch(e){process.stdout.write(JSON.stringify({__err:String(e&&e.message||e)}));}});`;
  const child = spawnSync(process.execPath, ['-e', script], {
    input: request, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 30000,
  });
  if (child.error || child.status !== 0) throw pineEngineError(String(child.error?.message ?? child.stderr ?? `exit ${child.status}`).slice(0, 400));
  let payload: { __err?: string; __http?: number } & Record<string, unknown>;
  try { payload = JSON.parse(child.stdout || '{}'); } catch { throw pineEngineError(`子进程输出无法解析:${child.stdout.slice(0, 200)}`); }
  if (payload.__err) throw pineEngineError(payload.__err);
  if (payload.__http && payload.__http >= 400) throw pineEngineError(`HTTP ${payload.__http}`);
  return remember(key, shape(payload, input.bars.length));
}

/** 引擎健康(托管器视图);不抛错,给 /api/research/pine/health 直接用。 */
export { pineEngineHealth } from './engine-host.js';
