// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * In-memory Decision_Receipt store (Req 15.4).
 *
 * Holds recently issued receipts (COSE_Sign1 wire bytes + payload) keyed by
 * receipt id, with a secondary index by execution id so the chat-completion
 * route can attach the `X-ATF-Receipt` header and the trace viewer can list
 * receipts for one run. Bounded FIFO — receipts are durable in the
 * `receipt_log` transparency table (21.4); this store only serves the live
 * replica that issued them.
 */

import type { SignedDecisionReceipt } from "./types.js";

/** Default cap on receipts kept per replica. */
const DEFAULT_MAX_RECEIPTS = 2000;

export interface ReceiptStore {
  /** Store a signed receipt; replaces an existing entry with the same id. */
  put(receipt: SignedDecisionReceipt): void;
  /** Look up one receipt by id. */
  get(receiptId: string): SignedDecisionReceipt | undefined;
  /** All receipts for one execution (parent first, then tool-call children). */
  byExecution(executionId: string): SignedDecisionReceipt[];
  /** Number of receipts currently held. */
  size(): number;
}

export class InMemoryReceiptStore implements ReceiptStore {
  private readonly byId = new Map<string, SignedDecisionReceipt>();
  private readonly byExec = new Map<string, string[]>();

  constructor(private readonly maxReceipts: number = DEFAULT_MAX_RECEIPTS) {}

  put(receipt: SignedDecisionReceipt): void {
    const id = receipt.payload.receipt_id;
    if (!this.byId.has(id)) {
      const ids = this.byExec.get(receipt.payload.execution_id) ?? [];
      ids.push(id);
      this.byExec.set(receipt.payload.execution_id, ids);
    }
    this.byId.set(id, receipt);
    // FIFO eviction keeps the store bounded without disturbing insertion order.
    while (this.byId.size > this.maxReceipts) {
      const oldest = this.byId.keys().next();
      if (oldest.done === true) break;
      const evicted = this.byId.get(oldest.value);
      this.byId.delete(oldest.value);
      if (evicted !== undefined) {
        const ids = this.byExec.get(evicted.payload.execution_id);
        if (ids !== undefined) {
          const at = ids.indexOf(oldest.value);
          if (at >= 0) ids.splice(at, 1);
          if (ids.length === 0)
            this.byExec.delete(evicted.payload.execution_id);
        }
      }
    }
  }

  get(receiptId: string): SignedDecisionReceipt | undefined {
    return this.byId.get(receiptId);
  }

  byExecution(executionId: string): SignedDecisionReceipt[] {
    const ids = this.byExec.get(executionId) ?? [];
    const out: SignedDecisionReceipt[] = [];
    for (const id of ids) {
      const r = this.byId.get(id);
      if (r !== undefined) out.push(r);
    }
    // Parent receipt first so consumers see the completion before its children.
    return out.sort((a, b) =>
      a.payload.kind === b.payload.kind
        ? 0
        : a.payload.kind === "chat_completion"
          ? -1
          : 1,
    );
  }

  size(): number {
    return this.byId.size;
  }
}
