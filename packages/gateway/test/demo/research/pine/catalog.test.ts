/**
 * Pine 脚本目录(migrations/0030)的 DAO 行为:CRUD、搜索排序、准入留痕、
 * 以及「改了正文就作废准入」这条不能松的规矩。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { openStateDb } from '../../../../src/state-db.js';
import { PineCatalog, summarize, setPineCatalog, pineCatalog } from '../../../../src/demo/research/pine/catalog.js';
import type { AdmissionReport } from '../../../../src/demo/research/pine/admission.js';

const clean: (() => void)[] = [];
afterEach(() => { clean.splice(0).forEach((f) => f()); setPineCatalog(null); });

function setup(): PineCatalog {
  const db = openStateDb(':memory:');
  clean.push(() => db.close());
  return new PineCatalog(db.db, () => 1700000000000);
}

const report = (ok: boolean, outputs: string[] = ['rsi'], warmup = 14): AdmissionReport => ({
  ok, checks: [{ name: 'causality', ok, message: ok ? '一致' : 'lookahead' }],
  outputs, warmup_bars: warmup, sample_points: [50, 99], bars: 100, timeframe: '1h',
  tolerance: 1e-9, warnings: [], ran_at: 1700000000000, method_version: 'pine_admission_v1',
});

describe('Pine 脚本目录', () => {
  it('迁移 0030 建好表,新建的脚本默认未准入', () => {
    const catalog = setup();
    const created = catalog.create({ name: 'RSI', description: '相对强弱', aliases: ['相对强弱指数'], script: '//@version=5', source: 'user' });
    expect(created.id).toMatch(/^pine_/);
    expect(created.admitted).toBe(false);
    expect(created.outputs).toEqual([]);
    expect(created.usage_count).toBe(0);
    expect(catalog.get(created.id)).toEqual(created);
    expect(catalog.find('RSI')?.id).toBe(created.id); // 名字也能取
  });

  it('准入报告落库后 admitted 翻真,outputs 用真跑出来的名字', () => {
    const catalog = setup();
    const created = catalog.create({ name: 'RSI', script: 'x' });
    const admitted = catalog.admit(created.id, report(true, ['rsi', 'ema']));
    expect(admitted.admitted).toBe(true);
    expect(admitted.outputs).toEqual(['rsi', 'ema']);
    expect(admitted.admission_report?.warmup_bars).toBe(14);
    expect(summarize(admitted).admission_summary).toEqual({ ok: true, warmup_bars: 14, failed: [] });
    expect('script' in summarize(admitted)).toBe(false);
    // 没过的报告不翻 admitted,但报告照样留痕
    const rejected = catalog.admit(created.id, report(false));
    expect(rejected.admitted).toBe(false);
    expect(summarize(rejected).admission_summary?.failed).toEqual(['causality']);
  });

  it('改正文或参数即作废准入,只改描述则保留', () => {
    const catalog = setup();
    const created = catalog.create({ name: 'RSI', script: 'v1' });
    catalog.admit(created.id, report(true));
    expect(catalog.update(created.id, { description: '换个说法' }).admitted).toBe(true);
    const changed = catalog.update(created.id, { script: 'v2' });
    expect(changed.admitted).toBe(false);
    expect(changed.admission_report).toBeNull();
    expect(changed.outputs).toEqual([]);
  });

  it('按名字/描述/别名搜索,名字命中排在别名与描述前面,同级按用量', () => {
    const catalog = setup();
    const byName = catalog.create({ name: '超级趋势', script: 'a' });
    const byAlias = catalog.create({ name: 'ST', aliases: ['超级趋势线'], script: 'b' });
    const byDesc = catalog.create({ name: 'ATR 通道', description: '和超级趋势同族', script: 'c' });
    catalog.create({ name: 'RSI', description: '无关', script: 'd' });
    const hits = catalog.search('超级趋势').map((s) => s.id);
    expect(hits).toEqual([byName.id, byAlias.id, byDesc.id]);
    expect(catalog.search('不存在的概念')).toEqual([]);
    // 空查询 = 列表,按用量排序
    catalog.used(byDesc.id); catalog.used(byDesc.id); catalog.used(byAlias.id);
    expect(catalog.search('')[0]!.id).toBe(byDesc.id);
    expect(catalog.get(byDesc.id)!.usage_count).toBe(2);
  });

  it('admitted 过滤只回已准入的条目', () => {
    const catalog = setup();
    const a = catalog.create({ name: 'A', script: 'a' });
    catalog.create({ name: 'B', script: 'b' });
    catalog.admit(a.id, report(true));
    expect(catalog.search('', { admitted: true }).map((s) => s.name)).toEqual(['A']);
    expect(catalog.search('', { admitted: false }).map((s) => s.name)).toEqual(['B']);
    expect(catalog.search('').length).toBe(2);
  });

  it('拒绝空名字/空脚本/重名/无许可的社区脚本', () => {
    const catalog = setup();
    catalog.create({ name: 'RSI', script: 'x' });
    expect(() => catalog.create({ name: '', script: 'x' })).toThrow('pine_name_required');
    expect(() => catalog.create({ name: 'Y', script: ' ' })).toThrow('pine_script_required');
    expect(() => catalog.create({ name: 'RSI', script: 'y' })).toThrow('pine_name_conflict');
    expect(() => catalog.create({ name: 'Z', script: 'y', source: 'community' })).toThrow('pine_license_required_for_community');
    expect(catalog.create({ name: 'Z', script: 'y', source: 'community', license: 'MPL-2.0' }).license).toBe('MPL-2.0');
  });

  it('删除与未知 id 的行为明确', () => {
    const catalog = setup();
    const created = catalog.create({ name: 'RSI', script: 'x' });
    expect(catalog.remove(created.id)).toBe(true);
    expect(catalog.remove(created.id)).toBe(false);
    expect(catalog.get(created.id)).toBeNull();
    expect(() => catalog.update('nope', { script: 'x' })).toThrow('pine_script_not_found');
    expect(() => catalog.admit('nope', report(true))).toThrow('pine_script_not_found');
  });

  it('进程内单例可装可卸(原语侧同步取目录靠它)', () => {
    const catalog = setup();
    expect(pineCatalog()).toBeNull();
    setPineCatalog(catalog);
    expect(pineCatalog()).toBe(catalog);
  });
});
