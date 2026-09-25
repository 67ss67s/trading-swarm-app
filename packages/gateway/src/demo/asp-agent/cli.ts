/** All Signal Market CLI processes inherit the environment, including proxy configuration. */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
export type CliBinary = 'onchainos' | 'okx-a2a';
export type CliRunner = (bin: CliBinary, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
export const CLI_TIMEOUT_MS = 20_000;
export function cliBinary(bin: CliBinary): string {
  const local = join(homedir(), '.local', 'bin', bin);
  return existsSync(local) ? local : bin;
}
export const spawnCli: CliRunner = (bin, args, timeoutMs = CLI_TIMEOUT_MS) => new Promise((resolve) => {
  execFile(cliBinary(bin), args, { env: process.env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : err.killed ? 124 : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr || err?.message || '') });
  });
});
export class CliError extends Error {
  constructor(readonly code: string, readonly raw_message: string, readonly output: Record<string, unknown> = {}, readonly status = 502, readonly hint = '平台调用失败，请查看原始错误。') { super(`${hint}\n${raw_message}`); }
}
/** stdout may contain progress/upgrade text around a pretty-printed JSON envelope. */
export function parseCliOutput(stdout: string): Record<string, unknown> {
  const text = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const values: Record<string, unknown>[] = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    let depth = 0; let quoted = false; let escaped = false;
    for (let end = start; end < text.length; end++) {
      const c = text[end];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
      if (c === '"') quoted = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        if (--depth !== 0) continue;
        try { const value: unknown = JSON.parse(text.slice(start, end + 1)); values.push(Array.isArray(value) ? { data: value } : object(value)); start = end; } catch {}
        break;
      }
    }
  }
  const envelopes = values.filter((v) => 'ok' in v || 'success' in v || 'code' in v);
  if (envelopes.length !== 1 && values.length !== 1) throw new Error('CLI 未返回唯一结果信封');
  return envelopes[0] ?? values[0] ?? (() => { throw new Error('CLI stdout is not JSON'); })();
}
const runnerQueues = new WeakMap<CliRunner, Promise<unknown>>();
export function cliFailure(raw: string, output: Record<string, unknown> = {}, timeout = false): CliError {
  if (timeout) return new CliError('cli_timeout', raw, output, 504, 'CLI 超时，操作结果尚未确认；请先刷新订阅列表，勿重复提交。');
  if (/update required/i.test(raw) || String(output['code'] ?? object(output['error'])['code']) === '1001') return new CliError('cli_update_required', raw, output, 503, 'OnchainOS CLI 需要升级。');
  if (/provider not online/i.test(raw)) return new CliError('provider_offline', raw, output, 409, '服务方暂时离线，请待其上线后再订阅。');
  if (/network unavailable|error sending request|tls handshake|\(connect\)|connection (?:refused|reset)|timed out connecting/i.test(raw)) return new CliError('network_unavailable', raw, output, 503, '连不上 OKX(网络/代理抖动),请稍后重试。');
  if (/session expired|login again|agenticId is required/i.test(raw)) return new CliError('cli_login_required', raw, output, 409, 'CLI 登录或买方身份不可用，请检查钱包登录状态。');
  return new CliError('cli_failed', raw, output);
}
export function object(v: unknown): Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; }
export function payload(v: unknown): unknown { const o = object(v); return o['data'] ?? v; }
export function data(v: unknown): Record<string, unknown> { const o = object(v); return o['data'] !== undefined ? object(o['data']) : o; }
export function list(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.map(object);
  if (Array.isArray(object(v)['data'])) return (object(v)['data'] as unknown[]).map(object);
  const o = data(v);
  const xs = o['list'] ?? o['subscriptions'] ?? o['agents'] ?? o['services'] ?? o['items'] ?? o['devices'];
  return Array.isArray(xs) ? xs.map(object) : [];
}
const WRITE_COMMANDS = new Set(['create-subscribe', 'subscribe-cancel', 'subscribe-reject', 'start-autorenew', 'refund-execute', 'refund-prepare', 'create', 'activate', 'deactivate', 'update', 'upload', 'deliver', 'claim', 'subscription-execution-config-set', 'device-set']);
const CONNECT_PHASE = /tls handshake|\(connect\)|connection refused|timed out connecting|dns/i;
export const NETWORK_ATTEMPTS = 3;
export let NETWORK_BACKOFF_MS = 1500;
/** 测试用:把网络重试退避设为 0 */
export function setNetworkBackoffForTest(ms: number): void { NETWORK_BACKOFF_MS = ms; }
export class MarketCli {
  constructor(readonly runner: CliRunner = spawnCli) {}
  async call(command: string, args: string[] = []): Promise<Record<string, unknown>> {
    // 本机经 Clash 出网,TLS 握手常被掐断:读操作失败就重试;写操作只在「连接没建立」时重试
    // (请求没到 OKX,重发不会重复写),发出后才断的交给调用方的「失败后回查状态」处理。
    const write = WRITE_COMMANDS.has(command);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.json(['agent', command, ...args]);
      } catch (e) {
        const retryable = e instanceof CliError && e.code === 'network_unavailable' && (!write || CONNECT_PHASE.test(e.raw_message));
        if (!retryable || attempt >= NETWORK_ATTEMPTS) throw e;
        await new Promise((r) => setTimeout(r, NETWORK_BACKOFF_MS * attempt));
      }
    }
  }
  async json(args: string[]): Promise<Record<string, unknown>> {
    // Serialize child processes sharing one CLI wallet session; a failed call never poisons the queue.
    const timeout = ['create-subscribe', 'subscribe-cancel', 'start-autorenew', 'refund-execute'].includes(args[1] ?? '') ? 120_000 : args[1] === 'my-subscriptions' ? 45_000 : CLI_TIMEOUT_MS;
    const pending = (runnerQueues.get(this.runner) ?? Promise.resolve()).then(() => this.runner('onchainos', args, timeout));
    runnerQueues.set(this.runner, pending.catch(() => undefined));
    const r = await pending;
    let out: Record<string, unknown>;
    try { out = parseCliOutput(r.stdout); } catch {
      const raw = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n') || 'CLI stdout is not JSON';
      if (r.code !== 0 || /update required/i.test(raw)) throw cliFailure(raw, {}, r.code === 124);
      // 部分写命令(如 subscribe-cancel)成功时只打人话:「✓ Subscription cancel in progress (transaction broadcast)」。
      // 退出码 0 + ✓ 开头 = 成功已提交(链上确认中),不能当格式错误报给用户(这正是「取消老报错」的来源)。
      const ok = r.stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (/^✓/.test(ok)) return { ok: true, data: { text: ok, pending: /in progress|broadcast/i.test(ok), tx: ok.match(/0x[0-9a-f]{16,}/i)?.[0] ?? null } };
      throw new CliError('cli_invalid_json', raw, {}, 502, 'CLI 返回格式无法确认，请刷新订阅列表核实结果，勿重复提交。');
    }
    if (r.code !== 0 || out['ok'] === false || out['success'] === false || (out['code'] !== undefined && !['0', '200'].includes(String(out['code'])))) {
      const detail = String((typeof out['error'] === 'string' ? out['error'] : object(out['error'])['message']) ?? out['message'] ?? (r.stderr || r.stdout || 'CLI failed'));
      const message = r.stderr.trim() && !detail.includes(r.stderr.trim()) ? `${detail}\n${r.stderr.trim()}` : detail;
      throw cliFailure(message, out, r.code === 124);
    }
    return out;
  }
}
export interface WatchHandle { stop(): void | Promise<void>; }
export type WatchRunner = (line: (text: string) => void, ended: (error: string | null) => void) => WatchHandle;
/** Experimental streaming transport; the persistent process intentionally has no 20s lifetime limit. */
export const spawnWatch: WatchRunner = (line, ended) => {
  const child = spawn(cliBinary('okx-a2a'), ['user', 'watch', '--json'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const reader = createInterface({ input: child.stdout });
  let error = ''; let stopped = false;
  reader.on('line', line);
  child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-2000); });
  child.once('error', (e) => ended(e.message));
  child.once('close', (code) => { reader.close(); if (!stopped) ended(error || `watch exited (${code})`); });
  return { stop() {
    stopped = true; reader.close();
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000); timer.unref();
      child.once('close', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
    });
  } };
};
