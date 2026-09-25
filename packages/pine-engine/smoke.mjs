/**
 * 真机冒烟(可选,手动跑):`npm run smoke -w @trading-swarm/pine-engine`
 * 默认自己用 launch.js 起一个沙箱引擎(临时端口),跑完收掉;给了 PINE_ENGINE_URL 就打那个现成的引擎
 * (比如网关托管的那个,端口看 GET /api/research/pine/health)。
 * 用合成 K 线跑一段 RSI + EMA 脚本,核对:
 *   1) /health 通;
 *   2) 每条 plot 与 K 线等长;
 *   3) 前导 null 段(实测预热)符合 RSI(14) 的预期量级;
 *   4) 因果抽样:前缀跑与全量跑在同一根上一致(这正是准入门 admission.ts 的判据)。
 * 单元测试不依赖它(gateway 侧 test/demo/research/pine/engine-sandbox.test.ts 有真引擎测试)。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let engine = null;
let URL_BASE = process.env.PINE_ENGINE_URL;
if (!URL_BASE) {
    engine = spawn(process.execPath, [fileURLToPath(new URL('./launch.js', import.meta.url))], { stdio: ['ignore', 'pipe', 'inherit'] });
    const port = await new Promise((resolve, reject) => {
        let buf = '';
        engine.stdout.on('data', (c) => { buf += c; const line = buf.split('\n').find((l) => l.startsWith('{')); if (line) resolve(JSON.parse(line).port); });
        engine.on('exit', (code) => reject(new Error(`引擎启动失败 exit ${code}`)));
    });
    URL_BASE = `http://127.0.0.1:${port}`;
}
process.on('exit', () => engine?.kill());

const SCRIPT = `//@version=5
indicator("smoke", overlay=false)
length = input.int(14, "length")
r = ta.rsi(close, length)
plot(r, "rsi")
plot(ta.ema(close, 20), "ema20")
`;

function bars(count = 240, stepMs = 3600000, t0 = Date.UTC(2025, 0, 1)) {
    let price = 100;
    return Array.from({ length: count }, (_, i) => {
        const open = price;
        price = Math.max(20, price + Math.sin(i / 11) * 1.4 + (i % 23 === 0 ? -6 : 0.35));
        return {
            time: Math.floor((t0 + i * stepMs) / 1000),
            open, high: Math.max(open, price) + 0.4, low: Math.min(open, price) - 0.4,
            close: price, volume: i % 7 === 0 ? 220 : 100 + (i % 13) * 3,
        };
    });
}

async function run(candles) {
    const res = await fetch(`${URL_BASE}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: SCRIPT, candles, symbol: 'TEST-USDT', interval: '1h' }),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(`脚本失败:${body.error}\n${body.detail ?? ''}`);
    return body;
}

const leading = (row) => { const at = row.findIndex((v) => v !== null); return at === -1 ? row.length : at; };

const health = await fetch(`${URL_BASE}/health`).then((r) => r.json()).catch((e) => { throw new Error(`引擎连不上(${URL_BASE}):${e.message}`); });
console.log('health:', health);

const candles = bars();
const full = await run(candles);
const names = Object.keys(full.series);
console.log('outputs:', names.join('、'), '| bars:', full.bars);
for (const name of names) {
    const row = full.series[name];
    if (row.length !== candles.length) throw new Error(`${name} 长度 ${row.length} ≠ K 线 ${candles.length}`);
    console.log(`  ${name}: 预热 ${leading(row)} 根, 末值 ${row.at(-1)}`);
}
if (!names.includes('rsi')) throw new Error('没拿到 rsi 这条序列(plot title 没透出来?)');

let checked = 0;
for (const i of [120, 180, candles.length - 1]) {
    const prefix = await run(candles.slice(0, i + 1));
    for (const name of names) {
        const a = full.series[name][i], b = prefix.series[name]?.[i];
        const same = a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)));
        if (!same) throw new Error(`因果检查失败 bar ${i} ${name}:全量 ${a} ≠ 前缀 ${b}`);
    }
    checked++;
}
console.log(`因果抽样 ${checked} 个点全部一致。smoke OK`);
engine?.kill();
