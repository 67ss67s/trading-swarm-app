/**
 * 评审版新手引导的状态(纯逻辑,无 React):开没开、在第几步、看没看过。
 *
 *   首次访问 → maybeAutoStart() 打开第 1 步;关闭 / 走完 → closeTour() 记进 localStorage,之后不再自动弹;
 *   顶栏「Tour」按钮 → reopenTour() 随时从第 1 步重开。
 * localStorage 读写全部 try/catch(隐私模式 / 沙箱没有 storage 时:每次都当首次,但不会报错)。
 * storage 参数只给测试注入用。
 */
import { useSyncExternalStore } from 'react';

export const TOUR_SEEN_KEY = 'tg.judge.tour.v1';

export interface TourState {
  open: boolean;
  step: number;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

let state: TourState = { open: false, step: 0 };
const listeners = new Set<() => void>();

function emit(next: TourState): void {
  state = next;
  for (const fn of listeners) fn();
}

export function getTourState(): TourState {
  return state;
}

export function subscribeTour(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useTourState(): TourState {
  return useSyncExternalStore(subscribeTour, getTourState, getTourState);
}

export function hasSeenTour(storage: StorageLike | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(TOUR_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markSeen(storage: StorageLike | null): void {
  try {
    storage?.setItem(TOUR_SEEN_KEY, '1');
  } catch {
    /* 隐私模式等 */
  }
}

export function openTour(step = 0): void {
  emit({ open: true, step: Math.max(0, step) });
}

/** 顶栏 Tour 按钮:总是从第 1 步重开 */
export function reopenTour(): void {
  openTour(0);
}

/** 关闭或走完:记成看过,之后不再自动弹 */
export function closeTour(storage: StorageLike | null = defaultStorage()): void {
  markSeen(storage);
  emit({ open: false, step: state.step });
}

export function setTourStep(step: number, total: number): void {
  emit({ open: true, step: Math.min(Math.max(0, step), Math.max(0, total - 1)) });
}

/** 首次访问自动弹出;返回这次是否打开了 */
export function maybeAutoStart(storage: StorageLike | null = defaultStorage()): boolean {
  if (state.open || hasSeenTour(storage)) return false;
  openTour(0);
  return true;
}

/** 测试用:回到初始状态 */
export function resetTourForTest(): void {
  state = { open: false, step: 0 };
}
