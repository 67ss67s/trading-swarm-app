/**
 * §9.55 九个 agent 名册:规范线程 id 约定、AGENT.md 切块。
 */
import { describe, expect, it } from 'vitest';
import { AGENT_ROLES, FALLBACK_AGENTS, agentMdSection, agentSessionId, roleOfSession } from '../src/api/agents';

describe('规范线程', () => {
  it('九个 agent,gate_captain 走 default,其余 agent:<role>,可逆', () => {
    expect(AGENT_ROLES).toHaveLength(9);
    expect(new Set(FALLBACK_AGENTS.agents.map((a) => a.callsign)).size).toBe(9);
    for (const r of AGENT_ROLES) expect(roleOfSession(agentSessionId(r))).toBe(r);
    expect(agentSessionId('asp_agent')).toBe('agent:asp_agent');
    expect(roleOfSession('default')).toBe('gate_captain');
    expect(roleOfSession('ses-abc')).toBeNull();
    expect(roleOfSession('agent:nobody')).toBeNull();
  });
});

describe('AGENT.md 切块', () => {
  const md = '# ASP Agent\n\n## 我是谁\n我是 Trading Swarm 的 ASP。\n\n## 我负责\n- 接单\n- 领款\n\n## 我不负责(找谁)\n下单找 @EXEC\n';
  it('按固定二级标题取段,括号标题也行,缺的返回 null', () => {
    expect(agentMdSection(md, '我是谁')).toBe('我是 Trading Swarm 的 ASP。');
    expect(agentMdSection(md, '我负责')).toBe('- 接单\n- 领款');
    expect(agentMdSection(md, '我不负责(找谁)')).toBe('下单找 @EXEC');
    expect(agentMdSection(md, '红线')).toBeNull();
  });
});
