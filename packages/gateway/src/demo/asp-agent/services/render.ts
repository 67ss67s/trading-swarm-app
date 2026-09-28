/**
 * 交付物渲染:人读的英文正文(OKX.AI 买方/审核方是国际用户;中文买方请求照常解析)+ 规范化 JSON + sha256。
 * text 超过 MAX_TEXT 时,text 只留摘要和哈希,完整 JSON 放 file(由轮询方决定走 --file 还是 --deliverable-text)。
 * 措辞红线与发布器一致:不写收益保证类词。
 */
import { createHash } from 'node:crypto';
import { canonical } from '../../research/primitives.js';
import { BANNED_WORDS } from '../publisher.js';
import type { Deliverable, PerCallJob, ServiceKey } from './types.js';

export const MAX_TEXT = 3500;
/** 纯规则 / 历史数据的交付(推荐、回测、矩阵、简报、雷达、告警) */
export const DISCLAIMER = 'Rule-based analysis of historical and market data. Not investment advice.';
/** 含 AI 模型判断的交付(计划把关调用了模型时、AI 概率判断) */
export const DISCLAIMER_AI = 'Contains AI-generated judgment alongside rule-based analysis of historical and market data. Not investment advice.';
/** 人读正文与末尾 JSON 代码块之间的分隔标题(测试按 `\n\n${STRUCTURED_HEADER}` 切出人读部分) */
export const STRUCTURED_HEADER = 'Structured data (JSON):';

export function sha256Of(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

/** undefined 不能进 canonical;统一剥掉,NaN/Infinity 变 null */
export function clean<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => typeof x === 'number' && !Number.isFinite(x) ? null : x)) as T;
}

/**
 * 正文先给人读内容(标题、结论、要点、免责声明),末尾附一个 JSON 代码块(上架描述承诺了 JSON);file 字段另存一份格式化 JSON。
 * 研究报告额外保留一行报告哈希(可链上存证);其余服务哈希只进 payload。
 */
export function deliverable(job: PerCallJob, key: ServiceKey, title: string, summary: string, lines: string[], body: Record<string, unknown>, opts: { ai?: boolean; hash?: boolean } = {}): Deliverable {
  const payload = clean({ service: key, job_id: job.job_id, source: 'trading-swarm', version: 1, ...body });
  const sha256 = sha256Of(payload);
  const showHash = opts.hash ?? key === 'research_report';
  const head = [`${title}`, summary, ...lines, opts.ai ? DISCLAIMER_AI : DISCLAIMER, ...(showHash ? [`Report hash (sha256): ${sha256}`] : [])].join('\n');
  if (BANNED_WORDS.test(head)) throw new Error('deliverable_banned_words');
  // 按次报告附结构化 JSON:deliver 只能发正文或附件二选一,长正文本来就会变成 .md 附件,JSON 放在末尾代码块里,聊天预览只看到前面的结论
  const text = `${head}\n\n${STRUCTURED_HEADER}\n\`\`\`json\n${JSON.stringify({ ...payload, sha256 })}\n\`\`\``;
  return {
    service_key: key, job_id: job.job_id, summary, sha256, payload, text,
    file: { filename: `${key}-${job.job_id.slice(0, 18)}.json`, content: JSON.stringify({ ...payload, sha256 }, null, 2) },
  };
}

export const pct = (x: number | null | undefined, digits = 1): string => x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(digits)}%`;
export const num = (x: number | null | undefined, digits = 2): string => x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(digits);
