/**
 * 报告面板插槽:详情页与单独报告页都通过这里挂 WP-C 的 Horizon 式报告面板
 * (components/backtest-report/report-view.tsx 的 BacktestReportView / BacktestReportById)。
 * 集中在这一个文件里接,WP-C 的签名变了只改这里。
 */
import type { BacktestReport } from '@trading-swarm/contracts';
import { researchApi } from '@/api/client';
import { BacktestReportById, BacktestReportView, type BacktestReportHeaderConfig } from '@/components/backtest-report/report-view';
import { detailHash, reportHash } from './model';
import { go } from './use-strategy-actions';

/** 报告面板头部(WP-C header 约定:名称/描述/版本标签/Settings/Share/Automate) */
export type ReportHeader = BacktestReportHeaderConfig;

/**
 * 详情页里「按此区间重跑」出的新报告:后端按 ir_hash 自动挂到同一个策略 → 留在详情页看新报告;
 * 没挂上(IR 已改过等)→ 跳单独报告页,不让详情页 404。
 */
async function openRerun(strategyId: string, reportId: string): Promise<void> {
  const r = await researchApi.backtest(reportId).catch(() => null);
  go(r?.strategy_id === strategyId ? detailHash(strategyId, reportId) : reportHash(reportId));
}

export function ReportSlot({ report, header, strategyId }: { report: BacktestReport; header: ReportHeader; strategyId?: string }) {
  return <BacktestReportView key={report.id} report={report} header={header} onRerunDone={strategyId ? (id) => void openRerun(strategyId, id) : undefined} />;
}

export function ReportByIdSlot({ reportId, header }: { reportId: string; header?: ReportHeader }) {
  return <BacktestReportById reportId={reportId} header={header} />;
}
