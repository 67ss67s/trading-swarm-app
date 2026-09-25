import { evaluateOrderGate, fitOrderGate, riskCapApplies, type OrderGateParams } from './order-gate.js';
import type { ResearchBar, ResearchEquity, ResearchExecution, ResearchTrade } from '@trading-swarm/contracts';
import { q, decimal, mul, div, min, SCALE } from './primitives.js';
export type Entry = import('@trading-swarm/contracts').ResearchEntry;
export interface Position { capped?:boolean;fit?:ResearchTrade['fit'];stop_reason?:ResearchTrade['reason']; id:string; candidate_id:string; entry_at:number; entry_price:bigint; qty:bigint; stop:bigint; target:bigint|null; entry_fee:bigint; entry_notional:bigint; initial_risk:bigint; bars_held:number; high_water?:bigint; initial_distance?:bigint;mae_r?:number;mfe_r?:number;entry_slippage?:bigint }
/** size_weight:波动率目标仓位(IR risk.sizing=vol_target)的 w,十进制字符串 (0,1];入场名义额度上限再 × w。不用 vol_target 的请求不带,账本算式不变。 */
export type Pending = { action:'enter'; entry:Entry; size_weight?:string } | { action:'exit'|'reduce'; reason:ResearchTrade['reason'] };
export class SpotLedger {
  cash:bigint; position:Position|null=null; pending:Pending|null=null; peak:bigint; slippage=0n; turnover=0n; fees=0n; counter=0;
  readonly trades:ResearchTrade[]=[]; readonly equity:ResearchEquity[]=[]; readonly opens_by_day=new Map<number,number>();
  constructor(readonly config:ResearchExecution,readonly detail:{symbol?:string;diagnostics?:boolean;order_gate?:OrderGateParams;fit?:boolean;onGate?:(gate:ReturnType<typeof evaluateOrderGate>)=>void;bar_path?:'adaptive'}={}) { this.cash=q(config.initial_cash); this.peak=this.cash; }
  value(mark:string):bigint {return this.cash+(this.position?mul(this.position.qty,q(mark)):0n);}
  /** Protective orders submitted earlier have priority over an agent's next-open exit. */
  step(b:ResearchBar):string[] {
    const notices=this.stepOpen(b);
    this.stepIntrabar(b);this.mark(b);return notices;
  }
  stepOpen(b:ResearchBar,limits?:{risk_budget:bigint;notional_cap:bigint;equity?:bigint}):string[] {
    const notices:string[]=[]; const o=q(b.open); const h=q(b.high); const l=q(b.low);
    this.excursion(o,o);
    if (this.position && o <= this.position.stop) this.close(b.open_time,o,this.position.stop_reason??'stop','open');
    else if (this.position && this.position.target!==null && o >= this.position.target) this.close(b.open_time,this.position.target,'target','open');
    const order=this.pending; this.pending=null;
    if(order?.action==='enter') {
      if(this.position) notices.push('position_capacity');
      else {
        const price=this.buyPrice(o), fee=q(this.config.fee_rate);
        // Re-fit at the actual fill: a gap changes the stop distance, so the cost floor and fixed-R target are re-anchored to the fill price.
        const placed=this.detail.order_gate&&this.detail.fit&&q(order.entry.fit?.strategy_stop??order.entry.stop)>0n&&q(order.entry.fit?.strategy_stop??order.entry.stop)<price?fitOrderGate({side:'long',entry:decimal(price),stop:order.entry.fit?.strategy_stop??order.entry.stop,target:order.entry.fit?order.entry.fit.strategy_target:order.entry.target,target_r:order.entry.target_r,costs:this.config,params:this.detail.order_gate}):null;
        const stop=placed?q(placed.stop):q(order.entry.stop), target=placed?(placed.target===null?null:q(placed.target)):order.entry.target_r!==undefined?price+mul(price-stop,q(order.entry.target_r.toFixed(8))):order.entry.target===null?null:q(order.entry.target);
        const day=Math.floor(b.open_time/86400000);
        if(!(stop>0n && stop<price && (target===null||target>price))) notices.push('gap_invalidated_entry');
        else if((this.opens_by_day.get(day)??0)>=this.config.max_opens_per_day) notices.push('daily_open_cap');
        else {
          const budget=limits?.risk_budget??mul(this.cash,q(this.config.risk_fraction));
          const cap0=limits?.notional_cap??(this.config.sizing_mode==='unit_notional'?this.cash:mul(this.cash,q(this.config.max_allocation))),cap=order.size_weight===undefined?cap0:mul(cap0,q(order.size_weight));
          const riskQty=(this.config.sizing_mode==='unit_notional'||this.config.allocation==='equal_notional')?div(cap,price):div(budget,price-stop);
          const raw=min(riskQty,div(cap,price),div(this.cash,mul(price,SCALE+fee)));
          const qty=raw/q(this.config.qty_step)*q(this.config.qty_step); const notional=mul(qty,price), entryFee=mul(notional,fee);
          const gate=this.detail.order_gate&&qty>0n?evaluateOrderGate({side:'long',entry:decimal(price),stop:decimal(stop),target:target===null?null:decimal(target),costs:this.config,equity:decimal(limits?.equity??this.cash),qty:riskCapApplies(this.detail.order_gate,this.config.sizing_mode)?decimal(qty):null,params:this.detail.order_gate}):null;
          if(gate)this.detail.onGate?.(gate);
          if(gate&&!gate.ok)notices.push(...gate.blocked_by);
          else if(qty<=0n || notional<q(this.config.min_notional)) notices.push('below_min_notional');
          else {
            this.cash-=notional+entryFee; this.turnover+=notional; this.fees+=entryFee;
            this.position={capped:mul(raw,price)<cap,...(placed?{fit:placed.fit}:{}),id:`trade_${++this.counter}`,candidate_id:order.entry.candidate_id,entry_at:b.open_time,entry_price:price,qty,stop,target,entry_fee:entryFee,entry_notional:notional,initial_risk:mul(qty,price-stop),bars_held:0,initial_distance:price-stop,mae_r:0,mfe_r:0,entry_slippage:mul(qty,price-o)};
            this.slippage+=mul(qty,price-o);
            this.opens_by_day.set(day,(this.opens_by_day.get(day)??0)+1);
          }
        }
      }
    } else if(order && this.position) this.close(b.open_time,o,order.reason,'open',order.action==='reduce');
    return notices;
  }
  stepIntrabar(b:ResearchBar):void {
    const l=q(b.low),h=q(b.high);
    // engine v4(Nautilus bar execution):止损与止盈同根都被触及时按 bar 内路径定先后——开盘离最高价近走 O→H→L→C(先止盈),
    // 否则 O→L→H→C(先止损);旧口径(未开 bar_path)一律先止损,旧 manifest 重放不变
    if(this.position&&this.detail.bar_path==='adaptive'&&this.position.target!==null&&l<=this.position.stop&&h>=this.position.target&&h-q(b.open)<q(b.open)-l){const t=this.position.target;this.excursion(t,t);this.close(b.close_time,t,'target','intrabar_unknown');}
    if(this.position){
      if(l<=this.position.stop){this.excursion(this.position.stop,this.position.stop);this.close(b.close_time,this.position.stop,this.position.stop_reason??'stop','intrabar_unknown');}
      else if(this.position.target!==null&&h>=this.position.target){this.excursion(this.position.target,this.position.target);this.close(b.close_time,this.position.target,'target','intrabar_unknown');}
      else this.excursion(l,h);
    }
    if(this.position){this.position.bars_held++;this.position.high_water=this.position.high_water&&this.position.high_water>h?this.position.high_water:h;}

  }
  mark(b:ResearchBar):ResearchEquity {
    const holdings=this.position?mul(this.position.qty,q(b.close)):0n, equity=this.cash+holdings;
    if(equity>this.peak)this.peak=equity;
    const row={at:b.close_time,cash:decimal(this.cash),holdings:decimal(holdings),equity:decimal(equity),exposure:equity>0n?Number(holdings)/Number(equity):0,drawdown:this.peak>0n?1-Number(equity)/Number(this.peak):0};
    this.equity.push(row); return row;
  }
  private excursion(low:bigint,high:bigint):void {const p=this.position;if(!p||!p.initial_distance||p.initial_distance<=0n)return;p.mae_r=Math.min(p.mae_r??0,Number(low-p.entry_price)/Number(p.initial_distance));p.mfe_r=Math.max(p.mfe_r??0,Number(high-p.entry_price)/Number(p.initial_distance));}
  private buyPrice(p:bigint):bigint{return mul(p,SCALE+q(this.config.slippage_bps)/10000n);}
  private close(at:number,raw:bigint,reason:ResearchTrade['reason'],timing:ResearchTrade['timing'],half=false):void {
    const p=this.position!;
    const step=q(this.config.qty_step); const qty=half?p.qty/2n/step*step:p.qty;
    if(qty===0n)return;
    const price=mul(raw,SCALE-q(this.config.slippage_bps)/10000n);
    const received=mul(qty,price), fee=mul(received,q(this.config.fee_rate));
    const entryFee=half?p.entry_fee*qty/p.qty:p.entry_fee, risk=half?p.initial_risk*qty/p.qty:p.initial_risk;
    const costBasis=half?p.entry_notional*qty/p.qty:p.entry_notional;
    const entrySlip=half?(p.entry_slippage??0n)*qty/p.qty:(p.entry_slippage??0n),exitSlip=mul(qty,raw-price);this.slippage+=exitSlip;
    const gross=received-costBasis; const net=gross-entryFee-fee;
    this.cash+=received-fee;this.fees+=fee;this.turnover+=received;
    this.trades.push({position_id:p.id,id:`${p.id}_${this.trades.length}`,candidate_id:p.candidate_id,entry_at:p.entry_at,exit_at:at,entry_price:decimal(p.entry_price),exit_price:decimal(price),qty:decimal(qty),gross_pnl:decimal(gross),fees:decimal(entryFee+fee),net_pnl:decimal(net),initial_risk:decimal(risk),net_r:risk>0n?Number(net)/Number(risk):null,reason,timing,...(p.fit?{fit:p.fit,stop:decimal(p.stop),target:p.target===null?null:decimal(p.target)}:{}),...(this.config.sizing_mode?{capped:p.capped??false,return_pct:100*Number(net)/Number(costBasis)}:{}),...(this.detail.diagnostics?{symbol:this.detail.symbol??'',mae_r:p.mae_r??0,mfe_r:p.mfe_r??0,holding_bars:p.bars_held+(timing==='intrabar_unknown'?1:0),slippage_est:decimal(entrySlip+exitSlip)}:{})});
    if(qty===p.qty)this.position=null;
    else{p.qty-=qty;p.entry_notional-=costBasis;p.entry_fee-=entryFee;p.initial_risk-=risk;p.entry_slippage=(p.entry_slippage??0n)-entrySlip;}
  }
}
