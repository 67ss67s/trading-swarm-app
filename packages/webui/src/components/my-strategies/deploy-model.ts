/**
 * 「我的策略 → 部署」页签与列表「实盘」胶囊的纯函数(docs/research/strategy-merge-plan-2026-09-23.md)。
 *
 * 三轴(apply-spec §2):研究成熟度 = ResearchStrategy.status;部署模式 = 实盘注册表(GET /api/strategies)里
 * 对应策略的状态映射成 off / shadow_only / paper / live;发布 = published_listing_id。
 * 研究策略 ↔ 实盘策略的对应只认 lab_strategy_id(导入的内置策略 = 内置 id;以后 apply 下发写回的 = StrategySpec.id,
 * 可能带 @version,取 @ 前)。这里只读,不写实盘注册表。
 */
import type { ResearchStrategy } from '@trade-gate/contracts';
import type { AllocatorCandidate, AllocatorView, ShadowStats, StrategyView } from '@/api/types';
import { tmap } from '@/lib/i18n';

export type DeployMode = 'off' | 'shadow_only' | 'paper' | 'live';

export const DEPLOY_MODE_LABEL: Record<DeployMode, string> = tmap({ off: '关', shadow_only: '影子', paper: '模拟', live: '实盘(限额)' });

/** 实盘旧词表 → 部署模式(apply-spec §2:shadow→shadow_only、live_capped→live+cap、retired→archived 即关) */
export function deployModeOf(status: string | null | undefined): DeployMode {
  switch (status) {
    case 'shadow':
      return 'shadow_only';
    case 'paper':
      return 'paper';
    case 'live_capped':
      return 'live';
    default:
      return 'off';
  }
}

/** lab_strategy_id 可能是 `id` 或 `id@version`,对注册表只认 id */
export function labIdOf(s: Pick<ResearchStrategy, 'lab_strategy_id'>): string | null {
  const raw = s.lab_strategy_id?.trim();
  return raw ? raw.split('@')[0]! || null : null;
}

export interface Deployment {
  lab_id: string;
  /** 注册表里有没有这条 */
  found: boolean;
  spec: StrategyView | null;
  mode: DeployMode;
  /** 头版本还没到 paper,但注册表说存在 ≥paper 的旧版本(实盘按那个版本跑) */
  older_version_runs: boolean;
  /** 在 workflow.active_strategies 票池里(实盘判断真的会用它) */
  in_pool: boolean;
  candidate: AllocatorCandidate | null;
  shadow: ShadowStats | null;
  live_trades: number | null;
  live_expectancy_r: number | null;
  live_win_rate: number | null;
}

/**
 * versions:可选,GET /api/strategies/:id 的版本列表。实盘 resolve() 取「≥ paper 的最高版本」,头版本还在回测时
 * 实际跑的是更早的 paper 版本;列表页只有头版本,用 activatable 近似,详情页传 versions 精确判断。
 */
export function deploymentOf(s: Pick<ResearchStrategy, 'lab_strategy_id'>, registry: readonly StrategyView[] | null | undefined, allocator?: AllocatorView | null, versions?: readonly { version: number; status: string }[] | null): Deployment | null {
  const lab_id = labIdOf(s);
  if (!lab_id) return null;
  const spec = registry?.find((x) => x.id === lab_id) ?? null;
  const candidate = allocator?.candidates.find((c) => c.id === lab_id) ?? null;
  const headMode = deployModeOf(spec?.status);
  const runnable = versions?.filter((v) => v.status === 'paper' || v.status === 'live_capped').sort((a, b) => b.version - a.version)[0] ?? null;
  const older = !!spec && (headMode === 'off' || headMode === 'shadow_only') && (runnable !== null || spec.activatable === true);
  const olderMode: DeployMode = runnable ? deployModeOf(runnable.status) : 'paper';
  const in_pool = !!spec?.active || !!candidate?.in_pool || !!allocator?.active.includes(lab_id);
  return {
    lab_id,
    found: !!spec,
    spec,
    mode: older ? olderMode : headMode,
    older_version_runs: older,
    in_pool,
    candidate,
    shadow: spec?.lab_stats?.shadow ?? null,
    live_trades: spec ? spec.eval_stats.trades : null,
    live_expectancy_r: spec?.eval_stats.expectancy_r ?? null,
    live_win_rate: spec?.eval_stats.win_rate ?? null,
  };
}

/** 列表「实盘」胶囊的口径:在票池里,或部署模式是模拟/实盘(影子不算) */
export function isLiveDeployed(d: Deployment | null): boolean {
  return !!d && d.found && (d.in_pool || d.mode === 'paper' || d.mode === 'live');
}

export function liveStrategyIds(strategies: readonly ResearchStrategy[], registry: readonly StrategyView[] | null | undefined, allocator?: AllocatorView | null): Set<string> {
  const out = new Set<string>();
  for (const s of strategies) if (isLiveDeployed(deploymentOf(s, registry, allocator))) out.add(s.id);
  return out;
}

/** 深链:实盘部署台(#strategies,原策略库)。09-25 起 #strategies 已重定向到 #my-strategies、界面不再引用,留着给旧调用方 */
export function deployDeskHash(labId: string | null): string {
  return labId ? `strategies?id=${encodeURIComponent(labId)}` : 'strategies';
}
