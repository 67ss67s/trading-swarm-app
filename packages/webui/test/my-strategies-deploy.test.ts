// 「我的策略 → 部署」页签与「实盘」胶囊口径(docs/research/strategy-merge-plan-2026-09-23.md,§9.47):
// 部署模式映射、票池判断、角色切片渲染(执行者标签)、规则未编码草稿、hash 页签。node 环境 renderToStaticMarkup。
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BindingRoleSlice, ResearchStrategy } from '@trade-gate/contracts';
import type { AllocatorView, StrategyView } from '@/api/types';

vi.mock('@/api/client', () => ({ api: {}, researchApi: {} }));

import { deployDeskHash, deployModeOf, deploymentOf, isLiveDeployed, labIdOf, liveStrategyIds } from '../src/components/my-strategies/deploy-model';
import { BindingPreview, DeployStatusCard, RoleSliceCard } from '../src/components/my-strategies/deploy-panel';
import { DetailTabs } from '../src/components/my-strategies/strategy-detail';
import { detailHash, parseRoute } from '../src/components/my-strategies/model';

const noop = () => {};
const spec = (over: Partial<StrategyView> = {}): StrategyView =>
  ({ id: 'breakout_retest', name: '突破-回踩', version: 2, status: 'backtest', status_label: '回测中', active: false, activatable: false, eval_stats: { backtests: 0, trades: 0, win_rate: null, expectancy_r: null }, lab_stats: null, ...over }) as unknown as StrategyView;
const rs = (over: Partial<ResearchStrategy> = {}): ResearchStrategy =>
  ({ id: 'rs_1', name: 'x', description: '', status: 'backtested', symbol: 'BTCUSDT', timeframe: '1h', watchlist: false, alerts: false, current_version: 1, created_at: 0, updated_at: 0, origin: { session_id: null, inquiry_id: null, source: 'import' }, summary: null, lab_strategy_id: 'breakout_retest', published_listing_id: null, ...over }) as ResearchStrategy;
const alloc = (over: Partial<AllocatorView> = {}): AllocatorView => ({ mode: 'manual', max: 4, active: [], regime: null, decision: null, candidates: [], last_run_at: null, last_change_at: null, last_reason: null, previous: null, events: [], ...over }) as AllocatorView;

describe('部署模式(三轴之一,只读)', () => {
  it('实盘旧词表映射', () => {
    expect(['draft', 'backtest', 'shadow', 'paper', 'live_capped', 'retired', undefined].map(deployModeOf)).toEqual(['off', 'off', 'shadow_only', 'paper', 'live', 'off', 'off']);
    expect(labIdOf({ lab_strategy_id: 'breakout_retest@2' })).toBe('breakout_retest');
    expect(labIdOf({ lab_strategy_id: null })).toBeNull();
    expect(deployDeskHash('a b')).toBe('strategies?id=a%20b');
  });
  it('头版本在回测但有 ≥paper 旧版本、且在票池 → 算「实盘」;影子不算;没关联不算', () => {
    const d = deploymentOf(rs(), [spec({ active: true, activatable: true })], alloc({ active: ['breakout_retest'] }))!;
    expect(d).toMatchObject({ found: true, mode: 'paper', older_version_runs: true, in_pool: true });
    expect(isLiveDeployed(d)).toBe(true);
    expect(isLiveDeployed(deploymentOf(rs(), [spec({ status: 'shadow' as never })], alloc()))).toBe(false);
    expect(isLiveDeployed(deploymentOf(rs(), [spec({ status: 'live_capped' as never })], alloc()))).toBe(true);
    expect(deploymentOf(rs({ lab_strategy_id: null }), [spec()], alloc())).toBeNull();
    // 详情页带版本列表:头版本 v2 回测中、activatable=false,但 v1 是 paper → 实盘跑 v1,模式=模拟
    const withVersions = deploymentOf(rs(), [spec({ active: true, activatable: false })], alloc(), [{ version: 2, status: 'backtest' }, { version: 1, status: 'paper' }])!;
    expect(withVersions).toMatchObject({ mode: 'paper', older_version_runs: true });
    expect(deploymentOf(rs(), [spec({ activatable: false })], alloc(), [{ version: 2, status: 'backtest' }])!.mode).toBe('off');
    // 研究侧 status=live 只是状态记录,不算实盘
    const ids = liveStrategyIds([rs({ id: 'a', status: 'live', lab_strategy_id: null }), rs({ id: 'b' }), rs({ id: 'c', lab_strategy_id: 'nope' })], [spec({ active: true })], alloc());
    expect([...ids]).toEqual(['b']);
  });
});

describe('部署页签渲染', () => {
  it('角色切片:每条规则带执行者标签,judge 片高亮模型', () => {
    const slice: BindingRoleSlice = { role: 'judge', title: '判断 agent:只做入场过滤', summary: 's', rules: [{ text: '只答 follow/skip', executor: 'model', ref: null, primitive: null }, { text: '价格字段忽略', executor: 'code', ref: null, primitive: null }] };
    const html = renderToStaticMarkup(createElement(RoleSliceCard, { slice }));
    expect(html).toContain('data-role="judge"');
    expect((html.match(/data-executor="model"/g) ?? []).length).toBe(2); // 标题 + 一条规则
    expect((html.match(/data-executor="code"/g) ?? []).length).toBe(1);
  });
  it('部署状态:未下发 / 已下发(导入策略提示实盘仍跑旧文本)', () => {
    // 09-25:卡片按钮改成「设为 agent 当前策略」(SetAgentStrategyButton 用 react-query),渲染要包一层 QueryClientProvider
    const withQc = (el: ReturnType<typeof createElement>) => createElement(QueryClientProvider, { client: new QueryClient() }, el);
    const none = renderToStaticMarkup(withQc(createElement(DeployStatusCard, { strategy: rs({ lab_strategy_id: null, origin: { session_id: null, inquiry_id: null, source: 'research_loop' } }), deployment: null })));
    expect(none).toContain('data-deployed="no"');
    expect(none).toContain('还没有下发到实盘');
    const d = deploymentOf(rs(), [spec({ active: true, activatable: true })], alloc())!;
    const yes = renderToStaticMarkup(withQc(createElement(DeployStatusCard, { strategy: rs(), deployment: d })));
    expect(yes).toContain('data-deployed="yes"');
    expect(yes).toContain('data-mode="paper"');
    expect(yes).toContain('在票池');
    expect(yes).toContain('旧策略库里那条文本规则版本已经不再开仓');
    expect(yes).toContain('设为 agent 当前策略');
    expect(yes).not.toContain('去实盘部署台');
  });
  it('规则未编码的草稿:没有绑定,只列缺什么', () => {
    const html = renderToStaticMarkup(createElement(BindingPreview, { binding: null, unmapped: [{ code: 'funding_primitive_missing', path: 'signal', severity: 'block', message: '缺资金费率极值原语', source: 'import' }] }));
    expect(html).toContain('规则未编码');
    expect(html).toContain('data-severity="block"');
    expect(html).toContain('缺资金费率极值原语');
  });
  it('详情页签与 hash:tab=deploy 往返', () => {
    expect(parseRoute('#' + detailHash('rs_1', null, 'deploy'))).toEqual({ view: 'detail', id: 'rs_1', report: null, tab: 'deploy' });
    expect(parseRoute('#' + detailHash('rs_1', 'bt_1'))).toEqual({ view: 'detail', id: 'rs_1', report: 'bt_1' });
    const html = renderToStaticMarkup(createElement(DetailTabs, { value: 'deploy', onChange: noop }));
    expect(html).toMatch(/aria-selected="true" data-tab="deploy"/);
  });
});
