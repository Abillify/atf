// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { TransactionBudget } from "./types.js";
export interface BudgetUsage { costUsd: number; tokens: number; durationMs: number; retrievalDocuments: number; toolCalls: number }
export interface BudgetReservation { invocationId: string; requested: Partial<BudgetUsage> }
const fields: Array<[keyof BudgetUsage, keyof TransactionBudget]> = [["costUsd","maxCostUsd"],["tokens","maxTokens"],["durationMs","maxDurationMs"],["retrievalDocuments","maxRetrievalDocuments"],["toolCalls","maxToolCalls"]];
export class BudgetExceededError extends Error { constructor(readonly dimension: keyof BudgetUsage) { super(`Transaction budget exceeded: ${dimension}`); this.name = "BudgetExceededError"; } }

/**
 * Recognizes terminal transaction-budget failures even when an SDK/provider
 * has copied the error into a plain object and lost its prototype.
 */
export function isBudgetExceededError(error: unknown): error is BudgetExceededError {
  if (error instanceof BudgetExceededError) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; message?: unknown; dimension?: unknown };
  return candidate.name === "BudgetExceededError"
    && typeof candidate.message === "string"
    && candidate.message.startsWith("Transaction budget exceeded:")
    && typeof candidate.dimension === "string";
}
interface KeyedBudgetReservation { key: string; reservation: BudgetReservation }

/** Coordinates committed usage and open reservations atomically within one JS isolate. */
export class TransactionBudgetCoordinator {
  private readonly usage = new Map<string, BudgetUsage>(); private readonly reservations = new Map<string, KeyedBudgetReservation>();
  reserve(key: string, budget: TransactionBudget, reservation: BudgetReservation): void {
    if (this.reservations.has(reservation.invocationId)) return;
    const used = { ...(this.usage.get(key) ?? { costUsd: 0, tokens: 0, durationMs: 0, retrievalDocuments: 0, toolCalls: 0 }) };
    for (const open of this.reservations.values()) {
      if (open.key !== key) continue;
      for (const [field] of fields) used[field] += open.reservation.requested[field] ?? 0;
    }
    for (const [usageField, limitField] of fields) { const limit = budget[limitField]; const requested = reservation.requested[usageField] ?? 0; if (limit !== undefined && used[usageField] + requested > limit) throw new BudgetExceededError(usageField); }
    this.reservations.set(reservation.invocationId, { key, reservation });
  }
  commit(key: string, invocationId: string, actual?: Partial<BudgetUsage>): BudgetUsage {
    const open = this.reservations.get(invocationId); if (!open) throw new Error(`Unknown budget reservation: ${invocationId}`);
    if (open.key !== key) throw new Error(`Budget reservation belongs to a different execution: ${invocationId}`);
    const used = this.usage.get(key) ?? { costUsd: 0, tokens: 0, durationMs: 0, retrievalDocuments: 0, toolCalls: 0 };
    for (const [field] of fields) used[field] += actual?.[field] ?? open.reservation.requested[field] ?? 0;
    this.reservations.delete(invocationId); this.usage.set(key, used); return { ...used };
  }
  release(invocationId: string): boolean { return this.reservations.delete(invocationId); }
  current(key: string): BudgetUsage { return { ...(this.usage.get(key) ?? { costUsd: 0, tokens: 0, durationMs: 0, retrievalDocuments: 0, toolCalls: 0 }) }; }
}
