import { describe, expect, it } from 'vitest';
import { RR_PROMPT } from '../../src/demo/rr-prompt.js';
import { buildContext, type EpisodeInputs } from '../../src/demo/context.js';
import { buildHoldingPlan, holdingEntryGates } from '../../src/demo/holding-policy.js';
import { newThread } from '../../src/demo/threads.js';
import type { TfFeatures } from '../../src/demo/market.js';
const now=Date.UTC(2026,8,1);
const input:EpisodeInputs={now,symbol:'BTCUSDT',trigger:{kind:'manual',detail:'RR contract'},mode:'scan',thread:null,open_threads:[],account:{backend:'paper',equity:'10000',available:'10000',unrealized_pnl:'0',positions:[],open_orders:[],as_of:now},market:{symbol:'BTCUSDT',last:'100',mark:'100',funding_rate:'',next_funding_at:now,open_interest:'',as_of:now,klines_tf:'15m'},features:[],oi_change_1h_pct:null,ticker24h:{priceChangePercent:'0',highPrice:'101',lowPrice:'99',quoteVolume:'10000'},market_state:null,playbook_text:'fixture',last_judgment_summary:null,halted:false};
describe('RR prompt public behavior contract',()=>{
 it('adds RR analysis to scan only',()=>{expect(buildContext(input).system_text).toContain(RR_PROMPT);expect(buildContext({...input,mode:'review'}).system_text).not.toContain(RR_PROMPT);});
 it('requires independent structure/target and refuses reverse engineering an RR',()=>{expect(RR_PROMPT).toContain('先引用本策略主周期的结构证据');expect(RR_PROMPT).toContain('再独立引用');expect(RR_PROMPT).toContain('不要从想要的RR反推目标或收窄止损');expect(RR_PROMPT).toContain('缺乏独立目标证据时不提案');});
 it('accounts for costs and first-target full exit without invented numeric evidence',()=>{expect(RR_PROMPT).toContain('未知成本不能按零处理');expect(RR_PROMPT).toContain('只用第一目标');expect(RR_PROMPT).toContain('第二目标不参与');expect(RR_PROMPT).toContain('不要在理由中编造未登记的计算值');});
 it('a remote second TP cannot rescue failing first-target economics in code',()=>{const t=newThread({id:'rr-first-target',backend:'paper',symbol:'BTCUSDT',side:'long',source:'agent',timeframe:'15m',horizon:'intraday',thesis:'fixture',invalidation_text:'99',watch_conditions:[],entry:{type:'market',price:'100',zone:null},stop_price:'98',take_profits:['102','200'],qty:'1',margin_usdt:'100',leverage:1,margin_mode:'cross',now});const features=[{tf:'1h',atr14:1,ema20:100,ema50:95,last_close:101} as TfFeatures];const plan=buildHoldingPlan({thread:t,features,now})!;expect(Number(plan.gross_rr)).toBe(1);expect(holdingEntryGates(plan,t).find(g=>g.name==='净盈亏比')!.passed).toBe(false);});
});
