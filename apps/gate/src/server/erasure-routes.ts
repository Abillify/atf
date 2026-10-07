// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHash } from "node:crypto";
import express, { Router } from "express";
import {
	canonicalizeJson,
	ErasureRequestSchema,
	type ErasureRequest,
	type ErasureResponse,
} from "@atf/erasure-contract";
import { AuthError, extractBearer, type Authenticator } from "../auth/authenticator.ts";
import type { AuthContext } from "../auth/context.ts";
import type { InvocationLedgerStore } from "../transaction/fabric.ts";
import type { ToolResult } from "../tools/types.ts";
import type { AuditSink } from "../monitor/audit.ts";
import { logger } from "../logger.ts";

/** Scope a caller needs to invoke the gate's erasure endpoint. */
export const GATE_ERASURE_SCOPE = "gate.erasure";

/**
 * Idempotency fingerprint over the ZOD-PARSED request (same canonical shape as
 * the search/extract stores: sha256 over sorted-key JSON of
 * {tool, args, executionId}). Parsing first means semantically equal bodies
 * (key order, absent-vs-default fields) collide on one fingerprint.
 */
export function erasureFingerprint(request: ErasureRequest): string {
	return createHash("sha256")
		.update(
			canonicalizeJson({
				tool: "erasure",
				args: request,
				executionId: request.requestId,
			}),
		)
		.digest("hex");
}

export interface ErasureRouterOptions {
	audit: AuditSink;
	ledger: InvocationLedgerStore;
	authenticator: Authenticator;
	tenantIsolationEnabled: boolean;
	authorizationEnabled: boolean;
}

/**
 * `POST /v1/erasure` — subject erasure in the persistent audit sink (Req 2.8).
 *
 * Service-auth endpoint on the shared erasure contract: bearer token with
 * scope `gate.erasure`, tenant-checked when isolation is enabled, idempotent
 * over `requestId` via the transaction ledger (replay returns the stored
 * response; a different body under a taken id is a 409). The sink itself
 * decides honestly between `ok`, `not_configured` (disabled / append-only) and
 * `failed`; a failed store surfaces as HTTP 502 so the orchestrator retries.
 */
export function createErasureRouter(options: ErasureRouterOptions): Router {
	const router = Router();
	const { audit, ledger, authenticator, tenantIsolationEnabled, authorizationEnabled } = options;

	router.post(
		"/v1/erasure",
		express.json({ limit: "64kb" }),
		async (req, res, next) => {
			const parsed = ErasureRequestSchema.safeParse(req.body);
			if (!parsed.success) {
				res.status(400).json({
					error: "invalid erasure request",
					code: "ERASURE_REQUEST_INVALID",
					issues: parsed.error.issues.map(
						(issue) => `${issue.path.join(".")}: ${issue.message}`,
					),
				});
				return;
			}
			const request = parsed.data;

			let ctx: AuthContext;
			try {
				ctx = await authenticator.authenticate(
					extractBearer(req.headers.authorization),
					req.headers,
				);
			} catch (err) {
				if (err instanceof AuthError) {
					res
						.status(err.status)
						.json({ error: err.message, code: "AUTHENTICATION_FAILED" });
					return;
				}
				next(err);
				return;
			}

			if (authorizationEnabled && !ctx.scopes.includes(GATE_ERASURE_SCOPE)) {
				res.status(403).json({
					error: `missing scope ${GATE_ERASURE_SCOPE}`,
					code: "SCOPE_REQUIRED",
				});
				return;
			}
			if (tenantIsolationEnabled && ctx.tenantId !== request.tenantId) {
				res.status(403).json({
					error: "request tenantId does not match the authenticated tenant",
					code: "TENANT_MISMATCH",
				});
				return;
			}

			const key = `erasure:${request.requestId}`;
			const fingerprint = erasureFingerprint(request);
			try {
				const reservation = await ledger.reserve(key, fingerprint);
				switch (reservation.kind) {
					case "replay": {
						const stored = reservation.record.result?.structuredContent as
							| ErasureResponse
							| undefined;
						if (stored !== undefined) {
							res.status(200).json(stored);
							return;
						}
						// Committed without a recoverable payload — report, never redo blindly.
						res.status(500).json({
							error: "erasure replay has no stored response",
							code: "OUTCOME_UNKNOWN",
						});
						return;
					}
					case "conflict": {
						res.status(409).json({
							error: "requestId already used with a different payload",
							code: "IDEMPOTENCY_KEY_MISMATCH",
						});
						return;
					}
					case "in_flight": {
						res.status(409).json({
							error: "an erasure with this requestId is still running",
							code: "INVOCATION_IN_FLIGHT",
						});
						return;
					}
					case "unknown": {
						res.status(500).json({
							error: "previous erasure outcome is unknown — inspect before retrying",
							code: "OUTCOME_UNKNOWN",
						});
						return;
					}
					case "acquired":
						break;
				}

				await ledger.transition(key, "running");
				const result = await audit.erase(request, request.dryRun);
				const response: ErasureResponse = {
					requestId: request.requestId,
					service: "gate",
					results: [result],
				};
				const status = result.status === "failed" ? 502 : 200;
				const wrapped: ToolResult = {
					content: [{ type: "text", text: JSON.stringify(response) }],
					structuredContent: response,
				};
				await ledger.transition(key, "committed", wrapped);
				logger.info("erasure executed on gate audit sink", {
					requestId: request.requestId,
					store: result.store,
					storeStatus: result.status,
					erased: result.erased,
					dryRun: request.dryRun,
				});
				res.status(status).json(response);
			} catch (err) {
				// Best-effort: mark the invocation failed so a retry can re-acquire.
				await ledger.transition(key, "failed").catch(() => undefined);
				next(err);
			}
		},
	);

	return router;
}
