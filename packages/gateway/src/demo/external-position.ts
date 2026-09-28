// 外部仓位:交易账户上不是本网关开的仓(例如 okx-demo 模拟盘上手动开的 BTC 空单,自带 OCO 止损/止盈)。
// 规则(评审版):只显示,不平仓、不改保护单、不重挂、不当孤儿处理;只有 owner 能手动平,访客的平仓/改单接口一律 403 judge_locked。
//
// 判定:没有线程认领的仓位里,
//   1. 品种在 TG_EXTERNAL_POSITIONS(逗号分隔,如 BTCUSDT)里 → 外部;
//   2. 或同品种挂着不是本网关下的保护单(客户端 id 不以 tgd 开头)→ 外部(有人在管它);
// 否则当作自家孤儿仓(重启留下的金丝雀等),沿用原来的接管口径。
import type { AccountView } from './types.js';

type Position = AccountView['positions'][number];

const OWN_PREFIX = 'tgd';

export function externalSymbols(): Set<string> {
  return new Set((process.env['TG_EXTERNAL_POSITIONS'] ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean));
}

export function isExternalPosition(position: Position, account: Pick<AccountView, 'open_orders'>): boolean {
  if (externalSymbols().has(position.symbol)) return true;
  const market = position.market ?? 'perp';
  return account.open_orders.some((o) => o.symbol === position.symbol && (o.market ?? 'perp') === market && !o.client_order_id.startsWith(OWN_PREFIX));
}
