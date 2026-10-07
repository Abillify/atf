// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * @atf/erasure-contract
 *
 * The cross-service erasure (DSAR) contract. One normative definition of the
 * erasure request, the per-store result, the service response and the signed
 * `Erasure_Receipt` payload — shared by the orchestrator (`@atf/runtime`) and
 * every store that must forget (`@atf/search`, `@atf/extract`, `@atf/gate`).
 *
 * Endpoints (all service-auth, scope `*.erasure`, idempotent over `requestId`):
 *
 * - Search:  `POST /v1/erasure` → document cascade + `vs_search_stats` + ledger.
 * - Extract: `POST /v1/erasure` → jobs, uploads, page images, persistence, then
 *   the Search cascade for referenced documents.
 * - Gate:    `POST /v1/erasure` → redaction / deletion in the persistent audit
 *   sink where it is not append-only.
 *
 * The receipt never contains subject data in cleartext — only the subject hash
 * `sha256(tenantId + "|" + userId)` (or the hash of the email / external id).
 */

export {
	ERASURE_CONTRACT_ID,
	ERASURE_CONTRACT_VERSION,
	ErasureRequestSchema,
	ErasureResponseSchema,
	ErasureScopeSchema,
	ErasureStoreResultSchema,
	erasureSubjectHash,
	type ErasureRequest,
	type ErasureResponse,
	type ErasureScope,
	type ErasureStoreResult,
	type ErasureSubject,
} from "./erasure.js";

export {
	ERASURE_RECEIPT_TYPE,
	ErasureReceiptPayloadSchema,
	canonicalizeJson,
	type ErasureReceiptPayload,
} from "./receipt.js";
