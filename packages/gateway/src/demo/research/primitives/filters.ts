import { define,n } from './registry.js';
import { trendState,trendWarmup } from './trend-state.js';
export const trend_state=define('trend_state','regime','ADX、快慢 EMA 斜率与完整高周期方向共同判断趋势',(p,base)=>trendWarmup(p,base),(ctx,p)=>{const trend=trendState(ctx,p);return {trend,pass:trend.status==='ok'&&trend.state==='up'};});
export const residual_sharpe_min=define('residual_sharpe_min','screen','残差 Sharpe 达到下限',()=>0,(ctx,p)=>({pass:ctx.screen?.status==='ok'&&ctx.screen.residual?.sharpe!=null&&ctx.screen.residual.sharpe>=n(p,'minimum')}));
export const beta_max=define('beta_max','screen','市场 beta 不超过上限',()=>0,(ctx,p)=>({pass:ctx.screen?.status==='ok'&&ctx.screen.beta!==undefined&&ctx.screen.beta<=n(p,'maximum')}));
export const trend_required=define('trend_required','screen','趋势状态属于允许集合',()=>0,(ctx,p)=>({pass:ctx.screen?.trend.status==='ok'&&(p.states as string[]).includes(ctx.screen.trend.state)}));
