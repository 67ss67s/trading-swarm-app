import { afterEach, describe, it, expect } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import type { ActivityItem } from '../../src/demo/types.js';
let state: StateDb | undefined;
afterEach(() => state?.close());
describe('历史页面游标', () => {
  it('日志折叠后仍按原始末行翻页，保留全部最近记录', () => {
    state = openStateDb(':memory:'); const s = new DemoStore(state);
    // data 各不相同:写入端不合并(只合并完全相同的行,log-retention.ts),这里测的是读取端折叠后的翻页。
    for (let i = 0; i < 8; i++) s.log({ at: 1000, level: 'warn', scope: 'test', message: 'timeout', data: { attempt: i } });
    const first = s.logPage(3); const second = s.logPage(3, first.next_before_id!); const third = s.logPage(3, second.next_before_id!);
    expect(first.logs).toHaveLength(1); expect(first.logs[0]?.observed_count).toBe(3);
    expect(second.next_before_id).toBeLessThan(first.next_before_id!);
    expect(third.logs[0]?.observed_count).toBe(2); expect(third.next_before_id).toBeNull();
    expect(s.logPage(100).logs[0]?.observed_count).toBe(8);
  });
  it('同毫秒的活动跨页不丢失、不重复', () => {
    state = openStateDb(':memory:'); const s = new DemoStore(state);
    for (let i = 0; i < 7; i++) s.saveActivity({ id: `a${i}`, at: 1000, kind: 'execution_changed', level: 'info', symbol: null, thread_id: null, episode_id: null, title: 'test', detail: null, data: {} } as ActivityItem);
    const first = s.activityPage(3); const c = first.next_before!;
    const second = s.activityPage(3, c.at, undefined, c.id); const c2 = second.next_before!;
    const third = s.activityPage(3, c2.at, undefined, c2.id);
    expect([...first.activity, ...second.activity, ...third.activity].map(x => x.id)).toEqual(['a6','a5','a4','a3','a2','a1','a0']);
    expect(third.next_before).toBeNull();
  });
});
