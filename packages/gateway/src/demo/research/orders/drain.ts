/** 生成器驱动:执行核与意图计算写成逐根 yield 的生成器,同一份代码既能同步跑完(测试)也能按时间让出事件循环(全窗口回测)。
 * 网关里研究回测与交易同进程,任何逐根循环都不能一口气跑完:每 20ms 至少 await setImmediate 一次(与 engine.ts 同口径)。 */
export const YIELD_MS = 20;
export function drainSync<T>(g: Generator<void, T, void>): T { for (;;) { const r = g.next(); if (r.done) return r.value; } }
export async function drainAsync<T>(g: Generator<void, T, void>, check?: () => void): Promise<T> {
  let last = performance.now();
  for (;;) {
    const r = g.next(); if (r.done) return r.value;
    if (performance.now() - last > YIELD_MS) { check?.(); await new Promise<void>((resolve) => setImmediate(resolve)); last = performance.now(); }
  }
}
