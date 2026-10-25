// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/corpus-migration.ts
 *
 * The PURE core of the corpus re-ingest / migration tool (task 5.6,
 * requirements 17.3, 17.4). No I/O lives here — every function is a
 * deterministic transform so the whole thing is unit-testable offline, with no
 * Extract/Search server in reach. The thin executable that actually uploads
 * sources, drives `/v1/ingest` in `version` mode and polls to a terminal state
 * is `scripts/corpus-migrate.ts`; it imports these functions and adds only the
 * network/filesystem side-effects.
 *
 * What the migration does
 * -----------------------
 * An operator migrating an existing corpus into the v2 pipeline re-ingests each
 * document one at a time, in **`version` mode** so the running system keeps
 * serving the old revision until the new one is fully committed (Search does
 * the atomic `is_latest` switch on commit). Two properties this
 * module owns:
 *
 *   1. **Order by usage (Req 17.3).** {@link orderByUsage} sorts the manifest
 *      so the most-used documents migrate first and become searchable on the
 *      new pipeline soonest. The sort is stable and fully deterministic: usage
 *      descending, ties and unknown-usage entries broken by `reference` so two
 *      runs of the same manifest always produce the same plan.
 *
 *   2. **Prove stable asset ids (Req 17.4).** Asset ids are
 *      `sha256(NFC(reference) + "\n" + NFC(localId))` — derived from the
 *      reference and a local id, never from the image bytes (see
 *      `@atf/extract-contract` `buildAssetId`). So a re-extraction of an
 *      existing corpus MUST produce byte-identical asset ids for the same
 *      reference + local id; the contract doc comment states this explicitly.
 *      {@link expectedAssetIds} recomputes the ids from the reference and the
 *      local ids, and {@link checkAssetIdStability} compares them against the
 *      ids the corpus had *before* migration (carried in the manifest). Any
 *      mismatch is a real regression and is reported per document.
 *
 * IMPORTANT — no fabricated results. Nothing here invents a migration outcome.
 * The pure core only plans the order and does the stability arithmetic; the
 * executable records real per-document outcomes and, in `--dry-run`/`--plan`
 * mode, prints the usage-ordered plan and the expected asset ids WITHOUT
 * contacting a server.
 */

import { buildAssetId, figureLocalId, pageLocalId, tileLocalId, nativeLocalId } from "@atf/extract-contract";

// ─── Manifest schema ─────────────────────────────────────────────────────────

/**
 * One local id an existing asset was addressed under, tagged by kind so the
 * expected asset id is recomputed through the same contract helper the pipeline
 * uses. For `figure`/`page`/`tile`/`native` the `id` is the raw local id
 * component (e.g. `p12-f3`, `37`, `p37-f1-r2c3`, `source`); the helpers add the
 * v2 prefix. A bare `raw` local id (already fully formed, e.g. `page:p37`) is
 * hashed verbatim, which is what a manifest exported straight from Search's
 * asset table carries.
 */
export interface ManifestAsset {
  kind: "figure" | "page" | "tile" | "native" | "raw";
  /** The local-id component (kind-specific) or, for `raw`, the full local id. */
  id: string;
  /**
   * The asset id this local id resolved to BEFORE migration, when known. When
   * present it is the ground truth the recomputed id is checked against — that
   * is the real stability proof (Req 17.4). When absent the tool can only
   * assert the recomputation is internally consistent.
   */
  priorAssetId?: string;
}

/** One document to migrate. */
export interface ManifestEntry {
  /** The document reference — the row key Search stores under. Required. */
  reference: string;
  /**
   * The source, as either an already-stored source sha256 or a filesystem path
   * to upload first. At least one is needed to actually re-ingest; a manifest
   * with neither is still valid for a `--plan` (it just cannot be migrated).
   */
  sourceSha256?: string;
  path?: string;
  /** Optional declared content type, a hint for the ingest route. */
  mimeType?: string;
  /** Optional target collection; falls back to the tool's `--collection`. */
  collection?: string;
  /**
   * The usage signal, most-used first (Req 17.3). Any of these may be present;
   * `hitCount` wins, then `usage`, then recency via `lastAccessed`. All absent
   * means "no signal" and the entry sorts last, deterministically by reference.
   */
  hitCount?: number;
  usage?: number;
  /** ISO-8601 timestamp of last access; newer is treated as higher usage. */
  lastAccessed?: string;
  /** The assets this document had before migration, for the stability proof. */
  assets?: ManifestAsset[];
}

/** A parsed manifest: the entries plus any per-line parse warnings. */
export interface ParsedManifest {
  entries: ManifestEntry[];
  warnings: string[];
}

// ─── Manifest parsing ──────────────────────────────────────────────────────────

/**
 * Parse a manifest from its text. PURE — no filesystem access; the caller reads
 * the file. Accepts either a single JSON array/object or NDJSON (one JSON
 * object per non-blank line), because both are natural exports: an array is what
 * a small hand-written list looks like, NDJSON is what a streamed corpus dump
 * produces. A `{ "documents": [...] }` wrapper is also accepted.
 *
 * Malformed lines/entries are collected as warnings rather than aborting the
 * whole parse, so one bad row does not sink a 10 000-document migration; the
 * caller decides whether to proceed.
 */
export function parseManifest(text: string): ParsedManifest {
  const trimmed = text.trim();
  const warnings: string[] = [];
  if (trimmed === "") return { entries: [], warnings };

  const raw: unknown[] = [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      // Not a single JSON value — fall back to NDJSON parsing below.
      parsed = undefined;
      warnings.push(`Manifest is not a single JSON document (${errText(error)}); parsing as NDJSON.`);
    }
    if (Array.isArray(parsed)) {
      raw.push(...parsed);
    } else if (parsed !== undefined && isRecord(parsed) && Array.isArray(parsed.documents)) {
      raw.push(...parsed.documents);
    } else if (parsed !== undefined && isRecord(parsed)) {
      raw.push(parsed);
    } else if (parsed !== undefined) {
      warnings.push("Manifest JSON is neither an array, an object, nor a { documents: [] } wrapper.");
    }
  }

  if (raw.length === 0) {
    // NDJSON: one JSON object per non-blank line.
    const lines = trimmed.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim() ?? "";
      if (line === "") continue;
      try {
        raw.push(JSON.parse(line));
      } catch (error) {
        warnings.push(`Line ${i + 1}: not valid JSON (${errText(error)}); skipped.`);
      }
    }
  }

  const entries: ManifestEntry[] = [];
  raw.forEach((item, index) => {
    const entry = normalizeEntry(item, index, warnings);
    if (entry !== undefined) entries.push(entry);
  });
  return { entries, warnings };
}

/** Validate and normalise one raw manifest item. Returns undefined on error. */
function normalizeEntry(item: unknown, index: number, warnings: string[]): ManifestEntry | undefined {
  if (!isRecord(item)) {
    warnings.push(`Entry ${index}: not an object; skipped.`);
    return undefined;
  }
  const reference = typeof item.reference === "string" ? item.reference.trim() : "";
  if (reference === "") {
    warnings.push(`Entry ${index}: missing or empty "reference"; skipped.`);
    return undefined;
  }
  const entry: ManifestEntry = { reference };
  if (typeof item.sourceSha256 === "string" && /^[0-9a-f]{64}$/.test(item.sourceSha256)) {
    entry.sourceSha256 = item.sourceSha256;
  } else if (item.sourceSha256 !== undefined) {
    warnings.push(`Entry ${index} (${reference}): "sourceSha256" is not a 64-hex sha; ignored.`);
  }
  if (typeof item.path === "string" && item.path.trim() !== "") entry.path = item.path.trim();
  if (typeof item.mimeType === "string" && item.mimeType.trim() !== "") entry.mimeType = item.mimeType.trim();
  if (typeof item.collection === "string" && item.collection.trim() !== "") entry.collection = item.collection.trim();
  if (typeof item.hitCount === "number" && Number.isFinite(item.hitCount)) entry.hitCount = item.hitCount;
  if (typeof item.usage === "number" && Number.isFinite(item.usage)) entry.usage = item.usage;
  if (typeof item.lastAccessed === "string" && item.lastAccessed.trim() !== "") entry.lastAccessed = item.lastAccessed.trim();

  if (Array.isArray(item.assets)) {
    const assets: ManifestAsset[] = [];
    item.assets.forEach((a, ai) => {
      const asset = normalizeAsset(a, `${reference}#${ai}`, warnings);
      if (asset !== undefined) assets.push(asset);
    });
    if (assets.length > 0) entry.assets = assets;
  }
  return entry;
}

/** Validate and normalise one manifest asset. */
function normalizeAsset(item: unknown, where: string, warnings: string[]): ManifestAsset | undefined {
  if (!isRecord(item)) {
    warnings.push(`Asset ${where}: not an object; skipped.`);
    return undefined;
  }
  const kind = item.kind;
  if (kind !== "figure" && kind !== "page" && kind !== "tile" && kind !== "native" && kind !== "raw") {
    warnings.push(`Asset ${where}: unknown kind "${String(kind)}"; skipped.`);
    return undefined;
  }
  const id = typeof item.id === "string" ? item.id.trim() : "";
  if (id === "") {
    warnings.push(`Asset ${where}: missing "id"; skipped.`);
    return undefined;
  }
  const asset: ManifestAsset = { kind, id };
  if (typeof item.priorAssetId === "string" && /^[0-9a-f]{64}$/.test(item.priorAssetId)) {
    asset.priorAssetId = item.priorAssetId;
  } else if (item.priorAssetId !== undefined) {
    warnings.push(`Asset ${where}: "priorAssetId" is not a 64-hex sha; ignored.`);
  }
  return asset;
}

// ─── Usage ordering (Req 17.3) ───────────────────────────────────────────────

/**
 * A numeric usage weight for an entry, higher = more used. PURE.
 *
 * Precedence — `hitCount`, then `usage`, then recency of `lastAccessed`
 * expressed as its epoch-milliseconds (a newer access outranks an older one).
 * Returns `null` when the entry carries no usage signal at all, so
 * {@link orderByUsage} can place those documents last in a deterministic order
 * rather than pretending they have a weight of zero (which would tangle them
 * with documents that genuinely have zero hits).
 */
export function usageWeight(entry: ManifestEntry): number | null {
  if (entry.hitCount !== undefined && Number.isFinite(entry.hitCount)) return entry.hitCount;
  if (entry.usage !== undefined && Number.isFinite(entry.usage)) return entry.usage;
  if (entry.lastAccessed !== undefined) {
    const t = Date.parse(entry.lastAccessed);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * Order the manifest most-used first (Req 17.3). PURE and total: a stable sort
 * by usage descending, with a deterministic tie-break so the plan is identical
 * across runs and machines.
 *
 * Documents with a usage signal come first, highest weight first. Ties (equal
 * weight) and documents with no signal are broken by `reference` ascending
 * (locale-independent code-point order). Documents with no signal always sort
 * after documents that have one, even one with a low weight, because "unknown
 * usage" is a weaker claim than "measured, but small".
 */
export function orderByUsage(entries: readonly ManifestEntry[]): ManifestEntry[] {
  return [...entries].sort((a, b) => {
    const wa = usageWeight(a);
    const wb = usageWeight(b);
    if (wa !== null && wb !== null) {
      if (wa !== wb) return wb - wa; // higher usage first
    } else if (wa !== null) {
      return -1; // a has a signal, b does not → a first
    } else if (wb !== null) {
      return 1; // b has a signal, a does not → b first
    }
    // Deterministic tie-break: reference ascending by code point.
    return a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0;
  });
}

// ─── Asset-id stability (Req 17.4) ───────────────────────────────────────────

/** The fully-formed local id for a manifest asset, through the contract helper. */
export function localIdFor(asset: ManifestAsset): string {
  switch (asset.kind) {
    case "figure":
      return figureLocalId(asset.id);
    case "page":
      // Accept "37" or "p37"; pageLocalId wants the numeric page.
      return pageLocalId(Number.parseInt(asset.id.replace(/^p/i, ""), 10));
    case "tile":
      return tileLocalId(asset.id);
    case "native":
      return nativeLocalId(asset.id);
    case "raw":
      return asset.id;
  }
}

/** One expected asset id, computed purely from a reference and a local id. */
export interface ExpectedAssetId {
  kind: ManifestAsset["kind"];
  localId: string;
  assetId: string;
  priorAssetId?: string;
}

/**
 * Recompute the asset ids a document's assets MUST resolve to, from the
 * reference and the local ids, using the real `buildAssetId` from the contract
 * (never a re-implemented hash). PURE. This is the "stability math" the
 * `--dry-run` mode prints: given the same reference and local ids, the ids are
 * byte-identical to what a v2 re-extraction produces.
 */
export function expectedAssetIds(reference: string, assets: readonly ManifestAsset[]): ExpectedAssetId[] {
  return assets.map((asset) => {
    const localId = localIdFor(asset);
    const expected: ExpectedAssetId = {
      kind: asset.kind,
      localId,
      assetId: buildAssetId(reference, localId),
    };
    if (asset.priorAssetId !== undefined) expected.priorAssetId = asset.priorAssetId;
    return expected;
  });
}

/** One asset's stability verdict. */
export interface AssetStabilityResult {
  kind: ManifestAsset["kind"];
  localId: string;
  /** The recomputed id (what a v2 re-extraction produces for this reference). */
  assetId: string;
  /** The pre-migration id from the manifest, when supplied. */
  priorAssetId?: string;
  /**
   * `stable` — recomputed id equals the prior id (proven byte-identical).
   * `changed` — recomputed id differs from the prior id (a real regression).
   * `unverified` — no prior id supplied, so only the recomputation is known.
   */
  status: "stable" | "changed" | "unverified";
}

/** A document's overall stability report. */
export interface DocumentStabilityReport {
  reference: string;
  assets: AssetStabilityResult[];
  stable: number;
  changed: number;
  unverified: number;
  /** True when nothing changed — i.e. no `changed` asset. */
  ok: boolean;
}

/**
 * Prove asset-id stability for one document (Req 17.4). PURE.
 *
 * For each asset, recompute `buildAssetId(reference, localId)` and compare it
 * against the pre-migration `priorAssetId` from the manifest. When the manifest
 * supplies prior ids this is the real proof that re-extracting the corpus keeps
 * asset ids byte-identical (so previously uploaded crops stay valid); when it
 * does not, the asset is reported `unverified` — the recomputed id is shown but
 * there is nothing to check it against. A single `changed` asset flips the
 * document's `ok` to false, because a changed id would orphan an uploaded crop.
 */
export function checkAssetIdStability(reference: string, assets: readonly ManifestAsset[]): DocumentStabilityReport {
  const results: AssetStabilityResult[] = expectedAssetIds(reference, assets).map((e) => {
    const result: AssetStabilityResult = {
      kind: e.kind,
      localId: e.localId,
      assetId: e.assetId,
      status: e.priorAssetId === undefined ? "unverified" : e.assetId === e.priorAssetId ? "stable" : "changed",
    };
    if (e.priorAssetId !== undefined) result.priorAssetId = e.priorAssetId;
    return result;
  });
  const stable = results.filter((r) => r.status === "stable").length;
  const changed = results.filter((r) => r.status === "changed").length;
  const unverified = results.filter((r) => r.status === "unverified").length;
  return { reference, assets: results, stable, changed, unverified, ok: changed === 0 };
}

// ─── Migration plan ──────────────────────────────────────────────────────────

/** One planned document, in migration order, with its stability preview. */
export interface PlannedDocument {
  /** 1-based position in the usage-ordered plan. */
  order: number;
  reference: string;
  /** The usage weight that placed it, or null when it had no signal. */
  usage: number | null;
  sourceSha256?: string;
  path?: string;
  collection?: string;
  /** How the source will be obtained: an existing sha, a file upload, or none. */
  sourceKind: "sha256" | "upload" | "none";
  stability: DocumentStabilityReport;
}

/**
 * Build the full migration plan from a parsed manifest: order by usage and
 * attach each document's stability preview. PURE — this is exactly what
 * `--dry-run`/`--plan` prints, computed with no server contacted.
 */
export function buildMigrationPlan(entries: readonly ManifestEntry[]): PlannedDocument[] {
  return orderByUsage(entries).map((entry, i) => {
    const sourceKind: PlannedDocument["sourceKind"] =
      entry.sourceSha256 !== undefined ? "sha256" : entry.path !== undefined ? "upload" : "none";
    const planned: PlannedDocument = {
      order: i + 1,
      reference: entry.reference,
      usage: usageWeight(entry),
      sourceKind,
      stability: checkAssetIdStability(entry.reference, entry.assets ?? []),
    };
    if (entry.sourceSha256 !== undefined) planned.sourceSha256 = entry.sourceSha256;
    if (entry.path !== undefined) planned.path = entry.path;
    if (entry.collection !== undefined) planned.collection = entry.collection;
    return planned;
  });
}

// ─── Run summary ─────────────────────────────────────────────────────────────

/** The terminal outcome of migrating one document. */
export interface MigrationOutcome {
  reference: string;
  status: "migrated" | "failed" | "skipped";
  /** Present when migrated: the new revision's contract and page count. */
  contract?: string;
  pageCount?: number;
  /** Present when the document carried a stability report. */
  stability?: DocumentStabilityReport;
  /** Present when failed/skipped: the reason. */
  error?: string;
}

/** The whole-run summary. */
export interface MigrationSummary {
  total: number;
  migrated: number;
  failed: number;
  skipped: number;
  /** Documents whose asset ids changed — a real regression that needs review. */
  assetIdRegressions: string[];
}

/** Fold per-document outcomes into a run summary. PURE. */
export function summarizeRun(outcomes: readonly MigrationOutcome[]): MigrationSummary {
  const summary: MigrationSummary = {
    total: outcomes.length,
    migrated: outcomes.filter((o) => o.status === "migrated").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    assetIdRegressions: outcomes.filter((o) => o.stability !== undefined && !o.stability.ok).map((o) => o.reference),
  };
  return summary;
}

// ─── Report formatting ───────────────────────────────────────────────────────

/** Render the usage-ordered plan (and the stability preview) as plain text. */
export function formatPlan(plan: readonly PlannedDocument[]): string {
  if (plan.length === 0) return "(empty manifest — nothing to migrate)";
  const lines: string[] = [];
  for (const doc of plan) {
    const usage = doc.usage === null ? "usage: —" : `usage: ${doc.usage}`;
    const src =
      doc.sourceKind === "sha256"
        ? `sha256:${(doc.sourceSha256 ?? "").slice(0, 12)}…`
        : doc.sourceKind === "upload"
          ? `upload:${doc.path}`
          : "source: MISSING";
    lines.push(`${String(doc.order).padStart(4)}. ${doc.reference}  [${usage}]  (${src})`);
    for (const a of doc.stability.assets) {
      const mark = a.status === "stable" ? "✓ stable" : a.status === "changed" ? "✗ CHANGED" : "· unverified";
      const cmp =
        a.status === "changed" ? `  expected ${a.assetId} but corpus had ${a.priorAssetId ?? "?"}` : "";
      lines.push(`        ${mark}  ${a.kind} ${a.localId} → ${a.assetId}${cmp}`);
    }
  }
  return lines.join("\n");
}

/** Render the whole-run summary as plain text. */
export function formatSummary(summary: MigrationSummary): string {
  const lines = [
    `Documents:   ${summary.total}`,
    `Migrated:    ${summary.migrated}`,
    `Failed:      ${summary.failed}`,
    `Skipped:     ${summary.skipped}`,
  ];
  if (summary.assetIdRegressions.length > 0) {
    lines.push(
      `Asset-id regressions (${summary.assetIdRegressions.length}): ${summary.assetIdRegressions.join(", ")}`,
    );
  } else {
    lines.push("Asset-id regressions: none — every checked id stayed byte-identical.");
  }
  return lines.join("\n");
}

// ─── small helpers ───────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
