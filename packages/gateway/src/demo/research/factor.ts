import type { ResearchFactorMetrics, ResearchFactorResult } from '@trade-gate/contracts';
export interface FactorOptions {window_bars:number;periods_per_year:number;risk_free_per_bar?:number;factors?:number[][]}
const mean=(x:number[])=>x.reduce((a,b)=>a+b,0)/x.length;
const variance=(x:number[],m=mean(x))=>x.reduce((a,b)=>a+(b-m)**2,0)/x.length;
function regression(y:number[],x:number[],ppy:number,rf:number) {
  const mx=mean(x),my=mean(y),vx=variance(x,mx),vy=variance(y,my);
  const cov=y.reduce((s,v,i)=>s+(v-my)*(x[i]!-mx),0)/y.length;
  const beta=vx>1e-24?cov/vx:0,alpha=my-rf-beta*(mx-rf);
  return {beta,alpha_per_bar:alpha,alpha_annualized:alpha*ppy,r2:vx>1e-24&&vy>1e-24?Math.min(1,Math.max(0,cov*cov/vx/vy)):0};
}
export function factorMetrics(returns:number[],market:number[],ppy:number,rf=0):ResearchFactorMetrics {
  const m=mean(returns),sd=Math.sqrt(variance(returns)),active=returns.map((v,i)=>v-market[i]!),tracking=Math.sqrt(variance(active));
  const downside=Math.sqrt(mean(returns.map(v=>Math.min(0,v-rf)**2)));
  let log=0,peak=0,max=0,area=0,squares=0;
  for(const r of returns){log+=r;peak=Math.max(peak,log);const dd=-Math.expm1(log-peak);max=Math.max(max,dd);area+=dd;squares+=dd*dd;}
  return {total_return:Math.expm1(log),max_drawdown:max,drawdown_area:area/returns.length,ulcer_index:Math.sqrt(squares/returns.length),sharpe:sd>1e-12?(m-rf)/sd*Math.sqrt(ppy):null,sortino:downside>1e-12?(m-rf)/downside*Math.sqrt(ppy):null,information_ratio:tracking>1e-12?mean(active)/tracking*Math.sqrt(ppy):null,volatility:sd*Math.sqrt(ppy)};
}
/** OLS with intercept on per-bar log returns. No future data or fitting across windows. */
export function factorDecompose(returns:number[],marketReturns:number[],opts:FactorOptions):ResearchFactorResult {
  const {window_bars:w,periods_per_year:ppy,risk_free_per_bar:rf=0}=opts;
  if(!Number.isInteger(w)||w<2||!Number.isFinite(ppy)||ppy<=0||!Number.isFinite(rf))throw new Error('factor_options_invalid');
  if(opts.factors?.length)throw new Error('multiple_factors_not_implemented');
  if(returns.length!==marketReturns.length||[...returns,...marketReturns].some(x=>!Number.isFinite(x)))throw new Error('factor_returns_invalid');
  if(returns.length<Math.max(100,2*w))return {status:'insufficient',note:'至少需要 max(100, 2 × window_bars) 个同周期对数收益样本'};
  const fit=regression(returns,marketReturns,ppy,rf),residual=returns.map((r,i)=>r-fit.beta*marketReturns[i]!);
  const alpha=residual.reduce((a,b)=>a+b,0),beta=fit.beta*marketReturns.reduce((a,b)=>a+b,0),total=alpha+beta;
  // Signed shares for positive total; negative total uses magnitudes, so shares still sum to one.
  const denominator=total<0?Math.abs(alpha)+Math.abs(beta):total;
  const rolling:NonNullable<ResearchFactorResult['rolling']>=[];
  // Sliding sufficient statistics keep screen O(n), including its rolling regression output.
  let sx=0,sy=0,sxx=0,syy=0,sxy=0;
  for(let i=0;i<returns.length;i++){
    const x=marketReturns[i]!,y=returns[i]!;sx+=x;sy+=y;sxx+=x*x;syy+=y*y;sxy+=x*y;
    if(i>=w){const oldX=marketReturns[i-w]!,oldY=returns[i-w]!;sx-=oldX;sy-=oldY;sxx-=oldX*oldX;syy-=oldY*oldY;sxy-=oldX*oldY;}
    if(i>=w-1){const vx=Math.max(0,sxx/w-(sx/w)**2),vy=Math.max(0,syy/w-(sy/w)**2),cov=sxy/w-sx*sy/(w*w),beta=vx>1e-24?cov/vx:0;
      rolling.push({at_index:i,beta,alpha_annualized:(sy/w-rf-beta*(sx/w-rf))*ppy,r2:vx>1e-24&&vy>1e-24?Math.min(1,Math.max(0,cov*cov/vx/vy)):0});}
  }
  return {status:'ok',...fit,residual_returns:residual,raw:factorMetrics(returns,marketReturns,ppy,rf),residual:factorMetrics(residual,Array(residual.length).fill(0),ppy,rf),alpha_share:Math.abs(denominator)>1e-15?(total<0?Math.abs(alpha):alpha)/denominator:null,beta_share:Math.abs(denominator)>1e-15?(total<0?Math.abs(beta):beta)/denominator:null,rolling,note:`对数收益 OLS；alpha 年化为每根截距 × periods_per_year；${total<0?'负总收益按两部分绝对值占比':'正总收益按有符号累计对数收益占比（可超出 0–1）'}；零总收益占比及零分母比率为 null；回撤面积为平均回撤。`};
}
