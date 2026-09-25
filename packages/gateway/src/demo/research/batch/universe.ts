/**
 * 批量研究的资产池(2026-09-23,设计见 docs/research/batch-study-2026-09-23.md 第二节)。
 * 口径:OKX「当前在售」的 USDT 现货,按近 90 个完整 UTC 日的报价币成交额(volCcyQuote 之和)排名,取前 N 个,
 *   排除稳定币、法币锚定币、黄金代币与包装/质押衍生币(它们的价格走势是别的资产的影子,不是独立的交易标的);
 *   要求同名 USDT 线性永续也在售(永续与资金费套利两条线要用)。
 * 幸存者偏差:只看「现在还在售、现在还活跃」的币,2018–2022 年间退市或沉寂的币不在池里,早期年份的结果偏乐观;报告里标注。
 * 本文件只放纯函数(排序与排除),联网取数在 scripts/research-batch/universe.ts。
 */

/** 稳定币 / 法币锚定 / 商品代币 / 包装与质押衍生币(按 base 币种名) */
export const EXCLUDED_BASES = new Set([
  'USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDE', 'SUSDE', 'PYUSD', 'USDD', 'BUSD', 'USDP', 'RLUSD', 'USD1', 'USDG', 'USDS', 'GUSD', 'USTC', 'FRAX', 'LUSD', 'CRVUSD', 'GHO', 'USDQ',
  'EUR', 'EURT', 'EURC', 'EURS', 'AEUR', 'TRY', 'BRL',
  'XAUT', 'PAXG',
  'WBTC', 'WETH', 'STETH', 'WSTETH', 'CBBTC', 'BETH', 'WBETH', 'WEETH', 'EETH', 'RETH', 'CBETH', 'OKSOL', 'JITOSOL', 'MSOL', 'BNSOL', 'LBTC', 'SOLVBTC', 'TBTC', 'FBTC', 'BTCB', 'WTRX', 'WBNB', 'STSOL', 'BBSOL',
]);
/** 名字看起来是稳定币/包装币的兜底规则(新发的 xxUSD、wXXX 等) */
export function looksExcluded(base: string): boolean {
  const b = base.toUpperCase();
  if (EXCLUDED_BASES.has(b)) return true;
  if (/^USD|USD$/.test(b) && b.length <= 6) return true;
  return false;
}
export interface UniverseCandidate { base: string; quote_volume_90d: number; days: number; has_swap: boolean; volume_24h?: number }
export interface UniverseMember extends UniverseCandidate { rank: number; symbol: string }
/**
 * 排名:剔除排除名单、缺永续、90 天里有效日数不足 min_days 的(新上市不到 90 天的币成交额不可比),按 90 天成交额降序取前 size 个;
 * 同额按 base 字母序,结果确定。
 */
export function rankUniverse(cands: UniverseCandidate[], opts: { size?: number; min_days?: number; require_swap?: boolean } = {}): { members: UniverseMember[]; dropped: { base: string; reason: string }[] } {
  const size = opts.size ?? 20, minDays = opts.min_days ?? 85, needSwap = opts.require_swap ?? true, dropped: { base: string; reason: string }[] = [];
  const ok = cands.filter((c) => {
    if (looksExcluded(c.base)) { dropped.push({ base: c.base, reason: 'stable_or_wrapped' }); return false; }
    if (needSwap && !c.has_swap) { dropped.push({ base: c.base, reason: 'no_usdt_swap' }); return false; }
    if (c.days < minDays) { dropped.push({ base: c.base, reason: `only_${c.days}_days` }); return false; }
    if (!(c.quote_volume_90d > 0)) { dropped.push({ base: c.base, reason: 'no_volume' }); return false; }
    return true;
  });
  ok.sort((a, b) => b.quote_volume_90d - a.quote_volume_90d || a.base.localeCompare(b.base));
  return { members: ok.slice(0, size).map((c, i) => ({ ...c, rank: i + 1, symbol: `${c.base.toUpperCase()}USDT` })), dropped };
}
