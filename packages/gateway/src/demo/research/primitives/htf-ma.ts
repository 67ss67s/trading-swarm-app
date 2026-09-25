/** 高周期均线状态原语 htf_ma_state(2026-09-23 夜)。计算见 htf.ts;单独成文件并在 index.ts 最后注册,原语目录顺序对旧原语不变。 */
import { define } from './registry.js';
import { htfMaParams, htfMaStates, htfMaHistory, seriesOf } from './htf.js';
export const htf_ma_state = define('htf_ma_state', 'regime',
  '高周期均线状态:最近一根已收盘的 htf K 线收盘价在其 MA(period) 之上(side=above,缺省)/之下(side=below);高周期 K 线由已收盘执行周期 K 线分桶聚成、只用完整的桶,不受 5000 根视图上限约束。做多用 regime,做空用 order.short_regime{side:below}',
  // 决策视图预热记 0:状态从整段已收盘 K 线(ctx.series)按下标取,不拉长视图;历史需求走 history_bars(取数时借)
  () => 0,
  (ctx, p) => {
    const x = htfMaParams(p), { series, i } = seriesOf(ctx);
    if (i < 0 || i >= series.length) return { pass: false };
    const s = htfMaStates(series, ctx.timeframe_ms, x)[i]!;
    return { pass: x.side === 'below' ? s === -1 : s === 1 };
  },
  htfMaHistory);
