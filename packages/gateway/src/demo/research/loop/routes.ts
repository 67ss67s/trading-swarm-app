import { revisionContext } from './revisions.js';
import type { IncomingMessage } from "node:http";
import type { RouteModule, RouteHandler } from "../../http-extra.js";
import type { LoopContext } from "./store.js";
import { LoopStore } from "./store.js";
import { LoopService } from "./service.js";
import { BacktestBridge } from "./backtest.js";
import { okxMarketData } from "../data/index.js";
import type { ResearchStore } from "../store.js";
import type { ResearchService } from "../service.js";
import { check } from "./schema.js";
/** Register before old chat/artifact routes; all operations remain research-only. */
export function registerLoopRoutes(
  ctx: Parameters<RouteModule>[0],
  research: ResearchStore,
  researchService: ResearchService,
  body: (req: IncomingMessage) => Promise<unknown>,
): LoopService {
  const store = new LoopStore(ctx.store.marketDb),
    svc = new LoopService(store, {
      market: okxMarketData(),
      brain: () => ctx.rt.brainForRole('research'),
      backtests: new BacktestBridge(research, researchService),
      emit: (event) => ctx.emit("research.inquiry", event),
    });
  const wrap =
    (handler: RouteHandler): RouteHandler =>
    async (req, res, url, p) => {
      try {
        await handler(req, res, url, p);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        ctx.fail(
          res,
          message.includes("not_found")
            ? 404
            : /busy|conflict|not_awaiting_input/.test(message)
              ? 409
              : 400,
          message,
          message === "research_session_busy" ? message : "research_error",
        );
      }
    };
  const object = async (req: IncomingMessage) =>
    check<Record<string, unknown>>("Object", await body(req));
  ctx.route(
    "POST",
    "/api/research/sessions",
    wrap(async (req, res) => {
      const raw = await object(req);
      ctx.json(res, 201, store.createSession(raw.title as string | undefined));
    }),
  );
  ctx.route(
    "GET",
    "/api/research/sessions",
    wrap(async (_req, res, url) =>
      ctx.json(res, 200, {
        items: store.sessions(Number(url.searchParams.get("limit") ?? 100)),
      }),
    ),
  );
  ctx.route(
    "GET",
    "/api/research/sessions/:id",
    wrap(async (_req, res, _url, p) => ctx.json(res, 200, svc.session(p.id!))),
  );
  ctx.route(
    "PATCH",
    "/api/research/sessions/:id/context",
    wrap(async (req, res, _url, p) =>
      ctx.json(
        res,
        200,
        svc.context(p.id!, (await object(req)) as Partial<LoopContext>),
      ),
    ),
  );
  ctx.route(
    "POST",
    "/api/research/sessions/:id/messages",
    wrap(async (req, res, _url, p) => {
      const raw = await object(req);
      ctx.json(
        res,
        202,
        svc.ask(
          p.id!,
          raw.text as string,
          raw.idempotency_key as string,
          raw.context as Partial<LoopContext> | undefined,
        ),
      );
    }),
  );
  ctx.route(
    "GET",
    "/api/research/inquiries/:id/events",
    wrap(async (_req, res, url, p) => {
      const after = Number(url.searchParams.get("after") ?? 0),
        items = store.events(p.id!, after);
      ctx.json(res, 200, { items, next_cursor: items.at(-1)?.seq ?? after });
    }),
  );
  ctx.route(
    "GET",
    "/api/research/inquiries/:id",
    wrap(async (_req, res, _url, p) => ctx.json(res, 200, svc.inquiry(p.id!))),
  );
  ctx.route(
    "POST",
    "/api/research/inquiries/:id/answer",
    wrap(async (req, res, _url, p) => {
      const raw = await object(req);
      ctx.json(res, 202, svc.answer(p.id!, raw.text as string));
    }),
  );
  ctx.route(
    "POST",
    "/api/research/inquiries/:id/cancel",
    wrap(async (_req, res, _url, p) => ctx.json(res, 200, svc.cancel(p.id!))),
  );
  ctx.route(
    "GET",
    "/api/research/artifacts/:id",
    wrap(async (_req, res, _url, p) =>
      ctx.json(res, 200, store.artifact(p.id!)),
    ),
  );
  ctx.route(
    "GET",
    "/api/research/snapshots/:id",
    wrap(async (_req, res, url, p) => {
      const snapshot = store.snapshot(p.id!);
      const { rows: _, ...metadata } = snapshot;
      ctx.json(
        res,
        200,
        url.searchParams.get("rows") === "0" ? metadata : snapshot,
      );
    }),
  );
  ctx.route(
    "GET",
    "/api/research/tools",
    wrap(async (_req, res) =>
      ctx.json(res, 200, { items: svc.registry.catalog() }),
    ),
  );
  ctx.route("POST", "/api/research/sessions/:id/commands", wrap(async (req, res, _url, p) => {
    const raw = await object(req);
    ctx.json(res, 202, svc.command(p.id!, raw.command, raw.idempotency_key as string));
  }));
  ctx.route("GET", "/api/research/runs/:id/revision-context", wrap(async (_req, res, _url, p) => {
    ctx.json(res, 200, revisionContext(svc.options.backtests!, p.id!));
  }));
  return svc;
}
