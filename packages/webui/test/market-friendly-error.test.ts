/**
 * OKX.AI 页的报错(components/market/judge.ts friendlyMarketError):默认版也把 onchainos CLI 原文(命令行、本机路径)换成友好说明,
 * 平台的业务提示原样显示;评审版沿用 friendlyError。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRIENDLY_TECH_ERROR } from '../src/lib/edition';
import { setLang } from '../src/lib/i18n';
import { MARKET_CLI_ERROR_ZH, friendlyMarketError } from '../src/components/market/judge';

const RAW = 'CLI login or buyer identity unavailable; check the wallet login. session expired, please login again: onchainos wallet login Command failed: /Users/someone/.local/bin/onchainos agent get-my-agents';

describe('friendlyMarketError', () => {
  afterEach(() => setLang('zh'));
  it('replaces raw CLI errors with a plain explanation in the default edition, and logs the original once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(friendlyMarketError(RAW, 'default')).toBe(MARKET_CLI_ERROR_ZH);
    friendlyMarketError(RAW, 'default');
    expect(warn).toHaveBeenCalledTimes(1);
    setLang('en');
    const en = friendlyMarketError(RAW, 'default') as string;
    expect(en).toMatch(/^The OKX\.AI tool on this machine is not ready/);
    expect(en).not.toMatch(/Users|onchainos/);
    warn.mockRestore();
  });
  it('keeps platform messages that are not technical', () => {
    expect(friendlyMarketError('此服务当前不支持试用，请刷新目录后重新选择。', 'default')).toBe('此服务当前不支持试用，请刷新目录后重新选择。');
    expect(friendlyMarketError(null, 'default')).toBeNull();
  });
  it('uses the judge wording in the judge edition', () => {
    expect(friendlyMarketError(RAW, 'judge')).toBe(FRIENDLY_TECH_ERROR);
  });
});
