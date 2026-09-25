import './structure.js';
import './signals.js';import './stops.js';import './exits.js';import './filters.js';import './sizing.js';
import './indicators.js';import './generic.js';import './patterns.js';import './pine.js';
import './levels.js';
import './smc.js';
import './htf-ma.js';
export { registry } from './registry.js';
import { registry } from './registry.js';
export function listPrimitives(){return {items:[...registry.values()].map(p=>({name:p.name,category:p.category,params_schema:p.params,description:p.describe({}),warmup_note:'以 warmup 检查为准；仅使用当前已收盘及以前的 bar，高周期必须完整。'}))};}
