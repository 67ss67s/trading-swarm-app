// 公网演示给非 owner 的投影:JSON 响应与 SSE 共用。去掉凭证类字段,抹掉字符串里的密钥、服务器路径和钱包地址。
// 交易账户(OKX 模拟盘/paper)的权益、持仓不算私密,照常展示;钱包余额走 /api/wallet,整条路由对访客遮蔽。
// 英文评审版(TG_PUBLIC_LANG=en)在同一次遍历里做出口英文覆盖(public-en.ts):对象先按形状覆盖,字符串再翻,最后照常脱敏。
import { englishObject, englishText, ownStrategyId, publicEnglish } from './public-en.js';

const PRIVATE_KEY = new RegExp([
  '^api_?key$',
  '^(?:access_|refresh_|owner_|invite_|auth_|bearer_|session_|api_)?token$',
  'secret',
  'password',
  'passphrase',
  '^private_key$',
  '^mnemonic$',
  '^seed(?:_phrase)?$',
  '^email$',
  '^uid$',
  '^account_id$',
  '^wallet_address$',
  '^address$',
  '^balances?$',
  '^balance_usd$',
  '^(?:cli_)?commands?$',
  '_path$',
  '^(?:path|home|directory|cwd)$',
  '^(?:stdout|stderr|raw|raw_response|receipt|credentials|env|environment|headers)$',
].join('|'), 'i');

const MAX_DEPTH = 30;

/** 内部提示词与模型原始输出的字段名(episode.context_text / judgment_raw,以及同类的 system/user 提示词字段)。 */
const PROMPT_KEY = /^(?:context_text|judgment_raw|system_text|user_text|system_prompt|user_prompt|prompt|prompt_text|raw_output|model_raw)$/;

const HIDDEN_ZH = { secret: '[已隐藏]', path: '[服务器路径已隐藏]', credential: '[凭证已隐藏]', address: '[地址已隐藏]' };
const HIDDEN_EN = { secret: '[hidden]', path: '[server path hidden]', credential: '[credential hidden]', address: '[address hidden]' };

export function redactPublicText(text: string): string {
  const h = publicEnglish() ? HIDDEN_EN : HIDDEN_ZH;
  return text
    .replace(/Bearer\s+\S+/gi, h.secret)
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\S*/g, h.secret)
    .replace(/\/(?:Users|home|root|opt|private|tmp|var|etc)\/[^\s"'<>)]+/g, h.path)
    .replace(/(?:api[_ -]?key|secret|password|passphrase|token)\s*[:=]\s*[^\s,;]+/gi, h.credential)
    .replace(/\b0x[0-9a-fA-F]{40}\b/g, h.address);
}

export function publicView(value: unknown, depth = 0): unknown {
  return project(value, depth, publicEnglish());
}

function project(value: unknown, depth: number, en: boolean, sid: string | null = null): unknown {
  if (depth > MAX_DEPTH) return null;
  if (typeof value === 'string') return redactPublicText(en ? englishText(value) : value);
  if (Array.isArray(value)) return value.map((item) => project(item, depth + 1, en, sid));
  if (value && typeof value === 'object') {
    // 研究策略 id 沿对象树往下传:详情里的 versions[]/report 这些内嵌对象按外层策略覆盖 strategy_ir
    const here = en ? ownStrategyId(value as Record<string, unknown>) ?? sid : sid;
    const source = en ? englishObject(value as Record<string, unknown>, here) : value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      if (PRIVATE_KEY.test(key)) continue;
      if (PROMPT_KEY.test(key) && typeof item === 'string') {
        // 模型实际收到的内部提示词 / 模型原始输出:访客一律不给原文(英文模式也不给译文),只留长度;字段本身置 null,前端按「没有」处理
        out[key] = null;
        out[`${key}_hidden`] = { hidden: true, length: item.length };
        continue;
      }
      out[key] = project(item, depth + 1, en, here);
    }
    return out;
  }
  return value;
}
