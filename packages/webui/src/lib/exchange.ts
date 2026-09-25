/**
 * 交易所相关的用户可见文案 / 链接,只有这一个来源。
 *
 * 为什么:这个 fork 把交易所从 Binance 换成 OKX(docs/design/okx-atk-2026-09-20.md),但 Binance
 * 的代码和界面都不删、只按 `TG_EXCHANGE` 隐藏。所以组件里不能再写死「币安」和币安的入金链接——
 * 一律 `exchangeInfo(executionView)` 取。老网关不返回 `exchange` 字段 → 按 'binance' 处理,
 * 界面和今天一模一样。
 */
import type { ExecutionView } from '@/api/types';
import { t } from '@/lib/i18n';

export type ExchangeId = 'okx' | 'binance';

export interface ExchangeInfo {
  id: ExchangeId;
  /** 「币安」/「OKX」。 */
  name: string;
  /** 带账户形态的说法:币安是子账户,OKX 是 profile 对应的那个账户。 */
  account: string;
  /** 入金 / 划转页。 */
  depositUrl: string;
}

const BINANCE_DEPOSIT = 'https://www.binance.com/en/my/sub-account/asset-management/transfer?asset=USDT';
/** 模拟盘的「领模拟金」在交易页里;实盘走资金划转。 */
const OKX_DEMO_DEPOSIT = 'https://www.okx.com/trade-demo';
const OKX_LIVE_DEPOSIT = 'https://www.okx.com/balance/transfer';

export function exchangeId(view: ExecutionView | null | undefined): ExchangeId {
  return view?.exchange === 'okx' ? 'okx' : 'binance';
}

export function exchangeInfo(view: ExecutionView | null | undefined): ExchangeInfo {
  if (exchangeId(view) === 'okx') {
    // demo 读不出来(null)时按模拟盘给链接:本 fork 开发期一律模拟盘,给实盘划转页更容易误导。
    const demo = view?.okx?.demo !== false;
    return { id: 'okx', name: 'OKX', account: t('OKX 账户'), depositUrl: demo ? OKX_DEMO_DEPOSIT : OKX_LIVE_DEPOSIT };
  }
  return { id: 'binance', name: t('币安'), account: t('币安子账户'), depositUrl: BINANCE_DEPOSIT };
}
