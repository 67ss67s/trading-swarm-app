// TG_PUBLIC_LANG=en:模型现写的内容一律英文(系统提示在大脑出口追加硬性要求);不设时本机中文行为不变。
import { afterEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => [] as string[]);
vi.mock('../../src/demo/brain.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/demo/brain.js')>()),
  makeBrain: () => ({ name: 'recorder', complete: async (system: string) => { seen.push(system); return { text: 'ok', model: 'recorder', input_tokens: 1, output_tokens: 1, cost_usd: null }; } }),
}));

import { ENGLISH_ONLY, withOutputLanguage } from '../../src/demo/output-language.js';
import { DemoRuntime } from '../../src/demo/runtime.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { openStateDb } from '../../src/state-db.js';

afterEach(() => {
  vi.unstubAllEnvs();
  seen.length = 0;
});

describe('公网评审版输出语言', () => {
  it('不设 TG_PUBLIC_LANG 时系统提示原样;设 en 时追加一次英文要求', () => {
    expect(withOutputLanguage('你是交易员')).toBe('你是交易员');
    vi.stubEnv('TG_PUBLIC_LANG', 'en');
    const once = withOutputLanguage('你是交易员');
    expect(once.endsWith(ENGLISH_ONLY)).toBe(true);
    expect(withOutputLanguage(once)).toBe(once);
  });

  it('runtime 的大脑出口(判断、信息员、提案、对话共用)把英文要求带进每次模型调用;不设时不带', async () => {
    const state = openStateDb(':memory:');
    const rt = new DemoRuntime({ store: new DemoStore(state), backend: new PaperBackend(), brains: {} });
    await rt.brainFor('pi', 'zai/glm').complete('判断:给出 headline 与 reasons', '行情', {});
    vi.stubEnv('TG_PUBLIC_LANG', 'en');
    await rt.brainFor('pi', 'zai/glm').complete('判断:给出 headline 与 reasons', '行情', {});
    expect(seen[0]).not.toContain('Always respond in English.');
    expect(seen[1]).toContain('Always respond in English.');
    state.close();
  });
});
