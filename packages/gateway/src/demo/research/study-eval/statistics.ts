import { rng } from './nulls.js';
/** 精确二项 CP 单侧上界，二分解 BinomialCDF(k;n,p)=tail。 */
export function clopperPearsonUpper(successes:number,n:number,tail=0.025):number {
 if(!Number.isSafeInteger(n)||n<1||!Number.isSafeInteger(successes)||successes<0||successes>n||!(tail>0&&tail<1))throw Error('binomial_invalid');
 if(successes===n)return 1;
 const logFact=[0];for(let i=1;i<=n;i++)logFact[i]=logFact[i-1]!+Math.log(i);
 const cdf=(p:number)=>{const terms:number[]=[];for(let k=0;k<=successes;k++)terms.push(logFact[n]!-logFact[k]!-logFact[n-k]!+k*Math.log(p)+(n-k)*Math.log1p(-p));const max=Math.max(...terms);return Math.exp(max)*terms.reduce((s,v)=>s+Math.exp(v-max),0);};
 let lo=0,hi=1;for(let i=0;i<70;i++){const mid=(lo+hi)/2;if(cdf(mid)>tail)lo=mid;else hi=mid;}return hi;
}
export function holm(pvalues:readonly number[],alpha=0.025):{adjusted:number;rejected:boolean}[] {
 if(pvalues.some(p=>!Number.isFinite(p)||p<0||p>1))throw Error('pvalue_invalid');
 const sorted=pvalues.map((p,i)=>({p,i})).sort((a,b)=>a.p-b.p||a.i-b.i),out:{adjusted:number;rejected:boolean}[]=pvalues.map(()=>({adjusted:1,rejected:false}));let prior=0;
 for(let k=0;k<sorted.length;k++){const x=sorted[k]!;prior=Math.min(1,Math.max(prior,x.p*(sorted.length-k)));out[x.i]={adjusted:prior,rejected:prior<=alpha};}return out;
}
/** 同步连续时间块配对 bootstrap；最少块数由预注册协议给定。 */
export function pairedBlockBootstrap(a:readonly number[],b:readonly number[],opts:{block_size:number;replicates:number;seed:number;alpha?:number;min_blocks?:number}):{status:'ok'|'insufficient_evidence';delta:number;ci:[number,number]|null;blocks:number} {
 if(a.length!==b.length||!a.length||[...a,...b].some(x=>!Number.isFinite(x))||!Number.isSafeInteger(opts.block_size)||opts.block_size<1||!Number.isSafeInteger(opts.replicates)||opts.replicates<1)throw Error('paired_series_invalid');
 const d=a.map((v,i)=>v-b[i]!),delta=d.reduce((s,v)=>s+v,0)/d.length,blocks=Math.floor(d.length/opts.block_size);
 if(blocks<(opts.min_blocks??20))return{status:'insufficient_evidence',delta,ci:null,blocks};
 const r=rng(opts.seed),draws:number[]=[];
 for(let k=0;k<opts.replicates;k++){let sum=0,n=0;while(n<d.length){const start=Math.floor(r()*(d.length-opts.block_size+1));for(let j=0;j<opts.block_size&&n<d.length;j++,n++)sum+=d[start+j]!;}draws.push(sum/d.length);}
 draws.sort((x,y)=>x-y);const alpha=opts.alpha??0.05;return{status:'ok',delta,ci:[draws[Math.floor(alpha/2*draws.length)]!,draws[Math.min(draws.length-1,Math.floor((1-alpha/2)*draws.length))]!],blocks};
}
export interface G1Count {null_kind:'n1'|'n2';studies:number;false_releases:number;upper_975:number;}
export function g1Verdict(groups:G1Count[],positive:{studies:number;detected:number},profile:'ci'|'release'):'passed'|'failed'|'insufficient_evidence' {
 if(profile==='ci'||groups.length!==2||groups.some(g=>g.studies<1000)||positive.studies<100)return'insufficient_evidence';
 return groups.every(g=>g.upper_975<=0.05)&&positive.detected/positive.studies>=0.8?'passed':'failed';
}
