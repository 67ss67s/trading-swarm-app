/**
 * 房间里的「装饰数字」(交易台跑马灯、组合台饼图百分比、各币敞口柱)——原型里是写死的假数,
 * 接真数据后由外壳在 setData 时写进这里,两套引擎的房间绘制直接读。没有数据时显示「—」,不编数。
 */
export interface Deco {
  /** 跑马灯:观察币最新价 + 最近一笔成交 */
  tape: { text: string; tone: 'up' | 'down' | 'hi' }[];
  /** 总敞口(权益百分比),null = 没有组合快照 */
  exposurePct: string | null;
  /** 各币毛敞口 / 权益(0–1,最多 5 个) */
  byCoin: [string, number][];
  /** 账本墙:每行一笔持仓 [币, 方向, 数量, 开仓价, 标记价, 未实现盈亏](最多 9 行) */
  ledger: string[][];
}

export const DECO: Deco = { tape: [], exposurePct: null, byCoin: [], ledger: [] };

export function setDeco(d: Deco): void {
  DECO.tape = d.tape;
  DECO.exposurePct = d.exposurePct;
  DECO.byCoin = d.byCoin;
  DECO.ledger = d.ledger;
}
