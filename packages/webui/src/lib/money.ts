/**
 * 模型花费的显示。网关按人民币记(gateway demo/brain.ts BRAIN_PRICES_CNY,本来就是按牌价估的),
 * 中文界面照原样写 ¥;英文界面按固定汇率换成美元写 $,免得英文读者看到 ¥ 以为是日元或看不懂。
 * 花费本身就是估算,汇率用一个固定值就够了,不去拉实时汇率。
 */
import { getLang } from './i18n';

/** 1 美元约合多少人民币(只用于把估算花费换成美元显示) */
export const CNY_PER_USD = 7.1;

/**
 * 人民币金额 → 当前语言的显示:zh `¥0.12`,en `$0.02`。
 * 英文下金额大于 0 但按位数舍成 0 时写成 `<$0.01`,不显示成 0。
 */
export function fmtCost(cny: number | null | undefined, digits = 2): string {
  const v = cny === null || cny === undefined || !Number.isFinite(Number(cny)) ? 0 : Number(cny);
  if (getLang() !== 'en') return `¥${v.toFixed(digits)}`;
  const usd = v / CNY_PER_USD;
  const floor = 10 ** -digits;
  if (usd > 0 && usd < floor) return `<$${floor.toFixed(digits)}`;
  return `$${usd.toFixed(digits)}`;
}
