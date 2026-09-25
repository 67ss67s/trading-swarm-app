import { describe,it,expect } from 'vitest';
import { runStudy } from '../../../../scripts/research-study-eval/matrix-adapter.js';
import { aggregatePanel,correlatedWalk,signFlipBlocks,syntheticDevelopment } from '../../../../src/demo/research/study-eval/nulls.js';
describe('G1 生产 matrix 服务离线接线（CI，非FWER声明）',()=>{
 it.each(['n1','n2'] as const)('%s 重跑两臂、记试验与桩调用，不能只给固定冠军打分',async kind=>{
  const o={seed:20260925,bars:96*45},panel=kind==='n1'?correlatedWalk(o):signFlipBlocks(o,syntheticDevelopment(17));
  const result=await runStudy({panel,bars:aggregatePanel(panel),judge_kind:'random',seed:o.seed,replicate:0,profile:'ci'});
  expect(result.attempt_count).toBeGreaterThanOrEqual(12);expect(result.trial_count).toBeGreaterThanOrEqual(12);expect(result.judge_calls).toBeGreaterThan(0);expect(result.passed).toBe(false);
 },60000);
});
