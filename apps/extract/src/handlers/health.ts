// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * health.ts
 *
 * `GET /health` — liveness plus the dependency state that actually predicts
 * whether a conversion will work.
 *
 * ## Why this checks the converter binaries
 *
 * A container missing `poppler-utils` starts perfectly, serves `/health`
 * perfectly, and fails every conversion. That failure surfaces as a 500 on the
 * first real upload, which in a rollout means the deployment is already live. So
 * the probes run here: a missing binary makes the container unhealthy at startup,
 * which is the difference between a failed rollout and a broken service.
 *
 * ## Why the results are cached
 *
 * Each converter probe spawns a process. An orchestrator polling every five
 * seconds would spawn `pdfinfo` and LibreOffice on that schedule forever, and
 * LibreOffice takes seconds to start. Probe outcomes are therefore cached, with a
 * short TTL for network dependencies (they recover) and a long one for binaries
 * (a binary does not appear at runtime).
 *
 * ## What counts as unhealthy
 *
 * Only what makes the service unable to do its job: the converter binaries and
 * the vision endpoint. Search being unreachable degrades `/v1/ingest` but leaves
 * `/v1/convert` fully functional, so it is reported and not fatal — taking the
 * container out of rotation because a *downstream* service is down turns one
 * outage into two.
 */

import type { RequestHandler } from "express";
import type { Logger } from "pino";
import { EXTRACT_CONTRACT_ID } from "@atf/extract-contract/v1";
import { probe as probeBinary } from "../pipeline/exec.js";
import { probeBboxLayout, type PopplerTools } from "../pipeline/pdf.js";
import type { WorkQueue } from "../queue.js";
import type { VisionClient } from "../vision/client.js";
import type { SearchClient } from "../search-client.js";
import { formatByMimeType, supportedMimeTypes } from "../formats.js";

/** Binaries do not appear at runtime; a failed probe stays true for a while. */
const BINARY_TTL_MS = 300_000;
/** Network dependencies recover, so their state must not be stale for long. */
const NETWORK_TTL_MS = 15_000;

interface DependencyState {
  available: boolean;
  version?: string;
  error?: string;
}

interface CachedProbe {
  state: DependencyState;
  checkedAt: number;
}

/** Signature of the converter-binary probe, so tests can substitute it. */
export type HealthProbe = (
  command: string,
  args: readonly string[],
  home: string,
) => Promise<DependencyState>;

function binaryPathFor(
  config: { popplerBinDir: string | null },
  name: string,
): string {
  return config.popplerBinDir === null
    ? name
    : `${config.popplerBinDir}/${name}`;
}

export interface HealthHandlerDeps {
  queue: WorkQueue;
  vision: VisionClient;
  searchClient: SearchClient | null;
  logger: Logger;
  /** `AUTHN_MODE=disabled`: `/health` says so (`auth: "disabled"`). */
  authDisabled?: boolean;
  config: {
    libreofficeBin: string;
    popplerBinDir: string | null;
    tempDir: string;
    visionModel: string;
    renderDpi: number;
    figureDpi: number;
    maxPages: number;
  };
  /** Injectable for tests, which must not spawn processes. */
  probeBinary?: HealthProbe;
  /**
   * The `pdftotext -bbox-layout` capability probe, injectable
   * so tests need not spawn poppler. Defaults to the real probe.
   */
  probeBboxLayout?: (tools: PopplerTools) => Promise<{
    supported: boolean;
    version: string | null;
    reason?: string;
  }>;
}

/**
 * TTL-keyed probe cache, shared by the composite `/health` handler and the
 * `/health/ready` probe so each handler re-probes on its own schedule without
 * an orchestrator's poll spawning `pdfinfo` or LibreOffice every few seconds.
 */
function createProbeCache() {
  const cache = new Map<string, CachedProbe>();
  return async function cached(
    key: string,
    ttlMs: number,
    probe: () => Promise<DependencyState>,
    force: boolean,
  ): Promise<DependencyState> {
    const hit = cache.get(key);
    if (!force && hit !== undefined && Date.now() - hit.checkedAt < ttlMs)
      return hit.state;
    const state = await probe();
    cache.set(key, { state, checkedAt: Date.now() });
    return state;
  };
}

export function createHealthHandler(deps: HealthHandlerDeps): RequestHandler {
  const { queue, vision, searchClient, config, logger } = deps;
  const runBinaryProbe = deps.probeBinary ?? probeBinary;
  const runBboxLayoutProbe = deps.probeBboxLayout ?? probeBboxLayout;
  const cached = createProbeCache();
  // The `-bbox-layout` capability is a property of the binary, so it is cached
  // for the life of the process rather than re-probed per request.
  let bboxLayoutCap: {
    supported: boolean;
    version: string | null;
    reason?: string;
  } | null = null;

  function binaryPath(name: string): string {
    return binaryPathFor(config, name);
  }

  return (req, res) => {
    void (async () => {
      // `?deep=1` forces a re-probe, for an operator debugging a container rather
      // than for the orchestrator's poll.
      const force = req.query["deep"] === "1" || req.query["deep"] === "true";

      const [
        pdfinfo,
        pdftotext,
        pdftoppm,
        libreoffice,
        visionState,
        searchState,
      ] = await Promise.all([
        cached(
          "pdfinfo",
          BINARY_TTL_MS,
          () => runBinaryProbe(binaryPath("pdfinfo"), ["-v"], config.tempDir),
          force,
        ),
        cached(
          "pdftotext",
          BINARY_TTL_MS,
          () => runBinaryProbe(binaryPath("pdftotext"), ["-v"], config.tempDir),
          force,
        ),
        cached(
          "pdftoppm",
          BINARY_TTL_MS,
          () => runBinaryProbe(binaryPath("pdftoppm"), ["-v"], config.tempDir),
          force,
        ),
        cached(
          "libreoffice",
          BINARY_TTL_MS,
          () =>
            runBinaryProbe(
              config.libreofficeBin,
              ["--version"],
              config.tempDir,
            ),
          force,
        ),
        cached("vision", NETWORK_TTL_MS, () => vision.probe(), force),
        searchClient === null
          ? Promise.resolve<DependencyState>({ available: true })
          : cached("search", NETWORK_TTL_MS, () => searchClient.probe(), force),
      ]);

      const poppler = { pdfinfo, pdftotext, pdftoppm };
      const popplerAvailable = Object.values(poppler).every(
        (state) => state.available,
      );

      // The `-bbox-layout` capability the deterministic page analysis (S2)
      // depends on. Probed once and cached for the process,
      // re-probed on `?deep=1`. It is *reported*, never fatal: a v1-only
      // deployment that never runs the analyzed stage does not need it, so a
      // missing capability degrades S2 (page falls through to vision) rather
      // than taking the container out of rotation.
      if (bboxLayoutCap === null || force) {
        const tools: PopplerTools = {
          binDir: config.popplerBinDir,
          home: config.tempDir,
        };
        bboxLayoutCap = await runBboxLayoutProbe(tools).catch((err) => ({
          supported: false,
          version: null,
          reason: err instanceof Error ? err.message : String(err),
        }));
        if (!bboxLayoutCap.supported) {
          logger.warn(
            { reason: bboxLayoutCap.reason, version: bboxLayoutCap.version },
            "pdftotext -bbox-layout unavailable; the deterministic page analysis (S2) will be skipped and pages fall through to vision",
          );
        }
      }

      // LibreOffice is only needed for Word and spreadsheet inputs, so its
      // absence degrades those formats rather than the whole service.
      const degraded: string[] = [];
      if (!libreoffice.available) degraded.push("doc", "docx", "xls", "xlsx");

      const healthy = popplerAvailable && visionState.available;
      if (!healthy) {
        logger.warn(
          { poppler, vision: visionState },
          "Health check failed: a required dependency is unavailable",
        );
      }

      res.status(healthy ? 200 : 503).json({
        status: healthy ? "ok" : "unhealthy",
        ...(deps.authDisabled === true ? { auth: "disabled" } : {}),
        contract: EXTRACT_CONTRACT_ID,
        uptime_seconds: Math.round(process.uptime()),
        queue: queue.state(),
        pipeline: {
          vision_model: config.visionModel,
          render_dpi: config.renderDpi,
          figure_dpi: config.figureDpi,
          max_pages: config.maxPages === 0 ? null : config.maxPages,
        },
        supported_types: supportedMimeTypes().filter((mimeType) => {
          const kind = formatByMimeType(mimeType)?.kind;
          return (
            libreoffice.available || (kind !== "word" && kind !== "spreadsheet")
          );
        }),
        dependencies: {
          poppler,
          // The `-bbox-layout` capability for the deterministic page analysis
          // (S2). Reported for observability; not part of the healthy gate.
          bbox_layout: bboxLayoutCap,
          libreoffice,
          vision: visionState,
          search:
            searchClient === null
              ? {
                  available: true,
                  error: "not configured; /v1/ingest is disabled",
                }
              : searchState,
        },
        ...(degraded.length > 0 ? { degraded_formats: degraded } : {}),
      });
    })().catch((error: unknown) => {
      logger.error({ err: error }, "Health check itself failed");
      res
        .status(503)
        .json({ status: "unhealthy", error: "The health check failed" });
    });
  };
}

/**
 * Liveness probe: is the process alive and able to serve?
 *
 * Checks nothing but the event loop on purpose — restarting a container
 * because the vision model is slow turns a dependency outage into a full
 * outage, and the restart fixes nothing.
 */
export function createLivenessHandler(): RequestHandler {
  return (_req, res) => {
    res.status(200).json({
      status: "ok",
      uptime_seconds: Math.round(process.uptime()),
    });
  };
}

export interface ReadinessHandlerDeps {
  vision: VisionClient;
  logger: Logger;
  config: {
    popplerBinDir: string | null;
    tempDir: string;
  };
  /** Injectable for tests, which must not spawn processes. */
  probeBinary?: HealthProbe;
}

/**
 * Readiness probe: can this replica do its job?
 *
 * The gate mirrors the fatal part of `/health` — the poppler binaries and the
 * vision endpoint — and nothing else: LibreOffice absence degrades only
 * Office formats, and Search is a downstream service whose outage must not
 * remove this container from rotation. Probes are cached on the same TTLs as
 * `/health`, so an orchestrator's poll does not spawn LibreOffice every five
 * seconds.
 */
export function createReadinessHandler(deps: ReadinessHandlerDeps): RequestHandler {
  const { vision, logger } = deps;
  const runBinaryProbe = deps.probeBinary ?? probeBinary;
  const cached = createProbeCache();

  return (req, res) => {
    void (async () => {
      const force = req.query["deep"] === "1" || req.query["deep"] === "true";
      const [pdfinfo, pdftotext, pdftoppm, visionState] = await Promise.all([
        cached(
          "pdfinfo",
          BINARY_TTL_MS,
          () =>
            runBinaryProbe(
              binaryPathFor(deps.config, "pdfinfo"),
              ["-v"],
              deps.config.tempDir,
            ),
          force,
        ),
        cached(
          "pdftotext",
          BINARY_TTL_MS,
          () =>
            runBinaryProbe(
              binaryPathFor(deps.config, "pdftotext"),
              ["-v"],
              deps.config.tempDir,
            ),
          force,
        ),
        cached(
          "pdftoppm",
          BINARY_TTL_MS,
          () =>
            runBinaryProbe(
              binaryPathFor(deps.config, "pdftoppm"),
              ["-v"],
              deps.config.tempDir,
            ),
          force,
        ),
        cached("vision", NETWORK_TTL_MS, () => vision.probe(), force),
      ]);

      const failures: Record<string, string> = {};
      for (const [name, state] of Object.entries({
        pdfinfo,
        pdftotext,
        pdftoppm,
      })) {
        if (!state.available) failures[name] = state.error ?? "unavailable";
      }
      if (!visionState.available) {
        failures.vision = visionState.error ?? "unavailable";
      }

      const ready = Object.keys(failures).length === 0;
      if (!ready) {
        logger.warn(
          { failures },
          "Readiness check failed: a required dependency is unavailable",
        );
      }
      res
        .status(ready ? 200 : 503)
        .json({ status: ready ? "ready" : "unready", checks: failures });
    })().catch((error: unknown) => {
      logger.error({ err: error }, "Readiness check itself failed");
      res.status(503).json({ status: "unready", error: "The probe failed" });
    });
  };
}
