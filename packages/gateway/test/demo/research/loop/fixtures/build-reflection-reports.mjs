// 从运行中的研究网关(默认 18811)取 09-23 的几份真实回测报告,裁掉诊断用不到的大字段,写成复盘评测夹具。
// 只读:GET /api/research/backtests/:id 与 /api/research/inquiries/:id。用法(仓库根):
//   node packages/gateway/test/demo/research/loop/fixtures/build-reflection-reports.mjs [http://127.0.0.1:18811]
import { writeFileSync } from "node:fs";
const base = process.argv[2] ?? "http://127.0.0.1:18811";
// 1% 风险仓位伪对比 / 死叉离场被塞追踪 / 10/30 变体(离场参数未同步、同策略多变体)/ SMC 止损被放宽 / ETH 回踩编成下穿
const PICK = ["c7b8d3c1", "4d23af81", "7689ff1b", "7be99184", "7f53fe31"];
const get = async (p) => { const r = await fetch(base + p); if (!r.ok) throw Error(`${p} ${r.status}`); return r.json(); };
const list = (await get("/api/research/backtests?limit=200")).reports;
const out = [];
for (const short of PICK) {
  const id = list.find((r) => r.id.startsWith(short))?.id;
  if (!id) throw Error(`report ${short} not found`);
  const rep = await get(`/api/research/backtests/${id}`);
  const question = rep.inquiry_id ? (await get(`/api/research/inquiries/${rep.inquiry_id}`)).question ?? null : null;
  const variants = rep.strategy_id ? new Set(list.filter((r) => r.strategy_id === rep.strategy_id).map((r) => r.strategy_ir_hash)).size : null;
  for (const a of rep.assets) {
    a.equity = []; a.daily_pnl = []; a.monthly_returns = []; a.yearly_returns = [];
    // 诊断只拆主资产的逐笔与计划;其余资产只留指标
    if (a.key !== rep.primary_key) { a.trades = []; if (a.plans) a.plans = []; continue; }
    if (a.plans) a.plans = a.plans.map((p) => ({ side: p.side, status: p.status, blocked_reason: p.blocked_reason ?? null, entry_type: p.entry_type, entry_price: p.entry_price, reference_price: p.reference_price, stop: p.stop ? { price: p.stop.price, note: p.stop.note } : null }));
  }
  out.push({ short, question, variants, report: rep });
}
const file = new URL("./reflection-reports.json", import.meta.url);
writeFileSync(file, JSON.stringify(out));
console.log("wrote", file.pathname, out.map((x) => `${x.short} variants=${x.variants}`).join(" "));
