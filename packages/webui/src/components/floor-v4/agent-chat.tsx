/**
 * 楼层里的 agent 对话框(§9.55):点楼层里任一 agent「和它对话」→ 在场景右侧弹出一个像素框,不跳页。
 *   - 对话:就是 Agent 页那个 ChatPanel,钉死在该 agent 的规范线程(default / agent:<role>)。两边同一个 session id,
 *     SSE chat.message 一到两边一起刷新,所以楼层里说的话在 Agent 页也看得到,反之亦然。
 *   - 身份:它的 AGENT.md(我是谁 / 我负责 / 我不负责 / 红线 / 工具)。
 *   - Portfolio Manager 额外在页签上方放「仓位倍率生效模式」三段开关(sizing-mode.tsx)。
 * 配色:外框走楼层主题变量;里面的 ChatPanel 用 shadcn token,在 .fv4-chat 上把 token 映射到楼层变量,不另写一套气泡。
 */
import { useState } from 'react';
import { agentMdSection, chatStateText, loopStatusText, useAgentDetail, useAgents } from '@/api/agents';
import type { AgentCard, BotRole } from '@/api/types';
import { ChatPanel } from '@/components/chat-panel';
import { SESSION_KEY } from '@/components/chat-session-bar';
import { Markdown } from '@/components/markdown';
import { t } from '@/lib/i18n';
import { ROLES } from './engine-b/roles';
import { SizingModeSwitch } from './sizing-mode';

type Tab = 'chat' | 'id';


function Lamp({ a }: { a: AgentCard }) {
  const busy = a.chat.state !== 'idle' && a.chat.state !== 'error';
  const cls = !a.enabled || a.loop.status === 'disabled' ? 'off' : a.loop.status === 'error' || a.chat.state === 'error' ? 'bad' : busy || a.loop.status === 'running' ? 'busy' : a.loop.status === 'paused' ? 'warn' : 'ok';
  return <span className={`lamp ${cls}`} />;
}

const ID_SECTIONS = ['我是谁', '我负责', '我不负责(找谁)', '红线', '我能调的工具', '口径'];

function IdTab({ role, card }: { role: BotRole; card: AgentCard | null }) {
  const q = useAgentDetail(role);
  if (q.isLoading) return <div className="empty">{t('加载中…')}</div>;
  const md = q.data?.agent_md ?? '';
  if (!md) {
    return (
      <div className="idmd">
        <p>{card?.tagline}</p>
        {card?.tools.length ? (
          <ul>
            {card.tools.map((x) => (
              <li key={x.name}>
                <code>{x.name}</code> {x.summary}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">{t('网关还没提供 AGENT.md')}</p>
        )}
      </div>
    );
  }
  const parts = ID_SECTIONS.map((h) => [h, agentMdSection(md, h)] as const).filter(([, v]) => v);
  return <div className="idmd">{parts.length ? parts.map(([h, v]) => <Markdown key={h} text={`#### ${t(h)}\n${v}`} />) : <Markdown text={md} />}</div>;
}

export function FloorAgentChat({ role, onClose }: { role: BotRole; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('chat');
  const agentsQ = useAgents();
  const card = agentsQ.data?.agents.find((a) => a.role === role) ?? null;
  const info = ROLES[role];
  const busy = chatStateText(card?.chat);
  const openInAgentPage = () => {
    try {
      window.localStorage.setItem(SESSION_KEY, card?.session_id ?? (role === 'gate_captain' ? 'default' : `agent:${role}`));
    } catch {
      /* ignore */
    }
    window.location.hash = 'agent';
  };
  return (
    <div className="fv4-chat" role="dialog" aria-label={t('和 {c} 对话', { c: info?.callsign ?? role })} onKeyDown={(e) => e.stopPropagation()}>
      <div className="hd">
        <span className="cs" style={{ color: info?.color }}>
          {info?.callsign ?? card?.callsign ?? role}
        </span>
        <b>{card?.name ?? info?.title ?? role}</b>
        {card ? <Lamp a={card} /> : null}
        <span className="stx">{busy || (card ? loopStatusText(card.loop.status) : '')}</span>
        <button type="button" className="x" onClick={onClose} aria-label={t('关闭')}>
          ×
        </button>
      </div>
      {card?.tagline ? <div className="tg">{card.tagline}</div> : null}
      {/* 组合经理(BOOK)专属:仓位倍率生效模式 = workflow.sizing_agent */}
      {role === 'portfolio_manager' ? <SizingModeSwitch /> : null}
      <div className="tabs" role="tablist">
        {(['chat', 'id'] as Tab[]).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {k === 'chat' ? t('对话') : t('身份')}
          </button>
        ))}
        <button type="button" className="go" onClick={openInAgentPage} title={t('同一条对话,在 Agent 页全屏看')}>
          {t('在 Agent 页打开')} ↗
        </button>
      </div>
      <div className="bd">
        {tab === 'chat' ? (
          <div className="chatwrap">
            <ChatPanel key={role} compact hideFeed session={card?.session_id ?? (role === 'gate_captain' ? 'default' : `agent:${role}`)} />
          </div>
        ) : (
          <IdTab role={role} card={card} />
        )}
      </div>
    </div>
  );
}
