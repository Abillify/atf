// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/erasure.ts — `POST /v1/erasure` (task 4.6, requirements 2.7, 2.12).
 *
 * Subject-related erasure for the Extract store, part of the platform-wide
 * DSAR flow orchestrated by the Runtime (`compliance/erasure-orchestrator.ts`).
 * The request/response shape is the shared `@atf/erasure-contract`; the route
 * sits behind service auth with the `extract.erasure` scope and is idempotent
 * over `requestId` through `extract.erasure_ledger`.
 *
 * What is erased, per scope:
 *
 *  - `subject`: every job whose `created_by_subject` matches one of the
 *    subject identifiers *within* the request tenant, the upload sessions of
 *    those jobs' references, and — once no job row references a source digest
 *    any more — the content-addressed source blob itself.
 *  - `reference`: every job for a listed reference plus its upload sessions
 *    and orphaned source blobs. The Search cascade runs with the same
 *    `requestId`, so a retry stays idempotent on both sides.
 *  - `tenant`: every job of the tenant and every upload session.
 *
 * Honesty rules (requirement 2.10 applies to every store, not just the
 * orchestrator):
 *
 *  - A store result reports what was *actually* removed. `dryRun` counts and
 *    deletes nothing.
 *  - The Search cascade is a real dependency: when Search is unreachable the
 *    `search.documents` result is `failed` with the error, and the HTTP status
 *    drops to 207/502 — Extract never reports a DSAR as complete while the
 *    indexed copies still exist (requirement 2.12).
 *  - Without a configured Search target the cascade is `not_configured`,
 *    which is truthful and never counts as a failure.
 *  - Upload sessions carry no tenant/subject column (they predate identity).
 *    For a subject erasure their rows are matched through the references of
 *    the subject's jobs; that is the only attribution the schema supports,
 *    and the count reflects exactly the rows removed.
 *
 * Source-blob deletion is dedup-safe: a digest is only removed when *no*
 * remaining job row references it — two uploads of identical bytes share one
 * content-addressed object, and deleting it under a live job would break its
 * reproducibility.
 */

import { createHash } from "node:crypto";
import {
	canonicalizeJson,
	type ErasureRequest,
	ErasureRequestSchema,
	type ErasureResponse,
	type ErasureStoreResult,
} from "@atf/erasure-contract";
import type { RequestHandler } from "express";
import type { Logger } from "pino";
import type { ErasureJobTargetFilter } from "../persistence/extract-queries.js";
import type { ExtractStore } from "../persistence/index.js";
import type { ErasureJobTargetRow } from "../persistence/types.js";
import { getPrincipal, type RequestPrincipal } from "../request-principal.js";
import type { SearchClient } from "../search-client.js";
import type { SourceStore } from "../source-store.js";
import { removeDerivedPdfsFor } from "../jobs/derived-pdf-cache.js";
import {
	orphanedSourceDigests,
	removeSessionFiles as removeUploadSessionFiles,
} from "../jobs/job-retention.js";

/** The fingerprint of an erasure invocation — same shape as Search's. */
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

export interface ErasureHandlerOptions {
	store: ExtractStore;
	/** Content-addressed source blobs; `remove` deletes orphaned ones. */
	sourceStore: SourceStore;
	/** Null when no Search target is configured → cascade is `not_configured`. */
	searchClient: SearchClient | null;
	logger: Logger;
	/** Directory of resumable-upload session files (`<uploadId>.part`). */
	tmpDir?: string;
	/**
	 * Directory of the derived-PDF cache (`TEMP_DIR/derived-pdf`). Converted
	 * documents cached there are removed for every source digest the erasure
	 * deletes jobs for. Omit when the cache is disabled.
	 */
	derivedPdfCacheDir?: string;
}

const STORE_JOBS = "extract.jobs";
const STORE_UPLOADS = "extract.uploads";
const STORE_SOURCES = "extract.sources";
const STORE_DERIVED_PDFS = "extract.derived_pdf_cache";
const STORE_SEARCH = "search.documents";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Every non-empty subject identifier the request carries. */
function subjectIdentifiers(request: ErasureRequest): string[] {
	const subject = request.subject;
	if (!subject) return [];
	const raw = [subject.userId, subject.email, ...subject.externalIds];
	return [
		...new Set(
			raw
				.filter((v): v is string => typeof v === "string" && v.trim() !== "")
				.map((v) => v.trim()),
		),
	];
}

/** Map the erasure request onto the job-table filter (tenant always wins). */
function jobFilterFor(
	request: ErasureRequest,
	tenantId: string,
): ErasureJobTargetFilter {
	switch (request.scope) {
		case "subject":
			return {
				scope: "subject",
				tenantId,
				identifiers: subjectIdentifiers(request),
			};
		case "tenant":
			return { scope: "tenant", tenantId };
		case "reference":
			return { scope: "reference", references: request.references ?? [] };
	}
}

export function createErasureHandler(
	options: ErasureHandlerOptions,
): RequestHandler {
	const { store, sourceStore, searchClient, logger, tmpDir, derivedPdfCacheDir } =
		options;

	/** Remove the `<uploadId>.part` scratch files of erased upload sessions. */
	const removeSessionFiles = (uploadIds: string[]): Promise<void> =>
		removeUploadSessionFiles(tmpDir, uploadIds, logger);

	/**
	 * Delete source blobs orphaned by the job deletion: digests the erased jobs
	 * referenced that NO remaining job row references any more.
	 */
	async function eraseOrphanedSources(
		erasedJobs: ErasureJobTargetRow[],
	): Promise<ErasureStoreResult> {
		try {
			const orphans = await orphanedSourceDigests(store, erasedJobs);
			let removed = 0;
			for (const digest of orphans) {
				if ((await sourceStore.remove?.(digest)) === true) removed += 1;
			}
			return { store: STORE_SOURCES, status: "ok", erased: removed };
		} catch (err) {
			return {
				store: STORE_SOURCES,
				status: "failed",
				erased: 0,
				error: errorMessage(err),
			};
		}
	}

	/**
	 * Remove the cached PDF conversions of every source the erased jobs held.
	 * Unlike the source blob this does not wait for the digest to be orphaned:
	 * a conversion is only a cache, and another job on the same bytes simply
	 * re-converts.
	 */
	async function eraseDerivedPdfs(
		erasedJobs: ErasureJobTargetRow[],
	): Promise<ErasureStoreResult> {
		try {
			const removed = await removeDerivedPdfsFor(
				derivedPdfCacheDir ?? "",
				erasedJobs.map((job) => job.source_sha256),
			);
			return { store: STORE_DERIVED_PDFS, status: "ok", erased: removed };
		} catch (err) {
			return {
				store: STORE_DERIVED_PDFS,
				status: "failed",
				erased: 0,
				error: errorMessage(err),
			};
		}
	}

	/** The data-level erasure: jobs, uploads, sources. Never throws. */
	async function eraseExtractData(
		request: ErasureRequest,
		tenantId: string,
	): Promise<ErasureStoreResult[]> {
		const filter = jobFilterFor(request, tenantId);
		const results: ErasureStoreResult[] = [];

		// ── jobs ────────────────────────────────────────────────────────────────
		let erasedJobs: ErasureJobTargetRow[] = [];
		let jobsFailed = false;
		try {
			if (request.dryRun) {
				const count = await store.erasureJobCount(filter);
				results.push({ store: STORE_JOBS, status: "ok", erased: count });
			} else {
				erasedJobs = await store.eraseJobs(filter);
				results.push({
					store: STORE_JOBS,
					status: "ok",
					erased: erasedJobs.length,
				});
			}
		} catch (err) {
			jobsFailed = true;
			results.push({
				store: STORE_JOBS,
				status: "failed",
				erased: 0,
				error: errorMessage(err),
			});
		}

		// ── uploads ─────────────────────────────────────────────────────────────
		// Upload sessions have no tenant/subject column; the honest attribution is
		// through the references of the targeted jobs (subject/reference scope) or
		// every session (tenant scope — the whole instance belongs to one tenant).
		try {
			if (jobsFailed && request.scope === "subject") {
				// Without the job rows there is no honest attribution for the
				// sessions; reporting ok/0 would claim a deletion that never ran.
				results.push({
					store: STORE_UPLOADS,
					status: "failed",
					erased: 0,
					error: "Upload erasure skipped: job erasure failed",
				});
			} else {
				let uploadCount = 0;
				let uploadIds: string[] = [];
				if (request.scope === "tenant") {
					if (request.dryRun) {
						uploadCount = await store.countAllUploads();
					} else {
						uploadIds = await store.eraseAllUploads();
						uploadCount = uploadIds.length;
					}
				} else {
					let references: string[];
					if (request.scope === "reference") {
						references = request.references ?? [];
					} else if (request.dryRun) {
						// A dry run never deleted the jobs, so the references have to come
						// from the target query itself — `erasedJobs` is empty here.
						const targets = await store.erasureJobTargets(filter);
						references = [...new Set(targets.map((job) => job.reference))];
					} else {
						references = [...new Set(erasedJobs.map((job) => job.reference))];
					}
					if (request.dryRun) {
						const found = await store.uploadsByReferences(references);
						uploadCount = found.length;
					} else {
						uploadIds = await store.eraseUploadsByReferences(references);
						uploadCount = uploadIds.length;
					}
				}
				if (!request.dryRun) await removeSessionFiles(uploadIds);
				results.push({
					store: STORE_UPLOADS,
					status: "ok",
					erased: uploadCount,
				});
			}
		} catch (err) {
			results.push({
				store: STORE_UPLOADS,
				status: "failed",
				erased: 0,
				error: errorMessage(err),
			});
		}

		// ── source blobs ────────────────────────────────────────────────────────
		if (request.dryRun) {
			// Dry-run cannot know which blobs *would* become orphaned without
			// deleting the jobs; report the honest zero and say so.
			results.push({ store: STORE_SOURCES, status: "ok", erased: 0 });
		} else if (jobsFailed) {
			// The digests come from the erased job rows; without them no blob may
			// be removed, and skipping is reported as a failure, not as ok/0.
			results.push({
				store: STORE_SOURCES,
				status: "failed",
				erased: 0,
				error: "Source erasure skipped: job erasure failed",
			});
		} else if (erasedJobs.length > 0) {
			results.push(await eraseOrphanedSources(erasedJobs));
		} else {
			results.push({ store: STORE_SOURCES, status: "ok", erased: 0 });
		}

		// ── derived-PDF cache ───────────────────────────────────────────────────
		if (derivedPdfCacheDir !== undefined) {
			if (request.dryRun) {
				results.push({ store: STORE_DERIVED_PDFS, status: "ok", erased: 0 });
			} else if (jobsFailed) {
				results.push({
					store: STORE_DERIVED_PDFS,
					status: "failed",
					erased: 0,
					error: "Derived-PDF erasure skipped: job erasure failed",
				});
			} else {
				results.push(await eraseDerivedPdfs(erasedJobs));
			}
		}

		return results;
	}

	/**
	 * The Search cascade (requirement 2.12). The same `requestId` goes over, so
	 * Search's ledger makes a retry idempotent on both sides. Search's `search.*`
	 * results are merged as-is — they are more precise than anything Extract
	 * could report about Search's tables.
	 */
	async function eraseSearchCascade(
		request: ErasureRequest,
		principal: RequestPrincipal,
	): Promise<ErasureStoreResult[]> {
		if (searchClient === null) {
			return [{ store: STORE_SEARCH, status: "not_configured", erased: 0 }];
		}
		try {
			const response = await searchClient.erase({
				request,
				identity: {
					userId: principal.userId,
					userGroups: principal.userGroups,
				},
			});
			return response.results;
		} catch (err) {
			return [
				{
					store: STORE_SEARCH,
					status: "failed",
					erased: 0,
					error: `Search cascade: ${errorMessage(err)}`,
				},
			];
		}
	}

	return async (req, res, next) => {
		const log: Logger = (req as { log?: Logger }).log ?? logger;
		const parsed = ErasureRequestSchema.safeParse(req.body);
		if (!parsed.success) {
			res.status(400).json({
				error: "Invalid erasure request",
				code: "ERASURE_REQUEST_INVALID",
				issues: parsed.error.issues.map(
					(issue) => `${issue.path.join(".")}: ${issue.message}`,
				),
			});
			return;
		}
		const request = parsed.data;

		// The authenticated tenant always wins; a credential bound to a tenant may
		// only erase that tenant's data (same rule as Search's handler).
		const principal = getPrincipal(req);
		if (
			!principal.authorizationBypass &&
			principal.tenantId !== undefined &&
			principal.tenantId !== request.tenantId
		) {
			res.status(403).json({
				error: "The erasure target tenant does not match the credential tenant",
				code: "TENANT_MISMATCH",
			});
			return;
		}
		const tenantId = principal.tenantId ?? request.tenantId;

		const key = `erasure:${request.requestId}`;
		const fingerprint = erasureFingerprint(request);
		const claim = await store.claimErasure(key, fingerprint);
		if (claim.kind === "replay") {
			res.status(200).json(claim.record.result);
			return;
		}
		if (claim.kind === "mismatch" || claim.kind === "in_flight") {
			res.status(409).json({
				error:
					claim.kind === "mismatch"
						? "The requestId was already used with a different payload"
						: "An erasure with this requestId is already in flight",
				code:
					claim.kind === "mismatch"
						? "IDEMPOTENCY_KEY_MISMATCH"
						: "INVOCATION_IN_FLIGHT",
			});
			return;
		}
		// claimed | terminal — a terminal (failed) record is retried: every erasure
		// operation is idempotent at the data level. The ledger transition below is
		// best-effort for this case.
		const retryOfFailed = claim.kind === "terminal";
		if (!retryOfFailed) {
			await store.transitionErasure(key, fingerprint, "running");
		}

		try {
			const extractResults = await eraseExtractData(request, tenantId);
			const searchResults = await eraseSearchCascade(request, principal);

			// The HTTP status derives from the data stores only; `not_configured`
			// never counts as a failure (requirement 2.10).
			const dataResults = [...extractResults, ...searchResults];
			const failed = dataResults.filter((r) => r.status === "failed").length;
			const response: ErasureResponse = {
				requestId: request.requestId,
				service: "extract",
				results: dataResults,
			};
			const status =
				failed === 0 ? 200 : failed === dataResults.length ? 502 : 207;

			log.info(
				{
					requestId: request.requestId,
					tenantId,
					scope: request.scope,
					dryRun: request.dryRun,
					results: dataResults,
				},
				"Extract erasure completed",
			);

			try {
				await store.transitionErasure(key, fingerprint, "committed", response);
			} catch (err) {
				if (!retryOfFailed) throw err;
				log.debug(
					{ err, requestId: request.requestId },
					"erasure retry could not re-commit the failed ledger record",
				);
			}
			res.status(status).json(response);
		} catch (err) {
			if (!retryOfFailed) {
				await store
					.transitionErasure(key, fingerprint, "failed")
					.catch(() => undefined);
			}
			next(err);
		}
	};
}
