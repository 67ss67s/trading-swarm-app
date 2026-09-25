/**
 * R58 F10/F14:交易所行(持仓 / 挂单 / 成交)的方向口径,双端共用。
 *
 * 双向持仓(hedge)账户上同一个 symbol 会有 LONG / SHORT **两行**,方向由行自述的
 * `positionSide` 给出;单向账户每行都是 `BOTH`(或缺失),方向只能按净量的符号推。
 * 这里是前端唯一的方向来源——列表 key、按方向平仓、保护腿关系标签全走它,免得
 * 各页面各写一套 `positionAmt > 0 ? 多 : 空`(那在 hedge 下会把对侧腿贴错标签)。
 *
 * 与后端 `console_core::util::row_position_side_long` 同口径:`positionSide` 只认
 * LONG/SHORT,其余(BOTH / 缺失 / 空串)一律返回 undefined ⇒ 调用方退回旧口径 ⇒
 * **单向账户逐字节保持改造前行为**。
 */

export type PositionSide = "long" | "short";

type Rec = Record<string, unknown>;

/** 行自述的方向;BOTH / 缺失 / 非法值 → undefined(没有方向信息,不是猜错)。 */
export function rowPositionSide(row: Rec | null | undefined): PositionSide | undefined {
  const raw = String((row ?? {}).positionSide ?? "").trim().toUpperCase();
  if (raw === "LONG") return "long";
  if (raw === "SHORT") return "short";
  return undefined;
}

/**
 * 持仓行的方向:优先信 `positionSide`,缺失时按 `positionAmt` 符号兜底。
 * 单向账户走符号分支 ⇒ 与改造前一致。
 */
export function positionRowSide(row: Rec | null | undefined): PositionSide {
  const declared = rowPositionSide(row);
  if (declared) return declared;
  return Number((row ?? {}).positionAmt ?? 0) < 0 ? "short" : "long";
}

/**
 * 一张挂单是不是**这一行仓**的保护腿(方向匹配的平仓腿)。
 *
 * - hedge:挂单行自带 positionSide ⇒ 必须与持仓行同方向,且 side 是该方向的平仓方向
 *   (多头被平是 SELL、空头被平是 BUY)。这条是关键——单看 side 的话,一张
 *   「开空的 SELL」会被当成「保护多头」贴错标签;
 * - one-way / 挂单行没有 positionSide:退回旧口径(只比平仓方向),现行为不变。
 */
export function isProtectiveLegFor(order: Rec, positionSide: PositionSide): boolean {
  const closeSide = positionSide === "long" ? "SELL" : "BUY";
  if (String(order.side ?? "").toUpperCase() !== closeSide) return false;
  const orderSide = rowPositionSide(order);
  return orderSide === undefined || orderSide === positionSide;
}
