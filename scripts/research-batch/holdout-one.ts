/**
 * 预先声明的单一子问题用一次留出段(不是每族冠军之外随手挑):例如主线程问「日线均线金叉(纯信号离场)是不是真有东西」,
 * 就在「该族 × 日线 × 整池」行里按训练段夏普选一行(和每族冠军同一规则,只是范围缩到日线),跑一次留出段,写进 results.json 的 holdout_extra。
 * 用法:node ... scripts/research-batch/holdout-one.ts <族> <周期>   (例:ema_cross 1d)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EvalEnv } from '../../packages/gateway/src/demo/research/improve/evaluate.ts';
import { evaluateIrVariant, poolScore } from '../../packages/gateway/src/demo/research/batch/evaluate.ts';
import { assetStats, slim, type BatchRow } from '../../packages/gateway/src/demo/research/batch/study.ts';
import { allVariants, type IrVariant } from '../../packages/gateway/src/demo/research/batch/families.ts';
import { BATCH_DIR, frozenData } from './common.ts';

const [fam, tf] = process.argv.slice(2) as [string, string];
const file = path.join(BATCH_DIR, 'results.json'), res = JSON.parse(readFileSync(file, 'utf8')) as { evals: Record<string, { rows: BatchRow[] }>; holdout_extra?: Record<string, unknown> };
const rows = Object.values(res.evals).flatMap((e) => e.rows).filter((r) => r.family === fam && r.timeframe === tf && r.scope === 'pool' && r.train.trades >= 30 && r.train.sharpe !== null);
const pick = rows.sort((a, b) => b.train.sharpe! - a.train.sharpe!)[0];
if (!pick) throw Error('没有符合条件的行');
res.holdout_extra ??= {};
if (res.holdout_extra[pick.id]) { console.log('已跑过', pick.id); process.exit(0); }
const v = allVariants().find((x) => x.id === pick.variant_id) as IrVariant, { data } = frozenData(v.timeframe, v.market), s = data.segments;
const r = await evaluateIrVariant(new EvalEnv(data), v.ir, s.holdout, { holdout: s.holdout }, v.vol_target ? { vol_target: v.vol_target } : {});
const per = r.slices.holdout!.map((x) => { const st = assetStats(x); return { symbol: x.symbol, eligible: x.eligible, return: st.ret, sharpe: st.sharpe, trades: x.trades, hold: x.hold.length ? x.hold.at(-1)! - 1 : null }; });
res.holdout_extra[pick.id] = { question: `${fam} × ${tf}:该范围内训练段夏普最高的整池行,留出段一次`, candidates: rows.length, train_sharpe: pick.train.sharpe, holdout: slim(poolScore(r.slices.holdout!, v.side === 'short' ? -1 : 1)), per_asset: per, segment: s.holdout };
writeFileSync(file, JSON.stringify(res));
console.log(pick.id, JSON.stringify(res.holdout_extra[pick.id]).slice(0, 1500));
