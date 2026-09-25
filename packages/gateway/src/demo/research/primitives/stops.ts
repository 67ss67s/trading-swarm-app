import { define,n,atr,last } from './registry.js';
export const atr_stop=define('atr_stop','stop','收盘价减去 ATR 倍数作为初始止损',p=>n(p,'atr_period')+1,(ctx,p)=>({stop:last(ctx)-atr(ctx.bars,n(p,'atr_period'))*n(p,'multiple')}));
export const swing_low_stop=define('swing_low_stop','stop','最近窗口最低价作为初始结构止损',p=>n(p,'lookback'),(ctx,p)=>({stop:Math.min(...ctx.bars.slice(-n(p,'lookback')).map(b=>Number(b.low)))}));
// 用户明确说「不设止损」时的显式选择(2026-09-23):止损价放在收盘价 0.01%,实际不会触发;规范里算「用户指定」只 warn,不再逼模型编一个止损
export const no_stop=define('no_stop','stop','不设止损(用户明确要求;止损价取收盘价的 0.01%,等于不触发)',()=>0,(ctx)=>({stop:last(ctx)*1e-4}));
