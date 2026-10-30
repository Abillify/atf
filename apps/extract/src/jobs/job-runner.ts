// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/job-runner.ts
 *
 * The real {@link JobRunner}: the v1 per-page pipeline ported onto stages and a
 * DB-backed ordered scheduler.
 *
 * ## What it does
 *
 * The v1 pipeline rendered every page in parallel with `mapOrdered`, collected
 * the whole document in memory, and returned it. That is fine for a 40-page
 * upload and impossible for a 10 000-page job: the array alone would be
 * gigabytes. This runner replaces the in-memory fan-out with a *DB-backed
 * ordered scheduler*. It repeatedly asks the store for the next window of
 * unfinished page numbers (`nextRunnablePages`, LIMIT `PAGE_CONCURRENCY`), runs
 * those pages concurrently through their stages, and loops. The store's `LIMIT`
 * is what keeps memory flat: the runner never holds more than `PAGE_CONCURRENCY`
 * pages, and never builds a full-document array.
 *
 * Each page runs the same work v1 did, now as {@link StageRunner} stages so a
 * resume reuses completed checkpoints without a model call:
 *
 *   render   deterministic — rasterise the page and read its text layer
 *   vision1  the one model call — summary, figures, body Markdown
 *   parse    deterministic — the tolerant v1 parser over the raw response
 *   crops    deterministic — cut each figure and stage it to the asset outbox
 *   emitted  the page's emit-outbox row is staged (the cursor stage)
 *
 * `render` and `parse` are folded onto `vision1` in one `runStage` closure —
 * the model call is the expensive, checkpointed unit, and its raw response is
 * what a `reparse` re-parses. The crop and emit steps have their own cursor
 * checkpoints so a resume that already sent a page does not re-cut its crops.
 *
 * Figure crops are written to the asset staging area (`asset_outbox`) the moment
 * they are produced, and the page's emit-outbox row is staged as soon as the
 * page's stages complete — both in page order. The actual send to Search is task
 * 1.12; here we only stage. As each page finishes, a {@link JobEvent} is
 * published so the SSE stream and the callback (task 1.14 wires the callback
 * itself) are fed from job/stage events rather than from an in-memory pipeline.
 *
 * ## What it does NOT do
 *
 * No Search-side revision/commit, no emitter send/reconcile, no streaming
 * document pass, no tiling, no new prompts. This is the structural port; the
 * vision prompt and parser are reused verbatim.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "pino";
import { buildAssetId, figureLocalId, pageLocalId, tileLocalId, sha256Hex } from "@atf/extract-contract";
import {
  buildFigureId,
  buildFigurePlaceholder,
  isValidBoundingBox,
  type BoundingBox,
} from "@atf/extract-contract/v1";
import type {
  AssetRef,
  Block,
  BBox,
  IdentifyRequest,
  IdentifyResponse,
  PageRecord,
  TileRef,
  Transcription,
} from "@atf/extract-contract/v2";
import { Readable } from "node:stream";
import { RevisionTransientError } from "../revision-client.js";
import type { SourceStore } from "../source-store.js";
import { resolveFormat } from "../formats.js";
import { ExtractError } from "../errors.js";
import type { OcrClient } from "../pipeline/ocr.js";
import { quotedParentOf, withQuotedHistory } from "../pipeline/native/index.js";
import { textFingerprint } from "./fingerprint.js";
import {
  PAGE_WINDOW_KEY,
  firstPageOf,
  hasPageSelection,
  pageWindowOf,
} from "./page-window.js";
import {
  EMAIL_KEY,
  FINGERPRINT_MAX_PAGES,
  IDENTITY_KEY,
  INHERITED_ATTRIBUTE_KEYS,
  attachmentReference,
  childJobId,
  identityOf,
  identifyRequestFor,
  ingestOptionsOf,
  resolveVersion,
  type JobIdentity,
} from "./identity.js";
import type { ExtractStore } from "../persistence/index.js";
import {
  LeaseLostError,
  type JobRow,
  type AssetOutboxRow,
  type Fence,
  type PageStageRow,
  type StageUnit,
} from "../persistence/types.js";
import type { StageKey } from "../persistence/extract-queries.js";
import type { VisionClient, VisionPageResult } from "../vision/client.js";
import {
  parseVisionPage,
  parseTranscription,
  labelCoverage,
  type ParsedVisionPage,
} from "../vision/response.js";
import type { FigureCrop } from "../pipeline/raster.js";
import type { JobRunContext, JobRunner, JobRunOutcome } from "./worker.js";
import type { JobEventBus } from "./events.js";
import {
  BudgetExhaustedError,
  DEFAULT_BACKOFF,
  PermanentStageError,
  StageNotDueError,
  TransientStageError,
  backoffMs,
  createStageRunner,
  isStageOutput,
  recordModelResponse,
  type BudgetLedger,
  type StageExecution,
  type StageOutput,
  type StageRunner,
  type ModelPricing,
} from "./stage-runner.js";
import {
  RESTARTABLE_STAGES,
  reusePolicyFor,
  standKey as standKeyOf,
  stageOrderIndex,
  type PipelineSnapshot,
} from "./snapshot.js";
import {
  createDbBudgetLedger,
  createTenantDailyPageBudget,
  tenantDailyBudgetFailureMessage,
  type TenantDailyPageBudget,
} from "./budget.js";
import {
  classifyRenderedPage,
  resolvePageSizePt,
  type Classification,
  type PageClass,
} from "./page-classifier.js";
import { planTiles, shouldTilePage } from "../pipeline/tiling.js";
import { mergeTileTranscriptions, type TileContribution } from "../pipeline/tile-merge.js";
import {
  buildTextFastPathBlocks,
  checkFastPathCoverage,
  checkFastPathFidelity,
  detectFastPathCandidates,
  fastPathEligibility,
  fastPathMarkdown,
} from "../pipeline/text-fast-path.js";
import {
  MARKDOWN_BLOCKS_VERSION,
  headingDisplayText,
  parseMarkdownBlocks,
  tableHeaderText,
} from "../pipeline/markdown-blocks.js";
import type { PrevPageContext } from "../vision/prompts.js";
import { SUMMARY_PROMPT_VERSION } from "../summary/prompts.js";
import { TransientSummaryFailure } from "../summary/client.js";
import type { StageObservation } from "../http-metrics.js";
import { createDedupRegistry, renderHash, type DedupRegistry } from "./page-dedup.js";
import type { PageAnalyzer, PreparedAnalyzer } from "./page-analyzer.js";
import type { PageAnalysis } from "../pipeline/bbox-layout.js";
import { snapFigureBBox } from "../pipeline/bbox-snap.js";
import type { FigureKind } from "@atf/extract-contract/v2";
import type { PreparedSource, PageImage, PageRenderer, RenderedPageInput } from "./page-renderer.js";
import type { Emitter, AssetLoader } from "./emitter.js";
import type { AssetBody } from "../revision-client.js";
import {
  createDocumentPass,
  parseDocpassState,
  type DocpassState,
} from "./docpass/document-pass.js";
import type { SummaryClient } from "../summary/client.js";
import { createSummaryGenerator, type SummaryGenerator } from "../summary/generator.js";
import type { EmitOutcome } from "./emitter.js";

/** The per-page stages, in order. The last one is the scheduler's cursor. */

/** Spread helper: attach a model's prices to a stage budget when configured. */
function pricingOf(pricing: ModelPricing | undefined): { pricing?: ModelPricing } {
  return pricing !== undefined ? { pricing } : {};
}

export const RENDER_STAGE = "render";
export const VISION1_STAGE = "vision1";
export const CROPS_STAGE = "crops";
/** The per-figure Pass-2 stage; keyed per figure. */
export const FIGURE2_STAGE = "figure2";

/** The per-tile transcription stage; keyed per tile. */
export const TILED_STAGE = "tiled";
/**
 * The strictly-ordered streaming document pass.
 * Runs AFTER the concurrent per-page stages, walking pages 1..N in order and
 * carrying the running state persisted in `docpass_state`.
 */
export const DOCPASS_STAGE = "docpass";
export const EMITTED_STAGE = "emitted";

/**
 * The stage whose `done` checkpoint marks a page fully processed by the
 * concurrent scheduler. The document pass (S7) runs after every page reaches
 * this cursor, so it is deliberately the pre-docpass cursor: the concurrent
 * window drives pages to `emitted` (base record staged), then the ordered
 * document pass enriches each in page order.
 */
export const CURSOR_STAGE = EMITTED_STAGE;
/**
 * Pages past the free page slots whose model-resolution render is warmed in the
 * same window (`PreparedSource.prefetch`). Bounds the pre-rendered PNGs held in
 * memory to about this many beyond the pages in flight.
 */
const RENDER_LOOKAHEAD_PAGES = 8;

/** Tunables for a run. */
export interface JobRunnerConfig {
  /** Pages of one job in flight at once; bounds the scheduler's memory. */
  pageConcurrency: number;
  /** Rough per-page token estimate for the budget guard before a model call. */
  visionTokenEstimate: number;
  /** Recorded on the page record's pipeline-ish fields. */
  visionModel: string;
  renderDpi: number;
  /**
   * FIGURE_DPI — the resolution a figure crop is re-rendered at for Pass 2.
   * The crop shown to the Pass-2 model is rendered at
   * this DPI, higher than the model-resolution page, so small labels stay
   * legible.
   */
  figureDpi: number;
  /** The figure kinds that get a Pass-2 transcription (FIGURE_PASS2_KINDS). */
  figurePass2Kinds: FigureKind[];
  /**
   * The smallest figure, as a fraction of page area, worth a Pass-2 call
   * (FIGURE_PASS2_MIN_AREA). A figure below this fraction is described only.
   */
  figurePass2MinArea: number;
  /**
   * The minimum percentage of a figure's `labels` that must appear in its
   * Pass-2 transcription before it is trusted (LABEL_COVERAGE_MIN). Below it,
   * Extract warns and retries Pass 2 once.
   */
  labelCoverageMin: number;
  /**
   * The long edge, in pixels, a single tile of a large-format page is rendered
   * towards (TILE_TARGET_PIXELS). Drives the tile count
   * and per-tile DPI. Default 2000 when omitted.
   */
  tileTargetPixels?: number;
  /**
   * The fraction a tile's own extent adjacent tiles overlap by
   * (TILE_OVERLAP_FRACTION). Default 0.1 (10 %) when omitted.
   */
  tileOverlapFraction?: number;
  /**
   * Hard ceiling on `cols × rows` tiles for one page (TILE_MAX_PER_PAGE; budget
   * guard). Default 16 when omitted.
   */
  tileMaxPerPage?: number;
  /**
   * Hard pixel ceiling on a single tile's rendered area (RENDER_MAX_PIXELS).
   * Default 40 MP when omitted; keeps a tile decode under the bomb guard.
   */
  renderMaxPixels?: number;
  /**
   * Enable the deterministic text fast-path (TEXT_FAST_PATH; task 2.9,
   * ). When true, a `text` page with no table/figure candidates
   * and usable S2 geometry builds its blocks from that geometry with no vision
   * call. Default off when omitted, so a runner constructed without this config
   * behaves exactly as before this task.
   */
  textFastPath?: boolean;
  /**
   * The ink-outside-blocks ceiling for fast-path eligibility
   * (TEXT_FAST_PATH_MAX_INK_RATIO). A `text` page qualifies
   * only when its ink outside the text blocks is at or below this fraction.
   * Default 0.04 when omitted.
   */
  textFastPathMaxInkRatio?: number;
  /**
   * The summary text-LLM model id, folded into a summary stage's
   * input hash so a model change recomputes. Undefined when SUMMARY_URL is not
   * configured (the summary pass is then skipped).
   */
  summaryModel?: string | undefined;
  /**
   * Rough per-summary output-token estimate for the budget guard before a
   * summary model call. Default 512 when omitted.
   */
  summaryTokenEstimate?: number | undefined;
  /**
   * USD per million tokens of the vision model (VISION_INPUT/OUTPUT_TOKEN_COST),
   * booked into the job's `cost_usd` per call. Omitted books tokens only.
   */
  visionPricing?: ModelPricing | undefined;
  /** USD per million tokens of the summary model (SUMMARY_INPUT/OUTPUT_TOKEN_COST). */
  summaryPricing?: ModelPricing | undefined;
  /**
   * JOB_MAX_TRANSIENT_WAIT_MS: how long a run keeps retrying
   * a transiently failing dependency (vision, text LLM, Search) in place, with
   * backoff, before it hands the job back as `paused(dependency)` with an
   * auto-resume instant. Default 0: pause on the first transient stall.
   */
  maxTransientWaitMs?: number;
  /**
   * VISION_BUDGET_PAGES_PER_DAY: VLM pages the
   * job's tenant may spend per UTC day across all its jobs. 0 (default when
   * omitted) disables the cap. Only consulted for a job with an attributable
   * tenant; over the cap the run fails with `BUDGET_EXCEEDED`.
   */
  visionBudgetPagesPerDay?: number;
  /**
   * MAX_PAGES: the ceiling on the pages a single job may
   * process. The v1 extractor refuses an over-long document before any model
   * call; the v2 runner must apply the same ceiling, or a job whose token
   * budget is unset (and a job with no attributable tenant, which the daily
   * budget leaves uncapped) drives vision over every page without bound. 0
   * (default when omitted) disables the check, matching the v1 extractor.
   */
  maxPages?: number;
}

export interface JobRunnerDeps {
  store: ExtractStore;
  vision: VisionClient;
  renderer: PageRenderer;
  events: JobEventBus;
  config: JobRunnerConfig;
  logger: Logger;
  /**
   * The deterministic S2 page analyzer. Optional: when present, the
   * runner analyses each page's geometry and feeds the numbered-heading
   * candidates to the Pass-1 prompt. Absent in a
   * deployment or test that has not wired S2 — the page then falls through to
   * vision with no hints, exactly as before this task.
   */
  analyzer?: PageAnalyzer | null;
  /**
   * The outbox emitter. Optional: a deployment without Search runs
   * processing → emitting and completes without sending anything, exactly as
   * before this task. When present, the runner invokes it in the `emitting`
   * phase, streaming the staged outbox to Search and reconciling on resume.
   */
  emitter?: Emitter | null;
  /**
   * The text-LLM client for the summary hierarchy.
   * Optional: a deployment without `SUMMARY_URL` passes `null`, the summary pass
   * is skipped cleanly and `document.end.summaries` stays empty — the job still
   * completes. When present, the document pass produces section summaries as
   * sections close and chapter/document summaries at the end, each a
   * checkpointed stage over this client. The per-job generator is constructed
   * inside the run so it binds to the run's stage runner and budget ledger.
   */
  summaryClient?: SummaryClient | null;
  /**
   * Observability hooks. Optional so the runner is
   * testable with a no-op. `recordFastPath` counts each page's route — the
   * deterministic text fast-path or the vision path — which `/metrics` exposes
   * as the "Anteil Fast-Path" share. `recordTextFidelity` keeps the fast-path
   * page's fidelity check on the same counter a vision page uses, so the check
   * "stays active" as a real, measured call.
   */
  metrics?: RunnerMetrics | null;
  /**
   * Search's source identification (dedup, canonical reference). Optional: a
   * deployment without Search, or a test, ingests every source as before —
   * no duplicate skipping, but the version is still detected and emitted.
   */
  identifier?: SourceIdentifier | null;
  /**
   * The content-addressed source store, for e-mail attachments: each one is
   * stored and ingested as a job of its own. Without it attachments are only
   * listed in the e-mail's text.
   */
  sourceStore?: SourceStore | null;
  /**
   * The Tesseract OCR fallback. Optional: when
   * absent or disabled (`OCR_FALLBACK=off`, the default), a VLM outage fails a
   * scanned page for a later retry exactly as before. When enabled, the runner
   * recognises the page image with Tesseract instead and records a warning on
   * the page, so a model outage degrades to searchable OCR text rather than
   * missing content.
   */
  ocr?: OcrClient | null;
  /** The wall clock used for backoff decisions; injectable for tests. */
  now?: () => Date;
  /**
   * Wait `ms` (or until `signal` aborts) before retrying a transient stall in
   * place. Injectable so tests can advance a fake clock instead of sleeping.
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The slice of the revision client the runner uses to identify a source. */
export interface SourceIdentifier {
  identify(args: {
    request: IdentifyRequest;
    collection?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<IdentifyResponse | null>;
}

/**
 * Per-run context carried through async continuations (the concurrent page
 * window included), so the lease fence and the run's stand reach every write
 * and every input hash without threading them through each helper.
 */
interface RunScope {
  fence: Fence;
  signal: AbortSignal;
  stand: PipelineSnapshot;
  standKey: string;
}

/** Config keys the runner keeps on the job row. */
const REPARSE_FLAG = "reparse";
const REPARSE_APPLIED_FLAG = "reparseApplied";
const RESTART_APPLIED_MARKER = "restartApplied";

/** Model-calling stages, reused regardless of hash while a reparse is applied. */
function isModelStage(stage: string): boolean {
  return (
    stage === VISION1_STAGE ||
    stage === FIGURE2_STAGE ||
    stage === TILED_STAGE ||
    stage.startsWith("summary:")
  );
}

/** Default sleep: a timer that resolves early (without throwing) on abort. */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** The observability surface the runner records against. */
export interface RunnerMetrics {
  /** Count a page's route: the deterministic fast path, or the vision path. */
  recordFastPath(route: "fast-path" | "vision"): void;
  /** Record a text-fidelity check outcome for a page. */
  recordTextFidelity(options: { flagged: boolean; missingTokens: number }): void;
  /**
   * Record one stage execution: outcome, duration and model
   * tokens. Optional so a metrics stub without it still type-checks; the
   * production wiring passes the shared {@link import("../http-metrics.js").HttpMetrics}.
   */
  recordStage?(observation: StageObservation): void;
}

/**
 * The Prometheus stage label of a checkpoint stage. Summary stages carry the
 * section id in their stage string (`summary:section:<id>`); they collapse onto
 * one bounded `summary` label.
 */
function stageMetricLabel(stage: string): string {
  return stage.startsWith("summary:") ? "summary" : stage;
}

/**
 * Version of the per-page pipeline behaviour this runner implements (S2
 * analyzer wiring, typed Markdown blocks, previous-page context, real page
 * sizes, fast-path fallback, dedup reuse of Pass 2/tiles). Folded into the
 * pipeline snapshot (`index.ts`), so a deployment that changes it trips a
 * pinned job's `resume_policy` instead of silently mixing two behaviours.
 */
export const PIPELINE_REVISION = "2.1.0";

/** The persisted parsed shape of the vision stage, enough to rebuild a page. */
interface VisionStageParsed {
  summary: string | undefined;
  markdown: string;
  figures: Array<{
    id: string;
    description: string;
    /**
     * The model-supplied figure kind. Optional so a checkpoint
     * written before this field existed still loads; `buildPageRecord` falls
     * back to `"other"`.
     */
    kind?: FigureKind | undefined;
    caption?: string | undefined;
    bbox: BoundingBox | undefined;
    /**
     * The deterministically snapped figure bbox (task 2.4, S4): the Pass-1
     * bbox expanded 3 %, trimmed to the ink and aligned to the adjacent text
     * blocks. Used for the crop and the emitted block so both reflect the
     * refined region. Optional so a checkpoint written before S4 existed still
     * loads; `buildPageRecord`/crops then fall back to the raw `bbox`.
     */
    snappedBbox?: BoundingBox | undefined;
    /**
     * The verbatim words of the text layer inside the snapped bbox (task 2.4,
     * ). Undefined for a scan or a container without
     * `-bbox-layout` geometry.
     */
    regionText?: string | undefined;
    /** `regionText` deduplicated and normalised. */
    labels?: string[] | undefined;
    /**
     * The structured Pass-2 transcription (task 2.5, S5). Filled by the
     * per-figure `figure2` stage for a gated kind; absent for a figure that got
     * no Pass 2 (kind not in `FIGURE_PASS2_KINDS`, below the minimum area, or
     * the budget ran out). Persisted on the figure so `buildPageRecord` emits it
     * on the v2 figure block and a resume replays it with no model call.
     */
    transcription?: Transcription | undefined;
  }>;
  /**
   * Tables the model flagged as crossing a page boundary. Carried on the
   * checkpoint so the document pass can merge them. Optional so a checkpoint
   * written before this field existed still loads.
   */
  tables?: Array<{ index: number; continues: boolean; continuationOf: boolean }>;
  warnings: string[];
  usedOcr: boolean;
  usage: { requests: number; promptTokens: number; completionTokens: number; totalTokens: number };
  truncated: boolean;
  size: { wPt: number; hPt: number };
  imageWidth: number;
  imageHeight: number;
  /**
   * The deterministic page class. Persisted on the vision checkpoint
   * so a checkpoint reuse (resume or a render-hash duplicate) keeps the same
   * classification without re-running the classifier.
   */
  pageClass?: PageClass;
  /**
   * The page's render hash. Persisted so a later
   * identical page can reuse this page's vision result instead of calling the
   * model again. `null` when the image could not be hashed.
   */
  renderHash?: string | null;
  /**
   * True when this page took the deterministic text fast-path (task 2.9,
   * ): its blocks were built from the S2 geometry with NO vision
   * call, so `usage` is all-zero. Persisted so a resume replays the page from
   * its checkpoint with no model call, exactly like a vision page. Optional so
   * a checkpoint written before this field existed still loads.
   */
  fastPath?: boolean;
  /**
   * The deterministic blocks built from the S2 geometry on the fast path.
   * Present only when `fastPath` is true; `buildPageRecord` emits these
   * verbatim instead of deriving a paragraph from the (empty) vision markdown.
   */
  fastPathBlocks?: Block[];
  /**
   * The previous-page context actually handed to the Pass-1 prompt, and its
   * hash. `null` when the page ran without context (first page, page N−1 not
   * finished yet, fast path, or a dedup copy). Recorded on the checkpoint so
   * the input that shaped the model's answer is auditable; see
   * {@link prevPageContextFor} for why it is deliberately NOT part of the
   * vision1 input hash.
   */
  prevPageContext?: PrevPageContext | null;
  prevPageContextHash?: string | null;
  /**
   * The page this page's vision result was copied from by the render-hash
   * dedup. Set only on a duplicate; Pass 2 and tiling then
   * copy the source page's `figure2`/`tiled` results instead of calling the
   * model again.
   */
  dedupOf?: number;
  /**
   * The result of the large-format tiling stage. Present only for a page that was
   * split into overlapping tiles (`drawing` class or over-A3): it carries the
   * merged per-tile transcription and the `tile:` asset refs, which
   * `buildPageRecord` emits as a page-spanning `technical_drawing` figure block
   * with `tiles[]`. Absent for a normal (single-tile) page. Filled by
   * `runTilePass` after the figure Pass 2 stage; persisted only implicitly via the
   * per-tile `tiled` checkpoints, so a resume replays each tile with no model call
   * and re-merges deterministically.
   */
  tiled?: {
    /** The merged, overlap-deduplicated transcription of the whole plan. */
    transcription: Transcription;
    /** The rendered tiles as `tile` asset refs, in grid order. */
    tiles: TileRef[];
  };
}

/**
 * Build the real job runner. It advances the job through `preparing →
 * processing → emitting`, drives every page through its stages in strict order
 * with bounded concurrency, and returns a terminal-ish outcome the worker
 * finalises (`completed`/`paused`/`failed`).
 */
export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  const { store, renderer, events, config, logger } = deps;
  const emitter = deps.emitter ?? null;
  const identifier = deps.identifier ?? null;
  const sourceStore = deps.sourceStore ?? null;
  const analyzer = deps.analyzer ?? null;
  const metrics = deps.metrics ?? null;
  const ocr = deps.ocr ?? null;
  const fastPathEnabled = config.textFastPath === true;
  const fastPathMaxInkRatio = config.textFastPathMaxInkRatio ?? 0.04;
  const clock = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const maxTransientWaitMs = Math.max(0, config.maxTransientWaitMs ?? 0);

  // ── run scope and guarded model clients ───────────────────────────────
  // The run's fence, stand and abort signal travel with the async context, so
  // the helpers below (and the concurrent page window) see them without extra
  // parameters. The model clients are wrapped once: every call carries the
  // run's AbortSignal (a lost lease cancels in-flight calls and refuses new
  // ones), and every response is recorded against the running stage so its raw
  // bytes and tokens are persisted even when the stage fails afterwards.
  const runScope = new AsyncLocalStorage<RunScope>();

  function scope(): RunScope {
    const current = runScope.getStore();
    if (current === undefined) throw new Error("job-runner: no active run scope");
    return current;
  }

  /** Throw LeaseLostError once the run has been aborted. */
  function assertLive(): void {
    const current = runScope.getStore();
    if (current?.signal.aborted) throw new LeaseLostError(current.fence);
  }

  function withRunSignal<T extends { signal?: AbortSignal | undefined }>(input: T): T {
    const current = runScope.getStore();
    if (current === undefined) return input;
    const signal =
      input.signal !== undefined ? AbortSignal.any([input.signal, current.signal]) : current.signal;
    return { ...input, signal };
  }

  async function guardedCall<R extends { raw: string }>(call: () => Promise<R>): Promise<R> {
    assertLive();
    let result: R;
    try {
      result = await call();
    } catch (err) {
      // An abort caused by a lost lease surfaces as a lost lease, not as a
      // vision outage (which would be retried).
      assertLive();
      throw err;
    }
    recordModelResponse(result);
    assertLive();
    return result;
  }

  const vision: VisionClient = {
    analyzePage: (input) => guardedCall(() => deps.vision.analyzePage(withRunSignal(input))),
    analyzeFigure: (input) => guardedCall(() => deps.vision.analyzeFigure(withRunSignal(input))),
    probe: () => deps.vision.probe(),
  };

  const innerSummary = deps.summaryClient ?? null;
  const summaryClient: SummaryClient | null =
    innerSummary === null
      ? null
      : {
          async summarize(input) {
            assertLive();
            const result = await innerSummary.summarize(input);
            recordModelResponse({ raw: result.text, usage: result.usage, requests: result.requests });
            assertLive();
            return result;
          },
          probe: () => innerSummary.probe(),
        };

  /** The input hash of a stage: its own inputs plus the run's stand. */
  function stageHash(parts: ReadonlyArray<string | number>): string {
    return sha256Hex([...parts, `stand:${scope().standKey}`].join("\n"));
  }

  async function run(ctx: JobRunContext): Promise<JobRunOutcome> {
    const { job, lease } = ctx;
    const abort = new AbortController();
    const onOuterAbort = (): void => abort.abort();
    if (ctx.signal !== undefined) {
      if (ctx.signal.aborted) abort.abort();
      else ctx.signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    const stand: PipelineSnapshot = ctx.stand ?? {
      pipelineHash: job.pipeline_hash ?? "",
      promptHash: job.prompt_hash ?? "",
    };
    const runContext: RunScope = {
      fence: lease.fence,
      signal: abort.signal,
      stand,
      standKey: standKeyOf(stand),
    };
    try {
      return await runScope.run(runContext, () => runJob(ctx, abort));
    } catch (err) {
      if (err instanceof LeaseLostError) abort.abort();
      throw err;
    } finally {
      ctx.signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  async function runJob(
    ctx: JobRunContext,
    abort: AbortController,
  ): Promise<JobRunOutcome> {
    const { lease } = ctx;
    let job = ctx.job;
    const fence = lease.fence;
    const cfg = job.config as Record<string, unknown>;
    const reparseRequested = cfg[REPARSE_FLAG] === true;
    const reparseApplied =
      reparseRequested || cfg[REPARSE_APPLIED_FLAG] === true;
    const policy = reusePolicyFor(ctx.resume);

    // resume_policy: continue reuses every finished
    // checkpoint whatever its hash; restart-stage reuses the ones before the
    // restart stage; a reparse reuses the (re-parsed) model checkpoints so the
    // rebuilt downstream never calls a model for a unit that already has one.
    const reuse = (stage: string, _unit: StageUnit): boolean =>
      policy.reuseDoneRegardlessOfHash(stage) ||
      (reparseApplied && isModelStage(stage));
    const recordStage = metrics?.recordStage;
    const stageRunner = createStageRunner({
      store,
      lease,
      logger,
      now: clock,
      stand: scope().stand,
      reuseDoneRegardlessOfHash: reuse,
      signal: abort.signal,
      // Every stage execution feeds the per-stage metrics.
      ...(recordStage !== undefined
        ? {
            onStage: (observation: StageExecution) =>
              recordStage.call(metrics, {
                stage: stageMetricLabel(observation.stage),
                outcome: observation.outcome,
                durationMs: observation.durationMs,
                tokens: observation.tokens,
              }),
          }
        : {}),
    });
    // Every job books its spend on the row; an uncapped ledger never refuses
    // a reservation, so `token_budget IS NULL` still means "no limit".
    const budget: BudgetLedger = createDbBudgetLedger(store, job.id, fence);
    // The tenant/day axis: independent of the
    // per-job token ledger above, this caps how many VLM pages the owning
    // tenant may spend today across ALL its jobs. A job without a tenant is
    // uncapped — there is no tenant to attribute the spend to.
    const tenantBudget: TenantDailyPageBudget = createTenantDailyPageBudget(
      store,
      {
        tenantId: job.created_by_tenant,
        limit: config.visionBudgetPagesPerDay ?? 0,
        now: clock,
      },
    );

    // The summary generator binds to this run's stage runner and budget ledger,
    // so each summary is a checkpointed, budget-gated stage. The stand key is
    // folded into the model slot of its input hash, so a changed prompt/pipeline
    // stand recomputes summaries exactly like every other model stage.
    const summaryGenerator: SummaryGenerator | null =
      summaryClient !== null
        ? createSummaryGenerator({
            client: summaryClient,
            stageRunner,
            logger,
            jobId: job.id,
            sourceSha256: job.source_sha256,
            model: `${config.summaryModel ?? ""}|stand:${scope().standKey}`,
            budget,
            tokenEstimate: config.summaryTokenEstimate ?? 512,
            ...(config.summaryPricing !== undefined ? { pricing: config.summaryPricing } : {}),
          })
        : null;

    // ── preparing: resolve and prepare the source ─────────────────────────
    if (job.status === "queued") {
      await store.setJobStatus(job.id, "preparing", null, fence);
    }

    // ── identify, source phase: before any work, ask Search which document
    //    this is (its canonical reference — another format of an indexed
    //    document ingests as a new revision of it) and whether the very same
    //    file is already indexed. Recorded on the job, so a resume skips it.
    const ingestOptions = ingestOptionsOf(cfg);
    let identity = identityOf(cfg);
    if (identity === undefined) {
      const step = await identifySourcePhase(job, ingestOptions.dedup);
      if (step.kind === "paused") return step.outcome;
      identity = step.identity;
      if (identity.canonicalReference !== job.reference) {
        logger.info(
          {
            jobId: job.id,
            requested: job.reference,
            canonical: identity.canonicalReference,
          },
          "Ingesting as a new revision of the document indexed under the canonical reference",
        );
        job = (await store.setJobReference(
          job.id,
          identity.canonicalReference,
          fence,
        )) ?? { ...job, reference: identity.canonicalReference };
      }
      await saveIdentity(job.id, identity);
    }
    if (identity.decision === "duplicate")
      return finishDuplicate(job, identity);

    let prepared: PreparedSource;
    try {
      prepared = await renderer.prepare({
        sourceSha256: job.source_sha256,
        filename: filenameOf(job),
        reference: job.reference,
      });
    } catch (err) {
      logger.error({ jobId: job.id, err }, "Job source preparation failed");
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // ── identify, content phase: the text fingerprint and the version, before
    //    any model call, so a duplicate in another format costs no vision.
    if (!identity.complete) {
      let step: IdentifyStep;
      try {
        step = await identifyContentPhase(job, identity, prepared);
      } catch (err) {
        await prepared.close();
        throw err;
      }
      if (step.kind === "paused") {
        await prepared.close();
        return step.outcome;
      }
      identity = step.identity;
      await saveIdentity(job.id, identity);
      if (identity.decision === "duplicate") {
        await prepared.close();
        return finishDuplicate(job, identity);
      }
    }

    // ── native path: BPMN / chart-free XLSX (no model) ────────
    if (prepared.native !== null) {
      try {
        if (reparseRequested) {
          // Native records carry no model response; a reparse has nothing to do.
          await store.patchJobConfig(job.id, { [REPARSE_FLAG]: false }, fence);
        }
        return await runNativeSource({
          job,
          native: prepared.native,
          stageRunner,
          lease,
          cfg,
        });
      } finally {
        await prepared.close();
      }
    }

    // Bind the deterministic S2 analyzer to this run's prepared PDF.
    const preparedAnalyzer: PreparedAnalyzer | null =
      analyzer !== null && prepared.pdfPath !== null
        ? analyzer.forSource({ pdfPath: prepared.pdfPath, home: prepared.home })
        : null;

    try {
      // The `pages` window (contract 2.4) in SOURCE page numbers. `pageCount`
      // below is the LAST page of the window — the bound every page loop and
      // query uses — `firstPage` its start, and `pageTotal` how many pages the
      // job processes (what `job.page_count` and the progress events report).
      const window = pageWindowOf(job, prepared.pageCount);
      if (window.count === 0) {
        logger.warn(
          { jobId: job.id, sourcePages: prepared.pageCount, pages: job.config.pages },
          "Job refused: the pages selection starts after the last page of the source",
        );
        return {
          status: "failed",
          error: `The pages selection starts at page ${window.first}, but the source has only ${prepared.pageCount} page(s)`,
        };
      }
      const firstPage = window.first;
      const pageCount = window.last;
      const pageTotal = window.count;
      // MAX_PAGES: the same ceiling the v1 extractor applies
      // before any model call. Without it a v2 job whose token budget is unset
      // — and a job with no attributable tenant, which the daily budget leaves
      // uncapped — drives vision over every page of an over-long document with
      // no bound. Refuse before `setJobPageCount`/`processing` so the job never
      // spends a token; the worker records the cause as a warning and fails it
      // terminally (a retry would read the same page count).
      if (
        config.maxPages !== undefined &&
        config.maxPages > 0 &&
        pageTotal > config.maxPages
      ) {
        logger.warn(
          { jobId: job.id, pageCount: pageTotal, maxPages: config.maxPages },
          "Job refused: the pages to process exceed MAX_PAGES",
        );
        return {
          status: "failed",
          error: `The job covers ${pageTotal} pages; the configured limit is ${config.maxPages} (MAX_PAGES)`,
        };
      }
      await store.setJobPageCount(job.id, pageTotal, fence);
      // The emitter reads the stream's first page from the config (it starts
      // from a fresh read of the job, without the prepared source).
      if (firstPage !== firstPageOf(cfg)) {
        await store.patchJobConfig(
          job.id,
          { [PAGE_WINDOW_KEY]: { first: firstPage, last: pageCount } },
          fence,
        );
      }
      events.publish({ type: "prepared", jobId: job.id, pageCount: pageTotal });

      // ── processing: drive pages through stages in order ─────────────────
      await store.setJobStatus(job.id, "processing", null, fence);

      // ── reparse: re-apply the parsers to every persisted
      //    raw response, then rebuild the downstream — no model call ───────
      if (reparseRequested) {
        const reparsed = await reparseCheckpoints({
          job,
          firstPage,
          pageCount,
          prepared,
          analyzer: preparedAnalyzer,
          stageRunner,
        });
        await store.invalidateDownstream(
          job.id,
          {
            fromPage: 1,
            stages: [CROPS_STAGE, EMITTED_STAGE, DOCPASS_STAGE],
            deleteAssets: true,
            configPatch: {
              [REPARSE_FLAG]: false,
              [REPARSE_APPLIED_FLAG]: true,
            },
          },
          fence,
        );
        logger.info(
          { jobId: job.id, reparsed },
          "Reparse applied; downstream invalidated for rebuild",
        );
      }

      // ── restart-stage: recompute from the restart stage
      //    on for every page. Applied once per stand; the marker makes a
      //    resume of an interrupted restart continue instead of starting over.
      if (policy.restartFrom !== null) {
        const marker = `${scope().standKey}:${RESTARTABLE_STAGES[policy.restartFrom] ?? "vision1"}`;
        if (cfg[RESTART_APPLIED_MARKER] !== marker) {
          const cropsIdx = stageOrderIndex(CROPS_STAGE);
          await store.invalidateDownstream(
            job.id,
            {
              fromPage: 1,
              stages:
                policy.restartFrom <= cropsIdx
                  ? [CROPS_STAGE, EMITTED_STAGE, DOCPASS_STAGE]
                  : [EMITTED_STAGE, DOCPASS_STAGE],
              deleteAssets: policy.restartFrom <= cropsIdx,
              configPatch: { [RESTART_APPLIED_MARKER]: marker },
            },
            fence,
          );
          logger.info(
            { jobId: job.id, marker },
            "restart-stage applied; downstream invalidated",
          );
        }
      }

      // Render-hash dedup registry for this run.
      const dedup = createDedupRegistry();

      const outcome = await drivePages({
        job,
        firstPage,
        pageCount,
        pageTotal,
        prepared,
        analyzer: preparedAnalyzer,
        stageRunner,
        budget,
        tenantBudget,
        events,
        dedup,
        abort,
      });
      if (outcome.status !== "completed") return outcome;

      // ── embedded objects (a DOCX's Visio, Excel, BPMN …): each a child
      //    document with its native parser, grouped under this document by
      //    Search. Ids are stable, so a resume creates none twice.
      if (
        prepared.embeddedSources !== undefined &&
        prepared.embeddedSources.length > 0
      ) {
        await spawnAttachmentJobs(
          job,
          cfg,
          prepared.embeddedSources,
          undefined,
        );
      }

      // ── version from the transcribed first page: a scan has no text layer,
      //    so the content phase could not read its version; the vision
      //    transcription of page 1 can.
      if (
        identity.version === undefined ||
        identity.version.source === "source_modified"
      ) {
        const firstPage = await firstPageText(job.id);
        if (firstPage !== "") {
          const version = await resolveVersion({
            options: { ...ingestOptions, dedup: ingestOptions.dedup },
            firstPageText: firstPage,
            llm: deps.summaryClient ?? null,
            signal: scope().signal,
            onTokens: (tokens) => consumeTokens(job.id, tokens),
            onLlmError: (err) =>
              logger.warn(
                { jobId: job.id, err },
                "Version detection by the text model failed",
              ),
          });
          if (
            version !== undefined &&
            version.source !== identity.version?.source
          ) {
            identity = { ...identity, version };
            await saveIdentity(job.id, identity);
          }
        }
      }

      // ── document pass (S7): strictly ordered, after the concurrent window ─
      const docPassOutcome = await runDocumentPass({
        job,
        firstPage,
        pageCount,
        analyzer: preparedAnalyzer,
        stageRunner,
        budget,
        summaryGenerator,
        headingLevelHints: prepared.docxHeadingHints?.levelByText ?? null,
      });
      if (docPassOutcome.status !== "completed") return docPassOutcome;

      // ── emitting: stream the staged outbox to Search and reconcile ──────
      const emitOutcome = await runEmit({ job, prepared, lease });
      if (emitOutcome.status !== "completed") return emitOutcome;

      if (reparseApplied) {
        await store.patchJobConfig(
          job.id,
          { [REPARSE_APPLIED_FLAG]: false },
          fence,
        );
      }
      events.publish({ type: "done", jobId: job.id, status: "completed" });
      return { status: "completed" };
    } finally {
      await prepared.close();
    }
  }

  type IdentifyStep =
    | { kind: "ok"; identity: JobIdentity }
    | { kind: "paused"; outcome: JobRunOutcome };

  type IdentifyCall =
    | { kind: "ok"; response: IdentifyResponse | null }
    | { kind: "paused"; outcome: JobRunOutcome };

  /**
   * Call Search's identify route. A transient failure (Search unreachable) is
   * retried in place and then pauses the job on dependency, like the emitter;
   * a permanent one (validation, auth) is logged and the job ingests without
   * identification — dedup is an optimisation, never a reason to fail an
   * ingest. `response: null` means "not identified".
   */
  async function callIdentify(
    request: IdentifyRequest,
    job: JobRow,
  ): Promise<IdentifyCall> {
    if (identifier === null) return { kind: "ok", response: null };
    const stall = { since: null as number | null };
    for (let attempt = 1; ; attempt++) {
      assertLive();
      try {
        const response = await identifier.identify({
          request,
          collection: job.collection ?? undefined,
          signal: scope().signal,
        });
        return { kind: "ok", response };
      } catch (err) {
        assertLive();
        if (err instanceof RevisionTransientError) {
          logger.warn(
            { jobId: job.id, phase: request.phase, err: err.message, attempt },
            "Source identification failed; retrying",
          );
          const retryAt = new Date(
            clock().getTime() + backoffMs(attempt, DEFAULT_BACKOFF),
          );
          const paused = await waitOrPause(
            stall,
            retryAt,
            scope().signal,
            true,
          );
          if (paused !== null) return { kind: "paused", outcome: paused };
          continue;
        }
        logger.warn(
          { jobId: job.id, phase: request.phase, err },
          "Source identification rejected; ingesting without dedup",
        );
        return { kind: "ok", response: null };
      }
    }
  }

  async function identifySourcePhase(
    job: JobRow,
    dedup: ReturnType<typeof ingestOptionsOf>["dedup"],
  ): Promise<IdentifyStep> {
    const base: JobIdentity = {
      requestedReference: job.reference,
      canonicalReference: job.reference,
      decision: "unidentified",
      registered: false,
      complete: false,
    };
    const call = await callIdentify(
      identifyRequestFor(job, {
        phase: "source",
        requestedReference: job.reference,
        dedup,
      }),
      job,
    );
    if (call.kind === "paused") return call;
    if (call.response === null) return { kind: "ok", identity: base };
    return {
      kind: "ok",
      identity: {
        ...base,
        canonicalReference: call.response.canonicalReference,
        decision: call.response.decision,
        registered: true,
        ...(call.response.duplicateOf !== undefined
          ? { duplicateOf: call.response.duplicateOf }
          : {}),
      },
    };
  }

  /**
   * The content phase: read the prepared source's text (no rendering), build
   * the fingerprint, resolve the version, record an e-mail's headers, and ask
   * Search again with all of it.
   */
  async function identifyContentPhase(
    job: JobRow,
    identity: JobIdentity,
    prepared: PreparedSource,
  ): Promise<IdentifyStep> {
    const cfg = job.config as Record<string, unknown>;
    const options = ingestOptionsOf(cfg);
    let pages: string[] | null = null;
    if (prepared.readText !== undefined) {
      try {
        pages = await prepared.readText(FINGERPRINT_MAX_PAGES, scope().signal);
      } catch (err) {
        assertLive();
        logger.warn(
          { jobId: job.id, err },
          "Reading the text layer for the fingerprint failed; continuing without",
        );
      }
    }
    // A fingerprint of only the first pages of a huge document would call two
    // documents with the same beginning identical; skip it instead.
    const fingerprint =
      pages !== null && prepared.pageCount <= FINGERPRINT_MAX_PAGES
        ? textFingerprint(pages)
        : null;
    const email = prepared.native?.email;
    const version = await resolveVersion({
      // An e-mail has no document version; only an explicit one counts.
      options:
        email !== undefined
          ? {
              dedup: options.dedup,
              ...(options.version ? { version: options.version } : {}),
            }
          : options,
      firstPageText: email !== undefined ? undefined : pages?.[0],
      llm: deps.summaryClient ?? null,
      signal: scope().signal,
      onTokens: (tokens) => consumeTokens(job.id, tokens),
      onLlmError: (err) =>
        logger.warn(
          { jobId: job.id, err },
          "Version detection by the text model failed",
        ),
    });
    if (email !== undefined) {
      const title = prepared.native?.title;
      await store.patchJobConfig(
        job.id,
        {
          [EMAIL_KEY]: email,
          ...(typeof cfg.title !== "string" && title !== undefined
            ? { title }
            : {}),
        },
        scope().fence,
      );
    }

    let next: JobIdentity = {
      ...identity,
      ...(version !== undefined ? { version } : {}),
      complete: true,
    };
    if (identity.registered) {
      const call = await callIdentify(
        identifyRequestFor(job, {
          phase: "content",
          requestedReference: identity.requestedReference,
          dedup: options.dedup,
          textHash: fingerprint?.textHash,
          minhash: fingerprint?.minhash,
          messageId: email?.messageId,
          version,
        }),
        job,
      );
      if (call.kind === "paused") return call;
      if (call.response !== null) {
        next = {
          ...next,
          decision: call.response.decision,
          ...(call.response.duplicateOf !== undefined
            ? { duplicateOf: call.response.duplicateOf }
            : {}),
        };
      }
    }
    logger.info(
      {
        jobId: job.id,
        decision: next.decision,
        version: next.version,
        fingerprint: fingerprint !== null,
        duplicateOf: next.duplicateOf?.reference,
      },
      "Source identified",
    );
    return { kind: "ok", identity: next };
  }

  async function saveIdentity(
    jobId: string,
    identity: JobIdentity,
  ): Promise<void> {
    await store.patchJobConfig(
      jobId,
      { [IDENTITY_KEY]: identity },
      scope().fence,
    );
  }

  /** Book the tokens of a model call made outside a stage (version detection). */
  async function consumeTokens(jobId: string, tokens: number): Promise<void> {
    if (tokens > 0) await store.consumeJobTokens(jobId, tokens, scope().fence);
  }

  /** The text of page 1 as staged for emitting (the vision transcription). */
  async function firstPageText(jobId: string): Promise<string> {
    const row = await store.getEmitBatch(jobId, 1);
    const record = (row?.payload as { record?: PageRecord } | null | undefined)
      ?.record;
    if (record === undefined || !Array.isArray(record.blocks)) return "";
    return record.blocks
      .map((b) =>
        "text" in b ? b.text : b.type === "list" ? b.items.join("\n") : "",
      )
      .filter((t) => t !== "")
      .join("\n");
  }

  /**
   * End a job whose source is already indexed: nothing is extracted or sent.
   * The source stays registered in Search as an additional source of the
   * document it duplicates.
   */
  async function finishDuplicate(
    job: JobRow,
    identity: JobIdentity,
  ): Promise<JobRunOutcome> {
    const dup = identity.duplicateOf;
    const warning =
      `Skipped: duplicate of ${dup?.reference ?? "an indexed source"}` +
      `${dup?.filename !== undefined ? ` (${dup.filename})` : ""}, matched by ${dup?.match ?? "sha256"}`;
    if (!job.warnings.includes(warning))
      await store.appendJobWarning(job.id, warning, scope().fence);
    logger.info(
      { jobId: job.id, reference: job.reference, duplicateOf: dup },
      "Job skipped as a duplicate",
    );
    events.publish({ type: "done", jobId: job.id, status: "completed" });
    return { status: "completed" };
  }

  /**
   * Wait for `retryAt` when it falls within the run's transient-wait budget
   * (retry with backoff first, pause only after JOB_MAX_TRANSIENT_WAIT), else
   * return the `paused(dependency)` outcome with the auto-resume instant.
   */
  async function waitOrPause(
    stall: { since: number | null },
    retryAt: Date,
    signal: AbortSignal,
    withRetryAt: boolean,
  ): Promise<JobRunOutcome | null> {
    const nowMs = clock().getTime();
    if (stall.since === null) stall.since = nowMs;
    if (retryAt.getTime() - stall.since <= maxTransientWaitMs) {
      await sleep(Math.max(0, retryAt.getTime() - nowMs), signal);
      assertLive();
      return null;
    }
    return withRetryAt
      ? { status: "paused", reason: "dependency", retryAt }
      : { status: "paused", reason: "dependency" };
  }

  /**
   * Drive the emitting phase. Transitions the job to `emitting`, then (when an
   * emitter is configured) streams the staged outbox to Search. The AssetLoader
   * re-renders each crop deterministically from the prepared source — the crop
   * bytes were never persisted, only their checksum was, so re-rendering from
   * the one durable source keeps storage flat and the resume byte-identical.
   */
  async function runEmit(args: {
    job: JobRow;
    prepared: PreparedSource;
    lease: JobRunContext["lease"];
  }): Promise<JobRunOutcome> {
    const { job, prepared, lease } = args;
    await store.setJobStatus(job.id, "emitting", null, lease.fence);
    if (emitter === null) return { status: "completed" };
    const loader = createCropLoader({ job, prepared });
    return emitWithRecovery(job.id, lease, loader);
  }

  /**
   * Run the emitter until it commits, recovering in place where that is safe:
   *
   *   - `transient` / `incomplete` (Search unreachable, commit still missing
   *     parts): retry with backoff inside JOB_MAX_TRANSIENT_WAIT, then pause on
   *     dependency — the outbox is intact, the auto-resume reconciles.
   *   - `conflict` (a batch digest clashes with the revision, e.g. its content
   *     was rebuilt): start ONE new emit generation — a fresh revision under a
   *     new Idempotency-Key — and emit again; a second conflict fails the job
   *     with a clear message instead of pausing forever.
   */
  async function emitWithRecovery(
    jobId: string,
    lease: JobRunContext["lease"],
    loader: AssetLoader,
  ): Promise<JobRunOutcome> {
    if (emitter === null) return { status: "completed" };
    const signal = scope().signal;
    let regenerated = false;
    let attempt = 0;
    const stall = { since: null as number | null };
    for (;;) {
      assertLive();
      const fresh = await store.getJob(jobId);
      if (fresh === null)
        return { status: "failed", error: `job ${jobId} vanished` };
      const outcome: EmitOutcome = await emitter.emit(fresh, lease, loader);
      if (outcome.status === "committed") return { status: "completed" };
      if (outcome.status === "conflict") {
        if (!regenerated) {
          regenerated = true;
          logger.warn(
            { jobId, reason: outcome.reason },
            "Emit conflict; starting a new emit generation",
          );
          await store.resetEmitGeneration(jobId, lease.fence);
          continue;
        }
        return {
          status: "failed",
          error: `Search rejected the revision content with 409 even after a new emit generation: ${outcome.reason}`,
        };
      }
      attempt += 1;
      logger.warn(
        { jobId, status: outcome.status, reason: outcome.reason, attempt },
        "Emit not committed",
      );
      const retryAt = new Date(
        clock().getTime() + backoffMs(attempt, DEFAULT_BACKOFF),
      );
      const paused = await waitOrPause(stall, retryAt, signal, false);
      if (paused !== null) return paused;
    }
  }

  /**
   * Drive a natively-parsed source (BPMN, chart-free XLSX): no vision, no
   * rendering, no document pass. The contract records were already
   * built during `prepare`. This stages one emit-outbox row per record and one
   * asset-outbox row per referenced asset (in page order, all fenced), then runs
   * the emitting phase directly. `native:` asset bytes (the original `.bpmn`
   * XML) are held in memory for this run and served verbatim by the loader.
   */
  async function runNativeSource(args: {
    job: JobRow;
    native: NonNullable<PreparedSource["native"]>;
    stageRunner: StageRunner;
    lease: JobRunContext["lease"];
    cfg: Record<string, unknown>;
  }): Promise<JobRunOutcome> {
    const { job, native, stageRunner, lease, cfg } = args;
    const { fence } = scope();
    const pageCount = native.records.length;
    // A native source (BPMN, a chart-free XLSX) is staged whole: a record is a
    // sheet or a diagram, not a page of a page range. `pages` does not apply.
    if (hasPageSelection(job)) {
      logger.info(
        { jobId: job.id, pages: job.config.pages },
        "The pages selection is ignored for a native source; every record is staged",
      );
    }
    // MAX_PAGES: the same ceiling as the vision path, so a
    // native source (a many-sheet XLSX, a large BPMN set) cannot stage an
    // unbounded emit outbox either. A native record is one page here.
    if (
      config.maxPages !== undefined &&
      config.maxPages > 0 &&
      pageCount > config.maxPages
    ) {
      logger.warn(
        { jobId: job.id, pageCount, maxPages: config.maxPages },
        "Job refused: the pages to process exceed MAX_PAGES",
      );
      return {
        status: "failed",
        error: `The job covers ${pageCount} pages; the configured limit is ${config.maxPages} (MAX_PAGES)`,
      };
    }
    await store.setJobPageCount(job.id, pageCount, fence);
    events.publish({ type: "prepared", jobId: job.id, pageCount });
    await store.setJobStatus(job.id, "processing", null, fence);

    const nativeBytes = new Map(native.nativeAssets.map((a) => [a.assetId, a]));

    const records = await withUnknownQuotedHistory(job, native);
    for (const record of records) {
      assertLive();
      const page = record.page;
      const emitted = await store.getStage("page", {
        job_id: job.id,
        page,
        stage: EMITTED_STAGE,
      });
      const emittedHash = stageHash(["native-emit", job.source_sha256, page]);
      if (emitted?.status === "done") continue; // staged on a previous run
      // Stage every asset the record references (page image, figure, native).
      for (const asset of record.assets) {
        await store.stageAsset(
          {
            job_id: job.id,
            asset_id: asset.assetId,
            page,
            ...(asset.checksum !== undefined
              ? { checksum: asset.checksum }
              : {}),
            variant:
              asset.kind === "native"
                ? "native"
                : asset.kind === "page"
                  ? "page"
                  : null,
            mime_type: asset.mimeType ?? "image/png",
          },
          fence,
        );
        events.publish({
          type: "asset",
          jobId: job.id,
          page,
          assetId: asset.assetId,
          kind: asset.kind === "figure" ? "figure" : "page",
        });
      }
      await stageEmitRow(job, page, record);
      // Advance the emitted cursor so a resume does not re-stage the page.
      await stageRunner.runStage<{ page: number }, null>({
        unit: "page",
        key: { job_id: job.id, page, stage: EMITTED_STAGE },
        inputHash: emittedHash,
        fn: async () => ({ raw: null, parsed: { page } }),
      });
      events.publish({
        type: "page",
        jobId: job.id,
        page,
        pageCount,
        record,
        assetIds: record.assets.map((a) => a.assetId),
        usage: {
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        },
      });
    }

    // An e-mail's attachments become jobs of their own (before the e-mail is
    // emitted, so a crash in between re-creates none twice: ids are stable).
    if (native.attachments !== undefined && native.attachments.length > 0) {
      await spawnAttachmentJobs(
        job,
        cfg,
        native.attachments,
        native.email?.date,
        native.childConfig,
      );
    }

    await store.setJobStatus(job.id, "emitting", null, fence);
    if (emitter !== null) {
      const outcome = await emitWithRecovery(
        job.id,
        lease,
        createNativeAssetLoader(nativeBytes),
      );
      if (outcome.status !== "completed") return outcome;
    }
    events.publish({ type: "done", jobId: job.id, status: "completed" });
    return { status: "completed" };
  }

  /**
   * An e-mail's records with its quoted history kept when the corpus does not
   * hold the message it replies to. The history was removed so a thread
   * indexes every message's words once; that is only right when the quoted
   * message is indexed itself. A lone exported reply, or a reply whose parent
   * was never ingested, keeps the history as a "Zitierter Verlauf" section.
   * A page already emitted on an earlier run is skipped by the caller, so a
   * parent arriving between two runs cannot change emitted content.
   */
  async function withUnknownQuotedHistory(
    job: JobRow,
    native: NonNullable<PreparedSource["native"]>,
  ): Promise<PageRecord[]> {
    const quoted = native.quotedHistory;
    if (
      native.email === undefined ||
      quoted === undefined ||
      quoted.trim() === ""
    )
      return native.records;
    const parent = quotedParentOf(native.email);
    // A message of an mbox export: its siblings are ingested with it, so a
    // parent in the same export counts as known whichever child runs first.
    const siblings = (job.config as { mboxMessageIds?: unknown })
      .mboxMessageIds;
    if (
      parent !== undefined &&
      Array.isArray(siblings) &&
      siblings.includes(parent)
    )
      return native.records;
    const known =
      parent !== undefined
        ? await store.knownEmailMessageIds(job.collection, [parent])
        : new Set<string>();
    if (parent !== undefined && known.has(parent)) return native.records;
    logger.info(
      { jobId: job.id, parent: parent ?? null },
      "Quoted history kept: the message it quotes is not in the corpus",
    );
    return native.records.map((r, i) =>
      i === 0 ? withQuotedHistory(r, quoted) : r,
    );
  }

  /**
   * Store each attachment in the source store and create a queued job for it,
   * under `<e-mail reference>/<file name>`, with the e-mail as its parent (so
   * Search groups it into the e-mail's thread) and the e-mail's date as its
   * version fallback. The job id is derived from the parent job and the
   * attachment's position, so a resumed parent never creates a second child.
   * An attachment in a format Extract cannot read is listed in the e-mail's
   * text only.
   */
  async function spawnAttachmentJobs(
    job: JobRow,
    cfg: Record<string, unknown>,
    attachments: ReadonlyArray<{
      filename: string;
      mimeType: string;
      content: Uint8Array;
    }>,
    emailDate: string | undefined,
    childConfig: Record<string, unknown> = {},
  ): Promise<void> {
    if (sourceStore === null) {
      logger.info(
        { jobId: job.id, count: attachments.length },
        "No source store; e-mail attachments are not ingested",
      );
      return;
    }
    const taken = new Set<string>();
    for (const [index, attachment] of attachments.entries()) {
      assertLive();
      const reference = attachmentReference(
        job.reference,
        attachment.filename,
        taken,
      );
      const childId = childJobId(job.id, index);
      if ((await store.getJob(childId)) !== null) continue;
      const resolved = resolveFormat({
        buffer: attachment.content,
        filename: attachment.filename,
        declaredMimeType: attachment.mimeType,
      });
      if (!resolved.ok) {
        const warning = `Attachment "${attachment.filename}" not ingested: ${resolved.reason}`;
        if (!job.warnings.includes(warning))
          await store.appendJobWarning(job.id, warning, scope().fence);
        continue;
      }
      const stored = await sourceStore.putStream(
        Readable.from(Buffer.from(attachment.content)),
        {
          maxBytes: attachment.content.length,
        },
      );
      // An attachment carries its e-mail's tags, metadata and source label, so
      // a tag filter finds the attachment where it finds the e-mail.
      const inherited = [
        "collection",
        "snapshot",
        "acl",
        "dedup",
        "pages",
        ...INHERITED_ATTRIBUTE_KEYS,
      ] as const;
      await store.createJob({
        id: childId,
        reference,
        source_sha256: stored.sha256,
        status: "queued",
        collection: job.collection,
        config: {
          ...Object.fromEntries(
            inherited
              .filter((k) => cfg[k] !== undefined)
              .map((k) => [k, cfg[k]]),
          ),
          source: {
            filename: attachment.filename,
            mimeType: resolved.format.mimeType,
            bytes: stored.size,
          },
          parent: { reference: job.reference, jobId: job.id },
          ...(emailDate !== undefined ? { sourceModifiedAt: emailDate } : {}),
          ...childConfig,
        },
        pipeline_hash: job.pipeline_hash,
        prompt_hash: job.prompt_hash,
        visibility: job.visibility,
        priority: job.priority,
        ...(job.token_budget !== null
          ? { token_budget: job.token_budget }
          : {}),
        ...(job.callback_url !== null
          ? { callback_url: job.callback_url }
          : {}),
      });
      logger.info(
        { jobId: job.id, childJobId: childId, reference },
        "Attachment / embedded file queued as its own job",
      );
    }
  }

  /**
   * An {@link AssetLoader} for a native source. A `native:` asset resolves to
   * its held bytes (the original `.bpmn` XML); any other asset (a native page
   * placeholder) has no bytes and is skipped, exactly as the emitter tolerates a
   * missing crop.
   */
  function createNativeAssetLoader(
    bytes: Map<
      string,
      {
        assetId: string;
        localId?: string;
        buffer: Uint8Array;
        mimeType: string;
      }
    >,
  ): AssetLoader {
    return {
      async load(row: AssetOutboxRow): Promise<AssetBody | null> {
        const entry = bytes.get(row.asset_id);
        if (entry === undefined) return null;
        return {
          assetId: entry.assetId,
          buffer: entry.buffer,
          mimeType: entry.mimeType,
          checksum: sha256Hex(entry.buffer),
          kind: "native",
          ...(entry.localId !== undefined ? { localId: entry.localId } : {}),
        };
      },
    };
  }

  /**
   * An {@link AssetLoader} that resolves an asset-outbox row to its bytes by
   * re-rendering the crop from the prepared source. The page comes from the
   * outbox row's `page` column and the bbox from THAT page's staged record — a
   * single-row lookup, cached for a handful of pages — so the loader never
   * loads every page payload. Only a legacy row without a
   * page falls back to a one-time index over the staged records.
   */
  function createCropLoader(deps: {
    job: JobRow;
    prepared: PreparedSource;
  }): AssetLoader {
    const { job, prepared } = deps;
    interface CropEntry {
      page: number;
      bbox: BBox | undefined;
      kind: string;
      localId: string;
    }
    const PAGE_CACHE = 16;
    const byPage = new Map<number, Map<string, CropEntry>>();
    let legacyIndex: Map<string, CropEntry> | null = null;

    function entriesOf(record: PageRecord): Map<string, CropEntry> {
      const map = new Map<string, CropEntry>();
      for (const asset of record.assets) {
        map.set(asset.assetId, {
          page: asset.page ?? record.page,
          bbox: asset.bbox,
          kind: asset.kind,
          localId: asset.localId,
        });
      }
      return map;
    }

    async function pageEntries(page: number): Promise<Map<string, CropEntry>> {
      const cached = byPage.get(page);
      if (cached !== undefined) return cached;
      const row = await store.getEmitBatch(job.id, page);
      const record = (row?.payload as { record?: PageRecord } | null)?.record;
      const entries =
        record !== undefined ? entriesOf(record) : new Map<string, CropEntry>();
      byPage.set(page, entries);
      if (byPage.size > PAGE_CACHE) {
        const oldest = byPage.keys().next().value;
        if (oldest !== undefined) byPage.delete(oldest);
      }
      return entries;
    }

    async function legacyEntry(
      assetId: string,
    ): Promise<CropEntry | undefined> {
      if (legacyIndex === null) {
        const built = new Map<string, CropEntry>();
        const meta = await store.listEmitBatchMeta(job.id);
        const window = 50;
        const last = meta.reduce((m, r) => Math.max(m, r.page_to), 0);
        for (let from = 1; from <= last; from += window) {
          for (const row of await store.emitBatchesInRange(
            job.id,
            from,
            from + window - 1,
          )) {
            const record = (row.payload as { record?: PageRecord } | null)
              ?.record;
            if (record === undefined) continue;
            for (const [id, entry] of entriesOf(record)) built.set(id, entry);
          }
        }
        legacyIndex = built;
      }
      return legacyIndex.get(assetId);
    }

    return {
      async load(row: AssetOutboxRow): Promise<AssetBody | null> {
        const entry =
          row.page !== undefined && row.page !== null
            ? (await pageEntries(Number(row.page))).get(row.asset_id)
            : await legacyEntry(row.asset_id);
        if (entry === undefined) return null;
        try {
          // A figure crop OR a tile: both are a bbox region re-rendered from the
          // source (tile bytes are not stored, they reproduce on demand exactly
          // like a figure crop).
          if (
            (entry.kind === "figure" || entry.kind === "tile") &&
            entry.bbox !== undefined &&
            isValidBoundingBox(entry.bbox)
          ) {
            const pageImage = await prepared.render(entry.page);
            const crop = await prepared.renderFigureCrop(
              entry.page,
              entry.bbox as unknown as BoundingBox,
              pageImage.image,
            );
            return {
              assetId: row.asset_id,
              buffer: crop.buffer,
              mimeType: crop.mimeType,
              checksum: sha256Hex(crop.buffer),
              kind: entry.kind,
              localId: entry.localId,
              page: entry.page,
              bbox: entry.bbox,
            };
          }
          // A page image (or a figure without a usable bbox): the full page.
          const rendered = await prepared.render(entry.page);
          return {
            assetId: row.asset_id,
            buffer: rendered.image.buffer,
            mimeType: rendered.image.mimeType,
            checksum: sha256Hex(rendered.image.buffer),
            kind: "page",
            localId: entry.localId,
            page: entry.page,
          };
        } catch (err) {
          logger.warn(
            { jobId: job.id, assetId: row.asset_id, err },
            "Crop re-render failed",
          );
          return null;
        }
      },
    };
  }

  /**
   * The reparse pass: walk the document in page windows and
   * re-apply the current parsers to every persisted raw response — Pass 1
   * (`vision1`, re-snapping figure bboxes deterministically from a re-render),
   * Pass 2 (`figure2`) and tiles (`tiled`) — WITHOUT any model call. Units that
   * failed permanently but kept their raw response (a parse/post-processing
   * failure) are repaired too. Returns how many checkpoints were rewritten.
   */
  async function reparseCheckpoints(args: {
    job: JobRow;
    /** First page of the job's `pages` window (1 without one). */
    firstPage: number;
    pageCount: number;
    prepared: PreparedSource;
    analyzer: PreparedAnalyzer | null;
    stageRunner: StageRunner;
  }): Promise<number> {
    const { job, firstPage, pageCount, prepared, stageRunner } = args;
    const WINDOW = 100;
    const threshold = config.labelCoverageMin / 100;
    let count = 0;
    for (let from = firstPage; from <= pageCount; from += WINDOW) {
      assertLive();
      const to = Math.min(pageCount, from + WINDOW - 1);
      const figuresByPage = new Map<number, VisionStageParsed["figures"]>();

      for (const row of await store.listStagesWindow(
        "page",
        job.id,
        VISION1_STAGE,
        from,
        to,
      )) {
        let parsed =
          row.status === "done"
            ? parsedOfRow<VisionStageParsed>(row)
            : undefined;
        if (reparseable(row)) {
          const result = await stageRunner.reparseRow<
            VisionStageParsed,
            string
          >("page", row, (raw, existing) =>
            rebuildVisionFromRaw(existing, raw, prepared, args.analyzer),
          );
          if (result !== null) {
            parsed = result.parsed;
            count += 1;
          }
        }
        if (parsed !== undefined) figuresByPage.set(row.page, parsed.figures);
      }

      for (const row of await store.listStagesWindow(
        "figure",
        job.id,
        FIGURE2_STAGE,
        from,
        to,
      )) {
        if (!reparseable(row)) continue;
        const figure = figuresByPage
          .get(row.page)
          ?.find((f) => f.id === row.figure_id);
        if (figure === undefined) continue; // the figure no longer exists after Pass-1 reparse
        const kind = figure.kind ?? "other";
        const labels = figure.labels ?? [];
        const result = await stageRunner.reparseRow(
          "figure",
          row,
          (raw: string) => {
            const reparsed = parseTranscription(kind, raw);
            if (reparsed === null) return undefined;
            const coverage = labelCoverage(labels, reparsed.transcription);
            const warnings = [...reparsed.warnings];
            if (labels.length > 0 && coverage < threshold) {
              warnings.push(
                `Pass 2 für Abbildung ${figure.id}: Label-Coverage ${(coverage * 100).toFixed(0)} % unter ${config.labelCoverageMin} % (reparse).`,
              );
            }
            return {
              transcription: reparsed.transcription,
              coverage,
              warnings,
            };
          },
        );
        if (result !== null) count += 1;
      }

      for (const row of await store.listStagesWindow(
        "tile",
        job.id,
        TILED_STAGE,
        from,
        to,
      )) {
        if (!reparseable(row)) continue;
        const result = await stageRunner.reparseRow(
          "tile",
          row,
          (raw: string) => {
            const reparsed = parseTranscription("technical_drawing", raw);
            if (reparsed === null) return undefined;
            return {
              transcription: reparsed.transcription,
              warnings: reparsed.warnings,
            };
          },
        );
        if (result !== null) count += 1;
      }
    }
    return count;
  }

  /**
   * Rebuild a page's Pass-1 stage result from its persisted raw response: the
   * tolerant parser, then the deterministic S4 refinement (re-rendering the page
   * only when a figure has a croppable bbox). Fields that do not come from the
   * response (render geometry, page class, render hash, usage) are kept from
   * the previous result, or re-derived deterministically for a unit that failed
   * before it ever had one. Returns undefined when the page cannot be rendered.
   */
  async function rebuildVisionFromRaw(
    existing: PageStageRow,
    raw: string,
    prepared: PreparedSource,
    preparedAnalyzer: PreparedAnalyzer | null,
  ): Promise<VisionStageParsed | undefined> {
    const page = existing.page;
    const prev =
      existing.status === "done"
        ? parsedOfRow<VisionStageParsed>(existing)
        : undefined;
    if (prev?.fastPath === true) return undefined;
    const stored = isStageOutput(existing.output)
      ? (existing.output as StageOutput)
      : undefined;
    const response = stored?.response;
    const parsedPage = parseVisionPage(raw, page);
    const croppable = parsedPage.figures.some((f) => isCroppable(f.bbox));

    let rendered: Awaited<ReturnType<PreparedSource["render"]>> | null = null;
    if (prev === undefined || croppable) {
      try {
        rendered = await prepared.render(page);
      } catch (err) {
        logger.warn(
          { jobId: existing.job_id, page, err },
          "Reparse: page could not be re-rendered",
        );
        return undefined;
      }
    }
    const analysis =
      croppable || prev === undefined
        ? await runPageAnalysis(preparedAnalyzer, page)
        : null;
    const image: PageImage = rendered?.image ?? {
      buffer: new Uint8Array(0),
      mimeType: "image/png",
      width: 1,
      height: 1,
    };
    const figures = await refineFigures(parsedPage.figures, image, analysis);
    // Geometry and class are kept from the previous result (a reparse must not
    // change the tile grid, which would require new model calls); a unit that
    // never had a result derives them deterministically from the re-render.
    const sizePt =
      prev?.size !== undefined
        ? { widthPt: prev.size.wPt, heightPt: prev.size.hPt }
        : resolvePageSizePt(rendered ?? { image }, analysis, config.renderDpi);
    const pageClass: PageClass =
      prev?.pageClass ??
      (rendered !== null
        ? (
            await classifyRenderedPage({
              imageBuffer: rendered.image.buffer,
              rawText: rendered.rawText,
              usedOcr: rendered.usedOcr,
              sizePt,
              analysis,
            })
          ).class
        : "text");
    const truncated = prev?.truncated ?? response?.truncated ?? false;
    const hash =
      prev?.renderHash !== undefined
        ? prev.renderHash
        : rendered !== null
          ? await renderHash(rendered.image.buffer)
          : null;
    return {
      summary: parsedPage.summary,
      markdown: parsedPage.markdown,
      figures,
      tables: parsedPage.tables.map((t) => ({
        index: t.index,
        continues: t.continues,
        continuationOf: t.continuationOf,
      })),
      warnings: [
        ...parsedPage.warnings,
        ...(truncated ? [TRUNCATION_WARNING] : []),
      ],
      usedOcr: prev?.usedOcr ?? rendered?.usedOcr ?? false,
      usage: prev?.usage ?? {
        requests: response?.requests ?? 0,
        promptTokens: response?.promptTokens ?? 0,
        completionTokens: response?.completionTokens ?? 0,
        totalTokens: response?.totalTokens ?? 0,
      },
      truncated,
      size: { wPt: sizePt.widthPt, hPt: sizePt.heightPt },
      imageWidth: prev?.imageWidth ?? image.width,
      imageHeight: prev?.imageHeight ?? image.height,
      pageClass,
      renderHash: hash,
      // Not derived from the response: carried over unchanged.
      ...(prev?.prevPageContext !== undefined
        ? { prevPageContext: prev.prevPageContext }
        : {}),
      ...(prev?.prevPageContextHash !== undefined
        ? { prevPageContextHash: prev.prevPageContextHash }
        : {}),
      ...(prev?.dedupOf !== undefined ? { dedupOf: prev.dedupOf } : {}),
    };
  }

  /**
   * The strictly-ordered streaming document pass.
   *
   * ## Why a separate ordered phase
   *
   * The per-page vision/crops/figure2 stages ran concurrently, which is correct
   * because they are order-independent. S7 is not: page N's `sectionPath` is the
   * heading stack from pages 1..N-1, a table on page N merges only if page N-1
   * left one open, furniture is a rolling window, and the identifier index and
   * refs accumulate across the whole document. So this phase runs once, after
   * the concurrent window has driven every page to the `emitted` cursor (its
   * BASE record staged), and folds the pages in strict ascending order.
   *
   * ## Resume is exact and idempotent
   *
   * For each page the three writes — the enriched emit payload, the running
   * state after the page, and the page's `docpass` checkpoint — commit in ONE
   * transaction. A crash therefore leaves either all three or none: on resume
   * the pass continues from `lastPage + 1`, whose emit payload is guaranteed to
   * still be the BASE record, so `applyPage` never runs twice over an already
   * enriched record. A summary pause returns before the page commits, for the
   * same reason (the summaries produced so far are checkpointed stages and are
   * reused without a model call). Each page reads exactly its own outbox row —
   * no per-page scan over the whole outbox (the old O(N²) pattern).
   */
  async function runDocumentPass(args: {
    job: JobRow;
    /** First page of the job's `pages` window (1 without one). */
    firstPage: number;
    pageCount: number;
    analyzer: PreparedAnalyzer | null;
    stageRunner: StageRunner;
    budget: BudgetLedger;
    summaryGenerator: SummaryGenerator | null;
    /** DOCX authoritative heading levels, or null. */
    headingLevelHints: ReadonlyMap<string, number> | null;
  }): Promise<JobRunOutcome> {
    const {
      job,
      firstPage,
      pageCount,
      analyzer: preparedAnalyzer,
      stageRunner,
      summaryGenerator,
    } = args;
    const { fence, stand } = scope();

    // Rehydrate the running state from the last finished page.
    const persisted = await store.latestDocpassState(job.id);
    const initial: DocpassState = parseDocpassState(persisted?.state ?? null);
    const pass = createDocumentPass(
      initial,
      args.headingLevelHints !== null
        ? { headingLevelHints: args.headingLevelHints }
        : {},
    );
    // A `pages` window starts at `firstPage`; a resume continues after the last
    // page the pass finished (never before the window).
    const resumeFrom = Math.max(firstPage - 1, initial.lastPage) + 1;

    // Whether the summary pass still needs to run its document-end finalize. If
    // the whole per-page loop was already done on a prior run (resumeFrom >
    // pageCount) we still finalize, because a resume may have stopped between
    // the last page and the chapter/document summaries.
    if (resumeFrom > pageCount) {
      return finalizeSummaries(pass, pageCount);
    }

    for (let page = resumeFrom; page <= pageCount; page++) {
      assertLive();
      const pageStarted = Date.now();
      // The BASE record was staged by the emitted stage. A missing record means
      // the page failed permanently upstream; skip it but keep the state moving.
      const baseRow = await store.getStage("page", {
        job_id: job.id,
        page,
        stage: EMITTED_STAGE,
      });
      const emitRow = await store.getEmitBatch(job.id, page);
      const payload = emitRow?.payload as
        | { record?: PageRecord }
        | null
        | undefined;
      const record = payload?.record;
      if (
        baseRow === null ||
        baseRow.status !== "done" ||
        record === undefined
      ) {
        logger.debug(
          { jobId: job.id, page },
          "Document pass: no base record for page; skipping",
        );
        // Advance the checkpoint so a resume does not re-examine this page.
        await stageRunner.runStage<{ page: number }, null>({
          unit: "page",
          key: { job_id: job.id, page, stage: DOCPASS_STAGE },
          inputHash: stageHash(["docpass", job.source_sha256, page, "skip"]),
          fn: async () => ({ raw: null, parsed: { page } }),
        });
        continue;
      }

      // This page's deterministic S2 geometry (heading heights, furniture
      // bands). Best-effort and never throws; null when unavailable.
      const analysis = await runPageAnalysis(preparedAnalyzer, page);
      // Page N+1's BASE record (staged, untouched until N+1 commits), read
      // only to see whether this page's last paragraph runs over the break.
      const nextRecord =
        page < pageCount
          ? ((
              (await store.getEmitBatch(job.id, page + 1))?.payload as
                | { record?: PageRecord }
                | null
                | undefined
            )?.record ?? null)
          : null;
      const applied = pass.applyPage(record, analysis, nextRecord);

      // ── Summary hierarchy ─────────────────
      // A section that closed on this page gets its summary now. A text-LLM
      // outage pauses the job on dependency, a budget exhaustion on budget.
      // Nothing of this page is committed before the summaries succeed, so the
      // resume re-applies the page to its untouched base record.
      if (summaryGenerator !== null && applied.closedSections.length > 0) {
        try {
          await summaryGenerator.onSectionsClosed(applied.closedSections, pass);
        } catch (err) {
          const outcome = summaryPauseOutcome(err, job.id, page);
          if (outcome !== null) return outcome;
          throw err;
        }
      }

      // Enriched payload + state after this page + docpass checkpoint: one
      // transaction, so the resume point and the enriched
      // record can never disagree.
      await store.commitDocpassPage(
        job.id,
        {
          page,
          payload: {
            ...(payload ?? {}),
            type: "page",
            page,
            record: applied.record,
          },
          state: pass.snapshot(),
          checkpoint: {
            job_id: job.id,
            page,
            stage: DOCPASS_STAGE,
            input_hash: stageHash(["docpass", job.source_sha256, page]),
            status: "done",
            output: { raw: null, parsed: { page }, stand },
            next_attempt_at: null,
            error: null,
          },
        },
        fence,
      );
      // The docpass checkpoint is written in the page's own transaction above,
      // not through the stage runner, so its metric is recorded here.
      metrics?.recordStage?.({
        stage: DOCPASS_STAGE,
        outcome: "done",
        durationMs: Date.now() - pageStarted,
      });
      // No `page` event is published here: the concurrent phase already emitted
      // one per page for the SSE/callback stream.
    }

    logger.info({ jobId: job.id, pages: pageCount }, "Document pass complete");

    // ── document-end summaries (chapter + document, and any still-open
    //    section) — a checkpointed stage each, after the last page.
    return finalizeSummaries(pass, pageCount);

    /**
     * Produce the document-end summaries (still-open sections, chapters, the
     * document) via the generator, persisting the final state. Returns a pause
     * outcome when the text-LLM is unreachable or the budget ran out, else
     * `completed`. A no-generator deployment is an immediate `completed`.
     */
    async function finalizeSummaries(
      finalPass: import("./docpass/document-pass.js").DocumentPass,
      last: number,
    ): Promise<JobRunOutcome> {
      if (summaryGenerator === null) return { status: "completed" };
      const outline = finalPass.outline(last);
      try {
        await summaryGenerator.finalize(finalPass, outline, last);
      } catch (err) {
        const paused = summaryPauseOutcome(err, job.id, last);
        if (paused !== null) {
          // Keep the summaries produced so far on the final state; the page
          // loop is complete, so this only adds summary nodes.
          await store.saveDocpassState(
            job.id,
            last,
            finalPass.snapshot(),
            fence,
          );
          return paused;
        }
        throw err;
      }
      // Persist the produced chapter/document summaries so the emitter reads
      // them from the latest docpass_state.
      await store.saveDocpassState(job.id, last, finalPass.snapshot(), fence);
      return { status: "completed" };
    }
  }

  /**
   * Map a summary-stage failure to a job pause outcome, or `null` when it is not
   * a pause-worthy failure (the caller rethrows). A budget exhaustion pauses on
   * `budget`; a transient text-LLM outage pauses on `dependency` with the
   * checkpoint's retry instant, so the auto-resume picks it up once it is due.
   */
  function summaryPauseOutcome(
    err: unknown,
    jobId: string,
    page: number,
  ): JobRunOutcome | null {
    if (err instanceof BudgetExhaustedError) {
      logger.info({ jobId, page }, "Summary paused: token budget exhausted");
      return { status: "paused", reason: "budget" };
    }
    if (err instanceof StageNotDueError) {
      return { status: "paused", reason: "dependency", retryAt: err.retryAt };
    }
    if (err instanceof TransientStageError) {
      logger.warn(
        { jobId, page, err: err.message },
        "Summary paused: text-LLM unreachable",
      );
      return { status: "paused", reason: "dependency" };
    }
    return null;
  }

  /**
   * The ordered scheduler loop with CONTINUOUS REFILL (Phase 11). Keeps up to
   * `pageConcurrency` pages in flight at all times: as soon as a slot frees,
   * the next due pages are claimed, so one slow page never idles the other
   * slots — the previous window scheduler waited for the slowest page of each
   * full window before claiming the next one. Never materialises the full page
   * list.
   *
   * Page events are still published in STRICT page order: a settled page is
   * buffered until every smaller page has settled and been published, so
   * subscribers — and the cumulative usage carried on each event — see exactly
   * the ordering guarantee the window scheduler gave.
   *
   * Backoff is honoured end to end: a page with any unit in its retry backoff is
   * not handed out, and when nothing is due while pages are still unfinished
   * the loop waits for the earliest retry instant — within
   * JOB_MAX_TRANSIENT_WAIT — and otherwise returns `paused(dependency)` with
   * that instant, so the claim resumes the job automatically. It never reports
   * `completed` while a page is unfinished.
   */
  async function drivePages(args: {
    job: JobRow;
    /** First page of the job's `pages` window (1 without one). */
    firstPage: number;
    /** Last page of the window. */
    pageCount: number;
    /** How many pages the job processes (`pageCount - firstPage + 1`). */
    pageTotal: number;
    prepared: PreparedSource;
    analyzer: PreparedAnalyzer | null;
    stageRunner: StageRunner;
    budget: BudgetLedger;
    tenantBudget: TenantDailyPageBudget;
    events: JobEventBus;
    dedup: DedupRegistry;
    abort: AbortController;
  }): Promise<JobRunOutcome> {
    const {
      job,
      firstPage,
      pageCount,
      pageTotal,
      prepared,
      stageRunner,
      budget,
      tenantBudget,
      dedup,
      abort,
    } = args;
    const concurrency = Math.max(1, config.pageConcurrency);

    // Cumulative usage lives as two numbers, not a per-page array.
    const cumulative = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const stall = { since: null as number | null };
    let blindRounds = 0;

    // Continuous refill (Phase 11): instead of running a full window to
    // completion — which made every window wait for its slowest page — keep
    // `concurrency` slots busy and claim the next due page as soon as a slot
    // frees. A settled page is buffered until every SMALLER page has settled,
    // so page events keep their strict page order and the cumulative usage on
    // each event accumulates in publish order. A page that failed WITHOUT a
    // store-side backoff row gets a scheduler-side notBefore so the claim loop
    // cannot hot-spin on it.
    const inFlight = new Map<number, Promise<void>>();
    const settled = new Map<number, PromiseSettledResult<PageResult>>();
    const untrackedBackoff = new Map<number, number>();
    const untrackedRounds = new Map<number, number>();
    let leaseLost: unknown = null;

    const startPage = (page: number): void => {
      const done = runPage({
        job,
        page,
        pageCount,
        prepared,
        analyzer: args.analyzer,
        stageRunner,
        budget,
        tenantBudget,
        dedup,
      })
        .then(
          (result) => {
            settled.set(page, { status: "fulfilled", value: result });
          },
          (err: unknown) => {
            // A lost lease aborts the run at once, so the other pages start no
            // further model calls; the error is re-thrown in page order below.
            if (err instanceof LeaseLostError) {
              leaseLost ??= err;
              abort.abort();
            }
            settled.set(page, { status: "rejected", reason: err });
          },
        )
        .finally(() => {
          inFlight.delete(page);
        });
      inFlight.set(page, done);
    };

    /**
     * Publish every settled page whose predecessors have all settled, in page
     * order. Returns an early job outcome (tenant-budget failure, budget pause)
     * as soon as one is reached in page order; pages settled after it are
     * dropped — their checkpoints persist, so a resume replays them. A lease
     * loss in page order is thrown.
     */
    const publishPrefix = (): JobRunOutcome | null => {
      for (;;) {
        let next: number | null = null;
        for (const page of settled.keys()) {
          if (next === null || page < next) next = page;
        }
        if (next === null) return null;
        for (const running of inFlight.keys()) {
          if (running < next) return null; // must publish `next`'s predecessor first
        }
        const page = next;
        const result = settled.get(page) as PromiseSettledResult<PageResult>;
        settled.delete(page);
        if (result.status === "fulfilled") {
          if (result.value.budgetExceeded === true) {
            // The tenant's daily vision-page budget is exhausted. Design
            // §Budget: the job FAILS rather than pauses — a paused(budget)
            // job would suggest an operator could resume it today, but the
            // counter only resets at the next UTC day. The worker records the
            // cause (which names BUDGET_EXCEEDED) as a job warning and
            // transitions to failed.
            return {
              status: "failed",
              error: tenantDailyBudgetFailureMessage(
                config.visionBudgetPagesPerDay ?? 0,
              ),
            };
          }
          if (result.value.paused) {
            // Budget ran out before a model call: park the job. The checkpoint
            // was left untouched so a resume recomputes in place.
            return { status: "paused", reason: "budget" };
          }
          if (result.value.completed) {
            stall.since = null;
            blindRounds = 0;
            cumulative.requests += result.value.usage.requests;
            cumulative.promptTokens += result.value.usage.promptTokens;
            cumulative.completionTokens += result.value.usage.completionTokens;
            cumulative.totalTokens += result.value.usage.totalTokens;
            args.events.publish({
              type: "page",
              jobId: job.id,
              page,
              pageCount: pageTotal,
              record: result.value.record,
              assetIds: result.value.assetIds,
              usage: { ...cumulative },
            });
          }
        } else {
          const reason: unknown = result.reason;
          if (reason instanceof LeaseLostError || abort.signal.aborted) {
            throw reason instanceof LeaseLostError
              ? reason
              : new LeaseLostError(scope().fence);
          }
          if (reason instanceof BudgetExhaustedError) {
            return { status: "paused", reason: "budget" };
          }
          // A transient stage failure left a retryable checkpoint with backoff;
          // the store skips the page until it is due. Anything else wrote no
          // backoff, so the scheduler backs this page off itself.
          if (!(reason instanceof TransientStageError)) {
            const rounds = (untrackedRounds.get(page) ?? 0) + 1;
            untrackedRounds.set(page, rounds);
            untrackedBackoff.set(
              page,
              clock().getTime() + backoffMs(rounds, DEFAULT_BACKOFF),
            );
          }
          logger.warn(
            { jobId: job.id, page, err: reason },
            "Page stage failed transiently",
          );
        }
      }
    };

    /** Await every in-flight page so no promise settles unobserved. */
    const drainInFlight = async (): Promise<void> => {
      if (inFlight.size > 0) await Promise.allSettled([...inFlight.values()]);
    };

    for (;;) {
      try {
        assertLive();
      } catch (err) {
        await drainInFlight();
        throw err;
      }
      const early = publishPrefix();
      if (early !== null) {
        await drainInFlight();
        return early;
      }
      if (leaseLost !== null) {
        if (inFlight.size === 0) throw leaseLost;
        // A smaller page is still in flight: let it settle so publishPrefix
        // can publish it (or hit the lease loss itself) in page order. Claim
        // no new work — the lease is gone.
        await Promise.race([...inFlight.values()]);
        continue;
      }

      // Claim into the free slots only. The store also hands out pages whose
      // cursor stage is not done yet — including the ones already in flight —
      // so filter those client side.
      const free = concurrency - inFlight.size;
      if (free > 0) {
        const now = clock();
        // Look a few pages past the free slots when the source can render a
        // window in one call: the pages about to start, and the next ones, are
        // warmed together (one pdfinfo + one pdftoppm for the window instead
        // of two subprocesses per page).
        const ahead = prepared.prefetch !== undefined ? RENDER_LOOKAHEAD_PAGES : 0;
        const candidates = await store.nextRunnablePages(
          job.id,
          pageCount,
          CURSOR_STAGE,
          concurrency + ahead,
          now,
          firstPage,
        );
        if (prepared.prefetch !== undefined) {
          const toWarm = candidates
            .filter(
              (page) =>
                !inFlight.has(page) &&
                !settled.has(page) &&
                (untrackedBackoff.get(page) ?? 0) <= now.getTime(),
            )
            .slice(0, free + ahead);
          // Registered synchronously, before the pages start, so a page that
          // renders at once waits for its window instead of racing it.
          void prepared.prefetch(toWarm, abort.signal).catch(() => undefined);
        }
        for (const page of candidates) {
          if (inFlight.size >= concurrency) break;
          if (inFlight.has(page) || settled.has(page)) continue;
          const notBefore = untrackedBackoff.get(page);
          if (notBefore !== undefined) {
            if (notBefore > now.getTime()) continue;
            untrackedBackoff.delete(page);
          }
          startPage(page);
        }
      }

      if (inFlight.size === 0) {
        if (settled.size > 0) continue; // settled while the claim was in flight
        const now = clock();
        const finished = await store.finishedPageCount(job.id, CURSOR_STAGE);
        if (finished >= pageTotal) break;
        // Pages are unfinished but none is runnable: wait for the earliest
        // retry — the store's (checkpoint backoff) or the scheduler's own
        // (failures that wrote no backoff row).
        const retryTimes: number[] = [];
        const storeRetry = await store.earliestRetryAt(job.id, now);
        if (storeRetry !== null) retryTimes.push(storeRetry.getTime());
        for (const notBefore of untrackedBackoff.values()) {
          retryTimes.push(notBefore);
        }
        const retryAt =
          retryTimes.length > 0
            ? new Date(Math.min(...retryTimes))
            : new Date(
                now.getTime() + backoffMs(++blindRounds, DEFAULT_BACKOFF),
              );
        const paused = await waitOrPause(stall, retryAt, abort.signal, true);
        if (paused !== null) return paused;
        continue;
      }

      // Wait for the next page to settle, then refill its slot and publish
      // whatever has become publishable in page order.
      await Promise.race([...inFlight.values()]);
    }

    return { status: "completed" };
  }

  /** Result of running one page through its stages. */
  interface PageResult {
    completed: boolean;
    paused: boolean;
    /**
     * True when this page's vision model call pushed the tenant over its
     * daily page budget. The page's own
     * checkpoint is persisted — only the JOB fails, so a later manual retry
     * after the day rolls over reuses this page without a model call.
     */
    budgetExceeded?: boolean;
    record: PageRecord;
    assetIds: string[];
    usage: {
      requests: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
  }

  /**
   * Run one page: vision (render+model+parse folded into the checkpointed
   * stage), crops, then stage the emit-outbox row. On a resume the vision and
   * crop stages are reused from their checkpoints without a model call.
   */
  async function runPage(args: {
    job: JobRow;
    page: number;
    pageCount: number;
    prepared: PreparedSource;
    analyzer: PreparedAnalyzer | null;
    stageRunner: StageRunner;
    budget: BudgetLedger;
    tenantBudget: TenantDailyPageBudget;
    dedup: DedupRegistry;
  }): Promise<PageResult> {
    const {
      job,
      page,
      pageCount,
      prepared,
      stageRunner,
      budget,
      tenantBudget,
      dedup,
    } = args;
    const preparedAnalyzer = args.analyzer;
    const key = (stage: string): StageKey => ({ job_id: job.id, page, stage });
    const empty: PageResult["usage"] = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    // Hold the rendered page image for the crop step; it is discarded when the
    // page finishes, so memory does not accumulate across pages.
    let pageImage: PageImage | null = null;

    // Source, page, render DPI, model, the fast-path knobs that decide whether
    // the page is built without the model, and (via stageHash) the run's
    // pipeline/prompt stand — so a changed prompt recomputes.
    const visionInputHash = stageHash([
      job.source_sha256,
      page,
      config.renderDpi,
      config.visionModel,
      `fastPath:${fastPathEnabled ? fastPathMaxInkRatio : "off"}`,
    ]);

    // ── vision stage (render + model + parse, one checkpoint) ─────────────
    // Set only when the page actually reached the vision model: a fast-path
    // page, a render-hash dedup reuse, or a checkpoint replay runs no model
    // call and must not be charged against the tenant's daily page budget.
    // The closure flag is the reliable signal —
    // the persisted checkpoint cannot tell a reuse copy from a fresh call.
    let modelCalled = false;
    let visionParsed: VisionStageParsed;
    try {
      const result = await stageRunner.runStage<
        VisionStageParsed | undefined,
        string
      >({
        unit: "page",
        key: key(VISION1_STAGE),
        // The input hash pins render DPI + model + page; a resume with the same
        // stand reuses the checkpoint. The source sha256 anchors the content.
        inputHash: visionInputHash,
        budget: { ledger: budget, estimatedTokens: config.visionTokenEstimate, ...pricingOf(config.visionPricing) },
        fn: async () => {
          let rendered: Awaited<ReturnType<PreparedSource["render"]>>;
          try {
            rendered = await prepared.render(page);
          } catch (error) {
            // A per-page render/text failure (broken xref, decoder choke) is
            // permanent for THIS page: mark it failed with a warning and let the
            // job continue, exactly as v1 collapsed a bad page to an empty one
            // rather than failing the whole document.
            throw new PermanentStageError(
              `render failed on page ${page}: ${errMessage(error)}`,
              `Die Seite konnte nicht gerendert oder ihr Text nicht extrahiert werden: ${errMessage(error)}`,
            );
          }
          pageImage = rendered.image;

          // ── render-hash dedup ──────────────
          // If an already-processed page rendered identically, reuse its vision
          // result verbatim instead of calling the model again. The reuse is a
          // deterministic copy of the source page's persisted vision checkpoint
          // — no model call, no budget spend — exactly the "reuse the vision
          // result" the requirement asks for.
          const hash = await renderHash(rendered.image.buffer);
          const decision = dedup.register(page, hash);
          if (decision.kind === "duplicate") {
            const reused = await reuseVisionFromPage(
              job,
              decision.sourcePage,
              page,
              rendered,
            );
            if (reused !== null) {
              // A deterministic stage result: raw carried over so `reparse`
              // still works, tokensUsed 0 so the budget is not charged twice.
              return { raw: reused.raw, parsed: reused.parsed, tokensUsed: 0 };
            }
            // The source checkpoint was not ready (e.g. still in flight in the
            // same window); fall through to a fresh, correct vision call.
          }

          // ── S2 heading candidates as a Pass-1 hint ──────────
          // Best-effort and order-independent: the analyzer never throws (it
          // degrades to an empty analysis), so a page with no text layer or a
          // container without `-bbox-layout` simply passes no hints. The
          // analysis is cheap (no model) and not itself checkpointed here — the
          // ordered `analyzed` stage is task 2.6's concern; here we only need
          // the per-page heading candidates the prompt consumes.
          const analysis = await runPageAnalysis(preparedAnalyzer, page);
          const headingCandidates = analysis?.headingCandidates.map((c) => ({
            numbering: c.numbering,
            text: c.text,
          }));

          // ── S2 classification ─────────────
          // The real page size in points (never pixels) and the ink outside
          // the S2 text blocks drive the class, which in turn gates the fast
          // path and the tiling stage.
          const sizePt = resolvePageSizePt(
            rendered,
            analysis,
            config.renderDpi,
          );
          const classification = await classifyRenderedPage({
            imageBuffer: rendered.image.buffer,
            rawText: rendered.rawText,
            usedOcr: rendered.usedOcr,
            sizePt,
            analysis,
          });

          // ── text fast-path (task 2.9, requirements 7.5, 18.1) ──────────
          // A `text` page with no table/figure candidates and usable S2
          // geometry builds its blocks deterministically from that geometry —
          // NO vision call, tokensUsed 0. The gate is conservative: any anomaly
          // (not text, no geometry, too much ink outside the blocks, a flagged
          // fidelity check, incomplete coverage of the text layer, a table or
          // figure candidate) falls the page back to the vision path below.
          if (fastPathEnabled && analysis !== null) {
            const fast = await tryFastPath(
              page,
              rendered,
              analysis,
              classification,
              sizePt,
            );
            if (fast !== null) {
              return { raw: null, parsed: fast, tokensUsed: 0 };
            }
          }

          // ── previous-page context ───────────────────────
          const prev = await prevPageContextFor(job, page);

          // This page takes the vision path (either the fast path was disabled
          // / ineligible, or there was no S2 analysis). Count the route so the
          // "Anteil Fast-Path" share reflects it.
          metrics?.recordFastPath("vision");
          modelCalled = true;
          let response: VisionPageResult;
          // Set when the Tesseract fallback produced this page's text;
          // drives the warning and `usedOcr` on the checkpoint.
          let ocrFallback = false;
          try {
            response = await vision.analyzePage({
              page,
              pageCount,
              rawText: rendered.rawText,
              image: {
                buffer: rendered.image.buffer,
                mimeType: rendered.image.mimeType,
              },
              ...(headingCandidates !== undefined &&
              headingCandidates.length > 0
                ? { headingCandidates }
                : {}),
              ...(prev.context !== null ? { prevPage: prev.context } : {}),
            });
          } catch (error) {
            // ── Tesseract OCR fallback ───────
            // A VLM outage must not cost a scanned page its content: with
            // OCR_FALLBACK=tesseract, recognise the rendered page image with
            // Tesseract instead and record a warning on the page. The gate is
            // deliberately narrow — only a vision outage (VISION_UNAVAILABLE,
            // the code the client throws once its retries are exhausted) on a
            // page the classifier called a `scan` (a text page keeps its text
            // layer, a drawing needs the model) with the fallback enabled.
            // Anything else, and a failing OCR run too, re-raises the original
            // error unchanged so the stage's transient-retry semantics (and
            // the backoff in the stage runner) stay exactly as before.
            if (
              ocr === null ||
              !ocr.enabled ||
              classification.class !== "scan" ||
              !(error instanceof ExtractError) ||
              error.code !== "VISION_UNAVAILABLE"
            ) {
              throw error;
            }
            logger.warn(
              { jobId: job.id, page, err: errMessage(error) },
              "Vision model unavailable; recognising the scanned page with Tesseract instead",
            );
            let text: string;
            try {
              text = await ocr.recognize(
                rendered.image.buffer,
                withRunSignal({}),
              );
            } catch (ocrError) {
              logger.warn(
                { jobId: job.id, page, err: errMessage(ocrError) },
                "Tesseract OCR fallback failed; re-raising the vision error",
              );
              throw error;
            }
            ocrFallback = true;
            // A synthetic response in the model's own tag format: `parseVisionPage`
            // below reads it back verbatim, and a reparse of the checkpoint
            // works exactly like one of a real response. No tokens were spent.
            response = {
              raw: `<markdown>\n${text}\n</markdown>`,
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              requests: 0,
              truncated: false,
              maxTokens: 0,
            };
          }
          const parsed = parseVisionPage(response.raw, page);
          // ── S4 deterministic refinement ────
          // Snap each figure bbox to the ink + text blocks and pull the
          // text-layer words inside it. Folded into the vision1 checkpoint
          // (not a separate stage) because it consumes exactly what this stage
          // already has to hand — the rendered page image and this page's S2
          // analysis — and its output must be persisted so a resume reuses the
          // snapped bbox and regionText without recomputing. See the S4 note in
          // `refineFigures`.
          const refined = await refineFigures(
            parsed.figures,
            rendered.image,
            analysis,
          );
          const stageParsed: VisionStageParsed = {
            summary: parsed.summary,
            markdown: parsed.markdown,
            figures: refined,
            tables: parsed.tables.map((t) => ({
              index: t.index,
              continues: t.continues,
              continuationOf: t.continuationOf,
            })),
            warnings: [
              ...parsed.warnings,
              ...(response.truncated ? [TRUNCATION_WARNING] : []),
              ...(ocrFallback ? [OCR_FALLBACK_WARNING] : []),
            ],
            usedOcr: rendered.usedOcr || ocrFallback,
            usage: { requests: response.requests, ...response.usage },
            truncated: response.truncated,
            size: { wPt: sizePt.widthPt, hPt: sizePt.heightPt },
            imageWidth: rendered.image.width,
            imageHeight: rendered.image.height,
            pageClass: classification.class,
            renderHash: hash,
            prevPageContext: prev.context,
            prevPageContextHash: prev.hash,
          };
          return {
            raw: response.raw,
            parsed: stageParsed,
            tokensUsed: response.usage.totalTokens,
          };
        },
      });
      // Tenant daily vision-page budget: charge
      // exactly the pages that took a real model call. The check runs
      // OUTSIDE runStage on purpose — a tenant-budget exhaustion is not a
      // stage failure, and reporting it through the stage would either
      // poison this page's checkpoint (permanent) or retry it pointlessly
      // (transient). The page's own result stays persisted: after the day
      // rolls over, a manual retry reuses it without a model call. The
      // charge also covers a stage that failed permanently AFTER the model
      // answered — the call spent real money even if its parse did not.
      if (modelCalled && !(await tenantBudget.tryConsumePage())) {
        return {
          completed: false,
          paused: false,
          budgetExceeded: true,
          record: emptyRecord(page),
          assetIds: [],
          usage: empty,
        };
      }
      // A reused/resumed checkpoint carries the source page's render hash;
      // re-register it so a *third* identical page still points at a source.
      if (result.parsed?.renderHash != null) {
        dedup.register(page, result.parsed.renderHash);
      }
      if (result.parsed === undefined) {
        // The vision stage failed permanently (its checkpoint is `failed`). Do
        // not lose the document over one page: emit an empty page carrying the
        // failure warning and advance the cursor so the scheduler moves past it,
        // exactly as v1 did.
        const warning =
          result.row.error ?? "Die Seite konnte nicht verarbeitet werden.";
        const record: PageRecord = {
          ...emptyRecord(page),
          warnings: [warning],
        };
        await stageEmitRow(job, page, record);
        await stageRunner.runStage<{ page: number }, null>({
          unit: "page",
          key: key(EMITTED_STAGE),
          inputHash: stageHash(["emit", job.source_sha256, page]),
          fn: async () => ({ raw: null, parsed: { page } }),
        });
        return {
          completed: true,
          paused: false,
          record,
          assetIds: [],
          usage: empty,
        };
      }
      visionParsed = result.parsed;
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        return {
          completed: false,
          paused: true,
          record: emptyRecord(page),
          assetIds: [],
          usage: empty,
        };
      }
      throw err;
    }

    // ── crops stage: cut each figure and stage it to the asset area ───────
    const cropKey = key(CROPS_STAGE);
    const existingCrops = await store.getStage("page", cropKey);
    const assetIds: string[] = [];
    if (existingCrops === null || existingCrops.status !== "done") {
      // Re-render is only possible while we still hold the page image (i.e. the
      // vision stage just ran). On a pure resume where vision was reused, the
      // page image is null; re-render it deterministically for the crops.
      if (
        pageImage === null &&
        visionParsed.figures.some((f) => isCroppable(f.bbox))
      ) {
        const rendered = await prepared.render(page);
        pageImage = rendered.image;
      }
      const staged = await stageCrops({
        job,
        page,
        prepared,
        pageImage,
        figures: visionParsed.figures,
      });
      assetIds.push(...staged);
      // A page image is always addressable as an asset even without figures.
      await lease_guardStageAsset(
        args.job,
        page,
        pageAssetId(job.reference, page),
        "page",
      );
      await args.stageRunner.runStage<{ assetIds: string[] }, null>({
        unit: "page",
        key: cropKey,
        inputHash: stageHash(["crops", job.source_sha256, page]),
        fn: async () => ({ raw: null, parsed: { assetIds } }),
      });
    } else {
      const parsed = (
        existingCrops.output as { parsed?: { assetIds?: string[] } } | null
      )?.parsed;
      if (parsed?.assetIds !== undefined) assetIds.push(...parsed.assetIds);
    }

    // ── figure Pass 2 (S5): a checkpointed stage per gated figure ─────────
    // Each figure that passes the gate (kind ∈ FIGURE_PASS2_KINDS, area ≥ the
    // minimum, budget available) gets its own `figure2` checkpoint. The
    // resulting transcription is written back onto `visionParsed.figures` so
    // the page record built below emits it, and a resume replays the checkpoint
    // with no model call. A budget exhaustion pauses the job cleanly, exactly
    // like the page-budget path.
    try {
      await runFigurePass2({
        job,
        page,
        prepared,
        stageRunner,
        budget,
        visionParsed,
      });
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        return {
          completed: false,
          paused: true,
          record: emptyRecord(page),
          assetIds,
          usage: empty,
        };
      }
      throw err;
    }

    // ── tiling (S6): split a large-format page into overlapping tiles ─────
    // A `drawing` page or a sheet over A3 is transcribed tile-by-tile at a
    // higher effective resolution and the results merged, with each tile stored
    // as a `tile` asset. A normal page
    // is a single tile and is left untouched. Budget exhaustion pauses the job
    // cleanly, exactly like the figure Pass-2 path above.
    try {
      const tileAssetIds = await runTilePass({
        job,
        page,
        prepared,
        stageRunner,
        budget,
        visionParsed,
      });
      assetIds.push(...tileAssetIds);
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        return {
          completed: false,
          paused: true,
          record: emptyRecord(page),
          assetIds,
          usage: empty,
        };
      }
      throw err;
    }

    // ── fast-path page summary ────────────
    // A fast-path page made no vision call, so it has no Pass-1 summary. When
    // the text-LLM is configured, it gets one as its own checkpointed,
    // budget-gated stage; without it the page simply carries none.
    try {
      await runFastPathSummary({
        job,
        page,
        stageRunner,
        budget,
        visionParsed,
      });
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        return {
          completed: false,
          paused: true,
          record: emptyRecord(page),
          assetIds,
          usage: empty,
        };
      }
      throw err;
    }

    // ── build the v2 page record ──────────────────────────────────────────
    const record = buildPageRecord(job.reference, page, visionParsed);

    // ── emitted stage: stage the page's emit-outbox row (cursor) ──────────
    await stageEmitRow(job, page, record);
    await stageRunner.runStage<{ page: number }, null>({
      unit: "page",
      key: key(EMITTED_STAGE),
      // The block-model version is part of the emitted record's inputs: a new
      // Markdown → block mapping must not be mistaken for the staged record.
      inputHash: stageHash([
        "emit",
        job.source_sha256,
        page,
        `blocks:${MARKDOWN_BLOCKS_VERSION}`,
      ]),
      fn: async () => ({ raw: null, parsed: { page } }),
    });

    return {
      completed: true,
      paused: false,
      record,
      assetIds,
      usage: visionParsed.usage,
    };
  }

  /**
   * Reuse an already-processed identical page's vision result (task 2.2,
   * ). Loads the source page's `vision1` checkpoint; when it is
   * `done` with a persisted raw response, returns a stage result that carries
   * the source's raw + parsed but re-anchored to this page's size/image
   * dimensions (so crops and the record use this page's own geometry, which is
   * identical anyway). Returns `null` when the source checkpoint is not ready —
   * the caller then falls back to a fresh vision call.
   */
  async function reuseVisionFromPage(
    job: JobRow,
    sourcePage: number,
    page: number,
    rendered: Awaited<ReturnType<PreparedSource["render"]>>,
  ): Promise<{ raw: string | null; parsed: VisionStageParsed } | null> {
    const sourceRow = await store.getStage("page", {
      job_id: job.id,
      page: sourcePage,
      stage: VISION1_STAGE,
    });
    if (sourceRow === null || sourceRow.status !== "done") return null;
    const output = sourceRow.output as { raw?: unknown; parsed?: VisionStageParsed } | null;
    const sourceParsed = output?.parsed;
    if (sourceParsed === undefined) return null;

    logger.debug(
      { jobId: job.id, page, sourcePage },
      "Identical render hash; reusing the source page's vision result (no model call)",
    );
    // Figure ids are page-scoped (`p<page>-f<n>`) and must be document-unique,
    // so the copy re-ids them for this page — exactly the ids a re-parse of the
    // copied raw response as this page yields — and rewrites the body
    // placeholders in lockstep.
    let markdown = sourceParsed.markdown;
    const figures = sourceParsed.figures.map((figure, index) => {
      const id = buildFigureId(page, index + 1);
      markdown = markdown.split(buildFigurePlaceholder(figure.id)).join(buildFigurePlaceholder(id));
      const { transcription: _transcription, ...rest } = figure;
      return { ...rest, id };
    });
    // A fast-path source carries page-stamped blocks; re-stamp them likewise.
    const fastPathBlocks = sourceParsed.fastPathBlocks?.map((block) => ({
      ...block,
      id: block.id.replace(/^p\d+-/, `p${page}-`),
      page,
    }));
    const parsed: VisionStageParsed = {
      ...sourceParsed,
      markdown,
      figures,
      ...(fastPathBlocks !== undefined ? { fastPathBlocks } : {}),
      // Re-anchor to this page's own (identical) rendered geometry. Size and
      // class are the source's: the render is byte-identical.
      usedOcr: rendered.usedOcr,
      imageWidth: rendered.image.width,
      imageHeight: rendered.image.height,
      // The reused copy costs no tokens.
      usage: { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      // Pass 2 / tiling copy the source page's results (no model call).
      dedupOf: sourceParsed.dedupOf ?? sourcePage,
      // The copy was not produced from any context of its own.
      prevPageContext: null,
      prevPageContextHash: null,
    };
    const raw = typeof output?.raw === "string" ? output.raw : null;
    return { raw, parsed };
  }

  /**
   * The finished result of a dedup source page's per-figure / per-tile stage
   * or `null` when it is not `done` yet (e.g. still in
   * flight in the same window) — the caller then runs the stage normally. The
   * raw response is carried along so a `reparse` of the copy still works.
   */
  async function dedupSourceResult<P>(
    unit: "figure" | "tile",
    key: StageKey,
  ): Promise<{ raw: string | null; parsed: P } | null> {
    const row = await store.getStage(unit, key);
    if (row === null || row.status !== "done" || !isStageOutput(row.output)) return null;
    const output = row.output as StageOutput<P | null, unknown>;
    if (output.parsed === null || output.parsed === undefined) return null;
    logger.debug(
      { jobId: key.job_id, sourcePage: key.page, stage: key.stage },
      "Duplicate page: reusing the source page's stage result (no model call)",
    );
    return { raw: typeof output.raw === "string" ? output.raw : null, parsed: output.parsed };
  }

  /**
   * Attempt the deterministic text fast-path for a page (task 2.9, requirements
   * 7.5, 18.1). Returns a fully-formed {@link VisionStageParsed} when the page
   * qualifies — built from the S2 geometry with NO model call, all-zero usage —
   * or `null` when the eligibility gate says the page must go through vision.
   *
   * The gate (every step conservative — any doubt → `null`, vision runs):
   *   1. {@link fastPathEligibility} on the page's classification (computed by
   *      the caller WITH the ink-outside-blocks ratio): text class, usable
   *      geometry, ink at or below the ceiling;
   *   2. no table/figure candidate in the geometry or the text layer
   *      ({@link detectFastPathCandidates}: column-aligned lines, captions);
   *   3. the built blocks cover the text layer's words
   *      ({@link checkFastPathCoverage});
   * 4. the fidelity check does not flag — a flagged check
   *      falls back to vision instead of emitting a divergent page.
   *
   * Records the fidelity outcome and, on success, the fast-path route. Never
   * throws: any failure degrades to `null` so the page safely uses vision.
   */
  async function tryFastPath(
    page: number,
    rendered: RenderedPageInput,
    analysis: PageAnalysis,
    classification: Classification,
    sizePt: { widthPt: number; heightPt: number },
  ): Promise<VisionStageParsed | null> {
    try {
      const decision = fastPathEligibility({
        enabled: fastPathEnabled,
        classification,
        analysis,
        maxInkRatio: fastPathMaxInkRatio,
      });
      if (!decision.eligible) {
        logger.debug({ page, reason: decision.reason }, "Text fast-path declined; using vision");
        return null;
      }

      const candidates = detectFastPathCandidates(analysis, rendered.rawText);
      if (candidates.table || candidates.figure) {
        logger.debug({ page, candidates }, "Text fast-path declined: table/figure candidate; using vision");
        return null;
      }

      const blocks = buildTextFastPathBlocks(analysis, page);
      if (blocks.length === 0) {
        // No blocks could be built despite passing the gate (all-empty text):
        // let vision handle it rather than emit an empty page.
        return null;
      }

      // The blocks must reproduce the text layer: a word the geometry lost
      // (text outside every block, a dropped run) means the page is not what
      // the text layer says, so vision handles it.
      const coverage = checkFastPathCoverage(rendered.rawText, blocks);
      if (!coverage.complete) {
        logger.debug({ page, coverage: coverage.ratio }, "Text fast-path declined: incomplete token coverage");
        return null;
      }

      // The fidelity check stays active and is binding: a
      // flagged divergence between blocks and text layer falls back to vision.
      const fidelity = checkFastPathFidelity(rendered.rawText, blocks);
      metrics?.recordTextFidelity({ flagged: fidelity.flagged, missingTokens: fidelity.missing.length });
      if (fidelity.flagged) {
        logger.info(
          { page, missing: fidelity.missing.length },
          "Text fast-path declined: fidelity check flagged a divergence; using vision",
        );
        return null;
      }
      metrics?.recordFastPath("fast-path");

      logger.debug({ page, blocks: blocks.length }, "Text fast-path: blocks built from S2, no vision call");

      const parsed: VisionStageParsed = {
        summary: undefined,
        // No Pass-1 summary on the fast path (no vision call); the separate,
        // checkpointed `summary:page` stage fills it over the text-LLM when one
        // is configured. The page markdown is left empty because the blocks
        // below are authoritative.
        markdown: "",
        figures: [],
        tables: [],
        warnings: [],
        usedOcr: false,
        usage: { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        truncated: false,
        size: { wPt: sizePt.widthPt, hPt: sizePt.heightPt },
        imageWidth: rendered.image.width,
        imageHeight: rendered.image.height,
        pageClass: "text",
        renderHash: await renderHash(rendered.image.buffer),
        fastPath: true,
        fastPathBlocks: blocks,
      };
      return parsed;
    } catch (err) {
      logger.warn({ page, err }, "Text fast-path failed; falling back to vision");
      return null;
    }
  }

  /**
   * Run the deterministic S2 analysis for a page, returning `null` when there
   * is no analyzer bound. Never throws — the analyzer degrades to an empty
   * analysis on any per-page failure — so a hint that cannot be produced simply
   * is not produced, and the page falls through to vision unhinted.
   */
  async function runPageAnalysis(
    preparedAnalyzer: PreparedAnalyzer | null,
    page: number,
  ): Promise<PageAnalysis | null> {
    if (preparedAnalyzer === null) return null;
    const started = Date.now();
    try {
      const analysis = await preparedAnalyzer.analyze(page, scope().signal);
      metrics?.recordStage?.({ stage: "analyzed", outcome: "done", durationMs: Date.now() - started });
      return analysis;
    } catch (err) {
      assertLive();
      metrics?.recordStage?.({ stage: "analyzed", outcome: "failed_transient", durationMs: Date.now() - started });
      logger.warn({ page, err }, "S2 page analysis failed; continuing without heading hints");
      return null;
    }
  }

  /**
   * The previous-page context for page N's Pass-1 prompt (≤ tokens): the
   * headings of page N−1 (from its blocks) and the header row of a table page
   * N−1 left open (`continues`).
   *
   * ## Why this is resume-idempotent without being in the input hash
   *
   * Pages run concurrently, so whether page N−1 is finished when page N starts
   * depends on scheduling. The context is therefore used ONLY when page N−1's
   * `vision1` checkpoint is already `done`; otherwise page N runs without it —
   * never waiting on N−1, so there is no ordering deadlock. The context is NOT
   * folded into the `vision1` input hash: a resume would otherwise see N−1 done
   * (where the first run did not), compute a different hash and pay for a
   * second model call for an already finished page. Instead the context that
   * was actually used, and its hash, are persisted on page N's checkpoint; a
   * resume reuses that checkpoint verbatim (same input hash), so the result is
   * identical and no model is called twice. The full heading chain from pages
   * 1..N−1 is the ordered document pass's state and is not available here;
   * page N−1's own headings are the bounded stand-in the design allows.
   */
  async function prevPageContextFor(
    job: JobRow,
    page: number,
  ): Promise<{ context: PrevPageContext | null; hash: string | null }> {
    const none = { context: null, hash: null };
    if (page <= 1) return none;
    const row = await store.getStage("page", { job_id: job.id, page: page - 1, stage: VISION1_STAGE });
    if (row === null || row.status !== "done") return none;
    const prevParsed = parsedOfRow<VisionStageParsed>(row);
    if (prevParsed === undefined) return none;
    const blocks =
      prevParsed.fastPath === true && prevParsed.fastPathBlocks !== undefined
        ? prevParsed.fastPathBlocks
        : parseMarkdownBlocks(prevParsed.markdown, { page: page - 1, source: "vision" }).items.flatMap((i) =>
            i.kind === "block" ? [i.block] : [],
          );
    const headingChain = blocks.flatMap((b) => (b.type === "heading" ? [headingDisplayText(b)] : []));
    let lastTableHeader: string | undefined;
    for (const block of blocks) {
      if (block.type === "table" && block.continues === true) lastTableHeader = tableHeaderText(block);
    }
    if (headingChain.length === 0 && lastTableHeader === undefined) return none;
    const context: PrevPageContext = {
      headingChain,
      ...(lastTableHeader !== undefined ? { lastTableHeader } : {}),
    };
    return { context, hash: sha256Hex(JSON.stringify(context)) };
  }

  /**
   * The page summary of a fast-path page: a fast-path page
   * made no vision call and so has no Pass-1 summary. When the text-LLM is
   * configured it is produced as its own checkpointed, budget-gated stage
   * `summary:page` over the page's block text; a resume reuses the checkpoint
   * with no model call. Without a summary client (or on a vision page) this is
   * a no-op. A text-LLM outage surfaces as a transient stage failure, so the
   * page backs off and the job pauses on dependency like a vision outage.
   */
  async function runFastPathSummary(args: {
    job: JobRow;
    page: number;
    stageRunner: StageRunner;
    budget: BudgetLedger;
    visionParsed: VisionStageParsed;
  }): Promise<void> {
    const { job, page, stageRunner, budget, visionParsed } = args;
    if (summaryClient === null || visionParsed.fastPath !== true || visionParsed.summary !== undefined) return;
    const content = fastPathMarkdown(visionParsed.fastPathBlocks ?? []);
    if (content.trim() === "") return;
    // A render-hash duplicate copies the source page's summary (no call).
    let sourceCopy: { raw: string | null; parsed: { summary: string } } | null = null;
    if (visionParsed.dedupOf !== undefined) {
      const row = await store.getStage("page", { job_id: job.id, page: visionParsed.dedupOf, stage: "summary:page" });
      const copied = row?.status === "done" ? parsedOfRow<{ summary: string }>(row) : undefined;
      if (copied !== undefined && typeof copied.summary === "string") {
        sourceCopy = { raw: copied.summary, parsed: copied };
      }
    }
    const result = await stageRunner.runStage<{ summary: string } | undefined, string>({
      unit: "page",
      key: { job_id: job.id, page, stage: "summary:page" },
      inputHash: stageHash([
        "summary:page",
        job.source_sha256,
        page,
        SUMMARY_PROMPT_VERSION,
        config.summaryModel ?? "",
        sha256Hex(content),
      ]),
      ...(sourceCopy !== null
        ? {}
        : { budget: { ledger: budget, estimatedTokens: config.summaryTokenEstimate ?? 512, ...pricingOf(config.summaryPricing) } }),
      fn: async () => {
        if (sourceCopy !== null) return { raw: sourceCopy.raw, parsed: sourceCopy.parsed, tokensUsed: 0 };
        try {
          const res = await summaryClient.summarize({ scope: "page", content });
          return { raw: res.text, parsed: { summary: res.text }, tokensUsed: res.usage.totalTokens };
        } catch (err) {
          if (err instanceof TransientSummaryFailure) throw new TransientStageError(err.message, err);
          throw err;
        }
      },
    });
    const summary = result.parsed?.summary?.trim();
    if (summary !== undefined && summary !== "") visionParsed.summary = summary;
  }

  /**
   * Run Pass 2 (S5) for each gated figure on a page (task 2.5, requirements
   * 8.3/8.4/8.6). For each figure it decides — via {@link pass2Gate} — whether
   * Pass 2 applies, and when it does runs a per-figure `figure2` stage that
   * calls the vision model once (twice on a low-coverage retry), parses the
   * response into a validated {@link Transcription}, and persists it on the
   * checkpoint. The transcription is written back onto the in-memory figure so
   * the page record emits it; on a resume the checkpoint is reused verbatim
   * with no model call.
   *
   * Gating and coverage:
   *  - a kind outside `FIGURE_PASS2_KINDS`, a figure below the minimum area, or
   *    a figure with no usable bbox is skipped (no stage, no model call);
   *  - after Pass 2, label coverage is measured against the figure's `labels`;
   *    below `LABEL_COVERAGE_MIN` a warning is pushed and Pass 2 is retried
   *    exactly once, then whatever coverage results is accepted (still warned).
   *
   * A budget exhaustion propagates as {@link BudgetExhaustedError} so the caller
   * pauses the job; a transcription failure never fails the page (the parser
   * degrades to a markdown transcription, and a permanent stage failure just
   * leaves the figure without a transcription and a warning on the job).
   */
  async function runFigurePass2(args: {
    job: JobRow;
    page: number;
    prepared: PreparedSource;
    stageRunner: StageRunner;
    budget: BudgetLedger;
    visionParsed: VisionStageParsed;
  }): Promise<void> {
    const { job, page, prepared, stageRunner, budget, visionParsed } = args;
    const kinds = new Set<string>(config.figurePass2Kinds);
    const pageWarnings: string[] = [];

    // Hold at most one figure-DPI page render, cut per figure and discarded
    // when the page finishes so memory does not accumulate.
    let figurePage: PageImage | null = null;

    for (const figure of visionParsed.figures) {
      const gate = pass2Gate(figure, kinds, config.figurePass2MinArea);
      if (!gate.run) continue;

      const bbox = gate.bbox;
      const figureKey: StageKey = {
        job_id: job.id,
        page,
        figure_id: figure.id,
        stage: FIGURE2_STAGE,
      };
      // The input hash pins the crop's inputs: source, page, figure, kind, DPI,
      // model and the snapped bbox. A resume with the same stand reuses the
      // checkpoint; a changed bbox (a re-run S4) recomputes.
      // The run's pipeline/prompt stand and the coverage threshold (it decides
      // the retry) are part of the input too.
      const inputHash = stageHash([
        "figure2",
        job.source_sha256,
        page,
        figure.id,
        figure.kind ?? "other",
        config.figureDpi,
        config.visionModel,
        config.labelCoverageMin,
        bbox.join(","),
      ]);

      type Figure2Parsed = { transcription: Transcription; coverage: number; warnings: string[] };

      // ── dedup: a duplicate page copies the source page's
      //    finished Pass-2 result for the same figure — no model call, no
      //    budget. Figures are re-id'd in order, so ordinal n maps to n.
      const sourceCopy =
        visionParsed.dedupOf !== undefined
          ? await dedupSourceResult<Figure2Parsed>("figure", {
              job_id: job.id,
              page: visionParsed.dedupOf,
              figure_id: buildFigureId(visionParsed.dedupOf, figureOrdinalOf(figure.id)),
              stage: FIGURE2_STAGE,
            })
          : null;

      const result = await stageRunner.runStage<Figure2Parsed | undefined, string>({
        unit: "figure",
        key: figureKey,
        inputHash,
        ...(sourceCopy !== null
          ? {}
          : { budget: { ledger: budget, estimatedTokens: config.visionTokenEstimate, ...pricingOf(config.visionPricing) } }),
        fn: async () => {
          if (sourceCopy !== null) return { raw: sourceCopy.raw, parsed: sourceCopy.parsed, tokensUsed: 0 };
          // Render the figure-DPI crop once per figure (reusing the figure-DPI
          // page render across figures on the page).
          if (figurePage === null) {
            const rendered = await prepared.render(page);
            // renderFigureCrop re-renders at figureDpi internally when it beats
            // the model resolution; pass the model page as the fallback source.
            figurePage = rendered.image;
          }
          const crop = await prepared
            .renderFigureCrop(page, bbox as unknown as BoundingBox, figurePage)
            .catch(() => null);
          if (crop === null) {
            throw new PermanentStageError(
              `figure crop failed on page ${page} figure ${figure.id}`,
              `Die Abbildung konnte für Pass 2 nicht ausgeschnitten werden.`,
            );
          }

          const kind = figure.kind ?? "other";
          const regionText = figure.regionText ?? "";
          const labels = figure.labels ?? [];

          // First Pass-2 call.
          let response = await vision.analyzeFigure({
            page,
            figureId: figure.id,
            kind,
            regionText,
            ...(figure.caption !== undefined ? { caption: figure.caption } : {}),
            image: { buffer: crop.buffer, mimeType: crop.mimeType },
          });
          let tokensUsed = response.usage.totalTokens;
          let parsed = parseTranscription(kind, response.raw);
          if (parsed === null) {
            // Defensive: the gate guarantees a parser exists for this kind.
            throw new PermanentStageError(
              `no Pass-2 parser for kind ${kind}`,
              `Für den Abbildungstyp ${kind} gibt es keine Pass-2-Transkription.`,
            );
          }
          const warnings = [...parsed.warnings];
          let coverage = labelCoverage(labels, parsed.transcription);

          // Label-coverage check with a single retry.
          const threshold = config.labelCoverageMin / 100;
          if (labels.length > 0 && coverage < threshold) {
            warnings.push(
              `Pass 2 für Abbildung ${figure.id}: Label-Coverage ${(coverage * 100).toFixed(0)} % unter ${config.labelCoverageMin} %; wird einmal wiederholt.`,
            );
            const retry = await vision.analyzeFigure({
              page,
              figureId: figure.id,
              kind,
              regionText,
              ...(figure.caption !== undefined ? { caption: figure.caption } : {}),
              image: { buffer: crop.buffer, mimeType: crop.mimeType },
            });
            tokensUsed += retry.usage.totalTokens;
            const retryParsed = parseTranscription(kind, retry.raw);
            if (retryParsed !== null) {
              const retryCoverage = labelCoverage(labels, retryParsed.transcription);
              // Keep whichever attempt covered more of the labels.
              if (retryCoverage >= coverage) {
                response = retry;
                parsed = retryParsed;
                coverage = retryCoverage;
                warnings.push(...retryParsed.warnings);
              }
            }
            if (coverage < threshold) {
              warnings.push(
                `Pass 2 für Abbildung ${figure.id}: Label-Coverage weiterhin ${(coverage * 100).toFixed(0)} % nach Wiederholung.`,
              );
            }
          }

          return {
            raw: response.raw,
            parsed: { transcription: parsed.transcription, coverage, warnings },
            tokensUsed,
          };
        },
      });

      if (result.parsed !== undefined) {
        figure.transcription = result.parsed.transcription;
        for (const warning of result.parsed.warnings) {
          if (!pageWarnings.includes(warning)) pageWarnings.push(warning);
        }
      }
      // A permanent figure failure (crop/parser) is recorded on the job by the
      // stage runner; the figure simply keeps no transcription. Do not fail the
      // page over one figure.
    }

    if (pageWarnings.length > 0) {
      visionParsed.warnings = [...visionParsed.warnings, ...pageWarnings];
    }
  }

  /**
   * Run the large-format tiling stage (S6) for a page. A page classified as
   * `drawing`, or whose long edge exceeds A3, is split into an N×M grid of
   * overlapping tiles; each tile gets its own checkpointed `tiled` stage that
   * renders the tile crop, transcribes it with the technical-drawing prompt,
   * and is stored as a `tile` asset. The per-tile transcriptions are merged
   * (overlap deduplicated) and written onto `visionParsed.tiled` so
   * `buildPageRecord` emits a page-spanning `technical_drawing` figure block
   * with `tiles[]`.
   *
   * Mirrors {@link runFigurePass2}: one checkpoint per tile keyed on
   * `(job, page, tile_id, tiled)` with an input hash that pins source, page,
   * tile bbox, DPI, model and prompt kind, so a resume replays each tile with
   * no model call and the merge re-runs deterministically. A budget exhaustion
   * propagates as {@link BudgetExhaustedError}; a per-tile transcription failure
   * never fails the page (the tile simply contributes no transcription).
   *
   * Returns the `tile` asset ids staged, in grid order (empty for a normal,
   * single-tile page — the stage is then a no-op).
   */
  async function runTilePass(args: {
    job: JobRow;
    page: number;
    prepared: PreparedSource;
    stageRunner: StageRunner;
    budget: BudgetLedger;
    visionParsed: VisionStageParsed;
  }): Promise<string[]> {
    const { job, page, prepared, stageRunner, budget, visionParsed } = args;

    const size = { widthPt: visionParsed.size.wPt, heightPt: visionParsed.size.hPt };
    if (!shouldTilePage(visionParsed.pageClass, size)) return [];

    const grid = planTiles(size, {
      tileTargetPixels: config.tileTargetPixels ?? 2000,
      overlapFraction: config.tileOverlapFraction ?? 0.1,
      maxTiles: config.tileMaxPerPage ?? 16,
      maxPixels: config.renderMaxPixels ?? 40_000_000,
    });
    // A page that fits in a single tile is not actually tiled — leave it to the
    // ordinary figure path so we do not emit a redundant whole-page "tile".
    if (grid.singleTile) return [];

    logger.debug(
      { jobId: job.id, page, cols: grid.cols, rows: grid.rows, dpi: grid.dpi },
      "Tiling large-format page into an overlapping grid (S6)",
    );

    // Hold at most one model-resolution page render, reused as the crop source
    // for every tile and discarded when the page finishes.
    let tilePage: PageImage | null = null;
    const contributions: TileContribution[] = [];
    const tileRefs: TileRef[] = [];
    const assetIds: string[] = [];
    const pageWarnings: string[] = [];

    for (const tile of grid.tiles) {
      const localId = tileLocalId(`p${page}-${tile.tileId}`);
      const assetId = buildAssetId(job.reference, localId);
      const tileKey: StageKey = {
        job_id: job.id,
        page,
        tile_id: tile.tileId,
        stage: TILED_STAGE,
      };
      // Pin the tile's inputs: source, page, tile bbox, grid DPI, model and the
      // drawing prompt kind. A resume with the same stand reuses the checkpoint;
      // a different page size (a re-render) recomputes.
      // The run's pipeline/prompt stand is folded in by stageHash (§9b.2).
      const inputHash = stageHash([
        "tiled",
        job.source_sha256,
        page,
        tile.tileId,
        grid.dpi,
        config.visionModel,
        "technical_drawing",
        tile.bbox.join(","),
      ]);

      type TileParsed = { transcription: Transcription; warnings: string[] };

      // ── dedup: a duplicate page has the identical grid;
      //    copy the source page's finished transcription of the same tile.
      const sourceCopy =
        visionParsed.dedupOf !== undefined
          ? await dedupSourceResult<TileParsed>("tile", {
              job_id: job.id,
              page: visionParsed.dedupOf,
              tile_id: tile.tileId,
              stage: TILED_STAGE,
            })
          : null;

      const result = await stageRunner.runStage<TileParsed | undefined, string>({
        unit: "tile",
        key: tileKey,
        inputHash,
        ...(sourceCopy !== null
          ? {}
          : { budget: { ledger: budget, estimatedTokens: config.visionTokenEstimate, ...pricingOf(config.visionPricing) } }),
        fn: async () => {
          if (sourceCopy !== null) return { raw: sourceCopy.raw, parsed: sourceCopy.parsed, tokensUsed: 0 };
          if (tilePage === null) {
            const rendered = await prepared.render(page);
            tilePage = rendered.image;
          }
          const crop = await prepared
            .renderFigureCrop(page, tile.bbox as unknown as BoundingBox, tilePage)
            .catch(() => null);
          if (crop === null) {
            throw new PermanentStageError(
              `tile crop failed on page ${page} tile ${tile.tileId}`,
              `Eine Kachel konnte für die Transkription nicht ausgeschnitten werden.`,
            );
          }
          // Transcribe the tile as a technical drawing; the region text is not
          // available per-tile (S4 runs per figure, not per tile), so the model
          // works from the crop alone, which is the plan-prompt case in §5 S6.
          const response = await vision.analyzeFigure({
            page,
            figureId: `${page}:${tile.tileId}`,
            kind: "technical_drawing",
            regionText: "",
            image: { buffer: crop.buffer, mimeType: crop.mimeType },
          });
          const parsed = parseTranscription("technical_drawing", response.raw);
          if (parsed === null) {
            throw new PermanentStageError(
              "no tile transcription parser",
              "Für die Kachel-Transkription gibt es keinen Parser.",
            );
          }
          return {
            raw: response.raw,
            parsed: { transcription: parsed.transcription, warnings: parsed.warnings },
            tokensUsed: response.usage.totalTokens,
          };
        },
      });

      // Every tile is an addressable `tile` asset regardless of whether its
      // transcription succeeded — the bytes reproduce on demand from the source
      // and the asset is what the research zoom serves from.
      await lease_guardStageTileAsset(job, page, assetId);
      assetIds.push(assetId);
      tileRefs.push({ tileId: `p${page}-${tile.tileId}`, assetId, bbox: tile.bbox });
      events.publish({ type: "asset", jobId: job.id, page, assetId, kind: "tile" });

      if (result.parsed !== undefined) {
        contributions.push({ tileId: tile.tileId, transcription: result.parsed.transcription });
        for (const warning of result.parsed.warnings) {
          if (!pageWarnings.includes(warning)) pageWarnings.push(warning);
        }
      } else {
        contributions.push({ tileId: tile.tileId, transcription: undefined });
      }
    }

    // Merge the per-tile transcriptions, deduplicating the overlap band, and
    // attach the result plus the tile refs to the page for `buildPageRecord`.
    const transcription = mergeTileTranscriptions(contributions);
    visionParsed.tiled = { transcription, tiles: tileRefs };
    if (pageWarnings.length > 0) {
      visionParsed.warnings = [...visionParsed.warnings, ...pageWarnings];
    }
    return assetIds;
  }

  /** Cut and stage each croppable figure; return the asset ids in figure order. */
  async function stageCrops(args: {
    job: JobRow;
    page: number;
    prepared: PreparedSource;
    pageImage: PageImage | null;
    figures: VisionStageParsed["figures"];
  }): Promise<string[]> {
    const { job, page, prepared, pageImage, figures } = args;
    const ids: string[] = [];
    for (const figure of figures) {
      const assetId = buildAssetId(job.reference, figureLocalId(figure.id));
      let crop: FigureCrop | null = null;
      if (pageImage !== null) {
        // Prefer the S4-snapped bbox so the crop reflects the refined
        // region; fall back to the raw Pass-1 bbox, then the full page.
        const snapped = isCroppable(figure.snappedBbox) ? figure.snappedBbox : undefined;
        const bbox = snapped ?? (isCroppable(figure.bbox) ? figure.bbox : ([0, 0, 1, 1] as BoundingBox));
        crop = await prepared.renderFigureCrop(page, bbox, pageImage).catch(() => null);
      }
      await lease_guardStageAsset(
        job,
        page,
        assetId,
        "figure",
        crop !== null ? sha256Hex(crop.buffer) : undefined,
      );
      ids.push(assetId);
      events.publish({ type: "asset", jobId: job.id, page, assetId, kind: "figure" });
    }
    return ids;
  }

  /**
   * Stage an asset-outbox row (idempotent), fenced on the lease in SQL: a
   * zombie worker cannot stage assets into a job it no longer owns. The owning
   * page is recorded so the emitter resolves the asset without a payload scan.
   */
  async function lease_guardStageAsset(
    job: JobRow,
    page: number,
    assetId: string,
    kind: "figure" | "page",
    checksum?: string,
  ): Promise<void> {
    await store.stageAsset(
      {
        job_id: job.id,
        asset_id: assetId,
        page,
        ...(checksum !== undefined ? { checksum } : {}),
        variant: kind === "page" ? "page" : null,
        mime_type: "image/png",
      },
      scope().fence,
    );
  }

  /**
   * Stage a `tile` asset-outbox row (idempotent), fenced on the lease. A tile
   * carries no checksum here — its bytes reproduce deterministically from the
   * content-addressed source on demand (the {@link AssetLoader} re-renders the
   * tile bbox), exactly like a figure crop, so nothing is stored eagerly.
   */
  async function lease_guardStageTileAsset(
    job: JobRow,
    page: number,
    assetId: string,
  ): Promise<void> {
    await store.stageAsset(
      {
        job_id: job.id,
        asset_id: assetId,
        page,
        variant: null,
        mime_type: "image/png",
      },
      scope().fence,
    );
  }

  /**
   * Stage the page's emit-outbox row (fenced; one page per row, the emitter
   * batches). The payload records the pipeline/prompt stand the page's Pass-1
   * result came from: under `resume_policy=continue` a
   * document mixes stands, and this is where each page's stand is auditable.
   * The staged record is the page's BASE record; the document pass enriches it.
   */
  async function stageEmitRow(job: JobRow, page: number, record: PageRecord): Promise<void> {
    const current = scope();
    const visionRow = await store.getStage("page", { job_id: job.id, page, stage: VISION1_STAGE });
    const recorded = isStageOutput(visionRow?.output) ? (visionRow.output as StageOutput).stand : undefined;
    const stand = recorded ?? current.stand;
    const payload = { type: "page", page, record, stand };
    await store.stageEmitBatch(
      {
        job_id: job.id,
        seq: page,
        digest: sha256Hex(JSON.stringify(payload)),
        page_from: page,
        page_to: page,
        payload,
      },
      current.fence,
    );
  }

  return { run };
}

// ── mapping helpers ──────────────────────────────────────────────────────

const TRUNCATION_WARNING =
  "Die Modellantwort war auch beim größten Token-Budget abgeschnitten; der Seiteninhalt ist unvollständig.";

/** Recorded on a page whose text came from the Tesseract fallback. */
const OCR_FALLBACK_WARNING =
  "Das Vision-Modell war nicht erreichbar; der Text dieser Seite wurde stattdessen mit Tesseract-OCR erkannt und ist möglicherweise unvollständig.";

/** The parsed result of a checkpoint row, or undefined when it has none. */
function parsedOfRow<T>(row: PageStageRow): T | undefined {
  const output = row.output;
  if (isStageOutput(output)) return (output.parsed ?? undefined) as T | undefined;
  return undefined;
}

/**
 * True when a checkpoint carries a raw model response a reparse can re-read:
 * a finished unit, or one that failed permanently after the model answered. A
 * unit in a transient backoff is left for its retry.
 */
function reparseable(row: PageStageRow): boolean {
  if (!isStageOutput(row.output) || typeof row.output.raw !== "string") return false;
  return row.status === "done" || (row.status === "failed" && row.next_attempt_at === null);
}

/** A human-readable message from any thrown value. */
function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The ordinal `n` of a page-scoped figure id `p<page>-f<n>` (1 when unparsable). */
function figureOrdinalOf(figureId: string): number {
  const match = /-f(\d+)$/.exec(figureId);
  const n = match?.[1] !== undefined ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** A figure has a usable, positive-area bbox. */
function isCroppable(bbox: BoundingBox | undefined): bbox is BoundingBox {
  return bbox !== undefined && isValidBoundingBox(bbox);
}

/** The normalised area (0–1) of a bbox `[x1,y1,x2,y2]`. */
function bboxArea(bbox: BoundingBox): number {
  return Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
}

/**
 * Decide whether a figure gets Pass 2. A figure
 * runs Pass 2 only when its kind is in `FIGURE_PASS2_KINDS`, it has a usable
 * bbox, and that bbox covers at least `minArea` of the page. The Pass-2 crop
 * uses the S4-snapped bbox when present, falling back to the raw
 * Pass-1 bbox. Returns the bbox to crop when Pass 2 should run.
 */
function pass2Gate(
  figure: VisionStageParsed["figures"][number],
  kinds: ReadonlySet<string>,
  minArea: number,
): { run: false } | { run: true; bbox: BoundingBox } {
  const kind = figure.kind ?? "other";
  if (!kinds.has(kind)) return { run: false };
  const bbox = isCroppable(figure.snappedBbox)
    ? figure.snappedBbox
    : isCroppable(figure.bbox)
      ? figure.bbox
      : undefined;
  if (bbox === undefined) return { run: false };
  if (bboxArea(bbox) < minArea) return { run: false };
  return { run: true, bbox };
}

/** Convert a v1 (readonly) bbox to the v2 record's mutable tuple. */
function toBBox(bbox: BoundingBox): BBox {
  return [bbox[0], bbox[1], bbox[2], bbox[3]];
}

/** The page-image asset id for a page. */
function pageAssetId(reference: string, page: number): string {
  return buildAssetId(reference, pageLocalId(page));
}

/**
 * S4 deterministic refinement of the Pass-1 figures. For each figure with a
 * usable bbox, snap the box to the ink and the adjacent text blocks and
 * collect the text-layer words inside it as `regionText`/`labels`; a figure
 * without a box is passed through untouched.
 *
 * This is deliberately folded onto the `vision1` checkpoint rather than being a
 * separate `refined` stage. S4 is deterministic and its only inputs are the
 * rendered page image and this page's S2 analysis — both already in hand inside
 * the vision stage — so computing it here and persisting the result on the
 * checkpoint means a resume (or a render-hash reuse) replays the snapped bbox
 * and region text with no recompute, which a separate stage would only
 * duplicate. The concurrent scheduler drives whole pages, not per-stage fan-out
 * within a page, so a distinct S4 stage would add a checkpoint round-trip
 * without changing resume behaviour. `snapFigureBBox` never throws, so a page
 * is never failed over refinement.
 *
 * Returns the figures in input order with `snappedBbox`/`regionText`/`labels`
 * filled in where available.
 */
async function refineFigures(
  figures: ParsedVisionPage["figures"],
  image: PageImage,
  analysis: PageAnalysis | null,
): Promise<VisionStageParsed["figures"]> {
  const refined: VisionStageParsed["figures"] = [];
  for (const f of figures) {
    const base = { id: f.id, description: f.description, kind: f.kind, caption: f.caption, bbox: f.bbox };
    if (!isCroppable(f.bbox)) {
      refined.push(base);
      continue;
    }
    const result = await snapFigureBBox(toBBox(f.bbox), {
      image: { buffer: image.buffer, width: image.width, height: image.height },
      analysis,
    });
    refined.push({
      ...base,
      snappedBbox: result.bbox as unknown as BoundingBox,
      ...(result.regionText !== undefined ? { regionText: result.regionText } : {}),
      ...(result.labels !== undefined ? { labels: result.labels } : {}),
    });
  }
  return refined;
}

/**
 * Build a contract-valid v2 page record from the parsed vision output.
 *
 * The Pass-1 body Markdown is mapped to typed blocks by the deterministic
 * {@link parseMarkdownBlocks} (headings with numbering, paragraphs, lists,
 * tables with cells and continuation flags, code); each figure block is placed
 * at its `![figure_<id>]` position in the reading order, and figures the body
 * never referenced follow at the end. A fast-path page emits its S2 blocks
 * verbatim. Because the mapping is a pure function of the persisted
 * checkpoint, a resume or a `reparse` rebuilds the identical record.
 */
function buildPageRecord(
  reference: string,
  page: number,
  parsed: VisionStageParsed,
): PageRecord {
  const blocks: Block[] = [];
  const warnings = [...parsed.warnings];
  const assets: AssetRef[] = [];

  // ── figure blocks, keyed by figure id for placement in the flow ──────────
  const figureBlocks = new Map<string, Block>();
  const figureOrder: string[] = [];
  let figureOrdinal = 0;
  for (const figure of parsed.figures) {
    figureOrdinal += 1;
    const assetId = buildAssetId(reference, figureLocalId(figure.id));
    // Prefer the S4-snapped bbox for the emitted block and asset so
    // consumers see the refined region; fall back to the raw Pass-1 bbox, then
    // the full page.
    const resolvedBbox = isCroppable(figure.snappedBbox)
      ? figure.snappedBbox
      : isCroppable(figure.bbox)
        ? figure.bbox
        : ([0, 0, 1, 1] as BoundingBox);
    const bbox = toBBox(resolvedBbox);
    figureOrder.push(figure.id);
    figureBlocks.set(figure.id, {
      id: `p${page}-fb${figureOrdinal}`,
      page,
      type: "figure",
      figureId: figure.id,
      // The model-supplied kind; falls back to "other" for a
      // checkpoint written before this field existed.
      kind: figure.kind ?? "other",
      ...(figure.caption !== undefined ? { caption: figure.caption } : {}),
      description: figure.description,
      // The verbatim text-layer words inside the snapped bbox and their
      // deduplicated labels. Absent for a scan or a
      // container without `-bbox-layout` geometry.
      ...(figure.regionText !== undefined ? { regionText: figure.regionText } : {}),
      ...(figure.labels !== undefined && figure.labels.length > 0 ? { labels: figure.labels } : {}),
      // The structured Pass-2 transcription (task 2.5, S5). Present only for a
      // gated kind that ran Pass 2; `renderMarkdown` renders it per format.
      ...(figure.transcription !== undefined ? { transcription: figure.transcription } : {}),
      bbox,
      assetId,
    });
    assets.push({ assetId, kind: "figure", localId: figureLocalId(figure.id), page, bbox });
  }

  // ── body blocks in reading order ─────────────────────────────────────────
  if (parsed.fastPath === true && parsed.fastPathBlocks !== undefined) {
    // A fast-path page carries its blocks (heading/paragraph/list, all
    // source:"text-layer") built from the S2 geometry; no vision markdown.
    blocks.push(...parsed.fastPathBlocks);
  } else if (parsed.markdown.trim() !== "") {
    const body = parseMarkdownBlocks(parsed.markdown, {
      page,
      source: parsed.usedOcr ? "vision" : "text-layer",
    });
    for (const item of body.items) {
      if (item.kind === "block") {
        blocks.push(item.block);
        continue;
      }
      // A figure placeholder: the figure block goes exactly here.
      const figureBlock = figureBlocks.get(item.figureId);
      if (figureBlock !== undefined) {
        blocks.push(figureBlock);
        figureBlocks.delete(item.figureId);
      }
    }
    warnings.push(...body.warnings);
  }
  // Figures the body did not reference follow the text, in figure order.
  for (const id of figureOrder) {
    const figureBlock = figureBlocks.get(id);
    if (figureBlock !== undefined) blocks.push(figureBlock);
  }

  // ── tiling (S6): a page-spanning drawing figure with its tiles ───────────
  // A large-format page that was tiled emits one `technical_drawing` figure
  // covering the whole page. It carries the merged, overlap-deduplicated
  // transcription and the `tiles[]` refs; each tile is a `tile` asset
  // addressable by its own bbox for the research zoom. The tile bytes are not
  // stored — they reproduce on demand from the content-addressed source,
  // exactly like a figure crop.
  if (parsed.tiled !== undefined && parsed.tiled.tiles.length > 0) {
    figureOrdinal += 1;
    const wholePage = toBBox([0, 0, 1, 1] as BoundingBox);
    const figureId = `p${page}-tiled`;
    const figureAssetId = buildAssetId(reference, figureLocalId(figureId));
    blocks.push({
      id: `p${page}-fb${figureOrdinal}`,
      page,
      type: "figure",
      figureId,
      kind: "technical_drawing",
      description:
        "Großformatige Seite, in überlappende Kacheln zerlegt und zusammengeführt (S6).",
      transcription: parsed.tiled.transcription,
      tiles: parsed.tiled.tiles,
      bbox: wholePage,
      assetId: figureAssetId,
    });
    // The whole-page figure crop asset (the plan as one image).
    assets.push({
      assetId: figureAssetId,
      kind: "figure",
      localId: figureLocalId(figureId),
      page,
      bbox: wholePage,
    });
    // Each tile as its own addressable `tile` asset with its region bbox.
    for (const tile of parsed.tiled.tiles) {
      assets.push({
        assetId: tile.assetId,
        kind: "tile",
        localId: tileLocalId(tile.tileId),
        page,
        bbox: tile.bbox,
      });
    }
  }

  // The page image itself is always an addressable asset.
  assets.push({
    assetId: buildAssetId(reference, pageLocalId(page)),
    kind: "page",
    localId: pageLocalId(page),
    page,
  });

  return {
    type: "page",
    page,
    size: { wPt: parsed.size.wPt, hPt: parsed.size.hPt },
    // The deterministic page class. Falls back to
    // the v1 heuristic for a checkpoint written before this field existed.
    class: parsed.pageClass ?? (parsed.usedOcr ? "scan" : "text"),
    ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
    blocks,
    assets,
    warnings,
    // `fastPath` records that the page took the deterministic text fast-path
    // a consumer and the eval harness read it as the per-page
    // fast-path signal alongside the /metrics counter.
    fidelity: { ocr: parsed.usedOcr, ...(parsed.fastPath === true ? { fastPath: true } : {}) },
  };
}

/** A minimal valid page record, for the budget-pause path. */
function emptyRecord(page: number): PageRecord {
  return {
    type: "page",
    page,
    size: { wPt: 1, hPt: 1 },
    class: "text",
    blocks: [],
    assets: [],
    warnings: [],
  };
}

/** The source filename, from the config snapshot when present, else the reference. */
function filenameOf(job: JobRow): string {
  const source = (job.config as { source?: { filename?: unknown } }).source;
  if (source !== undefined && typeof source.filename === "string" && source.filename !== "") {
    return source.filename;
  }
  return job.reference;
}

export type { PageRenderer } from "./page-renderer.js";
export type { ParsedVisionPage };
