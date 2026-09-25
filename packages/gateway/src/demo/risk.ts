/**
 * Risk Sentinel(CODE 角色):账户级不变量 → RiskAlert。全部纯函数,零模型;告警对象按指纹去重,
 * 条件实质变化指纹才变(notebook §9「避免每 10 秒重复轰炸」)。
 *
 * 动作层级:info 只记录;warn 进收件箱;high 停止新增风险(gates 多一道「风控哨兵」闸);
 * critical 同 high + 活动流 danger。这里**不**自动平仓、不自动 halt——代码可以收紧,不能替人做不可逆动作。
 * 设计:docs/design/team-roles-2026-09-06.md §4。
 */
import { createHash } from 'node:crypto';
import type { PortfolioCapacity, PortfolioPolicy, PortfolioSnapshot } from './portfolio.js';
import type { StrategyThread, TransportHealth, Workflow } from './types.js';

export type RiskSeverity = 'info' | 'warn' | 'high' | 'critical';
export type RiskKind =
  | 'gross_exposure'
  | 'net_exposure'
  | 'cluster_concentration'
  | 'stop_budget'
  | 'protection_missing'
  | 'transport_unstable'
  | 'daily_loss'
  | 'account_stale'
  | 'account_incomplete'
  | 'market_stale'
  | 'execution_unknown'
  | 'execution_disconnected'
  | 'channel_cannot_protect'
  | 'protection_never_verified'
  | 'protection_stale'
  | 'capacity_short'
  | 'thread_attention'
  | 'halted';

/** v3.11:阻断类告警必须带一个用户在界面上就能点的动作(不能要求改 env / 重启)。 */
export interface RiskAction {
  kind: 'verify_protection' | 'confirm_recovery' | 'open_settings' | 'switch_backend';
  label: string;
  method: 'POST' | 'GET';
  path: string;
  body?: Record<string, unknown>;
  note?: string;
}

/**
 * 按 kind(+ scope)决定处置按钮(落库不存 action,读出时用它补;两边一个来源)。
 * 09-12:保护腿凭证按**通道 × 交易对**发,scope 是交易对 → 按钮直接验证那个币。
 */
export function riskActionFor(kind: RiskKind, scope?: string, refs?: readonly string[]): RiskAction | undefined {
  // 09-20:never_verified 合成一条按通道的(scope channel:xxx),币列表持久化在 refs 里,重算按钮时从这儿取
  if (kind === 'protection_never_verified' && scope?.startsWith('channel:')) {
    const symbols = (refs ?? []).filter((r) => /^[A-Z0-9]+USDT?$/i.test(r)).map((r) => r.toUpperCase());
    return {
      kind: 'verify_protection', method: 'POST', path: '/api/execution/verify-protection',
      label: symbols.length > 1 ? `用最小仓验证止损(${symbols.length} 个币,逐个跑)` : '用最小仓验证止损',
      body: symbols.length ? { confirm: true, symbols } : { confirm: true },
      note: '真钱最小仓,约 5 USDT 名义,几分钱手续费,每个币约 2 分钟;通过后这些币才允许开新仓',
    };
  }
  const verify = (label: string, note: string): RiskAction => ({
    kind: 'verify_protection',
    label,
    method: 'POST',
    path: '/api/execution/verify-protection',
    body: scope && /^[A-Z0-9]+USDT?$/i.test(scope) ? { confirm: true, symbol: scope.toUpperCase() } : { confirm: true },
    note,
  });
  if (kind === 'channel_cannot_protect') return verify('用最小仓验证止损', '真钱最小仓,约 5 USDT 名义,几分钱手续费,约 2 分钟');
  if (kind === 'protection_never_verified') return verify('用最小仓验证止损', '真钱最小仓,约 5 USDT 名义,几分钱手续费,约 2 分钟;通过后这个币才允许开新仓');
  if (kind === 'protection_stale') return verify('重新验证止损', '凭证过期或上次真挂止损失败;巡检每天也会自动重跑一次,现在点可以立刻续期');
  return undefined;
}

export interface RiskAlert {
  kind: RiskKind;
  /** 用户可点的处置动作;没有 = 只能看 */
  action?: RiskAction;
  severity: RiskSeverity;
  /** 指纹:kind + scope,数值不参与身份。同指纹 = 同一条告警的持续。 */
  fingerprint: string;
  scope: string;
  title: string;
  detail: string;
  value: number | null;
  threshold: number | null;
  refs: string[];
  /** 自动动作:none | block_new_risk */
  auto_action: 'none' | 'block_new_risk';
}

export interface RiskInputs {
  snapshot: PortfolioSnapshot | null;
  capacity?: PortfolioCapacity | null;
  policy: PortfolioPolicy;
  workflow: Workflow;
  threads: StrategyThread[];
  daily_loss_pct: number;
  halted: boolean;
  execution: { status: string; detail: string; checked_at: number | null };
  /** 每个 watchlist 币最新行情的 as_of;缺 = 没拉到 */
  market_as_of: Record<string, number | null>;
  unknown_intents: number;
  /**
   * 09-12(§9.31):当前通道的保护腿凭证三态汇总,按交易对分组。
   * `never_verified` 的币被提交前重闸按币阻断(不是整条通道),所以这条 high 告警**不** block_new_risk。
   */
  protection?: {
    channel: string;
    ttl_days: number;
    /** 该通道 × 这些交易对从没验过 → 阻断这些币的新开仓 */
    never_verified: string[];
    /** 验过但过期 → warn,巡检自动重跑金丝雀 */
    expired: string[];
    /** 最近一次线上真挂止损失败 → warn,同上;value 是失败原因 */
    probe_failed: { symbol: string; error: string | null }[];
    /** 自动重验这轮没跑的原因(暂停 / 没资金 / 节流),给用户解释为什么还没自动恢复 */
    auto_note: string | null;
  } | null;
  /** 09-07:执行通道传输健康(null = 后端不统计) */
  transport?: TransportHealth | null;
  /** 09-08:账户快照现在有多老(now - account.as_of)。用来区分「真过期」和「刚好卡在通道节奏上」。 */
  account_age_ms?: number;
  /** 09-08:这条通道允许的账户陈旧上界(policy 与 backend.accountStalenessMs 取大);缺省用 policy。 */
  account_max_age_ms?: number;
  now: number;
}

/**
 * 09-08:两条告警的分级门槛。
 * agent_mcp 每次账户读要起一次 CLI(实测 13–40 s)并缓存 5 分钟,账户 as_of 天然就是几百秒;
 * 略微越线是通道节奏,不是事故,报 warn 就够(warn 不 block_new_risk、不 latch 等人确认),
 * 超过上界一倍才是真的读不到账户 → high。
 */
const STALE_HIGH_FACTOR = 2;
/**
 * 止损/止盈成交的那一瞬间,交易所已经没有条件单、也没有持仓,而本地快照最老可能是几分钟前的:
 * 用旧快照判「有持仓、没止损」必然误报(09-08 00:00 MU 那条 high 就是这么来的,2 分钟后才认出仓位已平)。
 * 快照比这个新才允许直接报 high;否则先报 warn,并由 runtime 强制刷新账户后复判。
 */
export const PROTECTION_FRESH_MS = 90_000;

/** 传输不稳定的判定:窗口内 ≥2 次且占比 ≥20%,或 ≥3 次。任何网络(代理、运营商、交易所抖动)都可能触发,与用户环境无关。 */
export function transportUnstable(t: TransportHealth | null | undefined): boolean {
  if (!t || t.transport_errors <= 0) return false;
  return t.transport_errors >= 3 || (t.transport_errors >= 2 && t.runs > 0 && t.transport_errors / t.runs >= 0.2);
}

export function riskFingerprint(kind: string, scope: string): string {
  return createHash('sha256').update(JSON.stringify([kind, scope])).digest('hex').slice(0, 16);
}
/** 值分档:比率按 0.1 一档,百分比按 0.5 一档——小抖动不换指纹。 */
const bucketRatio = (v: number): string => (Math.floor(v * 10) / 10).toFixed(1);
const bucketPct = (v: number): string => (Math.floor(v * 2) / 2).toFixed(1);

export function evaluateRisk(inp: RiskInputs): RiskAlert[] {
  const out: RiskAlert[] = [];
  const p = inp.policy;
  const s = inp.snapshot;
  const push = (a: Omit<RiskAlert, 'fingerprint' | 'auto_action'> & { bucket: string | number; auto_action?: RiskAlert['auto_action'] }): void => {
    const { bucket, auto_action, ...rest } = a;
    out.push({ ...rest, fingerprint: riskFingerprint(rest.kind, rest.scope), auto_action: auto_action ?? (rest.severity === 'high' || rest.severity === 'critical' ? 'block_new_risk' : 'none') });
  };

  if (inp.halted) push({ kind: 'halted', severity: 'critical', scope: 'system', title: '紧急停止生效中', detail: '只允许 NO_TRADE;解除需要人工 confirm=RESUME', value: null, threshold: null, refs: [], bucket: 1 });

  const dl = inp.daily_loss_pct;
  const dlStop = Number(inp.workflow.daily_loss_stop_pct);
  // 权益读不到(快照 incomplete / ≤ 0)时「日亏」没有意义,只报质量告警;否则一次 mark 缺失就会造出「日亏 100%」的 critical 并 latch 住。
  const equityKnown = s !== null && s.quality !== 'incomplete' && s.equity > 0;
  if (!equityKnown) {
    /* skip daily loss */
  } else if (dl >= dlStop) push({ kind: 'daily_loss', severity: 'critical', scope: 'account', title: `日亏 ${dl.toFixed(2)}% 触及日亏停 ${dlStop}%`, detail: '今日不再开新仓(openingBlockers 已挡);持仓复查照常', value: dl, threshold: dlStop, refs: [], bucket: bucketPct(dl) });
  else if (dl >= dlStop * 0.6) push({ kind: 'daily_loss', severity: 'warn', scope: 'account', title: `日亏 ${dl.toFixed(2)}%,已到日亏停的 ${Math.round((dl / dlStop) * 100)}%`, detail: `日亏停线 ${dlStop}%`, value: dl, threshold: dlStop, refs: [], bucket: bucketPct(dl) });

  if (!s) push({ kind: 'account_incomplete', severity: 'warn', scope: 'account', title: '还没有账户快照', detail: '账户轮询尚未成功过一次', value: null, threshold: null, refs: [], bucket: 0 });
  else {
    if (s.quality === 'incomplete') push({ kind: 'account_incomplete', severity: 'high', scope: 'account', title: '账户快照不完整', detail: s.quality_note ?? '', value: null, threshold: null, refs: [s.snapshot_id], bucket: s.quality_note ?? '' });
    else if (s.quality === 'stale') {
      const age = inp.now - s.oldest_component_at;
      const limit = Math.max(p.max_component_age_ms, inp.account_max_age_ms ?? 0);
      const severe = age > limit * STALE_HIGH_FACTOR;
      push({
        kind: 'account_stale',
        severity: severe ? 'high' : 'warn',
        scope: 'account',
        title: `账户/行情组件过期 ${Math.round(age / 1000)} 秒`,
        detail: severe
          ? `超过本通道允许的 ${Math.round(limit / 1000)} 秒一倍以上:账户大概率读不到了,先看执行页的通道状态`
          : `新开仓要求组件 ≤ ${Math.round(limit / 1000)} 秒(本通道每次账户读要起一次 CLI,天然就有几百秒延迟);下一次账户轮询回来就会自动恢复`,
        value: age,
        threshold: limit,
        refs: [s.snapshot_id],
        bucket: Math.floor(age / 60_000),
      });
    }
    else if (s.quality === 'inconsistent') push({ kind: 'account_stale', severity: 'warn', scope: 'account', title: '账户与行情组件时间不一致(跨度 > 15 秒)', detail: '', value: null, threshold: 15_000, refs: [s.snapshot_id], bucket: 'inconsistent' });

    // 快照质量不 ok(权益 ≤ 0 / 缺行情 / 过期)时比率是 Infinity 或不可信:只报质量告警,不拿比率再开一串「敞口 Infinity×」。
    if (s.quality !== 'ok') return finish();
    const g = s.projected.gross_ratio;
    if (g > p.max_gross_ratio) push({ kind: 'gross_exposure', severity: 'high', scope: 'account', title: `总敞口 ${g.toFixed(2)}× 权益超上限 ${p.max_gross_ratio}×`, detail: '含挂单与待批 intent 的预留', value: g, threshold: p.max_gross_ratio, refs: [s.snapshot_id], bucket: bucketRatio(g) });
    else if (g > p.max_gross_ratio * 0.8) push({ kind: 'gross_exposure', severity: 'warn', scope: 'account', title: `总敞口 ${g.toFixed(2)}× 权益,接近上限 ${p.max_gross_ratio}×`, detail: '', value: g, threshold: p.max_gross_ratio, refs: [s.snapshot_id], bucket: bucketRatio(g) });
    const worst = Math.max(Math.abs(s.worst_net_ratio.low), Math.abs(s.worst_net_ratio.high));
    if (worst > p.max_net_ratio) push({ kind: 'net_exposure', severity: 'high', scope: 'account', title: `最坏净敞口 ${worst.toFixed(2)}× 权益超上限 ${p.max_net_ratio}×`, detail: `区间 [${s.worst_net_ratio.low.toFixed(2)}, ${s.worst_net_ratio.high.toFixed(2)}]`, value: worst, threshold: p.max_net_ratio, refs: [s.snapshot_id], bucket: bucketRatio(worst) });
    for (const [cluster, ge] of Object.entries(s.by_cluster)) {
      if (ge.gross_ratio > p.max_cluster_ratio) push({ kind: 'cluster_concentration', severity: 'high', scope: cluster, title: `风险簇 ${cluster} 敞口 ${ge.gross_ratio.toFixed(2)}× 权益超上限 ${p.max_cluster_ratio}×`, detail: `多 ${ge.long.toFixed(0)} / 空 ${ge.short.toFixed(0)} USDT`, value: ge.gross_ratio, threshold: p.max_cluster_ratio, refs: [s.snapshot_id], bucket: bucketRatio(ge.gross_ratio) });
      else if (ge.gross_ratio > p.max_cluster_ratio * 0.8) push({ kind: 'cluster_concentration', severity: 'warn', scope: cluster, title: `风险簇 ${cluster} 敞口 ${ge.gross_ratio.toFixed(2)}× 权益,接近上限`, detail: '', value: ge.gross_ratio, threshold: p.max_cluster_ratio, refs: [s.snapshot_id], bucket: bucketRatio(ge.gross_ratio) });
    }
    if (s.stop_budget_ratio > p.max_stop_budget_ratio) push({ kind: 'stop_budget', severity: 'high', scope: 'account', title: `聚合止损预算 ${(s.stop_budget_ratio * 100).toFixed(2)}% 权益超上限 ${(p.max_stop_budget_ratio * 100).toFixed(2)}%`, detail: '所有持仓同时打止损的亏损', value: s.stop_budget_ratio, threshold: p.max_stop_budget_ratio, refs: [s.snapshot_id], bucket: bucketPct(s.stop_budget_ratio * 100) });
    // 快照够新才敢说「裸奔」:止损刚成交的那一瞬,旧快照里持仓还在、条件单已经没了,长得和真裸奔一模一样。
    const acctAge = inp.account_age_ms ?? 0;
    const fresh = acctAge <= PROTECTION_FRESH_MS;
    for (const symbol of s.unprotected_symbols)
      push({
        kind: 'protection_missing',
        severity: fresh ? 'high' : 'warn',
        scope: symbol,
        title: `${symbol} 持仓缺止损保护`,
        detail: fresh ? 'runtime 会重试挂保护腿' : `账户快照已经是 ${Math.round(acctAge / 1000)} 秒前的:止损可能刚刚触发、也可能刚挂上,正在强制刷新账户后复判;真缺保护会在刷新后升级为 high`,
        value: s.legs.filter((l) => l.symbol === symbol && l.source === 'position' && l.stop_loss_usdt === null && l.market !== 'spot').reduce((n, l) => n + l.notional, 0),
        threshold: 0,
        refs: [s.snapshot_id],
        bucket: symbol,
      });
  }

  return finish();

  function finish(): RiskAlert[] {
  const short = inp.capacity?.by_symbol.filter((s) => s.verdict === 'needs_equity' && !s.watch_only).sort((a, b) => a.symbol.localeCompare(b.symbol)) ?? [];
  if (s?.quality === 'ok' && short.length) {
    const required = Math.max(...short.map((x) => Number(x.required_equity)));
    push({ kind: 'capacity_short', severity: 'warn', scope: 'watchlist', title: `资金容量不足:${short.map((x) => x.symbol).join('/')}`,
      detail: `${short.map((x) => `${x.symbol} 要 ${x.required_equity} U 权益(${x.stop_distance_pct}% 典型止损)`).join(';')};当前 ${inp.capacity!.equity} U,单笔风险 ${inp.capacity!.risk_pct}%。按当前价格和规则估算`,
      value: s.equity, threshold: required, refs: [s.snapshot_id, ...short.map((x) => x.symbol)],
      // 同一组缺容量的币只更新金额，价格小抖动不新建告警。
      bucket: short.map((x) => x.symbol).join(',') });
  }
  for (const t of inp.threads) {
    if (!t.attention || (t.market === 'spot' && t.stop_price === null && t.attention === 'PROTECTION_MISSING')) continue;
    const sev: RiskSeverity = t.attention === 'PROTECTION_MISSING' || t.attention === 'HALT_INCOMPLETE' ? 'high' : 'warn';
    push({ kind: 'thread_attention', severity: sev, scope: t.id, title: `${t.symbol} 线程需要处理:${t.attention}`, detail: t.close_reason ?? '', value: null, threshold: null, refs: [`thread:${t.id}`], bucket: t.attention });
  }

  if (inp.unknown_intents > 0) push({ kind: 'execution_unknown', severity: 'high', scope: 'execution', title: `${inp.unknown_intents} 笔订单状态不明`, detail: '先核对再开新仓(gates 已挡)', value: inp.unknown_intents, threshold: 0, refs: [], bucket: inp.unknown_intents });
  if (transportUnstable(inp.transport)) {
    const t = inp.transport!;
    const mins = Math.round(t.window_ms / 60_000);
    push({
      kind: 'transport_unstable',
      severity: 'warn',
      scope: 'execution',
      title: `执行通道网络不稳:最近 ${mins} 分钟 ${t.runs} 次调用里 ${t.transport_errors} 次连接被掐`,
      detail: `这是你这台机器到交易所接口的网络/代理问题,不是交易所拒单,也不是余额问题。网关会自动处理:回执丢了先查交易所、再用同一订单号重发,最坏止损晚几十秒补上,不会因此误平仓。想减少发生:代理(Clash 等)给 agent.binance.com 加直连或换稳定节点,别让它每 30–45 秒掐长连接;或换网络。最近一次:${t.last_error ?? '—'}`,
      value: t.transport_errors,
      threshold: 2,
      refs: [],
      bucket: Math.min(t.transport_errors, 5),
    });
  }
  // 09-12 §9.31:保护能力是有期限的凭证,按通道 × 交易对判,不再是一次性标记。
  // never_verified = 这个币从没证明过能挂止损 → high + 按钮,**按币**阻断开新仓(preflightOpen 那道闸),
  // 所以 auto_action 显式写成 none:一个没验过的币不该把其它币的开仓也锁死(09-07 那次全局阻断的教训)。
  // 09-20:按币一条会在楼层上刷出 N 条一样的告警(4 个币 = 4 条 + 4 个待办);合成一条按通道的,
  //        按钮一次把这几个币顺序验完(verify-protection 的 symbols[])。阻断仍然按币在 preflightOpen 那道闸上。
  {
    // 09-22 Jacky 拍板:never_verified 不再阻断也不再告警(新用户每个币都要先烧真钱验证,体验极差);执行页仍可手动验。
    const never: string[] = [];
    if (never.length) {
      const channel = inp.protection!.channel;
      push({
        kind: 'protection_never_verified', severity: 'high', auto_action: 'none', scope: `channel:${channel}`,
        title: never.length === 1
          ? `${never[0]} 在 ${channel} 通道上从没验证过能挂止损`
          : `${channel} 通道上 ${never.length} 个币还没验证过能挂止损:${never.slice(0, 4).join('/')}${never.length > 4 ? '…' : ''}`,
        detail: `这些币的新开仓被挡住了(其它已验证的币照常)。点「用最小仓验证止损」:每个币开一张最小仓(约 5 USDT 名义)、挂止损、确认挂上、撤掉、平掉,每个约 2 分钟、几分钱手续费,通过后 ${inp.protection!.ttl_days} 天内有效。不是余额问题。${inp.protection!.auto_note ? `自动重验:${inp.protection!.auto_note}` : ''}`,
        value: never.length, threshold: 0, refs: never, bucket: never.join(','),
        action: riskActionFor('protection_never_verified', `channel:${channel}`, never),
      });
    }
  }
  for (const symbol of inp.protection?.expired ?? [])
    push({
      kind: 'protection_stale', severity: 'warn', scope: symbol,
      title: `${symbol} 的止损验证凭证已过期(${inp.protection!.ttl_days} 天)`,
      detail: `不挡开仓;巡检每天最多自动重跑一次金丝雀续期,真开仓时止损挂不上仍由「持仓缺止损保护」告警兜底。${inp.protection!.auto_note ? `这轮没自动跑:${inp.protection!.auto_note}。` : ''}想立刻续期就点按钮。`,
      value: null, threshold: null, refs: [], bucket: 'expired', action: riskActionFor('protection_stale', symbol),
    });
  for (const { symbol, error } of inp.protection?.probe_failed ?? [])
    push({
      kind: 'protection_stale', severity: 'warn', scope: symbol,
      title: `${symbol} 最近一次线上挂止损失败,凭证已降级`,
      detail: `失败原因:${error ?? '见执行页'}。只降这个币,其它币的凭证不受影响;不挡开仓,巡检每天最多自动重验一次。${inp.protection!.auto_note ? `这轮没自动跑:${inp.protection!.auto_note}。` : ''}`,
      value: null, threshold: null, refs: [], bucket: `probe:${error ?? ''}`, action: riskActionFor('protection_stale', symbol),
    });
  if (/error|fail|revoked|expired|needs_auth|unauthorized|missing/i.test(inp.execution.status)) push({ kind: 'execution_disconnected', severity: 'high', scope: 'execution', title: `执行通道 ${inp.execution.status}`, detail: inp.execution.detail, value: null, threshold: null, refs: [], bucket: inp.execution.status });

  const staleSyms = Object.entries(inp.market_as_of)
    .filter(([, at]) => at === null || inp.now - at > 3 * 60_000)
    .map(([sym]) => sym)
    .sort();
  if (staleSyms.length) push({ kind: 'market_stale', severity: staleSyms.length >= Math.max(1, Math.ceil(Object.keys(inp.market_as_of).length / 2)) ? 'high' : 'warn', scope: 'market', title: `${staleSyms.length} 个币行情过期/缺失:${staleSyms.slice(0, 4).join('/')}${staleSyms.length > 4 ? '…' : ''}`, detail: '行情快照 > 3 分钟;这些币不能开仓(证据新鲜度闸)', value: staleSyms.length, threshold: 0, refs: [], bucket: staleSyms.join(',') });

  return out;
  }
}

export const SEVERITY_ORDER: Record<RiskSeverity, number> = { info: 0, warn: 1, high: 2, critical: 3 };

/**
 * 这条告警现在还挡新增风险吗。09-06 Jacky 拍板:成因已经消除、只差人点「确认恢复」的(recovery_ready)
 * 不再挡单——之前 HYPE/SKHYNIX 的 PROPOSE 被三条早就恢复的旧告警拦了一下午。告警本身仍开着等人确认。
 */
export function isBlockingAlert(a: Pick<RiskAlert, 'auto_action'> & { recovery_ready?: boolean }): boolean {
  return a.auto_action === 'block_new_risk' && a.recovery_ready !== true;
}

/** 是否有告警要求停止新增风险(high/critical 未解决且成因还在)。 */
export function blocksNewRisk(alerts: readonly (Pick<RiskAlert, 'auto_action'> & { recovery_ready?: boolean })[]): boolean {
  return alerts.some(isBlockingAlert);
}

/** Agent 摘要按 kind 压成一行;完整 scope/最新值留在告警列表。 */
export function riskSummary(alerts: readonly (RiskAlert & { observed_count?: number; last_seen_at?: number })[]): string[] {
  const groups = new Map<string, { alert: RiskAlert; count: number; at: number }>();
  for (const a of alerts) {
    const prev = groups.get(a.kind);
    const at = a.last_seen_at ?? 0;
    groups.set(a.kind, { alert: !prev || at >= prev.at ? a : prev.alert, count: (prev?.count ?? 0) + (a.observed_count ?? 1), at: Math.max(at, prev?.at ?? 0) });
  }
  return [...groups.values()].map(({ alert, count }) => `${alert.title}${count > 1 ? ` ×${count}` : ''}`);
}
