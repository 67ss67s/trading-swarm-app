/**
 * 旧的「优化」页地址(#refine)落到研究台(#research),带的参数换成研究台的写法(components/strategy-research/refine-model.ts)。
 */
import { describe, expect, it } from 'vitest';
import { refineToResearchHash } from '../src/components/strategy-research/refine-model';

describe('#refine redirect', () => {
  it('maps a scout combo to the workbench builder seed', () => {
    expect(refineToResearchHash('#refine?study=ms_1&trial=mt_2')).toBe('research?matrix_study=ms_1&trial=mt_2');
  });
  it('maps a conversation to the workbench session', () => {
    expect(refineToResearchHash('#refine?session=2f58100d-de73')).toBe('research?session=2f58100d-de73');
  });
  it('falls back to the plain workbench', () => {
    expect(refineToResearchHash('#refine')).toBe('research');
    expect(refineToResearchHash('#refine?blank=1')).toBe('research');
    expect(refineToResearchHash('#refine?study=ms_1')).toBe('research');
  });
});
