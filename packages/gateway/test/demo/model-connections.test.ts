// §9.52 模型连接与角色底层:存储 / 密钥文件 / 绑定校验 / 角色执行语义 / Decisions 闸门。
// 全部零网络:HTTP 用注入的 fetchFn,CLI 探测与测试用注入函数。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { stubBrain, type Brain } from '../../src/demo/brain.js';
import { blockedIpReason, httpBrain, redactKeyText } from '../../src/demo/brain-http.js';
import { JevDecisionClient, memorySpendLedger } from '../../src/demo/decisions.js';
import { KeyVault, maskKey, ModelRouter, parseEnvKey, type ModelsView } from '../../src/demo/model-connections.js';
import { applyWorkflowPatch, DEFAULT_WORKFLOW } from '../../src/demo/workflow.js';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdefc6a5e9';
const dirs: string[] = [];
const states: StateDb[] = [];
afterEach(() => {
  for (const s of states.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'tg-models-'));
  dirs.push(d);
  return d;
};

type FetchCall = { url: string; body: Record<string, unknown>; headers: Record<string, string>; redirect: RequestRedirect | undefined };
function fakeFetch(handler: (call: FetchCall) => { status: number; body: unknown; headers?: Record<string, string> }): { fn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}, headers: (init?.headers ?? {}) as Record<string, string>, redirect: init?.redirect };
    calls.push(call);
    const r = handler(call);
    return new Response(r.body === null ? null : typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status, headers: r.headers ?? {} });
  }) as typeof fetch;
  return { fn, calls };
}

const chatOk = { status: 200, body: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 40, completion_tokens: 1, cost: 0.000015 } } };

function makeRouter(opts: { fetchFn?: typeof fetch; secretsDir?: string | null; importEnvPath?: string | null; brains?: { main?: Brain; cheap?: Brain }; lookupFn?: (host: string) => Promise<string[]> } = {}) {
  const state = openStateDb(':memory:');
  states.push(state);
  const views: ModelsView[] = [];
  const logs: string[] = [];
  const main = opts.brains?.main ?? { ...stubBrain(), name: 'pi:zai/glm-5.3' };
  const cheap = opts.brains?.cheap ?? { ...stubBrain(), name: 'pi:zai/glm-5-turbo' };
  const router = new ModelRouter({
    db: state.db,
    secretsDir: opts.secretsDir ?? null,
    importEnvPath: opts.importEnvPath ?? null,
    mainBrain: () => main,
    cheapBrain: () => cheap,
    cliBrain: (tool, model) => ({ ...stubBrain(), name: `${tool}:${model ?? 'default'}` }),
    cliCommands: () => null,
    decisionCapUsd: () => 2,
    ledger: memorySpendLedger(),
    emit: (v) => views.push(v),
    log: (_l, m) => logs.push(m),
    detectCli: (tool) => tool === 'claude',
    cliModels: () => ['sonnet', 'opus'],
    testCli: async (tool, model) => ({ ok: true, kind: tool, model, name: `${tool}:${model ?? 'default'}`, latency_ms: 5, text: 'ok', error: null }),
    // 缺省 DNS 桩:测试里绝不查真实 DNS;没登记的域名当解析失败。
    lookupFn: opts.lookupFn ?? (async (host) => { throw new Error(`no fake dns for ${host}`); }),
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
  });
  return { router, views, logs, state };
}

describe('helpers', () => {
  it('maskKey keeps 6+6 and parseEnvKey tolerates export/quotes', () => {
    expect(maskKey(KEY)).toBe('sk-or-…c6a5e9');
    expect(parseEnvKey(`# c\nexport OPENROUTER_API_KEY="${KEY}"\n`)).toBe(KEY);
    expect(parseEnvKey('OTHER=1')).toBeNull();
  });

  it('KeyVault writes secrets/model-keys.json with 700 dir / 600 file', () => {
    const dir = path.join(tmp(), 'secrets');
    const v = new KeyVault(dir);
    v.set('mc_a', KEY);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(v.file!).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(v.file!, 'utf8'))).toEqual({ mc_a: KEY });
    expect(new KeyVault(dir).get('mc_a')).toBe(KEY);
    v.delete('mc_a');
    expect(new KeyVault(dir).get('mc_a')).toBeNull();
  });

  it('workflow.decision_daily_usd_cap defaults to 2 and rejects out-of-range', () => {
    expect(DEFAULT_WORKFLOW.decision_daily_usd_cap).toBe(2);
    expect(applyWorkflowPatch(DEFAULT_WORKFLOW, { decision_daily_usd_cap: 0.5 }).next.decision_daily_usd_cap).toBe(0.5);
    expect(applyWorkflowPatch(DEFAULT_WORKFLOW, { decision_daily_usd_cap: -1 }).errors.length).toBe(1);
    expect(applyWorkflowPatch(DEFAULT_WORKFLOW, { decision_daily_usd_cap: 'x' }).errors.length).toBe(1);
  });
});

describe('ModelRouter', () => {
  it('view: 7 bindings, fallbacks per role, decision unset, cli detection', () => {
    const { router } = makeRouter();
    const v = router.view();
    expect(v.bindings.map((b) => b.role)).toEqual(['chat', 'judge', 'research', 'filter', 'reviewer', 'utility', 'decision']);
    expect(v.effective.chat).toEqual({ source: 'fallback_main', name: 'pi:zai/glm-5.3' });
    expect(v.effective.research.source).toBe('fallback_main');
    expect(v.effective.filter).toEqual({ source: 'fallback_cheap', name: 'pi:zai/glm-5-turbo' });
    expect(v.effective.decision).toEqual({ source: 'unset', name: '' });
    expect(v.cli_detected.find((c) => c.tool === 'claude')?.ok).toBe(true);
    expect(v.cli_detected.find((c) => c.tool === 'codex')?.ok).toBe(false);
    expect(router.decisionClient()).toBeNull();
  });

  it('create validates kind / key / base_url / cli and never returns the key', async () => {
    const { router, views } = makeRouter();
    await expect(router.createConnection({ kind: 'nope' })).rejects.toThrow(/kind/);
    await expect(router.createConnection({ kind: 'openrouter' })).rejects.toThrow(/api_key/);
    await expect(router.createConnection({ kind: 'openai_compatible' })).rejects.toThrow(/base_url/);
    await expect(router.createConnection({ kind: 'cli' })).rejects.toThrow(/cli/);
    const c = await router.createConnection({ kind: 'openrouter', api_key: KEY });
    expect(c).toMatchObject({ kind: 'openrouter', label: 'OpenRouter', key_masked: 'sk-or-…c6a5e9', status: 'untested' });
    expect(c.id).toMatch(/^mc_/);
    const local = await router.createConnection({ kind: 'openai_compatible', base_url: 'http://127.0.0.1:11434/v1/' });
    expect(local.base_url).toBe('http://127.0.0.1:11434/v1');
    const cli = await router.createConnection({ kind: 'cli', cli: 'claude' });
    expect(cli).toMatchObject({ label: 'Claude Code CLI', key_masked: null, models_hint: ['sonnet', 'opus'] });
    expect(JSON.stringify(router.view())).not.toContain(KEY);
    expect(JSON.stringify(views)).not.toContain(KEY);
  });

  it('bindings: decision only on openrouter (default Jev); decision-only models refused for LLM roles; API needs model', async () => {
    const { router } = makeRouter();
    const or = await router.createConnection({ kind: 'openrouter', api_key: KEY });
    const ds = await router.createConnection({ kind: 'deepseek', api_key: 'sk-deepseek-0123456789abcdef' });
    const cli = await router.createConnection({ kind: 'cli', cli: 'codex' });
    expect(() => router.setBinding('decision', { connection_id: ds.id })).toThrow(expect.objectContaining({ code: 'decision_requires_openrouter' }));
    expect(router.setBinding('decision', { connection_id: or.id, model: null }).bindings.find((b) => b.role === 'decision')?.model).toBe('~typesafe/jev-latest');
    expect(() => router.setBinding('chat', { connection_id: or.id, model: '~typesafe/jev-latest' })).toThrow(expect.objectContaining({ code: 'decision_only_model' }));
    expect(() => router.setBinding('judge', { connection_id: or.id, model: 'typesafe/jev-1.13' })).toThrow(expect.objectContaining({ code: 'decision_only_model' }));
    expect(() => router.setBinding('chat', { connection_id: ds.id })).toThrow(expect.objectContaining({ code: 'model_required' }));
    expect(() => router.setBinding('nope', { connection_id: ds.id })).toThrow(expect.objectContaining({ code: 'not_found' }));
    const v = router.setBinding('reviewer', { connection_id: cli.id, model: null });
    expect(v.effective.reviewer).toEqual({ source: 'binding', name: 'codex:default' });
    expect(v.effective.decision).toEqual({ source: 'binding', name: 'openrouter:~typesafe/jev-latest' });
    // 删除被占用的连接 → 409 + 角色清单;解绑后可删
    expect(() => router.deleteConnection(or.id)).toThrow(expect.objectContaining({ status: 409, code: 'connection_in_use', roles: ['decision'] }));
    router.setBinding('decision', { connection_id: null, model: null });
    router.deleteConnection(or.id);
    expect(router.view().connections.map((c) => c.id)).not.toContain(or.id);
  });

  it('bound HTTP role uses the connection, reports cost, and a 401 fails loudly without falling back', async () => {
    let status = 200;
    const f = fakeFetch(() => (status === 200 ? chatOk : { status, body: { error: { message: `bad key ${KEY}` } } }));
    const { router, views, logs } = makeRouter({ fetchFn: f.fn });
    const or = await router.createConnection({ kind: 'openrouter', api_key: KEY });
    router.setBinding('judge', { connection_id: or.id, model: 'deepseek/deepseek-v4.1-flash' });
    const brain = router.brainForRole('judge');
    expect(brain.name).toBe('openrouter:deepseek/deepseek-v4.1-flash');
    const r = await brain.complete('sys', 'user');
    expect(r.text).toBe('ok');
    expect((r as { cost_usd?: number }).cost_usd).toBe(0.000015);
    expect(f.calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(f.calls[0]!.headers['authorization']).toBe(`Bearer ${KEY}`);
    // chat 没绑定:仍回退主脑
    expect(router.brainForRole('chat').name).toBe('pi:zai/glm-5.3');

    status = 401;
    const err = await router.brainForRole('judge').complete('sys', 'user').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^model_connection_failed:judge:401 /);
    expect((err as Error).message).not.toContain(KEY);
    expect(router.view().connections[0]!.status).toBe('error');
    expect(JSON.stringify(views)).not.toContain(KEY);
    expect(logs.join('\n')).not.toContain(KEY);
  });

  it('a binding whose key is missing throws model_connection_failed instead of using the fallback slot', async () => {
    const { router } = makeRouter();
    const or = await router.createConnection({ kind: 'openrouter', api_key: KEY });
    router.setBinding('utility', { connection_id: or.id, model: 'deepseek/deepseek-v4.1-flash' });
    router.vault.delete(or.id); // 模拟密钥文件被删
    await router.updateConnection(or.id, { label: 'OR' }); // 版本号变了 → 重建
    await expect(router.brainForRole('utility').complete('s', 'u')).rejects.toThrow(/^model_connection_failed:utility:/);
  });

  it('test endpoint: LLM ping, decision noul, cli; results persist and are redacted', async () => {
    const f = fakeFetch((c) => {
      if (c.url.endsWith('/alpha/decisions')) return { status: 200, body: { model: 'typesafe/jev-1.13', answers: { ok: { type: 'noul', noul: 0.91 } }, usage: { input_tokens: 30, output_tokens: 0, cost: 0.000002 } } };
      if (c.url.endsWith('/models')) return { status: 200, body: { data: [{ id: 'deepseek/deepseek-v4.1-flash' }, { id: 'openai/gpt-5' }, { id: 'z-ai/glm-5.3' }] } };
      return chatOk;
    });
    const { router } = makeRouter({ fetchFn: f.fn });
    const or = await router.createConnection({ kind: 'openrouter', api_key: KEY });
    const t1 = await router.testConnection(or.id, {});
    expect(t1.ok).toBe(true);
    expect(f.calls[0]!.body['model']).toBe('deepseek/deepseek-v4.1-flash');
    expect(router.store.get(or.id)?.models_hint).toContain('z-ai/glm-5.3');
    expect(router.store.get(or.id)?.models_hint).not.toContain('openai/gpt-5');
    const t2 = await router.testConnection(or.id, { model: '~typesafe/jev-latest' });
    expect(t2).toMatchObject({ ok: true });
    expect(t2.detail).toContain('noul=0.910');
    const decisionCall = f.calls.find((c) => c.url.endsWith('/alpha/decisions'))!;
    expect(decisionCall.url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(Object.keys(decisionCall.body)).toEqual(['model', 'state', 'questions']);
    const cli = await router.createConnection({ kind: 'cli', cli: 'claude' });
    expect((await router.testConnection(cli.id, { model: 'sonnet' })).ok).toBe(true);
    expect(router.store.get(cli.id)?.status).toBe('ok');
  });

  it('testRole: bound role tests its own connection + model, fallback calls the legacy slot, decision unset fails, failures redacted', async () => {
    let mode: 'ok' | 'unauthorized' = 'ok';
    const f = fakeFetch((c) => {
      if (mode === 'unauthorized') return { status: 401, body: { error: { message: `invalid key ${KEY}` } } };
      if (c.url.endsWith('/alpha/decisions')) return { status: 200, body: { model: 'typesafe/jev-1.13', answers: { ok: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 30, output_tokens: 0, cost: 0.000002 } } };
      if (c.url.endsWith('/models')) return { status: 200, body: { data: [] } };
      return chatOk;
    });
    const failing: Brain = { name: 'pi:broken', async complete() { throw new Error('spawn pi ENOENT'); } };
    const { router } = makeRouter({ fetchFn: f.fn, brains: { cheap: failing } });

    // 回退主脑:直接调旧槽位,不产生出站请求
    const chat = await router.testRole('chat');
    expect(chat).toMatchObject({ role: 'chat', source: 'fallback_main', name: 'pi:zai/glm-5.3', ok: true });
    expect(f.calls).toHaveLength(0);
    // 回退副脑起不来:ok=false,带错误原因
    const util = await router.testRole('utility');
    expect(util).toMatchObject({ role: 'utility', source: 'fallback_cheap', ok: false });
    expect(util.detail).toContain('ENOENT');
    // decision 未绑定
    expect(await router.testRole('decision')).toMatchObject({ role: 'decision', source: 'unset', ok: false });

    const or = await router.createConnection({ kind: 'openrouter', api_key: KEY });
    router.setBinding('judge', { connection_id: or.id, model: 'z-ai/glm-5.3' });
    const judge = await router.testRole('judge');
    expect(judge).toMatchObject({ role: 'judge', source: 'binding', name: 'openrouter:z-ai/glm-5.3', ok: true });
    expect(f.calls.find((c) => c.url.endsWith('/chat/completions'))!.body['model']).toBe('z-ai/glm-5.3');
    expect(router.store.get(or.id)?.status).toBe('ok');

    router.setBinding('decision', { connection_id: or.id, model: null });
    const dec = await router.testRole('decision');
    expect(dec).toMatchObject({ role: 'decision', source: 'binding', ok: true });
    expect(dec.detail).toContain('noul=');

    // CLI 绑定走 testCli
    const cli = await router.createConnection({ kind: 'cli', cli: 'codex' });
    router.setBinding('research', { connection_id: cli.id, model: null });
    expect(await router.testRole('research')).toMatchObject({ source: 'binding', name: 'codex:default', ok: true });

    mode = 'unauthorized';
    const bad = await router.testRole('judge');
    expect(bad.ok).toBe(false);
    expect(bad.detail).not.toContain(KEY);
    expect(router.store.get(or.id)?.status).toBe('error');
    await expect(router.testRole('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('imports openrouter.env once and binds decision to Jev', async () => {
    const d = tmp();
    const env = path.join(d, 'openrouter.env');
    writeFileSync(env, `OPENROUTER_API_KEY=${KEY}\n`);
    const secrets = path.join(d, 'secrets');
    const { router, logs } = makeRouter({ importEnvPath: env, secretsDir: secrets });
    const v = router.view();
    expect(v.connections).toHaveLength(1);
    expect(v.connections[0]).toMatchObject({ kind: 'openrouter', label: 'OpenRouter(导入)', key_masked: 'sk-or-…c6a5e9' });
    expect(v.bindings.find((b) => b.role === 'decision')).toMatchObject({ connection_id: v.connections[0]!.id, model: '~typesafe/jev-latest' });
    expect(router.decisionClient()?.name).toBe('openrouter:~typesafe/jev-latest');
    expect(JSON.parse(readFileSync(path.join(secrets, 'model-keys.json'), 'utf8'))[v.connections[0]!.id]).toBe(KEY);
    expect(logs.join('\n')).not.toContain(KEY);
    expect(router.importOpenRouterEnv(env)).toBe(false); // 已有 openrouter 连接,不重复导入
    // §9.53 C:judge 用的钉住连接 —— 别名钉到固定版本、不重试、ref 不随连接改名变化
    const f1 = router.frozenDecision()!;
    expect(f1.profile).toMatchObject({ model: 'typesafe/jev-1.13-20260917', model_revision: 'typesafe/jev-1.13-20260917', retry_policy: 'none', parser_version: 'judge_answers_v1', max_call_usd: '0.00015', routing: 'openrouter' });
    expect(f1.profile.ref).toBe(`decision:${v.connections[0]!.id}:typesafe/jev-1.13-20260917`);
    expect(JSON.stringify(f1.profile)).not.toContain(KEY);
    await router.updateConnection(v.connections[0]!.id, { label: '改个名' });
    expect(router.frozenDecision()!.profile.ref).toBe(f1.profile.ref);
  });
});

describe('httpBrain', () => {
  it('retries 429/5xx at most twice, then gives up', async () => {
    const f = fakeFetch(() => ({ status: 503, body: 'busy' }));
    const b = httpBrain({ kind: 'deepseek', base_url: 'https://api.deepseek.com', api_key: 'sk-deepseek-0123456789abcdef', model: 'deepseek-chat', fetchFn: f.fn, sleep: async () => {} });
    await expect(b.complete('s', 'u')).rejects.toThrow(/^503/);
    expect(f.calls).toHaveLength(3);
  });

  it('anthropic wire format: /v1/messages + x-api-key', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 1 } } }));
    const b = httpBrain({ kind: 'anthropic', base_url: 'https://api.anthropic.com', api_key: 'sk-ant-0123456789abcdefghij', model: 'claude-haiku-4-5', fetchFn: f.fn });
    const r = await b.complete('sys', 'hi');
    expect(r).toMatchObject({ text: 'ok', input_tokens: 10, output_tokens: 1, cost_usd: null });
    expect(f.calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(f.calls[0]!.headers['x-api-key']).toBe('sk-ant-0123456789abcdefghij');
    expect(f.calls[0]!.body['system']).toBe('sys');
  });
});

describe('JevDecisionClient', () => {
  const q = { take: { type: 'noul' as const, instructions: 'enter?', criteria: { true: 'yes', false: 'no' } } };
  const ok = { status: 200, body: { model: 'typesafe/jev-1.13', answers: { take: { type: 'noul', noul: 0.6 } }, usage: { input_tokens: 10, output_tokens: 0, cost: 0.5 } } };

  it('daily spend cap → decision_budget_exhausted', async () => {
    const f = fakeFetch(() => ok);
    const c = new JevDecisionClient({ api_key: KEY, fetchFn: f.fn, dailyCapUsd: () => 1 });
    await c.decide({ state: {}, questions: q });
    await c.decide({ state: {}, questions: q });
    await expect(c.decide({ state: {}, questions: q })).rejects.toThrow(/^decision_budget_exhausted/);
    expect(f.calls).toHaveLength(2);
  });

  it('backs off on 429 and caps concurrency', async () => {
    let n = 0;
    const f = fakeFetch(() => (++n === 1 ? { status: 429, body: 'slow down', headers: { 'retry-after': '0' } } : ok));
    const c = new JevDecisionClient({ api_key: KEY, fetchFn: f.fn, sleep: async () => {} });
    const r = await c.decide({ state: { a: 1 }, questions: q });
    expect(r.answers['take']).toEqual({ type: 'noul', noul: 0.6 });
    expect(r.usage).toEqual({ input_tokens: 10, cost_usd: 0.5 });
    expect(f.calls).toHaveLength(2);

    let active = 0;
    let peak = 0;
    const slow = (async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((res) => setTimeout(res, 5));
      active--;
      return new Response(JSON.stringify(ok.body), { status: 200 });
    }) as typeof fetch;
    const c2 = new JevDecisionClient({ api_key: KEY, fetchFn: slow, concurrency: 2, dailyCapUsd: () => 1000 });
    await Promise.all(Array.from({ length: 6 }, () => c2.decide({ state: {}, questions: q })));
    expect(peak).toBe(2);
  });

  it('401 surfaces as auth error without leaking the key', async () => {
    const f = fakeFetch(() => ({ status: 401, body: { error: { message: `No auth credentials found for ${KEY}` } } }));
    const c = new JevDecisionClient({ api_key: KEY, fetchFn: f.fn });
    const e = await c.decide({ state: {}, questions: q }).catch((x: Error) => x);
    expect((e as { code?: string }).code).toBe('auth');
    expect((e as Error).message).not.toContain(KEY);
  });
});

// ---------------------------------------------------------------- cheap-review High-3 / Low-14:SSRF 与 key 卫生
describe('base_url SSRF guard & key hygiene', () => {
  const PUBLIC = '93.184.216.34';
  const dns = (table: Record<string, string[]>) => async (host: string): Promise<string[]> => {
    const r = table[host];
    if (!r) throw new Error(`ENOTFOUND ${host}`);
    return r;
  };
  const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => (await p.then(() => null, (e: { code?: string }) => e))?.code;

  it('built-in providers cannot set / PATCH base_url (400) and legacy stored overrides are ignored with a warn', async () => {
    const f = fakeFetch(() => chatOk);
    const { router, logs, views, state } = makeRouter({ fetchFn: f.fn });
    for (const kind of ['openrouter', 'anthropic', 'deepseek', 'zai', 'openai']) {
      expect(await codeOf(router.createConnection({ kind, api_key: KEY, base_url: 'https://evil.example/v1' }))).toBe('base_url_not_allowed');
    }
    const or = await router.createConnection({ kind: 'openrouter', api_key: KEY });
    expect(await codeOf(router.updateConnection(or.id, { base_url: 'https://evil.example/v1' }))).toBe('base_url_not_allowed');
    expect(await codeOf(router.updateConnection(or.id, { base_url: 'http://169.254.169.254' }))).toBe('base_url_not_allowed');
    const cli = await router.createConnection({ kind: 'cli', cli: 'claude' });
    expect(await codeOf(router.updateConnection(cli.id, { base_url: 'https://evil.example' }))).toBe('base_url_not_allowed');
    expect(router.store.get(or.id)!.base_url).toBeNull();

    // 旧库里残留的自定义地址:读取时丢掉、记一条 warn,出站仍打缺省地址
    state.db.prepare('UPDATE model_connections SET base_url = ? WHERE id = ?').run('https://attacker.example/v1', or.id);
    expect(router.view().connections.find((c) => c.id === or.id)!.base_url).toBeNull();
    router.view();
    expect(logs.filter((l) => l.includes('已忽略'))).toHaveLength(1);
    router.setBinding('judge', { connection_id: or.id, model: 'deepseek/deepseek-v4.1-flash' });
    await router.brainForRole('judge').complete('s', 'u');
    expect(f.calls.map((c) => c.url)).toEqual(['https://openrouter.ai/api/v1/chat/completions']);
    await router.testConnection(or.id, { model: '~typesafe/jev-latest' }).catch(() => undefined);
    expect(f.calls.every((c) => !c.url.includes('attacker'))).toBe(true);
    expect(JSON.stringify(views) + logs.join('\n')).not.toContain(KEY);
  });

  it('openai_compatible base_url: https only, no userinfo/fragment, every resolved IP must be public', async () => {
    const { router } = makeRouter({ lookupFn: dns({ 'api.example.com': [PUBLIC], 'mixed.example.com': [PUBLIC, '10.1.2.3'], 'meta.example.com': ['169.254.169.254'], 'v6.example.com': ['fd00:ec2::254'] }) });
    const bad: [Record<string, unknown>, string][] = [
      [{ base_url: 'https://10.0.0.5/v1' }, 'base_url_blocked'],
      [{ base_url: 'https://172.16.3.4/v1' }, 'base_url_blocked'],
      [{ base_url: 'https://192.168.1.2/v1' }, 'base_url_blocked'],
      [{ base_url: 'https://169.254.169.254/latest' }, 'base_url_blocked'],
      [{ base_url: 'https://100.100.100.200/v1' }, 'base_url_blocked'],
      [{ base_url: 'https://100.64.0.1/v1' }, 'base_url_blocked'],
      [{ base_url: 'https://0.0.0.0/v1' }, 'base_url_blocked'],
      [{ base_url: 'https://[fd00:ec2::254]/v1' }, 'base_url_blocked'],
      [{ base_url: 'https://[fe80::1]/v1' }, 'base_url_blocked'],
      [{ base_url: 'https://[::ffff:169.254.169.254]/v1' }, 'base_url_blocked'],
      [{ base_url: 'https://2130706433/v1', api_key: KEY }, 'base_url_blocked'], // 127.0.0.1 的整数写法
      [{ base_url: 'https://mixed.example.com/v1' }, 'base_url_blocked'],
      [{ base_url: 'https://meta.example.com/v1' }, 'base_url_blocked'],
      [{ base_url: 'https://v6.example.com/v1' }, 'base_url_blocked'],
      [{ base_url: 'https://nx.example.com/v1' }, 'base_url_unresolvable'],
      [{ base_url: 'https://user:pw@api.example.com/v1' }, 'bad_request'],
      [{ base_url: 'https://token@api.example.com/v1' }, 'bad_request'],
      [{ base_url: 'https://api.example.com/v1#frag' }, 'bad_request'],
      [{ base_url: 'ftp://api.example.com/v1' }, 'bad_request'],
      [{ base_url: 'http://api.example.com/v1', api_key: KEY }, 'base_url_insecure'],
      [{ base_url: 'http://api.example.com/v1' }, 'base_url_insecure'],
      [{ base_url: 'http://127.0.0.1:11434/v1', api_key: KEY }, 'base_url_insecure'],
      [{ base_url: 'http://localhost:11434/v1', api_key: KEY }, 'base_url_insecure'],
      [{ base_url: 'https://localhost/v1', api_key: KEY }, 'base_url_blocked'],
      [{ base_url: 'https://127.0.0.1/v1', api_key: KEY }, 'base_url_blocked'],
      [{ base_url: 'http://127.0.0.2:11434/v1' }, 'base_url_insecure'],
      [{ base_url: 'http://192.168.1.10:11434/v1' }, 'base_url_insecure'],
    ];
    for (const [body, code] of bad) expect([body, await codeOf(router.createConnection({ kind: 'openai_compatible', ...body }))]).toEqual([body, code]);
    expect(router.store.list()).toHaveLength(0);

    // 允许:本机无 key(http 也行)、公网 https(带 key)
    expect((await router.createConnection({ kind: 'openai_compatible', base_url: 'http://localhost:11434/v1/' })).base_url).toBe('http://localhost:11434/v1');
    expect((await router.createConnection({ kind: 'openai_compatible', base_url: 'http://[::1]:8080/v1' })).base_url).toBe('http://[::1]:8080/v1');
    const pub = await router.createConnection({ kind: 'openai_compatible', base_url: 'https://api.example.com/v1', api_key: KEY });
    expect(pub.base_url).toBe('https://api.example.com/v1');

    // PATCH 同样校验;失败不落库
    expect(await codeOf(router.updateConnection(pub.id, { base_url: 'https://169.254.169.254/v1' }))).toBe('base_url_blocked');
    expect(await codeOf(router.updateConnection(pub.id, { base_url: 'https://mixed.example.com/v1' }))).toBe('base_url_blocked');
    expect(router.store.get(pub.id)!.base_url).toBe('https://api.example.com/v1');
    // 本机 http 无 key 连接补 key → 必须改 https
    const local = router.store.list().find((c) => c.base_url === 'http://localhost:11434/v1')!;
    expect(await codeOf(router.updateConnection(local.id, { api_key: KEY }))).toBe('base_url_insecure');
    expect(router.vault.get(local.id)).toBeNull();
  });

  it('re-resolves before every outbound call (DNS rebinding) and never sends the request', async () => {
    const table: Record<string, string[]> = { 'rebind.example.com': [PUBLIC] };
    const f = fakeFetch(() => chatOk);
    const { router, logs } = makeRouter({ fetchFn: f.fn, lookupFn: dns(table) });
    const c = await router.createConnection({ kind: 'openai_compatible', base_url: 'https://rebind.example.com/v1', api_key: KEY });
    router.setBinding('chat', { connection_id: c.id, model: 'some-model' });
    await router.brainForRole('chat').complete('s', 'u');
    expect(f.calls).toHaveLength(1);
    table['rebind.example.com'] = ['127.0.0.1'];
    await expect(router.brainForRole('chat').complete('s', 'u')).rejects.toThrow(/^model_connection_failed:chat:出站地址被拒/);
    expect(f.calls).toHaveLength(1);
    expect(router.store.get(c.id)!.status).toBe('error');
    expect(logs.join('\n')).not.toContain(KEY);
  });

  it('3xx is a failure: never followed, Authorization never reaches the Location host', async () => {
    const f = fakeFetch((c) => (c.url.startsWith('https://evil.example') ? chatOk : { status: 307, body: null, headers: { location: 'https://evil.example/steal' } }));
    const { router, views, logs } = makeRouter({ fetchFn: f.fn, lookupFn: dns({ 'api.example.com': [PUBLIC] }) });
    const c = await router.createConnection({ kind: 'openai_compatible', base_url: 'https://api.example.com/v1', api_key: KEY });
    const t = await router.testConnection(c.id, { model: 'm1' });
    expect(t.ok).toBe(false);
    expect(t.detail).toMatch(/^307 .*重定向/);
    expect(f.calls).toHaveLength(1); // 不重试、不跟随
    expect(f.calls[0]).toMatchObject({ url: 'https://api.example.com/v1/chat/completions', redirect: 'manual' });
    expect(f.calls.some((x) => x.url.includes('evil.example'))).toBe(false);

    // 内置 provider 同理(openrouter 的对话、/models、Decisions 都是 manual)
    f.calls.length = 0;
    const or = await router.createConnection({ kind: 'openrouter', api_key: KEY });
    expect((await router.testConnection(or.id, {})).ok).toBe(false);
    expect((await router.testConnection(or.id, { model: '~typesafe/jev-latest' })).ok).toBe(false);
    expect(f.calls.map((x) => x.redirect)).toEqual(['manual', 'manual']);
    expect(f.calls.some((x) => x.url.includes('evil.example'))).toBe(false);
    expect(JSON.stringify(views) + logs.join('\n')).not.toContain(KEY);

    // /models 3xx:不跟随,hints 不被改
    const g = fakeFetch((x) => (x.url.endsWith('/models') ? { status: 302, body: null, headers: { location: 'https://evil.example/models' } } : x.url.includes('evil') ? { status: 200, body: { data: [{ id: 'deepseek/evil' }] } } : chatOk));
    const r2 = makeRouter({ fetchFn: g.fn });
    const or2 = await r2.router.createConnection({ kind: 'openrouter', api_key: KEY });
    expect((await r2.router.testConnection(or2.id, {})).ok).toBe(true);
    expect(g.calls.find((x) => x.url.endsWith('/models'))!.redirect).toBe('manual');
    expect(g.calls.some((x) => x.url.includes('evil'))).toBe(false);
    expect(r2.router.store.get(or2.id)!.models_hint).not.toContain('deepseek/evil');
  });

  it('httpBrain / JevDecisionClient: 3xx rejected with redirect=manual, single call', async () => {
    const f = fakeFetch(() => ({ status: 301, body: null, headers: { location: 'https://evil.example/' } }));
    const b = httpBrain({ kind: 'deepseek', base_url: 'https://api.deepseek.com', api_key: 'sk-deepseek-0123456789abcdef', model: 'deepseek-chat', fetchFn: f.fn, sleep: async () => {} });
    await expect(b.complete('s', 'u')).rejects.toThrow(/^301 .*重定向/);
    const c = new JevDecisionClient({ api_key: KEY, fetchFn: f.fn, sleep: async () => {} });
    const e = await c.decide({ state: {}, questions: { ok: { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } } } }).catch((x: Error) => x);
    expect((e as { code?: string }).code).toBe('http');
    expect(f.calls).toHaveLength(2);
    expect(f.calls.every((x) => x.redirect === 'manual' && !x.url.includes('evil'))).toBe(true);
  });

  it('api_key must be >= 16 chars without whitespace; every stored key is redacted regardless of length', async () => {
    const { router } = makeRouter();
    expect(await codeOf(router.createConnection({ kind: 'openrouter', api_key: 'sk-short' }))).toBe('api_key_invalid');
    expect(await codeOf(router.createConnection({ kind: 'openrouter', api_key: 'sk-0123456789 abcdefgh' }))).toBe('api_key_invalid');
    expect(await codeOf(router.createConnection({ kind: 'openai_compatible', base_url: 'http://localhost:1/v1', api_key: '123456789012345' }))).toBe('api_key_invalid');
    const ok = await router.createConnection({ kind: 'openrouter', api_key: '0123456789abcdef' });
    expect(await codeOf(router.updateConnection(ok.id, { api_key: 'abc' }))).toBe('api_key_invalid');
    expect(router.vault.get(ok.id)).toBe('0123456789abcdef');

    expect(redactKeyText('a tok b tok', ['tok'])).toBe('a [redacted] b [redacted]');
    expect(redactKeyText('k=abcdefgh1 k2=abc', ['abc', 'abcdefgh1'])).toBe('k=[redacted] k2=[redacted]');
    router.vault.set('legacy', 'short7!'); // 旧数据里的短 key 也要能抹掉
    expect(router.redact('upstream said short7! is bad')).toBe('upstream said [redacted] is bad');
  });

  it('blockedIpReason covers private / loopback / link-local / metadata / CGNAT / embedded v4', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.31.255.255', '192.168.0.1', '100.64.0.1', '0.0.0.0', '192.0.0.192', '224.0.0.1', '255.255.255.255', '::1', '::', 'fd00:ec2::254', 'fe80::1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1']) {
      expect([ip, blockedIpReason(ip)]).not.toEqual([ip, null]);
    }
    for (const ip of [PUBLIC, '8.8.8.8', '172.32.0.1', '100.128.0.1', '198.18.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) expect([ip, blockedIpReason(ip)]).toEqual([ip, null]);
  });
});
