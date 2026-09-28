/**
 * R58 §七 / §八:下单台的**四象限**——内部语义 `(side, action)` 与交易所方言
 * (`BUY`/`SELL` + `positionSide`)之间唯一的一张映射表,双端共用。
 *
 * 为什么要有这个文件:内部 `side` 是**持仓方向**(开多/平多都是 `long`),不是
 * 买卖方向。后端 `binance.rs::side_for_order` 就是这么翻的:
 *
 * ```text
 * side=long  + action=open   → BUY  · positionSide=LONG   (开多)
 * side=short + action=open   → SELL · positionSide=SHORT  (开空)
 * side=long  + action=reduce → SELL · positionSide=LONG   (平多,reduceOnly)
 * side=short + action=reduce → BUY  · positionSide=SHORT  (平空,reduceOnly)
 * ```
 *
 * 单向账户上「买入」与「平空」碰巧同号,谁也不会被这套暧昧措辞害到;双向账户上
 * 它们是**两件完全不同的事**——「买入」可能是给多头加仓,也可能是把空头平掉,
 * 填错方向不会被 -4061 拦下,而是**反手开一个新仓**(§七 开头那条独有新风险)。
 * 所以下单台必须把四象限显式摆出来,不能让人从「买入 / 卖出 + 只减仓开关」里
 * 自己心算。
 *
 * hedge 下 `positionSide` 才会真的发出去;one-way 下后端根本不进注入分支
 * (§3.2 F1),这里给出的 `positionSide` 只用于**界面标注**,不改变请求。
 */

import type { PositionSide } from "./positionSide";

/** 内部 action。`close` 与 `reduce` 在方向语义上同类,下单台只产出 `reduce`。 */
export type OrderAction = "open" | "reduce";

export type OrderQuadrant = "open_long" | "open_short" | "close_long" | "close_short";

export interface QuadrantSpec {
  quadrant: OrderQuadrant;
  /** 内部 side = **持仓方向**(不是买卖方向)。 */
  side: PositionSide;
  action: OrderAction;
  /** 交易所 side。`close_long` 是 SELL、`close_short` 是 BUY——最容易搞反的一格。 */
  exchangeSide: "BUY" | "SELL";
  /** hedge 下随单发出的 positionSide;one-way 下仅用于标注。 */
  positionSide: "LONG" | "SHORT";
  reduceOnly: boolean;
  /** 主标签(en)。 */
  label: string;
  /** 副标签(en):交易所方言,消除「买入 = 平空?」这类歧义。 */
  hint: string;
}

export const ORDER_QUADRANTS: readonly QuadrantSpec[] = [
  {
    quadrant: "open_long",
    side: "long",
    action: "open",
    exchangeSide: "BUY",
    positionSide: "LONG",
    reduceOnly: false,
    label: "Open Long",
    hint: "BUY · LONG",
  },
  {
    quadrant: "open_short",
    side: "short",
    action: "open",
    exchangeSide: "SELL",
    positionSide: "SHORT",
    reduceOnly: false,
    label: "Open Short",
    hint: "SELL · SHORT",
  },
  {
    quadrant: "close_long",
    side: "long",
    action: "reduce",
    exchangeSide: "SELL",
    positionSide: "LONG",
    reduceOnly: true,
    label: "Close Long",
    hint: "SELL · LONG",
  },
  {
    quadrant: "close_short",
    side: "short",
    action: "reduce",
    exchangeSide: "BUY",
    positionSide: "SHORT",
    reduceOnly: true,
    label: "Close Short",
    hint: "BUY · SHORT",
  },
] as const;

/** 下单台既有状态 `(side, reduceOnly)` → 象限。表单状态不用改形状。 */
export function quadrantOf(side: PositionSide, reduceOnly: boolean): OrderQuadrant {
  if (side === "long") return reduceOnly ? "close_long" : "open_long";
  return reduceOnly ? "close_short" : "open_short";
}

export function quadrantSpec(quadrant: OrderQuadrant): QuadrantSpec {
  const found = ORDER_QUADRANTS.find((spec) => spec.quadrant === quadrant);
  // 四个字面量已被类型穷举,这里只是给运行时一个不 throw 的地板。
  // (trade-gate 的 tsconfig 开了 noUncheckedIndexedAccess,ORDER_QUADRANTS[0] 类型上
  // 是 QuadrantSpec | undefined;数组是本文件内的非空 const 字面量,! 是安全的。)
  return found ?? ORDER_QUADRANTS[0]!;
}

/** 该象限所操作的那一行仓的方向标签(en),用于持仓/挂单行的 positionSide 徽章。 */
export function positionSideLabel(side: PositionSide): "LONG" | "SHORT" {
  return side === "long" ? "LONG" : "SHORT";
}
