// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import crypto from "node:crypto";
import type {
  InvocationLedgerStore,
  InvocationRecord,
  InvocationSideEffectDescriptor,
} from "./ledger.js";

export interface RecoveryResult {
  retryable: string[];
  outcomeUnknown: string[];
}

/**
 * Conservatively resolves abandoned claims. Only explicitly read-only or
 * idempotent work is marked retryable; non-idempotent work is never replayed.
 */
export async function recoverStaleInvocations(
  ledger: InvocationLedgerStore,
  staleBefore: number,
): Promise<RecoveryResult> {
  const result: RecoveryResult = { retryable: [], outcomeUnknown: [] };
  for (const record of await ledger.listStale(staleBefore, ["pending", "running"])) {
    const safeToRetry = record.sideEffect.semantics === "read_only" || record.sideEffect.semantics === "idempotent";
    await ledger.transition(record.invocationId, safeToRetry ? "failed" : "outcome_unknown", {
      retryable: safeToRetry,
      error: safeToRetry ? "stale invocation; safe for explicit retry" : "stale non-idempotent invocation; outcome unknown",
      errorEvidence: { kind: "recovery", summary: `stale ${record.state}` },
    });
    (safeToRetry ? result.retryable : result.outcomeUnknown).push(record.invocationId);
  }
  return result;
}

export interface CompensationContext<T = unknown> {
  original: InvocationRecord<T>;
  compensationInvocationId: string;
}

export type CompensationHandler<T = unknown> = (context: CompensationContext<T>) => Promise<unknown>;

export class CompensationRegistry {
  private readonly handlers = new Map<string, CompensationHandler>();
  register(tool: string, handler: CompensationHandler): void {
    if (this.handlers.has(tool)) throw new Error(`Compensation handler already registered: ${tool}`);
    this.handlers.set(tool, handler);
  }
  get(tool: string): CompensationHandler | undefined { return this.handlers.get(tool); }
}

function compactEvidence(value: unknown): { summary: string; kind?: string } {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
  return { summary: (raw ?? "undefined").slice(0, 1024), kind: value instanceof Error ? value.name : typeof value };
}

/** Compensation is always explicit and itself has a distinct invocation id. */
export async function compensateInvocation(
  ledger: InvocationLedgerStore,
  registry: CompensationRegistry,
  invocationId: string,
  compensationInvocationId: string = crypto.randomUUID(),
): Promise<InvocationRecord> {
  const original = await ledger.get(invocationId);
  if (!original) throw new Error(`Unknown invocation: ${invocationId}`);
  if (original.sideEffect.reversible !== true) throw new Error(`Invocation is not declared reversible: ${invocationId}`);
  if (original.state !== "committed" && original.state !== "outcome_unknown") {
    throw new Error(`Invocation cannot be compensated from ${original.state}`);
  }
  const handler = registry.get(original.sideEffect.tool);
  if (!handler) throw new Error(`No compensation handler registered: ${original.sideEffect.tool}`);
  const result = await handler({ original, compensationInvocationId });
  return ledger.transition(invocationId, "compensated", {
    compensationInvocationId,
    resultEvidence: compactEvidence(result),
  });
}

export function sideEffect(tool: string, semantics: InvocationSideEffectDescriptor["semantics"], reversible = false): InvocationSideEffectDescriptor {
  return { tool, semantics, ...(reversible ? { reversible: true } : {}) };
}
