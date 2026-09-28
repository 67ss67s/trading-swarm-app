import { dependencyHealth } from '../dependency-health.js';
import type { DatabaseSync } from 'node:sqlite';
/**
 * ASP 侧唯一接单方:轮询 `onchainos agent asp list-tasks`,按任务类型分发到处理器注册表。
 *
 * onchainos 4.6.2 起买方下单(订阅 sub_open / 按次 job_asp_selected)后,ASP 必须在 3 小时内自己
 * `accept-subscription` / `accept-job-by-provider`,否则任务过期;接单后才允许 deliver。
 * 账本 okx_market_provider_task(job_id 主键)在任何写命令之前落状态,保证:
 *  - 同一 job 至多一个 accept / decline(只有「连接没建立」或回查仍是 CREATED 才允许有限重试);
 *  - accept 失败或结果未知一律不 deliver;
 *  - deliver 前先落 delivering,中断或结果未知不自动重发(人工核实后可 retry)。
 * 单实例:进程内防重入 + 机器级锁文件(同一台机器共用一个 onchainos 钱包,多个网关只能一个接单)。
 */
import { closeSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DemoStore } from '../store.js';
import { CliError, MarketCli, object, spawnCli, type CliRunner } from './cli.js';
import { validateSignalText } from './publisher.js';
import { captainHandoff, startAspRun } from './audit.js';

export type ProviderTaskKind = 'subscription' | 'one_time';
export interface ProviderTask {
  job_id: string; kind: ProviderTaskKind;
  /** 0=CREATED 待接,1=ACCEPTED/ACTIVE;其余见 CLI statusLabel */
  status: number | null; status_label: string | null;
  service_id: string | null; service_name: string | null;
  buyer_agent_id: string | null; buyer_name: string | null; title: string | null;
  /** 平台审核账号下的测试单 */
  test_flag: boolean;
  raw: Record<string, unknown>;
  /** `asp status <job>` 的 payload.task(决策前刷新) */
  detail: Record<string, unknown> | null;
}
export interface ProviderContext { asp_id: string; cli: MarketCli; store: DemoStore; log(level: 'info' | 'warn' | 'error', msg: string): void; now(): number; }
export type ProviderDecision = { accept: true } | { accept: false; reason: string };
/** follow_up:主交付成功后按序补发的详情(尽力而为,失败只记日志;订阅欢迎包用它在信号行之后附完整内容) */
export type ProviderOutput = { text: string; follow_up?: string[] } | { skip: string };
export interface ProviderHandler {
  /** 接单前的纯判断,不许调写命令;不实现 = 接。 */
  decide?(task: ProviderTask, ctx: ProviderContext): ProviderDecision | Promise<ProviderDecision>;
  /** 接单确认后调用一次,返回交付文本;deliver 与落账由 poller 负责。 */
  produce(task: ProviderTask, ctx: ProviderContext): Promise<ProviderOutput>;
}
/**
 * 订阅交付前建立与买方的 A2A 会话(官方参考实现 ensure_session 同款,幂等)。
 * 返回是否成功;失败时调用方不要 deliver,下一轮再试。
 */
export async function ensureBuyerSession(job: string, buyer: string | null, ctx: { asp_id: string; runner?: CliRunner }): Promise<boolean> {
  if (!buyer) return false;
  const r = await (ctx.runner ?? spawnCli)('okx-a2a', ['session', 'create', '--job-id', job, '--my-agent-id', ctx.asp_id, '--to-agent-id', buyer, '--json'], 30_000);
  return r.code === 0;
}
export type ProviderRegistry = Map<string, ProviderHandler>;
const globalRegistry: ProviderRegistry = new Map();
/** key:'service:<serviceId>'(精确,优先) > 'one_time' / 'subscription'(按类型兜底)。返回注销函数。 */
export function registerProviderHandler(key: string, handler: ProviderHandler, registry: ProviderRegistry = globalRegistry): () => void {
  registry.set(key, handler);
  return () => { if (registry.get(key) === handler) registry.delete(key); };
}
export function resolveProviderHandler(task: Pick<ProviderTask, 'kind' | 'service_id'>, registry: ProviderRegistry = globalRegistry): { key: string; handler: ProviderHandler } | null {
  for (const key of [task.service_id ? `service:${task.service_id}` : null, task.kind]) {
    const handler = key ? registry.get(key) : undefined;
    if (key && handler) return { key, handler };
  }
  return null;
}

type State = 'seen' | 'no_handler' | 'declining' | 'declined' | 'decline_unknown' | 'accepting' | 'accepted' | 'accept_unknown'
  | 'delivering' | 'delivered' | 'deliver_failed' | 'deliver_unknown' | 'skipped' | 'closed';
export interface ProviderTaskRow {
  job_id: string; kind: ProviderTaskKind; service_id: string | null; buyer_agent_id: string | null; handler_key: string | null;
  state: State; remote_status: number | null; accept_attempts: number; deliver_attempts: number; error: string | null;
  deliverable_text: string | null; result: unknown; test_flag: boolean; created_at: number; updated_at: number;
}
const MAX_ACCEPT_ATTEMPTS = 2; const MAX_DELIVER_ATTEMPTS = 3; const UNKNOWN_RECHECK_MS = 120_000;
const TERMINAL_STATUSES = new Set([3, 4, 5, 6, 7, 8, 9]);
const CONNECT_PHASE = /tls handshake|\(connect\)|connection refused|timed out connecting|dns/i;
const NOT_ACCEPTED_YET = /must be accepted \(1\) before delivery/i;
const ACCEPT_WINDOW_EXPIRED = /accept window expired/i;
const connectFailure = (e: unknown) => e instanceof CliError && e.code === 'network_unavailable' && CONNECT_PHASE.test(e.raw_message);
const str = (v: unknown): string | null => v === null || v === undefined || v === '' ? null : String(v);
const num = (v: unknown): number | null => v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const STATUS_CODES: Record<string, number> = { INIT: -1, CREATED: 0, ACCEPTED: 1, ACTIVE: 1, SUBMITTED: 2, REFUSED: 3, REJECTED: 3, DISPUTED: 4, ADMIN_STOPPED: 5, COMPLETE: 6, COMPLETED: 6, CLOSE: 7, CLOSED: 7, EXPIRED: 8, FAILED: 9 };
/** 4.6.2 的 list-tasks / asp status 里 status 是名字(「CREATED」),数字在 statusCode;两种都认。 */
export function taskStatus(o: Record<string, unknown> | null | undefined): number | null {
  if (!o) return null;
  const code = num(o['statusCode']); if (code !== null) return code;
  const raw = o['status']; const n = num(raw); if (n !== null) return n;
  const name = String(raw ?? o['statusName'] ?? '').toUpperCase();
  return name in STATUS_CODES ? STATUS_CODES[name]! : null;
}
/** 在任意嵌套对象里找第一个 serviceId(按次任务详情的结构没有样本,尽力而为)。 */
export function normalizeProviderTask(item: Record<string, unknown>): ProviderTask | null {
  const job = str(item['jobId'] ?? item['job_id']); if (!job) return null;
  const type = String(item['taskType'] ?? item['jobType'] ?? '').toLowerCase();
  const kind: ProviderTaskKind = type.includes('sub') || type === '1' || Number(item['trialType']) === 1 || item['subStartTime'] !== undefined ? 'subscription' : 'one_time';
  return {
    job_id: job, kind, status: taskStatus(item), status_label: str(item['statusLabel'] ?? item['statusName']),
    service_id: str(item['serviceId'] ?? item['service_id']), service_name: str(item['serviceName'] ?? item['jobName']),
    buyer_agent_id: str(item['userAgentId'] ?? item['buyerAgentId'] ?? item['clientAgentId']), buyer_name: str(item['userName'] ?? item['buyerName']),
    title: str(item['jobName'] ?? item['title']), test_flag: item['testFlag'] === true, raw: item, detail: null,
  };
}

export interface ProviderPollerDeps {
  store: DemoStore; cli: MarketCli;
  /** 没有 ASP 身份时返回 null(不轮询) */
  aspId: () => Promise<string | null>;
  /** `okx-a2a session create`,deliver 前建会话;返回是否成功 */
  ensureSession: (job: string, asp: string, buyer: string | null) => Promise<boolean>;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  emit: (event: string, payload: unknown) => void;
  registry?: ProviderRegistry; now?: () => number; intervalMs?: number; lockPath?: string;
  /** 守护进程逐条记录系统事件原文的日志(默认 ~/.okx-agent-task/logs/llm.log);按次单的 serviceId/serviceParams 只在 job_asp_selected 事件里有 */
  eventLogPath?: string;
  /** 只有这个 serviceId(策略信号)的订阅交付要过【Futures】/【Spot】+200 字的信号格式检查;不提供 = 所有订阅都检查 */
  strictSignalService?: () => string | null;
}
export interface ProviderEventRow { job_id: string; event: string | null; service_id: string | null; service_params: string | null; client_agent_id: string | null; description: string | null }
const EVENT_LOG_OFFSET_KEY = 'provider_poller.event_log_offset';
const EVENT_LOG_FIRST_READ = 4 * 1024 * 1024;
/** `agent status` 纯文本里的 description: 行(可能折行,取到下一个「  键:」为止) */
export function parseStatusDescription(text: string): string | null {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  const i = lines.findIndex((l) => /^\s*description:\s*/i.test(l)); if (i < 0) return null;
  const out = [lines[i]!.replace(/^\s*description:\s*/i, '')];
  for (const l of lines.slice(i + 1)) { if (/^\s*[A-Za-z][A-Za-z ]*:\s/.test(l) || !l.trim()) break; out.push(l.trim()); }
  const d = out.join('\n').trim(); return d || null;
}
export class ProviderTaskPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<unknown> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private lockHeld = false;
  private lastTick: { at: number; error: string | null; tasks: number; locked: boolean } | null = null;
  constructor(private readonly deps: ProviderPollerDeps) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS okx_market_provider_task (
      job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, service_id TEXT, buyer_agent_id TEXT, handler_key TEXT,
      state TEXT NOT NULL, remote_status INTEGER, accept_attempts INTEGER NOT NULL DEFAULT 0, deliver_attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT, deliverable_text TEXT, result_json TEXT, raw_json TEXT, test_flag INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS okx_market_provider_event (
      job_id TEXT PRIMARY KEY, event TEXT, service_id TEXT, service_params TEXT, client_agent_id TEXT, description TEXT, raw_json TEXT, updated_at INTEGER NOT NULL)`);
    // 中断在 deliver 途中的单结果未知,不自动重发(accepting 留给下一轮按远端状态对账)。
    this.db.prepare("UPDATE okx_market_provider_task SET state='deliver_unknown',error='进程中断,投递结果未知;人工核实后可重发',updated_at=? WHERE state='delivering'").run(this.now());
  }
  private get db() { return this.deps.store.marketDb; }
  private now() { return (this.deps.now ?? Date.now)(); }
  private get registry() { return this.deps.registry ?? globalRegistry; }
  private get lockPath() { return this.deps.lockPath ?? join(homedir(), '.trade-gate-provider-poller.lock'); }

  start(): void {
    if (this.timer) return;
    const ms = this.deps.intervalMs ?? 60_000;
    this.first = setTimeout(() => { this.first = null; void this.tick(); }, 5_000); this.first.unref?.();
    this.timer = setInterval(() => { void this.tick(); }, ms); this.timer.unref?.();
  }
  async stop(): Promise<void> {
    if (this.first) clearTimeout(this.first); this.first = null;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    await this.running?.catch(() => undefined);
    this.releaseLock();
  }
  status() { return { running: !!this.timer, working: this.running !== null, interval_ms: this.deps.intervalMs ?? 60_000, lock_held: this.lockHeld, last_tick: this.lastTick }; }

  /** 机器级单实例锁:文件里写 pid,持有者进程还活着就让出。 */
  private acquireLock(): boolean {
    if (this.lockHeld) return true;
    for (let i = 0; i < 2; i++) {
      try { const fd = openSync(this.lockPath, 'wx'); writeSync(fd, String(process.pid)); closeSync(fd); this.lockHeld = true; return true; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
        let pid = NaN; try { pid = Number(readFileSync(this.lockPath, 'utf8').trim()); } catch {}
        if (pid === process.pid) { this.lockHeld = true; return true; }
        let alive = false; if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); alive = true; } catch (err) { alive = (err as NodeJS.ErrnoException).code === 'EPERM'; } }
        if (alive) return false;
        try { unlinkSync(this.lockPath); } catch {}
      }
    }
    return false;
  }
  private releaseLock(): void {
    if (!this.lockHeld) return; this.lockHeld = false;
    try { if (Number(readFileSync(this.lockPath, 'utf8').trim()) === process.pid) unlinkSync(this.lockPath); } catch {}
  }

  /** 单轮;并发调用共享同一轮。 */
  tick(): Promise<{ tasks: number; locked?: boolean; error?: string }> {
    if (this.running) return this.running as Promise<{ tasks: number }>;
    const p = this.tickInner().finally(() => { if (this.running === p) this.running = null; });
    this.running = p; return p;
  }
  private async tickInner(): Promise<{ tasks: number; locked?: boolean; error?: string }> {
    if (!this.acquireLock()) { this.lastTick = { at: this.now(), error: null, tasks: 0, locked: true }; return { tasks: 0, locked: true }; }
    let asp: string | null = null;
    try {
      asp = await this.deps.aspId(); if (!asp) return { tasks: 0 };
      const tasks = await this.listTasks(asp);
      await this.enrich(tasks, asp);
      for (const task of tasks) {
        try { await this.process(task, asp); }
        catch (e) { this.deps.log('warn', `provider task ${task.job_id}: ${(e as Error).message}`); this.patch(task.job_id, { error: (e as Error).message }); }
      }
      dependencyHealth.observe('a2a', true);
      this.lastTick = { at: this.now(), error: null, tasks: tasks.length, locked: false };
      return { tasks: tasks.length };
    } catch (e) {
      dependencyHealth.observe('a2a', false, e);
      const message = (e as Error).message; this.lastTick = { at: this.now(), error: message, tasks: 0, locked: false };
      return { tasks: 0, error: message };
    }
  }
  private async listTasks(asp: string): Promise<ProviderTask[]> {
    const out: ProviderTask[] = [];
    for (let page = 1; page <= 5; page++) {
      const r = object(object((await this.deps.cli.call('asp', ['list-tasks', '--agent-id', asp, '--page', String(page), '--limit', '50']))['data']));
      const p = object(r['payload'] ?? r);
      const items = Array.isArray(p['items']) ? (p['items'] as unknown[]).map(object) : [];
      for (const item of items) { const t = normalizeProviderTask(item); if (t) out.push(t); }
      if (p['hasMore'] !== true) break;
    }
    return out;
  }
  /**
   * list-tasks 不带 serviceId:订阅从 `my-subscriptions --role provider` 补(同时补买方 id),
   * 按次从 `agent status <job>` 里找。账本里已有 service_id 的不再查。
   */
  private async enrich(tasks: ProviderTask[], asp: string): Promise<void> {
    this.ingestEvents(asp);
    for (const t of tasks) {
      if (!t.service_id) t.service_id = this.row(t.job_id)?.service_id ?? null;
      const ev = this.event(t.job_id);
      if (ev) { t.service_id ??= ev.service_id; t.buyer_agent_id ??= ev.client_agent_id; }
    }
    if (tasks.some((t) => t.kind === 'subscription' && !t.service_id)) {
      const r = object((await this.deps.cli.call('my-subscriptions', ['--role', 'provider']))['data']);
      const rows = Array.isArray(r['list']) ? (r['list'] as unknown[]).map(object) : [];
      for (const t of tasks) {
        const hit = rows.find((x) => String(x['jobId'] ?? '').toLowerCase() === t.job_id.toLowerCase()); if (!hit) continue;
        t.service_id ??= str(hit['serviceId']); t.buyer_agent_id ??= str(hit['buyerAgentId']);
        if (String(hit['providerAgentId'] ?? asp) !== asp) t.service_id = null; // 不是本 ASP 的单
      }
    }
    // 按次单的买方描述只在 `agent status` 的纯文本里;待接/已接且还没取过的取一次存账本
    for (const t of tasks) if (t.kind === 'one_time' && [0, 1].includes(taskStatus({ status: t.status }) ?? -1) && !this.event(t.job_id)?.description) {
      try {
        const r = await this.deps.cli.runner('onchainos', ['agent', 'status', t.job_id, '--agent-id', asp], 20_000);
        const description = r.code === 0 ? parseStatusDescription(r.stdout) : null;
        if (description) this.upsertEvent(t.job_id, { description });
      } catch (e) { this.deps.log('warn', `按次任务 ${t.job_id} 取描述失败:${(e as Error).message}`); }
    }
  }
  /** 增量读守护进程事件日志:只收本 ASP 的系统事件(一行一个 JSON),按 jobId 存 serviceId / serviceParams / 买方 */
  ingestEvents(asp: string): void {
    const path = this.deps.eventLogPath ?? join(homedir(), '.okx-agent-task', 'logs', 'llm.log');
    let size: number; try { size = statSync(path).size; } catch { return; }
    let offset = Number(this.deps.store.kvGet(EVENT_LOG_OFFSET_KEY) ?? NaN);
    if (!Number.isFinite(offset) || offset < 0 || offset > size) offset = Math.max(0, size - EVENT_LOG_FIRST_READ); // 首读 / 日志被截断
    if (size <= offset) return;
    const buf = Buffer.alloc(size - offset); const fd = openSync(path, 'r');
    try { readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
    const end = buf.lastIndexOf(0x0a); if (end < 0) return;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.startsWith('{"agentId":')) continue;
      let o: Record<string, unknown>; try { o = object(JSON.parse(line)); } catch { continue; }
      const m = object(o['message']); const job = str(m['jobId']);
      if (String(o['agentId']) !== asp || m['source'] !== 'system' || !job) continue;
      const params = m['serviceParams'];
      this.upsertEvent(job, { event: str(m['event']), service_id: str(m['serviceId']), service_params: params === undefined || params === null ? null : typeof params === 'string' ? params : JSON.stringify(params), client_agent_id: str(m['clientAgentId'] ?? m['buyerAgentId']), raw_json: line.slice(0, 8000) });
    }
    this.deps.store.kvSet(EVENT_LOG_OFFSET_KEY, String(offset + end + 1));
  }
  private upsertEvent(job: string, f: Partial<Record<'event' | 'service_id' | 'service_params' | 'client_agent_id' | 'description' | 'raw_json', string | null>>): void {
    this.db.prepare(`INSERT INTO okx_market_provider_event(job_id,event,service_id,service_params,client_agent_id,description,raw_json,updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET event=COALESCE(excluded.event,event),service_id=COALESCE(excluded.service_id,service_id),service_params=COALESCE(excluded.service_params,service_params),
      client_agent_id=COALESCE(excluded.client_agent_id,client_agent_id),description=COALESCE(excluded.description,description),raw_json=COALESCE(excluded.raw_json,raw_json),updated_at=excluded.updated_at`)
      .run(job, f.event ?? null, f.service_id ?? null, f.service_params ?? null, f.client_agent_id ?? null, f.description ?? null, f.raw_json ?? null, this.now());
  }
  event(job: string): ProviderEventRow | null {
    const r = this.db.prepare('SELECT job_id,event,service_id,service_params,client_agent_id,description FROM okx_market_provider_event WHERE job_id=?').get(job);
    return r ? { job_id: String(r['job_id']), event: str(r['event']), service_id: str(r['service_id']), service_params: str(r['service_params']), client_agent_id: str(r['client_agent_id']), description: str(r['description']) } : null;
  }
  /** 处理器读 task.detail.description / serviceParams:把事件缓存并进 detail */
  private withEvent(task: ProviderTask): void {
    const ev = this.event(task.job_id); if (!ev) return;
    task.detail = { ...(task.detail ?? {}), ...(ev.description ? { description: ev.description } : {}), ...(ev.service_params ? { serviceParams: ev.service_params } : {}) };
    task.buyer_agent_id ??= ev.client_agent_id;
  }
  private async detail(job: string, asp: string): Promise<Record<string, unknown> | null> {
    const r = object(object((await this.deps.cli.call('asp', ['status', job, '--agent-id', asp]))['data']));
    const p = object(r['payload'] ?? r);
    const t = object(p['task'] ?? p);
    return Object.keys(t).length ? t : null;
  }
  row(job: string): ProviderTaskRow | null {
    const r = this.db.prepare('SELECT * FROM okx_market_provider_task WHERE job_id=?').get(job);
    return r ? providerTaskRow(r) : null;
  }
  rows(limit = 200): ProviderTaskRow[] { return this.db.prepare('SELECT * FROM okx_market_provider_task ORDER BY created_at DESC LIMIT ?').all(limit).map(providerTaskRow); }

  private patch(job: string, fields: Record<string, unknown>): void {
    const keys = Object.keys(fields); if (!keys.length) return;
    this.db.prepare(`UPDATE okx_market_provider_task SET ${keys.map((k) => `${k}=?`).join(',')},updated_at=? WHERE job_id=?`).run(...keys.map((k) => fields[k] as never), this.now(), job);
  }
  /** 条件迁移:只有当前状态在 from 里才改,返回是否抢到。 */
  private transition(job: string, from: State[], to: State, extra: Record<string, unknown> = {}): boolean {
    const keys = Object.keys(extra);
    const r = this.db.prepare(`UPDATE okx_market_provider_task SET state=?,${keys.map((k) => `${k}=?,`).join('')}updated_at=? WHERE job_id=? AND state IN (${from.map(() => '?').join(',')})`)
      .run(to, ...keys.map((k) => extra[k] as never), this.now(), job, ...from);
    return r.changes > 0;
  }
  private ctx(asp: string): ProviderContext { return { asp_id: asp, cli: this.deps.cli, store: this.deps.store, log: this.deps.log, now: () => this.now() }; }

  private async process(task: ProviderTask, asp: string): Promise<void> {
    this.db.prepare(`INSERT INTO okx_market_provider_task(job_id,kind,service_id,buyer_agent_id,state,remote_status,raw_json,test_flag,created_at,updated_at)
      VALUES (?,?,?,?,'seen',?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET remote_status=excluded.remote_status,raw_json=excluded.raw_json,service_id=COALESCE(excluded.service_id,service_id),buyer_agent_id=COALESCE(excluded.buyer_agent_id,buyer_agent_id)`)
      .run(task.job_id, task.kind, task.service_id, task.buyer_agent_id, task.status, JSON.stringify(task.raw), task.test_flag ? 1 : 0, this.now(), this.now());
    let row = this.row(task.job_id)!;
    // 按次单投递结果未知:等 2 分钟让链上状态落定,远端仍是「已接单未提交」(1)就回到 deliver_failed 自动重发(上限 MAX_DELIVER_ATTEMPTS);
    // 已提交(2)记 delivered;订阅单远端一直是 ACTIVE,判断不了有没有送到,仍走人工 retry。
    if (row.state === 'deliver_unknown' && row.kind === 'one_time' && row.deliver_attempts < MAX_DELIVER_ATTEMPTS && this.now() - row.updated_at >= UNKNOWN_RECHECK_MS) {
      const remote = taskStatus(await this.detail(task.job_id, asp).catch(() => null));
      if (remote === 1) { this.transition(task.job_id, ['deliver_unknown'], 'deliver_failed', { error: `投递结果未知,远端确认仍未提交,自动重发:${row.error ?? ''}`.slice(0, 1000) }); row = this.row(task.job_id)!; }
      else if (remote === 2) { this.transition(task.job_id, ['deliver_unknown'], 'delivered', { error: null, remote_status: 2 }); return; }
      else if (remote !== null && TERMINAL_STATUSES.has(remote)) { this.transition(task.job_id, ['deliver_unknown'], 'closed', { remote_status: remote }); return; }
    }
    // 接单结果未知(多半是 CLI 超时):同样等 2 分钟回查。远端已接(1)就补交付;还是 CREATED(0)说明上次没生效,
    // 次数没用完就回到 seen 再接一次。以前这里直接停手,真实买家的订阅因此在「等 ASP 接单」里挂了十几个小时。
    if (row.state === 'accept_unknown' && this.now() - row.updated_at >= UNKNOWN_RECHECK_MS) {
      if (ACCEPT_WINDOW_EXPIRED.test(row.error ?? '')) { this.transition(task.job_id, ['accept_unknown'], 'closed'); return; }
      const remote = taskStatus(await this.detail(task.job_id, asp).catch(() => null));
      if (remote === 1) { this.transition(task.job_id, ['accept_unknown'], 'accepted', { error: null, remote_status: 1 }); row = this.row(task.job_id)!; }
      else if (remote === 0 && row.accept_attempts < MAX_ACCEPT_ATTEMPTS) { this.transition(task.job_id, ['accept_unknown'], 'seen', { error: `接单结果未知,远端确认仍未接,重试:${row.error ?? ''}`.slice(0, 1000) }); row = this.row(task.job_id)!; }
      else if (remote !== null && TERMINAL_STATUSES.has(remote)) { this.transition(task.job_id, ['accept_unknown'], 'closed', { remote_status: remote }); return; }
    }
    if (['declined', 'decline_unknown', 'accept_unknown', 'delivered', 'deliver_unknown', 'skipped', 'closed', 'declining', 'delivering'].includes(row.state)) return;
    if (task.status !== null && TERMINAL_STATUSES.has(task.status)) { this.transition(task.job_id, [row.state], 'closed'); return; }
    const found = resolveProviderHandler(task, this.registry);
    if (!found) { if (row.state !== 'no_handler') { this.transition(task.job_id, ['seen'], 'no_handler', { error: `没有注册 ${task.kind}/${task.service_id ?? '-'} 的处理器,不接单` }); this.deps.log('warn', `provider task ${task.job_id} 无处理器,未接单`); } return; }
    if (row.state === 'no_handler') { this.transition(task.job_id, ['no_handler'], 'seen', { error: null }); row = this.row(task.job_id)!; }
    this.patch(task.job_id, { handler_key: found.key });

    if (row.state === 'seen' || row.state === 'accepting') {
      task.detail = await this.detail(task.job_id, asp);
      const status = taskStatus(task.detail) ?? task.status;
      this.withEvent(task);
      if (status === 0) {
        if (row.state === 'accepting' && row.accept_attempts >= MAX_ACCEPT_ATTEMPTS) { this.transition(task.job_id, ['accepting'], 'accept_unknown', { error: '接单多次未生效,人工核实' }); return; }
        if (row.state === 'accepting') this.transition(task.job_id, ['accepting'], 'seen');
        await this.decideAndAccept(task, asp, found.handler);
        // accept 上链有延迟:远端还是 CREATED(0)时交付会被拒(「must be accepted (1) before delivery」),留到下一轮
        if (this.row(task.job_id)?.state === 'accepted' && taskStatus(await this.detail(task.job_id, asp).catch(() => null)) === 0) return;
      } else if (status === 1) this.transition(task.job_id, ['seen', 'accepting'], 'accepted', { remote_status: 1 });
      else if (status !== null && TERMINAL_STATUSES.has(status)) { this.transition(task.job_id, ['seen', 'accepting'], 'closed', { remote_status: status }); return; }
      row = this.row(task.job_id)!;
    }
    if (row.state === 'accepted' || row.state === 'deliver_failed') { this.withEvent(task); await this.produceAndDeliver(task, asp, found.handler, row); }
  }

  private async decideAndAccept(task: ProviderTask, asp: string, handler: ProviderHandler): Promise<void> {
    const decision = handler.decide ? await handler.decide(task, this.ctx(asp)) : { accept: true as const };
    const sub = task.kind === 'subscription';
    const run = startAspRun(this.deps.store, 'asp_accept', { job_id: task.job_id, kind: task.kind, decision });
    if (!decision.accept) {
      const reason = [...decision.reason].slice(0, 512).join('') || '服务能力不匹配';
      if (!this.transition(task.job_id, ['seen'], 'declining')) return;
      try {
        const r = await this.deps.cli.call(sub ? 'decline-subscription' : 'decline-job-by-provider', [task.job_id, '--agent-id', asp, '--reason', reason]);
        this.transition(task.job_id, ['declining'], 'declined', { result_json: JSON.stringify(object(r['data'] ?? r)), error: null });
        this.deps.store.bots.finishRun(run, { status: 'done', result: { declined: true, reason } });
      } catch (e) {
        this.transition(task.job_id, ['declining'], connectFailure(e) ? 'seen' : 'decline_unknown', { error: (e as Error).message });
        this.deps.store.bots.finishRun(run, { status: 'failed', error: (e as Error).message });
      }
      this.deps.emit('market_provider_task', this.row(task.job_id)); return;
    }
    const before = this.row(task.job_id)!;
    if (!this.transition(task.job_id, ['seen'], 'accepting', { accept_attempts: before.accept_attempts + 1 })) return;
    try {
      const r = await this.deps.cli.call(sub ? 'accept-subscription' : 'accept-job-by-provider', [task.job_id, '--agent-id', asp]);
      this.transition(task.job_id, ['accepting'], 'accepted', { result_json: JSON.stringify(object(r['data'] ?? r)), error: null, remote_status: 1 });
      this.deps.log('info', `已接单 ${task.kind} ${task.job_id}${task.test_flag ? '(平台审核单)' : ''}`);
      this.deps.store.bots.finishRun(run, { status: 'done', result: { accepted: true } });
    } catch (e) {
      const message = (e as Error).message;
      // 回查远端:已接 = 成功;仍是 CREATED 且连接没建立 = 请求没发出,下一轮可再试;其余 = 结果未知,停手等人工。
      const latest = await this.detail(task.job_id, asp).catch(() => null);
      const status = taskStatus(latest);
      if (status === 1) this.transition(task.job_id, ['accepting'], 'accepted', { error: null, remote_status: 1 });
      // 平台说接单窗口已过:这单再也接不了,记关闭,不留成「结果未知」挂在监视页上
      else if (ACCEPT_WINDOW_EXPIRED.test(message)) this.transition(task.job_id, ['accepting'], 'closed', { error: message.slice(0, 1000) });
      else if (status === 0 && connectFailure(e) && before.accept_attempts + 1 < MAX_ACCEPT_ATTEMPTS) this.transition(task.job_id, ['accepting'], 'seen', { error: message });
      else {
        this.transition(task.job_id, ['accepting'], 'accept_unknown', { error: message, remote_status: status });
        captainHandoff(this.deps.store, `provider-accept:${task.job_id}`, '接单失败或结果未知,需人工核实', { job_id: task.job_id, error: message, remote_status: status });
      }
      this.deps.store.bots.finishRun(run, { status: 'failed', error: message });
    }
    this.deps.emit('market_provider_task', this.row(task.job_id));
  }

  private async produceAndDeliver(task: ProviderTask, asp: string, handler: ProviderHandler, row: ProviderTaskRow): Promise<void> {
    if (row.deliver_attempts >= MAX_DELIVER_ATTEMPTS) return;
    if (!await this.deps.ensureSession(task.job_id, asp, task.buyer_agent_id)) { this.patch(task.job_id, { error: 'okx-a2a session create 失败,下一轮重试' }); return; }
    let text = row.deliverable_text;
    let follow: string[] = [];
    if (!text) {
      const out = await handler.produce(task, this.ctx(asp));
      if ('skip' in out) { this.transition(task.job_id, ['accepted', 'deliver_failed'], 'skipped', { error: out.skip }); return; }
      text = out.text; follow = out.follow_up ?? [];
      if (task.kind === 'subscription' && (!this.deps.strictSignalService || task.service_id === this.deps.strictSignalService())) {
        const check = validateSignalText(text);
        if (!check.ok) { this.transition(task.job_id, ['accepted', 'deliver_failed'], 'skipped', { error: `交付文本不合规:${check.errors.join(';')}`, deliverable_text: text }); return; }
      }
    }
    if (!this.transition(task.job_id, ['accepted', 'deliver_failed'], 'delivering', { deliver_attempts: row.deliver_attempts + 1, deliverable_text: text })) return;
    const run = startAspRun(this.deps.store, 'asp_deliver', { job_id: task.job_id, kind: task.kind, text });
    try {
      const r = object(await this.deps.cli.call('deliver', [task.job_id, '--deliverable-text', text, '--agent-id', asp]));
      const d = object(r['data'] ?? r);
      this.transition(task.job_id, ['delivering'], 'delivered', { result_json: JSON.stringify(d), error: null });
      this.deps.log('info', `已交付 ${task.kind} ${task.job_id}`);
      this.deps.store.bots.finishRun(run, { status: 'done', result: d });
      await this.followUps(task.job_id, asp, follow);
    } catch (e) {
      const message = (e as Error).message;
      // 4.6.2 的 deliver 成功时可能什么都不打(exit 0 + 空 stdout,MarketCli 报 cli_invalid_json);exit 0 即 CLI 认定成功。
      if (/alreadyDelivered/i.test(message) || (e instanceof CliError && e.code === 'cli_invalid_json')) { this.transition(task.job_id, ['delivering'], 'delivered', { error: null, result_json: JSON.stringify({ exit: 0, stdout: e instanceof CliError ? e.raw_message.slice(0, 500) : '' }) }); await this.followUps(task.job_id, asp, follow); }
      // 平台明确以「尚未接单」拒绝 = 这次什么都没送出,可以放心重发
      else this.transition(task.job_id, ['delivering'], connectFailure(e) || NOT_ACCEPTED_YET.test(message) ? 'deliver_failed' : 'deliver_unknown', { error: message });
      this.deps.store.bots.finishRun(run, { status: 'failed', error: message });
    }
    this.deps.emit('market_provider_task', this.row(task.job_id));
  }

  /** 主交付成功后的详情补发:只对刚生成的交付有效(重试路径不重发),失败只记日志,不改任务状态 */
  private async followUps(job: string, asp: string, texts: string[]): Promise<void> {
    for (const t of texts) {
      try { await this.deps.cli.call('deliver', [job, '--deliverable-text', t, '--agent-id', asp]); }
      catch (e) { if (!(e instanceof CliError && e.code === 'cli_invalid_json')) this.deps.log('warn', `详情补发失败 ${job}:${(e as Error).message.slice(0, 200)}`); }
    }
  }

  /**
   * 已接单、从未投递、交付被本地校验跳过(skipped)的任务:重置为 accepted,清掉旧交付文本,下一轮重跑 produce。
   * 只对 remote_status=1(接单已确认)且 deliver_attempts=0 的单开放。
   */
  async reproduce(job: string): Promise<ProviderTaskRow | null> {
    const row = this.row(job);
    if (!row || row.state !== 'skipped' || row.remote_status !== 1 || row.deliver_attempts !== 0) throw Object.assign(new Error('只有已接单确认、从未投递、被跳过的任务可以重跑交付'), { status: 409 });
    if (!this.transition(job, ['skipped'], 'accepted', { deliverable_text: null, error: null })) throw Object.assign(new Error('状态已变化,请刷新'), { status: 409 });
    await this.tick(); return this.row(job);
  }
  /** 人工核实后重发一次未知/失败的交付。 */
  async retryDeliver(job: string, opts: { fresh?: boolean } = {}): Promise<ProviderTaskRow | null> {
    const row = this.row(job); if (!row || !['deliver_unknown', 'deliver_failed'].includes(row.state)) throw Object.assign(new Error('只有交付失败/未知的任务可以重发'), { status: 409 });
    // fresh:远端确认仍是已接单未提交(statusCode=1)才允许丢掉旧交付文本、按当前代码重新生成
    if (opts.fresh) {
      const asp = await this.deps.aspId(); if (!asp) throw Object.assign(new Error('没有 ASP 身份'), { status: 409 });
      const status = taskStatus(await this.detail(job, asp));
      if (status !== 1) throw Object.assign(new Error(`远端状态 ${status ?? '未知'} 不是「已接单未提交」,不能重新生成`), { status: 409 });
    }
    this.db.prepare(`UPDATE okx_market_provider_task SET state='deliver_failed',deliver_attempts=0,${opts.fresh ? 'deliverable_text=NULL,' : ''}updated_at=? WHERE job_id=?`).run(this.now(), job);
    await this.tick(); return this.row(job);
  }
}

export function providerTaskRow(r: Record<string, unknown>): ProviderTaskRow {
    return { job_id: String(r['job_id']), kind: r['kind'] as ProviderTaskKind, service_id: str(r['service_id']), buyer_agent_id: str(r['buyer_agent_id']), handler_key: str(r['handler_key']), state: r['state'] as State, remote_status: num(r['remote_status']), accept_attempts: Number(r['accept_attempts']), deliver_attempts: Number(r['deliver_attempts']), error: str(r['error']), deliverable_text: str(r['deliverable_text']), result: r['result_json'] ? JSON.parse(String(r['result_json'])) : null, test_flag: !!r['test_flag'], created_at: Number(r['created_at']), updated_at: Number(r['updated_at']) };
}

/** 独立读入口:open 在 SQL 限量之前过滤,未知结果仍属待处理。 */
export function providerTaskRows(db: DatabaseSync, opts: { limit?: number; status?: 'open' | 'all' } = {}): ProviderTaskRow[] {
  return db.prepare(`SELECT * FROM okx_market_provider_task ${opts.status === 'open' ? "WHERE state NOT IN ('delivered','declined','closed')" : ''} ORDER BY updated_at DESC,job_id LIMIT ?`).all(opts.limit ?? 200).map(providerTaskRow);
}
