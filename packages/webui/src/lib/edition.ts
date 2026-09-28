/**
 * 构建版本开关(2026-09-26 评审版英文优先)。
 *
 *   VITE_EDITION=judge npm run build -w @trade-gate/webui
 *
 * judge = 给 OKX 英文评审看的版本:只读锁、「Judge demo」标记、快照横幅、友好报错、新手引导。
 * 不设(或设成别的值)= 默认版(开源版),按钮全开。
 * 两个版本共有(2026-09-28 开源):默认语言 en(用户手动切过就记住他的选择,见 lib/i18n.ts readStored);
 * 侧栏不放「楼层(旧)」和「日志」两个旧页,直接用 hash 访问时回到楼层首页。
 *
 * 所有「评审版要不一样」的判断都从这里取,别在各处直接读 import.meta.env。
 */
import type { Page } from './nav';

export type Edition = 'default' | 'judge';

// 直接写成模块级常量比较(不包函数):vite 构建时把 import.meta.env.VITE_EDITION 替换成字面量,
// rollup 能据此把只在默认版用到的整块代码(旧楼层)摇掉。vitest / vite dev 同样有 import.meta.env。
export const IS_JUDGE: boolean = import.meta.env.VITE_EDITION === 'judge';

export const EDITION: Edition = IS_JUDGE ? 'judge' : 'default';

/** 没存过语言偏好时的默认语言(所有版本都是英文,可以在顶栏切中文) */
export const DEFAULT_LANG: 'zh' | 'en' = 'en';

/** 不露出的旧页:不进侧栏 / 命令面板,hash 直达也跳回楼层(所有版本) */
const HIDDEN_PAGES: readonly Page[] = ['floor-legacy', 'logs'];

export function isPageHidden(page: Page): boolean {
  return HIDDEN_PAGES.includes(page);
}

/** 隐藏页的落点 */
export const HIDDEN_PAGE_FALLBACK: Page = 'floor';

// ─────────────────────────────────────────────────────────────────────────────
// 评审版锁定:涉及机密(钱包 / 交易所凭证 / 模型密钥)或会动真钱、真上架的功能,按钮禁用 + 悬停说明原因。
// 原因文案统一英文(评审只看英文),按功能分类写在这一张表里;组件用 <JudgeLock feature="…"> 包一层即可。
// ─────────────────────────────────────────────────────────────────────────────

export type LockedFeature =
  // 钱包与账户凭证
  | 'wallet_connect'
  | 'exchange_credentials'
  | 'account_switch'
  // 模型连接
  | 'model_connection_edit'
  // 执行
  | 'execution_switch'
  | 'execution_policy'
  | 'execution_channel'
  | 'ai_scan_pause'
  | 'protection_verify'
  | 'emergency_stop'
  // 信号市场(OKX.AI ASP)
  | 'asp_register'
  | 'asp_publish'
  | 'asp_subscribe'
  | 'asp_claim'
  | 'asp_reply'
  | 'asp_settings'
  | 'asp_wallet'
  | 'asp_cancel';

const ASP_READONLY = 'Read-only in the judge edition — this is a snapshot of our live OKX.AI agent';

export const LOCK_REASONS: Record<LockedFeature, string> = {
  wallet_connect: 'Locked in the judge edition — wallet credentials stay private',
  exchange_credentials: 'Locked in the judge edition — OKX account credentials stay private',
  account_switch: 'Locked in the judge edition — the connected trading account is fixed for review',
  model_connection_edit: 'Locked in the judge edition — model API keys stay private, so connections can’t be added, edited or removed',
  execution_switch: 'Locked in the judge edition — the execution channel is fixed for review',
  execution_policy: 'Locked in the judge edition — the execution policy (judge layer, position sizing) is fixed for review',
  execution_channel: 'This judge edition runs on a paper account; switching to mainnet or testnet is disabled.',
  // 网关同一句:公网演示里访客只能恢复 AI 扫盘,不能暂停(暂停是全站共用的)
  ai_scan_pause: 'Pausing AI Scan is turned off in the public demo so it keeps running for everyone.',
  protection_verify: 'Locked in the judge edition — protection-order checks run against the private trading account',
  emergency_stop: 'Locked in the judge edition — emergency stop would close the live demo positions',
  // 信号市场 = OKX.AI 上真实 ASP 的只读快照:所有写操作一律同一句
  asp_register: ASP_READONLY,
  asp_publish: ASP_READONLY,
  asp_subscribe: ASP_READONLY,
  asp_claim: ASP_READONLY,
  asp_reply: ASP_READONLY,
  asp_settings: ASP_READONLY,
  asp_wallet: ASP_READONLY,
  asp_cancel: ASP_READONLY,
};

/** 评审版执行通道胶囊的固定文案(评审版只跑 paper) */
export const JUDGE_CHANNEL_LABEL = 'Paper · Judge demo';

/** 评审版下该功能锁定时返回英文原因;否则 null(默认版永远 null,行为不变) */
export function lockReason(feature: LockedFeature, edition: Edition = EDITION): string | null {
  return edition === 'judge' ? LOCK_REASONS[feature] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 技术报错友好化:评审版不把 ENOENT / spawn / CLI 路径 / stderr 之类原文摆给评审,
// 换成一句友好说明;原文只在 dev 下打到 console。默认版原样返回。
// ─────────────────────────────────────────────────────────────────────────────

/** OKX.AI 上真实上架的服务(评审版信号市场说明里引用) */
export const OKX_AI_LISTING_ID = '13866';
export const OKX_AI_LISTING_URL = 'https://www.okx.ai/agents/13866'; // Trading Swarm 在 OKX.AI 上的 ASP 页(Agent #13866)

const TECH_ERROR = /ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|spawn|stderr|stdout|exit code|exited with|command not found|No such file|onchainos|okx-a2a|daemon|\bCLI\b|\bcli\b|node:\d+|UNDICI|at [\w.<>]+ \(|\/(?:usr|opt|Users|home|tmp)\/|\.(?:js|mjs|ts|toml):\d*|--profile|~\/\.okx|pi exit|timed out after/i;

export const FRIENDLY_TECH_ERROR = 'This part runs on private infrastructure that is not connected in the judge edition.';

/** 交易所行情接口的原始报错(URL + HTTP / OKX 错误码 / 限频熔断),评审版换成一句行情暂不可用 */
// 两种 429 要分开说:
//   交易所限频 —— 网关调 OKX 被限(报错里带 /api/v5/ 路径、OKX 错误码,或网关自己的熔断 / 本机节流字样)
//   我们自己限频 —— nginx limit_req 或网关的访客限频(裸的 HTTP 429 / Too Many Requests / demo_rate_limited),跟交易所无关
const MARKET_ERROR = /\/api\/v5\/|-> OKX \d+|限频熔断|本机节流/i; // 别的 HTTP 错误(404 / 5xx)不能说成限频
export const FRIENDLY_MARKET_ERROR = 'Market data from the exchange was temporarily unavailable (rate limit), so this step was skipped.';
const OWN_RATE_LIMIT = /^(?:HTTP 429|Too Many Requests)$|demo_rate_limited|Too many live connections|<title>429 Too Many Requests<\/title>/i;
export const TOO_MANY_REQUESTS = 'Too many requests right now — retrying shortly';

/** 评审版:技术报错 → 友好文案(原文 dev 下进 console);其他情况原样 */
export function friendlyError<T extends string | null | undefined>(text: T, fallback: string = FRIENDLY_TECH_ERROR, edition: Edition = EDITION): T | string {
  if (edition !== 'judge' || !text) return text;
  if (text === TOO_MANY_REQUESTS) return text;
  if (MARKET_ERROR.test(text)) {
    if (import.meta.env?.DEV) console.debug('[judge] 行情报错已替换:', text);
    return fallback === FRIENDLY_TECH_ERROR ? FRIENDLY_MARKET_ERROR : fallback;
  }
  if (OWN_RATE_LIMIT.test(text.trim())) return fallback === FRIENDLY_TECH_ERROR ? TOO_MANY_REQUESTS : fallback;
  if (!TECH_ERROR.test(text)) return text;
  if (import.meta.env?.DEV) console.debug('[judge] 技术报错已替换:', text);
  return fallback;
}
