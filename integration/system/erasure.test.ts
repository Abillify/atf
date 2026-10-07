// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Systemtest Erasure (platform-hardening Task 4.13, Anforderungen 2.9, 2.10, 2.12).
 *
 * Teil A (selbstenthalten, laeuft immer): Der echte Runtime-Erasure-
 * Orchestrator faehrt gegen Contract-konforme Stub-Server fuer Search,
 * Extract und Gate (je ein `POST /v1/erasure` nach `@atf/erasure-contract`).
 * Geprueft werden die Verteilung mit je-Store-Teilergebnissen, Idempotenz
 * ueber `requestId`, ehrliche Aggregation (partial bei Ausfall) mit
 * anschiessendem Retry sowie der signierte Erasure_Receipt (Req 2.11).
 *
 * Teil B (live, env-gated wie outpost.test.ts): Outpost-MirrorDelete ->
 * Extract -> Search — ein lokal entferntes Dokument muss aus beiden
 * Services verschwinden — sowie die Extract-Kaskade ueber
 * `POST /v1/erasure` (scope=reference), die das Search-Ergebnis als
 * Teilergebnis `search.documents` zurueckmeldet (Anforderung 2.12).
 * Voraussetzungen (Umgebungsvariablen):
 *
 *   OUTPOST_IT_EXTRACT_URL   Basis-URL der Extract-Instanz
 *   OUTPOST_IT_EXTRACT_TOKEN Bearer-Token (extract.ingest, extract.delete;
 *                            extract.erasure nur fuer den Kaskaden-Check)
 *   OUTPOST_IT_SEARCH_URL    Search-URL fuer den Retrieval-/Loesch-Check
 *
 * Ausfuehren:
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
// Teil A — Runtime-DSAR -> Search/Extract/Gate gegen Contract-Stubs
// ─────────────────────────────────────────────────────────────────────────────

const STUB_TOKEN = "stub-erasure-token";
const RECEIPT_KEY = hmacReceiptKey("systemtest-anchor-secret-0123456789");
if (RECEIPT_KEY === undefined) throw new Error("Erasure-Key nicht verfuegbar");

type StubService = "search" | "extract" | "gate";

/** Zaehlt die eingegangenen Erasure-Aufrufe je Stub (Idempotenz-Nachweis). */
const stubCalls: Record<StubService, number> = { search: 0, extract: 0, gate: 0 };

/** Wenn true, antwortet der Gate-Stub mit 503 (Teilfailure-Szenario). */
let gateFails = false;

/**
 * Je-Store-Teilergebnisse der Stubs — Search meldet unnamespaced (wie die
 * echte API, der Orchestrator praefixt `search.`), Extract meldet seine
 * eigenen Stores plus den Search-Cascade `search.documents` (Anforderung 2.12).
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
 * Startet einen Contract-konformen `POST /v1/erasure`-Stub: prueft Bearer-
 * Token und Request-Schema und antwortet mit einem validen ErasureResponse.
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

describe("runtime-dsar -> search/extract/gate (Systemtest 2.9, 2.10, 2.11, 2.12)", () => {
	let servers: Partial<Record<StubService, ReturnType<typeof Bun.serve>>> = {};
	let urls: Record<StubService, string> = { search: "", extract: "", gate: "" };

	/** Port eines gestarteten Stub-Servers — wirft statt Non-null Assertion. */
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

	/** Orchestrator wie in Produktion: lokales Retention-Ziel + drei Remote-Stores. */
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

	test("DSAR verteilt an Search/Extract/Gate, je-Store-Ergebnis, signierter Receipt (2.9, 2.11, 2.12)", async () => {
		const orch = makeOrchestrator();
		const request = subjectRequest();
		const op = await orch.execute(request);
		expect(op.status).toBe("complete");
		const byStore = new Map(op.results.map((r) => [r.store, r]));
		// Lokales Runtime-Ziel plus alle drei Services mit namespaced Stores.
		expect(byStore.get("runtime.sessions")?.erased).toBe(2);
		expect(byStore.get("search.chunks")?.status).toBe("ok");
		expect(byStore.get("search.stats")?.erased).toBe(2);
		expect(byStore.get("extract.jobs")?.erased).toBe(3);
		// Extract meldet den Search-Cascade als eigenes Teilergebnis (2.12).
		expect(byStore.get("search.documents")?.status).toBe("ok");
		expect(byStore.get("gate.audit")?.erased).toBe(1);
		expect(op.erased).toBe(2 + 5 + 2 + 3 + 5 + 1);
		// Signierter Erasure_Receipt (2.11): verifizierbar, Subjekt nur als Hash.
		const envelope = op.receipt as ErasureReceiptEnvelope;
		expect(envelope.typ).toBe(ERASURE_RECEIPT_TYPE);
		expect(verifyReceipt(envelope, RECEIPT_KEY)).toBe(true);
		expect(envelope.payload.status).toBe("complete");
		expect(envelope.payload.subjectHashes).toContain(
			erasureSubjectHash("acme-system", "u-system-413"),
		);
		expect(JSON.stringify(envelope)).not.toContain("u-system-413");
	});

	test("Idempotenz: gleiches requestId replayt ohne erneuten Loeschlauf (2.9)", async () => {
		const orch = makeOrchestrator();
		const request = subjectRequest();
		const first = await orch.execute(request);
		expect(first.status).toBe("complete");
		const callsAfterFirst = { ...stubCalls };
		const second = await orch.execute(request);
		// Replay des gespeicherten Ergebnisses — kein Service wird erneut gerufen.
		expect(second.status).toBe(first.status);
		expect(second.erased).toBe(first.erased);
		expect(stubCalls).toEqual(callsAfterFirst);
	});

	test("Teilfailure -> partial; Retry vervollstaendigt ehrlich (2.9, 2.10)", async () => {
		gateFails = true;
		try {
			const orch = makeOrchestrator();
			const request = subjectRequest();
			const op = await orch.execute(request);
			// Ehrliche Aggregation: ein ausgefallener Store => partial, nie complete.
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
			// Die synthetische Endpoint-Failure darf den Retry nicht ueberdauern.
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
// Teil B — live: Outpost-MirrorDelete -> Extract -> Search (Anforderung 2.12)
// ─────────────────────────────────────────────────────────────────────────────

const OUTPOST_MAIN = join(import.meta.dirname, "../../apps/outpost/src/main.ts");
const EXTRACT_URL = (process.env.OUTPOST_IT_EXTRACT_URL ?? "").replace(/\/$/, "");
const EXTRACT_TOKEN = process.env.OUTPOST_IT_EXTRACT_TOKEN ?? "";
const SEARCH_URL = (process.env.OUTPOST_IT_SEARCH_URL ?? "").replace(/\/$/, "");
const servicesAvailable = EXTRACT_URL !== "" && EXTRACT_TOKEN !== "";

const COLLECTION = "erasure_it";
const SOURCE_ID = "local";

/** Siehe outpost.test.ts: `once`-Laufe inkl. Vision-Extraktion brauchen Minuten. */
const RUN_TIMEOUT_MS = 300_000;

/** Minimales gueltiges PDF-1.4 mit echtem Textlayer (wie outpost.test.ts). */
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

/** Minimaler HTTP-Client gegen die Extract-API (Bearer + X-Collection). */
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

/** Alle Jobs der Test-Collection fuer einen Reference-Prefix. */
async function listJobs(prefix = `outpost:${SOURCE_ID}:`): Promise<JobView[]> {
	const res = await extractFetch("/v2/jobs?limit=100");
	expect(res.status).toBe(200);
	const body = (await res.json()) as { jobs?: JobView[] };
	return (body.jobs ?? []).filter((job) => job.reference.startsWith(prefix));
}

/** Liefert true, wenn Search fuer das Wort einen Hit auf die Reference liefert. */
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
		// Testreferenzen in Extract wieder entfernen (best effort).
		try {
			for (const job of await listJobs()) {
				await extractFetch(`/v2/documents/${encodeURIComponent(job.reference)}`, {
					method: "DELETE",
				});
			}
		} catch {
			/* Ausraeumen best effort */
		}
		if (dataDir !== "") await rm(dataDir, { recursive: true, force: true });
	});

	/** `atf-outpost once` gegen die Live-Instanz; erwartet Exit 0 und failed=0. */
	async function runOnce(): Promise<string> {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			// CODELLDB_LAUNCH_CONNECT_FILE bringt bun mit ENOENT zum Absturz.
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
		"MirrorDelete: entferntes Dokument verschwindet aus Extract und Search (2.12)",
		async () => {
			const word = `Loeschwort${Math.floor(Math.random() * 1e9)}`;
			await writeFile(join(srcDir, "mirror.pdf"), makePdf(`einmalig ${word}`));
			await runOnce();
			const reference = deriveReference(SOURCE_ID, "mirror.pdf");
			if (SEARCH_URL === "") {
				skip("OUTPOST_IT_SEARCH_URL nicht gesetzt — nur Extract-Pfad geprueft");
			} else {
				// Der Inhalt erreicht Search erst nach terminalem Job und Emit.
				let found = false;
				for (let attempt = 0; attempt < 30 && !found; attempt += 1) {
					found = await searchHit(reference, word);
					if (!found) await Bun.sleep(2_000);
				}
				expect(found).toBe(true);
			}

			// Lokal entfernen -> naechster `once`-Lauf spiegelt den Loeschfall.
			await rm(join(srcDir, "mirror.pdf"));
			await runOnce();

			// Extract: das Dokument ist weg (DELETE liefert 404, idempotent).
			const res = await extractFetch(`/v2/documents/${encodeURIComponent(reference)}`, {
				method: "DELETE",
			});
			expect(res.status).toBe(404);

			if (SEARCH_URL !== "") {
				// Search-Cascade: der Inhalt ist nicht mehr auffindbar.
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
			// Extract meldet seine eigenen Stores und den Search-Cascade — der
			// Cascade darf nie als Erfolg vorgetaeuscht werden (not_configured
			// ist zulaessig, failed nicht verschluckt).
			expect(byStore.has("extract.jobs")).toBe(true);
			const cascade = byStore.get("search.documents");
			expect(cascade?.status === "ok" || cascade?.status === "not_configured").toBe(true);

			// Idempotenz ueber requestId: Replay ohne erneutes Loeschen.
			const replay = await extractFetch("/v1/erasure", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});
			expect(replay.status).toBe(200);
			const replayBody = (await replay.json()) as { requestId?: string };
			expect(replayBody.requestId).toBe(requestId);

			if (SEARCH_URL !== "") {
				// Nach der Kaskade ist der Inhalt aus Search entfernt.
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
