// confirm.ts (v3.10): one-time human confirmation tokens + the three-tier split of chat set_workflow patches.
import { describe, expect, it } from 'vitest';
import { CONFIRM_TTL_MS, ConfirmationStore, fingerprintOf, splitWorkflowPatch } from '../../src/demo/confirm.js';

describe('ConfirmationStore', () => {
  it('issues a token bound to kind + target + fingerprint, consumes it exactly once', () => {
    let now = 1_000_000;
    const c = new ConfirmationStore(() => now);
    const fp = fingerprintOf({ a: 1 });
    const t = c.issue('intent', 'int-1', fp);
    expect(t.expires_at - t.issued_at).toBe(CONFIRM_TTL_MS);
    expect(c.consume(undefined, 'intent', 'int-1', fp)).toMatchObject({ ok: false, code: 'confirm_required' });
    expect(c.consume('nope', 'intent', 'int-1', fp)).toMatchObject({ ok: false, code: 'confirm_unknown' });
    expect(c.consume(t.nonce, 'workflow_proposal', 'int-1', fp)).toMatchObject({ ok: false, code: 'confirm_mismatch' });
    expect(c.consume(t.nonce, 'intent', 'int-2', fp)).toMatchObject({ ok: false, code: 'confirm_mismatch' });
    expect(c.consume(t.nonce, 'intent', 'int-1', fingerprintOf({ a: 2 }))).toMatchObject({ ok: false, code: 'confirm_mismatch' });
    expect(c.consume(t.nonce, 'intent', 'int-1', fp)).toEqual({ ok: true });
    expect(c.consume(t.nonce, 'intent', 'int-1', fp)).toMatchObject({ ok: false, code: 'confirm_unknown' });
    const t2 = c.issue('intent', 'int-1', fp);
    now += CONFIRM_TTL_MS + 1;
    expect(c.consume(t2.nonce, 'intent', 'int-1', fp)).toMatchObject({ ok: false, code: 'confirm_expired' });
  });
});

describe('splitWorkflowPatch', () => {
  it('direct / proposal / refused tiers; paused=true is direct, paused=false needs a human', () => {
    const r = splitWorkflowPatch({ narrate: false, info_every_ms: 60_000, watchlist: ['BTCUSDT'], watch_only: [], brain_model: 'x', risk_pct: '5', leverage: 20, auto_approve: true, cli_commands: { claude: 'rm -rf' }, paused: false });
    expect(Object.keys(r.direct).sort()).toEqual(['info_every_ms', 'narrate']);
    expect(Object.keys(r.proposal).sort()).toEqual(['brain_model', 'paused', 'watch_only', 'watchlist']);
    expect(r.refused.sort()).toEqual(['auto_approve', 'cli_commands', 'leverage', 'risk_pct']);
    expect(splitWorkflowPatch({ paused: true }).direct).toEqual({ paused: true });
  });
});
