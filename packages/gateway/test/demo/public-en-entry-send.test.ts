/**
 * 评审版英文层:入场方式检查、发送前复查、算数量说明、组合检查、判断记录「提议被拒」、模型理由里派生数的来源标注。
 * 09-27 修 AI 扫盘后出现了新的拒单,这几组句子才在 #judgments / #history 露出中文。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { englishText, hasCjk } from '../../src/demo/public-en.js';
import { publicView } from '../../src/demo/public-view.js';

const SAMPLES: string[] = [
  // 判断记录 reducer
  '提议被拒:入场方式(限价 121.1 在现价 121.09 的上方会立刻成交,等同市价追单:距突破位 1.30 ATR 已超过上限 1 ATR;改挂回踩区(参考 120.9–121.1))',
  '提议被拒:入场方式(限价 121.1 在现价 121.09 的上方会立刻成交,等同市价追单:距突破位 1.30 ATR 已超过上限 1 ATR;改挂回踩区(参考 120.9–121.1));净盈亏比(净RR=1.2,需≥1.5)',
  '提议通过代码闸,建线程',
  // entry-policy.ts entryStyleGate / finalEntryCheck / entryStyleAdvice
  '市价追单被拒:距突破位 1.80 ATR 已超过市价上限 1 ATR;改挂限价(参考区 按结构自定)',
  'limit_only:市价开仓一律拒(该策略规则没有 entry_mode=market_ok);请给 entry="limit" + limit_price,挂单的对齐/耐心/撤单链照旧',
  'limit_only:限价 121.1 会立刻成交,等同市价开仓一律拒(该策略规则没有 entry_mode=market_ok)',
  'limit_only:该策略规则写了 entry_mode=market_ok,市价放行',
  'limit_only:限价入场',
  '入场方式不限制(free)',
  '非开仓动作',
  '没有入场方式证据,不拦',
  '限价入场',
  '限价入场(挂在现价不利侧等回踩)',
  '限价入场(身份未证明,距离闸不拦)',
  '方向成立但回踩未确认:只许挂等待型限价,市价拒',
  '限价 121.1 在现价 121.09 的上方,会立刻成交(marketable limit = 市价绕过);回踩未确认只许挂在不利侧等',
  '市价开仓要求可执行价新鲜:这个价已经是 45000ms 之前的(上限 30000ms),拒',
  '市价开仓要求可执行价新鲜:取不到可执行价,拒',
  '回踩未确认时必须证明这是等待型限价:可执行价不新鲜(45000ms > 30000ms),按 fail closed 拒',
  '回踩未确认时必须证明这是等待型限价:没有可用的限价,按 fail closed 拒',
  '立刻成交的限价追单被拒:成交价 121.09 距冻结突破位 119.5 已 1.80 ATR,超过上限 1 ATR',
  '市价追单被拒:成交价 121.09 距冻结突破位 119.5 已 1.80 ATR,超过上限 1 ATR',
  '等待型限价挂得太远:挂单价 118 距冻结突破位 119.5 有 1.60 ATR,超过上限 1 ATR —— 换成限价不等于没在追',
  '等待型限价:距冻结突破位 0.40 ATR(上限 1),时机待回踩',
  '市价:距冻结突破位 n/a(上限 1)',
  '入场时机判据已经不成立(不是「还没到」而是「过了/坏了」),不许开仓',
  '回踩已确认但已走出 1.80 ATR(市价上限 1),追单成本过高',
  '回踩已确认且离突破位不远,市价可用',
  '清单没给突破距离,按限价等回踩更稳',
  '回踩未确认(距突破位 0.40 ATR),按策略规则应挂限价等回踩',
  // runtime.ts 发送前复查(平仓原因 / 意图错误)
  '发送前持仓计划重闸: 净盈亏比;原计划不改价',
  '发送前持仓计划重闸: 策略ATR尺度/净盈亏比;原计划不改价',
  '发送前数量硬闸:数量低于交易所最小下单量',
  '发送前数量硬闸:低于交易所最小名义 5 USDT,抬到最小名义(实际风险 1.20 USDT);最小下单量风险 3.20 U > 预算 1.00 U;要 320 U 权益才能按 0.5% 做 BTCUSDT(容差 5%,拒单)',
  '发送前组合硬闸:成交后总敞口 3.20× 权益 > 上限 3×;聚合止损预算 3.20% 权益 > 上限 3.00%',
  '发送前组合硬闸:账户快照质量 incomplete(BTCUSDT 无行情,用持仓自带标记价),不能据此放行新开仓',
  '发送前行情过期',
  '发送前硬闸数据不可用',
  '发送前 IR 几何已失效,不改价',
  '发送前 IR min_rr 不满足,不改价',
  '策略限价挂单已过期,请等待下一次信号',
  '发送前发现紧急停止',
  '发送前策略运行已暂停/停止或通道/杠杆上限改变',
  '发送前入场方式重闸:方向成立但回踩未确认:只许挂等待型限价,市价拒',
  '发送前重闸拒绝:紧急停止中',
  '设杠杆失败:timeout',
  '设保证金模式失败:timeout',
  // gates.ts computeSizing 说明
  '名义超过权益×3,按上限钳制',
  '低于交易所最小名义 5 USDT,抬到最小名义(实际风险 1.20 USDT)',
  '按24h成交量流动性上限钳制',
  '数量低于交易所最小下单量',
  '低于交易所最小名义，拒单',
  '交易所最小名义 5 高于本地名义上限 3.20,拒单',
  '流动性上限或 sizing 数据不可用，拒单',
  '最小下单量风险 3.20 U > 预算 1.00 U;要 320 U 权益才能按 0.5% 做 BTCUSDT(容差 5%,拒单)',
  // portfolio.ts evaluateImpact / 快照质量
  '账户快照质量 incomplete(BTCUSDT 无行情,用持仓自带标记价;ETHUSDT 挂单 tg-e-1 无法定价),不能据此放行新开仓',
  '账户快照质量 invalid(权益 ≤ 0 或缺失),不能据此放行新开仓',
  '账户快照质量 degraded,不能据此放行新开仓',
  'PEPEUSDT 不在风险簇表里(unknown),不新增未知簇风险',
  '成交后总敞口 3.20× 权益 > 上限 3×',
  '最坏净敞口 2.10× 权益 > 上限 2×',
  '风险簇 majors 敞口 1.60× 权益 > 上限 1.5×',
  '候选没有可验证的止损(缺失或在错误一侧),不能进入止损预算',
  '聚合止损预算 3.20% 权益 > 上限 3.00%',
  '已有 BTCUSDT/ETHUSDT 缺止损保护(名义 1200 USDT),先补保护再加风险',
  '接近上限(> 80%)',
  // 模型理由里的派生数来源标注
  'Breakout level 121.3 (由 E9.20根高 与 E9.ATR% 算出) is close.',
  'Price is 1.3 ATR away (by E9.距).',
  'Unrealized P&L 66.34 USDT(由 (E6.mark-E7.entry)×E7.qty 算出)',
];

describe('评审版英文层:入场方式 / 发送前复查 / 数量与组合检查', () => {
  const english = (): void => { process.env['TG_PUBLIC_DEMO'] = '1'; process.env['TG_PUBLIC_LANG'] = 'en'; };
  afterEach(() => { delete process.env['TG_PUBLIC_DEMO']; delete process.env['TG_PUBLIC_LANG']; });

  it('英文模式下每句都没有中文', () => {
    english();
    expect(SAMPLES.filter((s) => hasCjk(englishText(s)))).toEqual([]);
  });

  it('提议被拒按最外层括号切开,理由里的分号和括号不拆', () => {
    english();
    const e = englishText(SAMPLES[1]!);
    expect(e.startsWith('Proposal rejected: ')).toBe(true);
    expect(e).toContain('(reference: 120.9–121.1)');
    expect(e.split('; ').length).toBeGreaterThanOrEqual(2);
  });

  it('派生数标注译成 computed from,字段名给英文', () => {
    english();
    expect(englishText('Breakout level 121.3 (由 E9.20根高 与 E9.ATR% 算出) is close.')).toBe('Breakout level 121.3 (computed from E9.20-bar high and E9.ATR%) is close.');
    expect(englishText('Price is 1.3 ATR away (by E9.距).')).toBe('Price is 1.3 ATR away (by E9.distance).');
  });

  it('公网演示非英文模式:出口原样返回', () => {
    process.env['TG_PUBLIC_DEMO'] = '1';
    expect(publicView({ close_reason: '发送前行情过期' })).toEqual({ close_reason: '发送前行情过期' });
  });
});
