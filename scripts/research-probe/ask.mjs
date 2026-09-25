// 研究 loop 端到端探针(不用浏览器):node scripts/research-probe/ask.mjs "问题" [session_id];CTX='{"instrument_refs":[],"selected_run_id":"..."}' 可带上下文(诊断追问)。打印计划、步骤、概念覆盖、答案与回测报告要点。
// 研究 loop 端到端探针:建会话 → 提问 → 轮询到终态 → 打印计划/步骤/答案/回测报告要点
const B = 'http://127.0.0.1:18811/api/research';
const j = async (p, init) => { const r = await fetch(B + p, init ? { method: init.method ?? 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body ?? {}) } : undefined); const t = await r.text(); try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, json: t }; } };
const q = process.argv[2], sid0 = process.argv[3];
const t0 = Date.now();
const sid = sid0 || (await j('/sessions', { body: { title: q.slice(0, 30) } })).json.id;
const sent = await j(`/sessions/${sid}/messages`, { body: { text: q, idempotency_key: 'k' + Date.now(), ...(process.env.CTX ? { context: JSON.parse(process.env.CTX) } : {}) } });
if (sent.status >= 300) { console.log('SEND FAIL', sent.status, JSON.stringify(sent.json).slice(0, 400)); process.exit(1); }
const iid = sent.json.inquiry.id;
let inq;
for (;;) { await new Promise((r) => setTimeout(r, 3000)); inq = (await j(`/inquiries/${iid}`)).json; if (!['queued', 'planning', 'running', 'cancelling', 'validating', 'composing'].includes(inq.status)) break; if (Date.now() - t0 > 15 * 60e3) { console.log('TIMEOUT'); break; } }
console.log(`== ${q}\nsession=${sid} inquiry=${iid} status=${inq.status} ${((Date.now() - t0) / 1000).toFixed(0)}s mode=${inq.plan?.mode} tf=${inq.plan?.timeframe} window=${inq.plan?.window ? new Date(inq.plan.window.from_ms).toISOString().slice(0, 10) + '→' + new Date(inq.plan.window.to_ms).toISOString().slice(0, 10) : ''} err=${inq.error_code ?? ''} ${inq.error ?? ''}`);
for (const s of inq.steps ?? []) console.log(`  [${s.status}] ${s.tool} · ${s.title}${s.error_code ? ' ERR ' + s.error_code + ' ' + (s.error ?? '') : ''}${s.output_summary?.metrics?.[0]?.report_id ? ' report=' + s.output_summary.metrics[0].report_id : ''}`);
const concepts = inq.checkpoint?.concepts ?? [];
if (concepts.length) console.log('  concepts:', concepts.map((c) => `${c.term}:${c.status}`).join(', '));
const detail = (await j(`/sessions/${sid}`)).json;
const ans = detail.messages.filter((m) => m.role === 'assistant').at(-1);
console.log('  ANSWER:', (ans?.blocks ?? []).map((b) => b.kind === 'text' ? b.text : `[${b.kind}${b.artifact_id ? ':' + b.artifact_id.slice(0, 8) : ''}]`).join(' ').replace(/\s+/g, ' ').slice(0, 1800));
const reportIds = new Set();
for (const a of detail.artifacts ?? []) if (a.content?.view === 'backtest_report') reportIds.add(a.content.report_id);
for (const s of inq.steps ?? []) { const id = s.output_summary?.metrics?.[0]?.report_id; if (id) reportIds.add(id); }
for (const id of reportIds) {
  const r = (await j(`/backtests/${id}`)).json;
  console.log(`  REPORT ${id} "${r.title}" tf=${r.timeframe} ${new Date(r.window.from_ms).toISOString().slice(0, 10)}→${new Date(r.window.to_ms).toISOString().slice(0, 10)} score=${r.score?.value}/${r.score?.label}/${r.score?.confidence} strategy=${r.strategy_id}@${r.strategy_version} warn=${(r.warnings ?? []).join('|').slice(0, 200)}`);
  for (const a of r.assets) { const m = a.metrics; console.log(`    ${a.key} ${a.status}${a.error ? ' ' + a.error : ''} ret=${m ? (m.total_return * 100).toFixed(1) + '%' : '-'} bh=${m?.benchmark_return != null ? (m.benchmark_return * 100).toFixed(1) + '%' : '-'} dd=${m ? (m.max_drawdown * 100).toFixed(1) + '%' : '-'} sharpe=${m?.sharpe?.toFixed?.(2) ?? '-'} trades=${m?.trades ?? '-'} win=${m?.win_rate != null ? (m.win_rate * 100).toFixed(0) + '%' : '-'} data=${a.data ? new Date(a.data.first_at).toISOString().slice(0, 10) + '→' + new Date(a.data.last_at).toISOString().slice(0, 10) + ' ' + a.data.bars + 'bars' : '-'} plans=${a.plans?.length ?? '-'}`); }
}
