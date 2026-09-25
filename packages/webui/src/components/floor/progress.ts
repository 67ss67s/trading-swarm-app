/**
 * 楼层的进度小仓库:SSE 里带进度的两种事件(bots.changed 的 strategy_lab 实验进度、screener.changed 的
 * Radar 筛选进度)由 App.tsx 写进来,楼层桌子上的气泡读。15 秒没新进度就当结束(结束那条没有 progress)。
 */
import { useSyncExternalStore } from 'react';
import type { BotRole } from './types';

export interface RoleProgress {
  label: string;
  done: number;
  total: number;
  at: number;
}

type Store = Partial<Record<BotRole, RoleProgress>>;
let store: Store = {};
const listeners = new Set<() => void>();

export function setRoleProgress(role: BotRole, p: Omit<RoleProgress, 'at'> | null): void {
  const next = { ...store };
  if (p) next[role] = { ...p, at: Date.now() };
  else delete next[role];
  store = next;
  listeners.forEach((l) => l());
}

export function useRoleProgress(): Store {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => store,
    () => store,
  );
}

export const PROGRESS_TTL_MS = 15_000;
