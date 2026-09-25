/**
 * 按次服务「策略研究报告 / Strategy Research Report」:两档,一个服务键 research_report。
 *
 *   quick(快速回测,缺省):买方描述一个想法 → 映射成 StrategyIR → 单资产全窗口回测(含手续费/滑点)+ 2 倍费率压力 + 按年/分段表现。
 *     确定性模板零模型;只有开了 nl_compile 且模板认不出时才花一次模型编译(见 quick-backtest.ts)。
 *   full(完整矩阵):≤3 资产 × ≤2 周期 × 策略族 × 方向的矩阵研究,训练/选择/留出三段,留出只看一次(见 matrix-report.ts)。
 *
 * 档位:JSON `tier` 优先;否则自由文本里「矩阵/完整/全面/full/matrix」且没有「快速/quick」→ full,其余 → quick。
 * 两档交付物都带 sha256 与 anchor {chain:'xlayer', status:'not_anchored'};第一行中英双语标题;只给分析与依据,不写收益保证。
 */
import { deliverable } from './render.js';
import { freeText, jsonParams } from './params.js';
import { matrixBody, runMatrix, validateMatrix, type MatrixReportParams } from './matrix-report.js';
import { quickLines, runQuickBacktest, validateQuick, type QuickBacktestDeps, type QuickBacktestParams } from './quick-backtest.js';
import { ServiceInputError, type PerCallJob, type PerCallService, type ServiceKey } from './types.js';

/** 服务键(types.ts ServiceKey 已含 research_report;旧 matrix_report 由主线程在交付后删除) */
export const RESEARCH_REPORT_KEY: ServiceKey = 'research_report';
export type ResearchTier = 'quick' | 'full';
export type ResearchReportParams = { tier: 'quick'; quick: QuickBacktestParams } | { tier: 'full'; full: MatrixReportParams };
export type ResearchReportDeps = QuickBacktestDeps;
/** 建议价位(USDT/次,主线程定):quick 成本 = 取数 + 两次单资产回放(秒级,零模型);full = 最多 300 变体矩阵 + 留出(分钟级,零模型) */
export const SUGGESTED_PRICE_USDT: Record<ResearchTier, string> = { quick: '2', full: '15' };

const TITLE: Record<ResearchTier, string> = {
  quick: '【策略研究报告·快速回测 / Strategy Research Report · Quick Backtest】 Trading Swarm',
  full: '【策略研究报告·完整矩阵 / Strategy Research Report · Full Matrix】 Trading Swarm',
};
const ANCHOR = { chain: 'xlayer', status: 'not_anchored' } as const;
const NATURE = '性质 / Nature: 历史回放,只给分析与依据,不构成投资建议,过去表现不代表未来 / Historical replay with evidence only; not investment advice; past performance does not indicate future results';

export function tierIn(job: PerCallJob): ResearchTier {
  const v = jsonParams(job)?.['tier'];
  if (v !== undefined && v !== null && v !== '') {
    const s = String(v).trim().toLowerCase();
    if (['quick', 'fast', '快速', '回测', 'backtest'].includes(s)) return 'quick';
    if (['full', 'matrix', '完整', '矩阵'].includes(s)) return 'full';
    throw new ServiceInputError('tier_invalid', 'tier 只能是 quick / full');
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
        const r = await runMatrix(job, params.full, deps), m = matrixBody(r.view, r);
        return deliverable(job, RESEARCH_REPORT_KEY, TITLE.full, m.summary, [...m.lines, NATURE], { tier: 'full', ...m.body, anchor: ANCHOR });
      }
      const q = params.quick, r = await runQuickBacktest(q, deps as ResearchReportDeps, job), { summary, lines } = quickLines(q, r);
      return deliverable(job, RESEARCH_REPORT_KEY, TITLE.quick, summary, [...lines, NATURE], {
        tier: 'quick', symbol: q.symbol, timeframe: q.timeframe, market: r.ir.order?.market ?? q.market, side: r.ir.order?.direction ?? q.side, days: q.days,
        request_text: q.text, ir_source: r.ir_source, strategy_ir: r.ir, strategy_ir_hash: r.ir_hash, compile: r.compile,
        window: r.window, data_source: r.data_source, fees: r.fees, engine_version: r.engine_version,
        metrics: r.full, stressed: r.stressed, segments: r.segments, yearly: r.yearly, exit_reasons: r.exit_reasons, warnings: r.warnings,
        anchor: ANCHOR,
        method: '单资产全窗口连续回放:已收盘 K 线判信号、下一根开盘成交,taker 手续费 + 滑点,每笔 100% 可用资金不加杠杆;持有基准同费率;另以 2 倍手续费重跑做压力 / full-window replay with fees and slippage, 2× fee stress',
      });
    },
  };
}

/** 缺省:只做确定性映射(认不出的描述在接单前拒单退款);接上 compile 后用 makeResearchReportService({ nl_compile: true }) */
export const researchReportService = makeResearchReportService();
