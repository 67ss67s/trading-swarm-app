/**
 * 对话面板(v3 重做,docs/demo/v3-ui-contract.md §4 / §8.2):
 *   - 「对话 / 动态」两个 tab:对话 = 用户与 agent 的真正往来;动态 = agent 旁白(判断结束 /
 *     成交 / 平仓 / 信息员更新),以前混在一起把回复淹没了。
 *   - 顶部说明 agent 能做什么 + 快捷提问;发送后先乐观显示自己的气泡;等待中显示已等秒数与
 *     队列状态(队列里正在跑扫描时回复要等它跑完)。
 *   - 自动滚到底:自己管一个 overflow-y-auto 的 div(Radix ScrollArea 的滚动层拿不到 ref),
 *     用户往上翻了就不打扰,回到底部又恢复跟随。
 *   - 「问 agent 为什么」入口(src/lib/ask-agent.ts)会把问题预填进输入框。
 *   - 09-25 Agent 页改版:空态 = 欢迎 + 五张建议提问卡(按「策略研究」流程);有对话后输入框上方一排建议胶囊 + 一行能力说明;
 *     点一下只填进输入框不直接发。工具调用显示成「做了什么」一行(components/agent/logic.ts 的 toolAction,中文动作 + 参数摘要),
 *     点开看原始参数与结果。建议与映射的纯逻辑有单测(test/agent-page.test.ts)。
 * 数据源:['chat-messages', kind](App.tsx 收到 SSE chat.message 时前缀失效),['overview'] 拿队列。
 * Agent 页整页用(compact=false),交易页右上角 tabs 里嵌一份小的(compact=true)。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CircleHelp, Compass, Eraser, FileClock, FlaskConical, Info, Repeat, Search, Send, Settings2, Sparkles, Zap, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Markdown } from '@/components/markdown';
import { RecommendationCard } from '@/components/chat/recommendation-card';
import { recommendationIdOf } from '@/api/recommend';
import { useAgentStrategy } from '@/api/agent-strategy';
import { suggestedPrompts, toolAction, type PromptIcon, type SuggestedPrompt, type ToolGroup } from '@/components/agent/logic';
import { ChatSessionBar, readSavedSession, SESSION_KEY } from '@/components/chat-session-bar';
import { onAskAgent, takePendingQuestion } from '@/lib/ask-agent';
import { fmtClock, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, quote } from '@/lib/i18n';
import type { BotRole, ChatMessage, ChatToolCall, QueueView } from '@/api/types';
import { chatStateText, roleOfSession, rolePrompts, useAgents } from '@/api/agents';
import { st } from '@/lib/server-text-en';

type Tab = 'chat' | 'feed';

const NARRATION_PREFIX = '旁白 · '; // i18n-ignore(后端消息前缀,只做匹配)

function msgKind(m: ChatMessage): 'chat' | 'narration' {
  if (m.kind) return m.kind;
  return m.role === 'agent' && m.text.startsWith(NARRATION_PREFIX) ? 'narration' : 'chat';
}

function stripNarration(text: string): string {
  return text.startsWith(NARRATION_PREFIX) ? text.slice(NARRATION_PREFIX.length) : text;
}

function capabilities(): string[] {
  return [
    t('问「为什么」:它会先读判断记录再回答,不凭印象。'),
    t('让它看某个币、跑一次信息员、复查某条线程。'),
    t('让它提议一笔单:数量由代码算;自动执行关着的时候,还要你在界面上点批准。'),
    t('改观察列表、周期、信息员频率、playbook、暂停。风险、杠杆、上限、自动执行只能在工作流面板改。'),
  ];
}

function quickPrompts(watchlist: string[]): string[] {
  const sym = watchlist[0] ?? 'BTCUSDT';
  return [t('现在为什么不开单?'), t('看一下 {symbol}', { symbol: sym }), t('复盘上一笔交易'), t('跑一次信息员'), t('把周期改成 15m'), t('先暂停扫描')];
}

function queueHint(queue: QueueView | null | undefined): string | null {
  if (!queue) return null;
  if (queue.running) {
    if (queue.running.kind === 'chat') return t('正在回复');
    const kindText: Record<string, string> = { scan: t('扫描'), review: t('复查'), info: t('信息员'), manual: t('手动') };
    const what = `${kindText[queue.running.kind] ?? t('判断')}${queue.running.symbol ? ` ${queue.running.symbol}` : ''}`;
    return t('要等正在跑的{what}结束(≤20 秒)', { what });
  }
  if (queue.pending > 0) return t('排队 {n}', { n: queue.pending });
  return null;
}

const GROUP_ICON: Record<ToolGroup, LucideIcon> = { read: Search, research: FlaskConical, act: Zap, config: Settings2 };
const GROUP_TONE: Record<ToolGroup, string> = {
  read: 'bg-muted-foreground/15 text-muted-foreground',
  research: 'bg-primary/15 text-primary',
  act: 'bg-warn/15 text-warn',
  config: 'bg-primary/10 text-primary',
};
const PROMPT_ICON: Record<PromptIcon, LucideIcon> = { recommend: Compass, research: FlaskConical, switch: Repeat, why: CircleHelp, review: FileClock };

/** 工具调用 = 「做了什么」一行:中文动作 + 参数摘要;点开看原始参数与结果(对照日志用)。 */
function ToolCallPill({ call }: { call: ChatToolCall }) {
  const [open, setOpen] = useState(false);
  const a = toolAction(call);
  const Icon = GROUP_ICON[a.group];
  return (
    <div className="max-w-full min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? t('收起原始参数') : t('看原始参数与结果')}
        className="group flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11.5px] transition-colors hover:bg-background/70"
      >
        <span className={cn('grid size-4 shrink-0 place-items-center rounded-full', a.ok ? GROUP_TONE[a.group] : 'bg-destructive/15 text-destructive')}>
          <Icon className="size-2.5" />
        </span>
        <span className={cn('shrink-0 font-medium', a.ok ? 'text-foreground/90' : 'text-destructive')}>{a.verb}</span>
        {a.detail ? <span className="num min-w-0 truncate text-muted-foreground">{st(a.detail)}</span> : null}
        {!a.ok ? <span className="shrink-0 text-destructive">· {t('失败')}</span> : null}
        <ChevronRight className={cn('ml-auto size-3 shrink-0 text-muted-foreground opacity-40 transition group-hover:opacity-100', open && 'rotate-90 opacity-100')} />
      </button>
      {open ? (
        <div className="mt-0.5 mb-1 ml-5">
          <div className="num text-[10px] text-muted-foreground">{a.raw}</div>
          <pre className="num mt-0.5 max-h-56 overflow-auto rounded-md border bg-background/70 p-2 text-[11px] leading-relaxed whitespace-pre-wrap">
            {JSON.stringify({ args: call.args, result: call.result }, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

/** 空态:它是谁 + 能做什么 + 五张建议提问卡(点一下填进输入框)。 */
function Welcome({ prompts, onPick }: { prompts: SuggestedPrompt[]; onPick: (text: string) => void }) {
  return (
    <div className="mx-auto w-full max-w-2xl py-4 animate-in fade-in duration-300">
      <div className="mb-3 flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Sparkles className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold">{t('跟 agent 说你想做什么')}</div>
          <div className="text-[12px] text-muted-foreground">{t('能看数据、能开研究、能切策略;下单要你确认')}</div>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {prompts.map((p) => {
          const Icon = PROMPT_ICON[p.id];
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onPick(p.text)}
              className="group flex items-start gap-2.5 rounded-lg border bg-card p-2.5 text-left transition-colors hover:border-primary/50 hover:bg-primary/5 focus-visible:border-primary focus-visible:outline-none"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground group-hover:bg-primary/15 group-hover:text-primary">
                <Icon className="size-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium text-foreground">{p.title}</span>
                <span className="line-clamp-2 block text-[11.5px] text-muted-foreground">{quote(p.text)}</span>
                <span className="mt-0.5 block text-[10.5px] text-muted-foreground/80">→ {p.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[10.5px] text-muted-foreground">{t('点一下填进输入框,改完再发')}</p>
    </div>
  );
}

/** 非研究类 agent 的空态:它是谁(tagline)+ 三四个它做得到的起手问题 */
function AgentWelcome({ name, tagline, prompts, onPick }: { name: string; tagline: string; prompts: string[]; onPick: (text: string) => void }) {
  return (
    <div className="mx-auto w-full max-w-2xl py-4 animate-in fade-in duration-300">
      <div className="mb-3 flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Sparkles className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold">{t('你在跟 {name} 说话', { name })}</div>
          {tagline ? <div className="text-[12px] text-muted-foreground">{tagline}</div> : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {prompts.map((q) => (
          <button key={q} type="button" onClick={() => onPick(q)} className="rounded-full border bg-card px-2.5 py-1 text-left text-[12px] text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-foreground">
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

function Bubble({ message, optimistic = false }: { message: ChatMessage; optimistic?: boolean }) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  return (
    <div className={cn('flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-1 duration-200', isUser ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[92%] rounded-lg px-2.5 py-1.5 text-[13px]',
          isUser ? 'bg-primary text-primary-foreground' : isSystem ? 'bg-transparent text-muted-foreground italic' : 'bg-muted text-foreground',
          optimistic && 'opacity-70',
        )}
      >
        {message.tool_calls.length ? (
          <div className="mb-1 flex min-w-0 flex-col gap-0.5 border-l-2 border-primary/30 pl-1">
            {message.tool_calls.map((call, i) => (
              <ToolCallPill key={i} call={call} />
            ))}
          </div>
        ) : null}
        {isUser ? <p className="whitespace-pre-wrap">{message.text}</p> : <Markdown text={message.text} />}
        {message.tool_calls.map((call) => recommendationIdOf(call)).filter((id): id is string => !!id).map((id) => (
          <RecommendationCard key={id} id={id} />
        ))}
      </div>
      <span className="num px-0.5 text-[10px] text-muted-foreground">{optimistic ? t('发送中…') : fmtClock(message.at)}</span>
    </div>
  );
}

function FeedRow({ message }: { message: ChatMessage }) {
  return (
    <div className="flex items-baseline gap-2 rounded-sm px-1 py-1 text-[12px] animate-in fade-in duration-200 hover:bg-muted/40">
      <span className="num shrink-0 text-[10.5px] text-muted-foreground">{fmtClock(message.at)}</span>
      <span className="min-w-0 flex-1 leading-snug text-foreground/90">{stripNarration(message.text)}</span>
    </div>
  );
}

/** 跟随到底的滚动容器:用户往上翻就停,回到底部又恢复跟随。 */
function useStickyScroll(depKey: unknown) {
  const ref = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [depKey]);
  const jumpToBottom = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = true;
    el.scrollTop = el.scrollHeight;
  };
  return { ref, onScroll, jumpToBottom };
}

/**
 * `session` 给了 = 受控(楼层对话框:钉死在某个 agent 的规范线程,不画会话条、不写 localStorage);
 * 不给 = Agent 页用法,会话记本机,会话条里按九个 agent 选。
 */
export function ChatPanel({ compact = false, session: fixedSession, hideFeed = false }: { compact?: boolean; session?: string; hideFeed?: boolean }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('chat');
  const [helpOpen, setHelpOpen] = useState(false); // 默认收起(B+ 方案),点 ⓘ 展开
  // v3.8:对话会话(§9.14)。记本机;老网关没有会话接口时 session 参数被忽略,行为同旧版
  const [savedSession, setSessionState] = useState<string>(readSavedSession);
  const session = fixedSession ?? savedSession;
  const setSession = (id: string) => {
    setSessionState(id);
    try {
      window.localStorage.setItem(SESSION_KEY, id);
    } catch {
      /* ignore */
    }
  };
  // §9.55:这个会话属于哪个 agent(规范线程);agent 的起手提问与「正在调 xx」都按它来
  const agentsQ = useAgents();
  const agentRole: BotRole | null = roleOfSession(session);
  const agent = agentRole ? agentsQ.data?.agents.find((a) => a.role === agentRole) ?? null : null;
  const researchy = agentRole === null || agentRole === 'gate_captain' || agentRole === 'strategy_lab';
  const now = useNow(1000);

  const chatQ = useQuery({ queryKey: ['chat-messages', 'chat', session], queryFn: () => api.chatMessages(500, 'chat', session) });
  const feedQ = useQuery({ queryKey: ['chat-messages', 'narration'], queryFn: () => api.chatMessages(200, 'narration'), enabled: tab === 'feed' });
  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview, staleTime: 5_000 });
  const watchlist = overviewQ.data?.workflow.watchlist ?? [];
  const stratQ = useAgentStrategy();
  const prompts = useMemo(() => suggestedPrompts({ watchlist, strategy: stratQ.data ?? null }), [watchlist, stratQ.data]);
  const agentPrompts = useMemo(() => (agentRole && !researchy ? rolePrompts(agentRole) : null), [agentRole, researchy]);
  const queue = overviewQ.data?.queue ?? null;

  // 老网关不认 kind 参数会把旁白一起返回,这里再按 kind 过一遍,两边都对。
  const chatMessages = useMemo(() => (chatQ.data?.messages ?? []).filter((m) => msgKind(m) === 'chat'), [chatQ.data]);
  const feedMessages = useMemo(() => (feedQ.data?.messages ?? []).filter((m) => msgKind(m) === 'narration'), [feedQ.data]);

  // ---- 乐观显示自己刚发的那条,服务端列表里出现同文本的 user 消息后撤掉 ----
  const [optimistic, setOptimistic] = useState<ChatMessage | null>(null);
  useEffect(() => {
    if (!optimistic) return;
    const seen = chatMessages.some((m) => m.role === 'user' && m.text === optimistic.text && m.at >= optimistic.at - 5_000);
    if (seen) setOptimistic(null);
  }, [chatMessages, optimistic]);

  const lastReal = chatMessages[chatMessages.length - 1];
  const waitingSince = optimistic ? optimistic.at : lastReal?.role === 'user' ? lastReal.at : null;
  const waitingSec = waitingSince ? Math.max(0, Math.round((now - waitingSince) / 1000)) : 0;
  const pending = waitingSince !== null;
  const hint = pending ? chatStateText(agent?.chat) || queueHint(queue) : null;

  // ---- 输入 / 预填 ----
  const [text, setText] = useState('');
  // Textarea 是普通函数组件不转发 ref,聚焦从外层容器往里找
  const inputWrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const consume = () => {
      const q = takePendingQuestion();
      if (q) {
        setText(q);
        setTab('chat');
        window.setTimeout(() => inputWrapRef.current?.querySelector('textarea')?.focus(), 50);
      }
    };
    consume();
    return onAskAgent(consume);
  }, []);

  /** 建议提问:只填进输入框并聚焦,让用户改完再发 */
  const fill = (q: string) => {
    setText(q);
    setTab('chat');
    window.setTimeout(() => {
      const el = inputWrapRef.current?.querySelector('textarea');
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 30);
  };

  const send = useMutation({
    mutationFn: (raw: string) => api.sendChat(raw, session),
    onMutate: (raw) => {
      setOptimistic({ id: `local-${Date.now()}`, at: Date.now(), role: 'user', text: raw, tool_calls: [], episode_id: null, kind: 'chat' });
      setText('');
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['chat-messages'] }),
    onError: (err, raw) => {
      setOptimistic(null);
      setText(raw);
      toast.error(t('发送失败'), { description: err instanceof Error ? err.message : String(err) });
    },
  });

  const submit = (raw: string = text) => {
    const v = raw.trim();
    if (!v || send.isPending) return;
    setTab('chat');
    send.mutate(v);
  };

  const reset = useMutation({
    mutationFn: () => api.resetChat(session),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['chat-messages'] });
      toast.success(t('对话已清空'));
    },
    onError: (err) => toast.error(t('清空失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  const shown = tab === 'chat' ? chatMessages : feedMessages;
  const scrollKey = `${tab}:${shown.length}:${optimistic?.id ?? ''}:${pending ? 1 : 0}`;
  const { ref: scrollRef, onScroll, jumpToBottom } = useStickyScroll(scrollKey);
  useEffect(() => {
    jumpToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏:tab + 说明开关 + 清空(楼层对话框自己有 tab,hideFeed 时不画) */}
      <div className={cn('flex shrink-0 items-center gap-1 border-b px-2', compact ? 'h-7' : 'h-8', hideFeed && 'hidden')}>
        {(hideFeed ? (['chat'] as Tab[]) : (['chat', 'feed'] as Tab[])).map((tk) => (
          <button
            key={tk}
            type="button"
            onClick={() => setTab(tk)}
            className={cn(
              'rounded px-2 py-0.5 text-[11.5px] transition-colors',
              tab === tk ? 'bg-accent font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tk === 'chat' ? t('对话') : t('动态')}
            {tk === 'feed' && feedQ.data ? <span className="num ml-1 text-[10px] text-muted-foreground">{feedMessages.length}</span> : null}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-0.5">
          <Button variant="ghost" size="icon-xs" title={t('agent 能做什么')} aria-label={t('agent 能做什么')} onClick={() => setHelpOpen((v) => !v)}>
            <Info className={cn(helpOpen && 'text-primary')} />
          </Button>
          {!compact ? (
            <Button
              variant="ghost"
              size="icon-xs"
              title={t('清空对话')}
              aria-label={t('清空对话')}
              disabled={reset.isPending}
              onClick={() => {
                if (window.confirm(t('清空这个会话的对话记录?'))) reset.mutate();
              }}
            >
              <Eraser />
            </Button>
          ) : null}
        </div>
      </div>

      {tab === 'chat' && fixedSession === undefined ? <ChatSessionBar session={session} onChange={setSession} compact={compact} /> : null}

      {/* 能力说明 + 快捷提问 */}
      {helpOpen ? (
        <div className={cn('shrink-0 border-b bg-muted/30 px-3 py-2 animate-in fade-in slide-in-from-top-1 duration-200', compact && 'px-2 py-1.5')}>
          {!compact ? (
            <>
              <div className="mb-1 flex items-center gap-1 text-[11.5px] font-medium text-foreground">
                {t('这个 agent 能做什么')}
                <button type="button" className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => setHelpOpen(false)} aria-label={t('收起')}>
                  <ChevronDown className="size-3.5" />
                </button>
              </div>
              <ul className="mb-2 list-disc space-y-0.5 pl-4 text-[11.5px] text-muted-foreground">
                {capabilities().map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </>
          ) : null}
          <div className="flex flex-wrap gap-1">
            {(agentPrompts ?? quickPrompts(watchlist)).map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => submit(q)}
                disabled={send.isPending}
                className="rounded-full border bg-card px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* 消息列表 */}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn('flex flex-col gap-3 p-3', compact && 'gap-2 p-2', tab === 'feed' && 'gap-0.5')}>
          {tab === 'chat' ? (
            <>
              {chatQ.isLoading ? <div className="py-10 text-center text-[12px] text-muted-foreground">{t('加载中…')}</div> : null}
              {!chatQ.isLoading && chatMessages.length === 0 && !optimistic ? (
                agentPrompts ? (
                  <AgentWelcome name={agent?.name ?? agentRole ?? ''} tagline={agent?.tagline ?? ''} prompts={agentPrompts} onPick={fill} />
                ) : compact ? (
                  <div className="py-10 text-center text-[12.5px] text-muted-foreground">{t('还没有对话。问问它现在为什么不开单,或者让它看看某个币。')}</div>
                ) : (
                  <Welcome prompts={prompts} onPick={fill} />
                )
              ) : null}
              {chatMessages.map((m) => (
                <Bubble key={m.id} message={m} />
              ))}
              {optimistic ? <Bubble key={optimistic.id} message={optimistic} optimistic /> : null}
              {pending ? (
                <div className="flex items-center gap-2 text-[12px] text-muted-foreground animate-in fade-in duration-300">
                  <span className="typing-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>
                    {t('正在思考…')} <span className="num">{waitingSec}</span> {t('秒')}
                  </span>
                  {hint ? <span className="text-[11px] text-muted-foreground/80">· {hint}</span> : null}
                </div>
              ) : null}
            </>
          ) : (
            <>
              {feedQ.isLoading ? <div className="py-10 text-center text-[12px] text-muted-foreground">{t('加载中…')}</div> : null}
              {!feedQ.isLoading && feedMessages.length === 0 ? (
                <div className="py-10 text-center text-[12.5px] text-muted-foreground">{t('还没有动态。agent 每次判断、成交、平仓、信息员更新,都会在这儿说一句。')}</div>
              ) : null}
              {feedMessages.map((m) => (
                <FeedRow key={m.id} message={m} />
              ))}
            </>
          )}
        </div>
      </div>

      {/* 输入区:建议胶囊(有对话后)+ 输入框 + 能力说明 */}
      <div className="shrink-0 border-t">
      {!compact && tab === 'chat' && (chatMessages.length > 0 || optimistic) && agentPrompts ? (
        <div className="flex items-center gap-1.5 overflow-x-auto px-2 pt-1.5 [scrollbar-width:none]">
          <span className="shrink-0 text-[10.5px] text-muted-foreground">{t('试试')}</span>
          {agentPrompts.map((q) => (
            <button key={q} type="button" onClick={() => fill(q)} className="inline-flex shrink-0 items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground">
              {q}
            </button>
          ))}
        </div>
      ) : null}
      {!compact && tab === 'chat' && (chatMessages.length > 0 || optimistic) && !agentPrompts ? (
        <div className="flex items-center gap-1.5 overflow-x-auto px-2 pt-1.5 [scrollbar-width:none]">
          <span className="shrink-0 text-[10.5px] text-muted-foreground">{t('试试')}</span>
          {prompts.map((p) => {
            const Icon = PROMPT_ICON[p.id];
            return (
              <button
                key={p.id}
                type="button"
                title={p.text}
                onClick={() => fill(p.text)}
                className="inline-flex shrink-0 items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                <Icon className="size-3" />
                {p.title}
              </button>
            );
          })}
        </div>
      ) : null}
      {/* data-tour:评审版新手引导第 2 步指向输入框 + 发送 */}
      <div ref={inputWrapRef} className="flex items-end gap-2 p-2" data-tour="chat-input">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={agent && agentRole !== 'gate_captain' ? t('跟 {name} 说点什么…(Enter 发送,Shift+Enter 换行)', { name: agent.name }) : t('跟 agent 说点什么…(Enter 发送,Shift+Enter 换行)')}
          className={cn('min-h-8 resize-none text-[13px]', compact ? 'h-8' : 'h-16')}
          disabled={send.isPending}
        />
        <Button size="sm" onClick={() => submit()} disabled={!text.trim() || send.isPending} aria-label={t('发送')}>
          <Send data-slot="icon" />
          {t('发送')}
        </Button>
      </div>
      {!compact && (chatMessages.length > 0 || optimistic) ? <div className="-mt-1 px-2.5 pb-1.5 text-[10.5px] text-muted-foreground">{agentPrompts ? agent?.tagline : t('能看数据、能开研究、能切策略;下单要你确认')}</div> : null}
      </div>
    </div>
  );
}
