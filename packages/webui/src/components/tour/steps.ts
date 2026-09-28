/**
 * 评审版新手引导的六步(2026-09-26,OKX DevDay 评审用)。
 * 每步:跳到哪个 hash、指向哪个元素(data-tour 属性,找不到就退化成居中卡片)、属于哪种状态(LIVE / Snapshot / Locked)、
 * 2–3 句英文说明。文案只给评审看,直接写英文、不走 t()。
 */
import { askAgent } from '@/lib/ask-agent';
import { OKX_AI_LISTING_ID, OKX_AI_LISTING_URL } from '@/lib/edition';
import type { StatusKind } from './status-tag';

export interface TourLink {
  label: string;
  /** '#hash' 站内跳转,'https://…' 新窗口打开 */
  href: string;
  /** 跳转前先做的事(比如先把 Agent 页右栏切到 Jev tab) */
  before?: () => void;
}

export interface TourStep {
  id: string;
  /** 进这一步时跳到的 hash(不带 #) */
  hash: string;
  /** 依次尝试的选择器,第一个在页面上找得到、且有尺寸的就高亮 */
  targets: string[];
  tags: StatusKind[];
  title: string;
  body: string[];
  links?: TourLink[];
  /** 找到目标元素之后(或等不到时兜底)执行一次 */
  onEnter?: () => void;
}

export const TOUR_SAMPLE_QUESTION = 'Recommend a few coins for this week';

/** Agent 页右栏的 tab 记在 localStorage(components/agent-side.tsx),跳过去前先写好 */
export function preselectJevTab(): void {
  try {
    window.localStorage.setItem('tg.agent.side.tab', 'jev');
  } catch {
    /* 隐私模式 */
  }
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'floor',
    hash: 'floor',
    targets: ['[data-tour="floor-scene"]'],
    tags: ['live'],
    title: 'A team of agents at work',
    body: [
      'Each desk on this floor is one role (the captain, radar, strategy lab, risk, reviewer and more), and the envelopes you see moving between desks are real hand-offs.',
      'Click any agent to walk into its room and talk to it. The THREAD desk on the right streams Jev’s live judgments.',
    ],
  },
  {
    id: 'agent',
    hash: 'agent',
    // 指向输入框 + 发送键(卡片落在它上方,不挡住「Send」);找不到再退到整个对话区
    targets: ['[data-tour="agent-chat"] [data-tour="chat-input"]', '[data-tour="agent-chat"]'],
    tags: ['live'],
    title: 'Ask the agent',
    body: [
      `We typed “${TOUR_SAMPLE_QUESTION}” into the chat box for you. Press Send when you’re ready.`,
      'The reply comes from DeepSeek in real time: you will see each read-only tool call it makes, then a recommendation card of coins and timeframes.',
    ],
    onEnter: () => askAgent(TOUR_SAMPLE_QUESTION),
  },
  {
    id: 'research',
    hash: 'strategy-research?step=scout',
    targets: ['[data-tour="scout-studies"]', '[data-testid="step-scout"]'],
    tags: ['live'],
    title: 'Strategy research, scored honestly',
    body: [
      'Five finished scouting runs cover 10 coins on real OKX history. Open one to see its scorecard, the luck discount (how much of a good backtest is probably noise) and which setups made the paper-candidate bench.',
      'When nothing survives, the run says “Nothing usable” in plain words instead of hiding it.',
    ],
  },
  {
    id: 'trade',
    hash: 'trade',
    targets: ['[data-tour="trade-runs"]', '[data-testid="trade-context-bar"]'],
    tags: ['live'],
    title: 'Four candidates trading on paper',
    body: [
      'The bench candidates (SOL 15m, ETH 4h, BTC 4h, SUI 15m) run in auto mode on paper against live OKX prices. Open any of them in My Strategies to pause or resume it.',
      'The SUI run also has Jev judge every candidate in shadow mode: the verdict is recorded next to the trade without blocking it.',
    ],
    links: [{ label: 'My Strategies', href: '#my-strategies' }],
  },
  {
    id: 'okx-ai',
    hash: 'market',
    targets: ['[data-tour="okx-snapshot"]'],
    tags: ['snapshot', 'locked'],
    title: 'Our real agent on OKX.AI',
    body: [
      `This page is a read-only snapshot of our live ASP on OKX.AI (Agent #${OKX_AI_LISTING_ID}): the services we list, subscriptions and deliveries.`,
      'Buying, publishing and wallet actions are locked here. The listing itself is live on OKX.AI.',
    ],
    links: [{ label: `Agent #${OKX_AI_LISTING_ID} on OKX.AI`, href: OKX_AI_LISTING_URL }],
  },
  {
    id: 'review',
    hash: 'history',
    targets: ['[data-tour="history-tabs"]'],
    tags: ['live'],
    title: 'Review every decision',
    body: [
      'Trade review is where every closed paper trade lands, next to a ledger of whether each kind of judgment paid off. Judgments lists every single decision with its inputs.',
      'The Jev stream shows how Jev scored each live candidate, what it cost, and how its follow and skip calls played out.',
    ],
    links: [
      { label: 'Judgments', href: '#judgments' },
      { label: 'Jev stream', href: '#agent', before: preselectJevTab },
    ],
  },
];

/** 最后一步卡片底部的说明 */
export const TOUR_FOOTNOTE = 'Trading Swarm is our entry for OKX DevDay. Every trade here is paper trading: no real funds are involved.';
