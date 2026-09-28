/**
 * 评审版(VITE_EDITION=judge)信号市场的纯函数:快照横幅文案、状态灯友好化、身份加载态。
 * 全部带 edition 参数(默认取构建时 EDITION),默认版一律原样返回,行为不变(friendlyMarketError 例外,见下)。
 * 评审版文案只给英文评审看,直接写英文字面量(不进 i18n)。
 */
import { EDITION, OKX_AI_LISTING_ID, friendlyError, isTechError, type Edition } from '@/lib/edition';
import { t } from '@/lib/i18n';
import type { ReadCacheMeta } from '@/api/types';

export const JUDGE_NOT_CONNECTED = 'Not connected in the judge edition';

/** 快照时间:unix 毫秒 / 秒 / ISO 字符串都认;认不出返回 null。 */
export function snapshotAsOfMs(v: unknown): number | null {
  if (typeof v === 'string' && v.trim() !== '') {
    if (/^\d+(\.\d+)?$/.test(v.trim())) return snapshotAsOfMs(Number(v));
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v < 1e11 ? v * 1000 : v;
}

/** 评审版横幅正文;默认版 null(不渲染)。asOfText 为空就省掉「as of …」。 */
export function snapshotBannerText(asOfText: string | null, edition: Edition = EDITION): string | null {
  if (edition !== 'judge') return null;
  const when = asOfText ? ` as of ${asOfText}` : '';
  return `This is a read-only snapshot of Trading Swarm's live ASP on OKX.AI — identity, services, subscriptions and deliveries —${when}. In the judge edition nothing here can be changed.`;
}

/** 默认版 OKX.AI 页:onchainos CLI 的原始报错(命令行、本机路径、进程退出码)换成这句 */
export const MARKET_CLI_ERROR_ZH = '本机的 OKX.AI 工具没准备好:可能还没安装,或者钱包登录过期了。到顶栏的账户菜单里重新登录钱包再试。';

const logged = new Set<string>();

/**
 * OKX.AI 页所有报错都走这里:评审版同 friendlyError;默认版把 CLI 原文(带命令行 / 本机路径那种)换成一句能照着做的说明,
 * 原文在浏览器控制台打一次(同一句只打一次),自己排查时还看得到。不是技术原文的报错(平台的业务提示)原样显示。
 */
export function friendlyMarketError<T extends string | null | undefined>(text: T, edition: Edition = EDITION): T | string {
  if (edition === 'judge') return friendlyError(text, undefined, edition);
  if (!text || !isTechError(text)) return text;
  if (!logged.has(text)) {
    logged.add(text);
    console.warn('[OKX.AI] 原始报错:', text);
  }
  return t(MARKET_CLI_ERROR_ZH);
}

export const listingLabel = (): string => `OKX.AI #${OKX_AI_LISTING_ID}`;

/** 状态灯 detail:评审版里没亮的灯一律中性说明(守护 / CLI / 账户表单之类的原文不给评审看);亮着的灯 detail 也过一遍 friendlyError。 */
export function judgeLightDetail(ok: boolean, detail: string | null, edition: Edition = EDITION): string | null {
  if (edition !== 'judge') return detail;
  if (!ok) return JUDGE_NOT_CONNECTED;
  return detail ? friendlyError(detail, JUDGE_NOT_CONNECTED, edition) : detail;
}

/**
 * 身份一栏显示什么:'loaded' = 有身份;'loading' = 还在加载;'none' = 确认没有;'unknown' = 显示「—」。
 * 评审版不显示「加载中」:快照数据是定格的,没到就显示中性的「—」,下次轮询到了自然补上,不会一直转。
 */
export type IdentityState = 'loaded' | 'loading' | 'none' | 'unknown';
export function identityState(identity: unknown, section: ReadCacheMeta | undefined, edition: Edition = EDITION): IdentityState {
  if (identity) return 'loaded';
  const loading = section?.fetched_at === null;
  if (edition !== 'judge') return loading ? 'loading' : 'none';
  return loading || section?.error ? 'unknown' : 'none';
}

/** 评审版 CacheNote 文案:「Snapshot as of …」;没有任何时间就不显示(null)。从不带刷新失败 / 原始报错。 */
export function judgeCacheNoteText(cache: Pick<ReadCacheMeta, 'fetched_at'> | undefined, asOf: unknown, fmt: (ms: number) => string): string | null {
  const at = snapshotAsOfMs(asOf) ?? (cache?.fetched_at ?? null);
  return at ? `Snapshot as of ${fmt(at)}` : null;
}
