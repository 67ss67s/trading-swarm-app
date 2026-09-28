// 14 天运行加固:日志合并与噪音摘要、库维护、备份、依赖告警、缓存上限、CLI 噪音、演示额度、进程兜底分类。
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { LogWriter } from '../../src/demo/log-retention.js';
import { logPolicy, NOISE_RULES, PROTECTED_SCOPES } from '../../src/demo/log-policy.js';
import { insertResearchDataset } from '../../src/demo/cache-capacity.js';
import { maintain, dailyBackup } from '../../src/demo/maintenance.js';
import { DependencyHealth } from '../../src/demo/dependency-health.js';
import { BoundedMap } from '../../src/demo/bounded-map.js';
import { stripCliNoise } from '../../src/demo/cli-noise.js';
import { isRecoverableRejection } from '../../src/demo/process-lifecycle.js';
import { assertVisitorCannotWrite, claimSlot, configureDemo, demoContext, reserveCliModel, reserveDemoCost, type DemoContext } from '../../src/demo/public-demo.js';

const DAY = 86_400_000;
const states: StateDb[] = [];
const dirs: string[] = [];

function setup(): StateDb & { file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'tg-soak-'));
  dirs.push(dir);
  const file = path.join(dir, 'state.sqlite');
  const state = openStateDb(file);
  states.push(state);
  return Object.assign(state, { file });
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const s of states.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const n = (db: DatabaseSync, sql: string, ...args: (string | number)[]): number => Number((db.prepare(sql).get(...args) as { n: number }).n);

// 18811 实测的高频日志原文(2026-09-25)
const SAMPLES = {
  noTicker: '[perp] XAUUSDT 行情拉取失败:OKX 没有 XAU-USDT 的行情(/api/v5/market/tickers)',
  funding: '[perp] NVDAUSDT 行情拉取失败:/api/v5/public/funding-rate?instId=NVDA-USDT-SWAP 网络错误 ECONNRESET',
  candle429: '[perp] 影子候选生成失败 CLUSDT:/api/v5/market/candles?instId=CL-USDT-SWAP&bar=15m&limit=300 -> HTTP 429',
  informant: '[perp] 信息员采集告警:ls:BTCUSDT: public fetch failed (35): curl: (35) LibreSSL SSL_connect',
};

describe('日志治理规则表', () => {
  it('噪音规则永远不指向受保护 scope,error 级永不算噪音', () => {
    for (const rule of NOISE_RULES) for (const scope of rule.scopes) expect(PROTECTED_SCOPES).not.toContain(scope);
    expect(logPolicy({ level: 'error', scope: 'market', message: SAMPLES.noTicker })).toMatchObject({ noise: false, key: null });
    expect(logPolicy({ level: 'warn', scope: 'exec', message: '行情拉取失败' })).toMatchObject({ noise: false, rule: 'preserve' });
  });

  it('18811 高频原文按预期归类,不同品种/接口/错误类别各自一个 key', () => {
    expect(logPolicy({ level: 'warn', scope: 'market', message: SAMPLES.noTicker }).rule).toBe('market_fetch_failure');
    expect(logPolicy({ level: 'warn', scope: 'market', message: SAMPLES.funding }).rule).toBe('market_fetch_failure');
    expect(logPolicy({ level: 'warn', scope: 'candidate', message: SAMPLES.candle429 }).rule).toBe('kline_fetch_failure');
    expect(logPolicy({ level: 'warn', scope: 'info', message: SAMPLES.informant }).rule).toBe('informant_fetch_failure');
    const key = (message: string): string | null => logPolicy({ level: 'warn', scope: 'market', message }).key;
    expect(key(SAMPLES.noTicker)).not.toBe(key(SAMPLES.noTicker.replaceAll('XAU', 'XAG')));
    expect(key(SAMPLES.funding)).not.toBe(key(SAMPLES.funding.replace('网络错误 ECONNRESET', '超时 8000ms')));
    // URL 里的时间戳等变化部分不影响 key
    expect(key(SAMPLES.funding)).toBe(key(SAMPLES.funding.replace('NVDA-USDT-SWAP', 'NVDA-USDT-SWAP&t=1')));
  });

  it('一天 15 万条同类噪音只写 288 行(5 分钟窗口),计数不丢', () => {
    const s = setup();
    const writer = new LogWriter(s.db);
    const start = Date.UTC(2026, 8, 1);
    for (let i = 0; i < 150_000; i++) writer.write({ at: start + Math.floor((i * DAY) / 150_000), level: 'warn', scope: 'market', message: SAMPLES.noTicker });
    writer.flush();
    expect(s.db.prepare('SELECT count(*) n, sum(repeat_count) total FROM demo_logs').get()).toMatchObject({ n: 288, total: 150_000 });
  });

  it('非噪音 warn 只有完全相同才合并;error 与不同线程的记录逐条保留', () => {
    const s = setup();
    const writer = new LogWriter(s.db);
    const at = Date.UTC(2026, 8, 1);
    for (let i = 0; i < 5; i++) writer.write({ at: at + i, level: 'warn', scope: 'strategy', message: 'active_strategies 有问题' });
    writer.write({ at, level: 'warn', scope: 'strategy', message: 'active_strategies 有问题', data: { id: 2 } });
    for (let i = 0; i < 3; i++) writer.write({ at: at + i, level: 'error', scope: 'exec', message: '提交未知', data: { thread_id: 'a' } });
    writer.write({ at, level: 'error', scope: 'exec', message: '提交未知', data: { thread_id: 'b' } });
    writer.flush();
    expect(n(s.db, "SELECT count(*) n FROM demo_logs WHERE scope = 'strategy'")).toBe(2);
    expect(n(s.db, "SELECT sum(repeat_count) n FROM demo_logs WHERE scope = 'strategy'")).toBe(6);
    expect(n(s.db, "SELECT count(*) n FROM demo_logs WHERE level = 'error'")).toBe(4);
  });
});

describe('库维护', () => {
  function seed(db: DatabaseSync, now: number): void {
    const insert = db.prepare('INSERT INTO demo_logs(at, level, scope, message, json) VALUES (?, ?, ?, ?, NULL)');
    for (let d = 1; d <= 6; d++) {
      for (let i = 0; i < 10; i++) insert.run(now - d * DAY + i * 1000, 'warn', 'market', SAMPLES.noTicker); // 旧库未合并的噪音
      insert.run(now - d * DAY, 'error', 'market', SAMPLES.noTicker); // error 永久
      insert.run(now - d * DAY, 'warn', 'reconcile', '入场单查询失败'); // 受保护 scope
    }
    db.prepare("INSERT INTO demo_episodes(id, at, status, json) VALUES ('e1', ?, 'done', '{}')").run(now - 30 * DAY);
  }

  it('dry-run 不改任何行,计划与真跑结果一致', async () => {
    const s = setup();
    const now = Date.UTC(2026, 8, 20, 12);
    seed(s.db, now);
    const snapshot = (): string => JSON.stringify(s.db.prepare('SELECT id, ops_noise, repeat_count FROM demo_logs ORDER BY id').all());
    const before = snapshot();
    vi.stubEnv('TG_MAINTENANCE_DRY_RUN', '1');
    const plan = await maintain(s.db, s.file, now);
    expect(snapshot()).toBe(before);
    expect(plan).toMatchObject({ dry_run: true, deleted: 27, summarized: 3 });
    vi.stubEnv('TG_MAINTENANCE_DRY_RUN', '0');
    const done = await maintain(s.db, s.file, now);
    expect(done).toMatchObject({ deleted: plan.deleted, summarized: plan.summarized, logs_before: 72, logs_after: 45 });
  });

  it('超过 3 天的噪音每天每 key 留一行摘要(首次/末次/次数),近 3 天、error、受保护记录、判断都不动', async () => {
    const s = setup();
    const now = Date.UTC(2026, 8, 20, 12);
    seed(s.db, now);
    await maintain(s.db, s.file, now);
    const summaries = s.db.prepare('SELECT at, last_seen_at, repeat_count FROM demo_logs WHERE ops_noise = 2 ORDER BY at').all() as { at: number; last_seen_at: number; repeat_count: number }[];
    expect(summaries).toHaveLength(3); // 第 4、5、6 天前
    for (const row of summaries) {
      expect(row.repeat_count).toBe(10);
      expect(row.last_seen_at - row.at).toBe(9000);
    }
    expect(n(s.db, "SELECT count(*) n FROM demo_logs WHERE ops_noise = 1 AND scope = 'market'")).toBe(30); // 近 3 天明细
    expect(n(s.db, "SELECT count(*) n FROM demo_logs WHERE level = 'error'")).toBe(6);
    expect(n(s.db, "SELECT count(*) n FROM demo_logs WHERE scope = 'reconcile'")).toBe(6);
    expect(n(s.db, 'SELECT count(*) n FROM demo_episodes')).toBe(1);
    // 再跑一次是幂等的
    const again = await maintain(s.db, s.file, now);
    expect(again).toMatchObject({ deleted: 0, summarized: 0 });
  });

  it('每轮批数有上限,分几轮也能收敛,摘要计数不重复', async () => {
    const s = setup();
    const now = Date.UTC(2026, 8, 20, 12);
    seed(s.db, now);
    vi.stubEnv('TG_MAINTENANCE_BATCH', '4');
    vi.stubEnv('TG_MAINTENANCE_MAX_BATCHES', '2');
    for (let round = 0; round < 20; round++) await maintain(s.db, s.file, now);
    expect(n(s.db, 'SELECT count(*) n FROM demo_logs WHERE ops_noise IS NULL')).toBe(0);
    expect(n(s.db, 'SELECT sum(repeat_count) n FROM demo_logs WHERE ops_noise = 2')).toBe(30);
    expect(n(s.db, 'SELECT count(*) n FROM demo_logs WHERE ops_noise = 2')).toBe(3);
  });

  it('超过 14 天的持仓/权益快照抽稀成每小时一条;风控告警引用的快照保留;dry-run 只计数;重复跑幂等', async () => {
    const s = setup();
    const now = Date.UTC(2026, 8, 30, 12);
    const old = now - 20 * DAY; // 整点起算
    const hour0 = Math.floor(old / 3_600_000) * 3_600_000;
    const snap = s.db.prepare("INSERT INTO demo_portfolio_snapshot(snapshot_id, observed_at, quality, economic_fingerprint, policy_version, equity, gross_ratio, json) VALUES (?, ?, 'ok', 'f', 1, 1, 0, '{}')");
    const eq = s.db.prepare("INSERT INTO demo_equity(at, equity, unrealized, backend) VALUES (?, 1, 0, ?)");
    for (let h = 0; h < 3; h++) {
      for (let i = 0; i < 12; i++) {
        const at = hour0 + h * 3_600_000 + i * 300_000;
        snap.run(`p-${h}-${i}`, at);
        eq.run(at, 'paper');
        eq.run(at + 1, 'okx');
      }
    }
    for (let i = 0; i < 12; i++) snap.run(`recent-${i}`, now - DAY + i * 300_000); // 近 14 天不动
    s.db.prepare("INSERT INTO demo_risk_alert(id, fingerprint, kind, severity, scope, title, detail, refs_json, auto_action, first_seen_at, last_seen_at, observed_count) VALUES ('r', 'f', 'stale', 'high', 'account', 'x', 'x', '[\"p-1-5\"]', 'none', ?, ?, 1)").run(old, old);
    vi.stubEnv('TG_MAINTENANCE_DRY_RUN', '1');
    const plan = await maintain(s.db, s.file, now);
    expect(plan.snapshots_thinned).toEqual({ demo_portfolio_snapshot: 32, demo_equity: 66 });
    expect(n(s.db, 'SELECT count(*) n FROM demo_portfolio_snapshot')).toBe(48);
    vi.stubEnv('TG_MAINTENANCE_DRY_RUN', '0');
    const done = await maintain(s.db, s.file, now);
    expect(done.snapshots_thinned).toEqual(plan.snapshots_thinned);
    expect(n(s.db, 'SELECT count(*) n FROM demo_portfolio_snapshot WHERE observed_at < ?', now - 14 * DAY)).toBe(4); // 3 小时各 1 条 + 告警引用的 1 条
    expect(n(s.db, "SELECT count(*) n FROM demo_portfolio_snapshot WHERE snapshot_id = 'p-1-5'")).toBe(1);
    expect(n(s.db, "SELECT count(*) n FROM demo_portfolio_snapshot WHERE snapshot_id LIKE 'recent-%'")).toBe(12);
    expect(n(s.db, 'SELECT count(*) n FROM demo_equity')).toBe(6); // 两个通道 × 3 小时
    expect((await maintain(s.db, s.file, now)).snapshots_thinned).toEqual({ demo_portfolio_snapshot: 0, demo_equity: 0 });
  });

  it('在线备份默认保留 2 份', async () => {
    const s = setup();
    vi.stubEnv('TG_BACKUP_ENABLED', '1');
    const now = Date.now();
    for (let d = 0; d < 4; d++) await dailyBackup(s.db, s.file, now + d * DAY);
    expect(readdirSync(path.join(path.dirname(s.file), 'backups'))).toHaveLength(2);
  });

  it('在线备份按日去重,轮转后保留最近 N 份可读备份且不留 -wal/-shm', async () => {
    const s = setup();
    vi.stubEnv('TG_BACKUP_ENABLED', '1');
    vi.stubEnv('TG_BACKUP_KEEP', '2');
    const now = Date.now();
    expect(await dailyBackup(s.db, s.file, now)).toBe(now);
    expect(await dailyBackup(s.db, s.file, now + 1000)).toBe(now);
    await dailyBackup(s.db, s.file, now + DAY);
    await dailyBackup(s.db, s.file, now + 2 * DAY);
    const dir = path.join(path.dirname(s.file), 'backups');
    const files = readdirSync(dir);
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(file).toMatch(/^state-\d+\.sqlite$/);
      const restored = new DatabaseSync(path.join(dir, file), { readOnly: true });
      try {
        expect(restored.prepare('PRAGMA quick_check').get()).toMatchObject({ quick_check: 'ok' });
      } finally {
        restored.close();
      }
    }
  });

  it('研究数据集到容量上限拒绝新增,重复数据复用,已有证据不删', () => {
    const s = setup();
    vi.stubEnv('TG_DATASET_MAX_BYTES', '10');
    insertResearchDataset(s.db, 'a', '123456');
    insertResearchDataset(s.db, 'a', '123456');
    expect(() => insertResearchDataset(s.db, 'b', 'abcdef')).toThrow(/research_cache_capacity/);
    expect(s.db.prepare('SELECT bytes, rows FROM ops_cache_usage').get()).toMatchObject({ bytes: 6, rows: 1 });
  });
});

describe('依赖、缓存、CLI 噪音、进程兜底', () => {
  it('连续失败只告警一次,恢复再发一次,不带原始错误', () => {
    const h = new DependencyHealth();
    const events: unknown[] = [];
    h.onSignal((e) => events.push(e));
    for (let i = 0; i < 8; i++) h.observe('account', false, 'timeout secret=abc', i);
    expect(events).toHaveLength(1);
    expect(h.view().account.consecutive_failures).toBe(8);
    h.observe('account', true, undefined, 20);
    expect(events).toHaveLength(2);
    expect(JSON.stringify([events, h.view()])).not.toMatch(/abc|secret/);
    h.observe('brain', false, '401 unauthorized');
    expect(events).toHaveLength(3); // 凭证失效立即告警
  });

  it('BoundedMap 换 key 十万次仍保持容量', () => {
    const cache = new BoundedMap<string, number>(32);
    for (let i = 0; i < 100_000; i++) cache.set(String(i), i);
    expect(cache.size).toBe(32);
    expect(cache.has('0')).toBe(false);
  });

  it('okx CLI 的更新提醒和 Node 警告被剥掉,真正的输出保留', () => {
    const stderr = 'Update available for @okx_ai/okx-trade-cli: 1.4.7 -> 1.4.8\nRun: npm install -g @okx_ai/okx-trade-cli\n';
    expect(stripCliNoise(stderr)).toBe('');
    expect(stripCliNoise('(node:45904) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.\n(Use `node --trace-warnings ...` to show where the warning was created)\n[{"ordId":"1"}]')).toBe('[{"ordId":"1"}]');
    expect(stripCliNoise('{"code":"51603","msg":"Order does not exist"}')).toBe('{"code":"51603","msg":"Order does not exist"}');
  });

  it('只有网络类 rejection 算可恢复', () => {
    expect(isRecoverableRejection(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRecoverableRejection(new DOMException('The operation was aborted', 'AbortError'))).toBe(true);
    expect(isRecoverableRejection(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
  });
});

describe('公网演示额度与写闸门', () => {
  const visitor: DemoContext = { role: 'anonymous', owner: false, invited: false, visitor: 'a:test' };

  it('访客上下文才计费;超出单访客日额度拒绝;后台调用不受影响', () => {
    const s = setup();
    vi.stubEnv('TG_PUBLIC_DEMO', '1');
    vi.stubEnv('TG_OWNER_TOKEN', 'o'.repeat(40));
    vi.stubEnv('TG_DEMO_VISITOR_DAILY_USD', '0.03');
    vi.stubEnv('TG_DEMO_CLI_CALL_USD', '0.02');
    configureDemo(s.db);
    reserveCliModel(true); // 后台:不计
    expect(n(s.db, 'SELECT count(*) n FROM ops_demo_usage')).toBe(0);
    demoContext.run(visitor, () => reserveCliModel(true));
    expect(() => demoContext.run(visitor, () => reserveCliModel(true))).toThrow(/spending cap reached/);
    expect(n(s.db, "SELECT reserved_microusd n FROM ops_demo_usage WHERE subject = 'visitors'")).toBe(20_000);
    expect(() => demoContext.run(visitor, () => reserveDemoCost(1))).not.toThrow();
  });

  it('没配 CLI 单价时访客不能触发本机模型;交易所写只挡访客', () => {
    vi.stubEnv('TG_PUBLIC_DEMO', '1');
    vi.stubEnv('TG_OWNER_TOKEN', 'o'.repeat(40));
    expect(() => demoContext.run(visitor, () => reserveCliModel(true))).toThrow(/not enabled for visitors/);
    vi.stubEnv('TG_DEMO_CLI_CALL_USD', '0.01');
    expect(() => demoContext.run(visitor, () => reserveCliModel(false))).toThrow(/with tools are owner-only/);
    expect(() => demoContext.run(visitor, () => assertVisitorCannotWrite())).toThrow(/Locked in the review demo/);
    expect(() => assertVisitorCannotWrite()).not.toThrow();
    expect(() => demoContext.run({ ...visitor, role: 'owner', owner: true }, () => assertVisitorCannotWrite())).not.toThrow();
  });

  it('重计算并发槽:公网默认 1,可整体关闭;释放幂等', () => {
    vi.stubEnv('TG_PUBLIC_DEMO', '1');
    const release = claimSlot('heavy');
    expect(() => claimSlot('heavy')).toThrow(/busy with another computation/);
    release();
    release();
    claimSlot('heavy')();
    vi.stubEnv('TG_HEAVY_ENABLED', '0');
    expect(() => claimSlot('heavy')).toThrow(/Heavy computation is disabled/);
  });
});
