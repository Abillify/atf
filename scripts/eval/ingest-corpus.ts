// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Corpus ingest driver for the retrieval eval (task 6.11).
 *
 * Indexes the corpus produced by `golden-set/build-corpus.ts` into a live
 * Search stack, either through the v1 `POST /ingest` endpoint (synchronous,
 * Markdown with the v1 page/figure grammar) or through the v2 revision API
 * (`POST /v2/documents/:ref/revisions` → `PUT …/batches/0` NDJSON →
 * `POST …/commit` → poll until `committed`, which requires the Search
 * `BATCH_WORKER` to be enabled).
 *
 * Usage:
 *   bun run scripts/eval/ingest-corpus.ts [--v2] [--collection golden]
 *     [--corpus scripts/eval/golden-set/corpus] [--base-url http://127.0.0.1:3002]
 *     [--token <api-token>] [--timeout-seconds 300]
 */

import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
	CorpusDocument,
	CorpusManifest,
	CorpusPage,
} from "./golden-set/build-corpus.ts";

const HERE = import.meta.dir;
const DEFAULT_CORPUS = resolve(HERE, "golden-set", "corpus");
const CONTRACT_V2 = "atf-extract/2.0.0";

/**
 * v1 chunking (X-Chunk-Size / X-Chunk-Overlap). Without chunking, Search
 * stores one row per document and never maps chunks to the `## Seite N`
 * markers, so Page-Recall and figure evidence would be zero. The size keeps
 * chunks inside a single corpus page (~1.5–3k chars per page) while the
 * overlap preserves sentences across boundaries.
 */
const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 120;

interface Args {
	corpus: string;
	baseUrl: string;
	token?: string;
	collection: string;
	v2: boolean;
	timeoutMs: number;
}

function parseArgs(argv: string[]): Args {
	const get = (name: string): string | undefined => {
		const index = argv.indexOf(name);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	return {
		corpus: get("--corpus") ?? DEFAULT_CORPUS,
		baseUrl: (
			get("--base-url") ??
			process.env.SEARCH_BASE_URL ??
			"http://127.0.0.1:3002"
		).replace(/\/$/, ""),
		token: get("--token") ?? process.env.SEARCH_TOKEN,
		collection: get("--collection") ?? "golden",
		v2: argv.includes("--v2"),
		timeoutMs:
			Number.parseInt(get("--timeout-seconds") ?? "300", 10) * 1000 || 300_000,
	};
}

function authHeaders(args: Args): Record<string, string> {
	return args.token ? { Authorization: `Bearer ${args.token}` } : {};
}

async function failWithDetail(
	label: string,
	response: Response,
): Promise<never> {
	const detail = await response.text().catch(() => "");
	throw new Error(
		`${label} failed: ${response.status} ${detail.slice(0, 400)}`,
	);
}

// ─── v1 ingest (synchronous Markdown) ──────────────────────────────────────────

async function ingestV1(
	args: Args,
	doc: CorpusDocument,
	markdown: string,
): Promise<void> {
	const response = await fetch(`${args.baseUrl}/ingest`, {
		method: "POST",
		headers: {
			"Content-Type": "text/markdown",
			"X-Reference": doc.reference,
			"X-Collection": args.collection,
			"X-Title": doc.title,
			"X-Chunk-Size": String(CHUNK_SIZE),
			"X-Chunk-Overlap": String(CHUNK_OVERLAP),
			...authHeaders(args),
		},
		body: markdown,
	});
	if (!response.ok) await failWithDetail(`ingest ${doc.reference}`, response);
	await response.body?.cancel();
}

// ─── v2 revision ingest (NDJSON batches + commit) ──────────────────────────────

interface V2Block {
	[k: string]: unknown;
}

function v2Blocks(doc: CorpusDocument, page: CorpusPage): V2Block[] {
	const blocks: V2Block[] = [];
	let index = 0;
	for (const block of page.blocks) {
		index += 1;
		const id = `${doc.id}-p${page.page}-b${index}`;
		if (block.type === "paragraph") {
			blocks.push({ type: "paragraph", id, page: page.page, text: block.text });
		} else if (block.type === "table") {
			blocks.push({
				type: "table",
				id,
				page: page.page,
				tableId: `${doc.id}-p${page.page}-t${index}`,
				headerRows: block.rows.slice(0, 1),
				rows: block.rows.slice(1),
			});
		} else {
			for (const figure of block.figures) {
				blocks.push({
					type: "figure",
					id: `${doc.id}-p${page.page}-${figure.id}`,
					page: page.page,
					figureId: figure.id,
					kind: figure.kind,
					description: figure.description,
					...(figure.labels.length > 0 ? { labels: figure.labels } : {}),
				});
			}
		}
	}
	return blocks;
}

function buildNdjson(doc: CorpusDocument, markdown: string): string {
	const bytes = Buffer.byteLength(markdown, "utf8");
	const sha256 = createHash("sha256").update(markdown).digest("hex");
	const records: object[] = [
		{
			type: "document.begin",
			contract: CONTRACT_V2,
			reference: doc.reference,
			title: doc.title,
			language: "de",
			source: {
				filename: doc.file,
				mimeType: "text/markdown",
				bytes,
				sha256,
			},
			pipeline: { extractor: "eval-corpus", ocr: false },
			pageCount: doc.pages,
		},
		...doc.content.map((page) => ({
			type: "page",
			page: page.page,
			size: { wPt: 595, hPt: 842 },
			class: "text",
			summary: page.summary,
			blocks: v2Blocks(doc, page),
			assets: [],
			warnings: [],
		})),
		{
			type: "document.end",
			reference: doc.reference,
			pageCount: doc.pages,
		},
	];
	return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

interface RevisionCreated {
	revisionId: string;
}

interface RevisionState {
	status: string;
	missingRanges?: unknown;
}

async function createRevision(
	args: Args,
	reference: string,
): Promise<RevisionCreated> {
	const response = await fetch(
		`${args.baseUrl}/v2/documents/${encodeURIComponent(reference)}/revisions`,
		{
			method: "POST",
			headers: {
				"Idempotency-Key": randomUUID(),
				"X-Collection": args.collection,
				"X-Extract-Contract": CONTRACT_V2,
				...authHeaders(args),
			},
		},
	);
	if (!response.ok)
		await failWithDetail(`create revision ${reference}`, response);
	return (await response.json()) as RevisionCreated;
}

async function putBatch(
	args: Args,
	reference: string,
	revisionId: string,
	ndjson: string,
): Promise<void> {
	const body = Buffer.from(ndjson, "utf8");
	const digest = createHash("sha256").update(body).digest("base64");
	const response = await fetch(
		`${args.baseUrl}/v2/documents/${encodeURIComponent(reference)}/revisions/${encodeURIComponent(revisionId)}/batches/0`,
		{
			method: "PUT",
			headers: {
				"Content-Type": "application/x-ndjson",
				"Content-Digest": `sha-256=:${digest}:`,
				"X-Collection": args.collection,
				"X-Extract-Contract": CONTRACT_V2,
				...authHeaders(args),
			},
			body,
		},
	);
	if (!response.ok)
		await failWithDetail(`put batch ${reference}@${revisionId}`, response);
	await response.body?.cancel();
}

async function commitRevision(
	args: Args,
	reference: string,
	revisionId: string,
): Promise<void> {
	const response = await fetch(
		`${args.baseUrl}/v2/documents/${encodeURIComponent(reference)}/revisions/${encodeURIComponent(revisionId)}/commit`,
		{
			method: "POST",
			headers: {
				"X-Collection": args.collection,
				"X-Extract-Contract": CONTRACT_V2,
				...authHeaders(args),
			},
		},
	);
	if (!response.ok)
		await failWithDetail(`commit ${reference}@${revisionId}`, response);
	await response.body?.cancel();
}

async function revisionState(
	args: Args,
	reference: string,
	revisionId: string,
): Promise<RevisionState> {
	const response = await fetch(
		`${args.baseUrl}/v2/documents/${encodeURIComponent(reference)}/revisions/${encodeURIComponent(revisionId)}`,
		{
			headers: {
				"X-Collection": args.collection,
				"X-Extract-Contract": CONTRACT_V2,
				...authHeaders(args),
			},
		},
	);
	if (!response.ok)
		await failWithDetail(`state ${reference}@${revisionId}`, response);
	return (await response.json()) as RevisionState;
}

async function waitForCommitted(
	args: Args,
	reference: string,
	revisionId: string,
): Promise<void> {
	const deadline = Date.now() + args.timeoutMs;
	for (;;) {
		const state = await revisionState(args, reference, revisionId);
		if (state.status === "committed") return;
		if (state.status === "aborted" || state.status === "superseded") {
			throw new Error(
				`revision ${reference}@${revisionId} ended in ${state.status}`,
			);
		}
		if (Date.now() > deadline) {
			throw new Error(
				`revision ${reference}@${revisionId} not committed within ${args.timeoutMs / 1000}s (status ${state.status})`,
			);
		}
		await Bun.sleep(1000);
	}
}

async function ingestV2(
	args: Args,
	doc: CorpusDocument,
	markdown: string,
): Promise<void> {
	const revision = await createRevision(args, doc.reference);
	await putBatch(args, doc.reference, revision.revisionId, buildNdjson(doc, markdown));
	await commitRevision(args, doc.reference, revision.revisionId);
	await waitForCommitted(args, doc.reference, revision.revisionId);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const manifestPath = resolve(args.corpus, "manifest.json");
	const manifestFile = Bun.file(manifestPath);
	if (!(await manifestFile.exists())) {
		throw new Error(
			`corpus manifest not found: ${manifestPath} — run \`bun run scripts/eval/golden-set/build-corpus.ts\` first`,
		);
	}
	const manifest = (await manifestFile.json()) as CorpusManifest;
	console.log(
		`ingesting ${manifest.documents.length} documents into collection "${args.collection}" via ${args.v2 ? "v2 revisions" : "v1 /ingest"} at ${args.baseUrl}`,
	);
	for (const doc of manifest.documents) {
		const markdown = await Bun.file(resolve(args.corpus, doc.file)).text();
		if (args.v2) {
			await ingestV2(args, doc, markdown);
		} else {
			await ingestV1(args, doc, markdown);
		}
		console.log(
			`  indexed ${doc.reference} (${doc.pages} pages, ${doc.figureIds.length} figures)`,
		);
	}
	console.log("ingest complete");
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
