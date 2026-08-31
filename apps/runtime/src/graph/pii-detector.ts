// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Extensible PII detector pipeline (`src/graph/pii-detector.ts`)
 *
 * Defines the {@link PiiDetector} interface, a {@link PiiDetectorRegistry}
 * that runs multiple detectors (regex, BERT-NER, remote REST) concurrently and
 * merges their spans with priority-based overlap resolution, and a
 * {@link PiiDetectorResolver} abstraction that selects the registry to use for
 * a given flow (enabling real per-flow detector selection — ADR-0015).
 *
 * Design principles (see ADR-0015):
 *   - Detectors are **composable, not exclusive** — regex stays the fast
 *     deterministic baseline; NER/remote add recall for unstructured PII.
 *   - Detection is **async** (NER inference, HTTP round-trip) and runs on
 *     full-text paths (vault ingress, non-streaming output). The streaming
 *     output guardrail remains sync/regex-only for latency reasons.
 *   - Each match carries a `detector` provenance tag for audit/compliance.
 *   - Overlap resolution: when spans from different detectors overlap, the
 *     detector with the **lower priority number** (= higher trust) wins.
 *   - **Fail mode is explicit.** A detector signals failure by THROWING (not by
 *     returning an empty array — that means "ran, found nothing"). The registry
 *     catches per-detector failures and applies the configured fail mode:
 *       - "open":   skip the failed detector, proceed with the rest.
 *       - "closed": re-throw as {@link PiiDetectionError} so the caller can
 *                   refuse to proceed (a PII vault must NOT leak un-tokenized
 *                   text to the provider when detection could not be trusted).
 *
 * No `any` at module boundaries.
 */

import type { PiiType, PiiMatch } from "./output-guardrails.js";
import { ALL_PII_TYPES } from "./output-guardrails.js";

// ---------------------------------------------------------------------------
// PiiDetector interface
// ---------------------------------------------------------------------------

/**
 * A single PII detection backend. Implementations:
 *   - {@link "./pii-detector-regex.js"} (regex + check-digit, always available)
 *   - {@link "./pii-detector-ner.js"} (in-process ONNX BERT-NER, optional)
 *   - {@link "./pii-detector-remote.js"} (external REST service, optional)
 */
export interface PiiDetector {
  /** Unique name for provenance tagging (e.g. "regex", "ner:de", "remote:presidio"). */
  readonly name: string;
  /**
   * Priority for overlap resolution — lower number = higher trust. When spans
   * from two detectors overlap, the one with the lower priority wins.
   * Convention: regex=10, ner=20, remote=30.
   */
  readonly priority: number;
  /**
   * Detects PII spans in `text`. May be async (NER inference, HTTP).
   *
   * Contract: a detector that **could not produce authoritative results**
   * (model load failure, inference error, HTTP error, open circuit) MUST
   * throw. Returning an empty array means "ran successfully, found no PII".
   * The {@link PiiDetectorRegistry} distinguishes the two: a throw participates
   * in the fail-mode decision, an empty array does not.
   *
   * @param text     The full text to scan.
   * @param types    Optional subset of PII types to detect. When empty/undefined,
   *                 the detector should use its full capability.
   */
  detect(text: string, types?: readonly PiiType[]): Promise<PiiMatch[]>;
}

// ---------------------------------------------------------------------------
// Extended PiiMatch with provenance
// ---------------------------------------------------------------------------

/** A PII match enriched with detector provenance for audit trails. */
export interface PiiMatchWithProvenance extends PiiMatch {
  /** Which detector produced this match. */
  detector: string;
}

/**
 * Thrown by {@link PiiDetectorRegistry.detect} when at least one detector
 * failed and the registry is configured with `failMode: "closed"`. Callers
 * (e.g. the PII vault) must treat this as "detection could not be trusted"
 * and refuse to proceed rather than passing un-tokenized text onward.
 */
export class PiiDetectionError extends Error {
  constructor(
    message: string,
    readonly failedDetectors: readonly string[],
  ) {
    super(message);
    this.name = "PiiDetectionError";
  }
}

// ---------------------------------------------------------------------------
// Overlap resolution (merge logic)
// ---------------------------------------------------------------------------

/**
 * Merges spans from multiple detectors, resolving overlaps by priority.
 * When two spans overlap, the one from the detector with the lower priority
 * number (= higher trust) wins; the other is discarded. Non-overlapping spans
 * from all detectors are kept. Output is sorted by `start` ascending.
 */
export function mergeDetectorMatches(
  groups: ReadonlyArray<{
    detector: string;
    priority: number;
    matches: readonly PiiMatch[];
  }>,
): PiiMatchWithProvenance[] {
  // Flatten and tag with priority + detector name.
  const all: Array<PiiMatchWithProvenance & { _priority: number }> = [];
  for (const g of groups) {
    for (const m of g.matches) {
      all.push({ ...m, detector: g.detector, _priority: g.priority });
    }
  }

  // Sort by priority (lower = higher trust), then by start position.
  all.sort((a, b) => a._priority - b._priority || a.start - b.start);

  // Greedily accept spans — skip any that overlap an already-accepted span.
  const accepted: PiiMatchWithProvenance[] = [];
  const occupied: Array<[number, number]> = [];

  for (const span of all) {
    const overlaps = occupied.some(
      ([os, oe]) => span.start < oe && span.end > os,
    );
    if (overlaps) continue;
    const { _priority, ...clean } = span;
    void _priority;
    accepted.push(clean);
    occupied.push([span.start, span.end]);
  }

  // Final sort by position for consistent output.
  accepted.sort((a, b) => a.start - b.start);
  return accepted;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Fail behaviour when a non-regex detector errors. */
export type DetectorFailMode = "open" | "closed";

export interface PiiDetectorRegistryConfig {
  /**
   * What to do when a detector throws or times out:
   *   - "open":   skip its results, proceed with remaining detectors (default).
   *   - "closed": throw {@link PiiDetectionError} so the caller refuses to
   *               proceed with untrusted detection.
   */
  failMode?: DetectorFailMode;
  /** Per-detector timeout in ms. Default: 5000. */
  timeoutMs?: number;
}

/**
 * Orchestrates multiple {@link PiiDetector}s, runs them concurrently, merges
 * their results with overlap resolution, and returns a unified match list.
 */
export class PiiDetectorRegistry {
  private readonly detectors: PiiDetector[] = [];
  private readonly failMode: DetectorFailMode;
  private readonly timeoutMs: number;

  constructor(config?: PiiDetectorRegistryConfig) {
    this.failMode = config?.failMode ?? "open";
    this.timeoutMs = config?.timeoutMs ?? 5_000;
  }

  /** Registers a detector. Order of registration does not matter (priority governs merge). */
  add(detector: PiiDetector): this {
    this.detectors.push(detector);
    return this;
  }

  /** Returns registered detector names (for diagnostics / status endpoints). */
  listDetectors(): string[] {
    return this.detectors.map((d) => d.name);
  }

  /** Number of registered detectors (0 = a no-op registry that never tokenizes). */
  size(): number {
    return this.detectors.length;
  }

  /**
   * Runs all registered detectors concurrently and merges their spans.
   *
   * @returns the merged match list (possibly empty — meaning no PII found).
   * @throws  {@link PiiDetectionError} when `failMode` is "closed" and at least
   *          one detector failed (threw or timed out). Under "open", failures
   *          are logged-by-detector and simply omitted from the merge.
   */
  async detect(
    text: string,
    types?: readonly PiiType[],
  ): Promise<PiiMatchWithProvenance[]> {
    if (this.detectors.length === 0) return [];

    const results = await Promise.allSettled(
      this.detectors.map((d) => this.runOne(d, text, types)),
    );

    const groups: Array<{
      detector: string;
      priority: number;
      matches: readonly PiiMatch[];
    }> = [];
    const failed: string[] = [];

    for (const [i, detector] of this.detectors.entries()) {
      const result = results[i];
      if (result === undefined) continue; // unreachable: results is a 1:1 map of detectors
      if (result.status === "fulfilled") {
        groups.push({
          detector: detector.name,
          priority: detector.priority,
          matches: result.value,
        });
      } else {
        failed.push(detector.name);
      }
    }

    if (failed.length > 0 && this.failMode === "closed") {
      throw new PiiDetectionError(
        `PII detection failed for detector(s) [${failed.join(", ")}] with failMode=closed`,
        failed,
      );
    }

    return mergeDetectorMatches(groups);
  }

  /** Runs a single detector with a timeout guard (timer is always cleared). */
  private async runOne(
    detector: PiiDetector,
    text: string,
    types?: readonly PiiType[],
  ): Promise<PiiMatch[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`PII detector "${detector.name}" timed out`)),
        this.timeoutMs,
      );
    });
    try {
      return await Promise.race([detector.detect(text, types), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-flow detector resolution (ADR-0015)
// ---------------------------------------------------------------------------

/**
 * Resolves the {@link PiiDetectorRegistry} to use for a given flow. Lets a
 * regulated flow opt into NER/remote detection while an internal flow stays
 * regex-only (or disables tokenization entirely) — declaratively, per flow.
 */
/**
 * The per-flow detection plan: which detectors to run, and (optionally) which
 * PII types to restrict them to for this flow.
 */
export interface PiiDetectionPlan {
  /** The detector registry to run for the flow. */
  registry: PiiDetectorRegistry;
  /**
   * Per-flow PII type subset. `undefined` means "use the vault's global default"
   * (`PII_VAULT_TYPES`, or all types when that too is unset). An explicit list
   * narrows detection to those types for this flow only.
   */
  piiTypes?: readonly PiiType[];
}

export interface PiiDetectorResolver {
  /**
   * Returns the detection plan for `flowId`, or `undefined` when the flow has
   * no detector configuration at all (the caller then falls back to its legacy
   * default — the vault's sync regex-only path). A plan whose registry has zero
   * detectors (`.size() === 0`) is returned when the flow explicitly disables
   * detection (`detectors: []`), which means "tokenize nothing".
   */
  resolve(flowId: string): PiiDetectionPlan | undefined;
}

/** Builds a {@link PiiDetectorRegistry} from a list of detector names. */
export type PiiDetectorFactory = (
  names: readonly string[],
) => PiiDetectorRegistry;

export interface FlowPiiDetectorResolverConfig {
  /** Builds a registry from detector names (regex/ner/remote). */
  factory: PiiDetectorFactory;
  /** Global default detector names (from PII_DETECTORS). Undefined = no global default. */
  globalNames?: readonly string[];
  /**
   * Per-flow detector-name lookup — typically
   * `(flowId) => guardrailPolicy.resolve(flowId)?.detectors`. Returns the
   * flow's explicit `detectors` list, or undefined to inherit the global.
   */
  flowLookup: (flowId: string) => readonly string[] | undefined;
  /**
   * Per-flow PII-type-subset lookup — typically
   * `(flowId) => guardrailPolicy.resolve(flowId)?.piiTypes`. Returns the flow's
   * explicit vault `piiTypes` list, or undefined to inherit the vault global.
   * Unknown type names are dropped.
   */
  flowTypesLookup?: (flowId: string) => readonly string[] | undefined;
  /**
   * Monotonic generation counter (e.g. `guardrailPolicy.generation`) — bumped
   * on policy hot-reload so the resolver's registry cache invalidates.
   */
  generation?: () => number;
}

const KNOWN_PII_TYPES = new Set<string>(ALL_PII_TYPES);

/**
 * Default {@link PiiDetectorResolver}: combines a global default detector set
 * with per-flow overrides from a lookup (backed by the guardrails policy's
 * `detectors` + `piiTypes` fields). Built registries are memoised per effective
 * detector-set and invalidated when the policy generation changes.
 *
 * Resolution for a flow:
 *   1. per-flow `detectors` present → use it (even `[]`, which disables).
 *   2. else global default present → use it.
 *   3. else → `undefined` (caller uses its legacy regex-only fallback).
 *
 * The plan's `piiTypes` is the per-flow type subset when configured, else
 * `undefined` (the vault then applies its global `PII_VAULT_TYPES`).
 */
export class FlowPiiDetectorResolver implements PiiDetectorResolver {
  private readonly factory: PiiDetectorFactory;
  private readonly globalNames?: readonly string[];
  private readonly flowLookup: (flowId: string) => readonly string[] | undefined;
  private readonly flowTypesLookup?: (
    flowId: string,
  ) => readonly string[] | undefined;
  private readonly generation?: () => number;

  private cache = new Map<string, PiiDetectorRegistry>();
  private cachedGen = -1;

  constructor(config: FlowPiiDetectorResolverConfig) {
    this.factory = config.factory;
    this.globalNames = config.globalNames;
    this.flowLookup = config.flowLookup;
    this.flowTypesLookup = config.flowTypesLookup;
    this.generation = config.generation;
  }

  resolve(flowId: string): PiiDetectionPlan | undefined {
    // Invalidate the cache when the underlying policy generation advances.
    if (this.generation !== undefined) {
      const gen = this.generation();
      if (gen !== this.cachedGen) {
        this.cache.clear();
        this.cachedGen = gen;
      }
    }

    const perFlow = this.flowLookup(flowId);
    const names = perFlow !== undefined ? perFlow : this.globalNames;

    // No configuration anywhere → let the caller use its legacy default.
    if (names === undefined) return undefined;

    // Cache by the effective (sorted) detector-set so two flows with the same
    // set share one registry instance.
    const key = [...names].sort().join(",");
    let registry = this.cache.get(key);
    if (registry === undefined) {
      registry = this.factory(names);
      this.cache.set(key, registry);
    }

    const piiTypes = this.resolveTypes(flowId);
    return piiTypes !== undefined ? { registry, piiTypes } : { registry };
  }

  /** Resolves + validates the per-flow PII type subset, dropping unknown names. */
  private resolveTypes(flowId: string): readonly PiiType[] | undefined {
    const raw = this.flowTypesLookup?.(flowId);
    if (raw === undefined) return undefined;
    const valid = raw.filter((t): t is PiiType => KNOWN_PII_TYPES.has(t));
    // An explicit (even empty) list is an intentional override — keep it so the
    // vault does not fall back to its global default.
    return valid;
  }
}
