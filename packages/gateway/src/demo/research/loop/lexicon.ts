/**
 * 指标 / 形态 / 数据指标词典(§9.45)。
 *
 * 纯数据表:中英文术语 → 本仓库里真实存在的实现。概念解析(concepts.ts)先查原语目录,再查这里;
 * 这里查不到的才叫「未映射」,由 acquire_concept 子 loop 去获取。
 *
 * 三条维护纪律:
 * 1. `target` 只能写真实存在的东西 —— 原语目录里的 name、data adapter 的 metric、或 indicators.ts 指标表的行名;
 *    没有实现就写 `kind:'unsupported'`,不要用一个形似的原语冒充。
 * 2. 近似映射必须 `approximate:true` 并在 note 里写清近似在哪(例:死叉没有原语,用 trend_break 破位近似)。
 * 3. terms 全部小写;中文按子串匹配,纯 ASCII 词按单词边界匹配,长词优先(顶背离 先于 背离)。
 */
export type LexiconKind =
  | "primitive" // 原语目录里已有实现
  | "data_metric" // data adapter 的指标(price/funding/open_interest/...)
  | "indicator_row" // 指标表里有这一行,但还没有通用原语覆盖这种用法
  | "comparison" // 由回测/分析步骤完成,不是原语
  | "timeframe"
  | "asset"
  | "unsupported"; // 已知概念但本仓库没有实现,需要 Pine 或新原语

export type ConceptCategory =
  | "indicator"
  | "pattern"
  | "structure"
  | "data_metric"
  | "comparison"
  | "timeframe"
  | "asset"
  | "risk";

export interface LexiconEntry {
  /** 规范概念 id,跨中英文唯一 */
  id: string;
  /** 全部小写的别名;中文子串匹配,ASCII 单词边界匹配 */
  terms: string[];
  category: ConceptCategory;
  kind: LexiconKind;
  /** 原语名 / 数据 metric / 指标表行名 / 时间周期代号 / 资产符号;unsupported 为 null */
  target: string | null;
  /** 通用原语(indicator_cross / indicator_threshold …)要带的固定参数,例如 {indicator:'bbands'} */
  params?: Record<string, unknown>;
  /** 近似映射(语义不完全一致),必须在 note 里说明差异 */
  approximate?: boolean;
  note: string;
}

export const LEXICON: LexiconEntry[] = [
  // ── 指标与信号 ─────────────────────────────────────────────────────────
  { id: "ema_cross", terms: ["金叉", "黄金交叉", "均线金叉", "均线上穿", "均线交叉", "ema cross", "golden cross", "ma cross"], category: "indicator", kind: "primitive", target: "ema_cross", note: "快 EMA 上穿慢 EMA。" },
  { id: "ema_death_cross", terms: ["死叉", "死亡交叉", "均线下穿", "跌破均线", "death cross"], category: "indicator", kind: "primitive", target: "trend_break", approximate: true, note: "没有下穿信号原语;用 trend_break(收盘跌破 EMA)近似,触发时点与经典死叉不完全一致。" },
  { id: "moving_average", terms: ["均线", "移动平均", "moving average", "sma", "ema"], category: "indicator", kind: "primitive", target: "ema_cross", approximate: true, note: "单条均线本身不是信号;交叉用 ema_cross(或 indicator_cross + sma/ema 行),破位用 trend_break。" },
  { id: "macd", terms: ["macd", "指数平滑异同"], category: "indicator", kind: "primitive", target: "macd_cross", note: "MACD 线上穿信号线。" },
  { id: "macd_cross", terms: ["macd 金叉", "macd金叉", "macd 上穿"], category: "indicator", kind: "primitive", target: "macd_cross", note: "MACD 线上穿信号线。" },
  { id: "bullish_divergence", terms: ["底背离", "看涨背离", "正背离", "bullish divergence"], category: "indicator", kind: "primitive", target: "macd_divergence", note: "价格创更低的已确认 pivot low 而 MACD 抬高,确认当根触发。" },
  { id: "bearish_divergence", terms: ["顶背离", "看跌背离", "负背离", "bearish divergence"], category: "indicator", kind: "primitive", target: "macd_divergence_exit", note: "顶背离只作为离场原语,不作入场。" },
  { id: "divergence", terms: ["背离", "divergence"], category: "indicator", kind: "primitive", target: "macd_divergence", approximate: true, note: "未指明方向时按底背离(入场)处理;换指标用 indicator_divergence + 指标行。" },
  { id: "rsi", terms: ["rsi", "相对强弱指标"], category: "indicator", kind: "primitive", target: "rsi_threshold", note: "Wilder RSI 越过阈值。" },
  { id: "overbought", terms: ["超买"], category: "indicator", kind: "primitive", target: "rsi_threshold", approximate: true, note: "按 RSI above 阈值实现,阈值需要指定(默认 70)。" },
  { id: "oversold", terms: ["超卖"], category: "indicator", kind: "primitive", target: "rsi_threshold", approximate: true, note: "按 RSI below 阈值实现,阈值需要指定(默认 30)。" },
  { id: "donchian_breakout", terms: ["唐奇安", "donchian", "通道突破"], category: "indicator", kind: "primitive", target: "donchian_breakout", note: "突破此前 N 根通道上沿。" },
  { id: "breakout", terms: ["突破", "创新高", "breakout"], category: "indicator", kind: "primitive", target: "donchian_breakout", approximate: true, note: "按唐奇安通道突破实现;若指的是形态颈线突破,需要新原语。" },
  { id: "volume_surge", terms: ["放量", "成交量放大", "爆量", "volume surge"], category: "indicator", kind: "primitive", target: "volume_surge", note: "成交量达到此前均量倍数。" },
  { id: "atr", terms: ["atr", "真实波幅", "平均真实波幅"], category: "indicator", kind: "primitive", target: "atr_stop", note: "ATR 只在止损/追踪里使用。" },
  { id: "bollinger", terms: ["布林", "布林带", "布林线", "bollinger", "boll"], category: "indicator", kind: "primitive", target: "indicator_cross", params: { indicator: "bbands", output: "upper" }, note: "指标表 bbands 行 + 通用穿越原语;看 %b 或中轨时改 output/params。" },
  { id: "stochastic", terms: ["kdj", "随机指标", "stochastic"], category: "indicator", kind: "primitive", target: "indicator_threshold", params: { indicator: "stoch" }, note: "指标表 stoch 行(KD);超买超卖用阈值原语。" },
  { id: "stochrsi", terms: ["stochrsi", "随机rsi", "随机 rsi"], category: "indicator", kind: "primitive", target: "indicator_threshold", params: { indicator: "stochrsi" }, note: "指标表 stochrsi 行。" },
  { id: "adx", terms: ["adx", "dmi", "趋势强度", "趋向指标"], category: "indicator", kind: "primitive", target: "indicator_threshold", params: { indicator: "adx" }, note: "指标表 adx 行;也可用 trend_state 把 ADX 折成 up/down/range。" },
  { id: "obv", terms: ["obv", "能量潮"], category: "indicator", kind: "primitive", target: "indicator_cross", params: { indicator: "obv", compare_to: "indicator", compare_indicator: "sma" }, note: "指标表 obv 行;常用法是 OBV 与自身均线交叉。" },
  { id: "vwap", terms: ["vwap", "成交量加权均价"], category: "indicator", kind: "primitive", target: "indicator_cross", params: { indicator: "vwap" }, note: "指标表 vwap 行,按 UTC 日重置;价格上穿/下穿 VWAP。" },
  { id: "cci", terms: ["cci", "顺势指标"], category: "indicator", kind: "primitive", target: "indicator_threshold", params: { indicator: "cci" }, note: "指标表 cci 行。" },
  { id: "ichimoku", terms: ["一目均衡表", "云图", "一目", "ichimoku"], category: "indicator", kind: "primitive", target: "indicator_cross", params: { indicator: "ichimoku" }, note: "指标表 ichimoku 行;先行 A/B 按当根能看到的云取值,无前视。" },
  { id: "supertrend", terms: ["超级趋势", "supertrend"], category: "indicator", kind: "primitive", target: "indicator_cross", params: { indicator: "supertrend" }, note: "指标表 supertrend 行。" },
  { id: "keltner", terms: ["肯特纳", "keltner"], category: "indicator", kind: "primitive", target: "indicator_cross", params: { indicator: "keltner", output: "upper" }, note: "指标表 keltner 行。" },
  { id: "parabolic_sar", terms: ["抛物线", "sar", "parabolic", "停损转向"], category: "indicator", kind: "primitive", target: "indicator_cross", params: { indicator: "psar" }, note: "指标表 psar 行。" },
  { id: "williams_r", terms: ["威廉指标", "威廉", "williams"], category: "indicator", kind: "primitive", target: "indicator_threshold", params: { indicator: "willr" }, note: "指标表 willr 行。" },
  { id: "mfi", terms: ["mfi", "资金流量指标", "资金流量"], category: "indicator", kind: "primitive", target: "indicator_threshold", params: { indicator: "mfi" }, note: "指标表 mfi 行。" },
  { id: "cmf", terms: ["蔡金资金流", "cmf"], category: "indicator", kind: "primitive", target: "indicator_threshold", params: { indicator: "cmf" }, note: "指标表 cmf 行。" },
  { id: "volume_ratio", terms: ["量比", "相对成交量"], category: "indicator", kind: "primitive", target: "indicator_threshold", params: { indicator: "volume_ratio" }, note: "指标表 volume_ratio 行;与 volume_surge 口径不同(比值 vs 倍数)。" },
  { id: "momentum", terms: ["动量", "roc", "momentum", "变动率", "涨跌幅"], category: "indicator", kind: "primitive", target: "indicator_threshold", params: { indicator: "roc" }, note: "指标表 roc 行。" },
  { id: "trix", terms: ["trix", "三重指数平滑"], category: "indicator", kind: "primitive", target: "indicator_threshold", params: { indicator: "trix" }, note: "指标表 trix 行。" },
  { id: "aroon", terms: ["阿隆", "aroon"], category: "indicator", kind: "primitive", target: "indicator_threshold", params: { indicator: "aroon" }, note: "指标表 aroon 行。" },
  { id: "vortex", terms: ["涡旋指标", "vortex"], category: "indicator", kind: "primitive", target: "indicator_cross", params: { indicator: "vortex" }, note: "指标表 vortex 行。" },
  { id: "choppiness", terms: ["震荡指数", "盘整指数", "choppiness"], category: "indicator", kind: "primitive", target: "indicator_threshold", params: { indicator: "chop" }, note: "指标表 chop 行,常用来判断是否横盘。" },
  { id: "ultimate_oscillator", terms: ["终极震荡", "终极摆动"], category: "indicator", kind: "primitive", target: "indicator_threshold", params: { indicator: "uo" }, note: "指标表 uo 行。" },
  { id: "awesome_oscillator", terms: ["动量震荡指标", "awesome"], category: "indicator", kind: "primitive", target: "indicator_threshold", params: { indicator: "ao" }, note: "指标表 ao 行。" },
  { id: "elder_ray", terms: ["多空力量", "艾达透视", "elder"], category: "indicator", kind: "primitive", target: "indicator_threshold", params: { indicator: "elder_ray" }, note: "指标表 elder_ray 行。" },
  { id: "kama", terms: ["自适应均线", "考夫曼", "kama"], category: "indicator", kind: "primitive", target: "indicator_cross", params: { indicator: "kama" }, note: "指标表 kama 行。" },
  { id: "hull_ma", terms: ["赫尔均线", "hull", "hma"], category: "indicator", kind: "primitive", target: "indicator_cross", params: { indicator: "hma" }, note: "指标表 hma 行。" },
  { id: "volatility", terms: ["波动率", "标准差", "volatility"], category: "indicator", kind: "primitive", target: "indicator_threshold", params: { indicator: "stdev" }, note: "指标表 stdev 行;归一化波动用 natr 行。" },

  // ── 形态与结构 ─────────────────────────────────────────────────────────
  { id: "order_blocks", terms: ["订单块", "order block", "ob 区"], category: "structure", kind: "primitive", target: "order_blocks", note: "已确认 pivot 形成的供需块,止损与目标都从这里取。" },
  { id: "break_of_structure", terms: ["结构突破", "break of structure", "bos"], category: "structure", kind: "primitive", target: "smc_bos", params: { kind: "bos" }, note: "SMC 结构突破:收盘越过已确认的内部(scope=internal)或摆动(swing)pivot;顺势为 BOS。旧原语 structure_bos 仍可用。" },
  { id: "change_of_character", terms: ["结构转换", "choch", "change of character"], category: "structure", kind: "primitive", target: "smc_bos", params: { kind: "choch" }, note: "SMC 反转突破:此前趋势与突破方向相反的那次突破;离场用 smc_choch_exit。" },
  { id: "pivot", terms: ["枢轴", "摆动点", "pivot", "swing point"], category: "structure", kind: "primitive", target: "structure_pivots", note: "左右各 swing 根确认的高低点。" },
  { id: "higher_low", terms: ["低点抬高", "抬高低点", "higher low"], category: "structure", kind: "primitive", target: "higher_low_sequence", note: "连续 N 根低点抬高。" },
  { id: "trend_state", terms: ["趋势状态", "多头排列", "空头排列", "趋势方向"], category: "structure", kind: "primitive", target: "trend_state", note: "EMA 排列 + ADX 给出 up/down/range。" },
  { id: "htf_structure", terms: ["高周期结构", "大周期结构", "htf"], category: "structure", kind: "primitive", target: "htf_structure", note: "高周期结构块,要求高周期 bar 完整收盘。" },
  { id: "regime", terms: ["市场环境", "regime", "日线结构方向"], category: "structure", kind: "primitive", target: "htf_structure_regime", note: "日线结构决定允许的方向与位置上限。" },
  { id: "fair_value_gap", terms: ["公允价值缺口", "fvg", "fair value gap"], category: "pattern", kind: "primitive", target: "smc_fvg_fill", note: "SMC FVG 回补:价格回到此前形成的缺口(自动阈值过滤小缺口);只要缺口形成那一根用 fair_value_gap。" },
  { id: "liquidity_sweep", terms: ["流动性扫荡", "猎杀止损", "插针", "stop hunt", "liquidity sweep"], category: "pattern", kind: "unsupported", target: null, note: "没有扫荡原语;需要先定义「扫过前高/前低后收回」的判定与确认时点。" },
  { id: "double_top", terms: ["双顶", "m 头", "double top"], category: "pattern", kind: "primitive", target: "double_top_exit", approximate: true, note: "只有离场版(收盘跌破颈线离场),没有做空入场版。" },
  { id: "double_bottom", terms: ["双底", "w 底", "double bottom"], category: "pattern", kind: "primitive", target: "double_bottom", note: "两个齐平的已确认 pivot low + 颈线,收盘首次突破颈线当根触发。" },
  { id: "head_and_shoulders", terms: ["头肩底", "头肩顶", "head and shoulders"], category: "pattern", kind: "primitive", target: "head_and_shoulders_inverse", approximate: true, note: "只有头肩底(做多)原语;头肩顶没有对应离场原语。" },
  { id: "triangle", terms: ["三角形整理", "收敛三角", "triangle"], category: "pattern", kind: "unsupported", target: null, note: "需要趋势线拟合,没有实现。" },
  { id: "flag", terms: ["旗形", "flag pattern"], category: "pattern", kind: "unsupported", target: null, note: "需要趋势线拟合,没有实现。" },
  { id: "engulfing", terms: ["吞没", "engulfing"], category: "pattern", kind: "primitive", target: "bullish_engulfing", approximate: true, note: "入场用看涨吞没;看跌吞没是离场原语 bearish_engulfing_exit。" },
  { id: "inside_bar", terms: ["内包", "母子线", "inside bar"], category: "pattern", kind: "primitive", target: "inside_bar_breakout", note: "母线后连续内包线,收盘首次突破母线高点当根触发。" },
  { id: "hammer", terms: ["锤子线", "长下影", "pin bar", "hammer"], category: "pattern", kind: "primitive", target: "pin_bar", note: "下影至少是实体的若干倍,实体与上影都受限。" },
  { id: "doji", terms: ["十字星", "doji"], category: "pattern", kind: "unsupported", target: null, note: "K 线形态未实现。" },
  { id: "gap", terms: ["跳空", "gap up", "gap down"], category: "pattern", kind: "unsupported", target: null, note: "加密永续基本无跳空;回放引擎有跳空钳制,但没有跳空信号原语。" },
  { id: "support_resistance", terms: ["支撑位", "阻力位", "支撑", "阻力", "support", "resistance"], category: "structure", kind: "primitive", target: "order_blocks", approximate: true, note: "用订单块的上下沿代表支撑/阻力,不是画线得到的水平位。" },
  { id: "trendline", terms: ["趋势线", "trend line"], category: "pattern", kind: "unsupported", target: null, note: "画线类概念没有代码实现,模型也不允许吐画线坐标。" },
  { id: "fibonacci", terms: ["斐波那契", "回撤位", "fib"], category: "pattern", kind: "unsupported", target: null, note: "没有斐波那契原语;可用结构块位置替代。" },

  // ── SMC(聪明钱概念,primitives/smc.ts;概念参照 LuxAlgo SMC 功能清单,自研实现)──────────
  { id: "smc", terms: ["smc", "聪明钱", "聪明钱概念", "smart money", "smart money concepts"], category: "structure", kind: "primitive", target: "smc_bos", note: "SMC 原语族:smc_bos(BOS/CHoCH)、smc_trend(结构方向门)、smc_ob_retest/smc_ob_level(订单块)、smc_fvg_fill(FVG)、smc_discount(溢价/折价)、smc_liquidity_target(流动性止盈)、smc_choch_exit(反向 CHoCH 离场)。" },
  { id: "smc_trend", terms: ["摆动结构", "内部结构", "市场结构", "结构趋势", "结构看涨", "结构看跌", "swing structure", "internal structure", "market structure"], category: "structure", kind: "primitive", target: "smc_trend", note: "最近一次结构突破的方向;摆动级别 swing_length 缺省 50,内部级别 internal_length 缺省 5。" },
  { id: "smc_order_block", terms: ["看涨订单块", "看跌订单块", "回踩订单块", "订单块回踩", "ob 回踩", "ob", "bullish order block", "bearish order block", "order block retest"], category: "structure", kind: "primitive", target: "smc_ob_retest", note: "SMC 订单块:结构突破时取回落段最低处最后一根反向 K 线;回踩 = 触及未失效块。限价/止损价位用 smc_ob_level。" },
  { id: "smc_ob_level", terms: ["订单块上沿", "订单块下沿", "订单块止损", "order block stop"], category: "risk", kind: "primitive", target: "smc_ob_level", note: "多单:最近未失效看涨订单块上沿挂限价、下沿止损;空单镜像。" },
  { id: "smc_premium", terms: ["溢价区", "premium zone"], category: "structure", kind: "primitive", target: "smc_discount", params: { zone: "premium" }, note: "收盘位于最近摆动高低区间的上半。" },
  { id: "smc_discount", terms: ["折价区", "discount zone"], category: "structure", kind: "primitive", target: "smc_discount", params: { zone: "discount" }, note: "收盘位于最近摆动高低区间的下半。" },
  { id: "smc_equilibrium", terms: ["均衡区", "equilibrium"], category: "structure", kind: "primitive", target: "smc_discount", params: { zone: "equilibrium" }, note: "收盘位于区间中线 ±2.5%。" },
  { id: "smc_equal_levels", terms: ["等高点", "等低点", "等高等低", "equal highs", "equal lows", "eqh", "eql"], category: "structure", kind: "primitive", target: "smc_liquidity_target", params: { source: "equal" }, note: "相邻 pivot 高(低)点之差小于 0.1×ATR;常作止盈目标(被扫前)。" },
  { id: "smc_liquidity", terms: ["流动性", "上方流动性", "下方流动性", "买方流动性", "卖方流动性", "liquidity", "buy-side liquidity", "sell-side liquidity"], category: "risk", kind: "primitive", target: "smc_liquidity_target", note: "止盈取最近未被扫的摆动高点/等高点/区间顶(空单取下方)。" },
  { id: "smc_strong_weak", terms: ["强高点", "弱高点", "强低点", "弱低点", "strong high", "weak high", "strong low", "weak low"], category: "structure", kind: "primitive", target: "smc_liquidity_target", approximate: true, note: "弱高(低)点即待扫的流动性,止盈用 smc_liquidity_target;强弱标注本身只在回放图层显示。" },
  { id: "smc_prev_levels", terms: ["前日高点", "前日低点", "昨日高点", "昨日低点", "上周高点", "上周低点", "pdh", "pdl", "pwh", "pwl"], category: "structure", kind: "primitive", target: "smc_liquidity_target", params: { source: "prev_day" }, approximate: true, note: "前一 UTC 日/周的高低点,作止盈参考(source=prev_day / prev_week)。" },
  { id: "smc_choch_exit", terms: ["choch 离场", "反向 choch", "结构转换离场", "choch exit"], category: "risk", kind: "primitive", target: "smc_choch_exit", note: "持仓中出现反向 CHoCH 当根离场。" },

  // ── 风险、离场与仓位 ───────────────────────────────────────────────────
  { id: "stop_loss", terms: ["止损", "stop loss"], category: "risk", kind: "primitive", target: "atr_stop", approximate: true, note: "止损来源优先结构位(swing_low_stop / order_blocks),没说结构时用 ATR 止损。" },
  { id: "structure_stop", terms: ["结构止损", "前低止损", "swing low stop"], category: "risk", kind: "primitive", target: "swing_low_stop", note: "以最近 N 根最低点为初始止损。" },
  { id: "trailing_stop", terms: ["移动止损", "追踪止损", "吊灯", "chandelier", "trailing stop"], category: "risk", kind: "primitive", target: "chandelier_trail", note: "吊灯追踪,不替代止盈目标。" },
  { id: "take_profit", terms: ["止盈", "目标位", "take profit"], category: "risk", kind: "primitive", target: "structure_target", note: "优先用上方阻力块下沿作目标。" },
  { id: "fixed_r_target", terms: ["盈亏比目标", "固定盈亏比", "2r", "3r"], category: "risk", kind: "primitive", target: "fixed_r_target", note: "按初始风险倍数设目标。" },
  { id: "breakeven", terms: ["保本", "移动到成本", "breakeven"], category: "risk", kind: "primitive", target: "breakeven_after_r", note: "到达 R 倍后把止损推到成本。" },
  { id: "time_stop", terms: ["时间止损", "持有到期", "time stop"], category: "risk", kind: "primitive", target: "time_stop", note: "持有 N 根后离场。" },
  { id: "position_size", terms: ["仓位", "仓位管理", "position size"], category: "risk", kind: "primitive", target: "risk_fraction", note: "按单笔风险比例定量。" },
  { id: "equal_notional", terms: ["等额", "等名义", "equal notional"], category: "risk", kind: "primitive", target: "equal_notional", note: "等名义仓位。" },
  { id: "risk_per_trade", terms: ["单笔风险", "风险比例", "risk per trade"], category: "risk", kind: "primitive", target: "risk_fraction", note: "单笔风险占权益比例。" },
  { id: "beta_limit", terms: ["beta 上限", "贝塔"], category: "risk", kind: "primitive", target: "beta_max", note: "组合层 beta 上限过滤。" },
  { id: "residual_sharpe", terms: ["残差夏普", "residual sharpe"], category: "risk", kind: "primitive", target: "residual_sharpe_min", note: "剔除大盘后的夏普下限过滤。" },
  { id: "market_order", terms: ["市价", "次开盘价", "market order"], category: "risk", kind: "primitive", target: "next_open_market", note: "信号确认后下一根开盘价成交,避免未来函数。" },
  { id: "trend_filter", terms: ["趋势过滤", "顺势", "trend filter"], category: "risk", kind: "primitive", target: "trend_required", note: "只在指定趋势状态下允许开仓。" },
  { id: "trend_break_exit", terms: ["破位离场", "趋势破位", "trend break"], category: "risk", kind: "primitive", target: "trend_break", note: "收盘跌破 EMA 离场。" },

  // ── 数据指标 ───────────────────────────────────────────────────────────
  { id: "price", terms: ["价格", "行情", "k线", "k 线", "收盘价", "price"], category: "data_metric", kind: "data_metric", target: "price", note: "OKX K 线快照。" },
  { id: "volume", terms: ["成交量", "量能", "volume"], category: "data_metric", kind: "data_metric", target: "price", note: "成交量在价格快照的 volume 列。" },
  { id: "funding", terms: ["资金费", "资金费率", "funding"], category: "data_metric", kind: "data_metric", target: "funding", note: "已结算资金费率;现货不适用,下一期预测未接。" },
  { id: "open_interest", terms: ["持仓量", "未平仓", "open interest", "oi"], category: "data_metric", kind: "data_metric", target: "open_interest", note: "永续持仓量,现货不适用。" },
  { id: "liquidations", terms: ["清算", "爆仓", "强平", "liquidation"], category: "data_metric", kind: "data_metric", target: "liquidations", note: "公共接口只给最近若干条,窗口覆盖通常是 partial。" },
  { id: "liquidation_heatmap", terms: ["清算热图", "清算估计", "liquidation heatmap"], category: "data_metric", kind: "data_metric", target: "liquidation_estimates", note: "估计数据源尚未接入,不伪造。" },
  { id: "orderbook", terms: ["订单簿", "盘口", "深度", "orderbook", "order book"], category: "data_metric", kind: "data_metric", target: "orderbook", note: "订单簿快照未接。" },
  { id: "leverage", terms: ["杠杆", "杠杆升温", "leverage"], category: "data_metric", kind: "data_metric", target: "open_interest", approximate: true, note: "没有直接的杠杆指标;用持仓量 + 资金费 + 清算三者组合观察。" },
  { id: "basis", terms: ["基差", "期现价差", "basis"], category: "data_metric", kind: "unsupported", target: null, note: "现货与永续的价差没有专门采集口径。" },
  { id: "premium_index", terms: ["溢价指数", "premium index"], category: "data_metric", kind: "unsupported", target: null, note: "未接。" },
  { id: "long_short_ratio", terms: ["多空比", "long short ratio"], category: "data_metric", kind: "unsupported", target: null, note: "未接。" },

  // ── 比较与评价 ─────────────────────────────────────────────────────────
  { id: "buy_and_hold", terms: ["一直持有", "买入持有", "持有", "buy and hold", "hodl"], category: "comparison", kind: "comparison", target: "compare_buy_and_hold", note: "同窗口持有基准,由回测步骤计算。" },
  { id: "relative_strength", terms: ["谁更强", "跑赢", "相对强弱", "更强", "outperform"], category: "comparison", kind: "comparison", target: "analyze_relative_strength", note: "相对大盘的 β/α/残差夏普。" },
  { id: "benchmark", terms: ["大盘", "基准", "benchmark"], category: "comparison", kind: "comparison", target: "analyze_relative_strength", note: "默认基准是 BTC 现货。" },
  { id: "backtest", terms: ["回测", "历史验证", "backtest"], category: "comparison", kind: "comparison", target: "run_backtest", note: "只跑开发段,扣除手续费与滑点。" },
  { id: "drawdown", terms: ["回撤", "最大回撤", "drawdown"], category: "comparison", kind: "comparison", target: "run_backtest", note: "回测产物里的指标,不是单独数据源。" },
  { id: "sharpe", terms: ["夏普", "sharpe"], category: "comparison", kind: "comparison", target: "run_backtest", note: "回测产物里的指标。" },
  { id: "win_rate", terms: ["胜率", "win rate"], category: "comparison", kind: "comparison", target: "run_backtest", note: "样本不足 30 笔时不作结论。" },
  { id: "profit_factor", terms: ["盈亏比", "盈利因子", "profit factor"], category: "comparison", kind: "comparison", target: "run_backtest", note: "回测产物里的指标。" },
  { id: "parameter_sweep", terms: ["参数", "不同参数", "调参", "参数敏感", "sweep"], category: "comparison", kind: "comparison", target: "run_backtest", note: "同一策略多组参数各回测一次,不做自动寻优。" },
  { id: "frequency", terms: ["频率", "出现次数", "多久出现", "多久一次", "how often"], category: "comparison", kind: "comparison", target: "analyze_pattern_frequency", note: "统计信号在窗口里的出现次数与随后 N 根收益,不下单。" },

  // ── 周期 ───────────────────────────────────────────────────────────────
  { id: "tf_1d", terms: ["日线", "日k", "daily"], category: "timeframe", kind: "timeframe", target: "1d", note: "日线。" },
  { id: "tf_4h", terms: ["4小时", "四小时", "4h"], category: "timeframe", kind: "timeframe", target: "4h", note: "4 小时。" },
  { id: "tf_1h", terms: ["小时线", "1小时", "一小时", "hourly", "1h"], category: "timeframe", kind: "timeframe", target: "1h", note: "1 小时。" },
  { id: "tf_30m", terms: ["30分钟", "半小时", "30m"], category: "timeframe", kind: "timeframe", target: "30m", note: "30 分钟。" },
  { id: "tf_15m", terms: ["15分钟", "15m"], category: "timeframe", kind: "timeframe", target: "15m", note: "15 分钟。" },
  { id: "tf_5m", terms: ["5分钟", "5m"], category: "timeframe", kind: "timeframe", target: "5m", note: "5 分钟。" },
  { id: "tf_1w", terms: ["周线", "weekly"], category: "timeframe", kind: "unsupported", target: null, note: "周期代号只认 ^\\d+(m|h|d)$;周线未接,只能退回日线。" },

  // ── 资产中文名 ─────────────────────────────────────────────────────────
  { id: "asset_btc", terms: ["比特币", "大饼"], category: "asset", kind: "asset", target: "BTC", note: "BTC。" },
  { id: "asset_eth", terms: ["以太坊", "以太"], category: "asset", kind: "asset", target: "ETH", note: "ETH。" },
  { id: "asset_sol", terms: ["索拉纳"], category: "asset", kind: "asset", target: "SOL", note: "SOL。" },
  { id: "asset_doge", terms: ["狗狗币"], category: "asset", kind: "asset", target: "DOGE", note: "DOGE。" },
];

/** term(已小写)→ 条目;同一别名只允许出现一次,重复即为词典缺陷。 */
const BY_TERM = new Map<string, LexiconEntry>();
for (const entry of LEXICON)
  for (const term of entry.terms) {
    const key = term.toLowerCase();
    if (BY_TERM.has(key))
      throw Error("lexicon_duplicate_term:" + key);
    BY_TERM.set(key, entry);
  }

/** 长词优先,保证「顶背离」不会先被「背离」吃掉。 */
const TERMS_BY_LENGTH = [...BY_TERM.keys()].sort((a, b) => b.length - a.length);

export function lexiconEntry(id: string): LexiconEntry | undefined {
  return LEXICON.find((e) => e.id === id);
}

export function lookupTerm(term: string): LexiconEntry | undefined {
  return BY_TERM.get(term.trim().toLowerCase());
}

const ASCII = /^[\x20-\x7e]+$/;

/** 纯 ASCII 词要求单词边界(rsi 不能命中 "rsix");中文直接子串匹配。 */
function indexOfTerm(haystack: string, term: string, from: number): number {
  if (!ASCII.test(term)) return haystack.indexOf(term, from);
  for (let at = haystack.indexOf(term, from); at >= 0; at = haystack.indexOf(term, at + 1)) {
    const before = haystack[at - 1], after = haystack[at + term.length];
    if (!(before && /[a-z0-9]/.test(before)) && !(after && /[a-z0-9]/.test(after)))
      return at;
  }
  return -1;
}

export interface LexiconMatch {
  entry: LexiconEntry;
  /** 命中的原文片段(原始大小写) */
  term: string;
  at: number;
}

/**
 * 在问题里扫词典。长词优先并占位:一段文字只归属一个概念,后面的短词不会再重复命中同一段。
 * 返回按出现顺序排列的命中,同一 id 只保留第一次。
 */
export function matchLexicon(question: string): LexiconMatch[] {
  const lower = question.toLowerCase();
  const taken = new Array<boolean>(lower.length).fill(false);
  const found: LexiconMatch[] = [];
  for (const term of TERMS_BY_LENGTH) {
    for (let at = indexOfTerm(lower, term, 0); at >= 0; at = indexOfTerm(lower, term, at + 1)) {
      let free = true;
      for (let i = at; i < at + term.length; i++) if (taken[i]) free = false;
      if (!free) continue;
      for (let i = at; i < at + term.length; i++) taken[i] = true;
      found.push({ entry: BY_TERM.get(term)!, term: question.slice(at, at + term.length), at });
    }
  }
  found.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  return found.filter((m) => !seen.has(m.entry.id) && seen.add(m.entry.id));
}

/** 词典扫完后仍未被认领的字符;未知概念探测只在这些片段上做,避免把已识别的词再拆一遍。 */
export function leftoverText(question: string): string {
  const lower = question.toLowerCase();
  const taken = new Array<boolean>(lower.length).fill(false);
  for (const term of TERMS_BY_LENGTH)
    for (let at = indexOfTerm(lower, term, 0); at >= 0; at = indexOfTerm(lower, term, at + 1)) {
      let free = true;
      for (let i = at; i < at + term.length; i++) if (taken[i]) free = false;
      if (!free) continue;
      for (let i = at; i < at + term.length; i++) taken[i] = true;
    }
  return question
    .split("")
    .map((c, i) => (taken[i] ? " " : c))
    .join("");
}
