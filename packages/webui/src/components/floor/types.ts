/**
 * 楼层页(#/floor)自己的类型。Bot 团队的持久对象类型已由 api/types.ts 统一声明(v3.6),
 * 这里 re-export 并补两个楼层专用形状:
 *   - BotPresence:网关代码派生的在场状态(2026-09-05 与并行 session 对齐的口径;不落库,模型不能写)。
 *     api/types.ts 的 BotProfile 还没带这个字段,楼层用 `BotProfileWithPresence` 读它,缺失时由
 *     presence.ts 的前端兜底推一份。
 *   - FeedItem:交接流的一行(真 bot_handoffs 行 + activity 映射行)。
 */
import type { BotHandoff, BotProfile, BotRole, HandoffKind, HandoffStatus } from '@/api/types';

export type { BotHandoff, BotProfile, BotRole, BotRun, BotsResponse, HandoffKind, HandoffStatus } from '@/api/types';

export type PresenceState = 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'done' | 'off';

export interface BotPresence {
  state: PresenceState;
  action: string | null;
  since: number | null;
  next_at: number | null;
}

export type BotProfileWithPresence = BotProfile & { presence?: BotPresence };

export type Roled = Pick<BotProfile, 'role'>;
export type RoleId = BotRole;

/**
 * feed 里的一行:真 bot_handoffs 行(source='handoff')和 activity 映射行(source='activity')
 * 走同一个形状,但视觉上必须区分——映射行看起来像协作,实际是单体代码的分支,不能让人误以为
 * 两个 bot 真的在对话(设计稿 §4)。`user` 表示「你」。
 */
export interface FeedItem {
  id: string;
  at: number;
  source: 'handoff' | 'activity';
  /** 活动流映射行才有:原始 activity kind(§9.19:普通 proposal 显示「出策略」,不是等人批的「请求」) */
  activity_kind?: string;
  from: BotRole | 'user';
  to: BotRole | 'user';
  kind: HandoffKind;
  summary: string;
  detail: string | null;
  symbol: string | null;
  status: HandoffStatus | null;
  /** 只有真交接行才有;用来 ack / 应用。 */
  handoff: BotHandoff | null;
  dim: boolean;
}
