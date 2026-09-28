/**
 * 按次服务「策略研究报告 / Strategy Research Report」:两档,一个服务键 research_report。
 *
 *   quick(快速回测,缺省):买方描述一个想法 → 映射成 StrategyIR → 单资产全窗口回测(含手续费/滑点)+ 2 倍费率压力 + 按年/分段表现。
 *     确定性模板零模型;只有开了 nl_compile 且模板认不出时才花一次模型编译(见 quick-backtest.ts)。
 *   full(完整矩阵):≤3 资产 × ≤2 周期 × 策略族 × 方向的矩阵研究,训练/选择/留出三段,留出只看一次(见 matrix-report.ts)。
 *
 * 档位:JSON `tier` 优先;否则自由文本里「矩阵/完整/全面/full/matrix」且没有「快速/quick」→ full,其余 → quick。
 * 两档交付物都带 sha256 与 anchor {chain:'xlayer', status:'not_anchored'};正文英文(第一行英文标题);只给分析与依据,不写收益保证。
 */
import { deliverable } from './render.js';
import { freeText, jsonParams } from './params.js';
import { matrixBody, notRunBody, runMatrix, validateMatrix, type MatrixReportParams } from './matrix-report.js';
import { englishOnly, quickLines, runQuickBacktest, SUPPORTED_RULES, validateQuick, type QuickBacktestDeps, type QuickBacktestParams } from './quick-backtest.js';
import { createHash } from 'node:crypto';

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
import { ServiceInputError, type PerCallJob, type PerCallService, type ServiceKey } from './types.js';

/** 服务键(types.ts ServiceKey 已含 research_report;旧 matrix_report 由主线程在交付后删除) */
export const RESEARCH_REPORT_KEY: ServiceKey = 'research_report';
export type ResearchTier = 'quick' | 'full';
export type ResearchReportParams = { tier: 'quick'; quick: QuickBacktestParams } | { tier: 'full'; full: MatrixReportParams };
export type ResearchReportDeps = QuickBacktestDeps;
/** 建议价位(USDT/次,主线程定):quick 成本 = 取数 + 两次单资产回放(秒级,零模型);full = 最多 300 变体矩阵 + 留出(分钟级,零模型) */
export const SUGGESTED_PRICE_USDT: Record<ResearchTier, string> = { quick: '2', full: '15' };

const TITLE: Record<ResearchTier, string> = {
  quick: '[Strategy Research Report · Quick Backtest] Trading Swarm',
  full: '[Strategy Research Report · Full Matrix] Trading Swarm',
};
const ANCHOR = { chain: 'xlayer', status: 'not_anchored' } as const;
/** 与 render 的 DISCLAIMER(不构成投资建议)不重复:这里只补「历史回放 / 过去不代表未来」 */
const NATURE = 'Nature: historical replay, analysis and evidence only; past performance does not indicate future results';

export function tierIn(job: PerCallJob): ResearchTier {
  const v = jsonParams(job)?.['tier'];
  if (v !== undefined && v !== null && v !== '') {
    const s = String(v).trim().toLowerCase();
    if (['quick', 'fast', '快速', '回测', 'backtest'].includes(s)) return 'quick';
    if (['full', 'matrix', '完整', '矩阵'].includes(s)) return 'full';
    throw new ServiceInputError('tier_invalid', 'tier must be quick or full');
  }
  const text = freeText(job);
  return /矩阵|完整|全面|\bfull\b|\bmatrix\b/i.test(text) && !/快速|\bquick\b/i.test(text) ? 'full' : 'quick';
}

export function makeResearchReportService(opts: { nl_compile?: boolean } = {}): PerCallService<ResearchReportParams> {
  return {
    key: RESEARCH_REPORT_KEY,
    validate(job) {
      const tier = tierIn(job);
      return tier === 'full' ? { tier, full: validateMatrix(job) } : { tier, quick: validateQuick(job, opts) };
    },
    async handle(job, params, deps) {
      if (params.tier === 'full') {
        const r = await runMatrix(job, params.full, deps), m = r.view ? matrixBody(r.view, r) : notRunBody(params.full, r.dropped);
        return deliverable(job, RESEARCH_REPORT_KEY, TITLE.full, m.summary, [...m.lines, NATURE], englishOnly({ tier: 'full', ...m.body, anchor: ANCHOR }));
      }
      const q = params.quick, r = await runQuickBacktest(q, deps as ResearchReportDeps, job), { summary, lines } = quickLines(q, r);
      // 买方原话含中文时不回显(交付 JSON 一律英文),只给原文哈希供核对
      const request = CJK.test(q.text) ? { request_text: null, request_text_sha256: createHash('sha256').update(q.text).digest('hex'), request_text_note: 'Original request text is not echoed because it is not in English; sha256 of the original text is given for verification' } : { request_text: q.text };
      const run = {
        window: r.window, data_source: r.data_source, initial_cash: r.initial_cash, fees: r.fees, engine_version: r.engine_version,
        metrics: r.full, stressed: r.stressed, segments: r.segments, yearly: r.yearly, exit_reasons: r.exit_reasons, warnings: r.warnings,
      };
      const common = { tier: 'quick', symbol: q.symbol, timeframe: q.timeframe, market: r.ir.order?.market ?? q.market, side: r.ir.order?.direction ?? q.side, days: q.days, ...request };
      const body = r.outcome === 'not_mapped'
        ? {
          ...common, outcome: 'not_mapped', tested_as_described: false,
          requested: { ir_source: 'model', strategy_ir: r.requested?.ir ?? null, strategy_ir_hash: r.requested?.ir_hash ?? null, compile: r.requested?.compile ?? null, reasons: r.requested?.reasons ?? [] },
          reference: { note: 'Closest supported template on the same asset, timeframe and window; NOT the requested strategy', family: r.reference_family ?? null, ir_source: 'template', strategy_ir: r.ir, strategy_ir_hash: r.ir_hash, ...run },
          supported_rules: SUPPORTED_RULES,
        }
        : { ...common, outcome: 'tested', tested_as_described: !(r.compile?.unmapped.length), ir_source: r.ir_source, strategy_ir: r.ir, strategy_ir_hash: r.ir_hash, compile: r.compile, ...run };
      return deliverable(job, RESEARCH_REPORT_KEY, TITLE.quick, summary, [...lines, NATURE], englishOnly({
        ...body, anchor: ANCHOR,
        method: 'Single-asset continuous full-window replay: signals on closed bars, fills at the next bar open, taker fees + slippage, 100% of available capital per trade without leverage; buy-and-hold benchmark at the same fee rate; a second run at 2× fees as a stress test',
      }));
    },
  };
}

/** 缺省:只做确定性映射(认不出的描述在接单前拒单退款);接上 compile 后用 makeResearchReportService({ nl_compile: true }) */
export const researchReportService = makeResearchReportService();
