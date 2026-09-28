/**
 * 默认语言是英文;模型花费:中文 ¥、英文按固定汇率换成 $(lib/money.ts),服务端文字里的 ¥ 金额也一样。
 */
import { describe, expect, it, vi } from 'vitest';

describe('default language', () => {
  it('is English when nothing is stored', async () => {
    vi.resetModules();
    const fresh = await import('../src/lib/i18n');
    expect(fresh.getLang()).toBe('en');
    expect(fresh.t('研究台')).toBe('Research workbench');
    expect(fresh.t('OKX.AI')).toBe('OKX.AI');
  });
});

describe('model cost display', () => {
  it('keeps ¥ in Chinese and shows dollars in English', async () => {
    const { setLang } = await import('../src/lib/i18n');
    const { fmtCost, CNY_PER_USD } = await import('../src/lib/money');
    setLang('zh');
    expect(fmtCost(0.12)).toBe('¥0.12');
    setLang('en');
    expect(fmtCost(CNY_PER_USD * 1.5)).toBe('$1.50');
    expect(fmtCost(0.006, 3)).toBe('<$0.001');
    expect(fmtCost(0)).toBe('$0.00');
    expect(fmtCost(null)).toBe('$0.00');
    setLang('zh');
  });
  it('turns ¥ amounts in server text into dollars in English', async () => {
    const { setLang } = await import('../src/lib/i18n');
    const { serverTextEn } = await import('../src/lib/server-text-en');
    setLang('en');
    expect(serverTextEn('过去 24h:10 次角色任务,¥7.100')).toBe('last 24h: 10 role tasks, $1.000');
    setLang('zh');
  });
});
