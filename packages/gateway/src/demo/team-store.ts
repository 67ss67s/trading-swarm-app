/** 持久化:Portfolio 快照 + Risk 告警(migrations/0010)。 */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PortfolioSnapshot } from './portfolio.js';
import type { RiskAlert, RiskSeverity } from './risk.js';
import { riskActionFor, riskFingerprint } from './risk.js';

export interface RiskAlertRow extends RiskAlert {
  id: string;
  first_seen_at: number;
  last_seen_at: number;
  observed_count: number;
  resolved_at: number | null;
  acked_at: number | null;
  clean_streak: number;
  recovery_ready: boolean;
}

/** warn 连续几轮干净就自动解除;high/critical 连续几轮干净只标 recovery_ready,仍锁着等人确认。 */
export const CLEAN_STREAK_TO_RESOLVE = 3;
/**
 * 09-20:这些告警说的是「基础设施/证据新鲜度」而不是钱——条件一消失就该自己关掉,不该攒成一堆「确认恢复」
 * 让人逐条点(楼层上 4 个币 × 未验证止损 + 组件过期 = 5 条待办,而事实早就恢复了)。
 * 人工确认只留给动钱的那几类:日亏、敞口、裸仓、紧急停止、容量、止损预算……
 */
export const AUTO_RECOVER_KINDS: ReadonlySet<string> = new Set([
  'protection_never_verified', 'protection_stale', 'verify_protection',
  'account_stale', 'account_incomplete', 'market_stale',
  'transport_unstable', 'execution_disconnected', 'execution_unknown',
]);

/** 快照最多多久落一行(内容没变时)。 */
export const SNAPSHOT_SAMPLE_MS = 15 * 60_000;

export class PortfolioStore {
  constructor(private readonly db: DatabaseSync) {}

  /** 内容指纹变了或距上次落库超过 15 分钟才写;返回是否写了。 */
  save(s: PortfolioSnapshot, policyVersion: number): boolean {
    const last = this.latest();
    if (last && last.economic_fingerprint === s.economic_fingerprint && s.observed_at - last.observed_at < SNAPSHOT_SAMPLE_MS) return false;
    this.db
      .prepare('INSERT OR REPLACE INTO demo_portfolio_snapshot(snapshot_id, observed_at, quality, economic_fingerprint, policy_version, equity, gross_ratio, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.snapshot_id, s.observed_at, s.quality, s.economic_fingerprint, policyVersion, s.equity, Number.isFinite(s.projected.gross_ratio) ? s.projected.gross_ratio : -1, JSON.stringify(s));
    return true;
  }
  latest(): PortfolioSnapshot | null {
    const row = this.db.prepare('SELECT json FROM demo_portfolio_snapshot ORDER BY observed_at DESC LIMIT 1').get() as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as PortfolioSnapshot) : null;
  }
  get(id: string): PortfolioSnapshot | null {
    const row = this.db.prepare('SELECT json FROM demo_portfolio_snapshot WHERE snapshot_id = ?').get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as PortfolioSnapshot) : null;
  }
  history(limit = 50): { snapshot_id: string; observed_at: number; quality: string; equity: number; gross_ratio: number }[] {
    return this.db.prepare('SELECT snapshot_id, observed_at, quality, equity, gross_ratio FROM demo_portfolio_snapshot ORDER BY observed_at DESC LIMIT ?').all(Math.max(1, Math.min(500, limit))) as {
      snapshot_id: string;
      observed_at: number;
      quality: string;
      equity: number;
      gross_ratio: number;
    }[];
  }
}

export class RiskStore {
  constructor(private readonly db: DatabaseSync) {
    // 合并升级前按数值/分钟分桶产生的开放行;保留最早 id、总次数和最新事实。
    db.exec('SAVEPOINT risk_identity');
    try {
      const groups = new Map<string, RiskAlertRow[]>();
      for (const a of this.open()) {
        const key = riskFingerprint(a.kind, a.scope);
        groups.set(key, [...(groups.get(key) ?? []), a]);
      }
      for (const [key, rows] of groups) {
        const latest = rows[0]!;
        const first = rows.reduce((a, b) => a.first_seen_at <= b.first_seen_at ? a : b);
        for (const a of rows) if (a.id !== first.id) db.prepare('DELETE FROM demo_risk_alert WHERE id = ?').run(a.id);
        db.prepare('UPDATE demo_risk_alert SET fingerprint=?, first_seen_at=?, last_seen_at=?, observed_count=?, title=?, detail=?, value=?, threshold=?, refs_json=?, severity=?, auto_action=?, clean_streak=?, recovery_ready=? WHERE id=?')
          .run(key, first.first_seen_at, latest.last_seen_at, rows.reduce((n,a) => n+a.observed_count,0), latest.title, latest.detail, latest.value, latest.threshold, JSON.stringify(latest.refs), latest.severity, latest.auto_action, latest.clean_streak, Number(latest.recovery_ready), first.id);
      }
      db.exec('RELEASE risk_identity');
    } catch (e) { db.exec('ROLLBACK TO risk_identity; RELEASE risk_identity'); throw e; }
  }

  private toRow(r: Record<string, unknown>): RiskAlertRow {
    const refs = JSON.parse(String(r['refs_json'] ?? '[]')) as string[];
    return {
      id: String(r['id']),
      fingerprint: String(r['fingerprint']),
      kind: String(r['kind']) as RiskAlert['kind'],
      severity: String(r['severity']) as RiskSeverity,
      scope: String(r['scope']),
      title: String(r['title']),
      detail: String(r['detail']),
      value: r['value'] === null ? null : Number(r['value']),
      threshold: r['threshold'] === null ? null : Number(r['threshold']),
      refs,
      auto_action: String(r['auto_action']) as RiskAlert['auto_action'],
      action: riskActionFor(String(r['kind']) as RiskAlert['kind'], String(r['scope']), refs),
      first_seen_at: Number(r['first_seen_at']),
      last_seen_at: Number(r['last_seen_at']),
      observed_count: Number(r['observed_count']),
      resolved_at: r['resolved_at'] === null ? null : Number(r['resolved_at']),
      acked_at: r['acked_at'] === null ? null : Number(r['acked_at']),
      clean_streak: Number(r['clean_streak'] ?? 0),
      recovery_ready: Number(r['recovery_ready'] ?? 0) === 1,
    };
  }

  open(): RiskAlertRow[] {
    return (this.db.prepare('SELECT * FROM demo_risk_alert WHERE resolved_at IS NULL ORDER BY last_seen_at DESC').all() as Record<string, unknown>[]).map((r) => this.toRow(r));
  }
  list(opts: { status?: 'open' | 'resolved' | 'all'; limit?: number } = {}): RiskAlertRow[] {
    const where = opts.status === 'resolved' ? 'WHERE resolved_at IS NOT NULL' : opts.status === 'all' ? '' : 'WHERE resolved_at IS NULL';
    return (this.db.prepare(`SELECT * FROM demo_risk_alert ${where} ORDER BY last_seen_at DESC LIMIT ?`).all(Math.max(1, Math.min(500, opts.limit ?? 100))) as Record<string, unknown>[]).map((r) => this.toRow(r));
  }
  byId(id: string): RiskAlertRow | null {
    const r = this.db.prepare('SELECT * FROM demo_risk_alert WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.toRow(r) : null;
  }

  /**
   * 用一轮评估结果对齐库里的开放告警(评审稿 §4.4 的 latch 语义):
   *   - 新指纹 → 插入(opened);
   *   - 已有指纹 → 更新 last_seen/count,clean_streak 归零,recovery_ready 归零;
   *   - 不在结果里的开放告警:clean_streak+1;warn/info 连续 3 轮干净 → 自动 resolved(滞回,防 80% 边界抖动);
   *     high/critical 连续 3 轮干净 → 只标 recovery_ready=1,**仍然开放且仍然 block_new_risk**,要人点「确认恢复」。
   */
  reconcile(inputAlerts: readonly RiskAlert[], now: number): { opened: RiskAlertRow[]; resolved: RiskAlertRow[]; recovery_ready: RiskAlertRow[]; open: RiskAlertRow[] } {
    const alerts = inputAlerts.map((a) => ({ ...a, fingerprint: riskFingerprint(a.kind, a.scope) }));
    const existing = new Map(this.open().map((a) => [a.fingerprint, a]));
    const opened: RiskAlertRow[] = [];
    const seen = new Set<string>();
    const ins = this.db.prepare(
      'INSERT INTO demo_risk_alert(id, fingerprint, kind, severity, scope, title, detail, value, threshold, refs_json, auto_action, first_seen_at, last_seen_at, observed_count, resolved_at, acked_at, clean_streak, recovery_ready) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, 0, 0)',
    );
    // severity/auto_action 也跟着最新评估走:规则降级(比如 channel_cannot_protect high→warn)后,老行不能还锁着 block_new_risk
    const upd = this.db.prepare('UPDATE demo_risk_alert SET last_seen_at = ?, observed_count = observed_count + 1, title = ?, detail = ?, value = ?, severity = ?, auto_action = ?, threshold = ?, refs_json = ?, clean_streak = 0, recovery_ready = 0 WHERE id = ?');
    for (const a of alerts) {
      if (seen.has(a.fingerprint)) continue;
      seen.add(a.fingerprint);
      const cur = existing.get(a.fingerprint);
      if (cur) upd.run(now, a.title, a.detail, a.value, a.severity, a.auto_action, a.threshold, JSON.stringify(a.refs), cur.id);
      else {
        const id = `ra-${now.toString(36)}${randomBytes(3).toString('hex')}`;
        ins.run(id, a.fingerprint, a.kind, a.severity, a.scope, a.title, a.detail, a.value, a.threshold, JSON.stringify(a.refs), a.auto_action, now, now);
        opened.push(this.byId(id)!);
      }
    }
    const resolved: RiskAlertRow[] = [];
    const ready: RiskAlertRow[] = [];
    const bump = this.db.prepare('UPDATE demo_risk_alert SET clean_streak = clean_streak + 1 WHERE id = ?');
    const res = this.db.prepare('UPDATE demo_risk_alert SET resolved_at = ? WHERE id = ?');
    const mark = this.db.prepare('UPDATE demo_risk_alert SET recovery_ready = 1 WHERE id = ?');
    for (const [fpr, row] of existing) {
      if (seen.has(fpr)) continue;
      bump.run(row.id);
      const streak = row.clean_streak + 1;
      if (streak < CLEAN_STREAK_TO_RESOLVE) continue;
      if ((row.severity === 'high' || row.severity === 'critical') && !AUTO_RECOVER_KINDS.has(row.kind)) {
        if (!row.recovery_ready) {
          mark.run(row.id);
          ready.push({ ...row, clean_streak: streak, recovery_ready: true });
        }
      } else {
        res.run(now, row.id);
        resolved.push({ ...row, clean_streak: streak, resolved_at: now });
      }
    }
    return { opened, resolved, recovery_ready: ready, open: this.open() };
  }

  /** 人点「确认恢复」:只有 recovery_ready 的 high/critical 才能关;条件还在(clean_streak 归零)就拒。 */
  /** v3.11:某类告警的成因被用户的动作直接消除(如止损验证通过)→ 直接解除,不再要求「确认恢复」。返回解除的条数。 */
  /** 成因已由用户动作消除时直接关掉这一类告警;给了 scope 就只关那个对象(09-12:保护腿凭证按币发)。 */
  resolveKind(kind: RiskAlert['kind'], now: number, scope?: string): number {
    const res = scope === undefined
      ? this.db.prepare('UPDATE demo_risk_alert SET resolved_at = ? WHERE resolved_at IS NULL AND kind = ?').run(now, kind)
      : this.db.prepare('UPDATE demo_risk_alert SET resolved_at = ? WHERE resolved_at IS NULL AND kind = ? AND scope = ?').run(now, kind, scope);
    return Number(res.changes);
  }
  confirmRecovery(id: string, now: number): { ok: boolean; alert: RiskAlertRow | null; error: string | null } {
    const a = this.byId(id);
    if (!a) return { ok: false, alert: null, error: '没有这条告警' };
    if (a.resolved_at) return { ok: true, alert: a, error: null };
    if (!a.recovery_ready) return { ok: false, alert: a, error: `恢复事实还没齐(连续干净 ${a.clean_streak}/${CLEAN_STREAK_TO_RESOLVE} 轮),不能人工关掉` };
    this.db.prepare('UPDATE demo_risk_alert SET resolved_at = ? WHERE id = ?').run(now, id);
    return { ok: true, alert: this.byId(id), error: null };
  }

  /** 「全部确认恢复」:把所有 recovery_ready 的开放告警一次关掉;条件还在的一条都不动。返回关掉的行。 */
  confirmAllRecovery(now: number): RiskAlertRow[] {
    const ready = this.open().filter((a) => a.recovery_ready);
    for (const a of ready) this.db.prepare('UPDATE demo_risk_alert SET resolved_at = ? WHERE id = ?').run(now, a.id);
    return ready.map((a) => this.byId(a.id)!).filter(Boolean);
  }

  ack(id: string, now: number): RiskAlertRow | null {
    this.db.prepare('UPDATE demo_risk_alert SET acked_at = COALESCE(acked_at, ?) WHERE id = ?').run(now, id);
    return this.byId(id);
  }
}
