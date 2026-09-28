// 公网英文评审版:交易页三层(执行层参数 / jev 判断 / 来源漏斗 / 预检 / 回测按执行层拒单)新增的中文都要有英文。
// 原文带数字的用真实样例值;原因码表、执行层校验报错、预检建议直接调源函数/遍历源常量,以后新增的码或改了句式会在这里红。
import { readFileSync } from 'node:fs';
import { schemas } from '@trade-gate/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXECUTION_THRESHOLDS, REASON_LABELS, checkPolicyPatch, policyFitAdvice, stopGeometry, stopGeometryReason } from '../../src/demo/execution-policy.js';
import { englishText, hasCjk } from '../../src/demo/public-en.js';
import { REASON_EN } from '../../src/demo/public-en-tables.js';
import { publicView } from '../../src/demo/public-view.js';
import { executionCheck } from '../../src/demo/research/execution-gate.js';
import { DEFAULT_WORKFLOW } from '../../src/demo/workflow.js';

const english = (): void => {
  vi.stubEnv('TG_PUBLIC_DEMO', '1');
  vi.stubEnv('TG_PUBLIC_LANG', 'en');
};
const chineseDemo = (): void => {
  vi.stubEnv('TG_PUBLIC_DEMO', '1');
  vi.stubEnv('TG_PUBLIC_LANG', '');
};
afterEach(() => vi.unstubAllEnvs());

const cjkIn = (v: unknown): string[] => {
  const out: string[] = [];
  const walk = (x: unknown): void => {
    if (typeof x === 'string') { if (hasCjk(x)) out.push(x); }
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  walk(v);
  return out;
};

/** 预检 blockers/warnings、启动失败 error、来源漏斗、活动流、闸理由、回测报告警告的原文样例(数字用真实值)。 */
const SAMPLES: string[] = [
  "雷达币池依赖尚未接线",
  "波动率目标仓位执行尚未接线，不能退回固定风险仓位",
  "该策略需要钉住模型与判断账本，请配置 judge 依赖后运行",
  "判断要素需要的决策模型连接未绑定或不可用(去「模型连接」绑定 decision 角色)",
  "这条策略钉住的判断模型(deepseek:deepseek-chat)与当前绑定(glm:glm-4.6)不一致;换回原连接,或重新研究后再运行",
  "这条策略钉住的判断模型(无)与当前绑定(glm:glm-4.6)不一致;换回原连接,或重新研究后再运行",
  "这条策略还没有可执行规则,请先在研究台生成并保存一个规则版本",
  "规则暂时无法执行,请在研究台修正编译提示后保存新版本",
  "这条策略已归档,请先恢复策略再运行",
  "这条策略要做空,请把市场选永续",
  "运行器不支持 1m/3m/5m,请用 15m 及以上周期",
  "这条双向策略还没有做空触发条件,请在研究台补充做空条件或改为只做多",
  "这条策略要求杠杆,请把市场选永续,或在研究台改为无杠杆",
  "这条入场规则还不能执行,请在研究台改为收盘确认、下一根入场",
  "止盈规则没有说明各档比例,请在研究台用 order.take_profits 配置目标和比例",
  "这条策略需要更多高周期历史,请缩短高周期指标回看长度后重试",
  "只挂最近第一档,按研究核归一后的 size_pct 部分止盈;其他档位不挂并记录在线程上,余仓由止损/信号离场/时间止损管理",
  "当前执行通道不支持按数量挂止盈,请切换纸面或 OKX,或把策略改为单目标",
  "每根收盘用运行币池等权构造市场因子并筛选;币池变化会影响排名,历史不足时跳过",
  "未成交 replace 缺撤单接线",
  "roll 无费结转尚未实现",
  "confirm 模式反手缺整项审批接线(auto/agent 已支持)",
  "未成交 replace 缺撤单接线;roll 无费结转尚未实现;confirm 模式反手缺整项审批接线(auto/agent 已支持)",
  "这条策略的同币新信号会加仓,运行器还没接加仓执行链;先改 IR 的 on_new_signal 或等接线后再运行",
  "这条策略靠追踪/保本/结构移损管仓,运行器的移损还没接通(缺 moveStop 或首档止盈成交状态);接通前不能运行",
  "这个版本还没有完成的回测报告",
  "尚未注册 ASP 身份,发布会跳过;请到信号市场 → 发布注册",
  "杠杆按账户/工作流上限封顶为 3 倍",
  "回测时的执行层阈值(止损 0.3%–5%、≥0.5×ATR、净RR≥1.5)与现在(0.5%–5%、≥0.5×ATR、净RR≥2)不同,回测结果不代表现在的实盘,请重跑回测",
  "无法核对执行层:没有找到这个版本的回测订单或实盘候选(执行层要求止损 0.3%–5%、≥0.5×ATR、净RR≥1.5),实盘可能被执行层拒单",
  "回测订单按当前执行层会被拒掉 97%(29/30:止损低于下限 7、净RR不足 28),样本止损中位 0.37%;建议把策略止损放宽到 ≥0.3% 且 ≥0.5×ATR;止盈目标放到扣成本后 ≥1.5R(或去掉不合理的近目标)",
  "回测按当前执行层会被拒掉 50%(5/10:止损低于下限 2、止损小于 ATR 下限 3、止损过宽 1、净RR不足 4),样本止损中位 0.42%;建议把策略止损倍数放宽到 ≥1.2×ATR(按样本 ATR 中位 0.35%,约 0.42%);把止损收紧到 ≤5%;止盈目标放到扣成本后 ≥1.5R(或去掉不合理的近目标)",
  "实盘候选按当前执行层会被拒掉 20%(1/5:止损过宽 1);建议把止损收紧到 ≤5%",
  "回测订单按当前执行层会被拒掉 60%(3/5:止损低于下限 3),样本止损中位 0.2%;建议把策略止损放宽到 ≥0.3%",
  "回测订单按当前执行层会被拒掉 60%(3/5:净RR不足 3);建议调整策略几何",
  "请求体必须是对象",
  "未知字段 foo",
  "strategy_id 必填",
  "version 必须是正整数",
  "「每笔问我确认」已下线;请选 auto(直接做)/ agent(LLM 判断)/ jev(Jev 判断)/ signal_only(只发信号)。已在跑的 confirm 运行不受影响",
  "「每笔问我确认」已下线;请选 auto / agent / jev / signal_only",
  "无效的 mode,只能是 auto / agent / jev / signal_only",
  "无效的 market",
  "无效的 status",
  "symbols 必须是 1–30 个内部 USDT 符号",
  "risk_pct 必须在 (0,100]",
  "max_open 必须在 1–30",
  "publish_asp 必须是布尔值",
  "jev_shadow 必须是布尔值",
  "confirm 必须是 LIVE",
  "该策略已有运行",
  "旧执行通道仍有持仓、待批线程或待对账新信号,请先处理再切换运行通道",
  "实盘运行需要输入 LIVE 确认",
  "运行不存在",
  "无效的事件游标",
  "symbols_source 必须是对象",
  "symbols_source 需 fixed 或 radar(tier=short|swing|weekly, top_n=1–30 整数)",
  "运行已暂停",
  "运行已停止",
  "AI 扫盘",
  "突破-回踩(单一策略,v3)",
  "(空 playbook)",
  "紧急停止中",
  "工作流已暂停",
  "AI 扫盘已暂停",
  "Thread Manager 已暂停",
  "当前策略「SOL 15m pullback short」在运行,自由判断只复查不开新仓",
  "界面上要求扫描",
  "界面上点了「立即扫描」",
  "工作流已更新:brain、cheap_brain",
  "工作流已更新:ai_scan_paused",
  "工作流已更新:min_stop_pct, max_stop_pct",
  "工作流已更新:min_stop_pct(未应用:max_stop_pct 需在 1–20)",
  "未应用:min_stop_pct 需在 0.05–2(0 = 关闭); min_stop_pct 必须小于 max_stop_pct",
  "AI 扫盘已暂停:不再扫描新机会,策略运行照常",
  "AI 扫盘已恢复",
  "已有线程继续复查,策略运行不受影响",
  "agent 改了执行层参数(模拟盘直改区间内):min_stop_pct、min_net_rr",
  "执行层参数已更新:min_stop_pct",
  "agent 在模拟盘直接改了执行层:min_stop_pct: 0.3 → 0.4",
  "用户改了执行层:min_stop_pct: 0.3 → 0.4; min_net_rr: 1.5 → 1.8",
  "对话提议改执行层:min_stop_pct、leverage(实盘通道),等待确认",
  "对话提议改执行层:min_stop_pct(超出 agent 直改区间:min_stop_pct),等待确认",
  "已生成设置提议卡,用户在界面上点确认才生效",
  "实盘通道改执行层参数需要输入 LIVE 确认",
  "没有要改的执行层参数",
  "请求体必须是对象,如 {\"min_stop_pct\":0.5}",
  "foo 不是执行层参数,只能是 risk_pct/leverage/margin_mode/min_stop_pct/max_stop_pct/min_stop_atr/min_net_rr/max_open_threads/max_opens_per_day/daily_loss_stop_pct/sizing_agent",
  "margin_mode 只能是 cross/isolated",
  "min_stop_pct 必须是数字",
  "max_open_threads 必须是整数",
  "min_stop_pct 需在 0.05–2",
  "min_stop_atr 需在 0–3(0 = 关闭)",
  "min_stop_pct(0.8)必须小于 max_stop_pct(0.5)",
  "min_stop_pct 必须小于 max_stop_pct",
  "ai_scan_paused 必须是布尔",
  "风险/杠杆/止损距离/净盈亏比/持仓与开仓上限/日亏停/仓位倍率属于执行层,改用 set_execution_policy(模拟盘区间内直接生效,否则生成提议);自动执行/执行通道只能由用户在界面上改",
  "请求体只能是 {\"paused\": true|false}",
  "since 必须是不晚于现在、且在 31 天内的毫秒时间戳",
  "止损在正确一侧",
  "止损距离",
  "止损ATR下限",
  "净盈亏比",
  "当前策略",
  "线程/日内限制",
  "现货,无止损(可选)",
  "做多止损低于入场价",
  "做空止损高于入场价",
  "止损 95.5 在入场价 100.0 的错误一侧",
  "0.25%(允许 0.3%–5%)",
  "0.25%(允许 0.3%–5%),0.40×ATR(下限 0.5×ATR)",
  "0.25%(允许 0.3%–5%),0.40×ATR(下限 0×ATR,已关闭)",
  "已关闭(min_stop_atr=0)",
  "ATR 不可用,不判(百分比下限 0.3% 仍生效)",
  "止损 0.40×ATR(需 ≥ 0.5×ATR ≈ 0.62%)",
  "净RR=1.2,需≥1.5;往返成本预算12bps",
  "净RR=不可计算,需≥1.5;往返成本预算12bps",
  "AI 扫盘已暂停,不开新仓",
  "SOLUSDT 提议做多被代码闸拦下",
  "止损距离:0.25%(允许 0.3%–5%);净盈亏比:净RR=1.2,需≥1.5;往返成本预算12bps",
  "基础闸拒绝:止损距离:0.25%(允许 0.3%–5%);净盈亏比:净RR=1.2,需≥1.5;往返成本预算12bps",
  "基础闸拒绝:止损ATR下限:止损 0.40×ATR(需 ≥ 0.5×ATR ≈ 0.62%)",
  "开仓被执行闸拒绝",
  "SOLUSDT 止损距离:0.25%(允许 0.3%–5%),0.40×ATR(下限 0.5×ATR)",
  "SOLUSDT 基础闸拒绝:止损距离:0.25%(允许 0.3%–5%)",
  "SOLUSDT:模型调用失败",
  "模型调用失败",
  "Jev 放行:trend aligned, clean retest",
  "Jev 跳过:no clear structure",
  "Jev 不可用,按跳过:no decision model bound",
  "临时失败,15 秒后重试:network timeout",
  "止损距离 0.25%(允许 0.3%–5%),0.40×ATR(下限 0.5×ATR)",
  "净盈亏比 1.20 < 1.5(扣往返成本 12bps)",
  "净盈亏比 算不出 < 1.5(扣往返成本 12bps)",
  "执行层:止损距离 0.25%(允许 0.3%–5%);净盈亏比 1.20 < 1.5(扣往返成本 12bps)",
  "这份回测按实盘的执行层阈值挡单:止损距离要在 0.3% 到 5% 之间,且不小于 0.5 倍 ATR,扣掉 12bps 往返成本后盈亏比不低于 1.5。各资产一共检查 120 个候选,挡掉 31 个",
  "这份回测按实盘的执行层阈值挡单:止损距离要在 0.3% 到 5% 之间,扣掉 12bps 往返成本后盈亏比不低于 1.5。各资产一共检查 0 个候选,挡掉 0 个",
  "这份回测没有按实盘的执行层阈值挡单,回测里能下的单到实盘可能下不出去",
];

/** 开仓检查项名字(execution-policy.ts GATE_NAME_CODE 的键 + gates.ts / runtime.ts 里的 name)。 */
const GATE_NAMES = ['紧急停止', '暂停', '证据新鲜度', '无持仓才能开仓', '每日开仓上限', '止损在正确一侧', '止损距离', '止损ATR下限', '止盈在正确一侧', '信心下限',
  '当前策略', '没有状态不明的订单', '策略共识', '入场方式', '事件封锁', '组合限额', '风控哨兵', '策略ATR尺度', '净盈亏比', '结构失效价', '持仓计划', '演示版不加仓',
  '线程/日内限制', 'AI 扫盘', 'AI 扫盘已暂停'];

describe('公网英文模式:交易页三层新增文案', () => {
  it.each(SAMPLES)('%s', (zh) => {
    english();
    const en = englishText(zh);
    expect(hasCjk(en), en).toBe(false);
  });

  it.each(GATE_NAMES)('检查项名 %s', (zh) => {
    english();
    expect(hasCjk(englishText(zh))).toBe(false);
  });

  it('REASON_LABELS 每个原因码都有英文,标签译出来不含中文', () => {
    english();
    const missing = Object.keys(REASON_LABELS).filter((code) => !REASON_EN[code]);
    expect(missing).toEqual([]);
    for (const [code, zh] of Object.entries(REASON_LABELS)) expect(hasCjk(englishText(zh)), `${code}: ${zh}`).toBe(false);
    expect(englishText(REASON_LABELS['min_net_rr']!)).toBe('Net R:R too low');
  });

  it('执行层校验报错(checkPolicyPatch)全部可译', () => {
    english();
    const bad = [
      checkPolicyPatch(null, DEFAULT_WORKFLOW),
      checkPolicyPatch({ foo: 1, margin_mode: 'x', min_stop_pct: 'abc', max_open_threads: 2.5, min_net_rr: 99, min_stop_atr: 9 }, DEFAULT_WORKFLOW),
      checkPolicyPatch({ min_stop_pct: 1.5, max_stop_pct: 1 }, DEFAULT_WORKFLOW),
    ].flatMap((c) => c.errors.map((e) => e.message));
    expect(bad.length).toBeGreaterThanOrEqual(7);
    for (const m of bad) expect(hasCjk(englishText(m)), m).toBe(false);
  });

  it('止损几何理由、回测执行层拒单理由、预检修改建议(源函数现拼)都可译', () => {
    english();
    const th = DEFAULT_EXECUTION_THRESHOLDS;
    const texts = [
      stopGeometryReason(stopGeometry(100, 99.75, 0.5, th), th),
      stopGeometryReason(stopGeometry(100, 99.75, 0.5, { ...th, min_stop_atr: 0 }), { ...th, min_stop_atr: 0 }),
      stopGeometryReason(stopGeometry(100, 99.75, null, th), th),
      executionCheck('long', 100, 99.75, 100.2, 0.5, th).reason!,
      `执行层:${executionCheck('long', 100, 94, 100.2, 0.5, th).reason!}`,
      executionCheck('short', 100, 100.2, 99.9, null, th).reason!,
    ];
    const fit = { checked: 30, rejected: 29, median_stop_pct: 0.37, median_atr_pct: 0.35, rejected_by_execution: { stop_distance: 7, stop_atr: 3, stop_too_wide: 1, min_net_rr: 28 } };
    for (const advice of [policyFitAdvice(fit, th), policyFitAdvice({ ...fit, median_atr_pct: null }, th), policyFitAdvice({ ...fit, median_atr_pct: null }, { ...th, min_stop_atr: 0 })]) {
      texts.push(`回测订单按当前执行层会被拒掉 97%(29/30:止损低于下限 7、止损小于 ATR 下限 3、止损过宽 1、净RR不足 28),样本止损中位 0.37%;建议${advice}`);
    }
    for (const t of texts) expect(hasCjk(englishText(t)), t).toBe(false);
  });

  it('启动失败:多条 blocker 用「;」拼成一条 error,切段后每段都译', () => {
    english();
    const joined = [
      '判断要素需要的决策模型连接未绑定或不可用(去「模型连接」绑定 decision 角色)',
      '这条策略需要更多高周期历史,请缩短高周期指标回看长度后重试',
      '回测订单按当前执行层会被拒掉 97%(29/30:止损低于下限 7、净RR不足 28),样本止损中位 0.37%;建议把策略止损放宽到 ≥0.3% 且 ≥0.5×ATR;止盈目标放到扣成本后 ≥1.5R(或去掉不合理的近目标)',
      '这条策略靠追踪/保本/结构移损管仓,运行器的移损还没接通(缺 moveStop 或首档止盈成交状态);接通前不能运行',
    ].join(';');
    const en = englishText(joined);
    expect(hasCjk(en), en).toBe(false);
    expect(en).toContain('97% of backtest orders (29 of 30) would be rejected by the current execution rules');
  });

  it('GET /api/research/schema 与回测/订单契约里的执行层描述可译', () => {
    english();
    expect(cjkIn(publicView(schemas.research))).toEqual([]);
    for (const f of ['research-backtest.json', 'research-orders.json']) {
      const json = JSON.parse(readFileSync(new URL(`../../../contracts/schema/${f}`, import.meta.url), 'utf8')) as unknown;
      const fresh = cjkIn(json).filter((d) => d.includes('执行层'));
      expect(fresh.length).toBeGreaterThan(0);
      for (const d of fresh) expect(hasCjk(englishText(d)), d).toBe(false);
    }
  });

  it('publicView:/api/trading/sources 形状整体无中文', () => {
    english();
    const sources = {
      since: 1790380800000, until: 1790458558083,
      shared: { open_threads: 0, max_open_threads: 3, opens_today: 0, max_opens_per_day: 4, daily_loss_hit: false, halted: false, paused: false },
      sources: [
        { kind: 'ai_scan', id: 'ai_scan', name: 'AI 扫盘', enabled: false, disabled_reason: 'AI 扫盘已暂停', paused: true,
          playbook: { name: '突破-回踩(单一策略,v3)', prompt_version: 'demo-playbook-v11.1-ohlc', custom: false }, judge: 'model',
          top_reasons: [
            { layer: 'gate', key: 'stop_distance', label: REASON_LABELS['stop_distance'], count: 3, example: 'SOLUSDT 止损距离:0.25%(允许 0.3%–5%),0.40×ATR(下限 0.5×ATR)' },
            { layer: 'gate', key: 'min_net_rr', label: REASON_LABELS['min_net_rr'], count: 2, example: 'ETHUSDT 净盈亏比:净RR=1.2,需≥1.5;往返成本预算12bps' },
            { layer: 'gate', key: 'current_strategy', label: REASON_LABELS['current_strategy'], count: 1, example: 'BTCUSDT 当前策略:当前策略「SOL 15m pullback short」在运行,自由判断只复查不开新仓' },
            { layer: 'execution', key: 'model_failed', label: REASON_LABELS['model_failed'], count: 1, example: '模型调用失败' },
          ],
          not_taken: [{ layer: 'gate', key: 'ai_scan_paused', label: REASON_LABELS['ai_scan_paused'], count: 1, example: 'SOLUSDT AI 扫盘已暂停:AI 扫盘已暂停,不开新仓' }] },
        { kind: 'strategy_run', id: 'run_1', name: 'SOL 15m pullback short (scout candidate)', mode: 'jev', judge: 'jev',
          top_reasons: [
            { layer: 'gate', key: 'stop_distance', label: REASON_LABELS['stop_distance'], count: 2, example: 'SOLUSDT 基础闸拒绝:止损距离:0.25%(允许 0.3%–5%);净盈亏比:净RR=1.2,需≥1.5;往返成本预算12bps' },
            { layer: 'judge', key: 'jev_skip', label: REASON_LABELS['jev_skip'], count: 1, example: 'SOLUSDT Jev 跳过:no clear structure' },
          ],
          not_taken: [{ layer: 'execution', key: 'transient', label: REASON_LABELS['transient'], count: 1, example: 'SOLUSDT 临时失败,15 秒后重试:network timeout' }] },
      ],
    };
    const out = publicView(sources) as typeof sources;
    expect(cjkIn(out)).toEqual([]);
    expect(out.sources[0]!.name).toBe('AI Scan');
    expect(out.sources[0]!.playbook!.name).toBe('Breakout-Retest (single strategy, v3)');
  });

  it('publicView:预检响应形状整体无中文', () => {
    english();
    const preflight = {
      strategy_id: 'rs_09b50604bc1446988889', version: 1, deployable: false,
      blockers: [
        { code: 'judge_unavailable', message: '判断要素需要的决策模型连接未绑定或不可用(去「模型连接」绑定 decision 角色)' },
        { code: 'history_window_unsupported', message: '这条策略需要更多高周期历史,请缩短高周期指标回看长度后重试' },
        { code: 'execution_policy_mismatch', message: '回测订单按当前执行层会被拒掉 97%(29/30:止损低于下限 7、净RR不足 28),样本止损中位 0.37%;建议把策略止损放宽到 ≥0.3% 且 ≥0.5×ATR;止盈目标放到扣成本后 ≥1.5R(或去掉不合理的近目标)' },
      ],
      warnings: [
        { code: 'not_backtested', message: '这个版本还没有完成的回测报告' },
        { code: 'execution_unverified', message: '无法核对执行层:没有找到这个版本的回测订单或实盘候选(执行层要求止损 0.3%–5%、≥0.5×ATR、净RR≥1.5),实盘可能被执行层拒单' },
        { code: 'new_signal_policy', message: 'roll 无费结转尚未实现;confirm 模式反手缺整项审批接线(auto/agent 已支持)' },
        { code: 'asp_identity_missing', message: '尚未注册 ASP 身份,发布会跳过;请到信号市场 → 发布注册' },
        { code: 'leverage_capped', message: '杠杆按账户/工作流上限封顶为 3 倍' },
      ],
    };
    expect(cjkIn(publicView(preflight))).toEqual([]);
  });

  it('非英文模式原样返回', () => {
    chineseDemo();
    const v = { name: 'AI 扫盘', label: REASON_LABELS['min_net_rr'] };
    expect(publicView(v)).toEqual(v);
  });
});

describe('心跳扫描文案(本机评审实例 crawl 漏出)', () => {
  it('触发说明、跳过标题与说明英文模式下无中文', () => {
    process.env['TG_PUBLIC_DEMO'] = '1'; process.env['TG_PUBLIC_LANG'] = 'en';
    for (const s of ['心跳扫描(15m K 线 21:45 UTC 收盘;30 分钟没问过模型)', 'BTCUSDT 心跳跳过 ×3', '15m/1h 结构、ATR 档、量能档、市场状态、时段都没变,省下一次模型调用']) {
      expect(hasCjk(englishText(s)), s).toBe(false);
    }
  });
});
