// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * job-runner-v2-pipeline.test.ts
 *
 * The v2 per-page pipeline behaviours closed after the Phase-2 audit (design
 * §4, §5 S2–S7; requirements 7, 8, 9, 18.1), driven against the in-memory fake
 * store with stub render/vision/analyzer — no poppler, no model, no database:
 *
 *  - Pass-1 Markdown becomes typed blocks (headings, tables with cells,
 *    figures at their reading-order position) and the document pass merges a
 *    cross-page table and fills section paths on vision pages;
 *  - the previous-page context reaches the Pass-1 call and is resume-idempotent
 *    (no second model call, identical record);
 *  - the text fast-path falls back to vision on a flagged fidelity check, on
 *    incomplete token coverage and on table/figure candidates, and gets a
 *    checkpointed page summary over the text-LLM;
 *  - a render-hash duplicate page reuses the source page's Pass 2 (no call);
 *  - every stage execution is reported to the metrics hook.
 */

import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { pageRecordSchema, type PageRecord, type TableBlock } from "@atf/extract-contract/v2";
import { createFakeJobStore, type FakeJobStore } from "./job-store-fake.js";
import { testLogger, TINY_PNG } from "./helpers.js";
import { createLeaseGuard } from "../src/jobs/lease.js";
import { createJobEventBus } from "../src/jobs/events.js";
import {
  createJobRunner,
  CROPS_STAGE,
  DOCPASS_STAGE,
  EMITTED_STAGE,
  FIGURE2_STAGE,
  VISION1_STAGE,
  type JobRunnerConfig,
  type JobRunnerDeps,
} from "../src/jobs/job-runner.js";
import type { PageImage, PageRenderer, PreparedSource } from "../src/jobs/page-renderer.js";
import type { AnalyzePageInput, VisionClient } from "../src/vision/client.js";
import type { SummaryClient } from "../src/summary/client.js";
import type { PageAnalysis } from "../src/pipeline/bbox-layout.js";
import type { ResumeDecision } from "../src/jobs/snapshot.js";
import type { JobRow } from "../src/persistence/types.js";
import type { StageObservation } from "../src/http-metrics.js";

const REFERENCE = "tests/handbuch.pdf";
const SOURCE_SHA = "b".repeat(64);
const RESUME: ResumeDecision = { action: "continue-pinned", changed: false };

const IMAGE_CACHE = new Map<number, PageImage>();
async function pageImage(seed: number): Promise<PageImage> {
  const cached = IMAGE_CACHE.get(seed);
  if (cached !== undefined) return cached;
  const raw = Buffer.alloc(8 * 8 * 3, 255);
  raw[3 * 63] = (seed * 37) % 200; // one dark-ish pixel in the corner, per seed
  const buffer = await sharp(raw, { raw: { width: 8, height: 8, channels: 3 } }).png().toBuffer();
  const image: PageImage = { buffer, mimeType: "image/png", width: 100, height: 140 };
  IMAGE_CACHE.set(seed, image);
  return image;
}

function fakePrepared(options: {
  pageCount: number;
  rawText?: (page: number) => string;
  identical?: boolean;
  pdf?: boolean;
}): PreparedSource {
  return {
    pageCount: options.pageCount,
    native: null,
    docxHeadingHints: null,
    vsdxStructure: null,
    pdfPath: options.pdf === true ? "/tmp/x.pdf" : null,
    home: "/tmp",
    format: { mimeType: "application/pdf", extensions: [".pdf"], kind: "pdf", family: "pdf", label: "PDF" },
    async render(page) {
      const image = await pageImage(options.identical === true ? 1 : page);
      return {
        image,
        rawText: options.rawText?.(page) ?? `text ${page}`,
        usedOcr: false,
        sizePt: { widthPt: 595, heightPt: 842 },
        dpi: 200,
      };
    },
    async renderFigureCrop() {
      return { buffer: TINY_PNG, mimeType: "image/png", width: 10, height: 10 };
    },
    async close() {},
  };
}

function fakeRenderer(prepared: PreparedSource): PageRenderer {
  return {
    async prepare() {
      return prepared;
    },
  };
}

/** A vision stub answering each page from `bodies`, recording every input. */
function scriptedVision(
  bodies: (page: number) => string,
  figureRaw = '{"format":"markdown","text":"stub"}',
): VisionClient & { inputs: AnalyzePageInput[]; figureCalls: string[] } {
  const inputs: AnalyzePageInput[] = [];
  const figureCalls: string[] = [];
  return {
    inputs,
    figureCalls,
    async analyzePage(input) {
      inputs.push(input);
      return {
        raw: bodies(input.page),
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        requests: 1,
        truncated: false,
        maxTokens: 8192,
      };
    },
    async analyzeFigure(input) {
      figureCalls.push(input.figureId);
      return {
        raw: figureRaw,
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

const BASE_CONFIG: JobRunnerConfig = {
  pageConcurrency: 1,
  visionTokenEstimate: 10,
  visionModel: "test-vlm",
  renderDpi: 200,
  figureDpi: 300,
  figurePass2Kinds: [],
  figurePass2MinArea: 0.02,
  labelCoverageMin: 60,
};

function runner(
  store: FakeJobStore,
  prepared: PreparedSource,
  vision: VisionClient,
  extra: Partial<Omit<JobRunnerDeps, "config">> & { config?: Partial<JobRunnerConfig> } = {},
) {
  const { config, ...rest } = extra;
  return createJobRunner({
    store,
    vision,
    renderer: fakeRenderer(prepared),
    events: createJobEventBus(),
    emitter: null,
    logger: testLogger,
    ...rest,
    config: { ...BASE_CONFIG, ...config },
  });
}

async function seedJob(store: FakeJobStore): Promise<JobRow> {
  const id = randomUUID();
  await store.createJob({ id, reference: REFERENCE, source_sha256: SOURCE_SHA });
  const claimed = await store.claimNextJob("worker-1", 60);
  if (claimed === null) throw new Error("expected a claim");
  await store.setJobStatus(id, "preparing");
  return { ...claimed, status: "preparing" };
}

function ctx(store: FakeJobStore, job: JobRow) {
  const lease = createLeaseGuard(store, { jobId: job.id, holder: "worker-1", epoch: Number(job.lease_epoch) }, 60);
  return { job, lease, resume: RESUME, logger: testLogger };
}

async function reclaim(store: FakeJobStore, job: JobRow): Promise<JobRow> {
  await store.requeueJob(job.id);
  const claimed = await store.claimNextJob("worker-1", 60);
  if (claimed === null) throw new Error("expected reclaim");
  return { ...claimed, status: "preparing" };
}

function recordOf(store: FakeJobStore, jobId: string, page: number): PageRecord {
  const row = store.peekEmitBatches(jobId).find((r) => r.seq === page);
  const record = (row?.payload as { record?: PageRecord } | undefined)?.record;
  if (record === undefined) throw new Error(`no record for page ${page}`);
  return record;
}

function body(markdown: string, figures = ""): string {
  return `<summary>S</summary><figures>${figures}</figures><markdown>${markdown}</markdown>`;
}

// ── typed blocks on vision pages ─────────────────────────────────────────

describe("job-runner · Pass-1 Markdown → typed blocks", () => {
  it("emits headings, tables with cells and the figure at its reading-order position", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store);
    const vision = scriptedVision(() =>
      body(
        '# 1 Einleitung\n\nText davor.\n\n![figure_1]\n\nText danach.\n\n<table><thead><tr><th>A</th><th colspan="2">B</th></tr></thead><tr><td rowspan="2">x</td><td>1</td><td>2</td></tr></table>',
        '<figure id="1" kind="diagram" bbox="0.1,0.1,0.5,0.5">Ein Diagramm</figure>',
      ),
    );
    const outcome = await runner(store, fakePrepared({ pageCount: 1 }), vision).run(ctx(store, job));
    expect(outcome).toEqual({ status: "completed" });

    const record = recordOf(store, job.id, 1);
    expect(pageRecordSchema.safeParse(record).success).toBe(true);
    expect(record.blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "figure", "paragraph", "table"]);
    expect(record.blocks[0]).toMatchObject({ type: "heading", level: 1, numbering: "1", text: "Einleitung" });
    const table = record.blocks[4] as TableBlock;
    expect(table.headerRows).toEqual([["A", { text: "B", colspan: 2 }]]);
    expect(table.rows).toEqual([[{ text: "x", rowspan: 2 }, "1", "2"]]);
    // The document pass filled the section path of the body blocks.
    expect(record.blocks[1]?.sectionPath).toEqual(["1 Einleitung"]);
  });

  it("merges a table continued across pages and keeps the outline for vision pages", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store);
    const vision = scriptedVision((page) =>
      page === 1
        ? body(
            "# 2 Wareneingang\n\n<table data-continues=\"true\"><thead><tr><th>Art.</th><th>Menge</th></tr></thead><tr><td>A1</td><td>3</td></tr></table>",
          )
        : body("<table data-continuation=\"true\"><tr><td>A2</td><td>4</td></tr></table>\n\nWeiter im Text."),
    );
    await runner(store, fakePrepared({ pageCount: 2 }), vision).run(ctx(store, job));

    const t1 = recordOf(store, job.id, 1).blocks.find((b) => b.type === "table") as TableBlock;
    const p2 = recordOf(store, job.id, 2);
    const t2 = p2.blocks.find((b) => b.type === "table") as TableBlock;
    expect(t2.tableId).toBe(t1.tableId);
    expect(t2.continuationOf).toBe(t1.tableId);
    expect(p2.blocks.find((b) => b.type === "paragraph")?.sectionPath).toEqual(["2 Wareneingang"]);
  });
});

// ── previous-page context (S3) ───────────────────────────────────────────

describe("job-runner · previous-page context (design §5 S3)", () => {
  const bodies = (page: number): string =>
    page === 1
      ? body(
          "# 3 Lager\n\n## 3.1 Regale\n\n<table data-continues><thead><tr><th>Regal</th><th>Fach</th></tr></thead><tr><td>R1</td><td>F1</td></tr></table>",
        )
      : body(`Seite ${page} Fortsetzung.`);

  it("hands page N−1's headings and open table header to page N's Pass-1 call", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store);
    const vision = scriptedVision(bodies);
    await runner(store, fakePrepared({ pageCount: 2 }), vision).run(ctx(store, job));

    expect(vision.inputs[0]?.prevPage).toBeUndefined();
    expect(vision.inputs[1]?.prevPage).toEqual({
      headingChain: ["3 Lager", "3.1 Regale"],
      lastTableHeader: "Regal | Fach",
    });
    const row = await store.getStage("page", { job_id: job.id, page: 2, stage: VISION1_STAGE });
    const parsed = (row?.output as { parsed?: { prevPageContextHash?: string | null } } | null)?.parsed;
    expect(parsed?.prevPageContextHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is resume-idempotent: a crash after vision1 re-runs without a model call and an identical record", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store);
    const vision = scriptedVision(bodies);
    await runner(store, fakePrepared({ pageCount: 2 }), vision).run(ctx(store, job));
    const before = recordOf(store, job.id, 2);
    expect(vision.inputs).toHaveLength(2);

    // Simulate a crash after page 2's vision1 checkpoint: its downstream
    // (crops, emitted, docpass) is gone, vision1 is kept.
    await store.invalidateDownstream(
      job.id,
      { fromPage: 2, stages: [CROPS_STAGE, EMITTED_STAGE, DOCPASS_STAGE], deleteAssets: false },
      undefined,
    );

    const resumed = await reclaim(store, job);
    const vision2 = scriptedVision(bodies);
    const outcome = await runner(store, fakePrepared({ pageCount: 2 }), vision2).run(ctx(store, resumed));
    expect(outcome).toEqual({ status: "completed" });
    expect(vision2.inputs).toEqual([]); // no second model call
    expect(recordOf(store, job.id, 2)).toEqual(before);
  });

  it("runs page N without context when page N−1 is not finished (no ordering wait)", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store);
    const inner = scriptedVision(bodies);
    // Both pages in one concurrent window, and page 1's model answer is held
    // until page 2 has made its own call: page 1 is provably not done when
    // page 2 builds its context. Page 2 must not wait for it.
    let releasePage1: () => void = () => {};
    const page1Held = new Promise<void>((resolve) => {
      releasePage1 = resolve;
    });
    const vision: VisionClient = {
      ...inner,
      async analyzePage(input) {
        if (input.page === 1) await page1Held;
        else releasePage1();
        return inner.analyzePage(input);
      },
    };
    const outcome = await runner(store, fakePrepared({ pageCount: 2 }), vision, {
      config: { pageConcurrency: 2 },
    }).run(ctx(store, job));
    expect(outcome).toEqual({ status: "completed" });
    const page2 = inner.inputs.find((i) => i.page === 2);
    expect(page2?.prevPage).toBeUndefined();
  });
});

// ── text fast-path fallbacks and page summary (requirement 7.5) ──────────

/** Clean `text`-page geometry from a heading and a paragraph text. */
function geometry(page: number, heading: string, paragraph: string, options: { columns?: boolean } = {}): PageAnalysis {
  const word = (text: string, x: number, y: number): { text: string; bbox: [number, number, number, number] } => ({
    text,
    bbox: [x, y, x + 0.01, y + 0.02],
  });
  const headingWords = heading.split(" ").map((t, i) => word(t, 0.1 + i * 0.011, 0.1));
  const headingLine = { words: headingWords, bbox: [0.1, 0.1, 0.5, 0.13] as [number, number, number, number], text: heading, height: 0.03 };
  const paraWords = paragraph.split(" ").map((t) => word(t, 0.1, 0.15));
  const paraLine = { words: paraWords, bbox: [0.1, 0.15, 0.9, 0.18] as [number, number, number, number], text: paragraph, height: 0.02 };
  const lines = [headingLine, paraLine];
  if (options.columns === true) {
    for (let r = 0; r < 4; r++) {
      const y = 0.3 + r * 0.03;
      lines.push({
        words: [word(`c${r}a`, 0.1, y), word(`c${r}b`, 0.4, y), word(`c${r}c`, 0.7, y)],
        bbox: [0.1, y, 0.71, y + 0.02],
        text: `c${r}a c${r}b c${r}c`,
        height: 0.02,
      });
    }
  }
  const blocks = lines.map((l) => ({ lines: [l], bbox: l.bbox, text: l.text }));
  return {
    page,
    size: { widthPt: 595, heightPt: 842 },
    blocks,
    lines,
    words: lines.flatMap((l) => l.words),
    headingCandidates: [],
  };
}

function analyzerFrom(forPage: (page: number) => PageAnalysis) {
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

const FILLER = "Wort ".repeat(260).trim();

function fastMetrics() {
  const routes: string[] = [];
  const fidelity: Array<{ flagged: boolean; missingTokens: number }> = [];
  const stages: StageObservation[] = [];
  return {
    routes,
    fidelity,
    stages,
    recordFastPath(route: "fast-path" | "vision") {
      routes.push(route);
    },
    recordTextFidelity(opts: { flagged: boolean; missingTokens: number }) {
      fidelity.push(opts);
    },
    recordStage(observation: StageObservation) {
      stages.push(observation);
    },
  };
}

describe("job-runner · text fast-path fallbacks (requirement 7.5)", () => {
  const heading = "1.1 Anmeldung";

  async function runFast(
    analysis: (page: number) => PageAnalysis,
    rawText: (page: number) => string,
    extra: Partial<JobRunnerDeps> = {},
  ) {
    const store = createFakeJobStore();
    const job = await seedJob(store);
    const vision = scriptedVision((page) => body(`Seite ${page}`));
    const metrics = fastMetrics();
    const outcome = await runner(store, fakePrepared({ pageCount: 1, rawText, pdf: true }), vision, {
      analyzer: analyzerFrom(analysis),
      metrics,
      config: { textFastPath: true, textFastPathMaxInkRatio: 0.04 },
      ...extra,
    }).run(ctx(store, job));
    return { store, job, vision, metrics, outcome };
  }

  it("takes the fast path when blocks, coverage and fidelity agree (control)", async () => {
    const paragraph = `Artikelnummer BA2b X1Y Z9Q ist Pflicht. ${FILLER}`;
    const { vision, metrics } = await runFast(
      (p) => geometry(p, heading, paragraph),
      () => `${heading}\n${paragraph}`,
    );
    expect(vision.inputs).toEqual([]);
    expect(metrics.routes).toEqual(["fast-path"]);
  });

  it("falls back to vision when the fidelity check flags a divergence", async () => {
    // Same words (coverage ≥ 98 %), but three identifiers differ: flagged.
    const geometryText = `Artikelnummer BA2b X1Y Z9Q ist Pflicht. ${FILLER}`;
    const layerText = `Artikelnummer BA3b X2Y Z8Q ist Pflicht. ${FILLER}`;
    const { vision, metrics } = await runFast(
      (p) => geometry(p, heading, geometryText),
      () => `${heading}\n${layerText}`,
    );
    expect(metrics.fidelity).toEqual([expect.objectContaining({ flagged: true })]);
    expect(vision.inputs.map((i) => i.page)).toEqual([1]);
    expect(metrics.routes).toEqual(["vision"]);
  });

  it("falls back to vision when the blocks do not cover the text layer", async () => {
    const paragraph = `Kurzer Text. ${FILLER}`;
    const missing = "Dieser ganze Satz fehlt in der Geometrie und muss deshalb über Vision laufen ".repeat(2);
    const { vision, metrics } = await runFast(
      (p) => geometry(p, heading, paragraph),
      () => `${heading}\n${paragraph}\n${missing}`,
    );
    expect(vision.inputs.map((i) => i.page)).toEqual([1]);
    expect(metrics.routes).toEqual(["vision"]);
  });

  it("falls back to vision for a column-aligned table candidate or a figure caption", async () => {
    const paragraph = `Text. ${FILLER}`;
    const table = await runFast(
      (p) => geometry(p, heading, paragraph, { columns: true }),
      () => `${heading}\n${paragraph}\nc0a c0b c0c c1a c1b c1c c2a c2b c2c c3a c3b c3c`,
    );
    expect(table.vision.inputs.map((i) => i.page)).toEqual([1]);

    const captioned = `Abbildung 3 zeigt den Ablauf. ${FILLER}`;
    const figure = await runFast(
      (p) => geometry(p, heading, captioned),
      () => `${heading}\n${captioned}`,
    );
    expect(figure.vision.inputs.map((i) => i.page)).toEqual([1]);
  });

  it("gives a fast-path page a checkpointed page summary over the text-LLM", async () => {
    const paragraph = `Artikelnummer BA2b ist Pflicht. ${FILLER}`;
    const calls: string[] = [];
    const summaryClient: SummaryClient = {
      async summarize(input) {
        calls.push(input.scope);
        return {
          text: "Die Seite regelt die Anmeldung.",
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
          requests: 1,
        } as Awaited<ReturnType<SummaryClient["summarize"]>>;
      },
      async probe() {
        return { available: true } as Awaited<ReturnType<SummaryClient["probe"]>>;
      },
    };
    const { store, job, vision } = await runFast(
      (p) => geometry(p, heading, paragraph),
      () => `${heading}\n${paragraph}`,
      { summaryClient },
    );
    expect(vision.inputs).toEqual([]);
    expect(calls[0]).toBe("page");
    const record = recordOf(store, job.id, 1);
    expect(record.fidelity?.fastPath).toBe(true);
    expect(record.summary).toBe("Die Seite regelt die Anmeldung.");
    const stage = await store.getStage("page", { job_id: job.id, page: 1, stage: "summary:page" });
    expect(stage?.status).toBe("done");
    const pageCalls = calls.filter((c) => c === "page").length;

    // A resume after the emit is lost replays the summary checkpoint.
    await store.invalidateDownstream(
      job.id,
      { fromPage: 1, stages: [CROPS_STAGE, EMITTED_STAGE, DOCPASS_STAGE], deleteAssets: false },
      undefined,
    );
    const resumed = await reclaim(store, job);
    await runner(store, fakePrepared({ pageCount: 1, rawText: () => `${heading}\n${paragraph}`, pdf: true }), vision, {
      analyzer: analyzerFrom((p) => geometry(p, heading, paragraph)),
      summaryClient,
      config: { textFastPath: true, textFastPathMaxInkRatio: 0.04 },
    }).run(ctx(store, resumed));
    expect(calls.filter((c) => c === "page").length).toBe(pageCalls);
    expect(recordOf(store, job.id, 1).summary).toBe("Die Seite regelt die Anmeldung.");
  });
});

// ── dedup reuses Pass 2 (requirement 7.4) ────────────────────────────────

describe("job-runner · render-hash duplicate reuses Pass 2", () => {
  it("copies the source page's figure2 result without a second Pass-2 call", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store);
    const vision = scriptedVision(
      () =>
        body(
          "Prozess:\n\n![figure_1]",
          '<figure id="1" kind="bpmn" bbox="0.1,0.1,0.6,0.6">Ein Ablauf</figure>',
        ),
      JSON.stringify({
        format: "process",
        mermaid: "graph TD; A-->B",
        nodes: [
          { id: "A", type: "start", label: "Start" },
          { id: "B", type: "end", label: "Ende" },
        ],
        edges: [{ from: "A", to: "B" }],
        steps: ["Start", "Ende"],
      }),
    );
    await runner(store, fakePrepared({ pageCount: 2, identical: true }), vision, {
      config: { figurePass2Kinds: ["bpmn"] },
    }).run(ctx(store, job));

    expect(vision.inputs.map((i) => i.page)).toEqual([1]);
    expect(vision.figureCalls).toEqual(["p1-f1"]);

    const p2 = recordOf(store, job.id, 2);
    const figure = p2.blocks.find((b) => b.type === "figure");
    expect(figure).toMatchObject({ type: "figure", figureId: "p2-f1", kind: "bpmn" });
    if (figure?.type === "figure") expect(figure.transcription?.format).toBe("process");
    // Reading order kept on the copy: the figure follows its paragraph.
    expect(p2.blocks.map((b) => b.type)).toEqual(["paragraph", "figure"]);
    const copied = await store.getStage("figure", { job_id: job.id, page: 2, figure_id: "p2-f1", stage: FIGURE2_STAGE });
    expect(copied?.status).toBe("done");
  });
});

// ── stage metrics (requirement 18.1) ─────────────────────────────────────

describe("job-runner · stage metrics", () => {
  it("reports every stage execution, and reuse on resume", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store);
    const metrics = fastMetrics();
    const vision = scriptedVision((page) => body(`Seite ${page}`));
    await runner(store, fakePrepared({ pageCount: 1 }), vision, { metrics }).run(ctx(store, job));

    const vision1 = metrics.stages.find((s) => s.stage === VISION1_STAGE);
    expect(vision1).toMatchObject({ outcome: "done", tokens: 30 });
    expect(vision1?.durationMs).toBeGreaterThanOrEqual(0);
    expect(metrics.stages.some((s) => s.stage === EMITTED_STAGE && s.outcome === "done")).toBe(true);
    expect(metrics.stages.some((s) => s.stage === DOCPASS_STAGE && s.outcome === "done")).toBe(true);

    // A resume that must re-run the emit reuses vision1.
    await store.invalidateDownstream(
      job.id,
      { fromPage: 1, stages: [CROPS_STAGE, EMITTED_STAGE, DOCPASS_STAGE], deleteAssets: false },
      undefined,
    );
    const resumedMetrics = fastMetrics();
    await runner(store, fakePrepared({ pageCount: 1 }), vision, { metrics: resumedMetrics }).run(
      ctx(store, await reclaim(store, job)),
    );
    expect(resumedMetrics.stages.find((s) => s.stage === VISION1_STAGE)?.outcome).toBe("reused");
  });
});
