// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * v2/api.ts
 *
 * The typed API surface shared by Extract (producer) and Search (consumer) for
 * the v2 ingest and job lifecycle. These are the request/response shapes that
 * travel over the routes in `design.md` §6.1 (Search ingest) and §5 (Extract
 * jobs); putting them in the contract keeps the two services from drifting on
 * field names or status vocabularies.
 *
 * Only the wire shapes live here. The stream *content* (records, blocks) is in
 * `./records.ts`; the codec that frames it is in `./codec.ts`.
 */

import { z } from "zod";
import { documentVersionSchema } from "./records.js";

// --- Revision (Search staging) ---------------------------------------------

/** Whether committed segments are searchable before the final commit. */
export const visibilitySchema = z.enum(["progressive", "on_commit"]);

export type Visibility = z.infer<typeof visibilitySchema>;

/** Lifecycle of a staged revision. */
export const revisionStatusSchema = z.enum([
  "staging",
  "partial",
  "committed",
  "superseded",
  "aborted",
]);

export type RevisionStatus = z.infer<typeof revisionStatusSchema>;

/** Response of `POST /v2/documents/{ref}/revisions`. */
export const revisionSchema = z.object({
  revisionId: z.string(),
  reference: z.string(),
  status: revisionStatusSchema,
  visibility: visibilitySchema,
  createdAt: z.string(),
  idempotencyKey: z.string().optional(),
  ttlExpiresAt: z.string().optional(),
});

export type Revision = z.infer<typeof revisionSchema>;

// --- Batch (NDJSON page upload) --------------------------------------------

/** Status of a staged NDJSON batch. */
export const batchStatusSchema = z.enum(["received", "processing", "processed", "failed"]);

export type BatchStatus = z.infer<typeof batchStatusSchema>;

/** A `[from,to]` closed page range. */
export const pageRangeSchema = z.object({
  from: z.int().min(1),
  to: z.int().min(1),
});

export type PageRange = z.infer<typeof pageRangeSchema>;

/**
 * Acknowledgement of `PUT …/batches/{seq}`.
 *
 * `noop` is true when the same `seq` arrived again with the same `Content-Digest`
 * — an idempotent replay, answered `200` without re-processing.
 */
export const batchAckSchema = z.object({
  seq: z.int().min(0),
  digest: z.string(),
  status: batchStatusSchema,
  pages: pageRangeSchema.optional(),
  noop: z.boolean().default(false),
});

export type BatchAck = z.infer<typeof batchAckSchema>;

// --- Revision status (GET …/revisions/{rev}) -------------------------------

export const revisionStateSchema = z.object({
  revisionId: z.string(),
  reference: z.string(),
  status: revisionStatusSchema,
  visibility: visibilitySchema,
  /** Batch sequence numbers accepted so far. */
  acceptedBatches: z.array(z.int().min(0)).default([]),
  /** Page ranges whose units have been built and indexed. */
  processedPages: z.array(pageRangeSchema).default([]),
  /** Asset ids referenced by accepted batches that have not been uploaded. */
  missingAssets: z.array(z.string()).default([]),
  /** Segment numbers committed so far. */
  committedSegments: z.array(z.int().min(0)).default([]),
  /** Total pages available for search under this revision. */
  pagesAvailable: z.int().min(0).optional(),
});

export type RevisionState = z.infer<typeof revisionStateSchema>;

// --- Commit ----------------------------------------------------------------

/**
 * Result of a segment or final commit.
 *
 * A commit is idempotent; when batches are still missing it is rejected (409)
 * and `missingRanges` lists exactly what the producer must still send.
 */
export const commitResultSchema = z.object({
  reference: z.string(),
  revisionId: z.string(),
  committed: z.boolean(),
  segment: z.int().min(0).optional(),
  isLatest: z.boolean().optional(),
  missingRanges: z.array(pageRangeSchema).default([]),
});

export type CommitResult = z.infer<typeof commitResultSchema>;

// --- Job (Extract) ---------------------------------------------------------

/** The lifecycle a persistent Extract job moves through. */
export const jobStatusSchema = z.enum([
  "queued",
  "preparing",
  "processing",
  "emitting",
  "committing",
  "completed",
  "failed",
  "paused",
  "cancelled",
]);

export type JobStatus = z.infer<typeof jobStatusSchema>;

/** Why a job is paused, so a controller can decide whether to auto-resume. */
export const pauseReasonSchema = z.enum(["budget", "dependency", "manual"]);

export type PauseReason = z.infer<typeof pauseReasonSchema>;

/** Behaviour when a resumed job's pipeline/prompt hash differs from the snapshot. */
export const resumePolicySchema = z.enum(["pin", "continue", "restart-stage"]);

export type ResumePolicy = z.infer<typeof resumePolicySchema>;

/** Per-stage progress counts, keyed by stage name (S2–S8). */
export const stageProgressSchema = z.record(
  z.string(),
  z.object({
    done: z.int().min(0),
    total: z.int().min(0),
    failed: z.int().min(0).default(0),
  }),
);

export type StageProgress = z.infer<typeof stageProgressSchema>;

/**
 * Duplicate handling for a new ingest:
 *   auto   skip exact duplicates anywhere in the collection and near-duplicates
 *          of the same document (same reference without file extension) that
 *          carry the same version (default)
 *   exact  skip only byte- or text-identical duplicates
 *   off    never skip
 */
export const dedupModeSchema = z.enum(["auto", "exact", "off"]);

export type DedupMode = z.infer<typeof dedupModeSchema>;

/** Request body of `POST /v2/jobs`. */
export const jobRequestSchema = z.object({
  reference: z.string().min(1),
  /** sha256 of the already-uploaded source, addressed in the source store. */
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  collection: z.string().optional(),
  pages: z.string().optional(),
  tokenBudget: z.int().min(0).optional(),
  priority: z.int().optional(),
  visibility: visibilitySchema.optional(),
  resumePolicy: resumePolicySchema.optional(),
  callbackUrl: z.string().optional(),
  /** Explicit document version; skips version detection. */
  version: z.string().min(1).max(200).optional(),
  /** The source file's modification time (RFC 3339), the last version fallback. */
  sourceModifiedAt: z.iso.datetime({ offset: true }).optional(),
  dedup: dedupModeSchema.optional(),
  /**
   * Who may read the document. Narrowed to the caller's own identity (a caller
   * cannot grant access it does not have); omitted = the caller's own identity,
   * or — for a service caller — the Search collection ACL.
   */
  allowedUsers: z.array(z.string().min(1)).max(1000).optional(),
  allowedGroups: z.array(z.string().min(1)).max(1000).optional(),
  /**
   * Document attributes Search stores on every unit (contract 2.2): the title,
   * tags for tag filters, free metadata for metadata filters, the document's
   * link and a source label. The v1 `/ingest` headers X-Title, X-Tags,
   * X-Metadata, X-Link and X-Source map onto these.
   */
  title: z.string().min(1).max(500).optional(),
  tags: z.array(z.string().min(1).max(200)).max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  link: z.string().min(1).max(2000).optional(),
  sourceLabel: z.string().min(1).max(500).optional(),
});

// --- Source identification (Search, dedup + version chains) -----------------

/** Lifecycle of a registered source. */
export const sourceStatusSchema = z.enum(["pending", "indexed", "duplicate", "released"]);

export type SourceStatus = z.infer<typeof sourceStatusSchema>;

/**
 * Request body of `POST /v2/sources/identify`.
 *
 * Extract calls it twice per job: once with the source hash only (phase
 * `source`, before any work) and once with the text fingerprint and the
 * detected version (phase `content`, after the source is prepared but before
 * any model call). Each call registers or updates the job's source claim.
 */
export const identifyRequestSchema = z.object({
  /** Stable id of the ingest (the Extract job id); the claim key. */
  sourceId: z.string().min(1).max(200),
  phase: z.enum(["source", "content"]),
  /** The reference the caller asked for. */
  reference: z.string().min(1),
  /** `documentKeyOf(reference)`. */
  documentKey: z.string().min(1),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** sha256 of the normalised text; absent for a source without text. */
  textHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** MinHash signature of the normalised text's word shingles. */
  minhash: z.array(z.int()).max(512).optional(),
  /** Message-ID of an e-mail source: the same message exported twice is a duplicate. */
  messageId: z.string().min(1).max(998).optional(),
  /**
   * The row ACL the document is ingested under (the same values the revision is
   * opened with). Sources only match sources of the same ACL.
   */
  allowedUsers: z.array(z.string()).max(1000).optional(),
  allowedGroups: z.array(z.string()).max(1000).optional(),
  version: documentVersionSchema.optional(),
  dedup: dedupModeSchema.default("auto"),
});

export type IdentifyRequest = z.input<typeof identifyRequestSchema>;

/** A registered source another ingest duplicated. */
export const duplicateOfSchema = z.object({
  reference: z.string(),
  sourceId: z.string(),
  filename: z.string().optional(),
  revisionId: z.string().optional(),
  /** `sha256`, `text` or `similar`. */
  match: z.enum(["sha256", "text", "similar"]),
  /** Estimated text similarity in `[0,1]` for a `similar` match. */
  similarity: z.number().min(0).max(1).optional(),
});

export type DuplicateOf = z.infer<typeof duplicateOfSchema>;

/** Response of `POST /v2/sources/identify`. */
export const identifyResponseSchema = z.object({
  /**
   *   new           nothing like it is indexed
   *   new_version   another version of an indexed document (same document key)
   *   duplicate     already indexed; the caller should skip it
   */
  decision: z.enum(["new", "new_version", "duplicate"]),
  /**
   * The reference to ingest under. The first reference a document key was
   * indexed with, so `handbuch.docx` becomes a new revision of an indexed
   * `handbuch.pdf`; the requested reference for a new document.
   */
  canonicalReference: z.string(),
  duplicateOf: duplicateOfSchema.optional(),
});

export type IdentifyResponse = z.infer<typeof identifyResponseSchema>;

/** One source of a document, as listed by `GET /v2/documents/{ref}/sources`. */
export const documentSourceSchema = z.object({
  sourceId: z.string(),
  reference: z.string(),
  requestedReference: z.string(),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  sourceSha256: z.string(),
  status: sourceStatusSchema,
  revisionId: z.string().optional(),
  version: documentVersionSchema.optional(),
  duplicateOf: duplicateOfSchema.optional(),
  createdAt: z.string(),
});

export type DocumentSource = z.infer<typeof documentSourceSchema>;

export type JobRequest = z.infer<typeof jobRequestSchema>;

/** `GET /v2/jobs/{id}` — status, progress, cost and an ETA. */
export const jobSchema = z.object({
  jobId: z.string(),
  reference: z.string(),
  status: jobStatusSchema,
  pauseReason: pauseReasonSchema.optional(),
  pageCount: z.int().min(0).optional(),
  progress: stageProgressSchema.optional(),
  warnings: z.array(z.string()).default([]),
  tokensUsed: z.int().min(0).optional(),
  tokenBudget: z.int().min(0).optional(),
  costUsd: z.number().min(0).optional(),
  etaSeconds: z.int().min(0).nullable().optional(),
  revisionId: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  /**
   * The reference the document was ingested under when it differs from the
   * requested one (a new version of a document indexed under another format).
   */
  resolvedReference: z.string().optional(),
  /** The version the document was ingested with, explicit or detected. */
  version: documentVersionSchema.optional(),
  /** Set when the job was skipped as a duplicate of an indexed source. */
  duplicateOf: duplicateOfSchema.optional(),
});

export type Job = z.infer<typeof jobSchema>;

/**
 * Request body of `POST /v2/render` (design §9a.1, requirements 6.8, 14.4).
 *
 * A full page image, or a bbox region of it, rendered ON DEMAND from the
 * content-addressed source — never pre-stored. `bbox`, when present, is a
 * normalised `[x0,y0,x1,y1]` in `[0,1]`; the whole page renders when it is
 * omitted. `targetPixels` is the desired LONG-EDGE pixel count of the result;
 * Extract picks a render DPI to hit it and CLAMPS to its own pixel ceiling
 * (`RENDER_MAX_PIXELS`) so a caller cannot request a gigapixel crop. Rendering
 * the same `(source, page, bbox, targetPixels)` is deterministic.
 */
export const renderRequestSchema = z
  .object({
    /** sha256 of the already-uploaded source, addressed in the source store. */
    source: z.string().regex(/^[0-9a-f]{64}$/),
    /** 1-based page number to render. */
    page: z.int().min(1),
    /**
     * Optional normalised crop box `[x0,y0,x1,y1]` in `[0,1]`, x0<x1, y0<y1.
     * Omitted renders the whole page.
     */
    bbox: z
      .tuple([
        z.number().min(0).max(1),
        z.number().min(0).max(1),
        z.number().min(0).max(1),
        z.number().min(0).max(1),
      ])
      .refine((b) => b[0] < b[2] && b[1] < b[3], {
        message: "bbox must have x0<x1 and y0<y1",
      })
      .optional(),
    /**
     * Desired long-edge pixel count of the result. Extract picks a DPI to hit
     * it, clamped to the server's `RENDER_MAX_PIXELS` ceiling. Omitted renders
     * at the configured page/figure DPI.
     */
    targetPixels: z.int().min(16).optional(),
    /** Optional filename hint so an extension-typed source resolves correctly. */
    filename: z.string().optional(),
  })
  .strict();

export type RenderRequest = z.infer<typeof renderRequestSchema>;

/**
 * Response metadata of `POST /v2/render` (the PNG bytes travel as the body;
 * this shape is returned as JSON only for a metadata-probe caller). The actual
 * pixel size and the DPI the render landed on, after any clamp.
 */
export const renderResultSchema = z.object({
  source: z.string(),
  page: z.int().min(1),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  width: z.int().min(1),
  height: z.int().min(1),
  dpi: z.int().min(1),
  mimeType: z.literal("image/png"),
});

export type RenderResult = z.infer<typeof renderResultSchema>;
