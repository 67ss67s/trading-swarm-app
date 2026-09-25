// Human confirmation with one-time nonces (2026-09-06, Codex 派单设计稿 §C.3):
// 「会话开关 + 模型一句话」不等于人批。要真的动钱 / 改高风险设置,必须由界面先取一张一次性 confirm token
// (绑定目标 id + 内容指纹,120 秒过期),再带着它调 apply/approve。模型工具里没有 approve/reject。

import { createHash, randomBytes } from 'node:crypto';

export type ConfirmKind = 'intent' | 'workflow_proposal';

export interface ConfirmToken {
  nonce: string;
  kind: ConfirmKind;
  target_id: string;
  /** 目标内容的指纹:apply 时内容变了(意图被改、工作流被别人先改了)token 就失效 */
  fingerprint: string;
  issued_at: number;
  expires_at: number;
}

export const CONFIRM_TTL_MS = 120_000;

export function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

export class ConfirmationStore {
  private tokens = new Map<string, ConfirmToken>();
  constructor(private readonly now: () => number = Date.now) {}

  issue(kind: ConfirmKind, target_id: string, fingerprint: string): ConfirmToken {
    this.sweep();
    const t: ConfirmToken = { nonce: randomBytes(16).toString('hex'), kind, target_id, fingerprint, issued_at: this.now(), expires_at: this.now() + CONFIRM_TTL_MS };
    this.tokens.set(t.nonce, t);
    return t;
  }

  /** 一次性消费:成功即作废;任何不匹配都不消费(但过期的会被清掉)。 */
  consume(nonce: string | null | undefined, kind: ConfirmKind, target_id: string, fingerprint: string): { ok: true } | { ok: false; code: 'confirm_required' | 'confirm_unknown' | 'confirm_expired' | 'confirm_mismatch'; message: string } {
    if (!nonce) return { ok: false, code: 'confirm_required', message: '需要先取确认 token(界面上点一下)' };
    const t = this.tokens.get(nonce);
    this.sweep();
    if (!t) return { ok: false, code: 'confirm_unknown', message: '确认 token 不存在或已用过' };
    if (t.expires_at <= this.now()) {
      this.tokens.delete(nonce);
      return { ok: false, code: 'confirm_expired', message: '确认 token 已过期(120 秒),请重新点' };
    }
    if (t.kind !== kind || t.target_id !== target_id) return { ok: false, code: 'confirm_mismatch', message: '确认 token 不是给这个对象的' };
    if (t.fingerprint !== fingerprint) return { ok: false, code: 'confirm_mismatch', message: '对象内容在你点确认之后变了,请重新看一遍再点' };
    this.tokens.delete(nonce);
    return { ok: true };
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, t] of this.tokens) if (t.expires_at <= now) this.tokens.delete(k);
  }
}

/**
 * 对话里的 set_workflow 分两档:
 * - 直接生效(不改交易范围、不花钱、只降不升的):narrate / info_every_ms / heartbeat_every_ms / review_every_close / scan_mode / fast_move_pct / paused=true
 * - 只能提议(改交易范围、叫醒循环、换模型、改判断规则):watchlist / watch_only / timeframe / playbook_text / paused=false / brain* / cheap_brain*
 * - 永远不能(风险/杠杆/上限/自动执行/执行通道/cli_commands):拒绝
 */
export const DIRECT_WORKFLOW_KEYS = ['narrate', 'info_every_ms', 'heartbeat_every_ms', 'review_every_close', 'scan_mode', 'fast_move_pct'] as const;
export const PROPOSAL_WORKFLOW_KEYS = ['watchlist', 'watch_only', 'timeframe', 'playbook_text', 'brain', 'brain_model', 'cheap_brain', 'cheap_brain_model'] as const;

export function splitWorkflowPatch(patch: Record<string, unknown>): { direct: Record<string, unknown>; proposal: Record<string, unknown>; refused: string[] } {
  const direct: Record<string, unknown> = {};
  const proposal: Record<string, unknown> = {};
  const refused: string[] = [];
  for (const [k, v] of Object.entries(patch ?? {})) {
    if ((DIRECT_WORKFLOW_KEYS as readonly string[]).includes(k)) direct[k] = v;
    else if ((PROPOSAL_WORKFLOW_KEYS as readonly string[]).includes(k)) proposal[k] = v;
    else if (k === 'paused') {
      if (v === true) direct[k] = v;
      else proposal[k] = v;
    } else refused.push(k); // 含 chat_requires_approval:这个开关只能人改
  }
  return { direct, proposal, refused };
}

export interface WorkflowProposal {
  id: string;
  created_at: number;
  expires_at: number;
  status: 'pending' | 'applied' | 'rejected' | 'expired';
  via: 'chat';
  session_id: string | null;
  patch: Record<string, unknown>;
  /** 提议时这些键的现值(apply 时任一变了 → 指纹不符,要重新看) */
  before: Record<string, unknown>;
  /** 提议时按 applyWorkflowPatch 预演的结果(只含 patch 的键);预演有错时 errors 非空且不能 apply */
  after: Record<string, unknown>;
  errors: string[];
  resolved_at: number | null;
}

export const PROPOSAL_TTL_MS = 30 * 60_000;
