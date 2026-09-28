/**
 * trade-gate 自己的 Pine 引擎(@trade-gate/pine-engine):把 PineTS(LuxAlgo 开源 Pine 运行时,AGPL-3.0)
 * 包成一个本地 HTTP 子进程。
 *
 * 由 gateway 托管(packages/gateway/src/demo/research/pine/engine-host.ts):网关启动时拉起、崩溃退避重启、
 * 网关退出一并收掉。子进程跑在 Node 权限模型里(--permission,只读本包与依赖目录;无 fs 写、无子进程、
 * 无 worker、无原生插件),端口默认 listen 0 由系统分配,就绪后把实际端口回报给托管器:
 *   - stdout 一行 JSON:{"event":"ready","port":…,"version":…,"pid":…}
 *   - 有 IPC 通道时另发 {type:'ready',…},并每秒发 {type:'heartbeat'};托管器靠心跳判断事件循环是否被脚本卡死。
 * IPC 断开(网关死了,哪怕是 SIGKILL)即自行退出,不留孤儿进程。
 *
 * POST /run  { source, candles: [{ time, open, high, low, close, volume }], symbol?, interval? }  // time 秒
 *   → { ok, bars, series: {name:[num|null]}, styles: {name:{...}}, drawings: {...}, warnings: [...] }
 * GET /health → { ok, engine: "pinets", version, port, pid }
 *
 * 限额(环境变量):PINE_RUN_TIMEOUT_MS 单次执行超时(默认 60000)、PINE_MAX_OUTPUT_BYTES 单次响应上限
 * (默认 16MB)、PINE_MAX_INPUT_BYTES 请求体上限(默认 30MB)。
 *
 * 授权边界:PineTS 为 AGPL-3.0(商业授权联系 LuxAlgo)。它只存在于这个独立进程里,
 * gateway 通过本地 HTTP 通信、从不 import 它——AGPL 边界就是进程边界。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { PineTS, aggregateCandles, TIMEFRAME_SECONDS } = require('pinets');

const PORT = Number(process.env.PINE_ENGINE_PORT || 0);
const RUN_TIMEOUT_MS = Number(process.env.PINE_RUN_TIMEOUT_MS || 60000);
const MAX_OUTPUT_BYTES = Number(process.env.PINE_MAX_OUTPUT_BYTES || 16 * 1024 * 1024);
const MAX_INPUT_BYTES = Number(process.env.PINE_MAX_INPUT_BYTES || 30 * 1024 * 1024);
// pinets 的 exports 不导出 ./package.json,按入口文件往上找(dist/xxx.cjs → 包根)
const VERSION = (() => {
    try {
        const root = path.resolve(path.dirname(require.resolve('pinets')), '..');
        return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    } catch { return 'unknown'; }
})();
// 自己要用的模块都已加载,之后脚本再要网络/文件/进程类模块一律拒(见 sandbox.js)
require('./sandbox').lockdown();

// TV 风格周期 → Binance/OKX 风格('60'→'1h','D'→'1d'…),已是后者则原样
function normalizeTimeframe(tf) {
    const s = String(tf || '').trim();
    if (TIMEFRAME_SECONDS[s]) return s;
    const upper = s.toUpperCase();
    if (upper === 'D' || upper === '1D') return '1d';
    if (upper === 'W' || upper === '1W') return '1w';
    if (upper === 'M' || upper === '1M') return '1M';
    if (/^\d+$/.test(s)) {
        const minutes = Number(s);
        if (minutes % 60 === 0 && TIMEFRAME_SECONDS[`${minutes / 60}h`]) return `${minutes / 60}h`;
        return `${minutes}m`;
    }
    return s;
}

/**
 * 用图表基础周期的 K 线服务所有周期请求:同周期直出,高周期用 aggregateCandles 聚合
 * (W/M 先聚成 1d 再按日历分组),让 request.security 在可用历史范围内工作。
 */
class LocalProvider {
    constructor(candles, baseTf) {
        this.base = candles;
        this.baseTf = normalizeTimeframe(baseTf || '1h');
    }
    async getMarketData(_tickerId, timeframe) {
        const target = normalizeTimeframe(timeframe);
        if (target === this.baseTf) return this.base;
        const baseSec = TIMEFRAME_SECONDS[this.baseTf] || 3600;
        const targetSec = TIMEFRAME_SECONDS[target] || 0;
        if (target === '1w' || target === '1M') {
            const daily = this.baseTf === '1d' ? this.base : aggregateCandles(this.base, '1d', this.baseTf);
            return aggregateCandles(daily, target === '1w' ? 'W' : 'M', 'D');
        }
        if (targetSec > 0 && targetSec % baseSec === 0) {
            return aggregateCandles(this.base, target, this.baseTf);
        }
        // 比基础周期还细:造不出来,退回基础周期(脚本层面等价于降级)
        return this.base;
    }
    async getSymbolInfo(tickerId) {
        return {
            ticker: tickerId, tickerid: tickerId, description: tickerId, type: 'crypto',
            currency: 'USDT', basecurrency: '', timezone: 'UTC', session: '24x7',
            mintick: 0.01, minmove: 1, pricescale: 100, pointvalue: 1, mincontract: 0,
        };
    }
    configure() {}
}

function toNum(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// 从绘图对象里拎出可序列化的原始字段(跳过 _helper 等内部引用)
function plainDrawing(obj) {
    const out = {};
    for (const key of Object.keys(obj)) {
        if (key.startsWith('_')) continue;
        const value = obj[key];
        if (value === null || ['number', 'string', 'boolean'].includes(typeof value)) out[key] = value;
    }
    return out;
}

// bar_index → K线时间(秒);越界钳到边界;坐标可能已是毫秒时间戳(xloc.bar_time)
function barTime(candles, barIndex) {
    if (typeof barIndex !== 'number' || !Number.isFinite(barIndex)) return null;
    if (barIndex > 10_000_000_000) return Math.floor(barIndex / 1000); // 已是 ms 时间戳
    const i = Math.max(0, Math.min(candles.length - 1, Math.round(barIndex)));
    return Math.floor(candles[i].openTime / 1000);
}

async function runPine(source, candles, symbol, interval) {
    const stepMs = candles.length > 1 ? Math.round((candles[1].time - candles[0].time) * 1000) : 3_600_000;
    const mapped = candles.map((c) => ({
        openTime: Math.round(c.time * 1000),
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.volume ?? 0,
        closeTime: Math.round(c.time * 1000) + stepMs,
        quoteAssetVolume: 0, numberOfTrades: 0,
        takerBuyBaseAssetVolume: 0, takerBuyQuoteAssetVolume: 0, ignore: 0,
    }));
    const provider = new LocalProvider(mapped, interval || '1h');
    const pineTS = new PineTS(provider, symbol || 'BTCUSDT', normalizeTimeframe(interval || '1h'), mapped.length);
    const ctx = await pineTS.run(source);

    const series = {};
    const styles = {};
    for (const [name, plot] of Object.entries(ctx.plots || {})) {
        if (name.startsWith('__')) continue; // 绘图对象走 _drawingHelpers
        const rows = Array.isArray(plot) ? plot : plot && plot.data;
        if (!Array.isArray(rows) || !rows.length) continue;
        // plot 行携带 time(ms);按时间对齐到 K 线索引,缺口留 null
        const byTime = new Map();
        for (const row of rows) {
            if (row && row.time != null) byTime.set(Math.floor(row.time / 1000), toNum(row.value));
        }
        const aligned = mapped.map((c) => byTime.get(Math.floor(c.openTime / 1000)) ?? null);
        if (aligned.every((v) => v === null)) continue;
        series[name] = aligned;
        const styled = rows.find((row) => row && row.options && Object.keys(row.options).length);
        if (styled) styles[name] = styled.options;
        if (Object.keys(series).length >= 24) break;
    }

    const drawings = { labels: [], lines: [], boxes: [] };
    const helpers = ctx._drawingHelpers || [];
    for (const helper of Object.values(helpers)) {
        for (const [prop, bucket] of [['_labels', 'labels'], ['_lines', 'lines'], ['_boxes', 'boxes']]) {
            const items = helper && helper[prop];
            if (!Array.isArray(items)) continue;
            for (const item of items.slice(-250)) { // 图上对象上限,防爆
                if (item && item._deleted) continue;
                const plain = plainDrawing(item);
                // bar_index 坐标 → 时间坐标,前端直接用
                if (bucket === 'labels' && plain.x != null) plain.time = barTime(mapped, plain.x);
                if (bucket === 'lines') {
                    if (plain.x1 != null) plain.time1 = barTime(mapped, plain.x1);
                    if (plain.x2 != null) plain.time2 = barTime(mapped, plain.x2);
                }
                if (bucket === 'boxes') {
                    if (plain.left != null) plain.time1 = barTime(mapped, plain.left);
                    if (plain.right != null) plain.time2 = barTime(mapped, plain.right);
                }
                drawings[bucket].push(plain);
            }
        }
    }

    return {
        ok: true,
        bars: mapped.length,
        series,
        styles,
        drawings,
        warnings: (ctx.warnings || []).slice(0, 20),
    };
}

/** 单次执行超时:脚本卡在异步环节时这里兜底;同步死循环卡住事件循环时由托管器的心跳看门狗杀进程重启。 */
function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`pine_run_timeout:${ms}ms`)), ms); }),
    ]).finally(() => clearTimeout(timer));
}

let listenPort = PORT;
const server = http.createServer((req, res) => {
    const reply = (status, payload) => {
        let body = JSON.stringify(payload);
        if (Buffer.byteLength(body) > MAX_OUTPUT_BYTES) {
            body = JSON.stringify({ ok: false, error: `pine_output_too_large:${Buffer.byteLength(body)}>${MAX_OUTPUT_BYTES} 字节` });
        }
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
    };
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
        return reply(200, { ok: true, engine: 'pinets', version: VERSION, port: listenPort, pid: process.pid });
    }
    if (req.method !== 'POST' || req.url !== '/run') return reply(404, { ok: false, error: 'not found' });
    let raw = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
        if (tooLarge) return;
        raw += chunk;
        if (raw.length > MAX_INPUT_BYTES) { tooLarge = true; raw = ''; reply(413, { ok: false, error: 'pine_input_too_large' }); req.destroy(); }
    });
    req.on('end', async () => {
        if (tooLarge) return;
        try {
            const { source, candles, symbol, interval } = JSON.parse(raw || '{}');
            if (!source || !Array.isArray(candles) || candles.length < 10) {
                return reply(400, { ok: false, error: 'source 与 candles(≥10 根)必填' });
            }
            const result = await withTimeout(runPine(String(source), candles, symbol, interval), RUN_TIMEOUT_MS);
            reply(200, result);
        } catch (error) {
            const detail = error && error.stack ? String(error.stack).split('\n').slice(0, 6).join('\n') : '';
            reply(200, { ok: false, error: String((error && error.message) || error).slice(0, 2000), detail });
        }
    });
});

server.listen(PORT, '127.0.0.1', () => {
    listenPort = server.address().port;
    const ready = { event: 'ready', port: listenPort, version: VERSION, pid: process.pid, engine: 'pinets' };
    process.stdout.write(JSON.stringify(ready) + '\n');
    if (typeof process.send === 'function') {
        process.send({ type: 'ready', ...ready });
        // 心跳:托管器据此判断事件循环有没有被脚本卡死
        setInterval(() => { try { process.send({ type: 'heartbeat', at: Date.now() }); } catch { /* 通道已断,下面的 disconnect 会收尾 */ } }, 1000);
        // 网关没了(包括被 SIGKILL):IPC 断开,自己退出,不做孤儿
        process.on('disconnect', () => process.exit(0));
    }
});
server.on('error', (error) => {
    process.stdout.write(JSON.stringify({ event: 'error', error: String((error && error.message) || error) }) + '\n');
    process.exit(1);
});
