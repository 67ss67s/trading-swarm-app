import type { Brain } from "../../brain.js";
import type { LoopBudget, LoopUsage } from "./store.js";
import { emptyUsage } from "./store.js";
export type BudgetClass = "none" | "data_call" | "model_call" | "backtest";
export class Budget {
  readonly usage: LoopUsage;
  readonly started: number;
  constructor(
    readonly limits: LoopBudget,
    readonly now: () => number = Date.now,
    usage = emptyUsage(),
    readonly changed: (usage: LoopUsage) => void = () => {},
  ) {
    this.usage = { ...usage };
    this.started = now() - usage.wall_clock_ms;
  }
  remaining(): number {
    return Math.max(0, this.limits.wall_clock_ms - (this.now() - this.started));
  }
  record(): void {
    this.usage.wall_clock_ms = Math.max(
      0,
      Math.floor(this.now() - this.started),
    );
    this.changed({ ...this.usage });
  }
  take(kind: BudgetClass): void {
    if (this.remaining() <= 0) throw Error("BUDGET_EXHAUSTED");
    const field =
      kind === "data_call"
        ? "max_data_calls"
        : kind === "model_call"
          ? "max_model_calls"
          : kind === "backtest"
            ? "max_backtests"
            : null;
    if (field) {
      if (this.usage[field] >= this.limits[field])
        throw Error("BUDGET_EXHAUSTED");
      this.usage[field]++;
    }
    this.record();
  }
  brain(brain: Brain | undefined, signal: AbortSignal): Brain | undefined {
    return brain
      ? {
          name: brain.name,
          complete: async (system, user, opts) => {
            if (signal.aborted) throw Error("CANCELLED");
            this.take("model_call");
            try {
              return await bounded(
                (s) =>
                  brain.complete(system, user, {
                    ...opts,
                    timeoutMs: Math.min(
                      opts?.timeoutMs ?? 30000,
                      this.remaining(),
                    ),
                  }),
                Math.min(opts?.timeoutMs ?? 30000, this.remaining()),
                signal,
              );
            } finally {
              this.record();
            }
          },
        }
      : undefined;
  }
}
/** Also bounds providers which ignore AbortSignal. Late results cannot write via registry's guarded context. */
export async function bounded<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parent: AbortSignal,
): Promise<T> {
  if (parent.aborted) throw Error("CANCELLED");
  if (ms <= 0) throw Error("BUDGET_EXHAUSTED");
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  const stop = new Promise<never>((_, reject) => {
    cancel = () => {
      ctl.abort();
      reject(Error("CANCELLED"));
    };
    parent.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      ctl.abort();
      reject(Error("TIMEOUT"));
    }, ms);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => fn(ctl.signal)),
      stop,
    ]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", cancel);
    ctl.abort();
  }
}
