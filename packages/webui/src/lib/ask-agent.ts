/**
 * 「问 agent 为什么」的跨页面入口:判断记录 / 线程行 / 复盘页点一下,跳到 Agent 页并把问题
 * 预填进对话框。走一个模块级的小信箱(不是 URL 参数——问题可能带中文和 id,放 hash 里难看)。
 * ChatPanel 挂载时读一次,之后监听 `tg:ask-agent` 事件;读走即清空,刷新页面不会重复弹。
 */

import { getLang, t } from '@/lib/i18n';

const EVENT = 'tg:ask-agent';
let pending: string | null = null;

export function askAgent(question: string): void {
  pending = question;
  if (window.location.hash.slice(1).split('?')[0] !== 'agent') window.location.hash = 'agent';
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function takePendingQuestion(): string | null {
  const q = pending;
  pending = null;
  return q;
}

export function onAskAgent(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}

/** 统一的提问文案,几个入口共用。 */
export function whyQuestion(args: { symbol: string; at: number; action: string | null; episodeId?: string | null; threadId?: string | null }): string {
  const hhmm = new Date(args.at).toLocaleTimeString(getLang() === 'en' ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (args.threadId && !args.episodeId) return t('这笔 {symbol} 当时是怎么判断的,结果为什么是这样?先看线程 {thread} 的判断记录再回答。', { symbol: args.symbol, thread: args.threadId });
  return t('为什么 {symbol} 在 {time} 判断{action}?(episode {episode})', { symbol: args.symbol, time: hhmm, action: args.action ?? t('成这样'), episode: args.episodeId ?? '' });
}
