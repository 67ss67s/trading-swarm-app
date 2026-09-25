// 复审 High-2 / Medium-13:判断大面积出错的试验不能成为 finalist;全部跳过不给增量数字。纯函数,零网络。
import { describe, expect, it } from 'vitest';
import { judgeTrials, JUDGE_ERROR_MAX, type TrialRec } from '../../../../src/demo/research/matrix-study/compute.js';
import { DEFAULT_PROTOCOL } from '../../../../src/demo/research/matrix-study/spec.js';

const score = { members: ['BTCUSDT'], trades: 80, total_return: 0.6, sharpe: 2.5, period_sharpe: 0.2, days: 300, skew: 0, kurtosis: 3, max_drawdown: 0.1, exposure: 0.5, expectancy: 0.01, win_rate: 0.55, stressed_return: 0.5, hold_return: 0.1, exposure_matched_hold: 0.05, btc_hold_return: 0.1 };
const days = Array.from({ length: 300 }, (_, i) => i);
const rec = (id: string, judge: { candidates: number; follow: number; skip: number; error: number; uncertain: number } | null): TrialRec => ({
  trial_id: id, cell_id: `BTCUSDT|4h|breakout|long|${judge ? 'code_judge' : 'code'}`, variant_id: 'v', param: 'p', parent_trial_id: null, generation: 0, config_hash: id, ir_hash: 'h',
  ir: {} as TrialRec['ir'], error: null, status: 'evaluated',
  dev: { train: score, selection: score, selection_returns: days.map((i) => 0.002 + (i % 7) * 0.0004), selection_days: days, selection_fees: 1, selection_gross: 0.62, diagnosis: [], judge, warnings: [], engine: 'test' } as unknown as TrialRec['dev'],
});

describe('judge 出错率门槛进入正式判定', () => {
  it('出错 + 不确定 > 50%:判 fail / unsupported_execution,且门槛行可见', () => {
    const { trials } = judgeTrials([rec('t1', { candidates: 100, follow: 35, skip: 5, error: 55, uncertain: 5 })], 1, DEFAULT_PROTOCOL);
    expect(trials[0]!.verdict).toBe('fail');
    expect(trials[0]!.cause).toBe('unsupported_execution');
    expect(trials[0]!.gates.find((g) => g.name === `judge_errors<=${JUDGE_ERROR_MAX * 100}%`)).toMatchObject({ ok: false, value: 0.6 });
  });

  it('出错率在阈值内:判断门槛通过,不影响其余判定', () => {
    const { trials } = judgeTrials([rec('t2', { candidates: 100, follow: 60, skip: 30, error: 8, uncertain: 2 })], 1, DEFAULT_PROTOCOL);
    expect(trials[0]!.gates.find((g) => g.name.startsWith('judge_errors'))).toMatchObject({ ok: true, value: 0.1 });
    expect(trials[0]!.cause).not.toBe('unsupported_execution');
  });

  it('纯代码臂没有判断计数:不加判断门槛', () => {
    const { trials } = judgeTrials([rec('t3', null)], 1, DEFAULT_PROTOCOL);
    expect(trials[0]!.gates.some((g) => g.name.startsWith('judge_errors'))).toBe(false);
  });
});
