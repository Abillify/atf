// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Configuration, dependencies and metrics contract of the v2 job runner. Split out of
 * `job-runner.ts` unchanged; that module re-exports the public types.
 */

import type { Logger } from "pino";
import type {
  IdentifyRequest,
  IdentifyResponse,
} from "@atf/extract-contract/v2";
import type { SourceStore } from "../source-store.js";
import type { OcrClient } from "../pipeline/ocr.js";
import type { ExtractStore } from "../persistence/index.js";
import type { VisionClient } from "../vision/client.js";
import type { JobEventBus } from "./events.js";
import type {
  ModelPricing,
} from "./stage-runner.js";
import type { StageObservation } from "../http-metrics.js";
import type { PageAnalyzer } from "./page-analyzer.js";
import type { FigureKind } from "@atf/extract-contract/v2";
import type { PageRenderer } from "./page-renderer.js";
import type { Emitter } from "./emitter.js";
import type { SummaryClient } from "../summary/client.js";

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
