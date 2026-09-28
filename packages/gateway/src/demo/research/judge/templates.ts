import type { JudgeQuestion, StrategyJudge } from '@trade-gate/contracts';
import { validateJudge } from './pure.js';
export const JUDGE_TEMPLATE_KEYS=['take','quality','support_holds','resistance_breaks','retreat_risk','regime_fit'] as const;
export type JudgeTemplateKey=typeof JUDGE_TEMPLATE_KEYS[number];
const fields=['candidate.direction','candidate.stop_distance_atr','candidate.reward_risk','features.trend','features.volatility','features.volume_ratio'] as const;
const levels=['candidate.direction','candidate.reference','candidate.support','candidate.resistance','candidate.stop','candidate.target'] as const;
/** 价位事件固定看未来15分钟；只问事前条件，不把概率命名为盈利概率。 */
export const JUDGE_TEMPLATES:Record<JudgeTemplateKey,JudgeQuestion>={
 take:{key:'take',type:'noul',instructions:'按这条策略的规则,此刻按给定的入场、止损和目标开仓是否合理',criteria:['趋势、波动与盈亏比支持这笔入场','状态与策略前提不符或盈亏比不足'],state_fields:[...fields]},
 quality:{key:'quality',type:'score',instructions:'这笔候选的整体质量',criteria:['差:前提明显不成立','一般:勉强成立','好:前提成立','很好:多项证据一致'],labels:['poor','fair','good','excellent'],state_fields:[...fields]},
 support_holds:{key:'support_holds',type:'noul',instructions:'从 as_of 起未来15分钟，价格是否始终不低于最近已确认摆动支撑 candidate.support？reference 为候选入场参考价。',criteria:['未来15分钟最低价不低于 support','未来15分钟最低价低于 support'],state_fields:[...levels]},
 resistance_breaks:{key:'resistance_breaks',type:'noul',instructions:'从 as_of 起未来15分钟，期末价格是否高于最近已确认摆动阻力 candidate.resistance？reference 为候选入场参考价。',criteria:['15分钟期末价高于 resistance','15分钟期末价不高于 resistance'],state_fields:[...levels]},
 retreat_risk:{key:'retreat_risk',type:'noul',instructions:'从 as_of 起未来15分钟，是否触及候选止损 candidate.stop（long:最低价<=stop，short:最高价>=stop）？',criteria:['15分钟内触及止损','15分钟内未触及止损'],state_fields:[...levels]},
 regime_fit:{key:'regime_fit',type:'noul',instructions:'目前的趋势、波动和量能状态是否与候选方向及风险收益几何相容？不预测已知未来收益。',criteria:['状态与候选方向和风险收益几何相容','不相容或证据不足'],state_fields:[...fields,'features.market_regime']},
};
export interface JudgeTemplateCombination { templates:JudgeTemplateKey[]; rule?:StrategyJudge['rule']; microstructure?:boolean }
export function templateJudge(profile_ref:string,combo:JudgeTemplateCombination={templates:['take','quality']}):StrategyJudge {
 if(!combo||!Array.isArray(combo.templates)||!combo.templates.length||combo.templates.length>6||new Set(combo.templates).size!==combo.templates.length||combo.templates.some(k=>!JUDGE_TEMPLATE_KEYS.includes(k))||Object.keys(combo).some(k=>!['templates','rule','microstructure'].includes(k))||combo.microstructure!==undefined&&typeof combo.microstructure!=='boolean')throw Error('judge_templates_invalid');
 const questions=combo.templates.map(k=>structuredClone(JUDGE_TEMPLATES[k]));
 if(combo.microstructure)for(const q of questions)q.state_fields.push('features.ob_imbalance_05','features.ob_wall_up','features.ob_wall_down','features.spread_bps','features.liq_long_5m','features.liq_short_5m');
 const spec={version:1,engine:'jev',model_profile_ref:profile_ref,state_schema_version:'judge_state_v1',questions,
 rule:combo.rule??{all:combo.templates.map(k=>({question_key:k,label:k==='quality'?'poor':'yes',operator:k==='quality'||k==='retreat_risk'?'lte':'gte',threshold:k==='quality'?0.5:k==='retreat_risk'?0.4:0.55,margin:0.02}))},
 on_uncertain:'skip',on_error:'skip',timeout_ms:10000,max_attempts:1} as StrategyJudge;
 validateJudge(spec);return spec;
}
