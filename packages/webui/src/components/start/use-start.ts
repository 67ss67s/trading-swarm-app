/**
 * 「开始」清单的数据层:把已有接口的缓存拼成 StartInputs,交给 logic.ts 判。
 *
 *   useStartCore()  只拉核心四项要的数据(execution / models / brains / overview / agent strategy),
 *                   App.tsx 的默认首页和侧栏用;这几个 key 顶栏、楼层本来就在拉,不多花请求。
 *   useStartFull()  #start / #connect 页用,另外拉矩阵研究数和复盘线程数(可选项)。
 *
 * 「自由判断我确认过了」没有后端字段,记在本机 localStorage(try/catch;读不到按没确认)。
 */
import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useAgentStrategy } from '@/api/agent-strategy';
import { matrixApi } from '@/api/matrix-study';
import { useModels } from '@/components/models/use-models';
import { useExecutionQuery } from '@/components/connect/use-execution';
import { evaluateStart, startCoreComplete, startProgress, type StartInputs, type StartSteps } from './logic';

const FREE_CONFIRMED_KEY = 'tg.start.free_confirmed';
const listeners = new Set<() => void>();

function readFreeConfirmed(): boolean {
  try {
    return window.localStorage.getItem(FREE_CONFIRMED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setFreeJudgmentConfirmed(v: boolean): void {
  try {
    if (v) window.localStorage.setItem(FREE_CONFIRMED_KEY, '1');
    else window.localStorage.removeItem(FREE_CONFIRMED_KEY);
  } catch {
    /* 私密模式等:这次会话内就当没记住 */
  }
  for (const fn of listeners) fn();
}

function useFreeConfirmed(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    readFreeConfirmed,
    readFreeConfirmed,
  );
}

function useBaseInputs(): Omit<StartInputs, 'matrixStudies' | 'historyThreads'> {
  const execQ = useExecutionQuery();
  const modelsQ = useModels();
  const brainsQ = useQuery({ queryKey: ['brains'], queryFn: () => api.brains(), staleTime: 5 * 60_000, retry: 0 });
  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 20_000 });
  const stratQ = useAgentStrategy();
  const freeConfirmed = useFreeConfirmed();
  const wf = overviewQ.data?.workflow;
  return {
    execution: execQ.isError ? null : execQ.data,
    models: modelsQ.isError ? null : modelsQ.data,
    brains: brainsQ.isError ? null : brainsQ.data?.brains,
    slots: wf ? { brain: wf.brain, cheap_brain: wf.cheap_brain } : overviewQ.isError ? null : undefined,
    workflow: overviewQ.isError ? null : wf,
    agentPaused: overviewQ.isError ? null : overviewQ.data?.loop.paused,
    agentStrategyKind: stratQ.isError ? null : stratQ.data?.kind,
    freeJudgmentConfirmed: freeConfirmed,
  };
}

export interface StartState {
  steps: StartSteps;
  /** 核心四项:true / false / null(还判不出来) */
  core: boolean | null;
  progress: { done: number; total: number };
}

export function useStartCore(): StartState {
  const steps = evaluateStart(useBaseInputs());
  return { steps, core: startCoreComplete(steps), progress: startProgress(steps) };
}

export function useStartFull(): StartState & { inputs: StartInputs } {
  const base = useBaseInputs();
  const studiesQ = useQuery({ queryKey: ['matrix-studies'], queryFn: () => matrixApi.list(), retry: 0, staleTime: 30_000 });
  const historyQ = useQuery({ queryKey: ['history'], queryFn: () => api.history(200), retry: 0, staleTime: 60_000 });
  const inputs: StartInputs = {
    ...base,
    matrixStudies: studiesQ.isError ? null : studiesQ.data?.items.length,
    historyThreads: historyQ.isError ? null : historyQ.data?.threads.length,
  };
  const steps = evaluateStart(inputs);
  return { steps, core: startCoreComplete(steps), progress: startProgress(steps), inputs };
}
