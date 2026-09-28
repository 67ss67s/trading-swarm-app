/** 运维数值配置：非法值直接拒绝启动，避免 NaN 悄悄关闭限额。 */
export function envInt(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const text = process.env[name];
  if (text === undefined || text === '') return fallback;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min}–${max} 的整数`);
  return value;
}

/**
 * SSE 心跳间隔(/api/events 与 /api/judge/live/stream 共用)。反代(nginx,proxy_buffering off)下,客户端断开后
 * 上游连接要等下一次写失败才会 close;心跳越短,公网访客刷新后旧连接越快释放 SSE 名额。TG_SSE_HEARTBEAT_MS,1–120 秒。
 */
export const sseHeartbeatMs = (): number => envInt('TG_SSE_HEARTBEAT_MS', 10_000, 1_000, 120_000);
