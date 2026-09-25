// chat.ts: parseToolLine (the `@@tool {...}` text protocol) and runChatTurn (scripted brain +
// tool loop, round-limited, both turns persisted/emitted).

import { describe, expect, it, vi } from 'vitest';
import { parseToolLine, runChatTurn, type ChatDeps, type ChatTools } from '../../src/demo/chat.js';
import type { Brain, BrainResult } from '../../src/demo/brain.js';
import type { ChatMessage } from '../../src/demo/types.js';

// ---------------------------------------------------------------- parseToolLine

describe('parseToolLine', () => {
  it('parses a valid @@tool line with name and args', () => {
    const r = parseToolLine('sure, let me check.\n@@tool {"name":"get_state","args":{"a":1}}');
    expect(r).toEqual({ name: 'get_state', args: { a: 1 } });
  });

  it('defaults args to {} when omitted', () => {
    const r = parseToolLine('@@tool {"name":"get_state"}');
    expect(r).toEqual({ name: 'get_state', args: {} });
  });

  it('returns null when the JSON on the @@tool line is invalid', () => {
    const r = parseToolLine('@@tool {not valid json}');
    expect(r).toBeNull();
  });

  it('returns null when the object has no "name" field', () => {
    const r = parseToolLine('@@tool {"args":{}}');
    expect(r).toBeNull();
  });

  it('returns null when there is no @@tool line at all', () => {
    expect(parseToolLine('just a normal reply, no tools needed')).toBeNull();
  });

  it('matches a @@tool line anywhere, not just at the start', () => {
    const r = parseToolLine('Some preamble text.\n@@tool {"name":"run_scan","args":{"symbol":"BTCUSDT"}}\ntrailing text after does not matter for the regex start');
    expect(r).toEqual({ name: 'run_scan', args: { symbol: 'BTCUSDT' } });
  });
});

// ---------------------------------------------------------------- runChatTurn

function scriptedBrain(replies: string[]): Brain {
  let i = 0;
  return {
    name: 'stub',
    async complete(): Promise<BrainResult> {
      const text = replies[Math.min(i, replies.length - 1)]!;
      i++;
      return { text, latency_ms: 1, model: 'stub', input_tokens: 0, output_tokens: 0 };
    },
  };
}

function mkTools(overrides: Partial<ChatTools> = {}): ChatTools {
  return {
    get_state: () => ({ ok: true }),
    list_threads: () => [],
    get_thread: () => ({ error: 'not found' }),
    propose_thread: async () => ({ accepted: false }),
    close_thread: async () => ({ ok: true }),
    set_workflow: () => ({ ok: true }),
    run_scan: () => ({ queued: false }),
    run_info: () => ({ queued: false }),
    run_review: () => ({ queued: false }),
    ...overrides,
  };
}

function mkDeps(brain: Brain, tools: ChatTools = mkTools()): { deps: ChatDeps; saved: ChatMessage[]; emitted: ChatMessage[] } {
  const saved: ChatMessage[] = [];
  const emitted: ChatMessage[] = [];
  const deps: ChatDeps = {
    brain: () => brain,
    tools,
    stateSummary: () => 'state summary',
    history: () => saved,
    save: (m) => saved.push(m),
    emit: (m) => emitted.push(m),
    log: () => {},
  };
  return { deps, saved, emitted };
}

describe('runChatTurn: tool call then final reply', () => {
  it('records the tool call with its result, then finishes with the second reply', async () => {
    const brain = scriptedBrain(['looking that up...\n@@tool {"name":"get_state","args":{}}', '账户权益 10000 USDT。']);
    const { deps, saved, emitted } = mkDeps(brain, mkTools({ get_state: () => ({ equity: '10000' }) }));

    const agentMsg = await runChatTurn(deps, '我现在权益多少?');

    expect(agentMsg.role).toBe('agent');
    expect(agentMsg.text).toBe('账户权益 10000 USDT。');
    expect(agentMsg.tool_calls).toHaveLength(1);
    expect(agentMsg.tool_calls[0]).toMatchObject({ name: 'get_state', args: {}, ok: true, result: { equity: '10000' } });

    // both the user message and the final agent message were saved and emitted
    expect(saved.map((m) => m.role)).toEqual(['user', 'agent']);
    expect(saved[0]!.text).toBe('我现在权益多少?');
    expect(emitted.map((m) => m.role)).toEqual(['user', 'agent']);
  });

  it('a reply with no tool line finishes immediately with zero tool calls', async () => {
    const brain = scriptedBrain(['你好,有什么可以帮你?']);
    const { deps } = mkDeps(brain);
    const agentMsg = await runChatTurn(deps, '你好');
    expect(agentMsg.tool_calls).toEqual([]);
    expect(agentMsg.text).toBe('你好,有什么可以帮你?');
  });

  it('an unknown tool name records ok:false with an error result, and the loop still finishes', async () => {
    const brain = scriptedBrain(['@@tool {"name":"nonexistent_tool","args":{}}', '好的,已处理。']);
    const { deps } = mkDeps(brain);
    const agentMsg = await runChatTurn(deps, '帮我做点什么');
    expect(agentMsg.tool_calls).toHaveLength(1);
    expect(agentMsg.tool_calls[0]!.ok).toBe(false);
    expect(agentMsg.tool_calls[0]!.result).toMatchObject({ error: expect.stringMatching(/未知工具/) });
    expect(agentMsg.text).toBe('好的,已处理。');
  });

  it('a tool that throws is caught and recorded as ok:false', async () => {
    const brain = scriptedBrain(['@@tool {"name":"run_scan","args":{}}', '扫描失败了,我已经记录。']);
    const { deps } = mkDeps(brain, mkTools({ run_scan: () => { throw new Error('boom'); } }));
    const agentMsg = await runChatTurn(deps, '扫描一下');
    expect(agentMsg.tool_calls[0]).toMatchObject({ name: 'run_scan', ok: false, result: { error: 'boom' } });
  });

  it('enforces the round limit: a brain that always calls tools eventually stops and falls back to a message', async () => {
    const brain: Brain = {
      name: 'stub',
      async complete(): Promise<BrainResult> {
        return { text: '@@tool {"name":"get_state","args":{}}', latency_ms: 1, model: 'stub', input_tokens: 0, output_tokens: 0 };
      },
    };
    const { deps } = mkDeps(brain);
    const agentMsg = await runChatTurn(deps, '一直调用工具');
    // current limit is 4 rounds (chat.ts: `for (let round = 0; round < 4; round++)`)
    expect(agentMsg.tool_calls).toHaveLength(4);
    expect(agentMsg.text.length).toBeGreaterThan(0); // falls back to a "ran out of rounds" message
  });

  it('multiple sequential tool calls are all recorded in order', async () => {
    const brain = scriptedBrain(['@@tool {"name":"run_info","args":{}}', '@@tool {"name":"run_scan","args":{"symbol":"BTCUSDT"}}', '两步都做完了。']);
    const { deps } = mkDeps(brain, mkTools({ run_info: () => ({ queued: true }), run_scan: () => ({ queued: true }) }));
    const agentMsg = await runChatTurn(deps, '先跑信息员再扫描');
    expect(agentMsg.tool_calls.map((c) => c.name)).toEqual(['run_info', 'run_scan']);
    expect(agentMsg.text).toBe('两步都做完了。');
  });
});

// ---------------------------------------------------------------- v3.8: sessions + execute gating

import { EXECUTE_TOOLS, systemPrompt } from '../../src/demo/chat.js';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';

describe('v3.8 chat sessions and execute gating', () => {
  it('v3.10.1: approve_intent is a normal tool again (the switch chat_requires_approval decides execute vs card); request_execution exists; EXECUTE_TOOLS empty', async () => {
    const approve = vi.fn(async () => ({ id: 'int-1', status: 'approved' }));
    const brain = scriptedBrain(['@@tool {"name":"approve_intent","args":{"id":"int-1"}}', '已批准。']);
    const { deps } = mkDeps(brain, mkTools({ approve_intent: approve }));
    const msg = await runChatTurn({ ...deps, can_execute: false, session_id: 'cs-x' }, '执行 int-1');
    expect(approve).toHaveBeenCalledTimes(1);
    expect(msg.tool_calls[0]!.ok).toBe(true);
    expect(msg.session_id).toBe('cs-x');
    const request = vi.fn(() => ({ needs_confirmation: true, intent_id: 'int-1' }));
    const brain2 = scriptedBrain(['@@tool {"name":"request_execution","args":{"id":"int-1"}}', '确认卡已推到界面,请点执行。']);
    const { deps: deps2 } = mkDeps(brain2, mkTools({ request_execution: request }));
    const msg2 = await runChatTurn({ ...deps2, session_id: 'cs-x' }, '执行 int-1');
    expect(request).toHaveBeenCalledTimes(1);
    expect(msg2.tool_calls[0]!.ok).toBe(true);
    expect(systemPrompt(false)).toContain('approve_intent{');
    expect(systemPrompt(false)).toContain('request_execution{');
    expect(EXECUTE_TOOLS).toEqual([]);
    // tool names resolve only through own keys — prototype names are unknown tools
    const brain3 = scriptedBrain(['@@tool {"name":"constructor","args":{}}', 'ok']);
    const { deps: deps3 } = mkDeps(brain3);
    const msg3 = await runChatTurn(deps3, 'x');
    expect(msg3.tool_calls[0]).toMatchObject({ name: 'constructor', ok: false });
  });

  it('store: sessions are created/listed/updated/deleted; messages are scoped per session; narration is shared; default cannot be deleted', () => {
    const state = openStateDb(':memory:');
    const store = new DemoStore(state);
    expect(store.chatSessions().map((s) => s.id)).toEqual(['default']);
    const a = store.createChatSession('BTC 讨论', 1000);
    let t = Date.now() + 60_000; // 默认会话由迁移建在「现在」,新消息要比它晚才能排到前面
    const m = (id: string, text: string, sid: string | null, kind: 'chat' | 'narration' = 'chat') => ({ id, at: (t += 1000), role: 'user' as const, text, tool_calls: [], episode_id: null, kind, session_id: sid });
    store.saveChat(m('m1', 'hello default', 'default'));
    store.saveChat(m('m2', 'hello A', a.id));
    store.saveChat(m('m3', '旁白 · 扫了一轮', null, 'narration'));
    expect(store.chat(50, 'chat', a.id).map((x) => x.text)).toEqual(['hello A']);
    expect(store.chat(50, 'chat', 'default').map((x) => x.text)).toEqual(['hello default']);
    expect(store.chat(50, 'all', a.id).map((x) => x.text).sort()).toEqual(['hello A', '旁白 · 扫了一轮']);
    expect(store.chat(50, 'chat').map((x) => x.text).sort()).toEqual(['hello A', 'hello default']); // no session → all
    const sessions = store.chatSessions();
    expect(sessions[0]!.id).toBe(a.id); // most recently updated first
    expect(sessions.find((s) => s.id === a.id)).toMatchObject({ message_count: 1, last_text: 'hello A', can_execute: false });
    expect(store.updateChatSession(a.id, { can_execute: true, title: '改名' })).toMatchObject({ can_execute: true, title: '改名' });
    expect(store.updateChatSession(a.id, { archived: true })!.archived).toBe(true);
    expect(store.chatSessions().map((s) => s.id)).toEqual(['default']);
    expect(store.chatSessions({ include_archived: true })).toHaveLength(2);
    expect(store.deleteChatSession('default')).toBe(false);
    expect(store.deleteChatSession(a.id)).toBe(true);
    expect(store.chat(50, 'chat', a.id)).toEqual([]);
    store.clearChat('default');
    expect(store.chat(50, 'chat', 'default')).toEqual([]);
    expect(store.chat(50, 'narration')).toHaveLength(1);
    state.close();
  });
});
