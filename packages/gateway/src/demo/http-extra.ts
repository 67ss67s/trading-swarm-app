/**
 * Extension point for HTTP route modules. Each feature keeps its routes in its own file
 * (`routes-<feature>.ts`) and registers here with ONE line, so parallel work never collides inside
 * http.ts. `createServer` calls every module after the core routes and before the SSE endpoint.
 */
import type http from 'node:http';
import type { DemoRuntime } from './runtime.js';
import type { DemoStore } from './store.js';
import type { BinanceOAuth } from './binance-oauth.js';
import { funnelRoutes } from './routes-funnel.js';
import { indicatorRoutes } from './routes-indicators.js';
import { judgmentLedgerRoutes } from './routes-judgment.js';
import { strategyRoutes } from './routes-strategies.js';
import { attributionRoutes } from './routes-attribution.js';
import { botRoutes } from './routes-bots.js';
import { candidateRoutes } from './routes-candidates.js';
import { strategyRunRoutes } from './routes-strategy-runs.js';
import { recommendationRoutes } from './routes-recommendations.js';
import { agentStrategyRoutes } from './routes-agent-strategy.js';
import { eventRoutes } from './routes-events.js';
import { marketRoutes } from './asp-agent/routes-market.js';
import { followRoutes } from './routes-follow.js';
import { screenerRoutes } from './routes-screener.js';
import { okxOnboardingRoutes } from './routes-okx-onboarding.js';
import { researchRoutes } from './routes-research.js';
import { teamRiskRoutes } from './routes-team-risk.js';
import { modelConnectionRoutes } from './routes-model-connections.js';
import { matrixStudyRoutes } from './routes-matrix-study.js';

export type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, params: Record<string, string>) => Promise<void>;

export interface RouteContext {
  route: (method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', path: string, handler: RouteHandler) => void;
  /** Wraps a handler so thrown errors become JSON error responses. */
  guarded: (fn: RouteHandler) => RouteHandler;
  json: (res: http.ServerResponse, status: number, body: unknown) => void;
  fail: (res: http.ServerResponse, status: number, message: string, code?: string) => void;
  readBody: (req: http.IncomingMessage) => Promise<Record<string, unknown>>;
  rt: DemoRuntime;
  store: DemoStore;
  oauth: BinanceOAuth | null;
  /** Broadcast an SSE event (must be listed in http.ts EVENTS). */
  emit: (event: string, data: unknown) => void;
}

export type RouteModule = (ctx: RouteContext) => void;

export const extraRouteModules: RouteModule[] = [
  // ---- register below (one line per module; keep alphabetical)
  agentStrategyRoutes,
  attributionRoutes,
  botRoutes,
  candidateRoutes,
  // 研究工作台必须排在 eventRoutes 前面:后者有老的 `/api/research/:id`(信息员研究任务),
  // 先注册的先匹配,否则 /api/research/capabilities 会被当成任务 id(2026-09-21)。
  researchRoutes,
  matrixStudyRoutes, // 必须在 eventRoutes 前:后者的 GET /api/research/:id 会吞掉 /api/research/matrix-studies
  eventRoutes,
  followRoutes,
  marketRoutes,
  funnelRoutes,
  indicatorRoutes,
  judgmentLedgerRoutes,
  modelConnectionRoutes,
  okxOnboardingRoutes,
  recommendationRoutes,
  screenerRoutes,
  strategyRoutes,
  strategyRunRoutes,
  teamRiskRoutes,
];
