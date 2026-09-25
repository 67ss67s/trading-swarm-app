/**
 * §9.52 模型连接与角色底层的前端纯逻辑:角色可选连接/模型、换连接带模型、红点判定、
 * 楼层引导横幅、楼层角色卡改读 effective(老网关回退两槽推断)、409 占用角色、英文词条齐全。
 */
import { describe, expect, it } from 'vitest';
import type { BrainOption, ModelConnection, ModelsView } from '../src/api/types';
import {
  botRoleModel,
  brokenRoles,
  connectionsForRole,
  inUseRoles,
  isDecisionOnlyModel,
  MODEL_ROLE_LABEL,
  modelHintsForRole,
  needsModelSetup,
  okConnectionCount,
  pickModelForConnection,
  SOURCE_LABEL,
} from '../src/components/models/logic';
import { roleBrainDisplay } from '../src/lib/role-brain';
import { EN } from '../src/lib/i18n-en';

const conn = (over: Partial<ModelConnection>): ModelConnection => ({
  id: 'mc_or', kind: 'openrouter', label: 'OpenRouter', base_url: null, cli: null, key_masked: 'sk-or-…c6a5e9', status: 'ok', last_test: null,
  models_hint: ['deepseek/deepseek-v4.1-flash', '~typesafe/jev-latest'], created_at: 1, updated_at: 1, ...over,
});

function view(over: Partial<ModelsView> = {}): ModelsView {
  const or = conn({});
  return {
    connections: [or, conn({ id: 'mc_ds', kind: 'deepseek', label: 'DeepSeek', models_hint: ['deepseek-chat'], status: 'error' })],
    bindings: [
      { role: 'chat', connection_id: null, model: null },
      { role: 'judge', connection_id: 'mc_ds', model: 'deepseek-chat' },
      { role: 'research', connection_id: null, model: null },
      { role: 'filter', connection_id: null, model: null },
      { role: 'reviewer', connection_id: null, model: null },
      { role: 'utility', connection_id: null, model: null },
      { role: 'decision', connection_id: 'mc_or', model: '~typesafe/jev-latest' },
    ],
    effective: {
      chat: { source: 'fallback_main', name: 'pi:zai/glm-5.3' },
      judge: { source: 'binding', name: 'deepseek:deepseek-chat' },
      research: { source: 'fallback_main', name: 'pi:zai/glm-5.3' },
      filter: { source: 'fallback_cheap', name: 'pi:zai/glm-5-turbo' },
      reviewer: { source: 'fallback_cheap', name: 'pi:zai/glm-5-turbo' },
      utility: { source: 'fallback_cheap', name: 'pi:zai/glm-5-turbo' },
      decision: { source: 'binding', name: 'openrouter:~typesafe/jev-latest' },
    },
    cli_detected: [{ tool: 'claude', command: 'claude', ok: true }],
    ...over,
  };
}

describe('role pickers', () => {
  it('decision only lists openrouter and defaults to Jev; other roles drop decision-only models', () => {
    const v = view();
    expect(connectionsForRole('decision', v.connections).map((c) => c.id)).toEqual(['mc_or']);
    expect(connectionsForRole('chat', v.connections)).toHaveLength(2);
    expect(modelHintsForRole('chat', v.connections[0])).toEqual(['deepseek/deepseek-v4.1-flash']);
    expect(modelHintsForRole('decision', v.connections[0])[0]).toBe('~typesafe/jev-latest');
    expect(isDecisionOnlyModel('typesafe/jev-1.13')).toBe(true);
    expect(isDecisionOnlyModel('deepseek/deepseek-v4.1-flash')).toBe(false);
    expect(pickModelForConnection('decision', v.connections[0]!, null)).toBe('~typesafe/jev-latest');
    expect(pickModelForConnection('judge', v.connections[0]!, 'deepseek-chat')).toBe('deepseek/deepseek-v4.1-flash');
    expect(pickModelForConnection('judge', conn({ kind: 'cli', cli: 'codex', models_hint: [] }), null)).toBeNull();
  });
});

describe('health', () => {
  it('pill count and red dots come from connection status of bound roles only', () => {
    const v = view();
    expect(okConnectionCount(v)).toBe(1);
    expect(brokenRoles(v)).toEqual(['judge']);
    expect(okConnectionCount(null)).toBe(0);
  });

  it('setup banner only when no ok connection AND both legacy slots unavailable', () => {
    const none = view({ connections: [] });
    const brains = (a: boolean, b: boolean) => [{ kind: 'pi', available: a }, { kind: 'claude', available: b }] as BrainOption[];
    const slots = { brain: 'pi', cheap_brain: 'claude' };
    expect(needsModelSetup(none, brains(false, false), slots)).toBe(true);
    expect(needsModelSetup(none, brains(true, false), slots)).toBe(false);
    expect(needsModelSetup(view(), brains(false, false), slots)).toBe(false);
    expect(needsModelSetup(null, brains(false, false), slots)).toBe(false); // 老网关:不误报
  });

  it('409 body roles are extracted', () => {
    expect(inUseRoles({ error: { code: 'connection_in_use' }, roles: ['judge', 'decision'] })).toEqual(['judge', 'decision']);
    expect(inUseRoles(null)).toEqual([]);
  });
});

describe('floor role cards read effective', () => {
  it('maps bot roles to model roles and flags broken bindings', () => {
    const v = view();
    expect(botRoleModel('thread_manager', v)).toMatchObject({ modelRole: 'judge', source: 'binding', broken: true });
    expect(botRoleModel('gate_captain', v)).toMatchObject({ modelRole: 'chat', source: 'fallback_main', name: 'pi:zai/glm-5.3' });
    expect(roleBrainDisplay('radar', v, null)).toMatchObject({ source: 'fallback_cheap', slot: 'cheap', name: 'pi:zai/glm-5-turbo' });
  });

  it('falls back to the two-slot inference on an old gateway', () => {
    expect(roleBrainDisplay('thread_manager', null, { brain: 'claude:sonnet', cheap_brain: 'pi:zai/glm-5.3' })).toMatchObject({ source: 'slot', slot: 'main', name: 'claude:sonnet' });
  });
});

describe('i18n', () => {
  it('every role / source label has an English entry', () => {
    // tmap 在 zh 下原样返回中文,正好拿来当词典 key 查
    for (const zh of [...Object.values(MODEL_ROLE_LABEL), ...Object.values(SOURCE_LABEL)]) expect(EN[zh], zh).toBeTruthy();
  });
});
