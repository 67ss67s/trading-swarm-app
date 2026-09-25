import { randomUUID } from 'node:crypto';
import type { DemoStore } from '../store.js';
export function startAspRun(store: DemoStore, routine: string, input: Record<string, unknown>, id: string = randomUUID()): string {
  store.bots.startRun({ id, role: 'asp_agent', routine, started_at: Date.now(), budget: { model_calls: 0 }, input }); return id;
}
export function captainHandoff(store: DemoStore, key: string, summary: string, payload: Record<string, unknown>, deadline: number | null = null): void {
  store.bots.handoff({ handoff_id: randomUUID(), run_id: null, from_role: 'asp_agent', to_role: 'gate_captain', kind: 'alert', subject: { type: 'market', id: key }, summary, evidence_refs: [], artifact_refs: [], requested_output_schema: null, priority: 90, deadline_at: deadline, idempotency_key: `market:${key}`, payload });
}
/** Reserved model hooks: deliberately no model calls in this release. */
export function draftListingCopy(): null { return null; }
export function summarizeJudgmentForAnalysis(reason: string): string { return reason.slice(0, 1000); }
export function draftRejectReply(): null { return null; }
