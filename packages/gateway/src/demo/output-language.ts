// 公网评审版的输出语言:TG_PUBLIC_LANG=en 时,所有模型现写的内容(agent 对话、信息员市场总结、提案理由、判断 headline 与 reasons)
// 一律英文。在大脑的统一出口(runtime.brainFor 与 model-connections 的角色大脑包装)给系统提示追加一句硬性要求;
// 不设时原样返回,Jacky 本机的中文行为不变。
export const ENGLISH_ONLY = 'Always respond in English. Write every free-text field (answers, summaries, headlines, reasons, notes) in English, even if the instructions or data above are in Chinese. Keep JSON keys, enum values and tool names exactly as specified.';

export function withOutputLanguage(system: string): string {
  if (process.env['TG_PUBLIC_LANG'] !== 'en' || system.includes(ENGLISH_ONLY)) return system; // 两层包装只加一次
  return `${system}\n\n${ENGLISH_ONLY}`;
}

// 喂给模型的扫描/持仓清单里的布尔值:英文评审版给 yes/no,否则模型用英文回答时会照抄「watch_eligible=否」。
// 本机(未设 TG_PUBLIC_LANG=en)仍是 是/否,测试与提示词口径不变。
export const englishOutput = (): boolean => process.env['TG_PUBLIC_LANG'] === 'en';
export const yesWord = (): string => (englishOutput() ? 'yes' : '是');
export const noWord = (): string => (englishOutput() ? 'no' : '否');
/**
 * 清单布尔项的标签:英文评审版用英文键(回踩确认 → retest_confirmed),否则模型用英文回答时会照抄「回踩确认 no」。
 * flagLabel('回踩确认') 返回带分隔符的前缀:本机「回踩确认=」,英文「retest_confirmed=」;第二个参数是本机模式下的分隔符。
 */
export const FLAG_LABEL_EN: Record<string, string> = {
  回踩确认: 'retest_confirmed',
  失效确认: 'invalidation_confirmed',
  结构转弱: 'structure_weakened',
  论点趋势翻转: 'thesis_trend_flipped',
  压缩成立: 'compression_met',
  扩张成立: 'expansion_met',
  极值成立: 'extreme_met',
  震荡成立: 'ranging_met',
  偏离成立: 'deviation_met',
  共识: 'consensus',
  已跑掉: 'ran_away',
  量能枯竭: 'volume_dried_up',
  挤压: 'squeeze',
};
export function flagLabel(zh: string, zhSep = '='): string {
  return englishOutput() && FLAG_LABEL_EN[zh] ? `${FLAG_LABEL_EN[zh]}=` : `${zh}${zhSep}`;
}
// 通用词(共识/挤压)只在紧跟 = 时才换,专名标签出现就换
const GENERIC_FLAGS = new Set(['共识', '挤压']);
const FLAG_RE = new RegExp(Object.keys(FLAG_LABEL_EN).sort((a, b) => b.length - a.length).map((k) => (GENERIC_FLAGS.has(k) ? `${k}(?==)` : k)).join('|'), 'g');

/** 系统提示里引用清单值的地方(「watch_eligible=是」「回踩确认=是」「共识=否」)跟着切换,和清单口径一致。 */
export function flagWords(text: string): string {
  if (!englishOutput()) return text;
  return text.replace(FLAG_RE, (m) => FLAG_LABEL_EN[m] ?? m).replace(/=是/g, '=yes').replace(/=否/g, '=no');
}

// ---------------------------------------------------------------- 判断输出的语言兜底(只在英文评审版)

/** 判断里给人看的自由文本字段。 */
export const JUDGMENT_TEXT_FIELDS = ['headline', 'thesis', 'reasons', 'watch_conditions'] as const;
const CJK_TEXT = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/;

/** 英文评审版下,判断的哪些自由文本字段还含中文(本机模式恒为空)。 */
export function judgmentCjkFields(j: Partial<Record<(typeof JUDGMENT_TEXT_FIELDS)[number], unknown>> | null | undefined): string[] {
  if (!englishOutput() || !j) return [];
  return JUDGMENT_TEXT_FIELDS.filter((k) => {
    const v = j[k];
    return typeof v === 'string' ? CJK_TEXT.test(v) : Array.isArray(v) ? v.some((x) => typeof x === 'string' && CJK_TEXT.test(x)) : false;
  });
}

export function englishRewritePrompt(fields: string[], previous: string): string {
  return [
    `Your previous output contained Chinese text in: ${fields.join(', ')}.`,
    'Rewrite the same judgment in English only: keep exactly the same JSON structure, action, direction, confidence, prices, numbers, evidence citations ([E3]) and strategy_id; translate every free-text field (headline, thesis, reasons, watch_conditions, invalidation and any notes) into English. Output only the JSON object.',
    'Previous output:',
    previous.slice(0, 4000),
  ].join('\n');
}

export interface RewriteCall { text: string; input_tokens: number; output_tokens: number; latency_ms: number }
export interface EnglishRewriteOutcome<J> { judgment: J; call: RewriteCall | null; still_cjk: string[]; accepted: boolean }

/**
 * 判断含中文时,用同一个 brain 重写一次(最多一次)。重写结果必须能解析、动作与方向不变、且不再含中文才采用;
 * 否则保留原判断,把仍含中文的字段报给调用方(调用方记 warn,出口句式层再兜底)。allowed=false(比如今日判断额度已满)时不调模型。
 */
export async function rewriteJudgmentInEnglish<J extends { action: string; direction: string | null }>(opts: {
  judgment: J;
  previous: string;
  allowed: boolean;
  complete: (userSuffix: string) => Promise<RewriteCall>;
  parse: (text: string) => J | null;
}): Promise<EnglishRewriteOutcome<J>> {
  const fields = judgmentCjkFields(opts.judgment as never);
  if (!fields.length) return { judgment: opts.judgment, call: null, still_cjk: [], accepted: false };
  if (!opts.allowed) return { judgment: opts.judgment, call: null, still_cjk: fields, accepted: false };
  const call = await opts.complete(englishRewritePrompt(fields, opts.previous));
  let parsed: J | null = null;
  try { parsed = opts.parse(call.text); } catch { parsed = null; }
  if (parsed && parsed.action === opts.judgment.action && parsed.direction === opts.judgment.direction && !judgmentCjkFields(parsed as never).length) {
    return { judgment: parsed, call, still_cjk: [], accepted: true };
  }
  return { judgment: opts.judgment, call, still_cjk: fields, accepted: false };
}
