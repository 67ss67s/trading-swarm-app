/**
 * 交付物渲染:人读的摘要(中英双语标题)+ 规范化 JSON + sha256。
 * text 超过 MAX_TEXT 时,text 只留摘要和哈希,完整 JSON 放 file(由轮询方决定走 --file 还是 --deliverable-text)。
 * 措辞红线与发布器一致:不写收益保证类词。
 */
import { createHash } from 'node:crypto';
import { canonical } from '../../research/primitives.js';
import { BANNED_WORDS } from '../publisher.js';
import type { Deliverable, PerCallJob, ServiceKey } from './types.js';

export const MAX_TEXT = 3500;
export const DISCLAIMER = '基于规则计算与历史数据(标注处含 AI 模型判断),仅供分析,不构成投资建议 / Rule-based and historical analysis (AI model output where noted); not investment advice.';

export function sha256Of(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

/** undefined 不能进 canonical;统一剥掉,NaN/Infinity 变 null */
export function clean<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => typeof x === 'number' && !Number.isFinite(x) ? null : x)) as T;
}

export function deliverable(job: PerCallJob, key: ServiceKey, title: string, summary: string, lines: string[], body: Record<string, unknown>): Deliverable {
  const payload = clean({ service: key, job_id: job.job_id, source: 'trading-swarm', version: 1, ...body });
  const sha256 = sha256Of(payload);
  const head = [`${title}`, summary, ...lines, DISCLAIMER, `sha256: ${sha256}`].join('\n');
  if (BANNED_WORDS.test(head)) throw new Error('deliverable_banned_words');
  const json = JSON.stringify({ ...payload, sha256 });
  const full = `${head}\n${json}`;
  const fits = full.length <= MAX_TEXT;
  return {
    service_key: key, job_id: job.job_id, summary, sha256, payload,
    text: fits ? full : `${head}\n完整报告见附件 / Full report attached (${key}-${job.job_id.slice(0, 18)}.json)`,
    file: fits ? null : { filename: `${key}-${job.job_id.slice(0, 18)}.json`, content: JSON.stringify({ ...payload, sha256 }, null, 2) },
  };
}

export const pct = (x: number | null | undefined, digits = 1): string => x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(digits)}%`;
export const num = (x: number | null | undefined, digits = 2): string => x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(digits);
