/**
 * Pine 脚本目录的 HTTP 面(研究域,零下单):
 *   GET    /api/research/pine/health          引擎托管状态 {status: up|starting|down|disabled, pid, port, restarts,
 *                                             last_error, engine:'pinets', version, scripts, admitted, hint?}
 *   GET    /api/research/pine/scripts         列表 / 搜索(q、admitted、limit)
 *   POST   /api/research/pine/scripts         新增,自动跑一次准入(合成 + 真实行情两套;inputs_schema 缺省从源码推导)
 *   GET    /api/research/pine/scripts/:id     详情(含脚本正文与准入报告)
 *   PATCH  /api/research/pine/scripts/:id     改;动了正文/参数即作废准入
 *   DELETE /api/research/pine/scripts/:id     删
 *   POST   /api/research/pine/scripts/:id/admit  重跑准入(body 可带 inputs / dataset_id / bars / sample_bars)
 *   POST   /api/research/pine/run             即席跑一段序列(给 agent / 前端看图)
 *
 * 主线程只需在 routes-research.ts 里加一行 registerPineRoutes(ctx, store)。
 */
import type { ResearchBar } from '@trading-swarm/contracts';
import type { RouteContext, RouteHandler } from '../../http-extra.js';
import { PineCatalog, setPineCatalog, summarize, type PineScriptDraft } from './catalog.js';
import {
  admitScript, syntheticBars, syntheticSuite, defaultSuites, setAdmissionDataSource, timeframeText,
  type AdmissionReport, type AdmissionSuite, type PineDatasetSource,
} from './admission.js';
import { runPine, pineEngineHealth, inputsRecord, PINE_ENGINE_HINT } from './client.js';
import { effectiveInputsSchema, schemaDefaults, validatePineInputs } from './inputs-schema.js';
import { setPineRuntime, defaultPineRuntime } from '../primitives/pine.js';

export type { PineDatasetSource } from './admission.js';

const asRecord = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected_object_body');
  return raw as Record<string, unknown>;
};

/**
 * 准入用的数据套:合成数据永远有;显式给了 dataset_id / bars 就作为第二套(custom),
 * 否则第二套取研究库里最新的日线/4h 数据集(market),库里没有就只有合成一套。
 */
function admissionSuites(raw: Record<string, unknown>, source?: PineDatasetSource): AdmissionSuite[] {
  const synthetic = syntheticSuite(Number(raw.sample_bars ?? 320));
  const id = raw.dataset_id as string | undefined;
  if (id && source) {
    const d = source.dataset(id);
    const bars = d.bars.slice(-1200);
    return [synthetic, { id: 'custom', label: `指定数据集 ${d.symbol} ${timeframeText(d.timeframe_ms)}(最后 ${bars.length} 根)`, bars, timeframe: timeframeText(d.timeframe_ms), dataset_id: id, symbol: d.symbol }];
  }
  if (Array.isArray(raw.bars) && raw.bars.length >= 10) {
    return [synthetic, { id: 'custom', label: `内联数据(${raw.bars.length} 根)`, bars: raw.bars as ResearchBar[], timeframe: String(raw.timeframe ?? '1h'), dataset_id: null, symbol: null }];
  }
  const suites = defaultSuites(source);
  suites[0] = synthetic;
  return suites;
}

/** 即席运行用的单套 K 线:给了 dataset_id 用真数据(截到 1200 根),给了 bars 用内联,否则合成。 */
function runBars(raw: Record<string, unknown>, source?: PineDatasetSource): { bars: ResearchBar[]; timeframe: string } {
  const id = raw.dataset_id as string | undefined;
  if (id && source) {
    const d = source.dataset(id);
    return { bars: d.bars.slice(-1200), timeframe: timeframeText(d.timeframe_ms) };
  }
  if (Array.isArray(raw.bars) && raw.bars.length >= 10) return { bars: raw.bars as ResearchBar[], timeframe: String(raw.timeframe ?? '1h') };
  return { bars: syntheticBars(Number(raw.sample_bars ?? 320)), timeframe: '1h' };
}

export function registerPineRoutes(ctx: RouteContext, source?: PineDatasetSource): PineCatalog {
  const catalog = new PineCatalog(ctx.store.marketDb);
  setPineCatalog(catalog);
  // 准入的真实行情套从研究库取(路由 + loop 工具 pine_author 共用)
  setAdmissionDataSource(source ?? null);
  // 原语侧的运行时:目录 + 同步引擎客户端;有 store 时还能把回测窗口还原成整段数据,一个数据集只跑一次引擎。
  setPineRuntime(defaultPineRuntime(
    source ? () => source.datasets() : undefined,
    source ? (id) => source.dataset(id) : undefined,
  ));

  const wrap = (handler: RouteHandler): RouteHandler => async (req, res, url, p) => {
    try { await handler(req, res, url, p); } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 脚本自己跑挂(语法错 / 被沙箱拒)是 422,引擎不可用才是 503——别让前端把脚本错当成引擎挂了
      const scriptFailed = message.includes('pine_script_failed');
      const status = message.includes('not_found') ? 404 : message.includes('conflict') ? 409 : scriptFailed ? 422 : message.includes('PROVIDER_ERROR') ? 503 : 400;
      ctx.fail(res, status, message, scriptFailed ? 'pine_script_failed' : message.includes('PROVIDER_ERROR') ? 'pine_engine_unavailable' : 'pine_error');
    }
  };

  /** 跑一次准入并落库;引擎没起时不写 admitted,把原因如实带回去。 */
  async function admit(id: string, raw: Record<string, unknown>): Promise<{ script: ReturnType<PineCatalog['get']>; report: AdmissionReport | null; error?: string }> {
    const script = catalog.get(id);
    if (!script) throw new Error('pine_script_not_found');
    const suites = admissionSuites(raw, source);
    const schema = effectiveInputsSchema(script.inputs_schema, script.script);
    try {
      const report = await admitScript(script.script, (input) => runPine(input, { noCache: true, timeoutMs: 60000 }), {
        suites, schema,
        inputs: inputsRecord(raw.inputs) ?? schemaDefaults(schema),
      });
      // 调用方显式给的参数不合 schema:这是请求错,不是脚本不合格——不落库,别把已准入的脚本打回未准入
      if (raw.inputs !== undefined && report.checks.some((c) => c.name === 'inputs' && !c.ok)) {
        return { script, report, error: `pine_inputs_invalid:${report.checks.find((c) => c.name === 'inputs')!.message}` };
      }
      report.warnings.push(`测试数据:${suites.map((x) => x.label).join(' + ')}`);
      if (!report.real_data) report.warnings.push('研究库里没有日线/4h 数据集,本次只用了合成数据;导入真实行情后建议重跑准入');
      return { script: catalog.admit(id, report), report };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { script, report: null, error };
    }
  }

  ctx.route('GET', '/api/research/pine/health', wrap(async (_req, res) => {
    const health = pineEngineHealth();
    ctx.json(res, 200, {
      ...health,
      scripts: catalog.list(1000).length,
      admitted: catalog.search('', { admitted: true, limit: 1000 }).length,
      ...(health.status === 'up' ? {} : { hint: PINE_ENGINE_HINT }),
    });
  }));

  ctx.route('GET', '/api/research/pine/scripts', wrap(async (_req, res, url) => {
    const admittedParam = url.searchParams.get('admitted');
    const items = catalog.search(url.searchParams.get('q') ?? '', {
      limit: Number(url.searchParams.get('limit') ?? 50),
      admitted: admittedParam === null ? undefined : admittedParam === 'true' || admittedParam === '1',
    });
    ctx.json(res, 200, { items: items.map(summarize) });
  }));

  ctx.route('GET', '/api/research/pine/scripts/:id', wrap(async (_req, res, _url, p) => {
    const script = catalog.find(p.id!);
    if (!script) throw new Error('pine_script_not_found');
    ctx.json(res, 200, script);
  }));

  ctx.route('POST', '/api/research/pine/scripts', wrap(async (req, res) => {
    const raw = asRecord(await ctx.readBody(req));
    const created = catalog.create(raw as unknown as PineScriptDraft);
    const outcome = await admit(created.id, raw);
    ctx.json(res, 201, { script: outcome.script, admission: outcome.report, error: outcome.error ?? null });
  }));

  ctx.route('PATCH', '/api/research/pine/scripts/:id', wrap(async (req, res, _url, p) => {
    ctx.json(res, 200, catalog.update(p.id!, asRecord(await ctx.readBody(req)) as Partial<PineScriptDraft>));
  }));

  ctx.route('DELETE', '/api/research/pine/scripts/:id', wrap(async (_req, res, _url, p) => {
    if (!catalog.remove(p.id!)) throw new Error('pine_script_not_found');
    ctx.json(res, 200, { ok: true });
  }));

  ctx.route('POST', '/api/research/pine/scripts/:id/admit', wrap(async (req, res, _url, p) => {
    const raw = await ctx.readBody(req).catch(() => ({}));
    const script = catalog.find(p.id!);
    if (!script) throw new Error('pine_script_not_found');
    const outcome = await admit(script.id, asRecord(raw ?? {}));
    ctx.json(res, 200, { script: outcome.script, admission: outcome.report, error: outcome.error ?? null });
  }));

  ctx.route('POST', '/api/research/pine/run', wrap(async (req, res) => {
    const raw = asRecord(await ctx.readBody(req));
    const fromCatalog = raw.script_id ? catalog.find(String(raw.script_id)) : null;
    if (raw.script_id && !fromCatalog) throw new Error('pine_script_not_found');
    const script = fromCatalog?.script ?? String(raw.script ?? '');
    if (!script.trim()) throw new Error('pine_script_required');
    const { bars, timeframe } = runBars(raw, source);
    const inputs = inputsRecord(raw.inputs);
    if (fromCatalog) {
      const errors = validatePineInputs(effectiveInputsSchema(fromCatalog.inputs_schema, fromCatalog.script), inputs);
      if (errors.length) throw new Error(`pine_inputs_invalid:${errors.join(';')}`);
    }
    const out = await runPine({ script, inputs, bars, timeframe, symbol: raw.symbol as string | undefined, dataset_id: raw.dataset_id as string | undefined }, { timeoutMs: 60000 });
    ctx.json(res, 200, {
      script_id: fromCatalog?.id ?? null,
      timeframe,
      bars: out.bars,
      outputs: Object.keys(out.series),
      series: out.series,
      times: bars.map((b) => b.close_time),
      warnings: out.warnings,
    });
  }));

  return catalog;
}
