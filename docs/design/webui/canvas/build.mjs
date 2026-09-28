// trade-gate WebUI 设计画板生成器(静态 .dc.html + canvas.json)。
// 用法:node build.mjs  → 在本目录产出 *.dc.html 与 canvas.json;随后用 design 技能的 seed 助手拼装发布。
// 视觉基线:借 8794 shadcn 变体「Graphite & Ice」的暗色三层地面 / 冰青强调 / 等宽数字 / 联排面板,
// 令牌值由其 oklch 换算为 hex(见 README「视觉决策」)。示例数据全部取自 packages/contracts/fixtures。
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = dirname(fileURLToPath(import.meta.url));

// ───────────────────────── tokens ─────────────────────────
const C = {
  side: "#05080b", bg: "#090d11", card: "#10151a", pop: "#13191f", sec: "#1d2329", muted: "#191f24", accent: "#1e272e",
  fg: "#dfe6ea", fg2: "#c5ccd0", mutedFg: "#868f95", dimFg: "#5b656d",
  border: "rgba(255,255,255,0.09)", border2: "rgba(255,255,255,0.13)", line: "rgba(255,255,255,0.06)",
  ice: "#6fcadf", iceFg: "#041119", ring: "#4ca0b3",
  up: "#48a870", down: "#cc544b", warn: "#bd903b", live: "#e24947", destructive: "#da534f",
  candleUp: "#2aa76e", candleDown: "#c94b3e", chartText: "#97a3b4", chartGrid: "rgba(255,255,255,0.06)",
  support: "#2882f0", resistance: "#c18708", trend: "#bd3eb0", volumeNode: "#8b95a6", structure: "#c3cddb",
};

const FONT_LINK = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&amp;family=JetBrains+Mono:wght@400;500;600&amp;display=swap">';

const CSS = `
body{margin:0;background:${C.bg};color:${C.fg};font-family:Geist,-apple-system,"PingFang SC","Noto Sans SC","Segoe UI",sans-serif;font-size:12.5px;line-height:1.45;-webkit-font-smoothing:antialiased}
a{color:${C.ice};text-decoration:none}a:hover{color:#9adcea}
*{box-sizing:border-box}
.num{font-family:"JetBrains Mono","SF Mono",ui-monospace,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
.app{display:flex;overflow:hidden;background:${C.bg};color:${C.fg}}
.side{width:168px;flex:none;background:${C.side};border-right:1px solid rgba(255,255,255,0.08);display:flex;flex-direction:column;user-select:none}
.brand{display:flex;align-items:center;gap:8px;padding:10px 10px 6px}
.logo{width:26px;height:26px;border-radius:5px;background:${C.ice};color:${C.iceFg};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px}
.nav-g{padding:4px 8px;display:flex;flex-direction:column;gap:2px}
.nav-l{height:24px;display:flex;align-items:center;padding:0 8px;font-size:10px;color:${C.mutedFg};letter-spacing:0.06em}
.nav-i{height:28px;display:flex;align-items:center;gap:8px;padding:0 8px;border-radius:6px;font-size:12.5px;color:${C.fg2}}
.nav-i.on{background:#161c23;color:#eef3f6}
.nav-i.dim{color:${C.dimFg}}
.nav-i svg{flex:none}
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.top{height:40px;flex:none;display:flex;align-items:center;gap:10px;padding:0 10px;border-bottom:1px solid ${C.border};user-select:none}
.vsep{width:1px;height:16px;background:${C.border2};flex:none}
.status{height:26px;flex:none;display:flex;align-items:center;gap:16px;padding:0 12px;border-top:1px solid ${C.border};background:${C.side};font-size:11px;color:${C.mutedFg};user-select:none}
.content{flex:1;min-height:0;padding:12px;display:flex;flex-direction:column;gap:12px}
.ws{border:1px solid ${C.border};border-radius:6px;background:${C.card};overflow:hidden;display:flex;flex-direction:column;min-height:0;min-width:0}
.pane-h{height:32px;flex:none;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid ${C.border};background:rgba(25,31,36,0.4);user-select:none}
.pane-t{font-size:12px;font-weight:600;letter-spacing:0.02em;white-space:nowrap;flex:none}
.pane-h .hint{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.pane-h > .row{flex:none}
.pane-b{flex:1;min-height:0;overflow:hidden}
.hint{font-size:11px;color:${C.mutedFg}}
.tbl{width:100%;border-collapse:collapse}
.tbl th{height:30px;font-size:11px;font-weight:500;color:${C.mutedFg};text-align:left;padding:0 10px;border-bottom:1px solid ${C.border};white-space:nowrap}
.tbl td{padding:5px 10px;font-size:12.5px;border-bottom:1px solid ${C.line};white-space:nowrap;vertical-align:middle}
.tbl tr:last-child td{border-bottom:0}
.tbl .r{text-align:right}
.pill{display:inline-flex;align-items:center;gap:5px;height:18px;padding:0 7px;border-radius:999px;font-size:10.5px;font-weight:500;border:1px solid transparent;white-space:nowrap;line-height:1}
.pill .dot{width:6px;height:6px;border-radius:999px;background:currentColor;flex:none}
.pill.ok{color:${C.up};background:rgba(72,168,112,0.12);border-color:rgba(72,168,112,0.28)}
.pill.warn{color:${C.warn};background:rgba(189,144,59,0.12);border-color:rgba(189,144,59,0.3)}
.pill.bad{color:${C.down};background:rgba(204,84,75,0.12);border-color:rgba(204,84,75,0.3)}
.pill.live{color:#fff;background:${C.live};border-color:${C.live};font-weight:600}
.pill.ice{color:${C.ice};background:rgba(111,202,223,0.1);border-color:rgba(111,202,223,0.3)}
.pill.mute{color:${C.fg2};background:${C.sec};border-color:${C.border2}}
.pill.dim{color:${C.mutedFg};background:transparent;border-color:${C.border2}}
.pill.slate{color:#c9d3dc;background:rgba(120,139,161,0.16);border-color:rgba(120,139,161,0.35)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 10px;border-radius:6px;font-size:12px;font-weight:500;border:1px solid transparent;white-space:nowrap;user-select:none}
.btn.pri{background:${C.ice};color:${C.iceFg}}
.btn.out{border-color:${C.border2};color:${C.fg};background:transparent}
.btn.ghost{color:${C.mutedFg};background:transparent}
.btn.danger{background:${C.destructive};color:#fff}
.btn.dout{border-color:rgba(218,83,79,0.45);color:${C.destructive};background:transparent}
.btn.xs{height:24px;padding:0 8px;font-size:11.5px}
.btn.lg{height:36px;padding:0 16px;font-size:13px}
.btn.dis{opacity:0.45}
.field{display:flex;flex-direction:column;gap:4px;min-width:0}
.lbl{font-size:11px;color:${C.mutedFg}}
.inp{height:30px;border:1px solid ${C.border2};border-radius:6px;background:rgba(255,255,255,0.03);padding:0 9px;display:flex;align-items:center;gap:6px;font-size:12.5px;color:${C.fg};min-width:0}
.inp.ro{background:transparent;color:${C.mutedFg}}
.seg{display:inline-flex;flex:none;border:1px solid ${C.border2};border-radius:6px;padding:2px;gap:2px;user-select:none}
.seg span{padding:2px 8px;border-radius:4px;font-size:11.5px;color:${C.mutedFg};white-space:nowrap}
.seg .on{background:${C.sec};color:#d9dfe3}
.seg .on.buy{background:rgba(72,168,112,0.18);color:${C.up}}
.seg .on.sell{background:rgba(204,84,75,0.18);color:${C.down}}
.seg .on.livep{background:${C.live};color:#fff}
.seg .on.warnp{background:rgba(189,144,59,0.18);color:${C.warn}}
.kv{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;font-size:12px;align-items:baseline}
.kv .k{color:${C.mutedFg};white-space:nowrap}
.card{border:1px solid ${C.border};border-radius:6px;background:${C.card}}
.cell{display:flex;flex-direction:column;gap:2px;padding:10px 14px;min-width:0;overflow:hidden}
.cell .l{font-size:11px;color:${C.mutedFg};white-space:nowrap}
.cell .v{font-size:19px;font-weight:600;line-height:24px;white-space:nowrap}
.cell .v small{font-size:11px;font-weight:400;color:${C.mutedFg};margin-left:4px}
.cell .s{font-size:11px;color:${C.mutedFg};white-space:nowrap;display:flex;gap:8px;align-items:center;overflow:hidden;text-overflow:ellipsis}
.up{color:${C.up}}.down{color:${C.down}}.warn{color:${C.warn}}.live{color:${C.live}}.ice{color:${C.ice}}.mutedc{color:${C.mutedFg}}
.row{display:flex;align-items:center;gap:8px;min-width:0}
.col{display:flex;flex-direction:column;gap:8px;min-width:0;min-height:0}
.list{display:flex;flex-direction:column}
.li{display:flex;align-items:center;gap:10px;padding:7px 10px;border-bottom:1px solid ${C.line};min-width:0}
.li:last-child{border-bottom:0}
.li.sel{background:rgba(111,202,223,0.07);box-shadow:inset 2px 0 0 ${C.ice}}
.mono{font-family:"JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace}
.ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.steps{display:flex;align-items:center;gap:0}
.step{display:flex;align-items:center;gap:5px;font-size:10px;white-space:nowrap}
.step .n{width:14px;height:14px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:9px;flex:none;border:1px solid ${C.border2};color:${C.mutedFg}}
.step.done .n{background:rgba(72,168,112,0.15);border-color:rgba(72,168,112,0.4);color:${C.up}}
.step.on .n{background:${C.ice};border-color:${C.ice};color:${C.iceFg}}
.step.bad .n{background:${C.live};border-color:${C.live};color:#fff}
.step.done{color:${C.fg2}}.step.on{color:${C.fg}}.step.bad{color:${C.live}}.step.todo{color:${C.mutedFg}}
.sline{width:10px;height:1px;background:${C.border2};flex:none;margin:0 3px}
.chk{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:999px;flex:none}
.chk.ok{background:rgba(72,168,112,0.16);color:${C.up}}
.chk.bad{background:rgba(204,84,75,0.16);color:${C.down}}
.chk.warn{background:rgba(189,144,59,0.16);color:${C.warn}}
.chk.todo{border:1px solid ${C.border2};color:${C.mutedFg}}
.chk.on{background:rgba(111,202,223,0.16);color:${C.ice}}
.note{font-size:11px;color:${C.mutedFg};line-height:1.5}
.banner{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:6px;border:1px solid;font-size:12px}
.banner.live{border-color:rgba(226,73,71,0.45);background:rgba(226,73,71,0.09);color:#f1b3b2}
.banner.warn{border-color:rgba(189,144,59,0.4);background:rgba(189,144,59,0.09);color:#e3c98a}
.banner.ice{border-color:rgba(111,202,223,0.35);background:rgba(111,202,223,0.07);color:#bfe7f0}
.tab{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;font-size:12px;color:${C.mutedFg};border-bottom:2px solid transparent;white-space:nowrap}
.tab.on{color:${C.fg};border-bottom-color:${C.ice}}
.cnt{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:999px;font-size:10px;background:${C.sec};color:${C.fg2}}
.cnt.warn{background:rgba(189,144,59,0.2);color:${C.warn}}
.ring{position:relative;display:inline-block;width:44px;height:44px;flex:none;vertical-align:middle}
.ring svg{display:block}
.ring .t{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600}
.spin{width:14px;height:14px;border-radius:999px;border:2px solid rgba(111,202,223,0.25);border-top-color:${C.ice};flex:none}
.meter{height:4px;border-radius:2px;background:${C.sec};overflow:hidden;flex:1;min-width:40px}
.meter i{display:block;height:100%;border-radius:2px}
`;

// ───────────────────────── icons(16px 描边,单一风格) ─────────────────────────
const P = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  chart: '<path d="M9 5v14M9 8H6v8h3M15 3v18M15 6h3v10h-3"/>',
  portfolio: '<path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
  trade: '<path d="M4 17l6-6 4 4 6-6"/><path d="M14 9h6v6"/>',
  funding: '<path d="M8 3L4 7l4 4"/><path d="M4 7h16"/><path d="M16 21l4-4-4-4"/><path d="M20 17H4"/>',
  intents: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  strategies: '<path d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 17l-6.5 4 2-7.5L2 9h7z"/>',
  automations: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  skills: '<path d="M12 3a4 4 0 0 0-4 4v1a4 4 0 0 0-3 4 4 4 0 0 0 3 4v1a4 4 0 0 0 8 0v-1a4 4 0 0 0 3-4 4 4 0 0 0-3-4V7a4 4 0 0 0-4-4z"/>',
  journal: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  exchange: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  brains: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>',
  policy: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"/><path d="M12 12l4-4"/><path d="M12 6v2M6 12h2M16 12h2M12 16v2"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  usage: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 6-6"/>',
  logs: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  wizard: '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M12.2 6.2L11 5M12.2 11.8L11 13"/><path d="M3 21l9-9"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  stop: '<path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86z"/><path d="M12 8v4M12 16h.01"/>',
  cmd: '<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  ext: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14L21 3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  chevD: '<path d="M6 9l6 6 6-6"/>',
  chevR: '<path d="M9 18l6-6-6-6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M21 2l-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bolt: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 4v4M8 13h.01M16 13h.01M9 17h6"/>',
  timer: '<path d="M10 2h4M12 14l3-3"/><circle cx="12" cy="14" r="8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.5z"/>',
  arrowR: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  wallet: '<path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
  layers: '<path d="M12 2L2 7l10 5 10-5z"/><path d="M2 12l10 5 10-5M2 17l10 5 10-5"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
  candle: '<path d="M8 3v3M8 15v6M16 3v6M16 18v3"/><rect x="5" y="6" width="6" height="9" rx="1"/><rect x="13" y="9" width="6" height="9" rx="1"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
};
const ico = (name, size = 14, color = "currentColor", extra = "") =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${P[name]}</svg>`;

// ───────────────────────── primitives ─────────────────────────
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pill = (text, tone = "mute", { dot = true, title = "", mono = true, cls = "" } = {}) =>
  `<span class="pill ${tone} ${mono ? "mono" : ""} ${cls}"${title ? ` title="${esc(title)}"` : ""}>${dot ? '<span class="dot"></span>' : ""}${esc(text)}</span>`;
const STATUS_TONE = {
  proposed: "mute", awaiting_approval: "warn", authorized: "ice", recorded: "dim", dispatching: "ice", executing: "ice",
  execution_unknown: "live", completed: "ok", canceled: "mute", expired: "dim", rejected: "bad",
};
const st = (status, opts = {}) => pill(status, STATUS_TONE[status] ?? "mute", opts);
const acct = (a, opts = {}) => (a === "main" ? pill("main · REST", "slate", { dot: false, ...opts }) : pill("sub · MCP", "ice", { dot: false, ...opts }));
const chk = (kind) => {
  const glyph = kind === "ok" || kind === "on" ? "check" : kind === "bad" ? "x" : kind === "warn" ? "alert" : null;
  return `<span class="chk ${kind}">${glyph ? ico(glyph, 10, "currentColor", ' stroke-width="2.6"') : ""}</span>`;
};
const btn = (label, kind = "out", { icon = "", size = "", extra = "", title = "" } = {}) =>
  `<span class="btn ${kind} ${size} ${extra}"${title ? ` title="${esc(title)}"` : ""}>${icon ? ico(icon, 13) : ""}${esc(label)}</span>`;
const kv = (pairs, style = "") =>
  `<div class="kv" style="${style}">${pairs.map(([k, v]) => `<span class="k">${k}</span><span class="num ell">${v}</span>`).join("")}</div>`;
const table = (cols, rows, { style = "", dense = false } = {}) =>
  `<table class="tbl" style="${style}"><thead><tr>${cols.map((c) => `<th class="${c.r ? "r" : ""}" style="${c.w ? `width:${c.w}px;` : ""}">${c.h}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((cell, i) => `<td class="${cols[i]?.r ? "r " : ""}${cols[i]?.num ? "num" : ""}" style="${dense ? "padding-top:3px;padding-bottom:3px;" : ""}">${cell}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
const pane = (title, hint, body, { actions = "", style = "", bodyStyle = "" } = {}) =>
  `<section class="ws" style="${style}"><header class="pane-h"><span class="pane-t">${title}</span>${hint ? `<span class="hint">${hint}</span>` : ""}<div class="row" style="margin-left:auto;gap:6px">${actions}</div></header><div class="pane-b" style="${bodyStyle}">${body}</div></section>`;
const steps = (items) =>
  `<div class="steps">${items
    .map((s, i) => `${i ? '<span class="sline"></span>' : ""}<span class="step ${s.state}"><span class="n">${s.state === "done" ? ico("check", 10, "currentColor", ' stroke-width="3"') : s.state === "bad" ? "!" : i + 1}</span><span class="mono">${esc(s.label)}</span></span>`)
    .join("")}</div>`;
const ring = (pct, label, color = C.ice, size = 44) => {
  const r = (size - 6) / 2, c = 2 * Math.PI * r, off = c * (1 - pct);
  return `<span class="ring" style="width:${size}px;height:${size}px"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${C.sec}" stroke-width="3"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg><span class="t num" style="color:${color}">${label}</span></span>`;
};
const meter = (pct, color = C.ice) => `<span class="meter"><i style="width:${Math.round(pct * 100)}%;background:${color}"></i></span>`;
const hash = (h, n = 4) => `<span class="num" title="${h}">${h.slice(0, n)}…${h.slice(-n)}</span>`;
const short = (id) => id.replace(/-/g, "").slice(0, 8);

// ───────────────────────── shell ─────────────────────────
const NAV = [
  { g: "交易", items: [["dashboard", "总览", "dashboard"], ["chat", "对话", "chat", "dim"], ["chart", "图表", "chart"], ["portfolio", "资产", "portfolio"], ["trade", "手动下单", "trade"], ["funding", "划转", "funding"], ["intents", "审批", "intents", "", 1], ["strategies", "策略", "strategies", "dim"]] },
  { g: "自动化", items: [["automations", "自动化", "automations", "dim"], ["skills", "技能与记忆", "skills", "dim"], ["journal", "复盘", "journal", "dim"]] },
  { g: "系统", items: [["exchange", "交易所", "exchange", "", 0, "warn"], ["brains", "大脑", "brains", "dim"], ["policy", "风控", "policy"], ["activity", "活动", "activity"], ["usage", "用量", "usage", "dim"], ["logs", "日志", "logs", "dim"], ["settings", "设置", "settings", "dim"], ["wizard", "向导", "wizard"]] },
];
const sidebar = (active) => `
<aside class="side">
  <div class="brand"><span class="logo mono">TG</span><span style="font-size:13px;font-weight:600">trade-gate</span><span class="hint num" style="margin-left:auto">v0.1</span></div>
  ${NAV.map(
    (g) => `<div class="nav-g"><div class="nav-l">${g.g}</div>${g.items
      .map(([id, label, icon, dim, count, dotc]) => `<div class="nav-i ${id === active ? "on" : ""} ${dim || ""}"${dim ? ' title="B 阶段铺面"' : ""}>${ico(icon, 14)}<span class="ell">${label}</span>${count ? `<span class="cnt warn num" style="margin-left:auto">${count}</span>` : ""}${dotc ? `<span style="margin-left:auto;width:6px;height:6px;border-radius:999px;background:${C.warn}"></span>` : ""}</div>`)
      .join("")}</div>`,
  ).join("")}
  <div style="margin-top:auto;padding:10px 14px" class="note">灰色项 = B 阶段铺面<br>A3 最小 UI 只含高亮页</div>
</aside>`;
const topbar = (title, sub, { extra = "" } = {}) => `
<header class="top">
  ${ico("menu", 15, C.mutedFg)}<span class="vsep"></span>
  <span style="font-size:13px;font-weight:600">${title}</span><span class="hint">${sub}</span>
  ${extra}
  <div class="row" style="margin-left:auto;gap:10px">
    <span class="num" style="font-size:11px;color:${C.mutedFg}">合并权益 <b style="font-size:12.5px;color:${C.fg}">3,788.00</b> USDT</span>
    <span class="num" style="font-size:11px;color:${C.mutedFg}">未实现 <b class="down" style="font-size:12.5px">-12.50</b></span>
    <span class="vsep"></span>
    <span class="row" style="gap:6px">${pill("mode run", "mute", { dot: false })}${pill("authority draft", "ice", { dot: false })}</span>
    ${btn("紧急停", "dout", { icon: "stop", size: "xs" })}
    <span class="vsep"></span>
    ${ico("cmd", 14, C.mutedFg)}${ico("moon", 14, C.mutedFg)}
  </div>
</header>`;
const statusbar = () => `
<footer class="status">
  <span class="row" style="gap:6px"><span style="width:6px;height:6px;border-radius:999px;background:${C.up}"></span>gateway ws 127.0.0.1:18800 已连接</span>
  <span class="num">execd ok · lease epoch 7</span>
  <span class="row num" style="gap:6px"><span style="width:6px;height:6px;border-radius:999px;background:${C.up}"></span>main REST ok</span>
  <span class="row num" style="gap:6px;color:${C.warn}"><span style="width:6px;height:6px;border-radius:999px;background:${C.warn}"></span>sub MCP degraded · oauth 8m</span>
  <span class="num" style="margin-left:auto">时钟 +12 ms</span>
  <span class="num">v0.1.0</span>
</footer>`;

const doc = (title, body, { w = 1440, h = 900, extraCss = "" } = {}) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${esc(title)}</title>
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  ${FONT_LINK}
  <style>${CSS}${extraCss}</style>
</helmet>
<div class="app" style="width:${w}px;height:${h}px">
${body}
</div>
</x-dc>
</body>
</html>
`;
const page = ({ id, title, sub, body, extra = "", w = 1440, h = 900, extraCss = "" }) =>
  doc(title, `${sidebar(id)}<div class="main">${topbar(title, sub, { extra })}<div class="content">${body}</div>${statusbar()}</div>`, { w, h, extraCss });

const files = {};

// ───────────────────────── 1. Dashboard ─────────────────────────
const cell = (l, v, unit, s, { vcls = "", style = "" } = {}) =>
  `<div class="cell" style="flex:1;border-right:1px solid ${C.border};${style}"><span class="l">${l}</span><span class="v num ${vcls}">${v}${unit ? `<small>${unit}</small>` : ""}</span>${s ? `<span class="s">${s}</span>` : ""}</div>`;

const attentionRows = [
  ["PROTECTION_MISSING", "live", "sub", "SOLUSDT", "保护腿 21s 未确认(上限 20s)→ 已 reduce-only 市价补偿平仓,intent 5e6f7081 → canceled", "19:53:42", pill("不可静音", "dim", { dot: false, mono: false })],
  ["ORDER_STATE_UNKNOWN", "live", "main", "ETHUSDT", "tg-6b7c8d9e0f1a-e0-1 REST 超时,按 clientOrderId 对账中(3 次 / 45s);期间全账户禁止新增敞口", "19:52:40", pill("不可静音", "dim", { dot: false, mono: false })],
  ["OAUTH_EXPIRING", "warn", "sub", "—", "MCP access token 8m 后过期;单飞刷新将于 19:56:40 触发,失败即 HALT,不烧 token", "19:53:20", btn("去重新授权", "out", { size: "xs" })],
  ["FOREIGN_ORDER", "warn", "main", "ETHUSDT", "发现非本机挂单 web_abc123(stop_market 3100,close_position);开仓前强制对账", "19:53:19", btn("静音 24h", "ghost", { size: "xs" })],
];
const recentIntents = [
  ["19:53:21", "0f8fad5b", "sub", "open", "BTCUSDT", "buy 0.002 @ 60000.5 limit · stop 59000 · tp 62000", "awaiting_approval"],
  ["19:53:20", "4d5e6f70", "sub", "protect", "ETHUSDT", "stop_market 2900.10 mark · replace 2 腿(追踪止损上移)", "executing"],
  ["19:53:20", "3c4d5e6f", "sub", "cancel_order", "BTCUSDT", "gate policy.mode: halt_all(limit run)", "rejected"],
  ["19:53:20", "2b3c4d5e", "main", "transfer", "USDT", "25 · main/spot → sub/usdm_futures · 注资金丝雀", "proposed"],
  ["19:52:40", "6b7c8d9e", "main", "open", "ETHUSDT", "buy 0.25 @ 2958.0 limit · reduce_only", "execution_unknown"],
  ["19:50:12", "8c9d0e1f", "sub", "open", "ETHUSDT", "sell 0.05 @ 2990.0 limit · 等 executor 领取", "authorized"],
  ["09-01 22:10", "1a2b3c4d", "main", "close", "ETHUSDT", "100% market · max_slippage 30 bps · 手动平仓", "completed"],
  ["09-01 14:30", "0e1f2a3b", "sub", "open", "ETHUSDT", "buy 0.05 @ 2900.0 limit · 120 s 无人批", "expired"],
];
const dashboard = () => {
  const kpi = `<div class="ws" style="flex:none;flex-direction:row;align-items:stretch">
    ${cell("合并权益", "3,788.00", "USDT", "main 2,787.50 · sub 1,000.50", { style: "flex:1.15" })}
    ${cell("未实现盈亏", "-12.50", "USDT", `ETHUSDT short · main`, { vcls: "down" })}
    ${cell("今日已实现", "+3.20", "USDT", `main +3.20 · sub 0.00`, { vcls: "up" })}
    ${cell("今日预算", "0 / 2", "开仓", "日亏 0.00% / 1% · token 0.42 / 2.00 RMB", { style: "flex:1.3" })}
    ${cell("待批 intents", "1", "", "TTL 09:28 · BTCUSDT open", { vcls: "warn" })}
    ${cell("通道", `<span class="row" style="gap:6px">${pill("main ok", "ok")}${pill("sub degraded", "warn")}</span>`, "", "oauth 8m 后过期", { style: "flex:1.2;border-right:0" })}
  </div>`;
  const attention = pane(
    "Attention 桶",
    "strategies.list · 派生自 ExchangeOrder / Fill / PositionEffect,不从 intent 状态派生",
    `<div class="row" style="padding:8px 10px;gap:6px;border-bottom:1px solid ${C.line}">
      ${pill("attention 2", "live")}${pill("pending 1", "warn")}${pill("holding 1", "ice")}${pill("ended 3", "mute")}${pill("abnormal 1", "bad")}
      <span class="hint" style="margin-left:auto">不可静音:ORDER_STATE_UNKNOWN · PROTECTION_MISSING</span></div>
    <div class="list">${attentionRows
      .map(([code, tone, a, sym, text, t, action]) => `<div class="li"><span style="width:150px;flex:none">${pill(code, tone)}</span><span style="width:76px;flex:none">${acct(a)}</span><span class="num" style="width:64px;flex:none">${sym}</span><span class="ell" style="flex:1">${text}</span><span class="num hint" style="flex:none">${t}</span><span style="flex:none;width:84px;text-align:right">${action}</span></div>`)
      .join("")}</div>`,
    { style: "flex:none" },
  );
  const recent = pane(
    "最近 intents",
    "intents.list · 事件 intent.*",
    table(
      [{ h: "时间" }, { h: "intent" }, { h: "状态" }, { h: "账户" }, { h: "kind" }, { h: "symbol" }, { h: "摘要" }],
      recentIntents.map(([t, id, a, kind, sym, sum, status]) => [`<span class="num hint">${t}</span>`, `<span class="num">${id}</span>`, st(status), acct(a), `<span class="num">${kind}</span>`, `<span class="num">${sym}</span>`, `<span class="ell" style="display:block;max-width:250px">${sum}</span>`]),
    ),
    { style: "flex:1", actions: btn("全部", "ghost", { size: "xs", icon: "chevR" }) },
  );
  const chan = pane(
    "通道健康",
    "exchange.status",
    `<div class="col" style="padding:10px;gap:10px">
      <div class="card" style="padding:10px"><div class="row" style="margin-bottom:8px">${acct("main")}<span style="margin-left:auto">${pill("ok", "ok")}</span></div>
        ${kv([["key 指纹", hash("7f3a2c91e4b0a7d1c21e")], ["用户数据流", `<span class="up">connected</span> · 3s 前`], ["时钟偏移", "+12 ms"], ["RestGate", "weight 180 / 2400 · 429 ×0"]])}</div>
      <div class="card" style="padding:10px"><div class="row" style="margin-bottom:8px">${acct("sub")}<span style="margin-left:auto">${pill("degraded", "warn")}</span></div>
        ${kv([["OAuth", `<span class="warn">expiring</span> · 8m`], ["MCP 会话", "mcp-9f2e · 2h13m"], ["tools_hash", `${hash("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")} = 钉版 ${ico("check", 11, C.up)}`], ["子账户", "agentic-sub-01 · 1,000.50 USDT"]])}</div>
    </div>`,
    { style: "flex:none", actions: btn("Exchange", "ghost", { size: "xs", icon: "chevR" }) },
  );
  const pol = pane(
    "Policy 快照",
    "policy.get · v3 · 17:06 更新",
    `<div style="padding:10px">${kv([["mode", "run"], ["authority", "draft(人批才执行)"], ["live_capped", "off · 待 Q6"], ["symbol 白名单", "BTCUSDT · ETHUSDT"], ["单笔风险", "0.25% · 杠杆 ≤ 2"], ["日开仓 / 日亏停", "≤ 2 · 1%"], ["授权 TTL", "market 30s · limit 120s"], ["紧急停", `<span class="up">未触发</span>`]])}</div>`,
    { style: "flex:1" },
  );
  return `${kpi}<div style="display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:12px;flex:1;min-height:0"><div class="col" style="gap:12px">${attention}${recent}</div><div class="col" style="gap:12px">${chan}${pol}</div></div>`;
};
files["Main.dc.html"] = page({ id: "dashboard", title: "总览", sub: "Dashboard · 两账户合并", body: dashboard() });

// ───────────────────────── 2. Onboarding 向导 ─────────────────────────
const WIZ = [
  ["1", "模式与风险确认", "quickstart · securityAcknowledgedAt 19:38"],
  ["2", "Workspace", "~/.trade-gate/workspace"],
  ["3", "大脑", "api · deepseek-chat · completion"],
  ["4", "Binance MCP 授权", "Agentic 子账户 · OAuth PKCE"],
  ["4b", "主账户 API key", "可选:手动交易与划转"],
  ["5", "Policy 初值", "金丝雀保守值"],
  ["6", "Gateway", "port 18800 · token"],
  ["7", "行情回填", "90 天 · 8 周期"],
  ["8", "通知(可选)", "Telegram"],
  ["9", "Daemon", "launchd / systemd"],
  ["10", "Health", "WS · MCP · brain · 时钟 · 代理"],
  ["11", "完成", "先 Observe 一周"],
];
const wizardRail = (current, doneUpTo) =>
  `<div class="ws" style="width:250px;flex:none"><div class="pane-h"><span class="pane-t">向导 · tgate onboard</span><span class="hint">wizard.status</span></div>
  <div class="list" style="padding:4px 0">${WIZ.map(([n, label, note]) => {
    const idx = WIZ.findIndex((w) => w[0] === n);
    const state = n === current ? "on" : idx < doneUpTo ? "done" : "todo";
    return `<div class="li ${n === current ? "sel" : ""}" style="gap:10px;padding:6px 12px;border-bottom:0"><span class="step ${state}"><span class="n num">${state === "done" ? ico("check", 10, "currentColor", ' stroke-width="3"') : n}</span></span><span class="col" style="gap:0"><span style="font-size:12.5px;color:${state === "todo" ? C.mutedFg : C.fg}">${label}</span><span class="hint num ell" style="max-width:170px">${note}</span></span></div>`;
  }).join("")}</div>
  <div class="note" style="margin-top:auto;padding:10px 12px;border-top:1px solid ${C.line}">显式状态机,可从任一步恢复;wizard.cancel 不丢已完成的步。</div></div>`;
const phase = (state, title, body, meta = "") =>
  `<div class="row" style="align-items:flex-start;gap:12px;padding:12px 14px;border-bottom:1px solid ${C.line}">${chk(state)}<div class="col" style="flex:1;gap:8px"><div class="row"><span style="font-size:13px;font-weight:600;color:${state === "todo" ? C.mutedFg : C.fg}">${title}</span><span class="hint num" style="margin-left:auto">${meta}</span></div>${body}</div></div>`;
const wizFooter = (nextLabel, nextDisabled = false, back = true) =>
  `<div class="row" style="padding:10px 14px;border-top:1px solid ${C.border};background:rgba(25,31,36,0.4)">${back ? btn("上一步", "ghost") : ""}<span class="hint" style="margin-left:12px">wizard.next 带 idempotencyKey;失败可重试</span><span style="margin-left:auto"></span>${btn("取消向导", "ghost")}${btn(nextLabel, nextDisabled ? "out" : "pri", { extra: nextDisabled ? "dis" : "", icon: "arrowR" })}</div>`;
const wizardPage = (id, title, sub, current, doneUpTo, main) =>
  page({ id: "wizard", title, sub, body: `<div class="row" style="align-items:stretch;gap:12px;flex:1;min-height:0">${wizardRail(current, doneUpTo)}<div class="ws" style="flex:1">${main}</div></div>` });

const scopeChips = (trade) => `${pill("market", "ok")}${pill("account", "ok")}${trade ? pill("trade", "ok") : pill("trade · 未申请", "dim")}${pill("transfer · v1 不勾", "dim")}`;

const oauthWaiting = `
<div class="pane-h" style="height:44px"><span class="pane-t" style="font-size:13px">第 4 步 · Binance MCP 授权(Agentic 子账户)</span><span class="hint">exchange.oauth.start → 浏览器 → /oauth/callback → exchange.oauth.complete</span><span style="margin-left:auto">${pill("等待回调", "warn")}</span></div>
<div class="col" style="flex:1;gap:0;overflow:hidden">
  ${phase("ok", "启动本地回调监听", kv([["redirect_uri", "http://127.0.0.1:18801/oauth/callback"], ["为什么固定端口", "CIMD 元数据里的 redirect_uri 必须逐字匹配"], ["client_id", "CIMD 托管元数据 · bridge.example.com/.well-known/trade-gate-client.json(P0 验证)"], ["PKCE", "S256 · code_verifier 已生成(只在内存)"]]), "19:41:02")}
  ${phase("ok", "打开浏览器授权", `<div class="row" style="gap:8px">${btn("已打开浏览器", "out", { icon: "globe" })}${btn("复制授权链接", "ghost", { icon: "copy" })}<span class="hint">accounts.binance.com/oauth/authorize?client_id=…&amp;scope=market+account&amp;code_challenge=…</span></div><div class="row" style="gap:6px"><span class="lbl">申请 scope</span>${scopeChips(false)}<span class="hint">Observe 阶段只授 market+account;进入 Draft 前再重新授权加 trade</span></div>`, "19:41:03")}
  ${phase("on", "等待回环回调", `<div class="row" style="gap:10px"><span class="spin"></span><span>在浏览器里登录 Binance 并点「授权」后会自动继续,不要关闭本页</span></div>
     <div class="row" style="gap:16px"><span class="num" style="font-size:22px;font-weight:600">00:42</span><span class="col" style="gap:4px;flex:1"><span class="hint">已等待 · 超时 10:00 后需重新开始(code 一次性)</span>${meter(0.07, C.ice)}</span></div>
     <div class="row" style="gap:8px">${btn("重新打开浏览器", "out", { icon: "refresh" })}${btn("换成手动粘贴回调 URL", "ghost")}<span class="hint">回调只在向导期间监听;完成后端口即关</span></div>`, "19:41:03 起")}
  ${phase("todo", "校验 token · tools/list 快照钉版 · 读子账户余额", kv([["token 有效期", "—"], ["scope", "—"], ["tools_hash", "— (钉版后写入 policy)"], ["子账户标识 / 余额", "—"]]), "")}
</div>
${wizFooter("下一步", true)}`;
files["OnboardingOAuth.dc.html"] = wizardPage("wizard", "向导", "Wizard · 第 4 步 · 等待回调", "4", 3, oauthWaiting);

const oauthDone = `
<div class="pane-h" style="height:44px"><span class="pane-t" style="font-size:13px">第 4 步 · Binance MCP 授权(Agentic 子账户)</span><span class="hint">exchange.oauth.complete → exchange.tools.snapshot → account.truth</span><span style="margin-left:auto">${pill("授权成功", "ok")}</span></div>
<div class="col" style="flex:1;gap:0;overflow:hidden">
  ${phase("ok", "本地回调监听 · 浏览器授权 · 回调已收到", `<span class="hint num">回调到达 19:41:58(等待 55s)· code 已换 token · 监听端口已关闭</span>`, "19:41:58")}
  ${phase("ok", "token 校验", `<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 24px">${kv([["access token", "有效至 20:41:58(60m)"], ["refresh token", "有效至 10-02 19:41"], ["刷新策略", "到期前 5m 单飞刷新;401 → 一次刷新后仍失败即 HALT"]])}${kv([["scope 结果", scopeChips(false)], ["撤销", "随时可在 Exchange 页 Disconnect / Binance 端 revoke"]])}</div>`, "19:41:58")}
  ${phase("ok", "tools/list 快照钉版", `${kv([["tools", "14 个 · 真实工具形状已落盘 docs/research/binance-mcp-tools.json"], ["tools_hash", `${hash("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", 6)} · 已钉版 → 漂移即 gate 拒绝`], ["clientOrderId", `支持 / 回显 / 可查 <span class="up">go</span>(A1 报告)`]])}`, "19:41:59")}
  ${phase("ok", "子账户身份与余额", `${kv([["子账户", "agentic-sub-01 · sub_account_id 8823…4f1(稳定标识)"], ["余额", `<span class="num">0.00</span> USDT · usdm_futures · observed 19:42:00`]])}<div class="banner warn">${ico("alert", 14)}<span>余额为 0:去 Binance UI 手动划转;或完成 4b 主账户 key 后,在 Funding 页从主账户注资(金丝雀建议 100 USDT)</span></div>`, "19:42:00")}
</div>
${wizFooter("下一步 · 4b 主账户 API key(可选)")}`;
files["OnboardingOAuthDone.dc.html"] = wizardPage("wizard", "向导", "Wizard · 第 4 步 · 授权结果", "4", 3, oauthDone);

const permRows = [
  ["读取", "enableReading", "ok", "通过", "账户 / 持仓 / 订单只读;Portfolio 页与对账用"],
  ["合约交易", "enableFutures", "ok", "通过", "Trade 页手动下单需要(USDⓈ-M)"],
  ["子账户划转", "permitsUniversalTransfer", "ok", "通过", "Funding 页 main ↔ sub 需要"],
  ["提币", "enableWithdrawals", "bad", "已勾选", `<span class="live">爆炸半径:这把 key 能动主账户的钱。</span>建议去 Binance 取消;保留则必须 IP 白名单(下一行)`],
  ["IP 白名单", "ipRestrict", "ok", "1 个 IP", "203.0.113.7 · 提币权限因此放行;policy.main_account.withdraw_enabled 仍为 false(Q7 默认)"],
];
const mainKey = `
<div class="pane-h" style="height:44px"><span class="pane-t" style="font-size:13px">第 4b 步 · 主账户 API key</span><span class="hint">可选:只有手动交易与划转才需要 · exec.credentials.probe</span><span style="margin-left:auto">${pill("探测完成", "ok")}</span></div>
<div style="display:grid;grid-template-columns:360px minmax(0,1fr);gap:0;flex:1;min-height:0">
  <div class="col" style="padding:14px;gap:12px;border-right:1px solid ${C.line}">
    <div class="field"><span class="lbl">API key</span><div class="inp num">${ico("key", 13, C.mutedFg)}Ab3kQ7mN…9Qx2</div></div>
    <div class="field"><span class="lbl">Secret</span><div class="inp num">${ico("lock", 13, C.mutedFg)}••••••••••••••••••••••••<span class="hint" style="margin-left:auto">已填</span></div></div>
    <div class="banner ice">${ico("lock", 14)}<span>只由 execd 落盘 ~/.trade-gate/secrets/apikey-main.json(0600)。gateway、UI、agent 永不接触明文;agent 的 effective catalog 里没有任何 main 写工具。</span></div>
    <div class="row" style="gap:8px">${btn("重新探测", "out", { icon: "refresh" })}<span class="hint num">上次 19:43:10 · 380 ms</span></div>
    <div class="note">探测顺序:读 → 合约 → 子账户划转 → 提币 → IP 白名单 → 读主账户余额 → 子账户列表。任何一步失败都不阻塞向导,只把对应页面按钮退化为 Binance 深链。</div>
  </div>
  <div class="col" style="gap:0;min-height:0">
    ${table([{ h: "权限" }, { h: "权限位" }, { h: "结果", w: 90 }, { h: "说明" }], permRows.map(([n, bit, k, r, d]) => [n, `<span class="num hint">${bit}</span>`, `<span class="row" style="gap:6px">${chk(k)}<span class="${k === "bad" ? "live" : ""}">${r}</span></span>`, `<span style="white-space:normal;display:block;max-width:560px;line-height:1.4">${d}</span>`]))}
    <div style="display:grid;grid-template-columns:1fr 1.5fr;border-top:1px solid ${C.border}">
      <div class="col" style="padding:12px 14px;gap:8px;border-right:1px solid ${C.line}"><span class="pane-t">主账户余额 <span class="hint" style="font-weight:400">observed 19:43:11</span></span>
        ${kv([["spot USDT", "300.00"], ["usdm_futures USDT", "2,500.00 · 可用 2,100.25"], ["未实现", `<span class="down">-12.50</span>`]])}</div>
      <div class="col" style="padding:12px 14px;gap:8px"><span class="pane-t">子账户列表 <span class="hint" style="font-weight:400">sub-account/list · §3.5 三件事</span></span>
        ${kv([["agentic-sub-01", "Agentic virtual · 8823…4f1"], ["主账户 API 可见", `${chk("ok")} 出现在子账户列表`], ["universalTransfer", `${chk("ok")} 可划转(dry-run)`], ["sub-account/assets", `${chk("ok")} 可读 · 1,000.50 USDT(独立于 OAuth 的对账真相)`]])}</div>
    </div>
  </div>
</div>
${wizFooter("保存并继续 · 5 Policy 初值")}`;
files["OnboardingMainKey.dc.html"] = wizardPage("wizard", "向导", "Wizard · 第 4b 步 · 主账户 API key", "4b", 4, mainKey);

// ───────────────────────── 3. Exchange 健康 ─────────────────────────
const sec = (title, body) => `<div class="col" style="padding:10px 12px;gap:6px;border-bottom:1px solid ${C.line}"><span class="lbl" style="letter-spacing:0.04em">${title}</span>${body}</div>`;
const exchangeMain = pane(
  `${acct("main")} 主账户 · REST + 用户数据流`,
  "",
  `${sec("凭证", kv([["key 指纹", `${hash("7f3a2c91e4b0a7d1c21e", 4)} · sha256 前缀`], ["落盘", "secrets/apikey-main.json · 0600 · 08-30 创建"]]))}
   ${sec("权限位", `<div class="row" style="gap:6px;flex-wrap:wrap">${pill("读", "ok")}${pill("合约", "ok")}${pill("子账户划转", "ok")}${pill("提币 · 未勾", "dim")}${pill("IP 白名单 · 1 条", "ok")}</div>`)}
   ${sec("用户数据流", `<div class="row">${pill("connected", "ok")}<span class="hint">最近事件 3s 前 · listenKey 续期 28m 后 · 24h 重连 0 次</span></div><span class="note">> 60s 无事件 → stale(快照回落 REST);> 600s → unavailable(NO_EXECUTION)</span>`)}
   ${sec("时钟偏移", `<div class="row"><span class="num" style="font-size:16px;font-weight:600">+12 ms</span>${meter(0.006, C.up)}<span class="hint num">阻断 > 2000 · HALT > 10000</span></div><span class="note">NTP 校时 19:50:00 · Clash fake-IP 会让校时静默失效,-1021 出现先查这里</span>`)}
   ${sec("RestGate", `<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px">${kv([["weight 1m", `180 / 2400 ${meter(0.075)}`], ["orders 10s", `3 / 300 ${meter(0.01)}`]])}${kv([["429(24h)", "0 次"], ["recvWindow", "5000 ms"]])}</div>`)}
   ${sec("单写者", kv([["writer", "execd-mba-2026 · lease epoch 7"], ["续约", "19:53:15 · 8794 同账户不同 key 时只能比余额判得出,别共写"]]))}`,
  { actions: pill("ok", "ok"), style: "flex:1" },
);
const exchangeSub = pane(
  `${acct("sub")} Agentic 子账户 · MCP + OAuth`,
  "",
  `${sec("OAuth", `<div class="row" style="gap:6px">${pill("expiring", "warn")}<span class="hint">access 到期 20:01:40(8m)· refresh 有效至 10-02</span></div>
      <div class="row" style="gap:6px"><span class="hint">状态集:</span>${pill("fresh", "ok", { dot: false })}${pill("expiring", "warn", { dot: false })}${pill("expired", "bad", { dot: false })}${pill("revoked", "dim", { dot: false })}<span class="hint">刷新状态机 idle → 19:56:40 单飞刷新 · 401 计数 0</span></div>`)}
   ${sec("scope", `<div class="row" style="gap:6px">${scopeChips(true)}</div>`)}
   ${sec("MCP 会话", `<div class="row">${pill("connected", "ok")}<span class="hint num">mcp-9f2e · 2h13m · tools/call p50 320 ms · 超时 20 s · 只对超时重试 1 次</span></div>`)}
   ${sec("工具快照", `<div class="row" style="gap:8px"><span class="num">当前 ${hash("a7c4f2d1e8b9c0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b1d90")}</span><span class="hint">≠</span><span class="num">钉版 ${hash("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")}</span>${pill("drift", "live")}</div>
      <div class="banner live">${ico("alert", 14)}<span>15 tools(钉版 14):新增 futures_modify_order。gate「工具快照哈希 = 钉版」不通过,拒绝一切新提议;EmergencyReduce 不受影响。</span></div>
      <div class="row" style="gap:8px">${btn("查看 diff", "out", { size: "xs" })}${btn("重新钉版(admin)", "pri", { size: "xs" })}<span class="hint">exchange.tools.snapshot · 需 operator.admin</span></div>`)}
   ${sec("子账户", kv([["标识", "agentic-sub-01 · sub_account_id 8823…4f1"], ["余额", `<span class="num">1,000.50</span> USDT · usdm_futures · observed 19:53:19`], ["资金流", "agent 无任何划转 / 提币工具;注资走 Funding 页(principal=user)"]]))}`,
  { actions: pill("degraded", "warn"), style: "flex:1" },
);
const exchangeEvents = pane(
  "exchange.* 最近事件",
  "events 表 · seq 单调 · 支持 since",
  table([{ h: "seq", w: 70 }, { h: "时间", w: 140 }, { h: "事件", w: 220 }, { h: "账户", w: 100 }, { h: "详情" }], [
    ["4188", "19:52:10", pill("exchange.tools.drift", "live"), acct("sub"), `<span class="num">a7c4…1d90 ≠ e3b0…b855</span> · +futures_modify_order`],
    ["4175", "19:50:00", pill("exchange.clock.synced", "mute"), acct("main"), `offset +12 ms · ntp time.apple.com`],
    ["4102", "19:41:59", pill("exchange.tools.snapshot", "mute"), acct("sub"), `pinned <span class="num">e3b0…b855</span> · 14 tools`],
    ["4101", "19:41:58", pill("exchange.auth.granted", "ok"), acct("sub"), `scope market,account,trade · access 60m · refresh 30d`],
  ].map(([s, t, e, a, d]) => [`<span class="num hint">${s}</span>`, `<span class="num">${t}</span>`, e, a, d])),
  { style: "flex:none" },
);
files["Exchange.dc.html"] = page({
  id: "exchange", title: "交易所", sub: "Exchange · 两通道健康",
  extra: `<span class="row" style="gap:6px;margin-left:8px">${btn("重新授权", "pri", { size: "xs", icon: "refresh" })}${btn("Disconnect", "dout", { size: "xs" })}${btn("刷新快照", "out", { size: "xs" })}</span>`,
  body: `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;flex:1;min-height:0">${exchangeMain}${exchangeSub}</div>${exchangeEvents}`,
});

// ───────────────────────── 4. Portfolio ─────────────────────────
const comp = (name, completeness, source, t) => {
  const tone = completeness === "complete" ? "ok" : completeness === "partial" ? "warn" : "bad";
  return `<span class="row" style="gap:5px">${pill(`${name} ${completeness}`, tone, { dot: true })}<span class="hint num">${source} · ${t}</span></span>`;
};
const consistencyRow = (a, cons, ver, span, note) =>
  `<div class="row" style="gap:10px;padding:8px 12px;border-bottom:1px solid ${C.line}">${acct(a)}${pill(cons, cons === "consistent" ? "ok" : cons === "inconsistent" ? "warn" : "bad")}<span class="hint num">account_version ${hash(ver)} · span ${span} ms · computed 19:53:20</span>${note ? `<span class="hint">${note}</span>` : ""}</div>`;
const portfolio = () => {
  const head = `<div class="row" style="gap:10px;flex:none"><span class="seg"><span class="on">合并</span><span>main</span><span>sub</span></span><span class="hint">account.truth · 每个组件各自 observed_at + 取数区间 + completeness;经济组件哈希 = account_version</span><span style="margin-left:auto" class="row">${btn("强刷(30s)", "out", { size: "xs", icon: "refresh" })}</span></div>`;
  const cons = `<div class="ws" style="flex:none">${consistencyRow("main", "consistent", "0000000000000000000000000000000000000000000000000000000000000000", 40, "")}${consistencyRow("sub", "consistent", "a18c8380c8cef8e3ed2ef66ee6d39cfcf4bd56c0271e3f7fe810478e065ac7ab", 350, `margin 组件 partial(不参与哈希)`)}</div>`;
  const balances = pane(
    "余额",
    "balances",
    table(
      [{ h: "账户" }, { h: "wallet" }, { h: "asset" }, { h: "wallet_balance", r: true, num: true }, { h: "available", r: true, num: true }, { h: "unrealized_pnl", r: true, num: true }, { h: "observed_at", num: true }, { h: "completeness" }],
      [
        [acct("main"), "usdm_futures", "USDT", "2,500.00", "2,100.25", `<span class="down">-12.50</span>`, "19:53:19.960", comp("balances", "complete", "rest", "50 ms")],
        [acct("main"), "spot", "USDT", "300.00", "300.00", "—", "19:53:19.960", comp("balances", "complete", "rest", "50 ms")],
        [acct("sub"), "usdm_futures", "USDT", "1,000.50", "900.00", "—", "19:53:19.900", comp("balances", "complete", "mcp", "250 ms")],
      ],
    ),
    { style: "flex:none" },
  );
  const positions = pane(
    "持仓",
    "positions · position_mode one_way(实查,两账户)",
    table(
      [{ h: "账户" }, { h: "symbol" }, { h: "side / qty", num: true }, { h: "entry", r: true, num: true }, { h: "mark", r: true, num: true }, { h: "uPnL", r: true, num: true }, { h: "lev / margin", num: true }, { h: "liq", r: true, num: true }, { h: "notional", r: true, num: true }, { h: "observed_at", num: true }, { h: "completeness" }],
      [
        [acct("main"), "ETHUSDT", `<span class="down">short</span> -0.5`, "2950.4", "2975.4", `<span class="down">-12.50</span>`, "3x isolated · 491.7", "3890.2", "-1,487.70", "19:53:19.970", comp("positions", "complete", "ws", "50 ms")],
        [acct("sub"), `<span class="hint">无持仓</span>`, "—", "—", "—", "—", "—", "—", "—", "19:53:19.950", comp("positions", "complete", "mcp", "250 ms")],
      ],
    ),
    { style: "flex:none" },
  );
  const orders = pane(
    "挂单",
    "open_orders · origin:local = tg- 前缀 · foreign = 其余(ts_ 为 8794);开仓前发现 foreign 活动 → 强制对账",
    `${table(
      [{ h: "账户" }, { h: "symbol" }, { h: "type", num: true }, { h: "side" }, { h: "exec / orig", r: true, num: true }, { h: "stop / price", r: true, num: true }, { h: "flags" }, { h: "origin" }, { h: "client_order_id", num: true }, { h: "observed_at", num: true }],
      [[acct("main"), "ETHUSDT", "stop_market", `<span class="up">buy</span>`, "0 / 0.5", "3100", `${pill("reduce_only", "dim", { dot: false })} ${pill("close_position", "dim", { dot: false })} ${pill("mark_price", "dim", { dot: false })}`, pill("foreign", "warn"), "web_abc123", "19:53:20.000"]],
    )}
    <div class="row" style="padding:8px 12px;gap:10px;border-top:1px solid ${C.line}">${pill("execution_unknown", "live")}<span class="num">tg-6b7c8d9e0f1a-e0-1</span><span class="hint">main · ETHUSDT buy 0.25 @ 2958.0 limit reduce_only · REST 超时 → 未决尝试,按 clientOrderId 在 history / fills / open orders 对账中(3 次 / 45s);列表里看不到 ≠ 交易所没收到</span></div>`,
    { style: "flex:none" },
  );
  const health = pane(
    "组件与快照历史",
    "consistency 派生规则:全组件 complete 且 span ≤ 15 s → consistent;组件缺失 / 跨度过大 → inconsistent(gate 拒开仓);取数失败 → unavailable(NO_EXECUTION)",
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:0;height:100%">
      <div class="col" style="padding:10px 12px;gap:8px;border-right:1px solid ${C.line}">
        <div class="row" style="gap:8px;flex-wrap:wrap">${acct("main")}${comp("balances", "complete", "rest", "19:53:19.960")}${comp("positions", "complete", "ws", "19:53:19.970")}${comp("open_orders", "complete", "ws", "19:53:20.000")}${comp("position_mode", "complete", "rest", "one_way")}</div>
        <div class="row" style="gap:8px;flex-wrap:wrap">${acct("sub")}${comp("balances", "complete", "mcp", "19:53:19.900")}${comp("positions", "complete", "mcp", "19:53:19.950")}${comp("open_orders", "complete", "mcp", "19:53:20.000")}${comp("position_mode", "complete", "mcp", "one_way")}${comp("recent_fills", "complete", "mcp", "19:53:19.990")}${comp("margin", "partial", "mcp", "margin ratio 字段缺失 · retryable")}</div>
      </div>
      <div class="col" style="padding:10px 12px;gap:6px">
        <span class="lbl">最近快照 · account_snapshots(只留最近 N 条)</span>
        <div class="row" style="gap:8px"><span class="num hint" style="width:60px">19:53:20</span>${acct("main")}${pill("consistent", "ok")}<span class="hint num">span 40 ms</span></div>
        <div class="row" style="gap:8px"><span class="num hint" style="width:60px">19:53:20</span>${acct("sub")}${pill("consistent", "ok")}<span class="hint num">span 350 ms · margin partial</span></div>
        <div class="row" style="gap:8px"><span class="num hint" style="width:60px">19:41:40</span>${acct("main")}${pill("unavailable", "bad")}<span class="hint">REST -1021 时钟漂移;用户数据流断开 > 600s · 4 组件 missing(source cache · age 700 s)</span></div>
        <div class="row" style="gap:8px"><span class="num hint" style="width:60px">18:20:05</span>${acct("sub")}${pill("inconsistent", "warn")}<span class="hint">span 22,140 ms > 15,000 · open_orders 取数区间跨过 positions;gate 拒开仓,只允许风险降低</span></div>
      </div>
    </div>`,
    { style: "flex:1" },
  );
  return `${head}${cons}${balances}${positions}${orders}${health}`;
};
files["Portfolio.dc.html"] = page({ id: "portfolio", title: "资产", sub: "Portfolio · 主账户 + Agentic 子账户合并", body: portfolio() });

// ───────────────────────── 5. Trade(主账户手动下单,经 execd) ─────────────────────────
const field = (l, v, { mono = true, ro = false, right = "" } = {}) => `<div class="field"><span class="lbl">${l}</span><div class="inp ${ro ? "ro" : ""} ${mono ? "num" : ""}">${v}${right ? `<span class="hint" style="margin-left:auto">${right}</span>` : ""}</div></div>`;
const tradeForm = pane(
  "下单 · 主账户",
  "",
  `<div class="col" style="padding:12px;gap:10px">
    <div class="row">${acct("main")}<span class="hint">principal=user · confirm=structured · 经 execd REST 单写者</span></div>
    <div class="banner live" style="padding:6px 10px">${ico("alert", 14)}<span>execution_unknown 进行中(tg-6b7c8d9e0f1a-e0-1):全账户禁止新增敞口,只允许 reduce_only</span></div>
    ${field("symbol", "ETHUSDT", { right: "持仓 short -0.5" })}
    <div class="field"><span class="lbl">side</span><span class="seg" style="width:100%"><span class="on buy" style="flex:1;text-align:center">buy</span><span style="flex:1;text-align:center">sell</span></span></div>
    <div class="field"><span class="lbl">type</span><span class="seg" style="width:100%"><span style="flex:1;text-align:center">market</span><span class="on" style="flex:1;text-align:center">limit</span><span style="flex:1;text-align:center">stop_market</span></span></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">${field("qty", "0.25", { right: "step 0.001" })}${field("price", "2960.00", { right: "tick 0.01" })}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">${field("leverage", "3x", { ro: true, right: "随持仓" })}${field("time_in_force", "gtc")}</div>
    <div class="row" style="gap:16px"><span class="row" style="gap:6px">${chk("on")}<span>reduce_only</span></span><span class="row" style="gap:6px">${chk("todo")}<span class="hint">post_only</span></span><span class="row" style="gap:6px">${chk("todo")}<span class="hint">close_position</span></span></div>
    <div class="row" style="gap:6px"><span class="hint">名义</span><span class="num">740.00 USDT</span><span class="hint">· 偏离 mark</span><span class="num warn">-52 bps</span><span class="hint">(上限 55)</span></div>
    ${btn("预览计划", "pri", { size: "lg", icon: "layers", extra: "" })}
    <span class="note">手动单也过基础闸:filters · 持仓模式 · 限频 · 紧急停;不受 agent 的 authority / 日频 / 名义上限约束。</span>
  </div>`,
  { style: "flex:none;width:300px" },
);
const PLAN_HASH_MAIN = "8d9e6f70a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9ea3c1";
const planPreview = pane(
  "ExecutableOrderPlan 预览",
  "plan v1 · 审批前物化 · 审批的是 plan_hash",
  `<div class="col" style="padding:12px;gap:12px">
    <div class="row" style="gap:8px">${pill("kind order", "mute", { dot: false })}${pill("channel rest", "slate", { dot: false })}<span class="num">plan_hash ${hash(PLAN_HASH_MAIN, 6)}</span>${btn("", "ghost", { icon: "copy", size: "xs" })}<span class="hint" style="margin-left:auto">authorization_ttl 120 s(limit)</span></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 24px">
      ${kv([["product", "usdm_perp"], ["symbol", "ETHUSDT"], ["side", `<span class="up">buy</span>`], ["pos_side / mode", "both · one_way"], ["order_type", "limit"], ["qty", "0.25"], ["price", "2960.00"]])}
      ${kv([["time_in_force", "gtc"], ["reduce_only", "true"], ["close_position", "false"], ["leverage / margin", "3 · isolated"], ["protection", "—(reduce_only)"], ["max_naked_seconds", "—"], ["expires_at", "20:03:20"]])}
    </div>
    <div class="card" style="padding:10px;background:${C.bg}">
      <span class="lbl">basis(不进哈希)</span>
      <div style="margin-top:6px">${kv([["filters", "tick 0.01 · step 0.001 · min_notional 5 · 19:53:10"], ["market_ref", "mark 2975.4 · last 2975.1 · 19:53:19"], ["account_version", `${hash("0000000000000000000000000000000000000000000000000000000000000000")} · policy_version 3`]])}</div>
    </div>
    <div class="col" style="gap:6px"><span class="lbl">基础闸预检(派发前会重闸,只能拒绝不能改经济字段)</span>
      <div class="row" style="gap:6px;flex-wrap:wrap">${["filters", "position_mode", "rate_limit", "emergency_stop", "reduce_only 不得翻仓", "execution_unknown 敞口禁令(reduce_only 豁免)"].map((g) => pill(g, "ok", { mono: false })).join("")}${pill("price_deviation 52 / 55 bps", "warn", { dot: false })}</div>
    </div>
    <div class="row" style="gap:8px;margin-top:auto">${btn("提交并确认", "pri", { size: "lg", icon: "check" })}${btn("放弃", "ghost", { size: "lg" })}<span class="hint">提交 → 结构化确认弹层(逐字回填 confirm_fields)</span></div>
  </div>`,
  { style: "flex:1" },
);
const flow = (rows) => steps(rows);
const submissions = pane(
  "提交状态流",
  "intent 状态 · 事件 intent.* / attempt.* / order.observed",
  `<div class="col" style="gap:0">
    <div class="col" style="padding:10px 12px;gap:8px;border-bottom:1px solid ${C.line}">
      <div class="row"><span class="num">6b7c8d9e</span><span class="hint">open · ETHUSDT buy 0.25 @ 2958.0 limit reduce_only</span><span style="margin-left:auto">${st("execution_unknown")}</span></div>
      ${flow([{ label: "authorized", state: "done" }, { label: "dispatching", state: "done" }, { label: "execution_unknown", state: "bad" }, { label: "executing…", state: "todo" }])}
      <div class="banner live" style="align-items:flex-start"><span style="margin-top:1px">${ico("alert", 14)}</span><span>REST 调用超时(10 s),不知道交易所是否收到。正在按 clientOrderId <span class="num">tg-6b7c8d9e0f1a-e0-1</span> 在 order history / fills / open orders 对账(有界轮询无限期继续,第 3 次 / 45 s)。<b>期间禁止新增敞口</b>;找到 → executing,确认从未收到(history 无且超 recvWindow)→ canceled。没有 LOST。</span></div>
      <div class="row" style="gap:8px"><span class="hint num">attempt 1 · stage submitted · fencing 7:execd-mba-2026</span>${btn("立即对账", "out", { size: "xs", icon: "refresh" })}</div>
    </div>
    <div class="col" style="padding:10px 12px;gap:8px;border-bottom:1px solid ${C.line}">
      <div class="row"><span class="num">1a2b3c4d</span><span class="hint">close · ETHUSDT 100% market · 09-01 22:10</span><span style="margin-left:auto">${st("completed")}</span></div>
      ${flow([{ label: "authorized", state: "done" }, { label: "dispatching", state: "done" }, { label: "executing", state: "done" }, { label: "completed", state: "done" }])}
      ${kv([["attempt", "tg-1a2b3c4d5e6f-x0-1 · acked 180 ms"], ["ExchangeOrder", "filled 0.5 / 0.5 · avg 2971.30"], ["PositionEffect", `satisfied · 平仓 = 数量核实 ${ico("check", 11, C.up)}`]])}
    </div>
    <div class="col" style="padding:10px 12px;gap:8px">
      <div class="row"><span class="num">9f0a1b2c</span><span class="hint">open · ETHUSDT sell 0.5 @ 2950.4 limit · 09-01 22:41</span><span style="margin-left:auto">${st("completed")}</span></div>
      ${flow([{ label: "authorized", state: "done" }, { label: "dispatching", state: "done" }, { label: "executing", state: "done" }, { label: "completed", state: "done" }])}
      ${kv([["保护腿", `stop_market 3100 · 确认在交易所 · naked 4 s ${ico("check", 11, C.up)}`], ["注意", "该止损后来被外部改单(web_abc123 → foreign)"]])}
    </div>
    <div class="note" style="padding:8px 12px;border-top:1px solid ${C.line}">授权 TTL:market 30 s · limit 120 s;过期未派发 → expired。dispatching 时 gate 重闸失败 → rejected 并作废授权。</div>
  </div>`,
  { style: "flex:none;width:420px" },
);
files["Trade.dc.html"] = page({ id: "trade", title: "手动下单", sub: "Trade · 主账户 · REST 经 execd", body: `<div class="row" style="align-items:stretch;gap:12px;flex:1;min-height:0">${tradeForm}${planPreview}${submissions}</div>` });

// ───────────────────────── 5b. 结构化确认弹层(组件 1:1) ─────────────────────────
const confirmRows = [["plan_hash", `${PLAN_HASH_MAIN.slice(0, 12)}…${PLAN_HASH_MAIN.slice(-8)}`], ["symbol", "ETHUSDT"], ["side", "buy"], ["qty", "0.25"], ["order_type", "limit"], ["price", "2960.00"], ["leverage", "3"], ["reduce_only", "true"]];
const confirmDialog = `
<div style="width:520px;height:760px;background:${C.bg};display:flex;align-items:center;justify-content:center;padding:20px">
  <div class="card" style="width:480px;background:${C.pop};box-shadow:0 20px 60px rgba(0,0,0,0.6);display:flex;flex-direction:column">
    <div class="col" style="padding:16px 18px 12px;gap:6px;border-bottom:1px solid ${C.border}">
      <div class="row" style="gap:8px">${ico("exchange", 16, C.ice)}<span style="font-size:14px;font-weight:600">确认下单</span>${acct("main")}<span style="margin-left:auto">${ring(0.93, "01:52", C.ice, 44)}</span></div>
      <span class="note">以下 8 个字段会作为 confirm_echo 逐字回填给 execd,与 plan.economic 派生的 map 不一致(多、少、任何差异)即 conflict,不会下单。缺省字段(trigger_price)不出现。</span>
    </div>
    <div class="col" style="padding:6px 18px;gap:0">
      ${confirmRows.map(([k, v]) => `<div class="row" style="height:34px;border-bottom:1px solid ${C.line}"><span class="num hint" style="width:120px">${k}</span><span class="num" style="font-size:13px;font-weight:${k === "qty" || k === "price" || k === "side" ? 600 : 500};color:${k === "side" ? C.up : C.fg}">${v}</span>${k === "plan_hash" ? `<span style="margin-left:auto">${btn("", "ghost", { icon: "copy", size: "xs" })}</span>` : ""}</div>`).join("")}
    </div>
    <div class="col" style="padding:12px 18px;gap:10px">
      <div class="row" style="gap:8px"><span class="hint">授权有效期</span>${meter(0.93, C.ice)}<span class="num">112 / 120 s</span><span class="hint">limit 120 s · market 30 s</span></div>
      <div class="row" style="gap:8px;align-items:flex-start">${chk("on")}<span style="font-size:12.5px">我已逐项核对上面 8 个字段;提交后 gate 仍会在派发前重闸(只能拒绝,不能改经济字段)。</span></div>
      <div class="banner ice" style="padding:6px 10px">${ico("lock", 14)}<span>reduce_only=true:不受当前 execution_unknown 的敞口禁令影响;经济字段任何实质变化 → 作废本授权、生成新 plan 重新确认。</span></div>
    </div>
    <div class="row" style="padding:12px 18px;border-top:1px solid ${C.border};gap:8px;justify-content:flex-end">${btn("取消", "ghost", { size: "lg" })}${btn("确认并提交 · intents.approve", "pri", { size: "lg", icon: "check" })}</div>
  </div>
</div>`;
files["TradeConfirm.dc.html"] = doc("结构化确认", confirmDialog, { w: 520, h: 760 });

// ───────────────────────── 6. Funding ─────────────────────────
const funding = () => {
  const balances = `<div class="ws" style="flex:none;flex-direction:row">
    ${cell("main · spot", "300.00", "USDT", "可划转 · 提币只从这里")}
    ${cell("main · usdm_futures", "2,500.00", "USDT", "可用 2,100.25 · 持仓中")}
    ${cell("sub · usdm_futures", "1,000.50", "USDT", "可用 900.00 · agentic-sub-01")}
    ${cell("金丝雀注资上限", "100", "USDT", "policy.canary.funded_balance_quote · 待 Q2", { style: "border-right:0" })}
  </div>`;
  const transfer = pane(
    "划转 main ↔ sub",
    "intent kind=transfer · principal=user · execd 走主账户 REST sub-account/universalTransfer",
    `<div class="col" style="padding:12px;gap:10px">
      <div class="field"><span class="lbl">方向</span><span class="seg" style="width:100%"><span class="on" style="flex:1;text-align:center">main → sub 注资</span><span style="flex:1;text-align:center">sub → main 回收</span></span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">${field("asset", "USDT")}${field("amount", "25", { right: "可用 300.00" })}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">${field("from_wallet", "main · spot")}${field("to_wallet", "sub · usdm_futures")}</div>
      <div class="card" style="padding:10px;background:${C.bg}">${kv([["plan", `kind transfer · v1 · ${hash("f900d9a89b081abc1badbcafb9752819603acff182199742dc53c254c2fe77d6", 6)}`], ["basis", "主账户 spot 可用 USDT 300 ≥ 25"], ["confirm_fields", "asset · amount · from_account · to_account · plan_hash"], ["authorization_ttl", "120 s"]])}</div>
      <div class="row" style="gap:8px;align-items:flex-start">${chk("todo")}<span>我确认从 <b>main / spot</b> 划转 <b class="num">25 USDT</b> 到 <b>sub / usdm_futures</b>(注资金丝雀)</span></div>
      <div class="banner warn" style="padding:6px 10px">${ico("alert", 14)}<span>Binance 可能要求 2FA:划转被拒(-2015 / 需验证)时先在 Binance App 完成验证再重试;execd 不会盲重放。</span></div>
      <div class="row" style="gap:8px">${btn("确认划转", "pri", { size: "lg", icon: "funding" })}<span class="hint">agent 没有任何划转 / 提币工具;此按钮 = tools.invoke intent.propose(kind transfer)+ 结构化确认</span></div>
    </div>`,
    { style: "flex:1" },
  );
  const withdraw = pane(
    "提币",
    "Q7 默认:不做一键提币",
    `<div class="col" style="padding:12px;gap:10px">
      ${btn("打开 Binance 提币页", "out", { size: "lg", icon: "ext" })}
      <span class="note">子账户在 Binance 规则下不能对外提币:先 <b>sub → main 回收</b>,再从 main 提币。主账户 API key 的提币权限保持关闭(policy.main_account.withdraw_enabled = false);要一键提币必须 IP 白名单 + 本页二次确认,且需单独拍板。</span>
      ${kv([["withdraw_enabled", `<span class="mutedc">false</span>`], ["transfers_enabled", `<span class="up">true</span> · policy v3`], ["深链", "binance.com/my/wallet/…/withdrawal/crypto/USDT"]])}
    </div>`,
    { style: "flex:none" },
  );
  const history = pane(
    "划转历史",
    "intents.list{kind transfer} · account.history",
    table(
      [{ h: "时间" }, { h: "intent" }, { h: "方向" }, { h: "asset" }, { h: "amount", r: true, num: true }, { h: "from → to", num: true }, { h: "状态" }, { h: "plan_hash / tranId", num: true }, { h: "备注" }],
      [
        ["19:53:20", "2b3c4d5e", `${acct("main")} → ${acct("sub")}`, "USDT", "25", "spot → usdm_futures", st("proposed"), hash("f900d9a89b081abc1badbcafb9752819603acff182199742dc53c254c2fe77d6"), "等待结构化确认 · TTL 300 s"],
        ["09-01 21:04", "c1d2e3f4", `${acct("main")} → ${acct("sub")}`, "USDT", "100", "spot → usdm_futures", st("completed"), "tranId 183920011", "金丝雀初始注资"],
        ["08-30 10:12", "d2e3f4a5", `${acct("sub")} → ${acct("main")}`, "USDT", "40", "usdm_futures → spot", st("completed"), "tranId 183877402", "回收 paper 期余额"],
        ["08-29 18:40", "e3f4a5b6", `${acct("main")} → ${acct("sub")}`, "USDT", "60", "spot → usdm_futures", st("rejected"), "—", "gate main_account.transfers_enabled=false(当时)"],
      ].map((r) => [`<span class="num hint">${r[0]}</span>`, `<span class="num">${r[1]}</span>`, ...r.slice(2)]),
    ),
    { style: "flex:1" },
  );
  return `${balances}<div style="display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:12px;flex:none">${transfer}${withdraw}</div>${history}`;
};
files["Funding.dc.html"] = page({ id: "funding", title: "划转", sub: "Funding · main ↔ sub · 提币深链", body: funding() });

// ───────────────────────── 7. Intents 审批卡(桌面 + 移动) ─────────────────────────
const PLAN_HASH_BTC = "474838171b83561288f58fc3ebdaf96c236f5ff4983b1556cac37ee8cc22433c";
const intentRows = [
  ["awaiting_approval", "0f8fad5b", "sub", "open", "BTCUSDT", "buy 0.002 @ 60000.5 limit", "19:53:21", "TTL 09:28", true],
  ["executing", "4d5e6f70", "sub", "protect", "ETHUSDT", "stop 2900.10 · replace ×2", "19:53:20", "scheduler"],
  ["execution_unknown", "6b7c8d9e", "main", "open", "ETHUSDT", "buy 0.25 @ 2958.0 reduce_only", "19:52:40", "对账 3 次"],
  ["dispatching", "7a8b9c0d", "sub", "protect", "BTCUSDT", "追加 tp 62000 · 50%", "19:53:50", "epoch 7"],
  ["proposed", "2b3c4d5e", "main", "transfer", "USDT", "25 · main/spot → sub/usdm_futures", "19:53:20", "等待确认"],
  ["authorized", "8c9d0e1f", "sub", "open", "ETHUSDT", "sell 0.05 @ 2990.0 limit", "19:50:12", "等 executor 领取"],
  ["canceled", "5e6f7081", "sub", "open", "SOLUSDT", "sell 1.5 market · 保护腿 21 s 未确认", "19:53:42", "compensation_close"],
  ["rejected", "3c4d5e6f", "sub", "cancel_order", "BTCUSDT", "gate policy.mode: halt_all(limit run)", "19:53:20", "gate"],
  ["completed", "1a2b3c4d", "main", "close", "ETHUSDT", "100% market · 手动平仓", "09-01 22:10", "effect satisfied"],
  ["expired", "0e1f2a3b", "sub", "open", "ETHUSDT", "buy 0.05 @ 2900.0 limit", "09-01 14:30", "120 s 无人批"],
  ["recorded", "9d0e1f2a", "sub", "open", "BTCUSDT", "buy · authority=observe 只落库", "09-01 08:12", "observe"],
];
const intentList = pane(
  "",
  "",
  `<div class="row" style="padding:0 6px;border-bottom:1px solid ${C.border}"><span class="tab on">全部 <span class="cnt">11</span></span><span class="tab">待批 <span class="cnt warn">1</span></span><span class="tab">进行中 <span class="cnt">4</span></span><span class="tab">历史</span><span style="margin-left:auto" class="row">${ico("filter", 13, C.mutedFg)}</span></div>
   <div class="row" style="padding:6px 10px;gap:6px;border-bottom:1px solid ${C.line}"><span class="seg"><span class="on">全部</span><span>main</span><span>sub</span></span><span class="hint">11 种状态全覆盖 · 终态:rejected recorded completed canceled expired</span></div>
   <div class="list">${intentRows
     .map(([status, id, a, kind, sym, sum, t, note, sel]) => `<div class="li ${sel ? "sel" : ""}" style="gap:8px;padding:6px 10px"><span style="width:132px;flex:none">${st(status)}</span><span class="col" style="flex:1;gap:1px"><span class="row" style="gap:6px"><span class="num" style="font-weight:600">${sym}</span><span class="num hint">${kind}</span>${acct(a, { cls: "", dot: false })}</span><span class="hint ell">${sum}</span></span><span class="col" style="align-items:flex-end;gap:1px;flex:none"><span class="num hint">${t}</span><span class="hint num" style="font-size:10.5px">${note}</span></span></div>`)
     .join("")}</div>`,
  { style: "width:470px;flex:none" },
);
const GATES = [
  ["policy.mode", "run", "ok"], ["authority", "draft → 需人批", "warn"], ["symbol_allowlist", "BTCUSDT", "ok"], ["product_allowlist", "usdm_perp", "ok"],
  ["account_truth 新鲜度", "0.35 s ≤ 15 s", "ok"], ["market 新鲜度", "1.0 s ≤ 5 s", "ok"], ["oauth scope trade", "有", "ok"], ["tools_hash = 钉版", "e3b0…b855", "ok"],
  ["必须有止损", "59000 mark", "ok"], ["leverage", "2 ≤ 2", "ok"], ["order_notional", "120 ≤ 200", "ok"], ["position_notional", "120 ≤ 400", "ok"],
  ["daily_opens", "0 / 2", "ok"], ["symbol_cooldown", "60 min 内无", "ok"], ["price_deviation", "16 ≤ 55 bps", "ok"], ["ntp 漂移", "12 ms ≤ 2 s", "ok"],
  ["position_mode", "one_way", "ok"], ["unknown 敞口禁令", "sub 无未决", "ok"],
];
const gateGrid = (gates, cols = 2) => `<div style="display:grid;grid-template-columns:repeat(${cols}, minmax(0, 1fr));gap:4px 16px">${gates.map(([g, v, k]) => `<div class="row" style="gap:6px;height:22px">${chk(k)}<span class="hint" style="width:132px;flex:none">${g}</span><span class="num ell">${v}</span></div>`).join("")}</div>`;
const intentDetail = pane(
  `<span class="num" style="font-size:13px">open · BTCUSDT · <span class="up">buy</span></span>`,
  "",
  `<div class="col" style="padding:12px 14px;gap:12px;height:100%">
    <div class="row" style="gap:6px;flex-wrap:wrap">${st("awaiting_approval")}${acct("sub")}${pill("principal model", "dim", { dot: false })}${pill("origin recipe:w4-judgment", "dim", { dot: false })}${pill("run-20260902-0001", "dim", { dot: false })}${pill("intent 0f8fad5b-d9cb-469f-a165-70867728950e", "dim", { dot: false })}
      <span style="margin-left:auto" class="row">${ring(0.94, "09:28", C.warn, 44)}<span class="col" style="gap:0;margin-left:8px"><span class="hint">提案 TTL 600 s · 到 20:03:20</span><span class="hint">批准后授权 TTL 120 s(limit)</span></span></span></div>
    <div style="display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:12px">
      <div class="card" style="padding:10px 12px"><span class="lbl">thesis</span><div style="font-size:13.5px;margin:4px 0 6px">4h 结构回踩支撑,量能收缩</div>
        <div class="row" style="gap:6px;flex-wrap:wrap"><span class="lbl">evidence_refs</span>${pill("T7.E1 market.features 4h", "ice", { dot: false })}${pill("T7.E3 market.structure 4h", "ice", { dot: false })}</div>
        <div class="row" style="gap:6px;margin-top:6px"><span class="lbl">invalidation</span><span>收盘跌破 58800</span></div></div>
      <div class="card" style="padding:10px 12px">${kv([["size_hint", "full → qty 由代码按止损距离反推"], ["sizing", "0.25% × 1000 = 2.5 USDT"], ["raw_qty", "0.0024987 → 0.002(step 向下)"], ["名义", "120.00 USDT"]])}</div>
    </div>
    <div class="card" style="padding:10px 12px">
      <div class="row" style="gap:8px;margin-bottom:6px"><span class="lbl">ExecutableOrderPlan v1</span><span class="num">plan_hash ${hash(PLAN_HASH_BTC, 6)}</span>${pill("channel mcp", "ice", { dot: false })}<span class="hint" style="margin-left:auto">审批的是 plan_hash;经济字段变化 → 新 plan、旧授权作废</span></div>
      <div style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:4px 24px">
        ${kv([["entry", "limit 60000.5 · gtc"], ["qty", "0.002 · step 0.001"], ["leverage / margin", "2x · isolated"], ["position_mode", "one_way(实查)"]])}
        ${kv([["stop", "stop_market 59000 · mark · close"], ["take_profit", "tp_market 62000 · 0.001 · mark"], ["max_naked_seconds", "20 s"], ["account_version", `${hash("a18c8380c8cef8e3ed2ef66ee6d39cfcf4bd56c0271e3f7fe810478e065ac7ab")} · mark 60010.2`]])}
      </div>
    </div>
    <div class="card" style="padding:10px 12px;flex:1;min-height:0;overflow:hidden">
      <div class="row" style="margin-bottom:6px"><span class="lbl">gate v2 结果</span>${pill("17 通过 · 1 需人批", "ok", { dot: false, mono: false })}<span class="hint" style="margin-left:auto">纯函数 · policy kv 热读 · 每次拒绝落 intent 行</span></div>
      ${gateGrid(GATES, 2)}
    </div>
    <div class="row" style="gap:8px;margin-top:auto">
      ${btn("拒绝", "dout", { size: "lg", icon: "x" })}
      <span class="hint">拒绝原因可选:thesis 不足 / 时机 / 手动接管</span>
      <span style="margin-left:auto" class="row" style="gap:8px">${btn(`批准 plan_hash ${PLAN_HASH_BTC.slice(0, 6)}…${PLAN_HASH_BTC.slice(-4)} · 回填 8 字段`, "pri", { size: "lg", icon: "check" })}</span>
    </div>
  </div>`,
  { style: "flex:1", actions: `<span class="hint">intents.get · intents.approve(超上限需 admin)· intents.reject</span>` },
);
files["Intents.dc.html"] = page({ id: "intents", title: "审批", sub: "Intents · 待批卡 + 历史 + gate 拒绝原因", body: `<div class="row" style="align-items:stretch;gap:12px;flex:1;min-height:0">${intentList}${intentDetail}</div>`, h: 940 });

// 移动端单卡(390×844,不画假状态栏)
const mobileCard = `
<div style="width:390px;height:844px;background:${C.bg};display:flex;flex-direction:column;padding-top:54px">
  <div class="row" style="padding:0 16px 10px;gap:8px"><span class="logo mono" style="width:22px;height:22px;font-size:10px">TG</span><span style="font-size:15px;font-weight:600">待批 1</span><span class="hint">Telegram 卡片同一口径</span><span style="margin-left:auto">${ring(0.94, "09:28", C.warn, 40)}</span></div>
  <div class="col" style="flex:1;padding:0 16px;gap:10px;overflow:hidden">
    <div class="card" style="padding:14px;display:flex;flex-direction:column;gap:10px">
      <div class="row" style="gap:6px;flex-wrap:wrap">${st("awaiting_approval")}${acct("sub")}${pill("model", "dim", { dot: false })}</div>
      <div class="row" style="gap:8px;align-items:baseline"><span class="num" style="font-size:22px;font-weight:600">BTCUSDT</span><span class="num up" style="font-size:15px;font-weight:600">buy</span><span class="num hint">open · limit</span></div>
      <div style="font-size:14px;line-height:1.45">4h 结构回踩支撑,量能收缩</div>
      <div class="row" style="gap:6px;flex-wrap:wrap">${pill("T7.E1", "ice", { dot: false })}${pill("T7.E3", "ice", { dot: false })}<span class="hint">失效:收盘跌破 58800</span></div>
    </div>
    <div class="card" style="padding:12px 14px">
      ${kv([["qty", "0.002 · 名义 120.00 USDT"], ["price", "60000.5 · gtc"], ["stop", "59000 · mark · close"], ["take_profit", "62000 · 50%"], ["leverage", "2 · isolated"], ["risk", "0.25% = 2.50 USDT"]], "font-size:13px;gap:6px 14px")}
    </div>
    <div class="card" style="padding:12px 14px;display:flex;flex-direction:column;gap:6px">
      <div class="row">${pill("gate 17 通过", "ok", { dot: false, mono: false })}<span class="hint">authority=draft → 需人批</span><span class="hint num" style="margin-left:auto">tools e3b0…b855</span></div>
      <div class="row" style="gap:6px"><span class="hint" style="white-space:nowrap">回填 8 字段</span><span class="num hint ell">plan_hash 474838…433c · symbol · side · qty · order_type · price · leverage · reduce_only</span></div>
    </div>
  </div>
  <div class="col" style="padding:12px 16px 24px;gap:10px;border-top:1px solid ${C.border};background:${C.side}">
    <div class="row" style="gap:8px">${meter(0.94, C.warn)}<span class="hint num">TTL 09:28</span></div>
    <div style="display:grid;grid-template-columns:1fr 2fr;gap:10px">
      <span class="btn dout" style="height:48px;font-size:14px">拒绝</span>
      <span class="btn pri" style="height:48px;font-size:14px">${ico("check", 15)}批准 · 474838…433c</span>
    </div>
  </div>
</div>`;
files["IntentCardMobile.dc.html"] = doc("移动端审批卡", mobileCard, { w: 390, h: 844 });

// ───────────────────────── 8. Activity / Trace 回放 ─────────────────────────
const EV_TONE = { "context.built": "mute", "model.called": "ice", "tool.called": "mute", "gate.evaluated": "ok", "intent.awaiting_approval": "warn", "intent.approved": "ok", "attempt.before_submit": "mute", "attempt.acked": "ok", "attempt.unknown": "live", "order.observed": "slate", "effect.evaluated": "ok" };
const traceRows = [
  ["19:53:18.020", "context.built", "8 段 · 3,912 tokens · evidence 6(T7.E1…E6)· 工具集固定 12 · prompt 前缀缓存命中", ""],
  ["19:53:18.110", "model.called", "deepseek-chat · turn 1/1 · in 3,912 / out 412 · 2.9 s · 0.006 RMB · 结构化输出 ok", ""],
  ["19:53:19.400", "tool.called", "market.features{BTCUSDT, 4h, lookback 120} → ok 120 ms · observed 19:53:10 · 注册为 T7.E1", ""],
  ["19:53:19.600", "tool.called", "account.truth → consistent · account_version a18c…c7ab · span 350 ms · 注册为 T7.E5", ""],
  ["19:53:20.000", "tool.called", "intent.propose{side buy, symbol BTCUSDT, stop_ref 59000, size_hint full, evidence [T7.E1, T7.E3], ttl 600}", ""],
  ["19:53:20.950", "gate.evaluated", "18 项 · 17 通过 · authority=draft → 需人批 · plan 7c9e6679 v1 物化(qty 0.002)", "open"],
  ["19:53:21.000", "intent.awaiting_approval", "seq 4181 · plan_hash 4748…433c · authorization_ttl 120 s · 已推 UI + Telegram", ""],
  ["19:55:00.000", "intent.approved", "by user · ws-conn:7f3a · confirm_echo 8 字段逐字一致 · authorization 16fd2706 · expires 19:57:00", ""],
  ["19:55:05.000", "attempt.before_submit", "tg-0f8fad5bd9cb-e0-1 · entry · fencing 7:execd-mba-2026 · order_fingerprint 已持久化(网络调用前 commit)", ""],
  ["19:55:05.480", "attempt.acked", "futures_place_order · exchange_order_id 8389765123456789 · 360 ms · authorization → consumed", ""],
  ["19:55:06.200", "order.observed", "partially_filled 0.001 / 0.002 @ 60000.5 · fill 557711223 maker · commission 0.01200010 USDT", ""],
  ["19:55:06.520", "attempt.unknown", "stop 腿 tg-0f8fad5bd9cb-s0-1 · MCP tools/call 超时 20 s · transport_ambiguous → 按 clientOrderId 对账,不盲重放", ""],
  ["19:55:08.000", "order.observed", "stop_market 8389765123456790 new(reconciled_found)· 保护腿确认在交易所 · naked 2 s ≤ 20", ""],
  ["19:55:10.000", "effect.evaluated", "pending · filled 0.001 / 0.002 · protection_confirmed · 剩余 0.001 待成交 → completed 需目标数量成交且剩余已撤", ""],
];
const gateDetail = `<div class="card" style="margin:6px 0 4px 122px;padding:10px 12px;background:${C.bg}">${gateGrid(GATES, 3)}<div class="row" style="gap:8px;margin-top:8px"><span class="hint">plan 物化:</span><span class="num hint">risk 0.25% × 1000 = 2.5 USDT · stop_distance 1000.5 · raw_qty 0.0024987 → 0.002 · filters observed 19:53:10</span></div></div>`;
const runs = pane(
  "runs",
  "runs.list",
  `<div class="list">
    <div class="li sel" style="flex-direction:column;align-items:stretch;gap:3px;padding:8px 10px"><div class="row"><span class="num" style="font-weight:600">run-20260902-0001</span><span style="margin-left:auto">${pill("settled", "ok")}</span></div><span class="hint">recipe · w4-judgment · deepseek-chat · 1 turn · 19:53:18 → 19:53:21</span><span class="hint num">1 intent · 3 tools · 4,324 tokens · 0.006 RMB</span></div>
    <div class="li" style="flex-direction:column;align-items:stretch;gap:3px;padding:8px 10px"><div class="row"><span class="num">run-20260902-0000</span><span style="margin-left:auto">${pill("settled", "mute")}</span></div><span class="hint">heartbeat · 指纹未变 → NO_REPLY · 0 token</span><span class="hint num">19:45:00 · 0 intent</span></div>
    <div class="li" style="flex-direction:column;align-items:stretch;gap:3px;padding:8px 10px"><div class="row"><span class="num">run-20260901-0042</span><span style="margin-left:auto">${pill("capped", "warn")}</span></div><span class="hint">chat · claude-cli · 8/8 turns · fail-closed:未完成 intent 不提交</span><span class="hint num">09-01 22:03 · 0 intent</span></div>
    <div class="li" style="flex-direction:column;align-items:stretch;gap:3px;padding:8px 10px"><div class="row"><span class="num">run-20260901-0041</span><span style="margin-left:auto">${pill("aborted", "bad")}</span></div><span class="hint">recipe · w4-judgment · 429 RATE_LIMITED → 不重试</span><span class="hint num">09-01 21:30</span></div>
  </div>`,
  { style: "width:300px;flex:none" },
);
const trace = pane(
  `<span class="num">run-20260902-0001</span> · trace 回放`,
  "runs.inspect · trace_events + execd events(exec_seq 对齐)· 19:53:18 → 19:55:10",
  `<div class="list">${traceRows
    .map(([t, ev, sum, open]) => `<div class="col" style="gap:0;border-bottom:1px solid ${C.line}"><div class="row" style="padding:6px 12px;gap:10px"><span class="num hint" style="width:100px;flex:none">${t}</span><span style="width:190px;flex:none">${pill(ev, EV_TONE[ev] ?? "mute")}</span><span class="ell" style="flex:1;${ev === "attempt.unknown" ? `color:${C.live}` : ""}">${sum}</span>${ico(open ? "chevD" : "chevR", 13, C.mutedFg)}</div>${open ? gateDetail : ""}</div>`)
    .join("")}</div>`,
  { style: "flex:1", actions: `${btn("复制 trace", "ghost", { size: "xs", icon: "copy" })}${btn("导出 JSON", "ghost", { size: "xs" })}` },
);
files["Activity.dc.html"] = page({ id: "activity", title: "活动", sub: "Activity · 一次 run 的事件时间线", body: `<div class="row" style="align-items:stretch;gap:12px;flex:1;min-height:0">${runs}${trace}</div>` });

// ───────────────────────── 9. Policy & 紧急停 ─────────────────────────
const optCard = (label, desc, { on = false, tone = "mute", disabled = false, tag = "" } = {}) =>
  `<div class="card" style="padding:10px 12px;display:flex;flex-direction:column;gap:4px;min-width:0;${on ? `border-color:${tone === "live" ? C.live : tone === "warn" ? C.warn : C.ice};box-shadow:inset 0 0 0 1px ${tone === "live" ? C.live : tone === "warn" ? C.warn : C.ice}` : ""}${disabled ? "opacity:0.45" : ""}">
    <div class="row" style="gap:6px"><span class="num" style="font-weight:600;font-size:13px">${label}</span>${on ? pill("当前", tone === "mute" ? "ice" : tone, { dot: false, mono: false }) : ""}${tag ? `<span class="hint" style="margin-left:auto">${tag}</span>` : ""}</div>
    <span class="note" style="white-space:normal">${desc}</span></div>`;
const CAPS = [
  ["max_leverage", "2", "2", "杠杆上限"], ["risk_pct_per_trade", "0.25%", "0.25%", "单笔风险(反推 qty)"], ["max_order_notional", "200", "150", "单笔名义 USDT"], ["max_position_notional", "400", "150", "单仓名义 USDT"],
  ["max_daily_opens", "2", "2", "日开仓(金丝雀 2→6)"], ["daily_loss_stop_pct", "1%", "1%", "日亏断路器"], ["symbol_cooldown_seconds", "3600", "3600", "同 symbol 冷却"], ["max_naked_seconds", "20", "20", "裸奔上限 → 补偿平仓"],
  ["account_truth_max_age_ms", "15000", "15000", "账户真相新鲜度"], ["market_max_age_ms", "5000", "5000", "行情新鲜度"], ["authorization_ttl_market_seconds", "30", "30", "市价授权 TTL"], ["authorization_ttl_limit_seconds", "120", "120", "限价授权 TTL"],
  ["max_price_deviation_bps", "55", "55", "下单价 vs 现价"], ["ntp_drift_block_ms", "2000", "2000", "> 即禁新增风险"], ["ntp_drift_halt_ms", "10000", "10000", "> 即 HALT"],
];
const policyPage = () => {
  const band = `<div class="ws" style="flex:none;flex-direction:row;align-items:center;gap:16px;padding:14px 16px;border-color:rgba(226,73,71,0.45)">
    <span class="btn danger" style="height:56px;padding:0 22px;font-size:15px;font-weight:700;border-radius:8px;box-shadow:0 0 0 4px rgba(226,73,71,0.18)">${ico("stop", 20, "#fff")}紧急停止 · HALT_ALL</span>
    <div class="col" style="gap:3px;flex:1"><span style="font-size:13px;font-weight:600">policy.emergencyStop · 需 operator.admin · 二次确认输入 HALT</span><span class="note">= mode → halt_all · emergency_stop = true · 所有 active 授权 → revoked(emergency_stop)· 拒绝一切新提议 · 事件 policy.halted 带外告警(Telegram)。双紧急停:这里 + Binance 端 revoke。</span></div>
    <div class="card" style="padding:8px 12px;max-width:380px;background:${C.bg}"><div class="row" style="gap:6px;margin-bottom:2px">${pill("EmergencyReduce 常开", "ok", { dot: false, mono: false })}<span class="hint">不是等级,是能力</span></div><span class="note">撤单 / 减仓 / 平仓 / 补保护腿在事故策略下自动执行;永不增加敞口、永不移除保护、永不翻仓;不随 authority 降级或 token 预算耗尽而失效。</span></div>
    <span class="col" style="align-items:flex-end;gap:2px">${pill("未触发", "ok")}<span class="hint num">上次 08-31 14:02 · 手动解除</span></span>
  </div>`;
  const modes = pane(
    "mode 四档",
    "gate v2 第一项 · 只能收紧执行,不改经济字段",
    `<div style="display:grid;grid-template-columns:repeat(4, minmax(0, 1fr));gap:10px;padding:12px">
      ${optCard("run", "正常:提议 → 闸 → 审批 → 执行", { on: true })}
      ${optCard("stop_opening", "不再开新仓;平仓、保护、撤单照常")}
      ${optCard("flatten_only", "只允许 reduce_only:减仓 / 平仓 / 保护腿", { tone: "warn" })}
      ${optCard("halt_all", "拒绝一切新提议(含 cancel_order);只剩 EmergencyReduce", { tone: "live" })}
    </div>`,
    { style: "flex:none" },
  );
  const authority = pane(
    "authority 四档",
    "物理能力墙(ActorContext + Binance scope),不是 prompt",
    `<div style="display:grid;grid-template-columns:repeat(4, minmax(0, 1fr));gap:10px;padding:12px">
      ${optCard("observe", "只读 scope;intent 只落库(recorded)。上线默认", { tag: "P1" })}
      ${optCard("draft", "+ intent 进 awaiting_approval(TTL 120 s,UI / TG 卡片),人批才执行", { on: true, tag: "P1" })}
      ${optCard("paper", "+ PaperExchange 本地撮合(费用 / 资金费 / 滑点);只验证策略,不验证执行链", { tag: "P2 · ≥ 4 周" })}
      ${optCard("live_capped", "上限内自动批,超限回落 draft。feature-gate 关闭,直到 Binance 对 standing authorization 有书面口径", { disabled: true, tag: "待 Q6" })}
    </div>
    <div class="row" style="padding:0 12px 12px;gap:8px"><span class="lbl">拨盘(LiveCapped 内)</span>${pill("close = auto", "ok", { dot: false })}${pill("agent_open = copilot", "dim", { dot: false })}${pill("strategy_open = capped", "dim", { dot: false })}<span class="hint">审批 ≠ 免检:派发前重闸只能拒绝</span></div>`,
    { style: "flex:none" },
  );
  const pending = pane(
    "待应用改动",
    "policy.set · 需 operator.admin + confirm 字段逐字回填 · gate 热读 kv,无需重启",
    `<div class="col" style="padding:12px;gap:10px">
      <div class="row" style="gap:10px"><span class="num hint" style="width:200px">caps.max_daily_opens</span><span class="num">2</span>${ico("arrowR", 13, C.mutedFg)}<span class="num" style="font-weight:600">3</span><span class="hint">version 3 → 4 · 事件 policy.changed</span></div>
      <div class="row" style="gap:10px"><span class="num hint" style="width:200px">symbol_allowlist</span><span class="num">BTCUSDT, ETHUSDT</span>${ico("arrowR", 13, C.mutedFg)}<span class="num" style="font-weight:600">+ SOLUSDT</span><span class="hint">新 symbol 需先回填 K 线 90 天</span></div>
      <div class="row" style="gap:10px;align-items:flex-end"><div class="field" style="flex:1"><span class="lbl">回填确认字段(逐字):mode · authority · 改动键=新值</span><div class="inp num">mode=run authority=draft caps.max_daily_opens=3 symbol_allowlist=BTCUSDT,ETHUSDT,SOLUSDT</div></div>${btn("应用改动(admin)", "pri", { icon: "check" })}${btn("放弃", "ghost")}</div>
    </div>`,
    { style: "flex:1" },
  );
  const caps = pane(
    "上限表 caps",
    "policy v3 · 显式输入,不静默继承",
    `${table([{ h: "键" }, { h: "当前", r: true, num: true }, { h: "金丝雀", r: true, num: true }, { h: "说明" }], CAPS.map(([k, v, c, d]) => [`<span class="num">${k}</span>`, v, `<span class="hint">${c}</span>`, `<span class="hint">${d}</span>`]), { dense: true })}
     <div class="row" style="padding:8px 12px;gap:6px;border-top:1px solid ${C.line};flex-wrap:wrap"><span class="lbl">白名单</span>${pill("BTCUSDT", "mute", { dot: false })}${pill("ETHUSDT", "mute", { dot: false })}${pill("usdm_perp", "slate", { dot: false })}<span class="lbl" style="margin-left:8px">main_account</span>${pill("manual_trading true", "ok", { dot: false })}${pill("transfers true", "ok", { dot: false })}${pill("withdraw false", "dim", { dot: false })}</div>`,
    { style: "flex:1" },
  );
  return `${band}<div style="display:grid;grid-template-columns:minmax(0,1fr) 540px;gap:12px;flex:1;min-height:0"><div class="col" style="gap:12px">${modes}${authority}${pending}</div><div class="col" style="gap:12px">${caps}</div></div>`;
};
files["Policy.dc.html"] = page({ id: "policy", title: "风控", sub: "Policy · mode / authority / caps · 紧急停", body: policyPage() });

const stopDialog = `
<div style="width:520px;height:520px;background:${C.bg};display:flex;align-items:center;justify-content:center;padding:20px">
  <div class="card" style="width:480px;background:${C.pop};border-color:rgba(226,73,71,0.5);box-shadow:0 20px 60px rgba(0,0,0,0.6);display:flex;flex-direction:column">
    <div class="col" style="padding:16px 18px 12px;gap:6px;border-bottom:1px solid ${C.border}">
      <div class="row" style="gap:8px">${ico("stop", 18, C.live)}<span style="font-size:15px;font-weight:700;color:${C.live}">确认紧急停止</span><span style="margin-left:auto">${pill("operator.admin", "dim", { dot: false })}</span></div>
      <span class="note">立即生效,事件 policy.halted 会同时推 UI 与 Telegram。解除需 admin 且逐字回填 mode=run。</span>
    </div>
    <div class="col" style="padding:12px 18px;gap:8px">
      ${[["mode", "run → halt_all"], ["emergency_stop", "false → true"], ["active 授权", "2 条 → revoked(emergency_stop)"], ["新提议", "全部 gate 拒绝(含 cancel_order)"], ["保留", "已确认的保护腿 · EmergencyReduce · 手动 reduce_only"]].map(([k, v]) => `<div class="row" style="height:28px;border-bottom:1px solid ${C.line}"><span class="num hint" style="width:120px">${k}</span><span class="num">${v}</span></div>`).join("")}
      <div class="field" style="margin-top:6px"><span class="lbl">输入 HALT 确认</span><div class="inp num" style="height:36px;font-size:14px">HAL<span style="width:1px;height:16px;background:${C.fg};margin-left:1px"></span></div></div>
    </div>
    <div class="row" style="padding:12px 18px;border-top:1px solid ${C.border};gap:8px;justify-content:flex-end">${btn("取消", "ghost", { size: "lg" })}${btn("立即停止", "danger", { size: "lg", icon: "stop", extra: "dis" })}</div>
  </div>
</div>`;
files["EmergencyStop.dc.html"] = doc("紧急停止确认", stopDialog, { w: 520, h: 520 });

// ───────────────────────── 10. Chart(最小 K 线) ─────────────────────────
const chartSvg = () => {
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const N = 64;
  const path = (i) => (i < 12 ? 61600 + i * 55 : i < 48 ? 62260 - (i - 12) * 80.8 : 59350 + (i - 48) * 43);
  const bars = []; let p = 61550;
  for (let i = 0; i < N; i++) {
    const o = p, c = path(i) + (rnd() - 0.5) * 240;
    const h = Math.max(o, c) + rnd() * 170, l = Math.min(o, c) - rnd() * 170;
    const v = (i < 48 ? 0.55 + rnd() * 0.45 : 0.22 + rnd() * 0.26) * (1 + Math.abs(c - o) / 220);
    bars.push({ o, h, l, c, v }); p = c;
  }
  const W = 896, AX = 64, PT = 16, PH = 500, VT = 540, VH = 130, XT = 690;
  const plotW = W - AX, step = plotW / N, bw = Math.max(6, step - 5);
  const yMin = 58500, yMax = 62800, y = (v) => PT + (yMax - v) / (yMax - yMin) * PH;
  const vMax = Math.max(...bars.map((b) => b.v)), yv = (v) => VT + VH - (v / vMax) * VH;
  let s = `<svg width="${W}" height="720" viewBox="0 0 ${W} 720" style="display:block;font-family:'JetBrains Mono','SF Mono',ui-monospace,Menlo,monospace" aria-label="BTCUSDT 4h">`;
  for (let v = 58500; v <= 62500; v += 500) s += `<line x1="0" x2="${plotW}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${C.chartGrid}"/><text x="${plotW + 8}" y="${(y(v) + 3.5).toFixed(1)}" fill="${C.chartText}" font-size="10.5">${v.toLocaleString("en-US")}</text>`;
  const zoneT = y(59400), zoneB = y(58800);
  s += `<rect x="0" y="${zoneT.toFixed(1)}" width="${plotW}" height="${(zoneB - zoneT).toFixed(1)}" fill="${C.support}" fill-opacity="0.12" stroke="${C.support}" stroke-opacity="0.72" stroke-width="1"/><text x="8" y="${(zoneT + 13).toFixed(1)}" fill="${C.support}" fill-opacity="0.78" font-size="10.5">支撑 4h 58,800–59,400 · confirmed · T7.E1</text>`;
  const rY = y(62400);
  s += `<line x1="0" x2="${plotW}" y1="${rY.toFixed(1)}" y2="${rY.toFixed(1)}" stroke="${C.resistance}" stroke-opacity="0.55" stroke-width="1.5" stroke-dasharray="6 4"/><text x="8" y="${(rY - 5).toFixed(1)}" fill="${C.resistance}" fill-opacity="0.55" font-size="10.5">阻力 62,400 · tentative · T7.E3</text>`;
  const dates = ["08-23", "08-25", "08-27", "08-29", "08-31", "09-02"];
  dates.forEach((d, i) => { const gx = i * 12 * step + step / 2, x = Math.max(24, gx); s += `<line x1="${gx.toFixed(1)}" x2="${gx.toFixed(1)}" y1="${PT}" y2="${VT + VH}" stroke="${C.chartGrid}"/><text x="${x.toFixed(1)}" y="${XT}" fill="${C.chartText}" font-size="10.5" text-anchor="middle">${d}</text>`; });
  bars.forEach((b, i) => {
    const x = i * step + step / 2, up = b.c >= b.o, col = up ? C.candleUp : C.candleDown;
    const top = y(Math.max(b.o, b.c)), bot = y(Math.min(b.o, b.c));
    s += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y(b.h).toFixed(1)}" y2="${y(b.l).toFixed(1)}" stroke="${col}" stroke-width="1"/><rect x="${(x - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, bot - top).toFixed(1)}" fill="${col}"/>`;
    s += `<rect x="${(x - bw / 2).toFixed(1)}" y="${yv(b.v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(VT + VH - yv(b.v)).toFixed(1)}" fill="${col}" fill-opacity="0.55"/>`;
  });
  const hh = bars.slice(8, 16).reduce((m, b) => Math.max(m, b.h), 0), hhI = 8 + bars.slice(8, 16).findIndex((b) => b.h === hh);
  const hl = bars.slice(44, 52).reduce((m, b) => Math.min(m, b.l), 1e9), hlI = 44 + bars.slice(44, 52).findIndex((b) => b.l === hl);
  s += `<text x="${(hhI * step + step / 2).toFixed(1)}" y="${(y(hh) - 6).toFixed(1)}" fill="${C.structure}" font-size="10.5" text-anchor="middle">HH ${Math.round(hh).toLocaleString("en-US")}</text>`;
  s += `<text x="${(hlI * step - 6).toFixed(1)}" y="${(y(hl) + 4).toFixed(1)}" fill="${C.structure}" font-size="10.5" text-anchor="end">HL ${Math.round(hl).toLocaleString("en-US")} · 结构确认</text>`;
  const lvl = (v, col, dash, label, opacity = 0.9) => {
    const yy = y(v);
    s += `<line x1="0" x2="${plotW}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="${col}" stroke-opacity="${opacity}" stroke-width="1.5"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
    s += `<rect x="${plotW + 2}" y="${(yy - 9).toFixed(1)}" width="${AX - 4}" height="18" rx="3" fill="${col}"/><text x="${plotW + AX / 2}" y="${(yy + 3.5).toFixed(1)}" fill="#041119" font-size="10.5" font-weight="600" text-anchor="middle">${v.toLocaleString("en-US", { maximumFractionDigits: 1 })}</text>`;
    s += `<text x="${plotW - 8}" y="${(yy - 5).toFixed(1)}" fill="${col}" font-size="10.5" text-anchor="end">${label}</text>`;
  };
  lvl(62000, C.candleUp, "6 4", "TP 62000 · tp_market · 50%");
  lvl(60000.5, C.ice, "", "entry limit 60000.5 · 待批");
  lvl(59000, C.candleDown, "6 4", "SL 59000 · stop_market · mark");
  const last = bars[N - 1];
  s += `<text x="8" y="${VT + 12}" fill="${C.chartText}" font-size="10.5">Volume · 量能比 0.62(收缩)</text><text x="8" y="${PT + 12}" fill="${C.chartText}" font-size="10.5">BTCUSDT · 4h · O ${Math.round(last.o)} H ${Math.round(last.h)} L ${Math.round(last.l)} C ${Math.round(last.c)}</text>`;
  s += `</svg>`;
  return s;
};
const chartPage = () => {
  const toolbar = `<div class="row" style="height:36px;padding:0 10px;gap:12px;border-bottom:1px solid ${C.line};white-space:nowrap">
    <span class="row" style="gap:6px;flex:none">${ico("candle", 14, C.mutedFg)}<span class="num" style="font-weight:600;font-size:13px">BTCUSDT</span><span class="hint">usdm_perp</span></span>
    <span class="seg"><span>15m</span><span>1h</span><span class="on">4h</span><span>1d</span></span>
    <span class="seg"><span>EMA20</span><span>EMA50</span><span>VWAP</span></span>
    <span class="row" style="gap:4px;flex:none">${ico("pen", 13, C.mutedFg)}<span class="hint" style="margin-right:4px">绘图</span>${btn("水平线", "ghost", { size: "xs" })}${btn("区间", "ghost", { size: "xs" })}${btn("趋势线", "ghost", { size: "xs" })}</span>
    <span class="hint num" style="margin-left:auto;flex:none">market.klines · 最新 19:53:19 · staleness 1 s</span></div>`;
  const chart = `<div class="ws" style="flex:1">${toolbar}<div style="padding:4px 0 0 6px;flex:1;min-height:0;overflow:hidden">${chartSvg()}</div>
    <div class="row" style="height:30px;padding:0 10px;gap:12px;border-top:1px solid ${C.line};white-space:nowrap"><span class="hint" style="flex:none">role 调色</span>${["support", "resistance", "trend", "volumeNode", "structure"].map((r) => `<span class="row" style="gap:4px;flex:none"><span style="width:12px;height:3px;border-radius:2px;background:${C[r]}"></span><span class="hint num">${r}</span></span>`).join("")}<span class="vsep"></span><span class="hint" style="flex:none">状态</span><span class="row" style="gap:6px;flex:none"><span style="width:22px;height:0;border-top:1.5px solid ${C.support}"></span><span class="hint">confirmed 实线 78%</span></span><span class="row" style="gap:6px;flex:none"><span style="width:22px;height:0;border-top:1.5px dashed ${C.resistance}"></span><span class="hint">tentative 虚线 55%</span></span><span class="row" style="gap:6px;flex:none"><span style="width:22px;height:0;border-top:1.5px dotted ${C.trend};opacity:0.4"></span><span class="hint">invalidated 点线 28%</span></span><span class="hint" style="margin-left:auto;flex:none">agent 画线 = drawing.create(role, state)</span></div></div>`;
  const side = `<div class="col" style="width:340px;flex:none;gap:12px">
    ${pane("当前 intent", "右栏与 Chat 页同一张卡", `<div class="col" style="padding:12px;gap:10px">
      <div class="row" style="gap:6px;flex-wrap:wrap">${st("awaiting_approval")}${acct("sub")}<span style="margin-left:auto">${ring(0.94, "09:28", C.warn, 40)}</span></div>
      <div class="row" style="gap:8px;align-items:baseline"><span class="num" style="font-size:18px;font-weight:600">BTCUSDT</span><span class="num up" style="font-weight:600">buy</span><span class="num hint">open · limit 60000.5</span></div>
      <div style="font-size:13px">4h 结构回踩支撑,量能收缩</div>
      ${kv([["qty", "0.002 · 名义 120.00"], ["stop / tp", "59000 · 62000(50%)"], ["risk", "0.25% = 2.50 USDT · RR 2.0"], ["invalidation", "收盘跌破 58800"]])}
      <div class="row" style="gap:8px">${btn("拒绝", "dout", { size: "xs" })}${btn("批准 4748…433c", "pri", { size: "xs", icon: "check" })}<span class="hint" style="margin-left:auto">去审批页</span></div></div>`, { style: "flex:none" })}
    ${pane("证据", "Evidence Registry · 每条 read 结果都带 observed_at / source / staleness", `<div class="list">
      ${[["T7.E1", "market.features BTCUSDT 4h", "swing_low 59,350 · range 58.8k–62.4k · vol_ratio 0.62 · ATR14 640", "19:53:10 · 10 s"], ["T7.E3", "market.structure BTCUSDT 4h", "HL 确认 · BOS 上方 62,400 · trend 4h up(tentative)", "19:53:10 · 10 s"], ["T7.E5", "account.truth", "sub consistent · 可用 900 · 今日开仓 0/2", "19:53:20 · 0.4 s"], ["T7.E6", "policy.get", "v3 · draft · 单笔名义 ≤ 200", "19:53:20 · 0 s"]]
        .map(([ref, tool, sum, t]) => `<div class="col" style="gap:2px;padding:8px 12px;border-bottom:1px solid ${C.line}"><div class="row" style="gap:6px">${pill(ref, "ice", { dot: false })}<span class="num hint">${tool}</span><span class="hint num" style="margin-left:auto">${t}</span></div><span style="font-size:12px">${sum}</span></div>`).join("")}
    </div>`, { style: "flex:1" })}
  </div>`;
  return `<div class="row" style="align-items:stretch;gap:12px;flex:1;min-height:0">${chart}${side}</div>`;
};
files["Chart.dc.html"] = page({ id: "chart", title: "图表", sub: "Chart · 最小 K 线 · lightweight-charts 风格", body: chartPage() });

// ───────────────────────── canvas.json ─────────────────────────
const X = [0, 1520, 3040], Y = [0, 1120, 2240, 3360, 4480];
const AB = (file, col, row, w = 1440, h = 900, title) => ({ file, x: X[col], y: Y[row], w, h, ...(title ? { title } : {}) });
const NOTE = (id, col, row, text, w = 560, dx = 0) => ({ id, x: X[col] + dx, y: Y[row] - 168, w, text });
const canvas = {
  artboards: [
    AB("Main.dc.html", 0, 0, 1440, 900, "1 Dashboard 总览"),
    AB("Chart.dc.html", 1, 0, 1440, 900, "10 Chart 最小 K 线"),
    AB("Portfolio.dc.html", 2, 0, 1440, 900, "4 Portfolio 主+子合并"),
    AB("OnboardingOAuth.dc.html", 0, 1, 1440, 900, "2a 向导 · 第 4 步 等待回调"),
    AB("OnboardingOAuthDone.dc.html", 1, 1, 1440, 900, "2b 向导 · 第 4 步 授权结果"),
    AB("OnboardingMainKey.dc.html", 2, 1, 1440, 900, "2c 向导 · 4b 主账户 API key"),
    AB("Exchange.dc.html", 0, 2, 1440, 900, "3 Exchange 两通道健康"),
    AB("Policy.dc.html", 1, 2, 1440, 900, "9 Policy & 紧急停"),
    AB("EmergencyStop.dc.html", 2, 2, 520, 520, "9b 紧急停二次确认"),
    AB("Trade.dc.html", 0, 3, 1440, 900, "5 Trade 主账户手动下单"),
    AB("TradeConfirm.dc.html", 1, 3, 520, 760, "5b 结构化确认弹层"),
    AB("Funding.dc.html", 2, 3, 1440, 900, "6 Funding 划转 / 提币深链"),
    AB("Intents.dc.html", 0, 4, 1440, 940, "7 Intents 审批卡"),
    AB("IntentCardMobile.dc.html", 1, 4, 390, 844, "7b 移动端审批卡"),
    AB("Activity.dc.html", 2, 4, 1440, 900, "8 Activity trace 回放"),
  ],
  annotations: [
    { id: "cover", x: 0, y: -420, w: 900, text: "trade-gate WebUI · A3 最小 UI 设计稿 v1 · 2026-09-02\n每个画板 = 一页(桌面 1440 宽),小画板 = 组件 1:1 / 移动端。示例数据全部取自 packages/contracts/fixtures(intent / plan / authorization / account_snapshot / policy / events / attempt / exchange_order / position_effect / fill),状态枚举保留英文小写。\n气质借 8794 shadcn 变体「Graphite & Ice」:三层暗色地面、冰青只给界面 chrome、绿红只表达多空、数字全部等宽;两账户用固定视觉约定区分:main · REST = 石板灰 chip,sub · MCP = 冰青 chip。\n行 1 交易台 · 行 2 向导 · 行 3 系统 · 行 4 主账户动钱 · 行 5 agent 动钱与回放" },
    NOTE("n-dashboard", 0, 0, "Dashboard\nRPC:account.truth(两账户合并)· intents.list · strategies.list(attention 桶)· exchange.status · policy.get · usage.summary\n事件:account.updated|stale · intent.* · strategy.attention · exchange.auth.* · health · usage"),
    NOTE("n-chart", 1, 0, "Chart\nRPC:market.klines / market.subscribe(4h 收盘)· market.features / market.structure(证据)· intents.get · drawing.create/update/remove(role, state)\n事件:market.kline · market.tick · intent.*\n画线颜色 = 8794 frontend-shared/drawing/palette.ts 的 role 调色(support 蓝 / resistance 琥珀 / trend 品红 / volumeNode·structure 无彩),状态用虚实与透明度编码,不用色相"),
    NOTE("n-portfolio", 2, 0, "Portfolio\nRPC:account.truth(AccountSnapshot:每组件 observed_at / fetched_from-to / completeness / source;consistency = consistent | inconsistent | unavailable;account_version)· orders.list · positions.list\n事件:account.updated|stale · order.* · position.*\n订单 origin:tg- 前缀 = local,ts_ / 其他 = foreign(开仓前强制对账)"),
    NOTE("n-oauth", 0, 1, "向导 第 4 步(等待回调)\nRPC:wizard.start/next/status · exchange.oauth.start(启动回环回调 :18801,PKCE)→ 浏览器 → GET /oauth/callback(只在向导期间监听)\n事件:exchange.auth.pending · tick"),
    NOTE("n-oauth-done", 1, 1, "向导 第 4 步(授权结果)\nRPC:exchange.oauth.complete · exchange.tools.snapshot(tools/list 钉版 → tools_hash)· account.truth(子账户余额)\n事件:exchange.auth.granted · exchange.tools.snapshot"),
    NOTE("n-mainkey", 2, 1, "向导 4b 主账户 API key\nRPC:wizard.next{apiKey, secret}(只到 execd,落盘 secrets/apikey-main.json 0600)· execd 权限探测(读 / 合约 / 子账户划转 / 提币 / IP 白名单)· sub-account/list · sub-account/assets · universalTransfer dry-run(§3.5 三件事)\n事件:exchange.credentials.probed"),
    NOTE("n-exchange", 0, 2, "Exchange\nRPC:exchange.status(key 指纹 / 权限位 / 用户数据流 / 时钟偏移 / RestGate;OAuth fresh|expiring|expired|revoked / MCP 会话 / tools_hash vs 钉版 / 子账户标识)· exchange.oauth.start/complete/revoke · exchange.tools.snapshot\n事件:exchange.auth.* · exchange.tools.drift · health"),
    NOTE("n-policy", 1, 2, "Policy & 紧急停\nRPC:policy.get · policy.set(admin + confirm 字段逐字回填)· policy.emergencyStop(admin,输入 HALT)\n事件:policy.changed · policy.halted\nlive_capped 灰掉:feature-gate 关闭直到 Q6(Binance 对 standing authorization 的口径)"),
    NOTE("n-stop", 2, 2, "紧急停二次确认(组件 1:1)\npolicy.emergencyStop → mode halt_all + emergency_stop=true + 所有 active 授权 revoked(emergency_stop);EmergencyReduce 与已确认保护腿保留", 480),
    NOTE("n-trade", 0, 3, "Trade(主账户手动下单,经 execd)\nRPC:tools.invoke intent.propose{kind open|close, account main}(principal=user, surface=rpc, origin ui:trade-page)→ exec.plan.materialize(预览)→ intents.approve{confirm_echo}\n事件:intent.awaiting_approval → intent.approved → attempt.before_submit/acked|unknown → order.observed → effect.evaluated;状态 dispatching → executing → completed / execution_unknown(对账中禁新增敞口)"),
    NOTE("n-confirm", 1, 3, "结构化确认弹层(组件 1:1)\nconfirm_fields(tables/confirm_fields.json)kind=order:symbol · side · qty · order_type · price · trigger_price(缺省不出现)· leverage · reduce_only + 永远回填 plan_hash;execd exec.intent.authorize 逐字比对,任何差异 → conflict(1006)\nTTL:market 30 s · limit 120 s", 480),
    NOTE("n-funding", 2, 3, "Funding\nRPC:tools.invoke intent.propose{kind transfer, asset, amount, from_account/from_wallet, to_account/to_wallet}(principal=user)→ intents.approve{confirm_echo: asset · amount · from_account · to_account · plan_hash}· account.history\n事件:intent.* · attempt.*(leg transfer,clientOrderId tg-…-f0-1)\n提币 = 打开 Binance 深链(Q7 默认不做一键提币)"),
    NOTE("n-intents", 0, 4, "Intents\nRPC:intents.list{status} · intents.get(Intent + ExecutableOrderPlan + gate_rejections)· intents.approve{plan_hash, confirm_echo}(超上限需 admin)· intents.reject · intents.expire\n事件:intent.created/gated/awaiting_approval/approved/rejected/expired/submitted/reconciled\n11 种状态徽章:proposed · awaiting_approval · authorized · recorded · dispatching · execution_unknown · executing · completed · canceled · expired · rejected"),
    NOTE("n-mobile", 1, 4, "移动端审批卡(390 宽)\n与 Telegram 卡片同一口径:thesis / evidence_refs / plan 经济字段 / gate 摘要 / TTL / 回填 8 字段;按钮 ≥ 44px", 420),
    NOTE("n-activity", 2, 4, "Activity / Trace 回放\nRPC:runs.list · runs.inspect(trace_events + tool_calls + llm_usage,与 execd events 按 exec_seq 对齐)· logs.tail\n时间线:context.built → model.called → tool.called → gate.evaluated → intent.* → attempt.* → order.observed → effect.evaluated"),
  ],
  launch: { view: "canvas" },
};

for (const [name, html] of Object.entries(files)) writeFileSync(join(OUT, name), html);
writeFileSync(join(OUT, "canvas.json"), JSON.stringify(canvas, null, 2) + "\n");
console.log(`wrote ${Object.keys(files).length} artboards + canvas.json → ${OUT}`);
