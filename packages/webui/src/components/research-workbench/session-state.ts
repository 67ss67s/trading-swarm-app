import type { ResearchInquiry, ResearchInquiryEvent, ResearchInquiryStatus, ResearchPlan, ResearchStep, ResearchStepStatus } from '../../api/research-types';

/** API plans use `plan`; message plans use `steps`. Preserve both historical forms. */
export function normalizePlan(value: unknown): ResearchPlan | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as ResearchPlan & { plan?: ResearchPlan['steps'] };
  return { ...p, steps: (p.steps ?? p.plan ?? []).map((step) => ({ ...step, status: step.status ?? 'pending' })) };
}

export function stepKey(step: ResearchStep): string {
  return step.key ?? (step.id.startsWith(step.inquiry_id + ':') ? step.id.slice(step.inquiry_id.length + 1) : step.id);
}
export function resolvedPlanSteps(plan: ResearchPlan, steps: ResearchStep[]): ResearchStep[] {
  const byKey = new Map(steps.map((s) => [stepKey(s), s]));
  return plan.steps.map((p, seq) => byKey.get(p.key) ?? ({ ...p, id: p.key, inquiry_id: '', seq } as ResearchStep));
}
export interface LiveView {
  status: ResearchInquiryStatus | null;
  plan: ResearchPlan | null;
  steps: ResearchStep[];
  artifactIds: string[];
  errorCode: string | null;
  error: string | null;
}

/** 把 inquiry(落库那份)和实时事件折成当前视图。同一步骤后到的覆盖先到的。 */
export function foldLive(base: ResearchInquiry | null, events: ResearchInquiryEvent[]): LiveView {
  const view: LiveView = {
    status: base?.status ?? null,
    plan: normalizePlan(base?.plan),
    steps: (base?.steps ?? []).map((step) => ({ ...step })),
    artifactIds: [],
    errorCode: base?.error_code ?? null,
    error: base?.error ?? null,
  };
  const stepIndex = new Map<string, number>();
  view.steps.forEach((s, i) => {
    // 后端步骤行没有 key 列:id = `${inquiry_id}:${key}`,从 id 推回来给计划块对状态
    if (!s.key && s.id.startsWith(s.inquiry_id + ':')) s.key = s.id.slice(s.inquiry_id.length + 1);
    stepIndex.set(s.key ?? s.id, i);
    stepIndex.set(s.id, i);
  });

  for (const e of [...events].filter((e) => !base || e.inquiry_id === base.id).sort((a, b) => a.seq - b.seq)) {
    if (base && e.at < base.updated_at) continue;
    const d = (e.data ?? {}) as Record<string, unknown>;
    switch (String(e.event)) {
      case 'inquiry.queued':
        view.status = 'queued';
        break;
      case 'inquiry.planning':
        view.status = 'planning';
        break;
      case 'inquiry.plan':
        view.plan = normalizePlan(d);
        view.status = 'running';
        break;
      case 'inquiry.awaiting_input':
        view.status = 'awaiting_input';
        if (typeof d['clarify'] === 'string' && view.plan) view.plan = { ...view.plan, clarify: d['clarify'] as string };
        break;
      case 'step.started':
      case 'step.progress':
      case 'step.completed': {
        const id = String(d['step_id'] ?? d['id'] ?? d['key'] ?? '');
        if (!id) break;
        const key = String(d['key'] ?? id);
        const at = stepIndex.get(id) ?? stepIndex.get(key);
        const patch: Partial<ResearchStep> = {
          status: (d['status'] as ResearchStepStatus) ?? (e.event === 'step.completed' ? 'succeeded' : 'running'),
          ...(d['title'] ? { title: String(d['title']) } : {}),
          ...(d['tool'] ? { tool: String(d['tool']) } : {}),
          ...(d['input'] !== undefined ? { input: d['input'] } : {}),
          ...(d['summary'] !== undefined ? { output_summary: d['summary'] as Record<string, unknown> } : {}),
          ...(Array.isArray(d['snapshot_refs']) ? { snapshot_refs: d['snapshot_refs'] as string[] } : {}),
          ...(Array.isArray(d['artifact_refs']) ? { artifact_refs: d['artifact_refs'] as string[] } : {}),
          ...(d['error_code'] ? { error_code: String(d['error_code']) } : {}),
          ...(typeof d['started_at'] === 'number' ? { started_at: d['started_at'] as number } : {}),
          ...(typeof d['ended_at'] === 'number' ? { ended_at: d['ended_at'] as number } : {}),
        };
        if (at === undefined) {
          const seq = view.steps.length;
          view.steps.push({
            id,
            inquiry_id: e.inquiry_id,
            seq,
            key,
            title: String(d['title'] ?? key),
            tool: String(d['tool'] ?? ''),
            status: patch.status ?? 'running',
            ...patch,
          } as ResearchStep);
          stepIndex.set(id, seq);
          stepIndex.set(key, seq);
        } else {
          view.steps[at] = { ...view.steps[at]!, ...patch };
        }
        break;
      }
      case 'artifact.created': {
        const id = String(d['id'] ?? '');
        if (id && !view.artifactIds.includes(id)) view.artifactIds.push(id);
        break;
      }
      case 'inquiry.validating':
        view.status = 'validating';
        break;
      case 'inquiry.cancelling':
        view.status = 'cancelling';
        break;
      case 'inquiry.completed':
        view.status = 'completed';
        break;
      case 'inquiry.incomplete':
        view.status = 'incomplete';
        view.errorCode = (d['error_code'] as string) ?? view.errorCode;
        view.error = (d['error'] as string) ?? (d['reason'] as string) ?? view.error;
        break;
      case 'inquiry.failed':
        view.status = 'failed';
        view.errorCode = (d['error_code'] as string) ?? view.errorCode;
        view.error = (d['error'] as string) ?? view.error;
        break;
      case 'inquiry.cancelled':
        view.status = 'cancelled';
        break;
      default:
        break;
    }
  }

  // 计划里的步骤状态跟着实际步骤走(计划块只显示目的 + 状态点)
  if (view.plan) {
    const byKey = new Map(view.steps.map((s) => [s.key ?? s.id, s]));
    view.plan = {
      ...view.plan,
      steps: (view.plan.steps ?? []).map((p) => ({ ...p, status: byKey.get(p.key)?.status ?? p.status ?? 'pending' })),
    };
  }
  return view;
}

