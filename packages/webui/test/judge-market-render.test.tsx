/**
 * 评审版状态条冒烟渲染:edition 模块被 mock 成 judge(构建时常量没法在测试里切),
 * 断言守护 / CLI 报错不露原文、身份不会一直「加载中」、写操作全挂锁、CacheNote 只说快照时间。
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/edition', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/lib/edition')>();
  return {
    ...orig,
    IS_JUDGE: true,
    EDITION: 'judge',
    lockReason: (f: Parameters<typeof orig.lockReason>[0]) => orig.lockReason(f, 'judge'),
    friendlyError: (text: string | null | undefined, fallback?: string) => orig.friendlyError(text, fallback, 'judge'),
  };
});
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
  useQuery: () => ({ isFetching: false, refetch: vi.fn() }),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('@/api/client', () => ({ api: {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { adaptSettings, adaptStatus } from '../src/api/market-adapt';
import { StatusStrip } from '../src/components/market/status-strip';
import { TooltipProvider } from '../src/components/ui/tooltip';

const loadingForever = { fetched_at: null, stale: false, refreshing: false, state: 'error', error: 'spawn onchainos ENOENT' };

describe('judge StatusStrip', () => {
  it('shows friendly neutral states and locks every write', () => {
    const status = adaptStatus(
      {
        cache: { fetched_at: null, stale: true, refreshing: false, state: 'error', error: '平台调用失败: spawn onchainos ENOENT' },
        sections: { identity: loadingForever, wallet: loadingForever },
        snapshot: { as_of: 1_790_000_000_000, source: 'okx.ai live ASP (read-only snapshot)' },
        a2a: { ok: false, detail: '守护没跑(okx-a2a daemon 未启动)' },
        trade_kit: { ok: false, detail: '请使用本页表单连接 OKX 账户' },
        inbox: { alive: false, last_error: 'spawn okx-a2a ENOENT' },
        errors: { wallet: 'onchainos wallet status exited with code 1' },
      },
      adaptSettings({ enabled: true }),
    );
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <StatusStrip status={status} isLoading={false} error={null} />
      </TooltipProvider>,
    );
    expect(html).not.toMatch(/ENOENT|spawn|daemon|onchainos|exited with/);
    expect(html).not.toContain('身份加载中');
    expect(html).not.toContain('请使用本页表单');
    expect(html).toContain('Not connected in the judge edition');
    expect(html).toContain('Snapshot as of');
    expect(html).toContain('data-judge-lock="asp_wallet"');
    expect(html).toContain('data-judge-lock="asp_settings"');
  });
});
