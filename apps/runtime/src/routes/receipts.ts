// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Decision_Receipt routes (Req 15.4).
 *
 *   GET /v1/receipts?execution_id — all receipts for one execution (Req 15.7)
 *   GET /v1/receipts/:id          — one signed receipt (COSE_Sign1 + payload)
 *   GET /v1/receipts/:id/proof    — Merkle inclusion proof + signed tree head
 *
 * The `/v1/*` routes sit behind the runtime auth middleware; access is
 * tenant-scoped: a receipt is only returned when its `tenant_id` matches the
 * verified tenant of the caller (404 otherwise — an unknown id and a foreign
 * receipt are indistinguishable on purpose).
 *
 * The public JWKS lives in `receipt-jwks.ts` (unauthenticated, mirrors
 * `transaction-jwks.ts`).
 */

import { Hono } from "hono";
import { base64UrlEncode } from "@atf/security-kit";
import type { AuthContext, AuthPrincipal } from "../middleware/auth.js";
import { AUTH_PRINCIPAL_KEY } from "../middleware/auth.js";
import { decodeReceiptPayload } from "../receipts/receipt-builder.js";
import type { ReceiptStore } from "../receipts/receipt-store.js";
import type { TransparencyLog } from "../receipts/transparency-log.js";
import type { SignedDecisionReceipt } from "../receipts/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function error(message: string, type = "invalid_request_error") {
  return { error: { message, type } };
}

/** Verified tenant of the caller, or undefined when the token carries none. */
function principalTenant(
  principal: AuthPrincipal | undefined,
): string | undefined {
  if (principal?.verified !== true) return undefined;
  const tenant = principal.tenantId?.trim();
  return tenant !== undefined && tenant !== "" ? tenant : undefined;
}

export interface ReceiptsRouterDeps {
  receiptStore: ReceiptStore;
  /** Absent when the transparency log is unavailable — proofs return 503. */
  transparencyLog?: TransparencyLog;
}

/**
 * Tenant-scoped receipt retrieval. The COSE bytes are the authoritative
 * artifact (the payload JSON is a convenience view — verifiers must check the
 * signature over `cose_base64`, not trust this JSON echo).
 */
export function createReceiptsRouter(deps: ReceiptsRouterDeps): Hono<AuthContext> {
  const router = new Hono<AuthContext>();
  const { receiptStore, transparencyLog } = deps;

  /**
   * Resolve one receipt: the bounded in-memory store first, then the
   * transparency log (rebuilt from the durable `receipt_log` at startup), so
   * a receipt stays retrievable after it was evicted from the store or the
   * replica restarted (Req 15.4). The caller applies the same tenant check
   * to both sources.
   */
  function resolveReceipt(receiptId: string): SignedDecisionReceipt | undefined {
    const live = receiptStore.get(receiptId);
    if (live !== undefined) return live;
    const entry = transparencyLog?.entryByReceiptId(receiptId);
    if (entry === undefined) return undefined;
    const payload = decodeReceiptPayload(entry.coseBytes);
    if (payload === undefined || payload.receipt_id !== receiptId) return undefined;
    return { payload, coseBytes: entry.coseBytes };
  }

  // Collection view for the trace viewer (Req 15.7): every receipt issued for
  // one execution, parent receipt first. Tenant-scoped like the single-read.
  router.get("/v1/receipts", (ctx) => {
    const tenant = principalTenant(ctx.get(AUTH_PRINCIPAL_KEY));
    if (tenant === undefined) {
      return ctx.json(
        error(
          "A verified tenant scope is required to read receipts.",
          "authentication_error",
        ),
        401,
      );
    }
    const executionId = ctx.req.query("execution_id")?.trim();
    if (executionId === undefined || executionId === "") {
      return ctx.json(
        error("The query parameter execution_id is required.", "invalid_request_error"),
        400,
      );
    }
    const receipts = receiptStore
      .byExecution(executionId)
      .filter((r) => r.payload.tenant_id === tenant)
      .map((r) => ({
        receipt_id: r.payload.receipt_id,
        kind: r.payload.kind,
        cose_base64: base64UrlEncode(r.coseBytes),
        payload: r.payload,
      }));
    return ctx.json({ execution_id: executionId, receipts });
  });

  router.get("/v1/receipts/:id", (ctx) => {
    const tenant = principalTenant(ctx.get(AUTH_PRINCIPAL_KEY));
    if (tenant === undefined) {
      return ctx.json(
        error(
          "A verified tenant scope is required to read receipts.",
          "authentication_error",
        ),
        401,
      );
    }
    const receipt = resolveReceipt(ctx.req.param("id"));
    if (receipt === undefined || receipt.payload.tenant_id !== tenant) {
      return ctx.json(error("Receipt not found.", "not_found_error"), 404);
    }
    return ctx.json({
      receipt_id: receipt.payload.receipt_id,
      cose_base64: base64UrlEncode(receipt.coseBytes),
      payload: receipt.payload,
    });
  });

  // RFC-6962 inclusion proof for one receipt, anchored at a signed tree head.
  // When no sealed head covers the entry yet, seal the current tree on demand
  // so the proof is always verifiable offline against the JWKS key.
  router.get("/v1/receipts/:id/proof", async (ctx) => {
    const tenant = principalTenant(ctx.get(AUTH_PRINCIPAL_KEY));
    if (tenant === undefined) {
      return ctx.json(
        error(
          "A verified tenant scope is required to read receipts.",
          "authentication_error",
        ),
        401,
      );
    }
    const receipt = resolveReceipt(ctx.req.param("id"));
    if (receipt === undefined || receipt.payload.tenant_id !== tenant) {
      return ctx.json(error("Receipt not found.", "not_found_error"), 404);
    }
    if (transparencyLog === undefined) {
      return ctx.json(
        error(
          "The transparency log is not available on this replica.",
          "service_unavailable_error",
        ),
        503,
      );
    }
    const receiptId = receipt.payload.receipt_id;
    const entry = transparencyLog.entryByReceiptId(receiptId);
    if (entry === undefined) {
      // The receipt is live in this replica's store but was never appended to
      // the log (append failed at issuance) — no honest proof exists.
      return ctx.json(
        error(
          "This receipt is not part of the transparency log.",
          "not_found_error",
        ),
        404,
      );
    }
    let head = transparencyLog.latestTreeHead();
    if (head === undefined || head.treeSize <= entry.seq) {
      head = await transparencyLog.sealTreeHead();
    }
    const proof = await transparencyLog.proofForReceipt(receiptId, head.treeSize);
    if (proof === undefined) {
      return ctx.json(
        error("No inclusion proof available yet.", "not_found_error"),
        404,
      );
    }
    return ctx.json({
      receipt_id: receiptId,
      proof: {
        leaf_index: proof.leafIndex,
        tree_size: proof.treeSize,
        node_hashes: proof.nodeHashes,
      },
      tree_head: {
        tree_size: head.treeSize,
        cose_base64: base64UrlEncode(head.coseBytes),
      },
    });
  });

  return router;
}
