// State-machine helpers over transitions/*.json (via generated/transitions.ts).
// docs/contracts/README.md §6. Semantics: self-loops are not transitions; the same
// (from, to) pair may have multiple events; terminal states have no outgoing edges.

import { transitions as tables } from './generated/transitions.js';

export type MachineName = keyof typeof tables;

/** The 4 machine names this module knows about: intent_status, authorization_status, attempt_result, exchange_order_status. */
export function machines(): MachineName[] {
  return Object.keys(tables) as MachineName[];
}

/** True iff the table has *some* edge (any event) from `from` to `to`. */
export function canTransition(machine: MachineName, from: string, to: string): boolean {
  return tables[machine].transitions.some((edge) => edge.from === from && edge.to === to);
}

/** The state reached by firing `event` from `from`, or undefined if no such edge exists. */
export function nextState(machine: MachineName, from: string, event: string): string | undefined {
  return tables[machine].transitions.find((edge) => edge.from === from && edge.event === event)?.to;
}

/** True iff `state` is one of the machine's terminal states (no outgoing edges). */
export function isTerminal(machine: MachineName, state: string): boolean {
  return (tables[machine].terminal as readonly string[]).includes(state);
}
