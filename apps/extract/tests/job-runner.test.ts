// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * job-runner.test.ts
 *
 * The real JobRunner: the v1 pipeline ported onto stages driven by a DB-backed
 * ordered scheduler (task 1.7, requirements 4.2, 6.1). Driven against the
 * in-memory fake store with stub render/vision, so no poppler, no model and no
 * database are touched.
 *
 * Covers:
 *  - a multi-page job runs its pages as stages in strict page order
 *  - the scheduler never holds more than PAGE_CONCURRENCY pages in flight and
 *    never builds a full-document array (bounded memory)
 *  - a resume reuses completed page checkpoints (the stage fn is NOT re-called
 *    for done pages)
 *  - a figure crop is staged to the asset area as its page completes
 *  - SSE/callback-facing events are emitted from stage completion, in page order
 *  - one permanently-failing page does not lose the document
 */

import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
	buildAssetId,
	figureLocalId,
	pageLocalId,
} from "@atf/extract-contract";
import { buildBpmnRecords } from "../src/pipeline/native/index.js";
import { createFakeJobStore, type FakeJobStore } from "./job-store-fake.js";
import { testLogger, TINY_PNG } from "./helpers.js";
import { createLeaseGuard } from "../src/jobs/lease.js";
import { createJobEventBus, type JobEvent } from "../src/jobs/events.js";
import {
	createJobRunner,
	CURSOR_STAGE,
	VISION1_STAGE,
	FIGURE2_STAGE,
	TILED_STAGE,
	DOCPASS_STAGE,
} from "../src/jobs/job-runner.js";
import type {
	PageRenderer,
	PreparedSource,
	PageImage,
} from "../src/jobs/page-renderer.js";
import type { VisionClient } from "../src/vision/client.js";
import type { ResumeDecision } from "../src/jobs/snapshot.js";
import type { JobRow } from "../src/persistence/types.js";

const REFERENCE = "tests/handbuch.pdf";
const SOURCE_SHA = "a".repeat(64);
const RESUME: ResumeDecision = { action: "continue-pinned", changed: false };

/**
 * A distinct PNG per page, so the render-hash dedup (task 2.2) treats every page
 * as unique and these tests keep their per-page vision semantics. The dedicated
 * dedup test uses intentionally-identical images instead. Cached so a re-render
 * of the same page yields byte-identical bytes (a resume must not "change").
 */
const PAGE_PNG_CACHE = new Map<number, PageImage>();
async function distinctPageImageAsync(page: number): Promise<PageImage> {
	const cached = PAGE_PNG_CACHE.get(page);
	if (cached !== undefined) return cached;
	const size = 8;
	const raw = Buffer.alloc(size * size * 3, 255);
	// A page-derived pixel makes each page's render hash differ.
	raw[0] = (page * 37) % 256;
	raw[1] = (page * 53) % 256;
	raw[2] = (page * 71) % 256;
	const buffer = await sharp(raw, {
		raw: { width: size, height: size, channels: 3 },
	})
		.png()
		.toBuffer();
	const image: PageImage = {
		buffer,
		mimeType: "image/png",
		width: 100,
		height: 140,
	};
	PAGE_PNG_CACHE.set(page, image);
	return image;
}

/** A prepared source with `pageCount` pages, tracking peak in-flight renders. */
function fakePrepared(options: {
	pageCount: number;
	failPages?: Set<number>;
	onRender?: (page: number) => void;
	onRelease?: (page: number) => void;
	/** When set, every page renders THIS exact image (identical → dedup). */
	identicalImage?: PageImage;
	/** The page's text layer; defaults to `text <page>`. */
	rawText?: (page: number) => string;
	/** The physical page size the renderer reports, in points. */
	sizePt?: { widthPt: number; heightPt: number };
}): PreparedSource {
	const failPages = options.failPages ?? new Set<number>();
	return {
		pageCount: options.pageCount,
		native: null,
		docxHeadingHints: null,
		vsdxStructure: null,
		pdfPath: null,
		home: "",
		format: {
			mimeType: "application/pdf",
			extensions: [".pdf"],
			kind: "pdf",
			family: "pdf",
			label: "PDF",
		},
		async render(page) {
			options.onRender?.(page);
			if (failPages.has(page)) {
				options.onRelease?.(page);
				throw new Error(`boom on page ${page}`);
			}
			// Let a microtask settle so concurrent renders overlap observably.
			await Promise.resolve();
			options.onRelease?.(page);
			const image =
				options.identicalImage ?? (await distinctPageImageAsync(page));
			return {
				image,
				rawText: options.rawText?.(page) ?? `text ${page}`,
				usedOcr: false,
				...(options.sizePt !== undefined ? { sizePt: options.sizePt } : {}),
			};
		},
		async renderFigureCrop() {
			return { buffer: TINY_PNG, mimeType: "image/png", width: 10, height: 10 };
		},
		async close() {},
	};
}

/** A page renderer returning the given prepared source. */
function fakeRenderer(prepared: PreparedSource): PageRenderer {
	return {
		async prepare() {
			return prepared;
		},
	};
}

/** A vision client that emits a figure on the configured pages. */
function fakeVision(
	figuresOnPages: Set<number> = new Set(),
): VisionClient & { calls: number[] } {
	const calls: number[] = [];
	return {
		calls,
		async analyzePage(input) {
			calls.push(input.page);
			const hasFigure = figuresOnPages.has(input.page);
			const raw = hasFigure
				? `<summary>S${input.page}</summary><figures><figure id="1" bbox="0.1,0.1,0.5,0.5">Diagramm</figure></figures><markdown>Seite ${input.page}\n\n![figure_1]</markdown>`
				: `<summary>S${input.page}</summary><figures></figures><markdown>Seite ${input.page}</markdown>`;
			return {
				raw,
				usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
				requests: 1,
				truncated: false,
				maxTokens: 8192,
			};
		},
		async analyzeFigure() {
			return {
				raw: '{"format":"markdown","text":"stub"}',
				usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
				requests: 1,
				truncated: false,
				maxTokens: 8192,
			};
		},
		async probe() {
			return { available: true };
		},
	};
}

async function seedClaimedJob(
	store: FakeJobStore,
	overrides: Partial<Parameters<FakeJobStore["createJob"]>[0]> = {},
) {
	const id = randomUUID();
	await store.createJob({
		id,
		reference: REFERENCE,
		source_sha256: SOURCE_SHA,
		...overrides,
	});
	const claimed = await store.claimNextJob("worker-1", 60);
	if (claimed === null) throw new Error("expected a claim");
	return claimed;
}

function runnerCtx(store: FakeJobStore, job: JobRow) {
	const lease = createLeaseGuard(
		store,
		{ jobId: job.id, holder: "worker-1", epoch: Number(job.lease_epoch) },
		60,
	);
	return { job, lease, resume: RESUME, logger: testLogger };
}

function makeRunner(
	store: FakeJobStore,
	prepared: PreparedSource,
	vision: VisionClient,
	events = createJobEventBus(),
	pageConcurrency = 2,
	emitter: import("../src/jobs/emitter.js").Emitter | null = null,
) {
	return createJobRunner({
		store,
		vision,
		renderer: fakeRenderer(prepared),
		events,
		config: {
			pageConcurrency,
			visionTokenEstimate: 1000,
			visionModel: "test-vlm",
			renderDpi: 200,
			figureDpi: 300,
			figurePass2Kinds: [],
			figurePass2MinArea: 0.02,
			labelCoverageMin: 60,
		},
		emitter,
		logger: testLogger,
	});
}

describe("job-runner · ordered staged processing", () => {
	it("runs a multi-page job as stages in strict page order and reaches emitting", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");
		const vision = fakeVision();
		const runner = makeRunner(store, fakePrepared({ pageCount: 5 }), vision);

		const outcome = await runner.run(
			runnerCtx(store, { ...job, status: "preparing" }),
		);
		expect(outcome).toEqual({ status: "completed" });

		// Every page has a done cursor checkpoint.
		const done = await store.listStagesByStatus("page", job.id, "done");
		const emittedPages = done
			.filter((s) => s.stage === CURSOR_STAGE)
			.map((s) => s.page)
			.sort((a, b) => a - b);
		expect(emittedPages).toEqual([1, 2, 3, 4, 5]);

		// The emit-outbox rows were staged one per page, in ascending seq order.
		const batches = store.peekEmitBatches(job.id);
		expect(batches.map((b) => b.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(batches.every((b) => b.status === "pending")).toBe(true);

		// The runner left the job in `emitting` for the worker to finalise.
		expect(store.peek(job.id)?.status).toBe("emitting");
		expect(store.peek(job.id)?.page_count).toBe(5);
	});

	it("never holds more than PAGE_CONCURRENCY pages in flight", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");

		let inFlight = 0;
		let peak = 0;
		const prepared = fakePrepared({
			pageCount: 20,
			onRender: () => {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
			},
			onRelease: () => {
				inFlight -= 1;
			},
		});
		const runner = makeRunner(
			store,
			prepared,
			fakeVision(),
			createJobEventBus(),
			3,
		);

		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));
		// The window is PAGE_CONCURRENCY, so no more than 3 renders ever overlap.
		expect(peak).toBeLessThanOrEqual(3);
		expect(peak).toBeGreaterThan(1); // and it did run concurrently
	});

	it("emits page/asset/prepared/done events in page order from stage completion", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");
		const events = createJobEventBus();
		const seen: JobEvent[] = [];
		events.subscribe(job.id, (e) => seen.push(e));

		const runner = makeRunner(
			store,
			fakePrepared({ pageCount: 3 }),
			fakeVision(new Set([2])),
			events,
			1, // strictly one at a time, so event order is deterministic
		);
		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));

		expect(seen[0]).toMatchObject({ type: "prepared", pageCount: 3 });
		const pageEvents = seen.filter((e) => e.type === "page");
		expect(pageEvents.map((e) => (e as { page: number }).page)).toEqual([
			1, 2, 3,
		]);
		// Page 2 carried a figure asset event before its page event.
		const assetEvents = seen.filter((e) => e.type === "asset");
		expect(assetEvents.length).toBe(1);
		expect(seen.at(-1)).toMatchObject({ type: "done", status: "completed" });
	});
});

describe("job-runner · crops staged to the asset area", () => {
	it("stages a figure crop and the page image as the page completes", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");
		const runner = makeRunner(
			store,
			fakePrepared({ pageCount: 2 }),
			fakeVision(new Set([1])),
		);

		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));

		const assets = store.peekAssets(job.id);
		const ids = assets.map((a) => a.asset_id);
		// Page 1's figure crop is staged, plus both pages' page images.
		expect(ids).toContain(buildAssetId(REFERENCE, figureLocalId("p1-f1")));
		expect(ids).toContain(buildAssetId(REFERENCE, pageLocalId(1)));
		expect(ids).toContain(buildAssetId(REFERENCE, pageLocalId(2)));
		// The figure crop carries a checksum (its bytes were produced).
		const figureAsset = assets.find(
			(a) => a.asset_id === buildAssetId(REFERENCE, figureLocalId("p1-f1")),
		);
		expect(figureAsset?.checksum).toBeTypeOf("string");
	});
});

describe("job-runner · resume reuses completed checkpoints", () => {
	it("does not re-call the vision fn for pages already done", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");

		const vision1 = fakeVision();
		const runner1 = makeRunner(store, fakePrepared({ pageCount: 4 }), vision1);
		await runner1.run(runnerCtx(store, { ...job, status: "preparing" }));
		expect(vision1.calls.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);

		// Re-queue and run again with a FRESH vision stub: every page's vision1
		// checkpoint is `done` with the same input hash, so the model is not called.
		await store.requeueJob(job.id);
		const reclaimed = await store.claimNextJob("worker-1", 60);
		if (reclaimed === null) throw new Error("expected reclaim");
		const vision2 = fakeVision();
		const runner2 = makeRunner(store, fakePrepared({ pageCount: 4 }), vision2);
		const outcome = await runner2.run(
			runnerCtx(store, { ...reclaimed, status: "preparing" }),
		);

		expect(outcome).toEqual({ status: "completed" });
		expect(vision2.calls).toEqual([]); // ZERO model calls on the resume
	});

	it("only re-runs the pages that were not yet done", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");

		// Pre-seed pages 1 and 2 as fully done (as a prior run would have left them).
		for (const page of [1, 2]) {
			for (const stage of [VISION1_STAGE, "crops", CURSOR_STAGE]) {
				await store.upsertStage("page", {
					job_id: job.id,
					page,
					stage,
					input_hash:
						stage === VISION1_STAGE
							? `seed` // deliberately different; but cursor is what the scheduler checks
							: "seed",
					status: "done",
					output: {
						raw: null,
						parsed: stage === VISION1_STAGE ? seedVisionParsed(page) : { page },
					},
				});
			}
		}

		const vision = fakeVision();
		const runner = makeRunner(store, fakePrepared({ pageCount: 4 }), vision);
		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));

		// Pages 1 and 2 had a done cursor, so the scheduler skipped them; only 3 and
		// 4 were rendered/analysed.
		expect(vision.calls.sort((a, b) => a - b)).toEqual([3, 4]);
	});
});

describe("job-runner · one bad page does not lose the document", () => {
	it("emits an empty warned page for a permanent render failure and continues", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");
		const runner = makeRunner(
			store,
			fakePrepared({ pageCount: 3, failPages: new Set([2]) }),
			fakeVision(),
		);

		const outcome = await runner.run(
			runnerCtx(store, { ...job, status: "preparing" }),
		);
		expect(outcome).toEqual({ status: "completed" });

		// All three pages have a done cursor, so page 2's failure did not block 3.
		const batches = store.peekEmitBatches(job.id);
		expect(batches.map((b) => b.seq)).toEqual([1, 2, 3]);
		// Page 2's staged record carries a warning and no blocks.
		const page2 = batches.find((b) => b.seq === 2);
		const record = (
			page2?.payload as { record?: { warnings?: string[]; blocks?: unknown[] } }
		)?.record;
		expect(record?.warnings?.length).toBeGreaterThan(0);
		expect(record?.blocks).toEqual([]);
	});
});

describe("job-runner · budget guard", () => {
	it("pauses (budget) before a model call when the token budget is exhausted", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store, { token_budget: 5 });
		await store.setJobStatus(job.id, "preparing");
		const vision = fakeVision();
		const runner = createJobRunner({
			store,
			vision,
			renderer: fakeRenderer(fakePrepared({ pageCount: 3 })),
			events: createJobEventBus(),
			// Estimate exceeds the tiny budget, so the guard trips before page 1.
			config: {
				pageConcurrency: 1,
				visionTokenEstimate: 100,
				visionModel: "test-vlm",
				renderDpi: 200,
				figureDpi: 300,
				figurePass2Kinds: [],
				figurePass2MinArea: 0.02,
				labelCoverageMin: 60,
			},
			logger: testLogger,
		});

		const outcome = await runner.run(
			runnerCtx(store, { ...job, status: "preparing" }),
		);
		expect(outcome).toEqual({ status: "paused", reason: "budget" });
		expect(vision.calls).toEqual([]); // no model call happened
	});
});

describe("job-runner · emitting phase invokes the emitter", () => {
	it("runs the emitter after processing and completes when it commits", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");

		const emitCalls: string[] = [];
		const emitter = {
			async emit(j: JobRow) {
				emitCalls.push(j.id);
				return { status: "committed" as const, revisionId: "rev-x" };
			},
		};
		const runner = makeRunner(
			store,
			fakePrepared({ pageCount: 3 }),
			fakeVision(),
			createJobEventBus(),
			2,
			emitter,
		);

		const outcome = await runner.run(
			runnerCtx(store, { ...job, status: "preparing" }),
		);
		expect(outcome).toEqual({ status: "completed" });
		expect(emitCalls).toEqual([job.id]);
		// The runner transitioned the job to `emitting` before calling the emitter.
		expect(store.peek(job.id)?.status).toBe("emitting");
	});

	it("pauses on dependency when the emitter reports a transient failure", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");

		const emitter = {
			async emit() {
				return {
					status: "transient" as const,
					revisionId: null,
					reason: "Search unreachable",
				};
			},
		};
		const runner = makeRunner(
			store,
			fakePrepared({ pageCount: 2 }),
			fakeVision(),
			createJobEventBus(),
			2,
			emitter,
		);

		const outcome = await runner.run(
			runnerCtx(store, { ...job, status: "preparing" }),
		);
		expect(outcome).toEqual({ status: "paused", reason: "dependency" });
	});
});

describe("job-runner · render-hash page dedup (requirement 7.4)", () => {
	it("reuses the vision result for identical pages (model called once)", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");

		// Every page renders the SAME image, so all pages after the first are
		// duplicates. Concurrency 1 makes the reuse deterministic: page 1 finishes
		// (its vision1 checkpoint is `done`) before page 2's dedup check runs.
		const identical = await distinctPageImageAsync(1);
		const vision = fakeVision();
		const runner = makeRunner(
			store,
			fakePrepared({ pageCount: 4, identicalImage: identical }),
			vision,
			createJobEventBus(),
			1,
		);

		const outcome = await runner.run(
			runnerCtx(store, { ...job, status: "preparing" }),
		);
		expect(outcome).toEqual({ status: "completed" });

		// The model was called exactly once; pages 2-4 reused page 1's result.
		expect(vision.calls).toEqual([1]);

		// Yet all four pages still produced a full record (reuse ≠ dropping pages).
		const batches = store.peekEmitBatches(job.id);
		expect(batches.map((b) => b.seq)).toEqual([1, 2, 3, 4]);
		for (const batch of batches) {
			const record = (batch.payload as { record?: { blocks?: unknown[] } })
				.record;
			expect(record?.blocks?.length).toBeGreaterThan(0);
		}
	});

	it("calls the model for every distinct page (no false dedup)", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");

		// distinctPageImageAsync gives each page a different image → no dedup.
		const vision = fakeVision();
		const runner = makeRunner(
			store,
			fakePrepared({ pageCount: 4 }),
			vision,
			createJobEventBus(),
			1,
		);

		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));
		expect(vision.calls.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
	});
});

describe("job-runner · S2 heading hints and v2 figure kind (task 2.3)", () => {
	it("feeds the S2 heading candidates to the vision call", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");

		const seenCandidates: Array<
			readonly { numbering: string; text: string }[] | undefined
		> = [];
		const vision: VisionClient = {
			async analyzePage(input) {
				seenCandidates.push(input.headingCandidates);
				return {
					raw: `<summary>S${input.page}</summary><figures></figures><markdown>Seite ${input.page}</markdown>`,
					usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
					requests: 1,
					truncated: false,
					maxTokens: 8192,
				};
			},
			async analyzeFigure() {
				return {
					raw: '{"format":"markdown","text":"stub"}',
					usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
					requests: 1,
					truncated: false,
					maxTokens: 8192,
				};
			},
			async probe() {
				return { available: true };
			},
		};

		// A minimal analyzer that returns one numbered heading candidate per page.
		const analyzer = {
			forSource() {
				return {
					async analyze(page: number) {
						return {
							page,
							size: { widthPt: 595, heightPt: 842 },
							blocks: [],
							lines: [],
							words: [],
							headingCandidates: [
								{
									text: `${page}.1 Titel`,
									numbering: `${page}.1`,
									bbox: [0, 0, 1, 0.1] as [number, number, number, number],
									height: 0.03,
								},
							],
						};
					},
					async capability() {
						return { supported: true, version: "24.0" };
					},
					inputHash() {
						return "h";
					},
				};
			},
		};

		// The fake prepared source has no pdfPath, so bind requires one: give it a
		// path so the runner binds the analyzer.
		const prepared = {
			...fakePrepared({ pageCount: 2 }),
			pdfPath: "/tmp/x.pdf",
			home: "/tmp",
		};
		const runner = createJobRunner({
			store,
			vision,
			renderer: fakeRenderer(prepared),
			events: createJobEventBus(),
			config: {
				pageConcurrency: 1,
				visionTokenEstimate: 10,
				visionModel: "test-vlm",
				renderDpi: 200,
				figureDpi: 300,
				figurePass2Kinds: [],
				figurePass2MinArea: 0.02,
				labelCoverageMin: 60,
			},
			analyzer,
			logger: testLogger,
		});

		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));
		// Both pages received their own page's heading candidate.
		expect(seenCandidates[0]).toEqual([
			{ numbering: "1.1", text: "1.1 Titel" },
		]);
		expect(seenCandidates[1]).toEqual([
			{ numbering: "2.1", text: "2.1 Titel" },
		]);
	});

	it("carries the model's figure kind and caption into the page record", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");

		const vision: VisionClient = {
			async analyzePage(input) {
				return {
					raw:
						`<summary>S${input.page}</summary>` +
						'<figures><figure id="1" kind="ui_mask" bbox="0.1,0.1,0.5,0.5" caption="Maske WE01">Eine Erfassungsmaske.</figure></figures>' +
						`<markdown>Seite ${input.page}\n\n![figure_1]</markdown>`,
					usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
					requests: 1,
					truncated: false,
					maxTokens: 8192,
				};
			},
			async analyzeFigure() {
				return {
					raw: '{"format":"markdown","text":"stub"}',
					usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
					requests: 1,
					truncated: false,
					maxTokens: 8192,
				};
			},
			async probe() {
				return { available: true };
			},
		};

		const events = createJobEventBus();
		const records: import("@atf/extract-contract/v2").PageRecord[] = [];
		events.subscribe(job.id, (e) => {
			if (e.type === "page") records.push(e.record);
		});

		const runner = makeRunner(
			store,
			fakePrepared({ pageCount: 1 }),
			vision,
			events,
			1,
		);
		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));

		const figureBlock = records[0]?.blocks.find((b) => b.type === "figure");
		expect(figureBlock).toBeDefined();
		if (figureBlock?.type === "figure") {
			expect(figureBlock.kind).toBe("ui_mask");
			expect(figureBlock.caption).toBe("Maske WE01");
			expect(figureBlock.description).toContain("Erfassungsmaske");
		}
	});

	it("snaps the figure bbox and carries regionText/labels from S2 words (task 2.4)", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");

		// The model proposes a figure box; S2 supplies words inside it, so S4
		// should populate regionText/labels on the emitted figure block.
		const vision: VisionClient = {
			async analyzePage(input) {
				return {
					raw:
						`<summary>S${input.page}</summary>` +
						'<figures><figure id="1" kind="process" bbox="0.1,0.1,0.5,0.5">Ein Ablauf.</figure></figures>' +
						`<markdown>Seite ${input.page}\n\n![figure_1]</markdown>`,
					usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
					requests: 1,
					truncated: false,
					maxTokens: 8192,
				};
			},
			async analyzeFigure() {
				return {
					raw: '{"format":"markdown","text":"stub"}',
					usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
					requests: 1,
					truncated: false,
					maxTokens: 8192,
				};
			},
			async probe() {
				return { available: true };
			},
		};

		// Words whose centres lie inside [0.1,0.1,0.5,0.5], on two lines, plus one
		// word outside the box that must be excluded from regionText.
		const bbox = (b: [number, number, number, number]) => b;
		const insideLineTop = {
			words: [
				{ text: "Start", bbox: bbox([0.15, 0.15, 0.25, 0.18]) },
				{ text: "Knoten", bbox: bbox([0.26, 0.15, 0.4, 0.18]) },
			],
			bbox: bbox([0.15, 0.15, 0.4, 0.18]),
			text: "Start Knoten",
			height: 0.03,
		};
		const insideLineBottom = {
			words: [{ text: "Ende", bbox: bbox([0.16, 0.3, 0.28, 0.33]) }],
			bbox: bbox([0.16, 0.3, 0.28, 0.33]),
			text: "Ende",
			height: 0.03,
		};
		const outsideLine = {
			words: [{ text: "Rand", bbox: bbox([0.8, 0.8, 0.9, 0.83]) }],
			bbox: bbox([0.8, 0.8, 0.9, 0.83]),
			text: "Rand",
			height: 0.03,
		};
		const analyzer = {
			forSource() {
				return {
					async analyze(page: number) {
						return {
							page,
							size: { widthPt: 595, heightPt: 842 },
							blocks: [],
							lines: [insideLineTop, insideLineBottom, outsideLine],
							words: [
								...insideLineTop.words,
								...insideLineBottom.words,
								...outsideLine.words,
							],
							headingCandidates: [],
						};
					},
					async capability() {
						return { supported: true, version: "24.0" };
					},
					inputHash() {
						return "h";
					},
				};
			},
		};

		const events = createJobEventBus();
		const records: import("@atf/extract-contract/v2").PageRecord[] = [];
		events.subscribe(job.id, (e) => {
			if (e.type === "page") records.push(e.record);
		});

		const prepared = {
			...fakePrepared({ pageCount: 1 }),
			pdfPath: "/tmp/x.pdf",
			home: "/tmp",
		};
		const runner = createJobRunner({
			store,
			vision,
			renderer: fakeRenderer(prepared),
			events,
			config: {
				pageConcurrency: 1,
				visionTokenEstimate: 10,
				visionModel: "test-vlm",
				renderDpi: 200,
				figureDpi: 300,
				figurePass2Kinds: [],
				figurePass2MinArea: 0.02,
				labelCoverageMin: 60,
			},
			analyzer,
			logger: testLogger,
		});

		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));

		const figureBlock = records[0]?.blocks.find((b) => b.type === "figure");
		expect(figureBlock).toBeDefined();
		if (figureBlock?.type === "figure") {
			expect(figureBlock.regionText).toBe("Start Knoten\nEnde");
			expect(figureBlock.labels).toEqual(["Start Knoten", "Ende"]);
			// The word outside the box never leaks into the region text.
			expect(figureBlock.regionText).not.toContain("Rand");
			// The emitted bbox is the snapped box (expanded then possibly trimmed),
			// still a valid in-page box.
			expect(figureBlock.bbox).toBeDefined();
			expect(figureBlock.bbox?.[0]).toBeGreaterThanOrEqual(0);
			expect(figureBlock.bbox?.[2]).toBeLessThanOrEqual(1);
		}
	});
});

/** The persisted parsed shape a done vision stage would carry, for the seed test. */
function seedVisionParsed(page: number) {
	return {
		summary: `S${page}`,
		markdown: `Seite ${page}`,
		figures: [],
		warnings: [],
		usedOcr: false,
		usage: {
			requests: 1,
			promptTokens: 10,
			completionTokens: 20,
			totalTokens: 30,
		},
		truncated: false,
		size: { wPt: 100, hPt: 140 },
		imageWidth: 100,
		imageHeight: 140,
	};
}

// ── figure Pass 2 (S5, task 2.5) ───────────────────────────────────────────

/**
 * A vision client that emits one figure of `kind` on page 1 (with a bbox large
 * enough to clear the default minimum area) and answers Pass 2 with a valid
 * `process` transcription. Both call counts are tracked so a resume can be
 * shown to make no extra model calls.
 */
function pass2Vision(
	kind: string,
	bbox = "0.1,0.1,0.6,0.6",
): VisionClient & { pageCalls: number[]; figureCalls: string[] } {
	const pageCalls: number[] = [];
	const figureCalls: string[] = [];
	return {
		pageCalls,
		figureCalls,
		async analyzePage(input) {
			pageCalls.push(input.page);
			return {
				raw:
					`<summary>S${input.page}</summary>` +
					`<figures><figure id="1" kind="${kind}" bbox="${bbox}">Ein Prozess.</figure></figures>` +
					`<markdown>Seite ${input.page}\n\n![figure_1]</markdown>`,
				usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
				requests: 1,
				truncated: false,
				maxTokens: 8192,
			};
		},
		async analyzeFigure(input) {
			figureCalls.push(input.figureId);
			return {
				raw: JSON.stringify({
					format: "process",
					mermaid: "flowchart TD\n  A-->B",
					nodes: [{ id: "A", type: "start", label: "Start" }],
					edges: [{ from: "A", to: "B" }],
					steps: ["Start", "Ende"],
				}),
				usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
				requests: 1,
				truncated: false,
				maxTokens: 8192,
			};
		},
		async probe() {
			return { available: true };
		},
	};
}

function pass2Runner(
	store: FakeJobStore,
	prepared: PreparedSource,
	vision: VisionClient,
	overrides: Partial<{
		figurePass2Kinds: import("@atf/extract-contract/v2").FigureKind[];
		figurePass2MinArea: number;
		labelCoverageMin: number;
	}> = {},
	events = createJobEventBus(),
) {
	return createJobRunner({
		store,
		vision,
		renderer: fakeRenderer(prepared),
		events,
		config: {
			pageConcurrency: 1,
			visionTokenEstimate: 10,
			visionModel: "test-vlm",
			renderDpi: 200,
			figureDpi: 300,
			figurePass2Kinds: overrides.figurePass2Kinds ?? ["bpmn", "flowchart"],
			figurePass2MinArea: overrides.figurePass2MinArea ?? 0.02,
			labelCoverageMin: overrides.labelCoverageMin ?? 60,
		},
		emitter: null,
		logger: testLogger,
	});
}

describe("job-runner · figure Pass 2 (S5, task 2.5)", () => {
	it("runs Pass 2 for a gated bpmn figure and emits the transcription on the block", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");
		const vision = pass2Vision("bpmn");

		const events = createJobEventBus();
		const records: import("@atf/extract-contract/v2").PageRecord[] = [];
		events.subscribe(job.id, (e) => {
			if (e.type === "page") records.push(e.record);
		});

		const runner = pass2Runner(
			store,
			fakePrepared({ pageCount: 1 }),
			vision,
			{},
			events,
		);
		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));

		expect(vision.figureCalls).toEqual(["p1-f1"]);
		const figureBlock = records[0]?.blocks.find((b) => b.type === "figure");
		expect(figureBlock?.type).toBe("figure");
		if (figureBlock?.type === "figure") {
			expect(figureBlock.transcription?.format).toBe("process");
			if (figureBlock.transcription?.format === "process") {
				expect(figureBlock.transcription.steps).toEqual(["Start", "Ende"]);
			}
		}

		// The figure2 checkpoint is persisted.
		const checkpoint = await store.getStage("figure", {
			job_id: job.id,
			page: 1,
			figure_id: "p1-f1",
			stage: FIGURE2_STAGE,
		});
		expect(checkpoint?.status).toBe("done");
	});

	it("replays the Pass-2 checkpoint on resume with no extra model call", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");
		const vision = pass2Vision("bpmn");
		const prepared = fakePrepared({ pageCount: 1 });

		const first = pass2Runner(store, prepared, vision);
		await first.run(runnerCtx(store, { ...job, status: "preparing" }));
		expect(vision.figureCalls).toEqual(["p1-f1"]);

		// A second full run over the same store must reuse every checkpoint: no
		// second Pass-1 or Pass-2 model call.
		const reclaimed = await store.claimNextJob("worker-1", 60);
		const target = reclaimed ?? { ...job, status: "processing" as const };
		const second = pass2Runner(store, prepared, vision);
		await second.run(runnerCtx(store, target));
		expect(vision.figureCalls).toEqual(["p1-f1"]); // still exactly one
	});

	it("skips Pass 2 when the kind is not in FIGURE_PASS2_KINDS", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");
		// A chart figure, but the runner is configured for bpmn/flowchart only.
		const vision = pass2Vision("chart");
		const runner = pass2Runner(store, fakePrepared({ pageCount: 1 }), vision, {
			figurePass2Kinds: ["bpmn", "flowchart"],
		});
		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));
		expect(vision.figureCalls).toEqual([]);
		const checkpoint = await store.getStage("figure", {
			job_id: job.id,
			page: 1,
			figure_id: "p1-f1",
			stage: FIGURE2_STAGE,
		});
		expect(checkpoint).toBeNull();
	});

	it("skips Pass 2 for a figure below the minimum area", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");
		// A tiny 0.01×0.01 box (area 0.0001) is well below the default 0.02.
		const vision = pass2Vision("bpmn", "0.10,0.10,0.11,0.11");
		const runner = pass2Runner(store, fakePrepared({ pageCount: 1 }), vision, {
			figurePass2MinArea: 0.02,
		});
		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));
		expect(vision.figureCalls).toEqual([]);
	});

	it("pauses (budget) cleanly when the budget is exhausted before Pass 2", async () => {
		const store = createFakeJobStore();
		// A budget that just covers the Pass-1 call (estimate 10, spends 2) but
		// leaves too little (8 < 10) for the Pass-2 guard.
		const job = await seedClaimedJob(store, { token_budget: 10 });
		await store.setJobStatus(job.id, "preparing");
		const vision = pass2Vision("bpmn");
		const runner = pass2Runner(store, fakePrepared({ pageCount: 1 }), vision);
		const outcome = await runner.run(
			runnerCtx(store, { ...job, status: "preparing" }),
		);
		expect(outcome).toEqual({ status: "paused", reason: "budget" });
		// No Pass-2 model call happened on the exhausted budget.
		expect(vision.figureCalls).toEqual([]);
	});
});

describe("job-runner · Pass 2 label coverage (task 2.5, requirement 8.4)", () => {
	/** An analyzer supplying three words inside a figure box on [0.1,0.1,0.6,0.6]. */
	function labelAnalyzer() {
		const bbox = (b: [number, number, number, number]) => b;
		const line = {
			words: [
				{ text: "Start", bbox: bbox([0.15, 0.15, 0.25, 0.18]) },
				{ text: "Knoten", bbox: bbox([0.26, 0.15, 0.4, 0.18]) },
				{ text: "Ende", bbox: bbox([0.42, 0.15, 0.5, 0.18]) },
			],
			bbox: bbox([0.15, 0.15, 0.5, 0.18]),
			text: "Start Knoten Ende",
			height: 0.03,
		};
		return {
			forSource() {
				return {
					async analyze(page: number) {
						return {
							page,
							size: { widthPt: 595, heightPt: 842 },
							blocks: [],
							lines: [line],
							words: line.words,
							headingCandidates: [],
						};
					},
					async capability() {
						return { supported: true, version: "24.0" };
					},
					inputHash() {
						return "h";
					},
				};
			},
		};
	}

	it("warns and retries Pass 2 exactly once when coverage is below the threshold", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");

		let figureCalls = 0;
		const vision: VisionClient = {
			async analyzePage(input) {
				return {
					raw:
						`<summary>S${input.page}</summary>` +
						'<figures><figure id="1" kind="bpmn" bbox="0.1,0.1,0.6,0.6">Ein Prozess.</figure></figures>' +
						`<markdown>Seite ${input.page}\n\n![figure_1]</markdown>`,
					usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
					requests: 1,
					truncated: false,
					maxTokens: 8192,
				};
			},
			async analyzeFigure() {
				figureCalls += 1;
				// First response covers none of the labels; the retry covers all three.
				const raw =
					figureCalls === 1
						? JSON.stringify({
								format: "process",
								mermaid: "flowchart TD",
								nodes: [],
								edges: [],
								steps: ["etwas anderes"],
							})
						: JSON.stringify({
								format: "process",
								mermaid: "flowchart TD",
								nodes: [
									{ id: "A", type: "start", label: "Start" },
									{ id: "B", type: "task", label: "Knoten" },
									{ id: "C", type: "end", label: "Ende" },
								],
								edges: [],
								steps: ["Start", "Knoten", "Ende"],
							});
				return {
					raw,
					usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
					requests: 1,
					truncated: false,
					maxTokens: 8192,
				};
			},
			async probe() {
				return { available: true };
			},
		};

		const events = createJobEventBus();
		const records: import("@atf/extract-contract/v2").PageRecord[] = [];
		events.subscribe(job.id, (e) => {
			if (e.type === "page") records.push(e.record);
		});

		const prepared = {
			...fakePrepared({ pageCount: 1 }),
			pdfPath: "/tmp/x.pdf",
			home: "/tmp",
		};
		const runner = createJobRunner({
			store,
			vision,
			renderer: fakeRenderer(prepared),
			events,
			config: {
				pageConcurrency: 1,
				visionTokenEstimate: 10,
				visionModel: "test-vlm",
				renderDpi: 200,
				figureDpi: 300,
				figurePass2Kinds: ["bpmn", "flowchart"],
				figurePass2MinArea: 0.02,
				labelCoverageMin: 60,
			},
			analyzer: labelAnalyzer(),
			emitter: null,
			logger: testLogger,
		});

		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));

		// Exactly one retry: two Pass-2 model calls total.
		expect(figureCalls).toBe(2);

		const record = records[0];
		// The low-coverage warning was surfaced on the page.
		expect(record?.warnings.some((w) => /Label-Coverage/.test(w))).toBe(true);
		// The higher-coverage retry transcription was kept.
		const figureBlock = record?.blocks.find((b) => b.type === "figure");
		if (
			figureBlock?.type === "figure" &&
			figureBlock.transcription?.format === "process"
		) {
			expect(figureBlock.transcription.steps).toContain("Knoten");
		}
	});
});

// ── streaming document pass (S7, task 2.6) ──────────────────────────────────

describe("job-runner · streaming document pass (S7, task 2.6)", () => {
	/**
	 * An analyzer that puts a recurring header line at the top band of every page
	 * (so the furniture detector recognises it) plus a numbered heading line, so
	 * the document pass has both furniture and a heading height to work with.
	 */
	function docpassAnalyzer() {
		const bbox = (b: [number, number, number, number]) => b;
		return {
			forSource() {
				return {
					async analyze(page: number) {
						const headerLine = {
							words: [],
							bbox: bbox([0.1, 0.02, 0.9, 0.05]),
							text: "Pflichtenheft WMS",
							height: 0.02,
						};
						return {
							page,
							size: { widthPt: 595, heightPt: 842 },
							blocks: [],
							lines: [headerLine],
							words: [],
							headingCandidates: [],
						};
					},
					async capability() {
						return { supported: true, version: "24.0" };
					},
					inputHash() {
						return "h";
					},
				};
			},
		};
	}

	it("runs after processing, persists docpass_state per page and writes the docpass checkpoint", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");

		const prepared = {
			...fakePrepared({ pageCount: 3 }),
			pdfPath: "/tmp/x.pdf",
			home: "/tmp",
		};
		const runner = createJobRunner({
			store,
			vision: fakeVision(),
			renderer: fakeRenderer(prepared),
			events: createJobEventBus(),
			config: {
				pageConcurrency: 2,
				visionTokenEstimate: 10,
				visionModel: "test-vlm",
				renderDpi: 200,
				figureDpi: 300,
				figurePass2Kinds: [],
				figurePass2MinArea: 0.02,
				labelCoverageMin: 60,
			},
			analyzer: docpassAnalyzer(),
			emitter: null,
			logger: testLogger,
		});

		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));

		// Every page has a done `docpass` checkpoint (the ordered phase ran).
		const done = await store.listStagesByStatus("page", job.id, "done");
		const docpassPages = done
			.filter((s) => s.stage === DOCPASS_STAGE)
			.map((s) => s.page)
			.sort((a, b) => a - b);
		expect(docpassPages).toEqual([1, 2, 3]);

		// docpass_state was persisted after the LAST page (its lastPage = 3).
		const latest = await store.latestDocpassState(job.id);
		expect(latest?.page).toBe(3);
		expect((latest?.state as { lastPage?: number } | null)?.lastPage).toBe(3);
	});

	it("recognises the recurring header as furniture on the enriched page record", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");

		const prepared = {
			...fakePrepared({ pageCount: 4 }),
			pdfPath: "/tmp/x.pdf",
			home: "/tmp",
		};
		const runner = createJobRunner({
			store,
			vision: fakeVision(),
			renderer: fakeRenderer(prepared),
			events: createJobEventBus(),
			config: {
				pageConcurrency: 2,
				visionTokenEstimate: 10,
				visionModel: "test-vlm",
				renderDpi: 200,
				figureDpi: 300,
				figurePass2Kinds: [],
				figurePass2MinArea: 0.02,
				labelCoverageMin: 60,
			},
			analyzer: docpassAnalyzer(),
			emitter: null,
			logger: testLogger,
		});

		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));

		// The enriched emit-outbox records carry the recurring header as furniture.
		const batches = store.peekEmitBatches(job.id);
		const laterPage = batches.find((b) => b.seq === 4);
		const record = (
			laterPage?.payload as {
				record?: import("@atf/extract-contract/v2").PageRecord;
			} | null
		)?.record;
		expect(record?.furniture?.header).toBe("Pflichtenheft WMS");
	});

	it("resumes the document pass from the last persisted page without reprocessing", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");

		const prepared = {
			...fakePrepared({ pageCount: 4 }),
			pdfPath: "/tmp/x.pdf",
			home: "/tmp",
		};
		const runner = createJobRunner({
			store,
			vision: fakeVision(),
			renderer: fakeRenderer(prepared),
			events: createJobEventBus(),
			config: {
				pageConcurrency: 4,
				visionTokenEstimate: 10,
				visionModel: "test-vlm",
				renderDpi: 200,
				figureDpi: 300,
				figurePass2Kinds: [],
				figurePass2MinArea: 0.02,
				labelCoverageMin: 60,
			},
			analyzer: docpassAnalyzer(),
			emitter: null,
			logger: testLogger,
		});
		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));

		// Snapshot the docpass_state (the pass finished on page 4).
		const before = await store.latestDocpassState(job.id);
		expect((before?.state as { lastPage?: number } | null)?.lastPage).toBe(4);

		// Re-run over the same store: the document pass sees lastPage = pageCount
		// and does nothing, so the persisted state is unchanged.
		await store.requeueJob(job.id);
		const reclaimed = await store.claimNextJob("worker-1", 60);
		if (reclaimed === null) throw new Error("expected reclaim");
		await runner.run(runnerCtx(store, { ...reclaimed, status: "preparing" }));

		const after = await store.latestDocpassState(job.id);
		expect(after?.page).toBe(4);
		expect((after?.state as { lastPage?: number } | null)?.lastPage).toBe(4);
	});
});

describe("job-runner · native source path (task 2.8)", () => {
	const BPMN = `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="P">
    <bpmn:startEvent id="S" name="Start"/>
    <bpmn:task id="T" name="Prüfen"/>
    <bpmn:endEvent id="E" name="Ende"/>
    <bpmn:sequenceFlow id="f1" sourceRef="S" targetRef="T"/>
    <bpmn:sequenceFlow id="f2" sourceRef="T" targetRef="E"/>
  </bpmn:process>
</bpmn:definitions>`;

	/** A prepared source whose `native` field is a built BPMN record set. */
	function nativeBpmnPrepared(reference: string): PreparedSource {
		const built = buildBpmnRecords(reference, new TextEncoder().encode(BPMN));
		return {
			pageCount: built.records.length,
			native: {
				records: built.records,
				nativeAssets: built.nativeAssets,
				warnings: built.warnings,
			},
			docxHeadingHints: null,
			vsdxStructure: null,
			pdfPath: null,
			home: "",
			format: {
				mimeType: "application/bpmn+xml",
				extensions: [".bpmn"],
				kind: "bpmn",
				family: "xml",
				label: "BPMN 2.0 (XML)",
			},
			async render() {
				throw new Error("render must not be called for a native BPMN source");
			},
			async renderFigureCrop() {
				throw new Error(
					"renderFigureCrop must not be called for a native BPMN source",
				);
			},
			async close() {},
		};
	}

	it("emits a BPMN process page with no vision call and stages the native: asset", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");
		const vision = fakeVision();
		const runner = makeRunner(store, nativeBpmnPrepared(REFERENCE), vision);

		const outcome = await runner.run(
			runnerCtx(store, { ...job, status: "preparing" }),
		);
		expect(outcome).toEqual({ status: "completed" });

		// The whole point: no model was ever called.
		expect(vision.calls).toEqual([]);

		// One emit-outbox row (one page), carrying the process figure.
		const batches = store.peekEmitBatches(job.id);
		expect(batches.map((b) => b.seq)).toEqual([1]);
		const [batch] = batches;
		if (batch === undefined) throw new Error("expected an emit batch");
		const payload = batch.payload as {
			record?: {
				blocks: Array<{
					type: string;
					kind?: string;
					transcription?: { format?: string };
				}>;
			};
		};
		const figure = payload.record?.blocks.find((b) => b.type === "figure");
		expect(figure?.kind).toBe("bpmn");
		expect(figure?.transcription?.format).toBe("process");

		// The native: asset for the original .bpmn XML was staged.
		const assets = store.peekAssets(job.id);
		const nativeAsset = assets.find((a) => a.variant === "native");
		expect(nativeAsset).toBeDefined();

		// Page count recorded; job left in emitting for the worker.
		expect(store.peek(job.id)?.page_count).toBe(1);
		expect(store.peek(job.id)?.status).toBe("emitting");
	});
});

// ── text fast-path (S3/S9, task 2.9, requirements 7.5, 18.1) ────────────────

describe("job-runner · text fast-path (task 2.9)", () => {
	/**
	 * An analyzer returning a clean `text`-page geometry: one numbered heading
	 * block and one paragraph block, with a positive page size and words — enough
	 * for the eligibility gate and the deterministic block builder.
	 */
	function textAnalyzer() {
		const bbox = (b: [number, number, number, number]) => b;
		const mkWord = (text: string, b: [number, number, number, number]) => ({
			text,
			bbox: bbox(b),
		});
		function forPage(page: number) {
			const headingLine = {
				words: [mkWord(`${page}.1`, [0.1, 0.1, 0.18, 0.13]), mkWord("Anmeldung", [0.2, 0.1, 0.5, 0.13])],
				bbox: bbox([0.1, 0.1, 0.5, 0.13]),
				text: `${page}.1 Anmeldung`,
				height: 0.03,
			};
			// Enough words for body-text density (>2 words/in² on A4 ≈ >192
			// words), so the classifier calls the page `text`. The meaningful
			// wording ("Artikelnummer BA2b ist Pflicht.") leads; filler follows.
			const paraWords = [
				mkWord("Artikelnummer", [0.1, 0.15, 0.3, 0.18]),
				mkWord("BA2b", [0.31, 0.15, 0.4, 0.18]),
				mkWord("ist", [0.41, 0.15, 0.45, 0.18]),
				mkWord("Pflicht.", [0.46, 0.15, 0.6, 0.18]),
			];
			for (let i = 0; i < 260; i++) {
				paraWords.push(mkWord("Wort", [0.1, 0.15, 0.3, 0.18]));
			}
			const paraLine = {
				words: paraWords,
				bbox: bbox([0.1, 0.15, 0.9, 0.18]),
				text: `Artikelnummer BA2b ist Pflicht. ${"Wort ".repeat(260).trim()}`,
				height: 0.02,
			};
			const headingBlock = {
				lines: [headingLine],
				bbox: headingLine.bbox,
				text: headingLine.text,
			};
			const paraBlock = { lines: [paraLine], bbox: paraLine.bbox, text: paraLine.text };
			return {
				page,
				size: { widthPt: 595, heightPt: 842 },
				blocks: [headingBlock, paraBlock],
				lines: [headingLine, paraLine],
				words: [...headingLine.words, ...paraLine.words],
				headingCandidates: [
					{ text: `${page}.1 Anmeldung`, numbering: `${page}.1`, bbox: headingLine.bbox, height: 0.03 },
				],
			};
		}
		return {
			forSource() {
				return {
					async analyze(page: number) {
						return forPage(page);
					},
					async capability() {
						return { supported: true, version: "24.0" };
					},
					inputHash() {
						return "h";
					},
				};
			},
		};
	}

	function fastPathMetrics() {
		const routes: string[] = [];
		const fidelity: Array<{ flagged: boolean; missingTokens: number }> = [];
		return {
			routes,
			fidelity,
			recordFastPath(route: "fast-path" | "vision") {
				routes.push(route);
			},
			recordTextFidelity(opts: { flagged: boolean; missingTokens: number }) {
				fidelity.push(opts);
			},
		};
	}

	function fastPathRunner(
		store: FakeJobStore,
		prepared: PreparedSource,
		vision: VisionClient,
		analyzer: unknown,
		metrics: unknown,
		overrides: { textFastPath?: boolean; textFastPathMaxInkRatio?: number } = {},
		events = createJobEventBus(),
	) {
		return createJobRunner({
			store,
			vision,
			renderer: fakeRenderer(prepared),
			events,
			config: {
				pageConcurrency: 1,
				visionTokenEstimate: 10,
				visionModel: "test-vlm",
				renderDpi: 200,
				figureDpi: 300,
				figurePass2Kinds: [],
				figurePass2MinArea: 0.02,
				labelCoverageMin: 60,
				textFastPath: overrides.textFastPath ?? true,
				textFastPathMaxInkRatio: overrides.textFastPathMaxInkRatio ?? 0.04,
			},
			// biome-ignore lint/suspicious/noExplicitAny: test stubs
			analyzer: analyzer as any,
			// biome-ignore lint/suspicious/noExplicitAny: test stubs
			metrics: metrics as any,
			emitter: null,
			logger: testLogger,
		});
	}

	/** The text layer matching {@link textAnalyzer}'s geometry for a page. */
	function textLayerFor(page: number): string {
		return `${page}.1 Anmeldung\nArtikelnummer BA2b ist Pflicht. ${"Wort ".repeat(260).trim()}`;
	}

	function preparedWithPdf(
		pageCount: number,
		rawText: (page: number) => string = textLayerFor,
	): PreparedSource {
		// A white page image → ink-outside-blocks ≈ 0, so the fidelity gate is
		// clear; a text layer that matches the S2 geometry, so the coverage and
		// fidelity checks pass; a pdfPath so the runner binds the analyzer.
		return {
			...fakePrepared({ pageCount, rawText }),
			pdfPath: "/tmp/x.pdf",
			home: "/tmp",
		};
	}

	it("builds blocks deterministically and makes NO vision call for a clean text page", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");

		const vision = fakeVision();
		const metrics = fastPathMetrics();
		const events = createJobEventBus();
		const records: import("@atf/extract-contract/v2").PageRecord[] = [];
		events.subscribe(job.id, (e) => {
			if (e.type === "page") records.push(e.record);
		});

		const runner = fastPathRunner(
			store,
			preparedWithPdf(2),
			vision,
			textAnalyzer(),
			metrics,
			{},
			events,
		);
		const outcome = await runner.run(
			runnerCtx(store, { ...job, status: "preparing" }),
		);
		expect(outcome).toEqual({ status: "completed" });

		// The whole point: the vision model was never called.
		expect(vision.calls).toEqual([]);

		// Both pages routed through the fast path, none through vision.
		expect(metrics.routes).toEqual(["fast-path", "fast-path"]);

		// The emitted record carries deterministic heading + paragraph blocks,
		// all source:"text-layer", and is flagged as a fast-path page.
		const record = records[0];
		expect(record?.fidelity?.fastPath).toBe(true);
		expect(record?.class).toBe("text");
		const heading = record?.blocks.find((b) => b.type === "heading");
		const paragraph = record?.blocks.find((b) => b.type === "paragraph");
		expect(heading).toMatchObject({ source: "text-layer", numbering: "1.1", level: 2 });
		expect(paragraph).toMatchObject({ source: "text-layer" });
		if (paragraph?.type === "paragraph") expect(paragraph.text).toContain("BA2b");

		// The vision1 checkpoint recorded zero token usage (budget not charged).
		const check = await store.getStage("page", {
			job_id: job.id,
			page: 1,
			stage: VISION1_STAGE,
		});
		const usage = (check?.output as { parsed?: { usage?: { totalTokens?: number }; fastPath?: boolean } } | null)
			?.parsed;
		expect(usage?.fastPath).toBe(true);
		expect(usage?.usage?.totalTokens).toBe(0);
	});

	it("runs the fidelity check on the fast-path page and it passes for a clean text layer", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");
		const metrics = fastPathMetrics();
		const runner = fastPathRunner(store, preparedWithPdf(1), fakeVision(), textAnalyzer(), metrics);

		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));

		// The check ran (recorded) and did not flag (blocks ARE the text layer).
		expect(metrics.fidelity).toHaveLength(1);
		expect(metrics.fidelity[0]?.flagged).toBe(false);
	});

	it("falls back to vision when the fast path is disabled", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");
		const vision = fakeVision();
		const metrics = fastPathMetrics();
		const runner = fastPathRunner(
			store,
			preparedWithPdf(1),
			vision,
			textAnalyzer(),
			metrics,
			{ textFastPath: false },
		);

		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));

		// Disabled → the model was called and the route is vision.
		expect(vision.calls).toEqual([1]);
		expect(metrics.routes).toEqual(["vision"]);
	});

	it("falls back to vision for a page with too much ink outside the text blocks", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");
		const vision = fakeVision();
		const metrics = fastPathMetrics();
		// A near-zero ink ceiling makes even the white page's tiny ink exceed it —
		// but more robustly, the geometry blocks cover almost nothing so any ink
		// counts as outside. Set the ceiling below what a real page can achieve.
		const runner = fastPathRunner(
			store,
			preparedWithPdf(1),
			vision,
			textAnalyzer(),
			metrics,
			{ textFastPathMaxInkRatio: -1 }, // impossible to satisfy → always vision
		);

		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));
		expect(vision.calls).toEqual([1]);
		expect(metrics.routes).toEqual(["vision"]);
	});

	it("falls back to vision when there is no S2 analyzer bound (no geometry)", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");
		const vision = fakeVision();
		const metrics = fastPathMetrics();
		// No analyzer → no geometry → the fast path never engages.
		const runner = fastPathRunner(
			store,
			preparedWithPdf(1),
			vision,
			null,
			metrics,
		);

		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));
		expect(vision.calls).toEqual([1]);
		expect(metrics.routes).toEqual(["vision"]);
	});

	it("replays a fast-path page on resume with NO model call", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");

		const vision1 = fakeVision();
		const first = fastPathRunner(store, preparedWithPdf(3), vision1, textAnalyzer(), fastPathMetrics());
		await first.run(runnerCtx(store, { ...job, status: "preparing" }));
		expect(vision1.calls).toEqual([]); // fast path: no calls at all

		// Re-queue and re-run with a FRESH vision stub: the fast-path vision1
		// checkpoints are `done`, so the stage fn is not called again — zero model
		// calls, exactly like resuming a vision page.
		await store.requeueJob(job.id);
		const reclaimed = await store.claimNextJob("worker-1", 60);
		if (reclaimed === null) throw new Error("expected reclaim");
		const vision2 = fakeVision();
		const metrics2 = fastPathMetrics();
		const second = fastPathRunner(store, preparedWithPdf(3), vision2, textAnalyzer(), metrics2);
		const outcome = await second.run(
			runnerCtx(store, { ...reclaimed, status: "preparing" }),
		);
		expect(outcome).toEqual({ status: "completed" });
		expect(vision2.calls).toEqual([]); // resumed from checkpoint, no model call
		// The resume replays from the checkpoint, so tryFastPath is not re-entered
		// and no new route is recorded — the pages are already done.
		expect(metrics2.routes).toEqual([]);
	});
});

// ── Tiling (S6): large-format pages split into overlapping tiles ───────────
// Task 5.1, requirements 8.5 / 14.4. A page whose long edge exceeds A3 (here
// forced via a large rendered image) is split into overlapping tiles, each
// transcribed as a technical drawing, merged, and stored as `tile` assets.

/** A0 and A4 in PostScript points (the renderer's pdfinfo page size). */
const A0_PT = { widthPt: 2384, heightPt: 3370 };
const A4_PT = { widthPt: 595, heightPt: 842 };

/** A large page image; the renderer reports the page size separately in points. */
async function largePageImage(): Promise<PageImage> {
	const buffer = await sharp({
		create: { width: 40, height: 55, channels: 3, background: "#ffffff" },
	})
		.png()
		.toBuffer();
	return { buffer, mimeType: "image/png", width: 2200, height: 3000 };
}

/** A vision client that emits no figures on Pass 1 and a drawing per tile. */
function tilingVision(): VisionClient & { pageCalls: number[]; tileCalls: string[] } {
	const pageCalls: number[] = [];
	const tileCalls: string[] = [];
	return {
		pageCalls,
		tileCalls,
		async analyzePage(input) {
			pageCalls.push(input.page);
			return {
				raw: `<summary>Plan ${input.page}</summary><figures></figures><markdown>Plan ${input.page}</markdown>`,
				usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
				requests: 1,
				truncated: false,
				maxTokens: 8192,
			};
		},
		async analyzeFigure(input) {
			tileCalls.push(input.figureId);
			// Each tile returns a small drawing; the shared "Alle Maße in mm" note
			// exercises the overlap dedup in the merge.
			return {
				raw: JSON.stringify({
					format: "drawing",
					titleBlock: { drawingNo: "PL-1" },
					notes: ["Alle Maße in mm", `Kachel ${input.figureId}`],
				}),
				usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
				requests: 1,
				truncated: false,
				maxTokens: 8192,
			};
		},
		async probe() {
			return { available: true };
		},
	};
}

function tilingRunner(
	store: FakeJobStore,
	prepared: PreparedSource,
	vision: VisionClient,
	events = createJobEventBus(),
) {
	return createJobRunner({
		store,
		vision,
		renderer: fakeRenderer(prepared),
		events,
		config: {
			pageConcurrency: 1,
			visionTokenEstimate: 10,
			visionModel: "test-vlm",
			renderDpi: 200,
			figureDpi: 300,
			figurePass2Kinds: [],
			figurePass2MinArea: 0.02,
			labelCoverageMin: 60,
			// Small target so the over-A3 page splits into several tiles.
			tileTargetPixels: 800,
			tileOverlapFraction: 0.1,
			tileMaxPerPage: 9,
			renderMaxPixels: 40_000_000,
		},
		emitter: null,
		logger: testLogger,
	});
}

describe("job-runner · tiling (S6, task 5.1)", () => {
	it("tiles an over-A3 page, stages tile assets and emits a merged drawing figure", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");
		const vision = tilingVision();

		const events = createJobEventBus();
		const records: import("@atf/extract-contract/v2").PageRecord[] = [];
		const tileAssetEvents: string[] = [];
		events.subscribe(job.id, (e) => {
			if (e.type === "page") records.push(e.record);
			if (e.type === "asset" && e.kind === "tile") tileAssetEvents.push(e.assetId);
		});

		const prepared = fakePrepared({ pageCount: 1, identicalImage: await largePageImage(), sizePt: A0_PT });
		const runner = tilingRunner(store, prepared, vision, events);
		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));

		// Multiple tiles were transcribed (over-A3 → more than one).
		expect(vision.tileCalls.length).toBeGreaterThan(1);

		// The page record carries a page-spanning technical_drawing figure with
		// tiles[] and a merged transcription; the shared note is deduped once.
		const figureBlock = records[0]?.blocks.find(
			(b) => b.type === "figure" && b.figureId.endsWith("-tiled"),
		);
		expect(figureBlock?.type).toBe("figure");
		if (figureBlock?.type === "figure") {
			expect(figureBlock.kind).toBe("technical_drawing");
			expect(figureBlock.tiles?.length).toBe(vision.tileCalls.length);
			expect(figureBlock.transcription?.format).toBe("drawing");
			if (figureBlock.transcription?.format === "drawing") {
				const mm = figureBlock.transcription.notes?.filter((n) => n === "Alle Maße in mm");
				expect(mm).toEqual(["Alle Maße in mm"]); // overlap dedup
			}
		}

		// Each tile is emitted as a `tile` asset ref with its own bbox.
		const tileAssets = records[0]?.assets.filter((a) => a.kind === "tile") ?? [];
		expect(tileAssets.length).toBe(vision.tileCalls.length);
		expect(tileAssetEvents.length).toBe(vision.tileCalls.length);
		for (const asset of tileAssets) {
			expect(asset.localId.startsWith("tile:")).toBe(true);
			expect(asset.bbox).toBeDefined();
		}

		// A tiled checkpoint is persisted per tile.
		const firstTile = await store.getStage("tile", {
			job_id: job.id,
			page: 1,
			tile_id: "r0c0",
			stage: TILED_STAGE,
		});
		expect(firstTile?.status).toBe("done");
	});

	it("replays tile checkpoints on resume with no extra model calls", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");
		const vision = tilingVision();
		const prepared = fakePrepared({ pageCount: 1, identicalImage: await largePageImage(), sizePt: A0_PT });

		const first = tilingRunner(store, prepared, vision);
		await first.run(runnerCtx(store, { ...job, status: "preparing" }));
		const firstCount = vision.tileCalls.length;
		expect(firstCount).toBeGreaterThan(1);

		const reclaimed = await store.claimNextJob("worker-1", 60);
		const target = reclaimed ?? { ...job, status: "processing" as const };
		const second = tilingRunner(store, prepared, vision);
		await second.run(runnerCtx(store, target));
		// No additional tile model calls — every tile replayed from its checkpoint.
		expect(vision.tileCalls.length).toBe(firstCount);
	});

	it("does not tile a normal page", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");
		const vision = tilingVision();
		// The default fake image is 100×140 → well under A3, class not drawing.
		const runner = tilingRunner(store, fakePrepared({ pageCount: 1 }), vision);
		await runner.run(runnerCtx(store, { ...job, status: "preparing" }));
		expect(vision.tileCalls).toEqual([]);
	});

	it("does not tile a high-resolution A4 page: pixels are never read as points", async () => {
		// Regression: a 2200×3000 px render of an A4 page used to be taken as a
		// 2200×3000 pt sheet (> A3) and tiled — every page of every document.
		for (const sizePt of [A4_PT, undefined]) {
			const store = createFakeJobStore();
			const job = await seedClaimedJob(store);
			await store.setJobStatus(job.id, "preparing");
			const vision = tilingVision();
			const image = { ...(await largePageImage()), width: 1654, height: 2339 };
			const prepared = fakePrepared({
				pageCount: 1,
				identicalImage: image,
				...(sizePt !== undefined ? { sizePt } : {}),
			});
			const records: import("@atf/extract-contract/v2").PageRecord[] = [];
			const events = createJobEventBus();
			events.subscribe(job.id, (e) => {
				if (e.type === "page") records.push(e.record);
			});
			await tilingRunner(store, prepared, vision, events).run(runnerCtx(store, { ...job, status: "preparing" }));
			expect(vision.tileCalls).toEqual([]);
			// The record carries the real size in points (≈ A4 either way).
			expect(records[0]?.size.wPt).toBeCloseTo(595, 0);
			expect(records[0]?.size.hPt).toBeCloseTo(842, 0);
		}
	});

	it("tiles an A0 page (size reported in points by the renderer)", async () => {
		const store = createFakeJobStore();
		const job = await seedClaimedJob(store);
		await store.setJobStatus(job.id, "preparing");
		const vision = tilingVision();
		// A0 rendered at a low adaptive DPI still reads as A0 via sizePt.
		const image = { ...(await largePageImage()), width: 1414, height: 2000 };
		await tilingRunner(store, fakePrepared({ pageCount: 1, identicalImage: image, sizePt: A0_PT }), vision).run(
			runnerCtx(store, { ...job, status: "preparing" }),
		);
		expect(vision.tileCalls.length).toBeGreaterThan(1);
	});
});
