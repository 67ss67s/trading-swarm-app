// 默认/研究只读现网配置；fill 仅联网补公开行情缓存，不修改运行时数据库。
import { readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';
import ts from 'typescript';
registerHooks({ resolve(specifier, context, next) {
        try {
            return next(specifier, context);
        }
        catch (e) {
            if (specifier.endsWith('.js') && context.parentURL?.includes('/src/'))
                return next(specifier.slice(0, -3) + '.ts', context);
            throw e;
        }
    }, load(url, context, next) {
        if (url.endsWith('.ts'))
            return { format: 'module', shortCircuit: true, source: ts.transpile(readFileSync(new URL(url), 'utf8'), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }) };
        return next(url, context);
    } });
if (process.argv.includes('--study=traders') || process.argv[process.argv.indexOf('--study') + 1] === 'traders') {
  await (await import('./trader-study.mjs')).run();
  process.exit(0);
}
if (process.argv.includes('--study') && process.argv[process.argv.indexOf('--study') + 1] === 'pair') {
  await (await import('./pair-cache.mjs')).run();
  process.exit(0);
}
const { StrategyLibrary } = await import('../packages/gateway/src/demo/strategies.ts');
const { registerManifest, runExperiment, labCacheFetchSpans } = await import('../packages/gateway/src/demo/strategy-lab.ts');
const root = `${homedir()}/.trade-gate/demo`;
const db = new DatabaseSync(`${root}/state.sqlite`, { readOnly: true });
const specs = new StrategyLibrary(db).list().filter(s => s.status !== 'retired');
const workflow = JSON.parse(db.prepare('SELECT value FROM kv WHERE key=?').get('demo.workflow').value);
db.close();
const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : args.find(a => a.startsWith(key + '='))?.slice(key.length + 1) ?? fallback;
if (args.includes('fill') || args.some(a => a === '--study' || a.startsWith('--study='))) {
    await special();
    process.exit(0);
}
const cache = new Map();
function read(symbol, tf) { const k = `${symbol}-${tf}`; if (!cache.has(k))
    cache.set(k, JSON.parse(readFileSync(`${root}/klines/${k}.json`, 'utf8')).bars); return cache.get(k); }
const symbols = readdirSync(`${root}/klines`).filter(f => f.endsWith('-15m.json') && !f.startsWith('FAKE')).map(f => f.slice(0, -9)).filter(s => ['1h', '4h', '1d'].every(tf => { try {
    read(s, tf);
    return true;
}
catch {
    return false;
} }));
const to = Math.min(...symbols.map(s => read(s, '15m').at(-1).close_time));
const manifest = registerManifest({ strategies: specs, symbols, timeframe: '15m', days: 90, now: to });
const loadSeries = async (symbol, tf) => ({ base: read(symbol, tf), h1: read(symbol, '1h'), h4: read(symbol, '4h'), d1: read(symbol, '1d'), funding: [] });
const topN = Number(process.argv.find(a => a.startsWith('--top='))?.split('=')[1] ?? 18);
const start = Date.now();
const result = await runExperiment(manifest, { specs, loadSeries, top_n: topN });
console.table(result.by_strategy.map(s => ({ family: specs.find(x => x.id === s.strategy_id).family, strategy: s.strategy_id, symbols: s.symbols, setups: s.setups, n: s.n, gross: s.gross?.expectancy_r, net: s.net?.expectancy_r, oos_n: s.replay?.oos_n, oos_net: s.replay?.oos_net_expectancy, ci_lower: s.replay?.oos_ci.lower, dsr: s.replay?.dsr })));
console.table(Object.entries(Object.groupBy(result.by_strategy, s => specs.find(x => x.id === s.strategy_id).family)).map(([family, rows]) => ({ family, setups: rows.reduce((n, r) => n + r.setups, 0) })));
console.log(JSON.stringify({ manifest, result, elapsed_ms: Date.now() - start }, null, 2));
async function special() {
    const { execFileSync } = await import('node:child_process');
    const { missingSpans, mergeSpans } = await import('../packages/gateway/src/demo/backtest.ts');
    const { tfToMs } = await import('../packages/gateway/src/demo/market.ts');
    const dir = `${root}/klines`, research = `${root}/research-entry`;
    mkdirSync(research, { recursive: true });
    const snapshotPath = option('--snapshot', null);
    const snapshotResult = snapshotPath ? JSON.parse(readFileSync(snapshotPath, 'utf8')) : null;
    const snapshot = snapshotResult?.manifest ?? null;
    const day = 86400000, to = snapshot?.to ?? Math.floor(Number(option('--to', Date.now())) / day) * day;
    const symbols = snapshot?.symbols ?? option('--symbols', workflow.watchlist.join(',')).split(',').sort();
    const atomic = (path, value) => { writeFileSync(path + '.p9.tmp', JSON.stringify(value)); renameSync(path + '.p9.tmp', path); };
    const request = async (path) => {
        for (let attempt = 0; ; attempt++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                return JSON.parse(execFileSync('curl', ['--fail', '--silent', '--show-error', '--max-time', '45', `https://fapi.binance.com${path}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
            } catch (error) {
                if (attempt >= 5 || !/429|500|502|503|504|timed out|reset|resolve|SSL/.test(String(error.stderr ?? error.message))) throw error;
                const wait = Math.min(300000, 30000 * 2 ** attempt);
                console.error(`公开缓存请求退避 ${wait / 1000}s (attempt ${attempt + 1})`);
                await new Promise(r => setTimeout(r, wait));
            }
        }
    };
    if (args.includes('fill')) {
        const info = await request('/fapi/v1/exchangeInfo');
        atomic(`${research}/ticks.json`, Object.fromEntries(info.symbols.map(s => [s.symbol, String(s.filters.find(f => f.filterType === 'PRICE_FILTER').tickSize)])));
        const coverage = [];
        for (const symbol of symbols) {
            for (const tf of ['15m', '1h', '4h', '1d', '5m']) {
                // 180d 实验外另留 30d 热身；日线多留 260d 支持 regime。
                const days = tf === '5m' ? 30 : tf === '1d' ? 440 : 210, from = to - days * day, step = tfToMs(tf), path = `${dir}/${symbol}-${tf}.json`;
                let old;
                try {
                    old = JSON.parse(readFileSync(path, 'utf8'));
                }
                catch {
                    old = { bars: [], ranges: [] };
                }
                // 旧 range 可能止于根内；不足一根的尾片也必须补整根，不能漏掉最后闭合日线。
                const gaps = labCacheFetchSpans(old.ranges ?? [], from, to - 1, step);
                const bars = new Map(old.bars.map(b => [b.open_time, b]));
                for (const gap of gaps) {
                    let start = gap.from;
                    while (start <= gap.to) {
                        const raw = await request(`/fapi/v1/klines?symbol=${symbol}&interval=${tf}&startTime=${start}&endTime=${gap.to}&limit=1500`);
                        if (!Array.isArray(raw))
                            throw Error(JSON.stringify(raw));
                        if (!raw.length)
                            break;
                        for (const b of raw)
                            if (b[6] < to)
                                bars.set(b[0], { open_time: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5], close_time: b[6] });
                        const next = raw.at(-1)[6] + 1;
                        if (next <= start)
                            throw Error('pagination stalled');
                        start = next;
                        old.ranges = mergeSpans([...(old.ranges ?? []), {from:gap.from,to:Math.min(gap.to,next-1)}]);
                        atomic(path, {symbol,tf,bars:[...bars.values()].sort((a,b)=>a.open_time-b.open_time),ranges:old.ranges});
                    }
                    old.ranges = mergeSpans([...(old.ranges ?? []), gap]);
                    atomic(path, { symbol, tf, bars: [...bars.values()].sort((a, b) => a.open_time - b.open_time), ranges: old.ranges });
                }
                const window = [...bars.values()].filter(b => b.open_time >= from && b.close_time < to).sort((a,b)=>a.open_time-b.open_time);
                coverage.push({ symbol, tf, requested_days: days, bars: window.length, expected_bars: days * day / step, first_at: window[0]?.open_time ?? null });
                console.error(`${symbol} ${tf}: ${window.length}/${days * day / step}`);
            }
            const path = `${research}/${symbol}-funding.json`;
            let f;
            try {
                f = JSON.parse(readFileSync(path, 'utf8'));
            }
            catch {
                f = { points: [], ranges: [] };
            }
            for (const gap of missingSpans(f.ranges, to - 210 * day, to - 1, 1)) {
                let start = gap.from;
                while (start <= gap.to) {
                    const rows = await request(`/fapi/v1/fundingRate?symbol=${symbol}&startTime=${start}&endTime=${gap.to}&limit=1000`);
                    if (!rows.length)
                        break;
                    f.points.push(...rows.map(r => ({ at: r.fundingTime, rate: r.fundingRate })));
                    start = rows.at(-1).fundingTime + 1;
                }
                f.ranges = mergeSpans([...f.ranges, gap]);
            }
            f.points = [...new Map(f.points.map(p => [p.at, p])).values()].sort((a, b) => a.at - b.at);
            atomic(path, f);
        }
        atomic(`${research}/coverage.json`, { to, symbols, coverage });
        return;
    }
    const { runStudy } = await import('../packages/gateway/src/demo/entry-param-study.ts');
    const kind = option('--study', 'entry');
    if (snapshot && snapshot.kind !== kind)
        throw Error('snapshot kind mismatch');
    if (!['entry', 'params'].includes(kind))
        throw Error('study must be entry|params');
    const ticks = Object.fromEntries(Object.entries(snapshot?.ticks ?? JSON.parse(readFileSync(`${research}/ticks.json`))).map(([symbol, tick]) => [symbol, Number(tick)]));
    const frozenSpecs = snapshot?.strategies ?? specs;
    atomic(`${research}/${kind}-registration.json`, { registered_at: Date.now(), kind, to, from: to - 180 * day, symbols, strategies: frozenSpecs, ticks: Object.fromEntries(Object.entries(ticks).map(([symbol,tick])=>[symbol,String(tick)])), protocol: 'entry-param-v1;60d train;full horizon purge;single selection;12 params or 3 entry arms' });
    const data = new Map();
    const read = (symbol, tf) => { const k = `${symbol}-${tf}`; if (!data.has(k))
        data.set(k, JSON.parse(readFileSync(`${dir}/${k}.json`)).bars); return data.get(k); };
    const load = (symbol, tf) => ({ base: read(symbol, tf), h1: read(symbol, '1h'), h4: read(symbol, '4h'), d1: read(symbol, '1d'), funding: JSON.parse(readFileSync(`${research}/${symbol}-funding.json`)).points });
    const ledger = new DatabaseSync(`${root}/lab-trials.sqlite`);
    ledger.exec('CREATE TABLE IF NOT EXISTS demo_strategy_trials(family TEXT NOT NULL,trial_key TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(family,trial_key))');
    const record = (family, keys) => { for (const key of keys)
        ledger.prepare('INSERT OR IGNORE INTO demo_strategy_trials VALUES(?,?,?)').run(family, key, Date.now()); return snapshotResult?.trial_count_snapshot?.[family] ?? Number(ledger.prepare('SELECT count(*) n FROM demo_strategy_trials WHERE family=?').get(family).n); };
    try {
        const result = await runStudy(kind, frozenSpecs, symbols, to - 180 * day, to, load, ticks, record);
        atomic(option('--output', `${research}/${kind}.json`), result);
        console.log(JSON.stringify(result, null, 2));
    }
    finally {
        ledger.close();
    }
}
