/**
 * 编排:冻结 → 估价 → 跑模型臂 → 零模型重放 → 报告。只由独立进程(scripts/research-judgment/)调用,不进网关进程。
 */
import { DEFAULT_COSTS } from '../../outcome.js';
import { PROMPT_VERSION } from '../../context.js';
import { DEFAULT_WORKFLOW } from '../../workflow.js';
import { priceFor } from '../../brain.js';
import { buildEventContext, buildEvents, makeBundle } from './events.js';
import { Budget, BudgetExhausted, decide, EXPECTED_OUT_TOK, RESEARCH_SYSTEM, researchPrompt, sha, type Decision, type FrozenPrompt, type ModelClient, type PromptMode, type PublicEvent } from './judge.js';
import { armStats, byGroup, modelFollow, paired, randomBaseline, stratifiedSample, type ArmStats, type Follow, type GroupRow, type PairedStats, type RandomBaseline } from './stats.js';
import { JrStore, type DecisionRow, type EventRow, type Manifest } from './store.js';
import { ACCOUNT_RULES, accountRow, holdReturn, type AccountRow } from './account.js';
import { EVENT_RULES_VERSION, MANAGEMENT_VERSION, MIN_STOP_ATR, RESEARCH_PROMPT_VERSION, type Dir, type JrEvent, type Management, type PeriodDef, type Venue } from './types.js';

export const PROMPT_LABEL: Record<PromptMode, string> = {
  prod: '生产 harness:context.ts buildContext 原文 + schema.ts 校验 + gates.ts(单轮,无修复调用)',
  research: 'research prompt,非生产 harness(生产证据登记 + 研究侧 follow/skip 任务)',
};

export const pub = (e: JrEvent): PublicEvent => ({ id: e.id, venue: e.venue, symbol: e.symbol, as_of: e.as_of, direction: e.direction, ref_close: e.ref_close, stop: e.stop, stop_atr: e.stop_atr });

export interface FreezeOptions {
  venue: Venue;
  periods: PeriodDef[];
  symbols: string[];
  cooldown_bars: number;
  prompt_mode: PromptMode;
  log?: (s: string) => void;
}

/** 冻结一套事件 + 提示词。manifest id 由全部输入的哈希决定,同样的输入重冻结得到同一个 id。 */
export function freezeManifest(store: JrStore, o: FreezeOptions): Manifest {
  const directions: Dir[] = o.venue === 'spot' ? ['long'] : ['long', 'short'];
  const series = store.series(o.venue).filter((s) => o.symbols.includes(s.symbol));
  if (series.length !== o.symbols.length) throw new Error(`实验库缺数据:${o.venue} 只有 ${series.map((s) => s.symbol).join(',')};先跑 import`);
  const fundingBy = new Map(o.symbols.map((s) => [s, o.venue === 'perp' ? store.funding(s) : []]));
  const versions: Record<string, string> = { event_rules: EVENT_RULES_VERSION, management: MANAGEMENT_VERSION, context_prompt: PROMPT_VERSION, ...(o.prompt_mode === 'research' ? { research_prompt: RESEARCH_PROMPT_VERSION } : {}) };
  const fundingSha = o.venue === 'perp' ? sha(JSON.stringify([...fundingBy.entries()])) : null;
  const inputKey = sha(JSON.stringify({ venue: o.venue, periods: o.periods, symbols: o.symbols, cooldown: o.cooldown_bars, mode: o.prompt_mode, versions, data: series.map((s) => s.sha256), fundingSha, playbook: sha(DEFAULT_WORKFLOW.playbook_text), min_stop: MIN_STOP_ATR }));
  const id = `jr-${o.venue}-${o.prompt_mode}-cd${o.cooldown_bars}-${inputKey.slice(0, 8)}`;
  const rows: EventRow[] = [];
  const systems = new Map<string, string>();
  const drops: Record<string, Record<string, number>> = {};
  for (const s of series) {
    const b = makeBundle(o.venue, s.symbol, s.bars, fundingBy.get(s.symbol) ?? []);
    for (const p of o.periods) {
      const t0 = Date.now();
      const r = buildEvents(b, p, { directions, cooldown_bars: o.cooldown_bars });
      drops[`${s.symbol}/${p.id}`] = { ...r.drops };
      for (const ev of r.events) {
        const { built, inputs } = buildEventContext(b, ev);
        const system = o.prompt_mode === 'prod' ? built.system_text : RESEARCH_SYSTEM;
        const user = o.prompt_mode === 'prod' ? built.user_text : researchPrompt(built.user_text, pub(ev));
        const hs = sha(system);
        systems.set(hs, system);
        const prompt: FrozenPrompt = { mode: o.prompt_mode, system, user, allowed_actions: built.allowed_actions, strategy_ids: built.strategy_ids, evidence: built.evidence, market: inputs.market };
        rows.push({ event: ev, prompt, system_sha256: hs, user_sha256: sha(user) });
      }
      o.log?.(`${s.symbol} ${p.id}: ${r.events.length} 个事件(${JSON.stringify(r.drops)},${Date.now() - t0}ms)`);
    }
  }
  rows.sort((a, b) => a.event.as_of - b.event.as_of || a.event.id.localeCompare(b.event.id));
  const prev = store.manifest(id);
  const m: Manifest = {
    id,
    created_at: prev?.created_at ?? Date.now(),
    venue: o.venue,
    periods: o.periods.map((p) => ({ ...p })),
    symbols: [...o.symbols],
    directions,
    cooldown_bars: o.cooldown_bars,
    prompt_mode: o.prompt_mode,
    prompt_label: PROMPT_LABEL[o.prompt_mode],
    versions,
    playbook_sha256: sha(DEFAULT_WORKFLOW.playbook_text),
    system_sha256: [...systems.keys()],
    datasets: series.map((s) => ({ symbol: s.symbol, source: s.source, source_id: s.source_id, n: s.bars.length, gaps: s.gaps, sha256: s.sha256 })),
    funding_sha256: fundingSha,
    costs: { ...DEFAULT_COSTS },
    events: { count: rows.length, sha256: sha(JSON.stringify(rows.map((r) => [r.event, r.system_sha256, r.user_sha256]))), drops },
    models: prev?.models ?? {},
  };
  if (prev && prev.events.sha256 !== m.events.sha256 && store.decisionCount(id) > 0) throw new Error(`manifest ${id} 重冻结结果与已有的不一致,且已有模型输出`);
  store.freeze(m, rows, systems);
  return m;
}

// ─────────────────────────────── 估价 ───────────────────────────────

export interface Estimate {
  model: string;
  prompt_mode: PromptMode;
  calls: number;
  in_tok: number;
  out_tok: number;
  cny_point: number;
  cny_upper: number;
  by_period: Record<string, { calls: number; cny_point: number; cny_upper: number }>;
}

/** 输入 token = 冻结提示词字符数/3(与 brain.ts 计量同口径);输出按每次 EXPECTED_OUT_TOK;上界 = 点估计 × upper_mult。 */
export function estimate(rows: EventRow[], model: string, mode: PromptMode, upperMult = 3): Estimate {
  const out = EXPECTED_OUT_TOK[mode];
  const by: Estimate['by_period'] = {};
  let inTok = 0;
  let cny = 0;
  for (const r of rows) {
    const it = Math.ceil((r.prompt.system + r.prompt.user).length / 3);
    const c = Budget.costOf(model, it, out);
    inTok += it;
    cny += c;
    const b = (by[r.event.period] ??= { calls: 0, cny_point: 0, cny_upper: 0 });
    b.calls++;
    b.cny_point += c;
    b.cny_upper += c * upperMult;
  }
  if (!priceFor(model)) throw new Error(`价格表里没有 ${model}`);
  return { model, prompt_mode: mode, calls: rows.length, in_tok: inTok, out_tok: out * rows.length, cny_point: cny, cny_upper: cny * upperMult, by_period: by };
}

// ─────────────────────────────── 跑一个模型臂 ───────────────────────────────

export interface RunOptions {
  arm: string;
  client: ModelClient;
  /** 只跑分层子样本(按 期段×币 分层、哈希排序,可复现);省略 = 全部事件 */
  sample?: number;
  max_calls: number;
  max_cny: number;
  concurrency: number;
  timeout_ms: number;
  log?: (s: string) => void;
}

export interface RunResult {
  attempted: number;
  skipped_existing: number;
  errors: number;
  stopped: string | null;
  spend: { calls: number; cny: number };
}

export function subsetFor(rows: EventRow[], sample?: number): EventRow[] {
  if (sample === undefined) return rows;
  const keep = new Set(stratifiedSample(rows.map((r) => r.event), sample, sha).map((e) => e.id));
  return rows.filter((r) => keep.has(r.event.id));
}

export async function runArm(store: JrStore, manifestId: string, o: RunOptions): Promise<RunResult> {
  const m = store.manifest(manifestId);
  if (!m) throw new Error(`没有 manifest ${manifestId}`);
  const frozen = m.models[o.arm];
  if (frozen && frozen.model !== o.client.name) throw new Error(`臂 ${o.arm} 已冻结为 ${frozen.model},不能换成 ${o.client.name}`);
  if (!frozen) {
    m.models[o.arm] = { model: o.client.name, key_note: o.client.key_note, prompt_mode: m.prompt_mode, first_run_at: Date.now() };
    store.saveManifest(m);
  }
  const rows = subsetFor(store.events(manifestId), o.sample);
  const done = new Set(store.decisions(manifestId, o.arm).map((d) => d.event_id));
  const todo = rows.filter((r) => !done.has(r.event.id));
  const spent = store.spend(o.client.name);
  const budget = new Budget(o.client.name, o.max_calls, o.max_cny, spent.calls, spent.cny);
  const expOut = EXPECTED_OUT_TOK[m.prompt_mode];
  let i = 0;
  let stopped: string | null = null;
  let errors = 0;
  let attempted = 0;
  const one = async (r: EventRow): Promise<void> => {
    const { system, user } = r.prompt;
    budget.reserve(system, user, expOut);
    attempted++;
    const p = pub(r.event);
    let raw: string | null = null;
    let terr: string | null = null;
    let usage: { input_tokens: number; output_tokens: number } | null = null;
    let latency = 0;
    const t0 = Date.now();
    try {
      const res = await Promise.race([
        o.client.complete(system, user, p, { timeoutMs: o.timeout_ms }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout ${o.timeout_ms + 5000}ms`)), o.timeout_ms + 5000).unref()),
      ]);
      raw = res.text;
      usage = { input_tokens: res.input_tokens, output_tokens: res.output_tokens };
      latency = res.latency_ms;
    } catch (e) {
      terr = (e as Error).message.slice(0, 500);
      latency = Date.now() - t0;
    }
    const cost = budget.settle(system, user, expOut, usage);
    const decision: Decision = raw === null ? { status: 'model_error', follow: false, action: null, direction: null, confidence: null, gates_failed: [], model_stop: null, reason: '', errors: [terr ?? 'unknown'] } : decide(m.prompt_mode, raw, r.prompt, p);
    if (decision.status === 'model_error') errors++;
    const row: DecisionRow = { manifest_id: manifestId, event_id: r.event.id, arm: o.arm, model: o.client.name, prompt_mode: m.prompt_mode, raw_text: raw, transport_error: terr, decision, in_tok: usage?.input_tokens ?? Math.ceil((system + user).length / 3), out_tok: usage?.output_tokens ?? 0, latency_ms: latency, cost_cny: cost, created_at: Date.now() };
    store.putDecision(row);
    if (attempted % 25 === 0) o.log?.(`${o.arm} ${attempted}/${todo.length} 已用 ¥${budget.cny.toFixed(4)} / ${budget.calls} 次`);
  };
  await Promise.all(
    Array.from({ length: Math.max(1, o.concurrency) }, async () => {
      while (i < todo.length && !stopped) {
        const r = todo[i++]!;
        try {
          await one(r);
        } catch (e) {
          if (e instanceof BudgetExhausted) stopped = e.message;
          else throw e;
        }
      }
    }),
  );
  return { attempted, skipped_existing: rows.length - todo.length, errors, stopped, spend: { calls: budget.calls, cny: budget.cny } };
}

// ─────────────────────────────── 零模型重放 ───────────────────────────────

/** 用库里的原始输出重新解析,和当时落库的决定逐条比;返回不一致的事件。 */
export function replayDecisions(store: JrStore, manifestId: string): { checked: number; mismatches: string[] } {
  const m = store.manifest(manifestId)!;
  const rows = new Map(store.events(manifestId).map((r) => [r.event.id, r]));
  const mismatches: string[] = [];
  let checked = 0;
  for (const d of store.decisions(manifestId)) {
    if (d.raw_text === null) continue;
    const r = rows.get(d.event_id);
    if (!r) {
      mismatches.push(`${d.arm}:${d.event_id}:event_missing`);
      continue;
    }
    const again = decide(m.prompt_mode, d.raw_text, r.prompt, pub(r.event));
    checked++;
    if (JSON.stringify(again) !== JSON.stringify(d.decision)) mismatches.push(`${d.arm}:${d.event_id}`);
  }
  return { checked, mismatches };
}

// ─────────────────────────────── 报告 ───────────────────────────────

export interface ModelArmReport {
  arm: string;
  model: string;
  key_note: string;
  n_decided: number;
  actions: Record<string, number>;
  model_errors: number;
  follow: number;
  direction_mismatch: number;
  gate_blocked: number;
  calls: number;
  in_tok: number;
  out_tok: number;
  cny: number;
  latency_s_mean: number | null;
  by_management: Record<Management, { arms: ArmStats[]; paired: PairedStats[]; random: RandomBaseline; by_symbol: GroupRow[]; by_period: GroupRow[]; account: AccountRow[] }>;
}

export interface Report {
  manifest: Manifest;
  full: Record<Management, { arms: ArmStats[]; paired: PairedStats[]; by_symbol: GroupRow[]; by_period: GroupRow[]; account: AccountRow[] }>;
  /** 账户折算的仓位规则说明(照搬 account-pnl.py)与同段等权持有对照 */
  account: { rules: string[]; hold: { period: string; label: string; return: number | null; symbols: number }[] };
  model_arms: ModelArmReport[];
  head_to_head: { a: string; b: string; n: number; by_management: Record<Management, { paired: PairedStats; arms: ArmStats[] }> } | null;
}

const MGMT: Management[] = ['trail', 'plan'];

export function buildReport(store: JrStore, manifestId: string, seeds = 200): Report {
  const m = store.manifest(manifestId);
  if (!m) throw new Error(`没有 manifest ${manifestId}`);
  const events = store.events(manifestId).map((r) => r.event);
  const A: Follow = () => true;
  const Af: Follow = (e) => e.trend_ok;
  const full = Object.fromEntries(
    MGMT.map((mg) => [
      mg,
      {
        arms: [armStats('A', events, A, mg), armStats('A_f', events, Af, mg)],
        paired: [paired('A_f', Af, 'A', A, events, mg)],
        by_symbol: byGroup(events, (e) => e.symbol, [['A', A], ['A_f', Af]], mg),
        by_period: byGroup(events, (e) => e.period, [['A', A], ['A_f', Af]], mg),
        account: [accountRow('A', events, A, mg, m.venue, m.periods), accountRow('A_f', events, Af, mg, m.venue, m.periods)],
      },
    ]),
  ) as Report['full'];
  const series = store.series(m.venue).filter((x) => m.symbols.includes(x.symbol));
  const account: Report['account'] = { rules: ACCOUNT_RULES, hold: m.periods.map((p) => ({ period: p.id, label: p.label, ...holdReturn(series, p) })) };
  const model_arms: ModelArmReport[] = [];
  const decByArm = new Map<string, Map<string, DecisionRow>>();
  for (const arm of Object.keys(m.models).sort()) {
    const ds = store.decisions(manifestId, arm);
    if (!ds.length) continue;
    const dm = new Map(ds.map((d) => [d.event_id, d]));
    decByArm.set(arm, dm);
    const sub = events.filter((e) => dm.has(e.id));
    const f = modelFollow(new Map(ds.map((d) => [d.event_id, d.decision])));
    const errs = ds.filter((d) => d.decision.status === 'model_error').length;
    const actions: Record<string, number> = {};
    for (const d of ds) {
      const k = d.decision.action ?? 'model_error';
      actions[k] = (actions[k] ?? 0) + 1;
    }
    const evById = new Map(sub.map((e) => [e.id, e]));
    const lat = ds.filter((d) => d.latency_ms > 0).map((d) => d.latency_ms / 1000);
    model_arms.push({
      arm,
      model: m.models[arm]!.model,
      key_note: m.models[arm]!.key_note,
      n_decided: ds.length,
      actions,
      model_errors: errs,
      follow: ds.filter((d) => d.decision.follow).length,
      direction_mismatch: ds.filter((d) => d.decision.action === 'PROPOSE' && d.decision.direction !== evById.get(d.event_id)?.direction).length,
      gate_blocked: ds.filter((d) => d.decision.action === 'PROPOSE' && d.decision.gates_failed.length > 0).length,
      calls: ds.length,
      in_tok: ds.reduce((a, d) => a + d.in_tok, 0),
      out_tok: ds.reduce((a, d) => a + d.out_tok, 0),
      cny: ds.reduce((a, d) => a + d.cost_cny, 0),
      latency_s_mean: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null,
      by_management: Object.fromEntries(
        MGMT.map((mg) => [
          mg,
          {
            arms: [armStats('A', sub, A, mg), armStats('A_f', sub, Af, mg), armStats(arm, sub, f, mg, errs)],
            paired: [paired(arm, f, 'A', A, sub, mg), paired(arm, f, 'A_f', Af, sub, mg), paired('A_f', Af, 'A', A, sub, mg)],
            random: randomBaseline(arm, f, sub, mg, seeds),
            by_symbol: byGroup(sub, (e) => e.symbol, [['A', A], ['A_f', Af], [arm, f]], mg),
            by_period: byGroup(sub, (e) => e.period, [['A', A], ['A_f', Af], [arm, f]], mg),
            account: [accountRow('A', sub, A, mg, m.venue, m.periods), accountRow('A_f', sub, Af, mg, m.venue, m.periods), accountRow(arm, sub, f, mg, m.venue, m.periods)],
          },
        ]),
      ) as ModelArmReport['by_management'],
    });
  }
  let head_to_head: Report['head_to_head'] = null;
  const armsWith = [...decByArm.keys()];
  if (armsWith.length >= 2) {
    const [a, b] = armsWith as [string, string];
    const da = decByArm.get(a)!;
    const db = decByArm.get(b)!;
    const sub = events.filter((e) => da.has(e.id) && db.has(e.id));
    const fa: Follow = (e) => da.get(e.id)?.decision.follow === true;
    const fb: Follow = (e) => db.get(e.id)?.decision.follow === true;
    head_to_head = {
      a,
      b,
      n: sub.length,
      by_management: Object.fromEntries(MGMT.map((mg) => [mg, { paired: paired(a, fa, b, fb, sub, mg), arms: [armStats('A', sub, A, mg), armStats(a, sub, fa, mg), armStats(b, sub, fb, mg)] }])) as NonNullable<Report['head_to_head']>['by_management'],
    };
  }
  return { manifest: m, full, account, model_arms, head_to_head };
}

// ─────────────────────────────── markdown ───────────────────────────────

const f = (x: number | null | undefined, d = 3): string => (x === null || x === undefined || !Number.isFinite(x) ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}`);
const pc = (x: number | null | undefined): string => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(0)}%`);
const ci = (c: [number | null, number | null]): string => `[${f(c[0], 2)}, ${f(c[1], 2)}]`;

function armTable(rows: ArmStats[]): string {
  return [
    '| 臂 | 事件 | 笔数 | 做单率 | 每笔净 R [95% CI] | 中位 R | 截尾均值 R(两端各截) | 胜率 | 合计 R | 每事件 R [95% CI] | model_error |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.arm} | ${r.n_events} | ${r.n_trades} | ${pc(r.follow_rate)} | ${f(r.mean_trade)} ${ci(r.ci_trade)} | ${f(r.median_trade)} | ${f(r.trimmed_trade)}(${r.trim_each_side ? `各截 ${r.trim_each_side}` : '<10 笔不截'}) | ${pc(r.win_rate)} | ${f(r.total_r, 1)} | ${f(r.mean_event)} ${ci(r.ci_event)} | ${r.model_errors} |`),
  ].join('\n');
}

const CENTER_NOTE = '每笔净 R 旁边给中位数与截尾均值(排序后两端各截 floor(笔数 × 10%) 笔再平均;不足 10 笔不截尾)。均值为正而中位数/截尾均值不为正,说明平均值靠少数几笔撑起。笔数 < 30 只作观察。';

function accountTable(rows: AccountRow[], hold: Report['account']['hold']): string {
  const periods = hold.map((h) => h.period);
  const cell = (p: AccountRow['periods'][number] | undefined): string => (p ? `${f(p.return * 100, 1)}%(${p.trades} 笔${p.skipped_full ? `,满仓跳过 ${p.skipped_full}` : ''},最大回撤 ${(p.max_drawdown * 100).toFixed(1)}%)` : '–');
  return [
    `| 臂 | ${periods.join(' | ')} |`,
    `|---|${periods.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.arm} | ${periods.map((pid) => cell(r.periods.find((x) => x.period === pid))).join(' | ')} |`),
    `| 等权持有 | ${hold.map((h) => (h.return === null ? '–' : `${f(h.return * 100, 1)}%(${h.symbols} 币,不扣成本)`)).join(' | ')} |`,
  ].join('\n');
}

function accountRules(r: Report): string {
  return ['\n### 真实盈亏的仓位规则(账户折算)', ...r.account.rules.map((x) => `- ${x}`)].join('\n');
}

function pairedTable(rows: PairedStats[]): string {
  return ['| 配对(逐事件,不做记 0) | n | 均值 Δ R [95% CI] | 决定不同 | 好 / 差 |', '|---|---|---|---|---|', ...rows.map((p) => `| ${p.a} − ${p.b} | ${p.n} | ${f(p.mean)} ${ci(p.ci)} | ${p.differ} | ${p.better} / ${p.worse} |`)].join('\n');
}

function groupTable(rows: GroupRow[], label: string): string {
  return [`| ${label} | 臂 | 事件 | 笔数 | 每笔净 R | 中位 R | 合计 R | 每事件 R |`, '|---|---|---|---|---|---|---|---|', ...rows.map((g) => `| ${g.group} | ${g.arm} | ${g.n_events} | ${g.n_trades} | ${f(g.mean_trade)} | ${f(g.median_trade)} | ${f(g.total_r, 1)} | ${f(g.mean_event)} |`)].join('\n');
}

export function reportMarkdown(r: Report): string {
  const m = r.manifest;
  const out: string[] = [];
  out.push(`## ${m.id}`);
  out.push(`- 市场:${m.venue === 'spot' ? '现货,只做多' : '永续,多空(资金费按 OKX 真实费率计入)'};行情段:${m.periods.map((p) => p.label).join(';')};资产:${m.symbols.join(' ')};1h;同币同向冷却 ${m.cooldown_bars} 根`);
  out.push(`- 提示词:**${m.prompt_label}**`);
  out.push(`- 版本:${Object.entries(m.versions).map(([k, v]) => `${k}=${v}`).join(',')};playbook sha ${m.playbook_sha256.slice(0, 12)};system sha ${m.system_sha256.map((s) => s.slice(0, 12)).join('/')}`);
  out.push(`- 数据:${m.datasets.map((d) => `${d.symbol} ${d.n} 根 gaps=${d.gaps} sha ${d.sha256.slice(0, 10)}`).join(';')}${m.funding_sha256 ? `;资金费 sha ${m.funding_sha256.slice(0, 10)}` : ''}`);
  out.push(`- 事件:${m.events.count} 个,sha ${m.events.sha256.slice(0, 12)};模型:${Object.entries(m.models).map(([a, x]) => `${a}=${x.model}(${x.key_note})`).join(';') || '(未跑)'}`);
  out.push(`- 统计口径:${CENTER_NOTE}`);
  out.push(accountRules(r));
  for (const mg of MGMT) {
    const full = r.full[mg];
    out.push(`\n### 管仓 ${mg === 'trail' ? 'trail(主):吊灯 ATR22×3,168 根' : 'plan(副):结构止盈/止损,48 根到期'} —— 全部事件(零模型)`);
    out.push(armTable(full.arms));
    out.push('');
    out.push(pairedTable(full.paired));
    out.push('');
    out.push(groupTable(full.by_period, '行情段'));
    out.push(`\n真实盈亏(每笔风险 1%,$10k 起,按段分开;规则见上):`);
    out.push(accountTable(full.account, r.account.hold));
  }
  for (const a of r.model_arms) {
    out.push(`\n### 模型臂 ${a.arm}:${a.model}`);
    out.push(`决定 ${a.n_decided} 个事件;动作 ${JSON.stringify(a.actions)};follow ${a.follow};PROPOSE 方向与事件相反 ${a.direction_mismatch};PROPOSE 被闸拦 ${a.gate_blocked};model_error ${a.model_errors};调用 ${a.calls} 次,估算 token 入 ${a.in_tok} / 出 ${a.out_tok},¥${a.cny.toFixed(4)},平均延迟 ${a.latency_s_mean === null ? '–' : a.latency_s_mean.toFixed(1)} s`);
    for (const mg of MGMT) {
      const b = a.by_management[mg];
      out.push(`\n#### ${a.arm} · ${mg}(同一子集上的 A / A_f / ${a.arm} / 随机)`);
      out.push(armTable(b.arms));
      out.push(`\n随机基线 R(同样挑 ${b.random.k}/${b.random.n} 个,种子 1..${b.random.seeds}):每笔 ${f(b.random.mean_trade)},2.5–97.5% 带 ${ci(b.random.band_trade)};每事件 ${f(b.random.mean_event)} ${ci(b.random.band_event)};${a.arm} 每笔 ${f(b.random.model_mean_trade)},随机不低于它的比例 ${pc(b.random.p_random_ge_model)}`);
      out.push('');
      out.push(pairedTable(b.paired));
      out.push('');
      out.push(groupTable(b.by_symbol, '币'));
      out.push('');
      out.push(groupTable(b.by_period, '行情段'));
      out.push(`\n真实盈亏(同一子集,每笔风险 1%,$10k 起):`);
      out.push(accountTable(b.account, r.account.hold));
    }
  }
  if (r.head_to_head) {
    const h = r.head_to_head;
    for (const mg of MGMT) {
      out.push(`\n### 两个模型同一子集(n=${h.n})· ${mg}`);
      out.push(armTable(h.by_management[mg].arms));
      out.push('');
      out.push(pairedTable([h.by_management[mg].paired]));
    }
  }
  return out.join('\n');
}
