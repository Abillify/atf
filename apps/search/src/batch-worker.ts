// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * batch-worker.ts
 *
 * The v2 batch-processing worker (design §9b.3, task 1.10). It is the missing
 * piece between the revision store (task 1.9), which stages NDJSON page batches
 * as `status='received'`, and a searchable index: it claims a staged batch,
 * turns its v2 blocks into index units, embeds them, upserts them, and marks
 * the batch `processed` — at which point `getRevisionState` surfaces the
 * batch's page range as processed.
 *
 * Decoupling and resumability (Requirement 5.4):
 *   - Batches are claimed with `SELECT … FOR UPDATE SKIP LOCKED` in a short
 *     claim transaction that sets `status='processing'`, a fresh `lease_token`
 *     and `next_attempt_at = now + leaseMs` (a lease / visibility timeout).
 *     Many workers never process the same batch twice, and a crash mid-batch
 *     leaves it claimable again once the lease expires — never in a hot loop.
 *   - The unit upsert and the `processed` flip happen in ONE processing
 *     transaction that re-locks the batch row and verifies the lease token.
 *     Either the whole batch becomes `processed` with its units committed, or
 *     nothing is committed — there is never a half-indexed batch.
 *   - On an embedding-service failure the processing transaction rolls back and
 *     the batch is returned to `received` with a `next_attempt_at` backoff, so
 *     processing resumes later without losing data (Requirement 5.4).
 *
 * Determinism (Requirement 5.5):
 *   - Units carry a deterministic `unit_id` (see batch-unit-builder.ts) and are
 *     upserted on the `(tenant_id, unit_id)` partial unique index (task 1.8),
 *     so reprocessing the same batch replaces in place and never duplicates.
 *
 * Scope: this uses the FULL multi-level unit builder (task 3.2): chunk / table /
 * figure units from page records, and section / page / document summary units
 * from a trailing `document.end` batch. The contextual header is task 3.3.
 * Visibility (Requirements 5.11, 6.4, 6.5): right before the upserts the worker
 * takes `FOR SHARE` on the revision row and reads the document pointer and the
 * committed segments (revision-store.ts `loadUnitVisibilityContext`). A unit is
 * written is_latest = TRUE only when the pointer names its revision AND the
 * revision is committed or it is `progressive` and the unit lies in a committed
 * segment. The share lock orders the write against segment commits and the
 * final switch, so a unit processed AFTER its segment was committed is visible
 * immediately instead of staying hidden forever. After the batch commits, the
 * worker completes an accepted final commit whose last batch this was
 * (`finalizeRevision`), and when idle it resumes interrupted switches.
 */

import { mapWithConcurrency } from "./concurrency.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Logger } from "pino";
import {
  decodeRecords,
  isDocumentBegin,
  isDocumentEnd,
  isPage,
  type DocumentEndRecord,
  type PageRecord,
} from "@atf/extract-contract";
import type { EmbeddingClient } from "./embedding-client.js";
import {
  collectionTableName,
  ensureIdentifiersTable,
  validateFtsLanguage,
} from "./collection-ddl.js";
import { buildIdentifierText, normalizeIdentifier } from "./identifier.js";
import { prepareFtsContent } from "./pg-helpers.js";
import {
  buildUnitsFromRecords,
  heuristicTokenCounter,
  type IndexUnit,
  type UnitTokenCounter,
} from "./batch-unit-builder.js";
import {
  parseStoredVector,
  shouldReembed,
  type StoredUnitFacts,
} from "./reembed-decision.js";
import {
  applyContextualHeaders,
  DEFAULT_CONTEXT_HEADER_MAX_FRACTION,
} from "./contextual-header.js";
import type { SummaryClient } from "./summary-client.js";
import { parseDocumentInfo, type DocumentInfo } from "./document-identity.js";
import {
  extractProvenanceOf,
  finalizePendingCommits,
  finalizeRevision,
  isUnitVisible,
  loadUnitVisibilityContext,
  parseExtractProvenance,
  type ExtractProvenance,
  type UnitVisibilityContext,
} from "./revision-store.js";

// ─── Result shape ───────────────────────────────────────────────────────────

/** Why a tick did not process a batch, or that it did. */
export type TickOutcome =
  | { kind: "idle" } // nothing claimable
  | { kind: "processed"; revisionId: string; seq: number; units: number }
  | { kind: "deferred"; revisionId: string; seq: number; reason: string } // embedding failed → backoff
  | { kind: "empty"; revisionId: string; seq: number } // no units to build, still marked processed
  | { kind: "skipped"; revisionId: string; seq: number; reason: string } // lease lost / revision closed
  | { kind: "error"; message: string };

export interface BatchWorker {
  /**
   * Claim and process at most one staged batch. Returns what happened. Safe to
   * call concurrently — SKIP LOCKED guarantees two ticks never grab one batch.
   */
  tick(now?: Date): Promise<TickOutcome>;
  /** Drain: tick until idle (or a max count). Returns outcomes in order. */
  drain(max?: number): Promise<TickOutcome[]>;
  /** Stop the background loop. Safe to call more than once. */
  stop(): void;
}

export interface BatchWorkerOptions {
  /** How often to poll for staged batches, in ms. 0 disables the loop. Default: 2000. */
  intervalMs?: number;
  /** Backoff applied to `next_attempt_at` after an embedding failure, in ms. Default: 30s. */
  backoffMs?: number;
  /**
   * Lease (visibility timeout) of a claimed batch, in ms. The claim sets
   * `next_attempt_at = now + leaseMs`; a batch whose worker died or whose
   * deferral write failed becomes claimable again after the lease, not
   * immediately. Must exceed the worst-case processing time of one batch.
   * Default: 10 minutes.
   */
  leaseMs?: number;
  /**
   * Token counter (task 3.1) used to size text chunks to 350–500 tokens and to
   * split oversize tables into row-groups (Requirements 11.2 / 11.3). When
   * omitted the builder uses a character heuristic (~4 chars/token) so ingest
   * still works without a configured TEI `/tokenize` endpoint.
   */
  tokenCounter?: UnitTokenCounter;
  /** Minimum tokens per text chunk (Req 11.2). Default: 350. */
  minChunkTokens?: number;
  /** Maximum tokens per text chunk / table row-group (Req 11.2/11.3). Default: 500. */
  maxChunkTokens?: number;
  /** @deprecated char-based chunk size of the transitional builder; ignored by the token-based builder. */
  chunkSize?: number;
  /** @deprecated char-based chunk overlap; ignored by the token-based builder. */
  chunkOverlap?: number;
  /** Embedding batch size per HTTP round-trip. Default: 64. */
  embedBatchSize?: number;
  /**
   * How many embedding round-trips of ONE staged batch run at once. The slices
   * used to go out one after the other, so a batch of N slices paid N times the
   * provider latency. Order of the vectors is preserved. Default: 4.
   */
  embedConcurrency?: number;
  /**
   * How many staged batches one wake-up of the poll loop may process back to
   * back before it sleeps for `intervalMs` again. Without it a backlog of B
   * batches took B poll intervals. The loop still stops at the first idle or
   * error tick. Default: 25.
   */
  maxBatchesPerPoll?: number;
  /**
   * Fraction of the chunk token budget the contextual embedding header may
   * occupy (task 3.3, Requirement 11.4). The header (title, section path,
   * pages, type, page summary) is prepended to each chunk/table/figure unit's
   * `embedInput` only and truncated summary-first to this fraction. Default:
   * {@link DEFAULT_CONTEXT_HEADER_MAX_FRACTION} (0.15).
   */
  contextHeaderMaxFraction?: number;
  /**
   * The SUMMARY_* text-LLM client (summary-client.ts). Required only for the
   * CONTEXTUAL_CHUNK_LLM stage; the header itself does not need it. When
   * omitted the LLM stage is inert regardless of {@link contextualChunkLlm}.
   */
  summaryClient?: SummaryClient;
  /**
   * Enable the per-chunk placement sentence via the text-LLM (Requirement
   * 11.6). Off by default — it is one model call per chunk. A text-LLM failure
   * degrades to the header without the sentence and never fails the batch.
   * No-op unless {@link summaryClient} is also provided. Default: false.
   */
  contextualChunkLlm?: boolean;
  /**
   * FTS_CONTEXTUAL_HEADER: when true, `ts_search` is written as
   * `setweight(to_tsvector(lang, header), 'D') || to_tsvector(lang, content)`
   * with the header being the document title and the unit's section path.
   * Only newly written units are affected. Default: false.
   */
  ftsContextualHeader?: boolean;
  /** pgvector column type for the vector cast: "vector" or "halfvec". Default: "vector". */
  vecType?: "vector" | "halfvec";
  /**
   * Create a collection that does not exist yet, with the embedding's vector
   * size and the same defaults the v1 ingest paths use
   * (`PostgresClient.ensureCollection`). The revision API accepts a document
   * for a new collection; without this the first batch would fail on the
   * missing table forever. Omitted, a missing collection is an error.
   */
  ensureCollection?: (collection: string, vectorSize: number) => Promise<{ ok: true } | { ok: false; error: { message: string } }>;
  /**
   * Narrow the claim to a single tenant. Undefined in production, where any
   * worker may process any staged batch. Set only by integration suites that
   * share one database: without it, the status-only claim lets a parallel
   * suite's worker steal batches staged under a different tenant, so the two
   * suites race for each other's rows. Scoping the claim to the suite's own
   * tenant makes the suites independent without serializing them.
   */
  onlyTenantId?: string;
  /**
   * Observer called once after every tick (loop or direct `tick()` call) with
   * its outcome and wall-clock duration in ms — the hook the service uses for
   * the batch metrics (Requirement 18.1). Purely observational: a throwing or
   * rejecting observer is swallowed and never changes the tick's outcome.
   */
  onTick?: (outcome: TickOutcome, durationMs: number) => void | Promise<void>;
  logger?: Logger;
}

// ─── Table names (mirrors revision-schema.ts) ───────────────────────────────

const BATCHES = "vs_ingest_batches";

interface ClaimedBatchRow {
  tenant_id: string;
  collection: string;
  revision_id: string;
  seq: number;
  reference: string;
  payload: Buffer | null;
  page_start: number | null;
  page_end: number | null;
  /** Token of THIS worker's claim; every later write is fenced on it. */
  lease_token: string;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createBatchWorker(
  pool: Pool,
  embeddingClient: EmbeddingClient,
  options: BatchWorkerOptions = {},
): BatchWorker {
  const intervalMs = options.intervalMs ?? 2_000;
  const backoffMs = options.backoffMs ?? 30_000;
  const leaseMs = options.leaseMs ?? 600_000;
  const tokenCounter = options.tokenCounter ?? heuristicTokenCounter;
  const minChunkTokens = options.minChunkTokens ?? 350;
  const maxChunkTokens = options.maxChunkTokens ?? 500;
  const embedBatchSize = options.embedBatchSize ?? 64;
  const embedConcurrency = Math.max(1, options.embedConcurrency ?? 4);
  const maxBatchesPerPoll = Math.max(1, options.maxBatchesPerPoll ?? 25);
  const vecType = options.vecType ?? "vector";
  const onlyTenantId = options.onlyTenantId;
  const onTick = options.onTick;
  const contextHeaderMaxFraction =
    options.contextHeaderMaxFraction ?? DEFAULT_CONTEXT_HEADER_MAX_FRACTION;
  const summaryClient = options.summaryClient;
  const contextualChunkLlm = options.contextualChunkLlm ?? false;
  const ftsContextualHeader = options.ftsContextualHeader ?? false;
  const logger = options.logger;

  /**
   * Embed all unit inputs in provider-sized batches. Throws on the first
   * embedding failure so the caller rolls the transaction back and defers the
   * batch (no partial commit).
   */
  async function embedAll(units: IndexUnit[]): Promise<number[][]> {
    const slices: IndexUnit[][] = [];
    for (let start = 0; start < units.length; start += embedBatchSize) {
      slices.push(units.slice(start, start + embedBatchSize));
    }
    const perSlice = await mapWithConcurrency(
      slices,
      embedConcurrency,
      async (slice) => {
        const res = await embeddingClient.embedBatch(slice.map((u) => u.embedInput));
        if (!res.ok) {
          throw new EmbeddingFailure(`${res.error.code}: ${res.error.message}`);
        }
        if (res.result.vectors.length !== slice.length) {
          throw new EmbeddingFailure(
            `embedding provider returned ${res.result.vectors.length} vectors for ${slice.length} inputs`,
          );
        }
        return res.result.vectors;
      },
    );
    return perSlice.flat();
  }

  /**
   * Resolve a vector for every unit, embedding only those that need it (task
   * 5.4, requirement 9.6).
   *
   * Batch-loads the stored `section_path`, `content` and `vector` for the
   * incoming unit ids in one query, then for each unit asks {@link shouldReembed}
   * whether its vector is stale. Units that need a fresh vector are embedded in
   * one call to {@link embedAll} (preserving the provider-batching); units whose
   * path and content are unchanged reuse the parsed stored vector and never hit
   * the embedder. Returns the vectors in the SAME order as `units`.
   *
   * A stored vector that fails to parse (corrupt/absent) falls back to embedding
   * that unit, so a reuse can never substitute a bad vector. Throws on an
   * embedding failure exactly as {@link embedAll} does.
   */
  async function resolveVectors(
    client: PoolClient,
    table: string,
    batch: ClaimedBatchRow,
    units: IndexUnit[],
    tableExists = true,
  ): Promise<number[][]> {
    // A collection that does not exist yet has no stored vectors to reuse.
    const stored = tableExists
      ? await loadStoredUnitFacts(client, table, batch.tenant_id, units)
      : new Map<string, never>();

    const reused: (number[] | null)[] = new Array(units.length).fill(null);
    const toEmbed: IndexUnit[] = [];
    const toEmbedIndex: number[] = [];
    let reuseCount = 0;

    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (!unit) continue;
      const facts = stored.get(unit.unitId) ?? null;
      const storedFacts: StoredUnitFacts | null = facts
        ? { sectionPath: facts.sectionPath, content: facts.content }
        : null;
      // A stored vector that will not parse forces a re-embed even when the
      // path/content match, so a reuse never yields a broken vector.
      const parsed = facts ? parseStoredVector(facts.vector) : null;
      if (!shouldReembed({ sectionPath: unit.sectionPath, content: unit.content }, storedFacts) && parsed) {
        reused[i] = parsed;
        reuseCount += 1;
      } else {
        toEmbed.push(unit);
        toEmbedIndex.push(i);
      }
    }

    if (reuseCount > 0) {
      logger?.debug(
        { revisionId: batch.revision_id, seq: batch.seq, reused: reuseCount, embedded: toEmbed.length },
        "selective re-embed: reused stored vectors for unchanged units",
      );
    }

    const freshVectors = toEmbed.length > 0 ? await embedAll(toEmbed) : [];
    for (let j = 0; j < toEmbedIndex.length; j++) {
      const idx = toEmbedIndex[j];
      const vec = freshVectors[j];
      if (idx !== undefined && vec) reused[idx] = vec;
    }

    // Every slot is now filled: a reused vector, or a freshly embedded one. A
    // null here would mean a unit produced no vector, which embedAll's length
    // check already rules out; guard defensively so the return type is clean.
    return reused.map((v, i) => {
      if (v) return v;
      throw new EmbeddingFailure(`no vector resolved for unit ${units[i]?.unitId ?? i}`);
    });
  }

  async function processClaimed(
    client: PoolClient,
    batch: ClaimedBatchRow,
  ): Promise<TickOutcome> {
    // Parse the staged NDJSON payload into page records. A staged batch already
    // validated at PUT time (task 1.9), so a parse failure here is a permanent
    // corruption, not a transient error: mark it processed-empty rather than
    // spinning on it forever.
    let pages: PageRecord[];
    let documentEnd: DocumentEndRecord | undefined;
    let documentTitle: string | undefined;
    let provenance: ExtractProvenance | undefined;
    try {
      const records = decodeRecords((batch.payload ?? Buffer.alloc(0)).toString("utf-8"));
      pages = records.filter(isPage);
      // The emitter (task 2.7) sends `document.end` as a trailing batch. When a
      // batch carries it, the builder emits the section/page/document summary
      // units from its summaries + outline; a page batch has none and only
      // yields chunk/table/figure units.
      documentEnd = records.find(isDocumentEnd);
      // The document title (task 3.3 header) rides on `document.begin` when a
      // batch carries it (the first batch). A later page batch has none, so the
      // title falls back to the reference below.
      const begin = records.find(isDocumentBegin);
      documentTitle = begin?.title;
      // Extract provenance (Requirement 18.2): taken from this batch's
      // document.begin when present, else from the revision row below.
      if (begin) provenance = extractProvenanceOf(begin);
    } catch (cause) {
      logger?.warn(
        { revisionId: batch.revision_id, seq: batch.seq, cause: String(cause) },
        "Batch payload no longer parses; marking processed with no units",
      );
      await markProcessed(client, batch);
      return { kind: "empty", revisionId: batch.revision_id, seq: batch.seq };
    }

    const documentId = batch.reference;
    const units = await buildUnitsFromRecords({
      revisionId: batch.revision_id,
      reference: batch.reference,
      documentId,
      pages,
      documentEnd,
      tokenCounter,
      minChunkTokens,
      maxChunkTokens,
    });

    const table = collectionTableName(batch.collection);

    if (units.length === 0) {
      // A batch can carry no units yet still carry identifiers: the trailing
      // `document.end` batch's summary units are only built when it has
      // summaries, but its identifier index must still be recorded (task 3.4,
      // Req 12.2). Index them, then mark processed. When there is nothing at all
      // to do, report empty as before.
      if (documentEnd && documentEnd.identifiers.length > 0) {
        await indexIdentifiers(client, table, batch, documentEnd);
        await markProcessed(client, batch);
        return { kind: "processed", revisionId: batch.revision_id, seq: batch.seq, units: 0 };
      }
      await markProcessed(client, batch);
      return { kind: "empty", revisionId: batch.revision_id, seq: batch.seq };
    }

    // Prepend the contextual header (task 3.3) to each chunk/table/figure unit's
    // embed input BEFORE embedding, so the vector reflects the header. The
    // header goes on embedInput only, never `content`/FTS. When CONTEXTUAL_CHUNK_LLM
    // is on and a summary client is present, a per-chunk placement sentence is
    // folded in; a text-LLM failure degrades to the header without it.
    // The revision's ACL and document attributes; its persisted title also
    // heads the batches that carry no document.begin of their own.
    const acl = await loadRevisionAcl(client, batch);

    await applyContextualHeaders(units, {
      documentTitle: documentTitle ?? acl.info.title ?? acl.info.email?.subject ?? batch.reference,
      budgetTokens: maxChunkTokens,
      maxFraction: contextHeaderMaxFraction,
      tokenCounter,
      ...(summaryClient ? { placementLlm: summaryClient } : {}),
      contextualChunkLlm,
      onLlmDegrade: (unitId, reason) =>
        logger?.debug(
          { unitId, reason },
          "CONTEXTUAL_CHUNK_LLM placement sentence unavailable; using header without it",
        ),
    });

    // Selective re-embedding (task 5.4, requirement 9.6). Before embedding, look
    // up each incoming unit's currently-stored section_path + content + vector
    // (batched). A unit whose section_path AND content are unchanged reuses its
    // stored vector and its embed call is SKIPPED — the metadata fix from the
    // Extract finalize pass must not re-embed the whole document. A new unit, or
    // one whose path or content changed, is embedded. A failure here throws and
    // the caller rolls back + defers, so no unit is ever committed for a failed
    // batch.
    const tableExists =
      (await client.query<{ t: string | null }>(`SELECT to_regclass($1) AS t`, [`"${table}"`])).rows[0]?.t != null;
    const vectors = await resolveVectors(client, table, batch, units, tableExists);
    if (!tableExists) {
      // First batch for a new collection: create it now that the vector size
      // is known, before anything is written into it.
      const vectorSize = vectors[0]?.length ?? 0;
      const ensured = options.ensureCollection
        ? await options.ensureCollection(batch.collection, vectorSize)
        : { ok: false as const, error: { message: "no collection bootstrap configured" } };
      if (!ensured.ok) {
        throw new Error(`Collection "${batch.collection}" does not exist and could not be created: ${ensured.error.message}`);
      }
      logger?.info({ collection: batch.collection, vectorSize }, "Created collection for the first v2 batch");
    }

    // Visibility decision under FOR SHARE on the revision row (see header). A
    // revision aborted / superseded meanwhile gets no units: roll back, the
    // cascade (abort) or nobody (superseded) owns the batch from here.
    const ctx = await loadUnitVisibilityContext(client, {
      tenantId: batch.tenant_id,
      collection: batch.collection,
      revisionId: batch.revision_id,
    });
    if (!ctx || ctx.status === "aborted" || ctx.status === "superseded") {
      throw new SkipBatch(ctx ? `revision is ${ctx.status}` : "revision no longer exists");
    }

    // Later batches carry no document.begin: use the provenance the revision
    // store persisted when the batch holding it was staged.
    provenance ??= await loadExtractProvenance(client, batch);

    const lang = await loadFtsLanguage(client, table);
    for (const [unit, vector] of zip(units, vectors)) {
      await upsertUnit(
        client,
        table,
        lang,
        vecType,
        batch,
        unit,
        vector,
        ctx,
        acl,
        provenance,
        ftsContextualHeader,
      );
    }

    // Identifier occurrence index (task 3.4, Requirement 12.2). The trailing
    // `document.end` batch carries the document-wide identifier index (found by
    // the Extract doc pass, task 2.6). Each occurrence names a block; map that
    // block to the v2 unit that contains it (its block_ids array) and record one
    // vs_identifiers row per (value_norm, unit, page) so the query side can turn
    // a recognised identifier into the third RRF list. Runs inside the same
    // transaction as the unit upserts.
    if (documentEnd && documentEnd.identifiers.length > 0) {
      await indexIdentifiers(client, table, batch, documentEnd);
    }

    await markProcessed(client, batch);
    return {
      kind: "processed",
      revisionId: batch.revision_id,
      seq: batch.seq,
      units: units.length,
    };
  }

  /**
   * The shared identifier table is a GLOBAL migration (v6), but a worker may run
   * against a database where it has not been applied yet (or a test that only
   * ensured the collection/revision schema). Ensure it ONCE per worker, outside
   * any processing transaction — running DDL inside the batch transaction, per
   * batch, raced parallel workers on CREATE TABLE and could deadlock against a
   * migration holding the schema-DDL lock.
   */
  let identifiersReady: Promise<void> | null = null;
  async function ensureIdentifiersOnce(): Promise<void> {
    if (!identifiersReady) {
      identifiersReady = (async () => {
        const client = await pool.connect();
        try {
          // Catalog check first: the idempotent DDL still takes table locks,
          // so skip it entirely when the table and its indexes exist.
          const present = await client.query<{ ok: boolean | null }>(
            `SELECT to_regclass('vs_identifiers') IS NOT NULL
                AND to_regclass('idx_vs_identifiers_lookup') IS NOT NULL
                AND to_regclass('idx_vs_identifiers_unit') IS NOT NULL AS ok`,
          );
          if (present.rows[0]?.ok !== true) await ensureIdentifiersTable(client);
        } finally {
          client.release();
        }
      })().catch((err: unknown) => {
        identifiersReady = null;
        throw err;
      });
    }
    return identifiersReady;
  }

  /**
   * Claim the oldest ready batch in a SHORT transaction of its own: SKIP LOCKED
   * lets other workers move on to a different row; the claim sets
   * status='processing', a new lease token and `next_attempt_at` to the lease
   * expiry. Committing the claim makes the lease durable: if this worker dies
   * or cannot write the deferral, the batch is reclaimed after the lease
   * instead of immediately (no hot loop). A 'processing' batch whose lease has
   * expired is claimable again.
   */
  async function claimBatch(client: PoolClient, now: Date): Promise<ClaimedBatchRow | null> {
    await client.query("BEGIN");
    try {
      const claim = await client.query<Omit<ClaimedBatchRow, "lease_token">>(
        `SELECT b.tenant_id, b.collection, b.revision_id, b.seq, r.reference,
                b.payload, b.page_start, b.page_end
           FROM ${BATCHES} b
           JOIN vs_revisions r
             ON r.tenant_id = b.tenant_id
            AND r.collection = b.collection
            AND r.revision_id = b.revision_id
          WHERE ((b.status = 'received' AND (b.next_attempt_at IS NULL OR b.next_attempt_at <= $1))
              OR (b.status = 'processing' AND b.next_attempt_at IS NOT NULL AND b.next_attempt_at <= $1))
            AND r.status NOT IN ('aborted', 'superseded')
            AND ($2::text IS NULL OR b.tenant_id = $2)
          ORDER BY b.next_attempt_at NULLS FIRST, b.created, b.seq
          FOR UPDATE OF b SKIP LOCKED
          LIMIT 1`,
        [now, onlyTenantId ?? null],
      );
      const row = claim.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      const leaseToken = randomUUID();
      await client.query(
        `UPDATE ${BATCHES}
            SET status = 'processing', lease_token = $5, next_attempt_at = $6,
                attempts = attempts + 1, modified = NOW()
          WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3 AND seq = $4`,
        [row.tenant_id, row.collection, row.revision_id, row.seq, leaseToken, new Date(now.getTime() + leaseMs)],
      );
      await client.query("COMMIT");
      return { ...row, lease_token: leaseToken };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  /** Complete an accepted final commit this batch may have unblocked. */
  async function finalizeAfter(batch: ClaimedBatchRow): Promise<void> {
    try {
      await finalizeRevision(pool, {
        tenantId: batch.tenant_id,
        collection: batch.collection,
        revisionId: batch.revision_id,
      });
    } catch (err) {
      // Not lost: the intent / cleanup marker is durable and the idle sweep
      // (or a replayed commit) resumes the switch.
      logger?.warn(
        { err, revisionId: batch.revision_id },
        "Deferred final commit could not complete yet; it will be resumed",
      );
    }
  }

  async function tick(now: Date = new Date()): Promise<TickOutcome> {
    const started = performance.now();
    const outcome = await tickOnce(now);
    if (onTick) {
      try {
        await onTick(outcome, performance.now() - started);
      } catch (err) {
        logger?.warn({ err }, "Batch worker onTick observer failed");
      }
    }
    return outcome;
  }

  async function tickOnce(now: Date): Promise<TickOutcome> {
    try {
      await ensureIdentifiersOnce();
    } catch (cause) {
      return { kind: "error", message: cause instanceof Error ? cause.message : String(cause) };
    }
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (cause) {
      return { kind: "error", message: cause instanceof Error ? cause.message : "db unreachable" };
    }
    let batch: ClaimedBatchRow | null = null;
    let outcome: TickOutcome;
    try {
      batch = await claimBatch(client, now);
      if (!batch) {
        outcome = { kind: "idle" };
      } else {
        await client.query("BEGIN");
        try {
          // Fence on the lease: a batch reclaimed by another worker after our
          // lease expired (or deleted by an abort) must not be written by us.
          const fenced = await client.query<{ lease_token: string | null; status: string }>(
            `SELECT lease_token, status FROM ${BATCHES}
              WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3 AND seq = $4
              FOR UPDATE`,
            [batch.tenant_id, batch.collection, batch.revision_id, batch.seq],
          );
          const current = fenced.rows[0];
          if (current?.status !== "processing" || current.lease_token !== batch.lease_token) {
            throw new SkipBatch("lease lost");
          }
          outcome = await processClaimed(client, batch);
          await client.query("COMMIT");
        } catch (cause) {
          await client.query("ROLLBACK").catch(() => {});
          if (cause instanceof SkipBatch) {
            outcome = { kind: "skipped", revisionId: batch.revision_id, seq: batch.seq, reason: cause.message };
          } else {
            // Everything (units + status) is rolled back. Return the batch to
            // 'received' with a backoff so it is retried later (Req 5.4).
            const reason = cause instanceof Error ? cause.message : String(cause);
            await deferBatch(pool, batch, new Date(now.getTime() + backoffMs), logger);
            outcome = { kind: "deferred", revisionId: batch.revision_id, seq: batch.seq, reason };
          }
        }
      }
    } catch (cause) {
      await client.query("ROLLBACK").catch(() => {});
      outcome = { kind: "error", message: cause instanceof Error ? cause.message : String(cause) };
    } finally {
      client.release();
    }

    if (batch && (outcome.kind === "processed" || outcome.kind === "empty")) {
      await finalizeAfter(batch);
    } else if (outcome.kind === "idle") {
      // Resume switches interrupted by a crash / failed flip, and commits whose
      // last batch was finished by a worker that died before finalizing.
      try {
        await finalizePendingCommits(pool, onlyTenantId ? { onlyTenantId } : {});
      } catch (err) {
        logger?.warn({ err }, "Resuming pending final commits failed; will retry");
      }
    }
    return outcome;
  }

  async function drain(max = 1000): Promise<TickOutcome[]> {
    const outcomes: TickOutcome[] = [];
    for (let i = 0; i < max; i++) {
      if (stopped) break;
      const outcome = await tick();
      outcomes.push(outcome);
      if (outcome.kind === "idle" || outcome.kind === "error") break;
    }
    return outcomes;
  }

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let stopped = false;
  if (intervalMs > 0) {
    timer = setInterval(() => {
      // Guard against overlapping ticks when a batch takes longer than the poll.
      if (running) return;
      running = true;
      // Work through the backlog before sleeping again (see maxBatchesPerPoll).
      void drain(maxBatchesPerPoll)
        .catch((err) => logger?.warn({ err }, "Batch worker tick failed"))
        .finally(() => {
          running = false;
        });
    }, intervalMs);
    timer.unref?.();
  }

  return {
    tick,
    drain,
    stop(): void {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

// ─── Internal SQL helpers ───────────────────────────────────────────────────

/** Pair each unit with its vector; lengths are guaranteed equal by embedAll. */
function zip(units: IndexUnit[], vectors: number[][]): Array<[IndexUnit, number[]]> {
  const pairs: Array<[IndexUnit, number[]]> = [];
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const vector = vectors[i];
    if (unit && vector) pairs.push([unit, vector]);
  }
  return pairs;
}

/**
 * Thrown inside the processing transaction when the batch must not be written
 * (lease lost, revision aborted / superseded). The tick rolls back WITHOUT a
 * deferral: the batch belongs to someone else now.
 */
class SkipBatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkipBatch";
  }
}

/** Thrown when the embedding service fails, so the tick defers the batch. */
class EmbeddingFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingFailure";
  }
}

/** The stored facts a unit's re-embed decision compares against. */
interface StoredUnitRow {
  sectionPath: string[];
  content: string;
  /** pgvector text rendering (`[1,2,3]`) of the stored embedding, or null. */
  vector: string | null;
}

/**
 * Batch-load the currently-stored `section_path`, `content` and `vector` for a
 * set of incoming unit ids, keyed by `unit_id` (task 5.4, requirement 9.6). One
 * query for the whole batch — the lookup that lets the worker skip the embed
 * call for units whose path and content are unchanged. The vector is read as
 * text (`vector::text`) so a reused embedding round-trips through the same
 * `::vector`/`::halfvec` cast the upsert uses. Scoped to the tenant and to
 * `unit_id IS NOT NULL` so it only ever matches v2 units.
 */
async function loadStoredUnitFacts(
  client: PoolClient,
  table: string,
  tenantId: string,
  units: IndexUnit[],
): Promise<Map<string, StoredUnitRow>> {
  const result = new Map<string, StoredUnitRow>();
  const unitIds = units.map((u) => u.unitId).filter((id): id is string => typeof id === "string" && id !== "");
  if (unitIds.length === 0) return result;

  const rows = await client.query<{
    unit_id: string;
    section_path: string[] | null;
    content: string | null;
    vector: string | null;
  }>(
    `SELECT unit_id, section_path, content, vector::text AS vector
       FROM "${table}"
      WHERE tenant_id = $1 AND unit_id = ANY($2::text[])`,
    [tenantId, unitIds],
  );
  for (const row of rows.rows) {
    result.set(row.unit_id, {
      sectionPath: row.section_path ?? [],
      content: row.content ?? "",
      vector: row.vector,
    });
  }
  return result;
}

/**
 * The Extract provenance persisted on the revision row when the batch carrying
 * `document.begin` was staged (Requirement 18.2). Undefined when that batch has
 * not been staged yet or predates the column — units then simply omit it.
 */
async function loadExtractProvenance(
  client: PoolClient,
  batch: ClaimedBatchRow,
): Promise<ExtractProvenance | undefined> {
  const res = await client.query<{ extract_provenance: unknown }>(
    `SELECT extract_provenance FROM vs_revisions
      WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3`,
    [batch.tenant_id, batch.collection, batch.revision_id],
  );
  return parseExtractProvenance(res.rows[0]?.extract_provenance);
}

/**
 * The row ACL the revision was created with (vs_revisions.allowed_users /
 * allowed_groups). Every unit carries it, so search, expansion and the asset
 * store (which checks readability through the unit rows) enforce it. A revision
 * created without one is readable by every reader of the collection.
 */
/**
 * The revision's row ACL and the document attributes its `document.begin`
 * carried (title, tags, metadata, link, source label — persisted in
 * `document_info` when the batch holding it was staged). Every unit row gets
 * them, so a v2 document answers title/tag/metadata filters like a v1 one.
 */
async function loadRevisionAcl(
  client: PoolClient,
  batch: ClaimedBatchRow,
): Promise<{ allowedUsers: string[]; allowedGroups: string[]; info: DocumentInfo }> {
  const res = await client.query<{
    allowed_users: string[] | null;
    allowed_groups: string[] | null;
    document_info: unknown;
  }>(
    `SELECT allowed_users, allowed_groups, document_info FROM vs_revisions
      WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3`,
    [batch.tenant_id, batch.collection, batch.revision_id],
  );
  const row = res.rows[0];
  return {
    allowedUsers: row?.allowed_users ?? [],
    allowedGroups: row?.allowed_groups ?? [],
    info: parseDocumentInfo(row?.document_info),
  };
}

/** Read the collection's FTS language for `to_tsvector`; default 'simple'. */
async function loadFtsLanguage(client: PoolClient, table: string): Promise<string> {
  const res = await client.query<{ fts_language: string }>(
    `SELECT fts_language FROM vs_collection_config WHERE collection_table = $1`,
    [table],
  );
  const lang = res.rows[0]?.fts_language ?? "simple";
  try {
    return validateFtsLanguage(lang);
  } catch {
    return "simple";
  }
}

/**
 * Upsert a single unit into the per-collection table on the (tenant_id, unit_id)
 * partial unique index (task 1.8). A deterministic `reference` derived from the
 * unit id keeps the (tenant_id, reference) unique index consistent with the unit
 * key, so both a reference collision and a unit_id collision resolve to the same
 * row on reprocessing (Requirement 5.5).
 */
async function upsertUnit(
  client: PoolClient,
  table: string,
  lang: string,
  vecType: "vector" | "halfvec",
  batch: ClaimedBatchRow,
  unit: IndexUnit,
  vector: number[],
  ctx: UnitVisibilityContext,
  acl: { allowedUsers: string[]; allowedGroups: string[]; info?: DocumentInfo },
  provenance?: ExtractProvenance,
  ftsContextualHeader = false,
): Promise<void> {
  const info = acl.info ?? {};
  const reference = `${batch.reference}#unit:${unit.unitId}`;
  // is_latest is decided NOW from the revision's state read under FOR SHARE
  // (see the module header): TRUE only when the document pointer names this
  // revision and it is committed, or it is `progressive` and the unit lies in a
  // committed segment. Otherwise FALSE, and the segment commit / final switch
  // that happens later flips it. The conflict update applies the same decision
  // (unit ids are per revision, so a conflict is a reprocess of this revision).
  const isLatest = isUnitVisible(ctx, unit.pageStart, unit.pageEnd);
  // section_id: prefer the unit's own (a section unit names its section), else
  // derive from the section path (a chunk/table/figure belongs to a section).
  const sectionId =
    unit.sectionId ??
    (unit.sectionPath.length > 0 ? unit.sectionPath.join("/") : null);
  // ts_ident (task 3.4, Requirement 12.1): a `simple`-config FTS vector of the
  // unit's identifiers, each collapsed to its canonical value_norm token so a
  // code like WE-01/A is tokenised verbatim rather than German-stemmed. Empty
  // string for a unit with no identifier → an empty vector that never matches.
  const identifierText = buildIdentifierText(unit.content);
  // FTS_CONTEXTUAL_HEADER (weight D): document title + section path indexed
  // alongside the content so title/section terms match every unit, not just
  // the one containing them. Empty header → plain content tsvector.
  const headerParts: string[] = [];
  const headerTitle = info.title ?? info.email?.subject;
  if (headerTitle) headerParts.push(headerTitle);
  if (unit.sectionPath.length > 0) headerParts.push(unit.sectionPath.join(" \u203a "));
  const ftsHeader =
    ftsContextualHeader && headerParts.length > 0
      ? prepareFtsContent(headerParts.join("\n"))
      : "";
  const tsSearchSql = ftsHeader
    ? `setweight(to_tsvector('${lang}', $30), 'D') || to_tsvector('${lang}', $4)`
    : `to_tsvector('${lang}', $4)`;
  // The header rides on $30 and is appended ONLY when the SQL references it:
  // Postgres rejects a bind whose parameter count exceeds the statement's.
  const sql = `INSERT INTO "${table}"
       (tenant_id, reference, base_ref, is_latest, content, vector, ts_search, ts_ident,
        metadata, unit_id, unit_type, revision_id, section_id, section_path,
        page_start, page_end, figure_kind, document_id,
        parent_unit_id, prev_unit_id, next_unit_id, block_ids, figure_refs, table_id,
        allowed_users, allowed_groups, title, tags, link, source)
     VALUES ($1, $2, $3, $23, $4, $5::${vecType}, ${tsSearchSql}, to_tsvector('simple', $22),
             $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19, $20, $21, $24, $25, $26, $27::text[], $28, $29)
     ON CONFLICT (tenant_id, unit_id) WHERE unit_id IS NOT NULL DO UPDATE SET
       reference      = EXCLUDED.reference,
       base_ref       = EXCLUDED.base_ref,
       is_latest      = EXCLUDED.is_latest,
       content        = EXCLUDED.content,
       vector         = EXCLUDED.vector,
       ts_search      = EXCLUDED.ts_search,
       ts_ident       = EXCLUDED.ts_ident,
       metadata       = EXCLUDED.metadata,
       unit_type      = EXCLUDED.unit_type,
       revision_id    = EXCLUDED.revision_id,
       section_id     = EXCLUDED.section_id,
       section_path   = EXCLUDED.section_path,
       page_start     = EXCLUDED.page_start,
       page_end       = EXCLUDED.page_end,
       figure_kind    = EXCLUDED.figure_kind,
       document_id    = EXCLUDED.document_id,
       parent_unit_id = EXCLUDED.parent_unit_id,
       prev_unit_id   = EXCLUDED.prev_unit_id,
       next_unit_id   = EXCLUDED.next_unit_id,
       block_ids      = EXCLUDED.block_ids,
       figure_refs    = EXCLUDED.figure_refs,
       table_id       = EXCLUDED.table_id,
       allowed_users  = EXCLUDED.allowed_users,
       allowed_groups = EXCLUDED.allowed_groups,
       title          = EXCLUDED.title,
       tags           = EXCLUDED.tags,
       link           = EXCLUDED.link,
       source         = EXCLUDED.source,
       modified       = NOW()`;
  const params: unknown[] = [
      batch.tenant_id,
      reference,
      batch.reference,
      unit.content,
      JSON.stringify(vector),
      JSON.stringify({ ...(info.metadata ?? {}), ...buildMetadata(unit, provenance) }),
      unit.unitId,
      unit.unitType,
      batch.revision_id,
      sectionId,
      unit.sectionPath.length > 0 ? unit.sectionPath : null,
      unit.pageStart,
      unit.pageEnd,
      unit.figureKind ?? null,
      batch.reference,
      unit.parentUnitId ?? null,
      unit.prevUnitId ?? null,
      unit.nextUnitId ?? null,
      unit.blockIds.length > 0 ? unit.blockIds : null,
      unit.figureRefs && unit.figureRefs.length > 0 ? unit.figureRefs : null,
      unit.tableId ?? null,
      identifierText,
      isLatest,
      acl.allowedUsers,
      acl.allowedGroups,
      info.title ?? info.email?.subject ?? null,
      info.tags ?? [],
      info.link ?? null,
      info.sourceLabel ?? null,
  ];
  // $30: contextual header for ts_search, appended only when the SQL references it
  if (ftsHeader) params.push(ftsHeader);
  await client.query(sql, params);
}

/**
 * The metadata JSONB stored on a unit row. The filter-relevant fields live in
 * real columns (design §6.2); this mirror carries the same coordinates plus the
 * relationship graph so a result row is self-describing without a column join.
 * The Extract provenance of the revision (Requirement 18.2) rides along as
 * `extract_contract` / `extract_pipeline_version` / `extract_prompt_hash` so two
 * ingests of the same document are comparable per unit.
 */
export function buildMetadata(
  unit: IndexUnit,
  provenance?: ExtractProvenance,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    unit_type: unit.unitType,
    page_start: unit.pageStart,
    page_end: unit.pageEnd,
    // Reading order within a block group (DOCUMENT_ORDER_SQL).
    ordinal: unit.ordinal,
  };
  if (unit.displayLen !== undefined) meta.display_len = unit.displayLen;
  if (provenance) {
    meta.extract_contract = provenance.contract;
    if (provenance.pipelineVersion) meta.extract_pipeline_version = provenance.pipelineVersion;
    if (provenance.promptHash) meta.extract_prompt_hash = provenance.promptHash;
  }
  if (unit.sectionPath.length > 0) meta.section_path = unit.sectionPath;
  if (unit.sectionId) meta.section_id = unit.sectionId;
  if (unit.blockIds.length > 0) meta.block_ids = unit.blockIds;
  if (unit.parentUnitId) meta.parent_unit_id = unit.parentUnitId;
  if (unit.prevUnitId) meta.prev_unit_id = unit.prevUnitId;
  if (unit.nextUnitId) meta.next_unit_id = unit.nextUnitId;
  if (unit.figureRefs && unit.figureRefs.length > 0) {
    meta.figure_refs = unit.figureRefs;
  }
  if (unit.unitType === "figure") {
    meta.modality = "image";
    if (unit.figureId) meta.figure_id = unit.figureId;
    if (unit.figureKind) meta.figure_kind = unit.figureKind;
    if (unit.assetId) meta.asset_id = unit.assetId;
  }
  if (unit.unitType === "table" && unit.tableId) {
    meta.table_id = unit.tableId;
  }
  return meta;
}

/**
 * Index the document's identifiers (from a trailing `document.end` batch) into
 * the shared `vs_identifiers` table (task 3.4, Requirement 12.2).
 *
 * Each `IdentifierEntry` carries occurrences that name a *block*; the v2 units
 * that hold those blocks were written in earlier page batches and record their
 * source block ids in the `block_ids` column. So for every occurrence we look up
 * the units of THIS revision whose `block_ids` contains the occurrence's block,
 * and record one `(value_norm, unit_id, page, kind)` row per (identifier, unit,
 * page). The `value` from either side is run through {@link normalizeIdentifier}
 * so ingest and query agree on equality.
 *
 * The rows for this document's units are deleted first (scoped to the revision's
 * unit ids) so a reprocessed `document.end` replaces the set in place rather
 * than accumulating duplicates — idempotent like the unit upsert (Req 5.5).
 * When an occurrence has no block id, or its block resolves to no unit yet, it
 * is simply skipped; a later reprocess (once the page batch is indexed) picks
 * it up. All within the caller's transaction.
 */
async function indexIdentifiers(
  client: PoolClient,
  table: string,
  batch: ClaimedBatchRow,
  documentEnd: DocumentEndRecord,
): Promise<void> {
  // vs_identifiers is ensured once per worker before the processing
  // transaction starts (see ensureIdentifiersOnce), never here per batch.

  // The units of this revision/document, with their source block ids. Clearing
  // and rebuilding is scoped to these unit ids so other documents in the same
  // collection are untouched.
  const unitRows = await client.query<{ unit_id: string; block_ids: string[] | null }>(
    `SELECT unit_id, block_ids FROM "${table}"
      WHERE tenant_id = $1 AND revision_id = $2 AND unit_id IS NOT NULL`,
    [batch.tenant_id, batch.revision_id],
  );
  if (unitRows.rows.length === 0) return;

  // block id → unit ids that carry it. A block can appear in one unit normally,
  // but a Map of arrays keeps the mapping correct if it ever appears in several.
  const unitIdsByBlock = new Map<string, string[]>();
  const revisionUnitIds: string[] = [];
  for (const row of unitRows.rows) {
    revisionUnitIds.push(row.unit_id);
    for (const blockId of row.block_ids ?? []) {
      const list = unitIdsByBlock.get(blockId) ?? [];
      list.push(row.unit_id);
      unitIdsByBlock.set(blockId, list);
    }
  }

  // Replace this document's identifier rows in place.
  await client.query(
    `DELETE FROM vs_identifiers
      WHERE tenant_id = $1 AND collection = $2 AND unit_id = ANY($3::text[])`,
    [batch.tenant_id, batch.collection, revisionUnitIds],
  );

  // Accumulate the distinct (value_norm, unit_id, page, kind) rows to insert.
  const seen = new Set<string>();
  const values: Array<[string, string, string, string, number, string]> = [];
  for (const entry of documentEnd.identifiers) {
    const valueNorm = normalizeIdentifier(entry.value);
    if (valueNorm === "") continue;
    for (const occ of entry.occurrences) {
      if (occ.blockId === undefined) continue;
      const unitIds = unitIdsByBlock.get(occ.blockId);
      if (!unitIds) continue;
      for (const unitId of unitIds) {
        const key = `${valueNorm}\u0000${unitId}\u0000${occ.page}`;
        if (seen.has(key)) continue;
        seen.add(key);
        values.push([
          batch.tenant_id,
          batch.collection,
          valueNorm,
          unitId,
          occ.page,
          entry.kind,
        ]);
      }
    }
  }
  if (values.length === 0) return;

  // One multi-row INSERT. ON CONFLICT DO NOTHING guards the primary key so a
  // concurrent/duplicate write is a no-op rather than an error.
  const params: unknown[] = [];
  const tuples = values.map((v, i) => {
    const base = i * 6;
    params.push(v[0], v[1], v[2], v[3], v[4], v[5]);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  });
  await client.query(
    `INSERT INTO vs_identifiers (tenant_id, collection, value_norm, unit_id, page, kind)
     VALUES ${tuples.join(", ")}
     ON CONFLICT (tenant_id, collection, value_norm, unit_id, page) DO NOTHING`,
    params,
  );
}

/** Mark a claimed batch processed, clear the lease/backoff (fenced on the lease). */
async function markProcessed(client: PoolClient, batch: ClaimedBatchRow): Promise<void> {
  await client.query(
    `UPDATE ${BATCHES}
        SET status = 'processed', next_attempt_at = NULL, lease_token = NULL, modified = NOW()
      WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3 AND seq = $4
        AND lease_token = $5`,
    [batch.tenant_id, batch.collection, batch.revision_id, batch.seq, batch.lease_token],
  );
}

/**
 * Return a batch to 'received' with a backoff after a failed tick. Runs on its
 * OWN connection (the processing tx was rolled back) and is fenced on this
 * worker's lease token, so it never touches a batch another worker reclaimed.
 *
 * If the deferral write itself fails, the batch simply keeps the committed
 * claim: status='processing' with `next_attempt_at` = lease expiry. It becomes
 * claimable again once the lease elapses — no hot loop, no lost batch.
 */
async function deferBatch(
  pool: Pool,
  batch: ClaimedBatchRow,
  nextAttemptAt: Date,
  logger?: Logger,
): Promise<void> {
  try {
    await pool.query(
      `UPDATE ${BATCHES}
          SET status = 'received', next_attempt_at = $5, lease_token = NULL, modified = NOW()
        WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3 AND seq = $4
          AND lease_token = $6`,
      [batch.tenant_id, batch.collection, batch.revision_id, batch.seq, nextAttemptAt, batch.lease_token],
    );
  } catch (err) {
    logger?.error(
      { err, revisionId: batch.revision_id, seq: batch.seq },
      "Failed to defer batch; it is retried after its lease expires",
    );
  }
}
