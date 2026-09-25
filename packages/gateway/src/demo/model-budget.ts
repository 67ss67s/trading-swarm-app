import type { ReadState } from './direct-agent-reads.js';
export interface ModelBudgetStatus { blocked: boolean; blocked_at: number | null; reason: string | null }
/** Durable latch: don't guess reset timestamps from localized prose, never auto-retry a write. */
export class ModelBudget {
  constructor(private readonly state: ReadState, private readonly key: string) {}
  status(): ModelBudgetStatus {
    const text = this.state.get(this.key); if (!text) return { blocked: false, blocked_at: null, reason: null };
    try { const v = JSON.parse(text); if (typeof v.blocked === 'boolean') return v; } catch {}
    return { blocked: true, blocked_at: null, reason: '额度暂停记录无效，请人工检查后恢复' };
  }
  observe(text: string): boolean {
    if (!/(you(?:'|’)ve hit your (?:(?:weekly|daily|usage|[0-9 -]+hour) )?limit|weekly (?:usage )?limit|usage limit (?:reached|exceeded)|out of (?:extra )?usage|insufficient (?:credits|quota)|credit balance is too low)/i.test(text)) return false;
    this.state.set(this.key, JSON.stringify({ blocked: true, blocked_at: Date.now(), reason: '模型额度已耗尽，已停止自动尝试；额度恢复后请手动解除' }));
    return true;
  }
  reset(): void { this.state.set(this.key, JSON.stringify({ blocked: false, blocked_at: null, reason: null })); }
}
