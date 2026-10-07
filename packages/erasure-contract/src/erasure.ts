// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Request / result / response schemas for the `POST /v1/erasure` endpoints.
 *
 * The shapes are the ones fixed by the platform-hardening design; services
 * must not widen them locally. Idempotency is keyed on `requestId`: a service
 * that already completed a request returns the original result instead of
 * erasing twice.
 */

import { createHash } from "node:crypto";

import { z } from "zod";

/** Contract identity, for logging and diagnostics. */
export const ERASURE_CONTRACT_ID = "atf-erasure/1.0.0" as const;
export const ERASURE_CONTRACT_VERSION = "1.0.0" as const;

/**
 * What to forget:
 * - `subject`   — all data of one subject (userId / email / external ids)
 * - `tenant`    — everything belonging to a tenant (offboarding)
 * - `reference` — the documents behind the given references only
 */
export const ErasureScopeSchema = z.enum(["subject", "tenant", "reference"]);
export type ErasureScope = z.infer<typeof ErasureScopeSchema>;

/** Subject identifiers; at least one must be present for `scope=subject`. */
export const ErasureSubjectInnerSchema = z
	.object({
		userId: z.string().optional(),
		email: z.string().optional(),
		externalIds: z.array(z.string()).default([]),
	})
	.refine(
		(s) => s.userId !== undefined || s.email !== undefined || s.externalIds.length > 0,
		{ message: "subject requires at least one of userId, email or externalIds" },
	);

export type ErasureSubject = z.infer<typeof ErasureSubjectInnerSchema>;

export const ErasureRequestSchema = z
	.object({
		requestId: z.string().uuid(),
		tenantId: z.string().min(1),
		subject: z
			.object({
				userId: z.string().optional(),
				email: z.string().optional(),
				externalIds: z.array(z.string()).default([]),
			})
			.optional(),
		scope: ErasureScopeSchema,
		references: z.array(z.string()).optional(),
		dryRun: z.boolean().default(false),
	})
	.superRefine((req, ctx) => {
		if (req.scope === "subject" && req.subject === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["subject"],
				message: "scope=subject requires a subject",
			});
		}
		if (req.scope === "subject" && req.subject !== undefined) {
			const hasId =
				req.subject.userId !== undefined ||
				req.subject.email !== undefined ||
				req.subject.externalIds.length > 0;
			if (!hasId) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["subject"],
					message: "subject requires at least one of userId, email or externalIds",
				});
			}
		}
		if (req.scope === "reference" && (req.references === undefined || req.references.length === 0)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["references"],
				message: "scope=reference requires at least one reference",
			});
		}
	});

export type ErasureRequest = z.infer<typeof ErasureRequestSchema>;

/**
 * Result per logical store (e.g. `search.chunks`, `search.identifiers`,
 * `extract.jobs`). `not_configured` is a *deliberate* state — the orchestrator
 * still reports overall `ok` for it, so a service without an optional store
 * does not fail every DSAR.
 */
export const ErasureStoreResultSchema = z.object({
	store: z.string(),
	status: z.enum(["ok", "failed", "not_configured"]),
	erased: z.number().int().nonnegative(),
	error: z.string().optional(),
});

export type ErasureStoreResult = z.infer<typeof ErasureStoreResultSchema>;

/** Response of one service; the orchestrator merges all of them. */
export const ErasureResponseSchema = z.object({
	requestId: z.string(),
	service: z.string(),
	results: z.array(ErasureStoreResultSchema),
});

export type ErasureResponse = z.infer<typeof ErasureResponseSchema>;

/**
 * Canonical subject hash for receipts and logs:
 * `sha256(tenantId + "|" + identifier)` as lowercase hex. The raw identifier
 * must never appear in a receipt.
 */
export function erasureSubjectHash(tenantId: string, identifier: string): string {
	return createHash("sha256").update(`${tenantId}|${identifier}`, "utf8").digest("hex");
}
