// 日志治理规则表 —— 唯一定义处(报告 .codex-reports/soak-14d-report.md「日志治理规则表」照此列出)。
//
// 三类:
//   1. 噪音(NOISE_RULES 命中):写入时按宽松 key(scope+级别+规则+品种+接口+错误类别)合并成一行累计次数;
//      超过 TG_NOISE_KEEP_DAYS(默认 3)天后,每天每个 key 只留一行摘要(首次时间 at、末次时间 last_seen_at、次数 repeat_count),其余明细删除。
//   2. 可合并但永久保留:非 error 级、没命中噪音规则的行,只有「scope+级别+正文+data 完全相同」才在窗口内合并计数,不做任何清理。
//   3. 逐条永久保留:error 级 —— 不合并、不删除。
// 噪音规则永远不能指向 PROTECTED_SCOPES(测试里强制);规则表以外的日志没有任何删除路径。
import { createHash } from 'node:crypto';

export interface NoiseRule {
  id: string;
  /** 人话说明,进报告和 dry-run 输出。 */
  title: string;
  scopes: readonly string[];
  levels: readonly ('info' | 'warn')[];
  message: RegExp;
}

/** 有价值记录所在的 scope:这些 scope 的任何一行都不会被判成噪音(判断/线程/订单/成交/保护单/账本/审批/风控/ASP/研究/策略运行/人工操作/配置)。 */
export const PROTECTED_SCOPES: readonly string[] = [
  'episode', 'brain', 'council', 'judge', 'thread', 'exec', 'demo-exec', 'order', 'fill', 'protection', 'ledger', 'gate',
  'approval', 'risk', 'portfolio', 'reconcile', 'follow', 'asp_agent', 'research', 'strategy', 'strategy_run', 'chat',
  'runtime', 'process', 'models', 'memory', 'reviewer', 'workflow', 'bots', 'cap', 'account',
];

export const NOISE_RULES: readonly NoiseRule[] = [
  {
    id: 'market_fetch_failure',
    title: '行情轮询失败:ticker/资金费率超时、断连、429,或品种没有该市场的行情',
    scopes: ['market'],
    levels: ['warn', 'info'],
    message: /行情拉取失败|没有 ?\S* ?的行情|instrument 清单读取失败/,
  },
  {
    id: 'kline_fetch_failure',
    title: 'K 线/特征拉取失败:影子候选、触发器、影子巡检、事件影响回填遇到超时/断连/HTTP 错误',
    scopes: ['shadow', 'candidate', 'trigger', 'events'],
    levels: ['warn'],
    message: /HTTP [45]\d\d|超时|timeout|ECONNRESET|网络错误|fetch failed|回填失败|特征拉取失败|候选生成失败/i,
  },
  {
    id: 'informant_fetch_failure',
    title: '信息员外部信息源采集失败(网络/TLS)',
    scopes: ['info'],
    levels: ['warn'],
    message: /采集告警|fetch failed|curl: \(\d+\)|超时|timeout|ECONNRESET/i,
  },
  {
    id: 'heartbeat',
    title: 'info 级心跳与扫描流水',
    scopes: ['heartbeat', 'scan', 'trigger', 'market'],
    levels: ['info'],
    message: /心跳|heartbeat|轮询|扫描开始|扫描完成|无触发|未触发|没有触发/i,
  },
];

export interface PolicyLog { level: string; scope: string; message: string; json?: string | null }

export interface PolicyDecision {
  /** 命中噪音规则。 */
  noise: boolean;
  /** 命中的规则 id;非噪音为 'preserve'(可合并)或 'preserve_each'(error,逐条)。 */
  rule: string;
  /** 写入端合并 key;null = 不合并(error 级)。 */
  key: string | null;
}

const sha = (parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);

function errorClass(message: string): string {
  if (/没有 ?\S* ?的行情/.test(message)) return 'no_ticker';
  const http = /HTTP (\d{3})/.exec(message)?.[1];
  if (http) return `http_${http}`;
  if (/超时|timeout|timed out/i.test(message)) return 'timeout';
  if (/ECONNRESET|socket hang up|SSL|TLS|curl: \(\d+\)/i.test(message)) return 'connection';
  if (/网络错误|fetch failed|ENOTFOUND|EAI_AGAIN/i.test(message)) return 'network';
  return 'other';
}

export function logPolicy(line: PolicyLog): PolicyDecision {
  const rule = line.level === 'error' || PROTECTED_SCOPES.includes(line.scope)
    ? undefined
    : NOISE_RULES.find((r) => r.scopes.includes(line.scope) && (r.levels as readonly string[]).includes(line.level) && r.message.test(line.message));
  if (rule) {
    const market = /^\[(spot|perp)\]/.exec(line.message)?.[1] ?? '';
    const symbol = /\b([A-Z0-9]{2,20}(?:USDT|USDC|USD))\b/.exec(line.message)?.[1] ?? '';
    const endpoint = /\/api\/v5\/([a-z-]+\/[a-z-]+)/.exec(line.message)?.[1] ?? '';
    return { noise: true, rule: rule.id, key: sha([line.scope, line.level, rule.id, market, symbol, endpoint, errorClass(line.message)]) };
  }
  if (line.level === 'error') return { noise: false, rule: 'preserve_each', key: null };
  return { noise: false, rule: 'preserve', key: sha([line.scope, line.level, line.message, line.json ?? null]) };
}
