/**
 * 生成器 1:诊断驱动(确定性规则,零模型)。输入是父策略训练段的诊断(loop/diagnose.ts 的 findings),
 * 按下表把每条 high/medium 诊断映射成 IR 改法;同一诊断的多种改法按表中顺序排,runner 统一去重、编译检查、截预算。
 *
 * 映射表(诊断 key → 改法 → 理由):
 *   stop_tight(止损出场占比 > 40% 且合计亏损)
 *     - atr_stop:multiple × 1.5(上限 10)            止损离入场太近,被正常波动打掉;放宽 ATR 倍数给波动留空间
 *     - 非 swing_low_stop:换 swing_low_stop{lookback:20}  改用结构止损(近 20 根最低价),止损放在结构失效处而不是固定距离
 *     - swing_low_stop:lookback × 2                  结构窗口加长,止损放到更远的低点
 *     - order_blocks:swing_length × 2(上限 100)     支撑块用更大摆动级别,止损放到更有意义的结构下沿
 *   exposure(在场 < 50% 且同窗口持有涨 > 50%)
 *     - 有 regime:去掉 regime                       方向门把太多上涨段挡在门外,放宽方向门
 *     - 有 chandelier_trail:multiple × 1.5          追踪止损太近导致过早离场,放宽让趋势段拿得更久
 *     (资产池在任务里冻结,「加资产」不在单任务内做)
 *   decay(训练段前半为正、后半转负)
 *     - signal 多于 1 个:去掉最后一个信号条件        条件越多越容易贴合前段行情,减少条件
 *     - 有 regime:去掉 regime                       同上,减少一层过滤
 *     - 有 optional 离场:去掉 optional 离场          去掉可选的固定目标/到期,减少可调部件
 *   concentration(前 20% 交易贡献超过全部净利润)
 *     - 没有 breakeven_after_r:加 breakeven_after_r{r:1}   盈利少数几笔撑全局,其余交易浮盈回吐;到 1R 后止损上移保本
 *     - 没有 fixed_r_target:加 optional fixed_r_target{r:3} 分一档止盈锁定部分大波段(现货单仓,近似分档)
 *   fees(手续费+滑点 > 毛盈亏 30%)
 *     - signal 周期 × 1.5                             降低信号频率(周期在任务里冻结,换高周期不在单任务内做)
 *     - 加 volume_surge{lookback:20, multiple:1.5}    只在放量时入场,过滤低质量信号、减少换手
 *   worst_exit(亏损主要来自某类非止损出场,解析诊断文本里的「出场类型」)
 *     - 追踪止损:chandelier_trail multiple × 1.5    追踪太紧,放宽
 *     - 信号离场/indicator_cross_exit 等:换成 chandelier_trail{22,3}  信号离场滞后回吐利润,换成按波动率追踪
 *     - 趋势破位:trend_break ema_period × 1.5       破位线太近,放慢
 *     - 到期:去掉 time_stop                        到期离场在亏,去掉持仓上限
 *     - 止盈:fixed_r_target r × 1.5                 目标太近,放远
 *     - 结构:swing_structure_stop lookback × 2      结构追踪太紧,加长窗口
 *   sample(平仓 < 30 笔)
 *     - signal 周期 × 0.75                            样本太少,缩短周期让信号更频繁
 *     - 有 regime:去掉 regime                       方向门过严,放宽
 * 不在表里的诊断(exit_mix / assets / no_metrics / info 级别)不产生候选。
 */
import type { StrategyIR } from '@trade-gate/contracts';
import { node } from '../../strategy.js';
import type { CandidateGenerator, GeneratorContext } from '../types.js';
import { appendExit, appendSignal, nodesOf, removeNode, replaceNode, scalePeriods, setParam, type Proposal } from './params.js';

type Rule = (ir: StrategyIR, text: string) => (Proposal | null)[];
const pick = (ir: StrategyIR, primitive: string) => nodesOf(ir).find((r) => r.node.primitive === primitive) ?? null;
const scaled = (ir: StrategyIR, primitive: string, key: string, f: number, cap: number, why: string): Proposal | null => {
  const r = pick(ir, primitive); if (!r) return null;
  const v = Number(r.node.params[key]); if (!Number.isFinite(v)) return null;
  const to = Number.isInteger(v) ? Math.min(cap, Math.max(2, Math.round(v * f))) : Math.min(cap, Math.round(v * f * 100) / 100);
  const x = setParam(ir, r.path, key, to); return x && { ...x, rationale: why };
};
const dropRegime = (ir: StrategyIR, why: string): Proposal | null => { const x = ir.regime ? removeNode(ir, 'regime') : null; return x && { ...x, rationale: why }; };
/** 诊断文本里「亏损主要来自「X」出场」的 X → 出场类别。 */
function worstExitOf(text: string): string | null { return /来自「([^」]+)」出场/.exec(text)?.[1] ?? null; }

export const RULES: Record<string, Rule> = {
  stop_tight: (ir) => {
    const s = ir.risk.stop;
    return [
      s.primitive === 'atr_stop' ? scaled(ir, 'atr_stop', 'multiple', 1.5, 10, '止损过紧:止损出场占比高且合计亏损,ATR 倍数放宽 1.5 倍给正常波动留空间') : null,
      s.primitive !== 'swing_low_stop' ? (() => { const x = replaceNode(ir, 'risk.stop', node('swing_low_stop', { lookback: 20 })); return x && { ...x, rationale: '止损过紧:改用结构止损(近 20 根最低价),止损放在结构失效处而不是固定距离' }; })() : null,
      s.primitive === 'swing_low_stop' ? scaled(ir, 'swing_low_stop', 'lookback', 2, 5000, '止损过紧:结构窗口加长一倍,止损放到更远的低点') : null,
      s.primitive === 'order_blocks' ? scaled(ir, 'order_blocks', 'swing_length', 2, 100, '止损过紧:支撑块用更大摆动级别,止损放到更有意义的结构下沿') : null,
    ];
  },
  exposure: (ir) => [
    dropRegime(ir, '资金闲置:在场时间不到一半而持有大涨,方向门挡掉了太多上涨段,去掉 regime'),
    scaled(ir, 'chandelier_trail', 'multiple', 1.5, 20, '资金闲置:追踪止损太近导致过早离场,倍数放宽 1.5 倍让趋势段拿得更久'),
  ],
  decay: (ir) => [
    ir.signal.length > 1 ? (() => { const x = removeNode(ir, `signal.${ir.signal.length - 1}`); return x && { ...x, rationale: '样本内外衰减:条件越多越贴合前段行情,去掉最后一个信号条件' }; })() : null,
    dropRegime(ir, '样本内外衰减:减少一层过滤,去掉 regime'),
    ...ir.exit.map((e, i) => ({ e, i })).filter((x) => x.e.optional).slice(0, 1).map(({ i }) => { const x = removeNode(ir, `exit.${i}`); return x && { ...x, rationale: '样本内外衰减:去掉可选的固定目标/到期离场,减少可调部件' }; }),
  ],
  concentration: (ir) => [
    !pick(ir, 'breakeven_after_r') ? { ...appendExit(ir, node('breakeven_after_r', { r: 1 })), rationale: '利润集中:少数几笔撑起全部利润、其余交易浮盈回吐,到 1R 后止损上移保本' } : null,
    !pick(ir, 'fixed_r_target') ? { ...appendExit(ir, node('fixed_r_target', { r: 3 }, true)), rationale: '利润集中:加一档 3R 固定止盈锁定部分大波段(现货单仓,近似分档止盈)' } : null,
  ],
  fees: (ir) => [
    (() => { const x = scalePeriods(ir, 1.5, ['signal']); return x && { ...x, rationale: '成本拖累:手续费占毛盈亏比例高,信号周期放大 1.5 倍降低交易频率(周期在任务里冻结,不换高周期)' }; })(),
    !pick(ir, 'volume_surge') ? { ...appendSignal(ir, node('volume_surge', { lookback: 20, multiple: 1.5 })), rationale: '成本拖累:只在放量(≥ 20 根均量 1.5 倍)时入场,过滤低质量信号、减少换手' } : null,
  ],
  worst_exit: (ir, text) => {
    const kind = worstExitOf(text);
    if (!kind) return [];
    if (kind === '追踪止损') return [scaled(ir, 'chandelier_trail', 'multiple', 1.5, 20, '追踪止损出场在亏:追踪太紧,倍数放宽 1.5 倍')];
    if (kind === '趋势破位') return [scaled(ir, 'trend_break', 'ema_period', 1.5, 5000, '趋势破位出场在亏:破位线太近,EMA 周期放慢 1.5 倍')];
    if (kind === '到期') { const i = ir.exit.findIndex((e) => e.primitive === 'time_stop'); const x = i >= 0 ? removeNode(ir, `exit.${i}`) : null; return [x && { ...x, rationale: '到期出场在亏:去掉持仓根数上限' }]; }
    if (kind === '止盈') return [scaled(ir, 'fixed_r_target', 'r', 1.5, 20, '止盈出场在亏(扣成本后):目标太近,R 倍数放大 1.5 倍')];
    if (kind === 'structure' || kind === 'swing_structure_stop') return [scaled(ir, 'swing_structure_stop', 'lookback', 2, 5000, '结构追踪出场在亏:窗口加长一倍')];
    // 信号离场类:把第一个信号离场换成按波动率追踪
    const i = ir.exit.findIndex((e) => /_exit$/.test(e.primitive) || e.primitive === kind);
    if (i < 0) return [];
    const x = replaceNode(ir, `exit.${i}`, node('chandelier_trail', { atr_period: 22, multiple: 3 }));
    return [x && { ...x, rationale: `「${kind}」出场在亏:信号离场滞后回吐利润,换成吊灯线追踪(22 根 ATR × 3)` }];
  },
  sample: (ir) => [
    (() => { const x = scalePeriods(ir, 0.75, ['signal']); return x && { ...x, rationale: '样本不足:平仓少于 30 笔,信号周期缩短到 0.75 倍让信号更频繁' }; })(),
    dropRegime(ir, '样本不足:方向门过严,去掉 regime'),
  ],
};

export const diagnosisGenerator: CandidateGenerator = {
  name: 'diagnosis',
  async generate(ctx: GeneratorContext) {
    const order = { high: 0, medium: 1, info: 2 } as Record<string, number>;
    const findings = ctx.diagnosis.filter((f) => f.severity !== 'info' && RULES[f.key]).sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
    const out: Awaited<ReturnType<CandidateGenerator['generate']>> = [];
    for (const f of findings) for (const p of RULES[f.key]!(ctx.parent.ir, f.text)) {
      if (!p) continue;
      const ok = ctx.check(p.ir);
      if (!ok.ok) continue;
      out.push({ generator: 'diagnosis', ir: { ...p.ir, label: ctx.parent.ir.label }, diff: p.diff, rationale: p.rationale, evidence: { finding: f.key, severity: f.severity, text: f.text } });
    }
    return out;
  },
};
