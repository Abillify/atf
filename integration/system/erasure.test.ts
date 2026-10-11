// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Erasure system test (platform-hardening Task 4.13, Requirements 2.9, 2.10, 2.12).
 *
 * Part A (self-contained, always runs): the real Runtime erasure
 * orchestrator runs against contract-conformant stub servers for Search,
 * Extract and Gate (one `POST /v1/erasure` each per `@atf/erasure-contract`).
 * Checked are the fan-out with per-store partial results, idempotency
 * via `requestId`, honest aggregation (partial on an outage) with a
 * subsequent retry, and the signed Erasure_Receipt (Req 2.11).
 *
 * Part B (live, env-gated like outpost.test.ts): Outpost MirrorDelete ->
 * Extract -> Search (a locally removed document must disappear from both
 * services) plus the Extract cascade via
 * `POST /v1/erasure` (scope=reference), which reports the Search result as
 * the partial result `search.documents` (Requirement 2.12).
 * Prerequisites (environment variables):
 *
 *   OUTPOST_IT_EXTRACT_URL   base URL of the Extract instance
 *   OUTPOST_IT_EXTRACT_TOKEN bearer token (extract.ingest, extract.delete;
 *                            extract.erasure only for the cascade check)
 *   OUTPOST_IT_SEARCH_URL    Search URL for the retrieval/delete check
 *
 * Run:
 *   bun test ./erasure.test.ts
 *   OUTPOST_IT_EXTRACT_URL=... OUTPOST_IT_EXTRACT_TOKEN=... \
 *     OUTPOST_IT_SEARCH_URL=... bun test ./erasure.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ERASURE_RECEIPT_TYPE,
	ErasureRequestSchema,
	ErasureResponseSchema,
	erasureSubjectHash,
	type ErasureRequest,
	type ErasureResponse,
	type ErasureStoreResult,
} from "../../packages/erasure-contract/src/index.ts";
import {
	createErasureOrchestrator,
	type ErasureOrchestrator,
} from "../../apps/runtime/src/compliance/erasure-orchestrator.ts";
import {
	hmacReceiptKey,
	verifyReceipt,
	type ErasureReceiptEnvelope,
} from "../../apps/runtime/src/compliance/erasure-receipt.ts";
import { RetentionService } from "../../apps/runtime/src/observability/retention.ts";
import { deriveReference } from "../../packages/outpost-core/src/sync/reference.ts";

function skip(why: string): void {
	console.log(`SKIP (erasure systemtest): ${why}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Part A: Runtime DSAR -> Search/Extract/Gate against contract stubs
// ─────────────────────────────────────────────────────────────────────────────

const STUB_TOKEN = "stub-erasure-token";
const RECEIPT_KEY = hmacReceiptKey("systemtest-anchor-secret-0123456789");
if (RECEIPT_KEY === undefined) throw new Error("Erasure-Key nicht verfuegbar");

type StubService = "search" | "extract" | "gate";

/** Counts the incoming erasure calls per stub (idempotency proof). */
const stubCalls: Record<StubService, number> = { search: 0, extract: 0, gate: 0 };

/** When true, the Gate stub answers 503 (partial-failure scenario). */
let gateFails = false;

/**
 * Per-store partial results of the stubs: Search reports unnamespaced (like the
 * real API; the orchestrator prefixes `search.`), Extract reports its own
 * stores plus the Search cascade `search.documents` (Requirement 2.12).
 */
function stubResults(service: StubService): ErasureStoreResult[] {
	switch (service) {
		case "search":
			return [
				{ store: "chunks", status: "ok", erased: 5 },
				{ store: "stats", status: "ok", erased: 2 },
			];
		case "extract":
			return [
				{ store: "extract.jobs", status: "ok", erased: 3 },
				{ store: "search.documents", status: "ok", erased: 5 },
			];
		case "gate":
			return [{ store: "audit", status: "ok", erased: 1 }];
	}
}

/**
 * Starts a contract-conformant `POST /v1/erasure` stub: checks the bearer
 * token and request schema and answers with a valid ErasureResponse.
 */
function startStubServer(service: StubService): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/erasure") {
				return new Response("not found", { status: 404 });
			}
			if ((req.headers.get("authorization") ?? "") !== `Bearer ${STUB_TOKEN}`) {
				return Response.json({ error: "unauthorized" }, { status: 401 });
			}
			const parsed = ErasureRequestSchema.safeParse(await req.json());
			if (!parsed.success) {
				return Response.json({ error: "malformed erasure request" }, { status: 400 });
			}
			stubCalls[service] += 1;
			if (service === "gate" && gateFails) {
				return Response.json({ error: "store unavailable" }, { status: 503 });
			}
			const body: ErasureResponse = {
				requestId: parsed.data.requestId,
				service,
				results: stubResults(service),
			};
			return Response.json(body);
		},
	});
}

describe("runtime-dsar -> search/extract/gate (system test 2.9, 2.10, 2.11, 2.12)", () => {
	let servers: Partial<Record<StubService, ReturnType<typeof Bun.serve>>> = {};
	let urls: Record<StubService, string> = { search: "", extract: "", gate: "" };

	/** Port of a started stub server; throws instead of a non-null assertion. */
	function serverPort(
		map: Partial<Record<StubService, ReturnType<typeof Bun.serve>>>,
		service: StubService,
	): number {
		const server = map[service];
		if (server === undefined) throw new Error(`Stub ${service} nicht gestartet`);
		const port = server.port;
		if (typeof port !== "number") throw new Error(`Stub ${service} ohne Port`);
		return port;
	}

	beforeAll(() => {
		servers = {
			search: startStubServer("search"),
			extract: startStubServer("extract"),
			gate: startStubServer("gate"),
		};
		urls = {
			search: `http://127.0.0.1:${serverPort(servers, "search")}/v1/erasure`,
			extract: `http://127.0.0.1:${serverPort(servers, "extract")}/v1/erasure`,
			gate: `http://127.0.0.1:${serverPort(servers, "gate")}/v1/erasure`,
		};
	});

	afterAll(() => {
		for (const server of Object.values(servers)) server?.stop();
		servers = {};
	});

	/** Orchestrator as in production: local retention target + three remote stores. */
	function makeOrchestrator(): ErasureOrchestrator {
		return createErasureOrchestrator({
			retention: new RetentionService([
				{ name: "runtime.sessions", eraseSubject: async () => 2 },
			]),
			targets: [
				{ service: "search", url: urls.search, tokenEnv: "ERASURE_IT_TOKEN" },
				{ service: "extract", url: urls.extract, tokenEnv: "ERASURE_IT_TOKEN" },
				{ service: "gate", url: urls.gate, tokenEnv: "ERASURE_IT_TOKEN" },
			],
			envLookup: () => STUB_TOKEN,
			attempts: 1,
			receiptKey: RECEIPT_KEY,
		});
	}

	function subjectRequest(): ErasureRequest {
		return {
			requestId: randomUUID(),
			tenantId: "acme-system",
			subject: { userId: "u-system-413", externalIds: [] },
			scope: "subject",
			dryRun: false,
		};
	}

	test("DSAR fans out to Search/Extract/Gate, per-store result, signed receipt (2.9, 2.11, 2.12)", async () => {
		const orch = makeOrchestrator();
		const request = subjectRequest();
		const op = await orch.execute(request);
		expect(op.status).toBe("complete");
		const byStore = new Map(op.results.map((r) => [r.store, r]));
		// Local Runtime target plus all three services with namespaced stores.
		expect(byStore.get("runtime.sessions")?.erased).toBe(2);
		expect(byStore.get("search.chunks")?.status).toBe("ok");
		expect(byStore.get("search.stats")?.erased).toBe(2);
		expect(byStore.get("extract.jobs")?.erased).toBe(3);
		// Extract reports the Search cascade as its own partial result (2.12).
		expect(byStore.get("search.documents")?.status).toBe("ok");
		expect(byStore.get("gate.audit")?.erased).toBe(1);
		expect(op.erased).toBe(2 + 5 + 2 + 3 + 5 + 1);
		// Signed Erasure_Receipt (2.11): verifiable, subject only as a hash.
		const envelope = op.receipt as ErasureReceiptEnvelope;
		expect(envelope.typ).toBe(ERASURE_RECEIPT_TYPE);
		expect(verifyReceipt(envelope, RECEIPT_KEY)).toBe(true);
		expect(envelope.payload.status).toBe("complete");
		expect(envelope.payload.subjectHashes).toContain(
			erasureSubjectHash("acme-system", "u-system-413"),
		);
		expect(JSON.stringify(envelope)).not.toContain("u-system-413");
	});

	test("idempotency: the same requestId replays without another erasure run (2.9)", async () => {
		const orch = makeOrchestrator();
		const request = subjectRequest();
		const first = await orch.execute(request);
		expect(first.status).toBe("complete");
		const callsAfterFirst = { ...stubCalls };
		const second = await orch.execute(request);
		// Replay of the stored result; no service is called again.
		expect(second.status).toBe(first.status);
		expect(second.erased).toBe(first.erased);
		expect(stubCalls).toEqual(callsAfterFirst);
	});

	test("partial failure -> partial; retry completes honestly (2.9, 2.10)", async () => {
		gateFails = true;
		try {
			const orch = makeOrchestrator();
			const request = subjectRequest();
			const op = await orch.execute(request);
			// Honest aggregation: a failed store => partial, never complete.
			expect(op.status).toBe("partial");
			const gateEndpoint = op.results.find((r) => r.store === "gate.endpoint");
			expect(gateEndpoint?.status).toBe("failed");
			const envelope = op.receipt as ErasureReceiptEnvelope;
			expect(envelope.payload.status).toBe("partial");
			expect(verifyReceipt(envelope, RECEIPT_KEY)).toBe(true);

			gateFails = false;
			const retried = await orch.retry(request.requestId);
			expect(retried?.status).toBe("complete");
			const stores = new Set((retried?.results ?? []).map((r) => r.store));
			expect(stores.has("gate.audit")).toBe(true);
			// The synthetic endpoint failure must not outlive the retry.
			expect(stores.has("gate.endpoint")).toBe(false);
			const retriedEnvelope = retried?.receipt as ErasureReceiptEnvelope;
			expect(retriedEnvelope.payload.status).toBe("complete");
			expect(verifyReceipt(retriedEnvelope, RECEIPT_KEY)).toBe(true);
		} finally {
			gateFails = false;
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Part B: live: Outpost MirrorDelete -> Extract -> Search (Requirement 2.12)
// ─────────────────────────────────────────────────────────────────────────────

const OUTPOST_MAIN = join(import.meta.dirname, "../../apps/outpost/src/main.ts");
const EXTRACT_URL = (process.env.OUTPOST_IT_EXTRACT_URL ?? "").replace(/\/$/, "");
const EXTRACT_TOKEN = process.env.OUTPOST_IT_EXTRACT_TOKEN ?? "";
const SEARCH_URL = (process.env.OUTPOST_IT_SEARCH_URL ?? "").replace(/\/$/, "");
const servicesAvailable = EXTRACT_URL !== "" && EXTRACT_TOKEN !== "";

const COLLECTION = "erasure_it";
const SOURCE_ID = "local";

/** See outpost.test.ts: `once` runs including vision extraction take minutes. */
const RUN_TIMEOUT_MS = 300_000;

/** Minimal valid PDF 1.4 with a real text layer (as in outpost.test.ts). */
function makePdf(text: string): Uint8Array<ArrayBuffer> {
	const chunks: string[] = [];
	const offsets: number[] = [];
	let pos = 0;
	const push = (s: string): void => {
		offsets.push(pos);
		chunks.push(s);
		pos += s.length;
	};
	push("%PDF-1.4\n");
	const content = `BT /F1 24 Tf 72 720 Td (${text.replace(/[()\\]/g, "")}) Tj ET\n`;
	push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
	push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
	push(
		"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
	);
	push(`4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
	push("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
	const xrefStart = pos;
	let xref = "xref\n0 6\n0000000000 65535 f \n";
	for (const off of offsets) xref += `${off.toString().padStart(10, "0")} 00000 n \n`;
	chunks.push(xref);
	chunks.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
	return new TextEncoder().encode(chunks.join(""));
}

/** Minimal HTTP client against the Extract API (bearer + X-Collection). */
async function extractFetch(path: string, init?: RequestInit): Promise<Response> {
	return fetch(`${EXTRACT_URL}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${EXTRACT_TOKEN}`,
			"x-collection": COLLECTION,
			...(init?.headers ?? {}),
		},
	});
}

type JobView = { jobId: string; reference: string; status: string };

/** All jobs of the test collection for a reference prefix. */
async function listJobs(prefix = `outpost:${SOURCE_ID}:`): Promise<JobView[]> {
	const res = await extractFetch("/v2/jobs?limit=100");
	expect(res.status).toBe(200);
	const body = (await res.json()) as { jobs?: JobView[] };
	return (body.jobs ?? []).filter((job) => job.reference.startsWith(prefix));
}

/** Returns true when Search returns a hit on the reference for the word. */
async function searchHit(reference: string, word: string): Promise<boolean> {
	const res = await fetch(`${SEARCH_URL}/search`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${EXTRACT_TOKEN}`,
			"content-type": "text/plain",
			"x-collection": COLLECTION,
			"x-search-mode": "fts",
		},
		body: word,
	});
	if (res.status !== 200) return false;
	const body = (await res.json()) as { results?: Array<{ reference?: string }> };
	return (body.results ?? []).some((hit) => (hit.reference ?? "").startsWith(`${reference}#`));
}

describe("outpost mirror-delete -> extract -> search (live, 2.12)", () => {
	if (!servicesAvailable) {
		skip("OUTPOST_IT_EXTRACT_URL / OUTPOST_IT_EXTRACT_TOKEN nicht gesetzt");
		return;
	}

	let dataDir = "";
	let srcDir = "";
	let configPath = "";

	beforeAll(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "atf-erasure-it-"));
		srcDir = join(dataDir, "src");
		await Bun.spawn(["mkdir", "-p", srcDir]).exited;
		configPath = join(dataDir, "outpost.yaml");
		await writeFile(
			configPath,
			[
				`extractUrl: ${EXTRACT_URL}`,
				"allowInsecureLocalhost: true",
				`collection: ${COLLECTION}`,
				"syncIntervalSec: 3600",
				"mirrorDelete: true",
				"sources:",
				`  - id: ${SOURCE_ID}`,
				"    type: local",
				`    path: ${srcDir}`,
				"health:",
				"  bind: 127.0.0.1",
				"  port: 0",
				"",
			].join("\n"),
		);
	});

	afterAll(async () => {
		// Remove the test references from Extract again (best effort).
		try {
			for (const job of await listJobs()) {
				await extractFetch(`/v2/documents/${encodeURIComponent(job.reference)}`, {
					method: "DELETE",
				});
			}
		} catch {
			/* cleanup is best effort */
		}
		if (dataDir !== "") await rm(dataDir, { recursive: true, force: true });
	});

	/** `atf-outpost once` against the live instance; expects exit 0 and failed=0. */
	async function runOnce(): Promise<string> {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			// CODELLDB_LAUNCH_CONNECT_FILE makes bun crash with ENOENT.
			if (value !== undefined && key !== "CODELLDB_LAUNCH_CONNECT_FILE") env[key] = value;
		}
		const proc = Bun.spawn({
			cmd: ["bun", "run", OUTPOST_MAIN, "once"],
			env: {
				...env,
				OUTPOST_API_TOKEN: EXTRACT_TOKEN,
				OUTPOST_CONFIG_FILE: configPath,
				OUTPOST_DATA_DIR: join(dataDir, "state"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const code = await proc.exited;
		if (code !== 0 || err.includes("FEHLER")) {
			console.log(`once exit=${code}\n${out}\n${err}`);
		}
		expect(code).toBe(0);
		expect(out).toContain("failed=0");
		return out;
	}

	test(
		"MirrorDelete: a removed document disappears from Extract and Search (2.12)",
		async () => {
			const word = `Loeschwort${Math.floor(Math.random() * 1e9)}`;
			await writeFile(join(srcDir, "mirror.pdf"), makePdf(`einmalig ${word}`));
			await runOnce();
			const reference = deriveReference(SOURCE_ID, "mirror.pdf");
			if (SEARCH_URL === "") {
				skip("OUTPOST_IT_SEARCH_URL nicht gesetzt — nur Extract-Pfad geprueft");
			} else {
				// The content reaches Search only after the terminal job and emit.
				let found = false;
				for (let attempt = 0; attempt < 30 && !found; attempt += 1) {
					found = await searchHit(reference, word);
					if (!found) await Bun.sleep(2_000);
				}
				expect(found).toBe(true);
			}

			// Remove locally -> the next `once` run mirrors the deletion.
			await rm(join(srcDir, "mirror.pdf"));
			await runOnce();

			// Extract: the document is gone (DELETE returns 404, idempotent).
			const res = await extractFetch(`/v2/documents/${encodeURIComponent(reference)}`, {
				method: "DELETE",
			});
			expect(res.status).toBe(404);

			if (SEARCH_URL !== "") {
				// Search cascade: the content can no longer be found.
				let gone = false;
				for (let attempt = 0; attempt < 30 && !gone; attempt += 1) {
					gone = !(await searchHit(reference, word));
					if (!gone) await Bun.sleep(2_000);
				}
				expect(gone).toBe(true);
			}
		},
		RUN_TIMEOUT_MS,
	);

	test(
		"Extract-Kaskade: /v1/erasure scope=reference meldet search.documents (2.12)",
		async () => {
			const word = `Kaskadenwort${Math.floor(Math.random() * 1e9)}`;
			await writeFile(join(srcDir, "cascade.pdf"), makePdf(`einmalig ${word}`));
			await runOnce();
			const reference = deriveReference(SOURCE_ID, "cascade.pdf");

			const requestId = randomUUID();
			const body = JSON.stringify({
				requestId,
				tenantId: "erasure-it-system",
				scope: "reference",
				references: [reference],
				dryRun: false,
			});
			const res = await extractFetch("/v1/erasure", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});
			if (res.status === 401 || res.status === 403) {
				skip("Token hat keinen extract.erasure-Scope");
				return;
			}
			expect(res.status).toBe(200);
			const parsed = ErasureResponseSchema.safeParse(await res.json());
			expect(parsed.success).toBe(true);
			if (!parsed.success) return;
			expect(parsed.data.requestId).toBe(requestId);
			const byStore = new Map(parsed.data.results.map((r) => [r.store, r]));
			// Extract reports its own stores and the Search cascade; the
			// cascade must never be faked as a success (not_configured
			// is allowed, failed is not swallowed).
			expect(byStore.has("extract.jobs")).toBe(true);
			const cascade = byStore.get("search.documents");
			expect(cascade?.status === "ok" || cascade?.status === "not_configured").toBe(true);

			// Idempotency via requestId: replay without deleting again.
			const replay = await extractFetch("/v1/erasure", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});
			expect(replay.status).toBe(200);
			const replayBody = (await replay.json()) as { requestId?: string };
			expect(replayBody.requestId).toBe(requestId);

			if (SEARCH_URL !== "") {
				// After the cascade the content is removed from Search.
				let gone = false;
				for (let attempt = 0; attempt < 30 && !gone; attempt += 1) {
					gone = !(await searchHit(reference, word));
					if (!gone) await Bun.sleep(2_000);
				}
				expect(gone).toBe(true);
			}
		},
		RUN_TIMEOUT_MS,
	);
});
