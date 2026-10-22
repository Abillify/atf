// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * tests/resume-converter-change.test.ts
 *
 * Resume re-pagination after a converter change.
 *
 * The converter identity (the LibreOffice version probe, `probeLibreOfficeIdentity`
 * in `pipeline/office.ts`, or the `AppOverrides.converterIdentity` override) is
 * folded into the pipeline hash. When a deployment swaps the converter, the
 * stored stand no longer matches the new one, and the resume must deal with two
 * consequences:
 *
 *   1. The old converter's page results were produced by a different renderer.
 *      Under `restart-stage` they must NOT be reused — every model stage runs
 *      again against the new converter's output.
 *   2. The new converter can paginate differently: the same source digest can
 *      yield 8 pages where the old one yielded 10. The job must end with the
 *      NEW page count, must not carry pages 9–10 in its result, and must not
 *      fail with an out-of-range error on the stale window.
 *
 * The policy semantics (see `decideResume` in `jobs/snapshot.ts`) are worth
 * stating honestly, because they differ per policy:
 *
 *   - `pin` PAUSES the job on a changed hash — it never re-renders anything.
 *   - `continue` reuses the stored checkpoints DESPITE the hash change (it
 *     adopts the new stand but keeps the old pages), so it cannot be the
 *     "re-render everything" case.
 *   - `restart-stage=<stage>` is the policy that recomputes from the given
 *     stage on: it is the one under which requirement (a) holds.
 *
 * Requirement (c) is the regression guard the other way: with an unchanged
 * identity (same stand) a resume reuses the stored pages and calls the model
 * zero times.
 *
 * The harness mirrors `chaos-resume.test.ts`: a fake store, a deterministic
 * counting vision client, and a fake prepared source of N pages. The prepared
 * source counts its own renders, so "all pages re-rendered" is proven by the
 * counter on the SECOND source instance, not by record equality (the stub's
 * output is deterministic per page, so identical records would not detect a
 * re-run — or a missing one).
 */

import { randomUUID } from "node:crypto";
import type { PageRecord } from "@atf/extract-contract";
import { describe, expect, it } from "vitest";
import { createJobEventBus } from "../src/jobs/events.js";
import { createJobRunner } from "../src/jobs/job-runner.js";
import { createLeaseGuard } from "../src/jobs/lease.js";
import type {
	PageImage,
	PageRenderer,
	PreparedSource,
} from "../src/jobs/page-renderer.js";
import {
	decideResume,
	type PipelineSnapshot,
	type ResumeDecision,
} from "../src/jobs/snapshot.js";
import type { VisionClient } from "../src/vision/client.js";
import { TINY_PNG, testLogger } from "./helpers.js";
import { createFakeJobStore, type FakeJobStore } from "./job-store-fake.js";

const REFERENCE = "tests/handbuch.pdf";
const SOURCE_SHA = "a".repeat(64);
/** The old converter's pagination. */
const PAGE_COUNT = 10;
/** The new converter's pagination of the same source digest. */
const SHRUNK_PAGE_COUNT = 8;
const FIGURE_PAGES = new Set([2, 5]);

const PAGE_IMAGE: PageImage = {
	buffer: TINY_PNG,
	mimeType: "image/png",
	width: 100,
	height: 140,
};

// ── counting vision mock ───────────────────────────────────────────────────

interface CountingVision extends VisionClient {
	/** Pages passed to `analyzePage`, in call order. */
	readonly calls: number[];
}

function countingVision(): CountingVision {
	const calls: number[] = [];
	return {
		calls,
		async analyzePage(input) {
			calls.push(input.page);
			const hasFigure = FIGURE_PAGES.has(input.page);
			const raw = hasFigure
				? `<summary>S${input.page}</summary><figures><figure id="1" bbox="0.1,0.1,0.5,0.5">Diagramm ${input.page}</figure></figures><markdown>Seite ${input.page}\n\n![figure_1]</markdown>`
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

// ── prepared-source fake with a render counter ─────────────────────────────

/** A prepared source standing in for one converter's output of one source. */
interface CountingPrepared {
	readonly prepared: PreparedSource;
	/** Pages passed to `render`, in call order — the re-render counter. */
	readonly renders: number[];
}

function countingPrepared(pageCount: number): CountingPrepared {
	const renders: number[] = [];
	const prepared: PreparedSource = {
		pageCount,
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
			renders.push(page);
			await Promise.resolve();
			return { image: PAGE_IMAGE, rawText: "text", usedOcr: false };
		},
		async pageSizePt() {
			return { widthPt: 612, heightPt: 792 };
		},
		async renderRegion() {
			throw new Error("renderRegion is not used by the job runner");
		},
		async renderFigureCrop() {
			return { buffer: TINY_PNG, mimeType: "image/png", width: 10, height: 10 };
		},
		async close() {},
	};
	return { prepared, renders };
}

function fakeRenderer(prepared: PreparedSource): PageRenderer {
	return {
		async prepare() {
			return prepared;
		},
	};
}

// ── harness ────────────────────────────────────────────────────────────────

const PINNED = { action: "continue-pinned", changed: false } as const;
/** The stand of the old converter. */
const STAND_A: PipelineSnapshot = {
	pipelineHash: "pipe-1",
	promptHash: "prompt-1",
};
/** The stand of the new converter: a different pipeline hash. */
const STAND_B: PipelineSnapshot = {
	pipelineHash: "pipe-2",
	promptHash: "prompt-1",
};

function runnerWith(
	store: FakeJobStore,
	vision: VisionClient,
	prepared: PreparedSource,
) {
	return createJobRunner({
		store,
		vision,
		renderer: fakeRenderer(prepared),
		events: createJobEventBus(),
		config: {
			pageConcurrency: 1,
			visionTokenEstimate: 30,
			visionModel: "test-vlm",
			renderDpi: 200,
			figureDpi: 300,
			figurePass2Kinds: [],
			figurePass2MinArea: 0.02,
			labelCoverageMin: 60,
			maxTransientWaitMs: 0,
		},
		emitter: null,
		logger: testLogger,
		now: () => store.clock(),
		sleep: async (ms) => {
			store.advance(ms);
		},
	});
}

/** Claim the job as `holder` and run it once. */
async function claimAndRun(
	store: FakeJobStore,
	holder: string,
	runner: ReturnType<typeof createJobRunner>,
	options: { resume?: ResumeDecision; stand?: PipelineSnapshot } = {},
) {
	const claimed = await store.claimNextJob(holder, 60);
	if (claimed === null) throw new Error(`expected ${holder} to claim a job`);
	const lease = createLeaseGuard(
		store,
		{ jobId: claimed.id, holder, epoch: Number(claimed.lease_epoch) },
		60,
	);
	if (claimed.status === "queued")
		await store.setJobStatus(claimed.id, "preparing", null, lease.fence);
	const run = runner.run({
		job: {
			...claimed,
			status: claimed.status === "queued" ? "preparing" : claimed.status,
		},
		lease,
		resume: options.resume ?? PINNED,
		logger: testLogger,
		...(options.stand !== undefined ? { stand: options.stand } : {}),
	});
	return { run, lease, claimed };
}

async function seedJob(store: FakeJobStore): Promise<string> {
	const id = randomUUID();
	await store.createJob({
		id,
		reference: REFERENCE,
		source_sha256: SOURCE_SHA,
		collection: "documents",
		pipeline_hash: "pipe-1",
		prompt_hash: "prompt-1",
	});
	return id;
}

/** The staged page records, in page order. */
function recordsOf(store: FakeJobStore, jobId: string): PageRecord[] {
	return store
		.peekEmitBatches(jobId)
		.map((row) => (row.payload as { record?: PageRecord } | null)?.record)
		.filter((r): r is PageRecord => r !== undefined && r !== null)
		.sort((a, b) => a.page - b.page);
}

/** An undisturbed 10-page run whose records are the reference. */
async function referenceRecords(): Promise<{
	store: FakeJobStore;
	jobId: string;
	records: PageRecord[];
}> {
	const store = createFakeJobStore();
	const jobId = await seedJob(store);
	const { prepared } = countingPrepared(PAGE_COUNT);
	const { run } = await claimAndRun(
		store,
		"worker-ref",
		runnerWith(store, countingVision(), prepared),
	);
	expect(await run).toEqual({ status: "completed" });
	return { store, jobId, records: recordsOf(store, jobId) };
}

describe("resume re-pagination after a converter change", () => {
	it("restart-stage after a converter identity change re-renders every page", async () => {
		const store = createFakeJobStore();
		const jobId = await seedJob(store);

		// Run 1: the old converter, 10 pages, stand A.
		const oldConverter = countingPrepared(PAGE_COUNT);
		const vision1 = countingVision();
		const first = await claimAndRun(
			store,
			"worker-1",
			runnerWith(store, vision1, oldConverter.prepared),
			{
				stand: STAND_A,
			},
		);
		expect(await first.run).toEqual({ status: "completed" });
		expect(vision1.calls).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(oldConverter.renders.length).toBeGreaterThan(0);

		// The deployment swaps the converter: the pipeline hash changes. The
		// operator restarts from the first model stage (the only policy that
		// recomputes stored pages — `pin` would pause, `continue` would reuse).
		await store.requeueJob(jobId);
		const resume = decideResume({
			snapshot: STAND_A,
			current: STAND_B,
			policy: "restart-stage",
			restartStage: "vision1",
		});
		expect(resume.action).toBe("restart-stage");
		expect(resume.changed).toBe(true);

		// Run 2: the new converter's output of the same source, stand B. A fresh
		// prepared instance, so its render counter counts only this run.
		const newConverter = countingPrepared(PAGE_COUNT);
		const vision2 = countingVision();
		const second = await claimAndRun(
			store,
			"worker-2",
			runnerWith(store, vision2, newConverter.prepared),
			{
				resume,
				stand: STAND_B,
			},
		);
		expect(await second.run).toEqual({ status: "completed" });

		// No stored page result was reused: every page ran the model again …
		expect(vision2.calls).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		// … and every page was rendered by the NEW converter, not taken from the
		// old one's stored results.
		expect(new Set(newConverter.renders)).toEqual(
			new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
		);

		// The result is consistent: exactly the 10 pages, equal to an
		// undisturbed run's records.
		const reference = await referenceRecords();
		expect(recordsOf(store, jobId)).toEqual(reference.records);
	});

	it("a converter that paginates 10 pages down to 8 re-paginates the resumed job", async () => {
		const store = createFakeJobStore();
		const jobId = await seedJob(store);

		// Run 1: the old converter yields 10 pages.
		const oldConverter = countingPrepared(PAGE_COUNT);
		const first = await claimAndRun(
			store,
			"worker-1",
			runnerWith(store, countingVision(), oldConverter.prepared),
			{
				stand: STAND_A,
			},
		);
		expect(await first.run).toEqual({ status: "completed" });
		expect(store.peek(jobId)?.page_count).toBe(PAGE_COUNT);

		// Run 2: the new converter (different hash) paginates the same digest to
		// 8 pages. The stored 10-page window must not survive into the result.
		await store.requeueJob(jobId);
		const resume = decideResume({
			snapshot: STAND_A,
			current: STAND_B,
			policy: "restart-stage",
			restartStage: "vision1",
		});
		const newConverter = countingPrepared(SHRUNK_PAGE_COUNT);
		const vision2 = countingVision();
		const second = await claimAndRun(
			store,
			"worker-2",
			runnerWith(store, vision2, newConverter.prepared),
			{
				resume,
				stand: STAND_B,
			},
		);

		// The job completes — no "page out of range" failure on the stale window.
		expect(await second.run).toEqual({ status: "completed" });

		// The job ends with the NEW page count, re-read from the fresh prepare.
		expect(store.peek(jobId)?.page_count).toBe(SHRUNK_PAGE_COUNT);

		// Only pages 1..8 were processed, and the result contains exactly them.
		expect(vision2.calls).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(new Set(newConverter.renders)).toEqual(
			new Set([1, 2, 3, 4, 5, 6, 7, 8]),
		);
		const records = recordsOf(store, jobId);
		expect(records.map((r) => r.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(records.some((r) => r.page > SHRUNK_PAGE_COUNT)).toBe(false);
	});

	it("an unchanged converter identity reuses the stored pages (regression guard)", async () => {
		const store = createFakeJobStore();
		const jobId = await seedJob(store);

		const firstConverter = countingPrepared(PAGE_COUNT);
		const vision1 = countingVision();
		const first = await claimAndRun(
			store,
			"worker-1",
			runnerWith(store, vision1, firstConverter.prepared),
			{
				stand: STAND_A,
			},
		);
		expect(await first.run).toEqual({ status: "completed" });
		expect(vision1.calls).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

		// Same identity: the hashes are unchanged, so the resume is pinned and
		// every checkpoint is reused — the model is never called again.
		await store.requeueJob(jobId);
		const resume = decideResume({
			snapshot: STAND_A,
			current: STAND_A,
			policy: "restart-stage",
			restartStage: "vision1",
		});
		expect(resume).toEqual({ action: "continue-pinned", changed: false });

		const secondConverter = countingPrepared(PAGE_COUNT);
		const vision2 = countingVision();
		const second = await claimAndRun(
			store,
			"worker-2",
			runnerWith(store, vision2, secondConverter.prepared),
			{
				resume,
				stand: STAND_A,
			},
		);
		expect(await second.run).toEqual({ status: "completed" });
		expect(vision2.calls).toEqual([]);

		// The stored records are untouched and still exactly the 10 pages.
		const reference = await referenceRecords();
		expect(recordsOf(store, jobId)).toEqual(reference.records);
	});
});
