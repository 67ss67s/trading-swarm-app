/**
 * 构建版本开关(lib/edition.ts + lib/nav.tsx):测试环境不设 VITE_EDITION = 默认版(开源版),judge 行为用显式 edition 参数测。
 * 09-28 开源:默认语言英文、旧楼层 / 日志不进侧栏、OKX.AI 在值班组交易下面,这几条两个版本一样;只读锁和「Judge demo」标记只在评审版。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LANG, EDITION, IS_JUDGE, isPageHidden, lockReason } from '../src/lib/edition';
import { ALL_NAV, NAV } from '../src/lib/nav';

describe('edition', () => {
  it('defaults to the normal (open-source) edition when VITE_EDITION is unset, in English', () => {
    expect(EDITION).toBe('default');
    expect(IS_JUDGE).toBe(false);
    expect(DEFAULT_LANG).toBe('en');
  });

  it('hides floor-legacy and logs in every edition', () => {
    const hidden = ALL_NAV.filter((n) => isPageHidden(n.id)).map((n) => n.id);
    expect(hidden).toEqual(['floor-legacy', 'logs']);
    expect(NAV.map((n) => n.id)).toEqual(ALL_NAV.filter((n) => !hidden.includes(n.id)).map((n) => n.id));
  });

  it('puts OKX.AI (the signal market page) right below Trading in the duty group', () => {
    const ops = NAV.filter((n) => n.group === 'ops').map((n) => n.id);
    expect(ops.indexOf('market')).toBe(ops.indexOf('trade') + 1);
    expect(NAV.find((n) => n.id === 'market')).toMatchObject({ label: 'OKX.AI', group: 'ops' });
    expect(NAV.filter((n) => n.id === 'market')).toHaveLength(1);
  });

  it('keeps the read-only locks to the judge edition only', () => {
    expect(lockReason('emergency_stop')).toBeNull();
    expect(lockReason('emergency_stop', 'judge')).toMatch(/judge edition/);
  });
});
