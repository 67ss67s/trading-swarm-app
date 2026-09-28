/**
 * 研究台落到哪段对话(components/research-workbench/session-pick.ts)。
 * 旧 bug:第一次打开 #research?session=<旧对话>,深链选中的对话被「落到最近一条」盖掉。
 */
import { describe, expect, it } from 'vitest';
import { fallbackSession } from '../src/components/research-workbench/session-pick';

const list = [{ id: 'newest' }, { id: 'seed-a' }, { id: 'seed-b' }];

describe('fallbackSession', () => {
  it('keeps the session a deep link just picked', () => {
    expect(fallbackSession(list, 'seed-b')).toBeNull();
  });
  it('falls back to the newest session when nothing valid is selected', () => {
    expect(fallbackSession(list, null)).toBe('newest');
    expect(fallbackSession(list, 'deleted')).toBe('newest');
  });
  it('does nothing without sessions', () => {
    expect(fallbackSession([], null)).toBeNull();
  });
});
