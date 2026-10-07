// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The `Erasure_Receipt` payload (Requirements 2.11, 15).
 *
 * A receipt proves *what was forgotten, when and how much of it* — without
 * repeating any personal data. The subject appears only as
 * `sha256(tenantId + "|" + identifier)` (see `erasureSubjectHash`).
 *
 * Signing (this package defines the payload only; the runtime produces the
 * signature): canonical JSON with recursively sorted keys, UTF-8 bytes, signed
 * Ed25519 (`ERASURE_RECEIPT_SIGNING_KEY`); the documented fallback is the
 * audit-anchor HMAC. The algorithm used is recorded in the signed envelope's
 * `alg` field, not in the payload, so the payload stays byte-stable across
 * key rotations.
 */

import { z } from "zod";

import { ErasureScopeSchema, ErasureStoreResultSchema } from "./erasure.js";

/** Discriminator placed in the signed envelope / COSE type. */
export const ERASURE_RECEIPT_TYPE = "atf-erasure-receipt/1.0.0" as const;

/**
 * Payload of an erasure receipt. `subjectHashes` holds one hash per subject
 * identifier that was part of the request (userId, email, each external id);
 * for `scope=tenant` it is empty — the tenant id alone identifies the scope.
 */
export const ErasureReceiptPayloadSchema = z.object({
	/** Stable receipt id — also the lookup key of `GET /v1/me/data/erasures/{id}`. */
	receiptId: z.string().uuid(),
	/** The idempotency key of the originating `ErasureRequest`. */
	requestId: z.string().uuid(),
	tenantId: z.string().min(1),
	scope: ErasureScopeSchema,
	/** `sha256(tenantId + "|" + identifier)`, lowercase hex — never cleartext. */
	subjectHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).default([]),
	/** ISO-8601 UTC instant the erasure completed. */
	completedAt: z.string().datetime(),
	/** Per-store counts and statuses, merged across all services. */
	results: z.array(ErasureStoreResultSchema).min(1),
	/** `complete` iff every store is `ok` or deliberately `not_configured`. */
	status: z.enum(["complete", "partial"]),
});

export type ErasureReceiptPayload = z.infer<typeof ErasureReceiptPayloadSchema>;

/**
 * Canonical JSON: object keys sorted recursively (UTF-16 code-unit order,
 * which matches byte order for the ASCII-only key set of this contract),
 * no insignificant whitespace, `undefined` members omitted. Arrays keep their
 * order. The result is the exact byte source for signing and verification.
 */
export function canonicalizeJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => canonicalize(item) ?? null);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const item = (value as Record<string, unknown>)[key];
			if (item === undefined) continue;
			out[key] = canonicalize(item);
		}
		return out;
	}
	return value;
}
