// 进程级兜底:SIGINT/SIGTERM 干净退出;未捕获异常一律限时退出交给 systemd 重启(状态已不可信);
// 未处理的 Promise rejection 若是网络类(超时、断连、DNS、abort)记一条继续跑,否则同样退出。
// 1 小时内可恢复 rejection 超过 TG_MAX_RECOVERABLE_REJECTIONS(默认 50)次也退出,避免带病硬撑。
import { envInt } from './ops-config.js';

const CLEANUP_DEADLINE_MS = 20_000;
const REJECTION_WINDOW_MS = 3_600_000;
const RECOVERABLE = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|timed? ?out|超时|AbortError|aborted/i;

export function isRecoverableRejection(reason: unknown): boolean {
  const text = reason instanceof Error ? `${reason.name} ${reason.message} ${(reason as { code?: string }).code ?? ''}` : String(reason ?? '');
  return RECOVERABLE.test(text);
}

export function installLifecycle(cleanup: () => Promise<void>, record: (kind: string, detail?: string) => void): void {
  let stopping = false;
  const recent: number[] = [];

  const stop = (code: number, kind: string): void => {
    if (stopping) {
      if (code) process.exitCode = code;
      return;
    }
    stopping = true;
    process.exitCode = code;
    // 不打印原始异常:可能带供应商凭证或命令行。库损坏/磁盘满时 stderr 仍能落到 journald。
    console.error(`${new Date().toISOString()} 进程退出 原因=${kind} code=${code}`);
    try {
      record(kind);
    } catch {
      console.error('退出原因写库失败');
    }
    const deadline = setTimeout(() => process.exit(process.exitCode || code), CLEANUP_DEADLINE_MS);
    void cleanup()
      .catch(() => { process.exitCode = 1; })
      .finally(() => {
        clearTimeout(deadline);
        process.exit(process.exitCode || code);
      });
  };

  process.on('SIGINT', () => stop(0, 'sigint'));
  process.on('SIGTERM', () => stop(0, 'sigterm'));
  process.on('uncaughtException', (e) => {
    console.error(`${new Date().toISOString()} uncaughtException ${e instanceof Error ? e.name : typeof e}`);
    stop(1, 'uncaught_exception');
  });
  process.on('unhandledRejection', (reason) => {
    if (!isRecoverableRejection(reason)) return stop(1, 'unhandled_rejection');
    const now = Date.now();
    recent.push(now);
    while (recent.length && now - recent[0]! > REJECTION_WINDOW_MS) recent.shift();
    try {
      record('recoverable_rejection', reason instanceof Error ? reason.name : 'non_error');
    } catch {
      /* 写库失败不影响继续运行 */
    }
    if (recent.length > envInt('TG_MAX_RECOVERABLE_REJECTIONS', 50, 1, 100_000)) stop(1, 'recoverable_rejection_storm');
  });
}
