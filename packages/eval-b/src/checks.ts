import { demo } from '@trading-swarm/gateway';

import { buildEvalContext } from './context.js';
import type { EvalCase } from './types.js';

export interface EvidenceCheck {
  valid: boolean;
  errors: string[];
  hallucinated: { token: string; field: 'reason' | 'thesis'; text: string }[];
}

function numericTokens(text: string): string[] {
  return [...text.matchAll(/(^|[^A-Za-z\d])([-+]?\d+(?:\.\d+)?)(?:%|\b)/g)].map((match) => match[2]!).filter((token) => {
    const digits = token.replace(/[-+.]/g, '').replace(/^0+/, '');
    return digits.length >= 3;
  });
}

function supportedNumber(token: string, evidenceNumbers: number[]): boolean {
  const value = Number(token);
  if (!Number.isFinite(value)) return true;
  return evidenceNumbers.some((candidate) => Math.abs(candidate - value) / Math.max(Math.abs(candidate), Math.abs(value), 1e-12) <= 0.005);
}

/** Checks registry membership, per-reason citations, and unsupported three-digit numbers. */
export function checkEvidenceAndNumbers(judgment: demo.Judgment, evidence: demo.Evidence[]): EvidenceCheck {
  const errors: string[] = [];
  const registry = new Set(evidence.map((item) => item.ref));
  const declared = new Set(judgment.evidence_refs);
  const badDeclared = judgment.evidence_refs.filter((ref) => !registry.has(ref));
  if (badDeclared.length) errors.push(`unknown evidence_refs: ${badDeclared.join(', ')}`);
  for (const [index, reason] of judgment.reasons.entries()) {
    const cited = [...reason.matchAll(/\[(E\d+)\]/g)].map((match) => match[1]!);
    if (cited.length === 0) errors.push(`reason ${index + 1} has no [E<n>] citation`);
    const unknown = cited.filter((ref) => !registry.has(ref));
    if (unknown.length) errors.push(`reason ${index + 1} cites unknown refs: ${unknown.join(', ')}`);
    const undeclared = cited.filter((ref) => !declared.has(ref));
    if (undeclared.length) errors.push(`reason ${index + 1} cites refs absent from evidence_refs: ${undeclared.join(', ')}`);
  }
  const evidenceNumbers = evidence.flatMap((item) =>
    [...item.value.matchAll(/[-+]?\d+(?:\.\d+)?/g)].map((match) => Number(match[0])).filter(Number.isFinite),
  );
  const hallucinated: EvidenceCheck['hallucinated'] = [];
  const inspect = (text: string, field: 'reason' | 'thesis'): void => {
    const withoutRefs = text.replace(/\[E\d+\]/g, '');
    for (const token of numericTokens(withoutRefs)) {
      if (!supportedNumber(token, evidenceNumbers)) hallucinated.push({ token, field, text });
    }
  };
  judgment.reasons.forEach((reason) => inspect(reason, 'reason'));
  inspect(judgment.thesis, 'thesis');
  return { valid: errors.length === 0, errors, hallucinated };
}

function numberVariants(value: string): string[] {
  const number = Number(value);
  if (!Number.isFinite(number)) return [];
  return [...new Set([value, String(number), number.toFixed(0), number.toFixed(2), number.toFixed(5)].map((item) => item.replace(/\.0+$/, '')))];
}

function appearsAsNumber(text: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^0-9.])${escaped}([^0-9.]|$)`).test(text);
}

export interface LeakageCheck {
  leaked: boolean;
  reasons: string[];
}

/** Detects malformed visible data and hidden future prices/timestamps copied into model context. */
export function detectFutureLeakage(evalCase: EvalCase, contextText: string): LeakageCheck {
  const reasons: string[] = [];
  for (const [timeframe, klines] of Object.entries(evalCase.visible.klines)) {
    const future = klines.filter((kline) => kline.close_time > evalCase.as_of);
    if (future.length) reasons.push(`${timeframe} visible contains ${future.length} bar(s) closing after as_of`);
  }
  const visibleNumbers = new Set(
    Object.values(evalCase.visible.klines)
      .flat()
      .filter((kline) => kline.close_time <= evalCase.as_of)
      .flatMap((kline) => [kline.open, kline.high, kline.low, kline.close])
      .flatMap(numberVariants),
  );
  // A raw future price can legitimately equal a present EMA/ATR or another registered value.
  // Attribute matching numbers to the legal evidence registry before calling them leakage.
  try {
    for (const evidence of buildEvalContext(evalCase).evidence) {
      for (const token of evidence.value.match(/[-+]?\d+(?:\.\d+)?/g) ?? []) {
        for (const variant of numberVariants(token)) visibleNumbers.add(variant);
      }
    }
  } catch {
    // Structural case errors are reported through the visible close_time checks / runner.
  }
  for (const [index, kline] of evalCase.hidden.future_klines.entries()) {
    const values = [kline.open, kline.high, kline.low, kline.close].flatMap(numberVariants);
    const leakedValue = values.find((value) => !visibleNumbers.has(value) && appearsAsNumber(contextText, value));
    const isoMinute = new Date(kline.open_time).toISOString().slice(0, 16);
    if (leakedValue) reasons.push(`future bar ${index} price ${leakedValue} appears in context`);
    if (contextText.includes(isoMinute)) reasons.push(`future bar ${index} time ${isoMinute} appears in context`);
  }
  return { leaked: reasons.length > 0, reasons };
}

export function allowedActionsForCase(evalCase: EvalCase): demo.Action[] {
  if (evalCase.mode === 'scan') return ['NO_TRADE', 'WATCH', ...(evalCase.visible.halted ? [] : (['PROPOSE'] as demo.Action[]))];
  if (!evalCase.thread) return [];
  const allowed = demo.allowedReviewActions(evalCase.thread);
  return evalCase.visible.halted ? allowed.filter((action) => ['REDUCE', 'EXIT', 'INVALIDATE'].includes(action)) : allowed;
}

export function unauthorizedReason(evalCase: EvalCase, judgment: demo.Judgment): string | null {
  const allowed = allowedActionsForCase(evalCase);
  if (!allowed.includes(judgment.action)) return `${judgment.action} not in allowed actions: ${allowed.join('|') || '(none)'}`;
  const forbidden = evalCase.hidden.rubric?.must_not ?? [];
  if (forbidden.includes(judgment.action)) return `${judgment.action} is forbidden by case rubric`;
  return null;
}
