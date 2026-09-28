// worker 线程里用的测试注入模块(MatrixWorkerRunner.inject):?mode=edge 合成 loader + 优势执行器;loader 只合成 loader;
// crash 取数时让 worker 线程直接退出(模拟崩溃);hang 取数永不返回(模拟关停时正在跑)。零网络。
import type { StrategyIR } from '@trade-gate/contracts';
import type { AssetExecutor, BarsLoader } from '../../../../src/demo/research/backtest-report.js';
import { edgeExecutor, loader as synth } from './fixtures.ts'; // 带 ?mode= 查询串时 .js→.ts 钩子认不出父模块,直接写 .ts

const mode = new URL(import.meta.url).searchParams.get('mode') ?? 'loader';
const base = synth();
export const loader: BarsLoader = mode === 'crash' ? (async () => { process.exit(7); }) as unknown as BarsLoader
  : mode === 'hang' ? (() => new Promise(() => undefined)) as unknown as BarsLoader
  : base;
export const executorFor: ((ir: StrategyIR) => AssetExecutor) | undefined = mode === 'edge' ? edgeExecutor() : undefined;
