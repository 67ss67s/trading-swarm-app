// Outcome simulation moved into the gateway (packages/gateway/src/demo/outcome.ts) on 2026-09-05 so the
// blind backtester (demo/backtest.ts) and this harness share ONE definition of the fill / stop / tp
// semantics. This file is the eval-side alias — import sites and `export * from './outcome.js'` are
// unchanged; the rules themselves now live next to the runtime that also uses them.

import { demo } from '@trading-swarm/gateway';

export type Outcome = demo.Outcome;
export type OutcomeInput = demo.OutcomeInput;
export type OutcomeStatus = demo.OutcomeStatus;
export type OpenTrade = demo.OpenTrade;
export type TradeStep = demo.TradeStep;

export const simulateOutcome = demo.simulateOutcome;
export const missedMove = demo.missedMove;
export const openTrade = demo.openTrade;
export const stepTrade = demo.stepTrade;
export const tradeR = demo.tradeR;
export const findFill = demo.findFill;
