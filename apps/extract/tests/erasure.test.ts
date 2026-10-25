// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * erasure.test.ts — `POST /v1/erasure` (task 4.6, requirements 2.7, 2.12).
 *
 * Runs against the real router mounted by `createApp` with the in-memory job
 * store (including its ledger/upload model), a recording Search stub, and an
 * in-memory source store that records which content-addressed blobs were
 * removed. The cases cover the honest-reporting rules: per-store results,
 * dry-run counting without deleting, idempotent replay over `requestId`,
 * the 409 mismatch, the tenant check on the credential, the Search cascade
 * (merged results, 207 on partial failure, 502 when everything failed,
 * `not_configured` without a Search target), and dedup-safe source deletion.
 */

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ErasureRequest, ErasureResponse } from "@atf/erasure-contract";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AppOverrides, createApp } from "../src/index.js";
import type { NewJob } from "../src/persistence/types.js";
import type { SourceStore } from "../src/source-store.js";
import {
	loadTestConfig,
	stubExtractor,
	stubSearchClient,
	stubVisionClient,
	testLogger,
} from "./helpers.js";
import { createFakeJobStore, type FakeJobStore } from "./job-store-fake.js";

const availableBinary = vi.fn(async () => ({
	available: true,
	version: "stub",
}));

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** One stable loopback socket per test (see documents.test.ts, serve()). */
async function serve(
	app: ReturnType<typeof createApp>["app"],
): Promise<string> {
	const server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("test server did not bind to a TCP port");
	}
	return `http://127.0.0.1:${address.port}`;
}

async function buildApp(
	configOverrides: Record<string, string | undefined> = {},
	overrides: AppOverrides = {},
): Promise<string> {
	const config = loadTestConfig(configOverrides);
	const created = createApp(config, {
		logger: testLogger,
		vision: stubVisionClient(),
		extractor: stubExtractor(),
		probeBinary: availableBinary,
		...overrides,
	});
	cleanups.push(created.cleanup);
	return serve(created.app);
}

/** A source store that only models `remove`, recording the deleted digests. */
function recordingSourceStore(): SourceStore & { removed: string[] } {
	const removed: string[] = [];
	const unsupported = () => {
		throw new Error("not implemented in the recording source store");
	};
	return {
		removed,
		has: async () => true,
		locate: async () => null,
		commitFile: unsupported,
		putStream: unsupported,
		async remove(sha256) {
			removed.push(sha256);
			return true;
		},
	};
}

function subjectRequest(
	overrides: Partial<ErasureRequest> = {},
): ErasureRequest {
	return {
		requestId: randomUUID(),
		tenantId: "default",
		subject: { userId: "u1", externalIds: [] },
		scope: "subject",
		dryRun: false,
		...overrides,
	};
}

function seedJob(
	store: FakeJobStore,
	overrides: Partial<NewJob> & { reference: string },
): string {
	const id = randomUUID();
	void store.createJob({
		id,
		source_sha256: "a".repeat(64),
		...overrides,
	});
	return id;
}

const ledgerKey = (requestId: string): string => `erasure:${requestId}`;

// ── Request validation ───────────────────────────────────────────────────────

describe("POST /v1/erasure · validation", () => {
	it("400 for a subject-scope request without a subject", async () => {
		const base = await buildApp({}, { store: createFakeJobStore() });
		const res = await request(base)
			.post("/v1/erasure")
			.send({ requestId: randomUUID(), tenantId: "default", scope: "subject" });
		expect(res.status).toBe(400);
		expect(res.body.code).toBe("ERASURE_REQUEST_INVALID");
	});

	it("401 without a credential when authn is enabled", async () => {
		const base = await buildApp(
			{
				AUTHN_MODE: "token",
				AUTHZ_ENABLED: "true",
				API_TOKEN: "e".repeat(40),
				API_SERVICE_SCOPES: "extract.erasure",
			},
			{ store: createFakeJobStore() },
		);
		const res = await request(base).post("/v1/erasure").send(subjectRequest());
		expect(res.status).toBe(401);
	});

	it("403 when the credential lacks the extract.erasure scope", async () => {
		const token = "e".repeat(40);
		const base = await buildApp(
			{
				AUTHN_MODE: "token",
				AUTHZ_ENABLED: "true",
				API_TOKEN: token,
				API_SERVICE_SCOPES: "extract.ingest",
			},
			{ store: createFakeJobStore() },
		);
		const res = await request(base)
			.post("/v1/erasure")
			.set("Authorization", `Bearer ${token}`)
			.send(subjectRequest());
		expect(res.status).toBe(403);
		expect(res.body.code).toBe("FORBIDDEN");
	});

	it("403 TENANT_MISMATCH when the credential tenant differs", async () => {
		const token = "e".repeat(40);
		const base = await buildApp(
			{
				AUTHN_MODE: "token",
				AUTHZ_ENABLED: "true",
				TENANT_ISOLATION_ENABLED: "true",
				API_TOKEN: token,
				API_SERVICE_SCOPES: "extract.erasure",
				API_SERVICE_TENANT_ID: "acme",
			},
			{ store: createFakeJobStore() },
		);
		const res = await request(base)
			.post("/v1/erasure")
			.set("Authorization", `Bearer ${token}`)
			.send(subjectRequest({ tenantId: "other-corp" }));
		expect(res.status).toBe(403);
		expect(res.body.code).toBe("TENANT_MISMATCH");
	});
});

// ── Subject scope: jobs, uploads, sources, cascade ───────────────────────────

describe("POST /v1/erasure · subject scope", () => {
	it("erases the subject's jobs, upload sessions, orphaned blobs, cascades to Search", async () => {
		const store = createFakeJobStore();
		const sources = recordingSourceStore();
		const search = stubSearchClient();
		const otherDigest = "b".repeat(64);
		seedJob(store, {
			reference: "dossier-a.pdf",
			source_sha256: "a".repeat(64),
			created_by_subject: "u1",
			created_by_tenant: "default",
		});
		seedJob(store, {
			reference: "dossier-b.pdf",
			source_sha256: otherDigest,
			created_by_subject: "u1",
			created_by_tenant: "default",
		});
		seedJob(store, {
			reference: "fremd.pdf",
			source_sha256: "c".repeat(64),
			created_by_subject: "u2",
			created_by_tenant: "default",
		});
		store.seedUpload(randomUUID(), "dossier-a.pdf");
		store.seedUpload(randomUUID(), "fremd.pdf");

		const base = await buildApp(
			{},
			{ store, sourceStore: sources, searchClient: search },
		);
		const body = subjectRequest();
		const res = await request(base).post("/v1/erasure").send(body);

		expect(res.status).toBe(200);
		const payload = res.body as ErasureResponse;
		expect(payload.service).toBe("extract");
		expect(payload.requestId).toBe(body.requestId);
		const byStore = new Map(payload.results.map((r) => [r.store, r]));
		expect(byStore.get("extract.jobs")).toEqual({
			store: "extract.jobs",
			status: "ok",
			erased: 2,
		});
		expect(byStore.get("extract.uploads")).toEqual({
			store: "extract.uploads",
			status: "ok",
			erased: 1,
		});
		expect(byStore.get("extract.sources")).toEqual({
			store: "extract.sources",
			status: "ok",
			erased: 2,
		});
		// Search's own results are merged verbatim.
		expect(byStore.get("search.documents")?.status).toBe("ok");
		expect(sources.removed.sort()).toEqual(["a".repeat(64), otherDigest]);
		expect(search.eraseCalls).toHaveLength(1);
		expect(search.eraseCalls[0]?.request.requestId).toBe(body.requestId);
		// The foreign job and its upload session survive.
		expect(store.peekUploads().map((u) => u.reference)).toEqual(["fremd.pdf"]);
		const remaining = [...store.peekUploads()];
		expect(remaining).toHaveLength(1);
	});

	it("keeps a source blob that a surviving job still references (dedup safety)", async () => {
		const store = createFakeJobStore();
		const sources = recordingSourceStore();
		const shared = "d".repeat(64);
		seedJob(store, {
			reference: "geteilt-1.pdf",
			source_sha256: shared,
			created_by_subject: "u1",
			created_by_tenant: "default",
		});
		seedJob(store, {
			reference: "geteilt-2.pdf",
			source_sha256: shared,
			created_by_subject: "u2",
			created_by_tenant: "default",
		});
		const base = await buildApp(
			{},
			{ store, sourceStore: sources, searchClient: stubSearchClient() },
		);

		const first = await request(base)
			.post("/v1/erasure")
			.send(subjectRequest());
		expect(first.status).toBe(200);
		const firstSources = (first.body as ErasureResponse).results.find(
			(r) => r.store === "extract.sources",
		);
		expect(firstSources).toEqual({
			store: "extract.sources",
			status: "ok",
			erased: 0,
		});
		expect(sources.removed).toEqual([]);

		const second = await request(base)
			.post("/v1/erasure")
			.send(subjectRequest({ subject: { userId: "u2", externalIds: [] } }));
		expect(second.status).toBe(200);
		const secondSources = (second.body as ErasureResponse).results.find(
			(r) => r.store === "extract.sources",
		);
		expect(secondSources).toEqual({
			store: "extract.sources",
			status: "ok",
			erased: 1,
		});
		expect(sources.removed).toEqual([shared]);
	});

	it("dryRun counts jobs and uploads without deleting anything", async () => {
		const store = createFakeJobStore();
		const sources = recordingSourceStore();
		const search = stubSearchClient();
		const jobId = seedJob(store, {
			reference: "geheim.pdf",
			source_sha256: "e".repeat(64),
			created_by_subject: "u1",
			created_by_tenant: "default",
		});
		store.seedUpload(randomUUID(), "geheim.pdf");
		const base = await buildApp(
			{},
			{ store, sourceStore: sources, searchClient: search },
		);

		const res = await request(base)
			.post("/v1/erasure")
			.send(subjectRequest({ dryRun: true }));

		expect(res.status).toBe(200);
		const byStore = new Map(
			(res.body as ErasureResponse).results.map((r) => [r.store, r]),
		);
		expect(byStore.get("extract.jobs")).toEqual({
			store: "extract.jobs",
			status: "ok",
			erased: 1,
		});
		// D4 regression: the upload count must come from the target query, not
		// from the (empty) erased-jobs list.
		expect(byStore.get("extract.uploads")).toEqual({
			store: "extract.uploads",
			status: "ok",
			erased: 1,
		});
		expect(byStore.get("extract.sources")).toEqual({
			store: "extract.sources",
			status: "ok",
			erased: 0,
		});
		expect(store.peek(jobId)).toBeDefined();
		expect(store.peekUploads()).toHaveLength(1);
		expect(sources.removed).toEqual([]);
		// The dry-run flag travels with the cascade so Search counts too.
		expect(search.eraseCalls[0]?.request.dryRun).toBe(true);
	});

	it("removes the <uploadId>.part scratch files of erased sessions", async () => {
		const dir = await mkdtemp(join(tmpdir(), "atf-erasure-tmp-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const store = createFakeJobStore();
		const uploadId = randomUUID();
		store.seedUpload(uploadId, "hochgeladen.pdf");
		seedJob(store, {
			reference: "hochgeladen.pdf",
			created_by_subject: "u1",
			created_by_tenant: "default",
		});
		const partPath = join(dir, `${uploadId}.part`);
		await writeFile(partPath, "half a file");
		const base = await buildApp(
			{ UPLOAD_TMP_DIR: dir },
			{
				store,
				sourceStore: recordingSourceStore(),
				searchClient: stubSearchClient(),
			},
		);

		const res = await request(base).post("/v1/erasure").send(subjectRequest());
		expect(res.status).toBe(200);
		const uploads = (res.body as ErasureResponse).results.find(
			(r) => r.store === "extract.uploads",
		);
		expect(uploads?.erased).toBe(1);
		const { access } = await import("node:fs/promises");
		await expect(access(partPath)).rejects.toThrow();
	});
});

// ── Reference and tenant scope ───────────────────────────────────────────────

describe("POST /v1/erasure · reference and tenant scope", () => {
	it("reference scope deletes exactly the listed references", async () => {
		const store = createFakeJobStore();
		seedJob(store, {
			reference: "a.pdf",
			created_by_subject: "u1",
			created_by_tenant: "t1",
		});
		seedJob(store, {
			reference: "b.pdf",
			created_by_subject: "u2",
			created_by_tenant: "t1",
		});
		store.seedUpload(randomUUID(), "a.pdf");
		const base = await buildApp(
			{},
			{
				store,
				sourceStore: recordingSourceStore(),
				searchClient: stubSearchClient(),
			},
		);

		const res = await request(base)
			.post("/v1/erasure")
			.send(subjectRequest({ scope: "reference", references: ["a.pdf"] }));
		expect(res.status).toBe(200);
		const byStore = new Map(
			(res.body as ErasureResponse).results.map((r) => [r.store, r]),
		);
		expect(byStore.get("extract.jobs")?.erased).toBe(1);
		expect(byStore.get("extract.uploads")?.erased).toBe(1);
		expect(store.peekUploads()).toHaveLength(0);
	});

	it("tenant scope deletes the tenant's jobs and every upload session", async () => {
		const store = createFakeJobStore();
		seedJob(store, {
			reference: "eins.pdf",
			created_by_subject: "u1",
			created_by_tenant: "default",
		});
		seedJob(store, {
			reference: "zwei.pdf",
			created_by_subject: "u9",
			created_by_tenant: "default",
		});
		const foreignId = seedJob(store, {
			reference: "fremd.pdf",
			created_by_subject: "x",
			created_by_tenant: "andere-firma",
		});
		store.seedUpload(randomUUID(), "eins.pdf");
		store.seedUpload(randomUUID(), "session-ohne-job");
		const base = await buildApp(
			{},
			{
				store,
				sourceStore: recordingSourceStore(),
				searchClient: stubSearchClient(),
			},
		);

		const dry = await request(base)
			.post("/v1/erasure")
			.send(subjectRequest({ scope: "tenant", dryRun: true }));
		expect(dry.status).toBe(200);
		const dryStores = new Map(
			(dry.body as ErasureResponse).results.map((r) => [r.store, r]),
		);
		expect(dryStores.get("extract.jobs")?.erased).toBe(2);
		expect(dryStores.get("extract.uploads")?.erased).toBe(2);
		expect(store.peekUploads()).toHaveLength(2);

		const real = await request(base)
			.post("/v1/erasure")
			.send(subjectRequest({ scope: "tenant" }));
		expect(real.status).toBe(200);
		const stores = new Map(
			(real.body as ErasureResponse).results.map((r) => [r.store, r]),
		);
		expect(stores.get("extract.jobs")?.erased).toBe(2);
		expect(stores.get("extract.uploads")?.erased).toBe(2);
		expect(store.peekUploads()).toHaveLength(0);
		// The other tenant's job is untouched.
		expect(store.peek(foreignId)).toBeDefined();
	});
});

// ── Idempotency over requestId ───────────────────────────────────────────────

describe("POST /v1/erasure · idempotency", () => {
	it("replays the stored result for a repeated requestId without re-running", async () => {
		const store = createFakeJobStore();
		const search = stubSearchClient();
		seedJob(store, {
			reference: "einmal.pdf",
			created_by_subject: "u1",
			created_by_tenant: "default",
		});
		const base = await buildApp(
			{},
			{ store, sourceStore: recordingSourceStore(), searchClient: search },
		);

		const body = subjectRequest();
		const first = await request(base).post("/v1/erasure").send(body);
		expect(first.status).toBe(200);
		expect(store.peekErasureLedger(ledgerKey(body.requestId))?.state).toBe(
			"committed",
		);

		const second = await request(base).post("/v1/erasure").send(body);
		expect(second.status).toBe(200);
		expect(second.body).toEqual(first.body);
		// The replay short-circuits: Search is not called a second time.
		expect(search.eraseCalls).toHaveLength(1);
	});

	it("409 IDEMPOTENCY_KEY_MISMATCH for the same requestId with a different payload", async () => {
		const store = createFakeJobStore();
		const base = await buildApp(
			{},
			{
				store,
				sourceStore: recordingSourceStore(),
				searchClient: stubSearchClient(),
			},
		);
		const body = subjectRequest();
		const first = await request(base).post("/v1/erasure").send(body);
		expect(first.status).toBe(200);

		const conflict = await request(base)
			.post("/v1/erasure")
			.send({ ...body, scope: "reference", references: ["x.pdf"] });
		expect(conflict.status).toBe(409);
		expect(conflict.body.code).toBe("IDEMPOTENCY_KEY_MISMATCH");
	});

	it("retries a failed erasure when the requestId is repeated", async () => {
		const store = createFakeJobStore();
		const search = stubSearchClient();
		seedJob(store, {
			reference: "retry.pdf",
			created_by_subject: "u1",
			created_by_tenant: "default",
		});
		const base = await buildApp(
			{},
			{ store, sourceStore: recordingSourceStore(), searchClient: search },
		);

		// skip=1: the `running` transition succeeds, the `committed` one faults —
		// the attempt fails after the data work (5xx via next(err)) and the record
		// lands in `failed`.
		store.failNext("transitionErasure", undefined, 1);
		const body = subjectRequest();
		const failed = await request(base).post("/v1/erasure").send(body);
		expect(failed.status).toBe(500);

		const retry = await request(base).post("/v1/erasure").send(body);
		expect(retry.status).toBe(200);
		// The terminal record is retried at the data level; the cascade runs again
		// (Search's own ledger keeps its side idempotent).
		expect(search.eraseCalls).toHaveLength(2);
	});
});

// ── Honest status codes for partial and total failure ────────────────────────

describe("POST /v1/erasure · failure reporting", () => {
	it("207 when the Search cascade fails but Extract's stores succeeded", async () => {
		const store = createFakeJobStore();
		seedJob(store, {
			reference: "indexiert.pdf",
			created_by_subject: "u1",
			created_by_tenant: "default",
		});
		const search = stubSearchClient({
			eraseError: new Error("search unreachable"),
		});
		const base = await buildApp(
			{},
			{ store, sourceStore: recordingSourceStore(), searchClient: search },
		);

		const res = await request(base).post("/v1/erasure").send(subjectRequest());
		expect(res.status).toBe(207);
		const byStore = new Map(
			(res.body as ErasureResponse).results.map((r) => [r.store, r]),
		);
		expect(byStore.get("extract.jobs")?.status).toBe("ok");
		const cascade = byStore.get("search.documents");
		expect(cascade?.status).toBe("failed");
		expect(cascade?.error).toContain("Search cascade: search unreachable");
	});

	it("502 when every store failed", async () => {
		const store = createFakeJobStore();
		seedJob(store, {
			reference: "alles-fehlt.pdf",
			created_by_subject: "u1",
			created_by_tenant: "default",
		});
		store.failNext("eraseJobs");
		const search = stubSearchClient({ eraseError: new Error("search down") });
		const base = await buildApp(
			{},
			{ store, sourceStore: recordingSourceStore(), searchClient: search },
		);

		const res = await request(base).post("/v1/erasure").send(subjectRequest());
		expect(res.status).toBe(502);
		const results = (res.body as ErasureResponse).results;
		expect(results.every((r) => r.status === "failed")).toBe(true);
		// The skipped dependent stores say so instead of claiming ok/0.
		const uploads = results.find((r) => r.store === "extract.uploads");
		expect(uploads?.error).toContain("skipped");
		const sources = results.find((r) => r.store === "extract.sources");
		expect(sources?.error).toContain("skipped");
	});

	it("not_configured for the cascade without a Search target — still 200", async () => {
		const store = createFakeJobStore();
		seedJob(store, {
			reference: "nur-extract.pdf",
			created_by_subject: "u1",
			created_by_tenant: "default",
		});
		const base = await buildApp(
			{},
			{ store, sourceStore: recordingSourceStore(), searchClient: null },
		);

		const res = await request(base).post("/v1/erasure").send(subjectRequest());
		expect(res.status).toBe(200);
		const cascade = (res.body as ErasureResponse).results.find(
			(r) => r.store === "search.documents",
		);
		expect(cascade).toEqual({
			store: "search.documents",
			status: "not_configured",
			erased: 0,
		});
	});
});
