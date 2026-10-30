// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Operator audit log (`src/observability/audit-log.ts`)
 *
 * Records every consequential action on the operator plane — who (actor +
 * role), what (action + target), when, and the outcome — so a deployment has an
 * accountable trail of flow publishes/rollbacks/deletes, tool-call approvals and
 * denials, and time-travel replays. Reads back via `GET /monitoring/audit`.
 *
 * Two backends behind one interface: an in-memory ring (always on, per replica)
 * and a durable Postgres `audit_log` table (cross-replica, survives restarts)
 * when a database is configured. Recording is best-effort and never throws into
 * the request path — an audit write failure must not fail the operation it logs.
 *
 * No `any` at module boundaries.
 */

import { createHash, createHmac } from "node:crypto";
import { canonicalJsonValue } from "@atf/canonical-json";
import type { Database } from "../db/database.js";
import {
  signEvidenceBytes,
  verifyEvidenceBytes,
  type Ed25519EvidenceKey,
} from "./evidence-key.js";
import type { Logger } from "./logger.js";

export interface AuditEntry {
  actor: string;
  role?: string;
  /** Dotted action id, e.g. "flows.publish", "approvals.resolve", "replay.run". */
  action: string;
  /** What was acted on (flow id, approval id, execution id, …). */
  target?: string;
  outcome?: "success" | "denied" | "error";
  details?: Record<string, unknown>;
}

export interface AuditRecord extends AuditEntry {
  id: number;
  at: string;
  /**
   * SHA-256 hash chaining this record to the one before it:
   * `hash = SHA256(prevHash + canonicalize(this record's AuditEntry fields + id + at))`.
   * Tamper-evidence: changing (or deleting/reordering) any historical record
   * changes its hash, which no longer matches the `prevHash` the NEXT record
   * was chained against — {@link verifyAuditChain} surfaces exactly that
   * mismatch. This is integrity verification, not encryption or non-repudiation
   * (no external anchoring by itself proves the chain wasn't rebuilt from
   * scratch — see {@link AuditChainAnchor} for that additional guarantee).
   */
  hash: string;
  /** Hash of the previous record in the chain, or the fixed genesis value for the first record. */
  prevHash: string;
}

export interface AuditQuery {
  limit?: number;
  /** Filter by actor name. */
  actor?: string;
  /** Filter by action prefix (e.g. "flows."). */
  actionPrefix?: string;
}

export interface AuditLog {
  /** Records an entry (best-effort; never throws). */
  record(entry: AuditEntry): void;
  /**
   * Records an entry and resolves ONLY once it is durably persisted; throws
   * when persisting fails. Required for Regulierte_Aktionen (flow publish,
   * approvals, DSAR erasure, key rotation, tenant deletion, …) where the
   * operation must not complete without its audit trail — the caller maps a
   * rejection to HTTP 503 `AUDIT_UNAVAILABLE` (Req 1.4).
   */
  recordRequired(entry: AuditEntry): Promise<void>;
  /** Returns recent entries, newest first. */
  list(query?: AuditQuery): Promise<AuditRecord[]>;
  /**
   * Fetches a single record by its id (targeted lookup — does not depend on a
   * bounded newest-first page). Used by external anchoring to re-verify the
   * anchored tip regardless of how many records have accrued since. Optional on
   * the interface; callers fall back to a scan when absent.
   */
  getById?(id: number): Promise<AuditRecord | undefined>;
  /**
   * Verifies the hash chain over the full history (or the last `limit`
   * records, when provided — see the caveat on partial verification in
   * {@link verifyAuditChain}'s doc comment). Fetches records in ASCENDING id
   * order internally regardless of `list()`'s newest-first ordering.
   */
  verifyChain(limit?: number): Promise<AuditChainVerification>;
  /**
   * Resolves once every `record()` call issued so far has been durably
   * persisted (or has failed and been logged). `record()` is deliberately
   * fire-and-forget on the request path; `flush()` exists for tests and
   * graceful-shutdown paths that need a synchronization point. Optional on
   * the interface — the in-memory backend has nothing to flush.
   */
  flush?(): Promise<void>;
  /**
   * Number of best-effort `record()` writes queued but not yet settled
   * (persisted or failed). Used by the shutdown flush to report how many
   * entries were still unpersisted when the timeout hit (Req 1.6). Optional
   * on the interface — backends without a write queue report nothing.
   */
  pendingWrites?(): number;
  /**
   * Number of failed durable writes since process start — the source for the
   * `aiperator_audit_write_failures_total` metric and the readiness hint
   * (Req 1.9). Optional on the interface.
   */
  writeFailures?(): number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function matches(rec: AuditRecord, q?: AuditQuery): boolean {
  if (q === undefined) return true;
  if (q.actor !== undefined && rec.actor !== q.actor) return false;
  if (q.actionPrefix !== undefined && !rec.action.startsWith(q.actionPrefix))
    return false;
  return true;
}

// ---------------------------------------------------------------------------
// Hash chain
// ---------------------------------------------------------------------------

/**
 * Fixed hash used as `prevHash` for the very first record in a chain — makes
 * the genesis record verifiable the same way as every subsequent one (no
 * special-cased "id === 1" branch in {@link verifyAuditChain}).
 */
export const AUDIT_CHAIN_GENESIS_HASH = "0".repeat(64);

// The recursive key-sorting canonical structure (`undefined` members dropped,
// arrays kept in order — JSON arrays are ordered data, and Postgres `jsonb`
// preserves array order too) is `@atf/canonical-json`'s structure form, byte-
// identical to the former local helper (proven by
// `packages/canonical-json/test/differential.test.ts`) because these bytes
// back the durable audit chain hash.
const canonicalJson = canonicalJsonValue;

/**
 * Deterministic, field-order-independent serialization of the fields that go
 * into a record's hash. Using `JSON.stringify` on a fixed key order (rather
 * than the raw object) means the hash does not depend on how the caller built
 * the object — only its actual field VALUES.
 *
 * `details` is canonicalized recursively (sorted keys at every depth): the
 * durable backend stores it in a Postgres `jsonb` column, and `jsonb` does NOT
 * preserve key order — on read-back the driver returns the keys in jsonb's own
 * storage order, so a hash computed over the insertion-ordered object at write
 * time would no longer match the same record re-serialized after a round-trip.
 * That made {@link verifyAuditChain} report false `hash_mismatch` failures for
 * every record with nested details against Postgres. Sorting at hash time makes
 * write and read-back produce the same bytes.
 *
 * Compatibility: rows written BEFORE this canonicalization hashed `details` in
 * insertion order. Where jsonb's storage order happened to equal that order
 * (e.g. `{ to, from }` inserted shortest-key-first) they verified before the
 * change and would not verify under the sorted form. {@link verifyAuditChain}
 * therefore also accepts the legacy form (`details` hashed in as-read key
 * order) and reports how many rows needed it (`legacyForm`). Rows whose
 * insertion order differed from jsonb's order were false-positives before the
 * change as well and stay unverifiable — they cannot be told apart from
 * tampering. New writes always use the sorted form.
 */
function canonicalizeForHash(
  rec: Pick<AuditRecord, "id" | "at" | "actor" | "role" | "action" | "target" | "outcome" | "details">,
  form: "canonical" | "legacy" = "canonical",
): string {
  return JSON.stringify({
    id: rec.id,
    at: rec.at,
    actor: rec.actor,
    role: rec.role ?? null,
    action: rec.action,
    target: rec.target ?? null,
    outcome: rec.outcome ?? "success",
    // "legacy" is the pre-canonicalization form: `details` serialized in
    // whatever key order the caller / the database driver handed over. It is
    // only ever used to RECOGNIZE rows written before the fix (see
    // verifyAuditChain); every new hash is the canonical form.
    details:
      rec.details == null
        ? null
        : form === "canonical"
          ? canonicalJson(rec.details)
          : rec.details,
  });
}

/** Computes the SHA-256 chain hash for a record given the previous record's hash. */
export function computeAuditHash(
  prevHash: string,
  rec: Pick<AuditRecord, "id" | "at" | "actor" | "role" | "action" | "target" | "outcome" | "details">,
): string {
  return createHash("sha256")
    .update(prevHash)
    .update(canonicalizeForHash(rec))
    .digest("hex");
}

/**
 * The hash a record written BEFORE `details` was canonicalized would have been
 * stored with: the same chain construction over the as-read key order. Used
 * only by {@link verifyAuditChain} to keep valid pre-fix rows verifiable.
 */
function computeLegacyAuditHash(
  prevHash: string,
  rec: Pick<AuditRecord, "id" | "at" | "actor" | "role" | "action" | "target" | "outcome" | "details">,
): string {
  return createHash("sha256")
    .update(prevHash)
    .update(canonicalizeForHash(rec, "legacy"))
    .digest("hex");
}

export interface AuditChainVerifyOptions {
  /**
   * Id of the first row written in the canonical hash form. The legacy form is
   * accepted only for rows with a smaller id. Absent = no canonical row is
   * known (every row may be legacy); `0` = the history is canonical only.
   */
  legacyCutoffId?: number;
}

/** Key of the persisted cut-off in `audit_chain_meta`. */
export const AUDIT_CANONICAL_CUTOFF_KEY = "canonical_cutoff_id";

export interface AuditChainVerification {
  /** True when every record's stored hash matches its recomputed hash AND chains correctly to the previous one. */
  valid: boolean;
  /** Number of records verified. */
  checked: number;
  /**
   * The first record (in ascending id order) where verification failed, plus
   * why. `undefined` when `valid` is true.
   */
  brokenAt?: {
    id: number;
    reason: "hash_mismatch" | "prev_hash_mismatch" | "legacy_hash_after_cutoff";
  };
  /**
   * Human-readable reason, set for `legacy_hash_after_cutoff`:
   * `legacy hash form after cut-off at id <n>`.
   */
  message?: string;
  /**
   * Number of records that verified only under the pre-canonicalization hash
   * form (`details` hashed in as-stored key order). Such rows were written
   * before `details` was key-sorted for hashing; they are intact, but an
   * auditor should know that the count is non-zero. Omitted when zero.
   */
  legacyForm?: number;
}

/**
 * Walks a list of records in ASCENDING id order and verifies the hash chain:
 * each record's stored `hash` must equal `computeAuditHash(prevHash, record)`,
 * and its stored `prevHash` must equal the previous record's stored `hash`
 * (or {@link AUDIT_CHAIN_GENESIS_HASH} for the first record in the list).
 *
 * Pure function — no I/O. Callers (`AuditLog.verifyChain`) are responsible for
 * fetching the full ordered record set first.
 *
 * Note: verifying only a PAGE of records (rather than the full history from
 * the genesis record) can only detect tampering WITHIN that page — a
 * consistent rewrite of an entire early segment (recomputing every subsequent
 * hash to match) would not be caught without also verifying back to genesis or
 * checking against an external anchor (see {@link verifyAuditAnchor}).
 */
export function verifyAuditChain(
  records: readonly AuditRecord[],
  options: AuditChainVerifyOptions = {},
): AuditChainVerification {
  let expectedPrevHash: string | undefined;
  let legacyForm = 0;
  for (const rec of records) {
    if (computeAuditHash(rec.prevHash, rec) !== rec.hash) {
      // Rows written before `details` was canonicalized carry the hash of the
      // as-stored key order. Accept exactly that one alternative form (it is
      // as tamper-evident for every VALUE as the canonical one) and count it;
      // anything else is a genuine mismatch.
      if (computeLegacyAuditHash(rec.prevHash, rec) !== rec.hash) {
        return { valid: false, checked: records.length, brokenAt: { id: rec.id, reason: "hash_mismatch" } };
      }
      // From the cut-off on every row is canonical: a legacy-form hash there is
      // a row written after the fix that does not verify canonically.
      if (options.legacyCutoffId !== undefined && rec.id >= options.legacyCutoffId) {
        return {
          valid: false,
          checked: records.length,
          brokenAt: { id: rec.id, reason: "legacy_hash_after_cutoff" },
          message: `legacy hash form after cut-off at id ${rec.id}`,
        };
      }
      legacyForm++;
    }
    if (expectedPrevHash !== undefined && rec.prevHash !== expectedPrevHash) {
      return { valid: false, checked: records.length, brokenAt: { id: rec.id, reason: "prev_hash_mismatch" } };
    }
    expectedPrevHash = rec.hash;
  }
  return {
    valid: true,
    checked: records.length,
    ...(legacyForm > 0 ? { legacyForm } : {}),
  };
}

// ---------------------------------------------------------------------------
// External anchoring
// ---------------------------------------------------------------------------

export interface AuditChainAnchor {
  /** Id of the last record covered by this anchor. */
  uptoId: number;
  /** That record's chain hash (i.e. the tip of the chain at anchor time). */
  tipHash: string;
  /**
   * Signature over `tipHash`, base64url. HMAC-SHA256 under the operator secret
   * when {@link alg} is absent (legacy) or `"hmac-sha256"`; an Ed25519
   * signature when {@link alg} is `"ed25519"` (ADR 0030 — independently
   * verifiable via the published evidence JWKS, no shared secret needed).
   */
  signature: string;
  /** ISO timestamp the anchor was produced. */
  anchoredAt: string;
  /**
   * Signing algorithm. Absent on anchors produced before asymmetric anchoring
   * existed — treated as `"hmac-sha256"`.
   */
  alg?: "hmac-sha256" | "ed25519";
  /**
   * Key id (base64url SHA-256 thumbprint) of the Ed25519 evidence key that
   * produced {@link signature}. Only set when {@link alg} is `"ed25519"`.
   */
  kid?: string;
}

/**
 * Produces a signed anchor for the current tip of the chain — a periodic,
 * externally-stored (e.g. exported to a separate system, printed to an
 * append-only log shipper, or committed to a ticket) checkpoint that lets an
 * auditor detect a wholesale chain rewrite even if an attacker had database
 * write access long enough to recompute every hash consistently.
 *
 * With an {@link Ed25519EvidenceKey} (ADR 0030) the anchor is signed with
 * Ed25519 and stamped `alg: "ed25519"` + `kid`, so a third party can verify it
 * offline against the published evidence JWKS — no shared secret. With a plain
 * secret string the anchor is HMAC-SHA256 signed (legacy form, kept so
 * existing anchors and deployments keep working); that secret must be kept
 * OUTSIDE the database the audit log lives in, or anchoring provides no
 * additional guarantee over the hash chain alone.
 */
export function signAuditAnchor(
  tip: Pick<AuditRecord, "id" | "hash">,
  secretOrKey: string | Ed25519EvidenceKey,
): AuditChainAnchor {
  if (typeof secretOrKey === "string") {
    const signature = createHmac("sha256", secretOrKey)
      .update(tip.hash)
      .digest("base64url");
    return {
      uptoId: tip.id,
      tipHash: tip.hash,
      signature,
      anchoredAt: new Date().toISOString(),
    };
  }
  return {
    uptoId: tip.id,
    tipHash: tip.hash,
    signature: signEvidenceBytes(secretOrKey, tip.hash),
    anchoredAt: new Date().toISOString(),
    alg: "ed25519",
    kid: secretOrKey.kid,
  };
}

/**
 * Verifies a previously-produced anchor against the CURRENT chain: the record
 * at `anchor.uptoId` must still exist and its stored hash must still equal
 * `anchor.tipHash`, and the anchor's signature must still verify. A mismatch
 * means the chain was altered after the anchor was taken (or the wrong
 * key/secret/anchor was supplied).
 *
 * Dual-algorithm (ADR 0030): an anchor with `alg: "ed25519"` verifies against
 * the Ed25519 evidence public key (or key) — `secretOrKey` may be the raw
 * 32-byte public key, making this callable by an independent auditor with no
 * secret at all. A legacy anchor (no `alg` / `"hmac-sha256"`) verifies under
 * the shared secret. An algorithm the supplied key material cannot check is
 * reported as `signature_mismatch`.
 */
export function verifyAuditAnchor(
  anchor: AuditChainAnchor,
  currentTipAtAnchorId: Pick<AuditRecord, "id" | "hash"> | undefined,
  secretOrKey: string | Ed25519EvidenceKey | Uint8Array,
): {
  valid: boolean;
  reason?: "record_not_found" | "hash_mismatch" | "signature_mismatch";
} {
  if (currentTipAtAnchorId === undefined) {
    return { valid: false, reason: "record_not_found" };
  }
  if (currentTipAtAnchorId.hash !== anchor.tipHash) {
    return { valid: false, reason: "hash_mismatch" };
  }
  const alg = anchor.alg ?? "hmac-sha256";
  if (alg === "ed25519") {
    const publicKey =
      typeof secretOrKey === "string"
        ? undefined
        : secretOrKey instanceof Uint8Array
          ? secretOrKey
          : secretOrKey.publicKeyRaw;
    if (publicKey === undefined) {
      return { valid: false, reason: "signature_mismatch" };
    }
    if (
      anchor.kid !== undefined &&
      typeof secretOrKey !== "string" &&
      !(secretOrKey instanceof Uint8Array) &&
      secretOrKey.kid !== anchor.kid
    ) {
      return { valid: false, reason: "signature_mismatch" };
    }
    if (!verifyEvidenceBytes(publicKey, anchor.tipHash, anchor.signature)) {
      return { valid: false, reason: "signature_mismatch" };
    }
    return { valid: true };
  }
  // Legacy HMAC anchors need the shared secret; Ed25519 key material cannot
  // check them.
  if (typeof secretOrKey !== "string") {
    return { valid: false, reason: "signature_mismatch" };
  }
  const expectedSig = createHmac("sha256", secretOrKey)
    .update(anchor.tipHash)
    .digest("base64url");
  if (expectedSig !== anchor.signature) {
    return { valid: false, reason: "signature_mismatch" };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// In-memory ring
// ---------------------------------------------------------------------------

export class InMemoryAuditLog implements AuditLog {
  private readonly entries: AuditRecord[] = [];
  private seq = 0;
  /** Tip hash of the chain — `undefined` before the first record. */
  private tipHash: string | undefined;

  constructor(private readonly maxEntries = 5000) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  record(entry: AuditEntry): void {
    const id = ++this.seq;
    const base = {
      id,
      at: new Date().toISOString(),
      outcome: "success" as const,
      ...entry,
    };
    const prevHash = this.tipHash ?? AUDIT_CHAIN_GENESIS_HASH;
    const hash = computeAuditHash(prevHash, base);
    this.tipHash = hash;
    this.entries.push({ ...base, hash, prevHash });
    while (this.entries.length > this.maxEntries) this.entries.shift();
  }

  async list(query?: AuditQuery): Promise<AuditRecord[]> {
    const limit = clampLimit(query?.limit);
    const out: AuditRecord[] = [];
    for (const rec of this.entries.toReversed()) {
      if (out.length >= limit) break;
      if (matches(rec, query)) out.push(rec);
    }
    return out;
  }

  async verifyChain(limit?: number): Promise<AuditChainVerification> {
    // `entries` is already stored in ascending-id order.
    const records =
      limit !== undefined ? this.entries.slice(-Math.max(1, limit)) : this.entries;
    // Every in-memory row is written in the canonical form.
    return verifyAuditChain(records, { legacyCutoffId: 0 });
  }

  async getById(id: number): Promise<AuditRecord | undefined> {
    return this.entries.find((e) => e.id === id);
  }

  /** The in-memory ring is written synchronously, so persisting cannot fail. */
  async recordRequired(entry: AuditEntry): Promise<void> {
    this.record(entry);
  }
}

// ---------------------------------------------------------------------------
// Postgres backend (durable) — mirrors writes to an in-memory ring for fast,
// always-available reads even during a brief DB outage.
// ---------------------------------------------------------------------------

interface AuditRow {
  id: number | string;
  actor: string;
  role: string | null;
  action: string;
  target: string | null;
  outcome: string;
  details: unknown;
  created_at: string | Date;
  hash: string;
  prev_hash: string;
}

function rowToRecord(r: AuditRow): AuditRecord {
  return {
    id: Number(r.id),
    actor: r.actor,
    ...(r.role !== null ? { role: r.role } : {}),
    action: r.action,
    ...(r.target !== null ? { target: r.target } : {}),
    outcome: (r.outcome as AuditRecord["outcome"]) ?? "success",
    ...(r.details != null ? { details: parseDetails(r.details) } : {}),
    at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    hash: r.hash,
    prevHash: r.prev_hash,
  };
}

export class PostgresAuditLog implements AuditLog {
  private readonly mirror = new InMemoryAuditLog(1000);

  /**
   * Invoked once per failed durable write (both best-effort `record()` and
   * rejecting `recordRequired()`). Wired to the
   * `aiperator_audit_write_failures_total` counter in bootstrap (Req 1.9).
   */
  onWriteFailure?: () => void;

  /** Best-effort writes queued but not yet settled — see {@link AuditLog.pendingWrites}. */
  private pending = 0;
  /** Failed durable writes since process start — see {@link AuditLog.writeFailures}. */
  private failures = 0;

  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
  ) {}

  pendingWrites(): number {
    return this.pending;
  }

  writeFailures(): number {
    return this.failures;
  }

  /**
   * Serializes writes within this process so two concurrent `record()` calls
   * cannot interleave their queue entries. Cross-process serialization (two
   * replicas) is provided by the transaction-level advisory lock in
   * {@link writeChainEntry} — the in-process queue only keeps local ordering
   * deterministic and is NOT the integrity mechanism.
   */
  private writeQueue: Promise<void> = Promise.resolve();

  record(entry: AuditEntry): void {
    this.pending += 1;
    this.writeQueue = this.writeQueue
      .catch(() => {
        /* a prior failure must not block subsequent writes */
      })
      .then(() =>
        this.writeChainEntry(entry).catch((err) => {
          this.failures += 1;
          this.onWriteFailure?.();
          this.logger?.warn("Failed to persist audit entry", {
            action: entry.action,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      )
      .finally(() => {
        this.pending -= 1;
      });
  }

  /**
   * Req 1.4: resolves only after the entry is durably persisted; throws on
   * failure so the caller can abort a Regulierte_Aktion with 503.
   */
  async recordRequired(entry: AuditEntry): Promise<void> {
    try {
      await this.writeChainEntry(entry);
    } catch (err) {
      this.failures += 1;
      this.onWriteFailure?.();
      // The caller only maps the rejection to 503 AUDIT_UNAVAILABLE; without
      // this log the cause (missing table, missing grant, DB outage) would be
      // invisible to the operator.
      this.logger?.error("Failed to persist required audit entry", {
        action: entry.action,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** Waits for every `record()` call issued so far to finish (success or logged failure). */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  /**
   * Req 1.1: tip read, ID allocation, hash computation and INSERT run in
   * ONE transaction under `pg_advisory_xact_lock`, so two replicas never
   * write against the same `prev_hash`. The tip cache is gone; the chain
   * is advanced only from the persisted state.
   *
   * Req 1.2/1.3: if the tip read fails, the write fails (the error is
   * thrown, not reset to genesis); the genesis hash is only used when the
   * table is provably empty (NULL after a LIMIT-1 SELECT inside the same
   * transaction).
   */
  private async writeChainEntry(entry: AuditEntry): Promise<void> {
    const exec = async (db: Database): Promise<void> => {
      await db.query("BEGIN");
      try {
        // Transactional advisory lock: serializes all chain writers across
        // all replicas; released automatically on COMMIT/ROLLBACK.
        await db.query(
          `SELECT pg_advisory_xact_lock(hashtext('atf:audit_log'))`,
        );
        const tipRows = await db.query<{ hash: string | null }>(
          `SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`,
        );
        const tipRow = tipRows[0];
        if (tipRows.length > 1 && tipRow === undefined) {
          // Unreachable defensively: a LIMIT-1 query returns 0 or 1 rows.
          throw new Error("Unexpected result reading the audit chain tip.");
        }
        // Genesis ONLY for a provably empty table (0 rows); a read ERROR
        // throws (no catch) and so prevents a silent new genesis chain
        // after an outage (Req 1.2/1.3).
        let prevHash: string;
        if (tipRow === undefined) {
          prevHash = AUDIT_CHAIN_GENESIS_HASH;
        } else if (tipRow.hash === null) {
          // A stored row without a hash means the chain is corrupted — refuse
          // to extend it rather than silently restarting from genesis.
          throw new Error(
            "Audit chain tip has no hash — refusing to extend a corrupted chain.",
          );
        } else {
          prevHash = tipRow.hash;
        }
        const idRows = await db.query<{ id: number | string }>(
          `SELECT nextval(pg_get_serial_sequence('audit_log', 'id')) AS id`,
        );
        const idRow = idRows[0];
        if (idRow === undefined) {
          // Unreachable: SELECT nextval(...) always returns exactly one row.
          throw new Error("Failed to reserve audit log id from sequence.");
        }
        const id = Number(idRow.id);
        const at = new Date().toISOString();
        const base = { id, at, outcome: entry.outcome ?? "success", ...entry };
        const hash = computeAuditHash(prevHash, base);
        // jsonb-cast-ok: `details` is stored as the JSON text it was hashed
        // from (a JSONB string scalar, read back by parseDetails). The chain
        // has rows in this form; it is never queried with JSON operators.
        await db.query(
          `INSERT INTO audit_log (id, actor, role, action, target, outcome, details, hash, prev_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
          [
            id,
            entry.actor,
            entry.role ?? null,
            entry.action,
            entry.target ?? null,
            entry.outcome ?? "success",
            entry.details !== undefined ? JSON.stringify(entry.details) : null,
            hash,
            prevHash,
            at,
          ],
        );
        // The first canonical row marks the end of the legacy hash form; later
        // writes keep the recorded value (ON CONFLICT DO NOTHING).
        await db.query(
          `INSERT INTO audit_chain_meta (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO NOTHING`,
          [AUDIT_CANONICAL_CUTOFF_KEY, String(id)],
        );
        await db.query("COMMIT");
      } catch (err) {
        try {
          await db.query("ROLLBACK");
        } catch {
          /* the rollback error must not mask the original error */
        }
        throw err;
      }
    };
    // Audit writes are operator-plane: run on the BYPASSRLS pool when one is
    // configured, and pin a single connection there (withConnection) so
    // BEGIN/…/COMMIT and the transaction-level advisory lock share one
    // session. Without either (tests, simple drivers) fall back to the plain
    // handle — the statement sequence is identical.
    const runPinned = (db: Database): Promise<void> =>
      db.withConnection !== undefined ? db.withConnection(exec) : exec(db);
    await (this.db.withOperator !== undefined
      ? this.db.withOperator((op) => runPinned(op))
      : runPinned(this.db));
    this.mirror.record(entry);
  }

  async list(query?: AuditQuery): Promise<AuditRecord[]> {
    const limit = clampLimit(query?.limit);
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query?.actor !== undefined) {
      params.push(query.actor);
      conditions.push(`actor = $${params.length}`);
    }
    if (query?.actionPrefix !== undefined) {
      params.push(`${query.actionPrefix}%`);
      conditions.push(`action LIKE $${params.length}`);
    }
    params.push(limit);
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    try {
      // Audit log reads are operator-plane (cross-tenant by design); run on the
      // BYPASSRLS pool so enforced RLS doesn't filter them to empty.
      const rows = await this.db.withOperator((db) =>
        db.query<AuditRow>(
          `SELECT id, actor, role, action, target, outcome, details, created_at, hash, prev_hash
             FROM audit_log ${where}
            ORDER BY id DESC
            LIMIT $${params.length}`,
          params,
        ),
      );
      return rows.map(rowToRecord);
    } catch (err) {
      this.logger?.warn("Audit query failed; serving in-memory mirror", {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.mirror.list(query);
    }
  }

  async getById(id: number): Promise<AuditRecord | undefined> {
    try {
      const rows = await this.db.withOperator((db) =>
        db.query<AuditRow>(
          `SELECT id, actor, role, action, target, outcome, details, created_at, hash, prev_hash
             FROM audit_log WHERE id = $1`,
          [id],
        ),
      );
      const row = rows[0];
      return row !== undefined ? rowToRecord(row) : undefined;
    } catch {
      return this.mirror.getById(id);
    }
  }

  /**
   * The persisted cut-off, or `undefined` when no canonical row was written
   * yet (or the table is missing on an older schema): then the legacy form
   * stays acceptable everywhere, as before.
   */
  private async readCanonicalCutoff(): Promise<number | undefined> {
    try {
      const rows = await this.db.withOperator((db) =>
        db.query<{ value: string }>(`SELECT value FROM audit_chain_meta WHERE key = $1`, [
          AUDIT_CANONICAL_CUTOFF_KEY,
        ]),
      );
      const value = rows[0]?.value;
      const parsed = value === undefined ? Number.NaN : Number(value);
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async verifyChain(limit?: number): Promise<AuditChainVerification> {
    try {
      const rows = await this.db.withOperator((db) =>
        limit !== undefined
          ? db.query<AuditRow>(
              `SELECT id, actor, role, action, target, outcome, details, created_at, hash, prev_hash
                 FROM audit_log ORDER BY id DESC LIMIT $1`,
              [limit],
            )
          : db.query<AuditRow>(
              `SELECT id, actor, role, action, target, outcome, details, created_at, hash, prev_hash
                 FROM audit_log ORDER BY id ASC`,
            ),
      );
      // The LIMIT-ed query returns newest-first; verifyAuditChain requires
      // ascending order regardless of which branch produced the rows.
      const ordered = limit !== undefined ? rows.slice().reverse() : rows;
      const cutoff = await this.readCanonicalCutoff();
      return verifyAuditChain(ordered.map(rowToRecord), cutoff !== undefined ? { legacyCutoffId: cutoff } : {});
    } catch (err) {
      this.logger?.warn("Audit chain verification query failed; verifying in-memory mirror instead", {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.mirror.verifyChain(limit);
    }
  }
}

function parseDetails(v: unknown): Record<string, unknown> | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  if (typeof v === "object") return v as Record<string, unknown>;
  return undefined;
}

/** Builds the durable audit log when a database is present, else in-memory. */
export function createAuditLog(
  db?: Database,
  logger?: Logger,
  /**
   * Invoked once per failed durable write on the Postgres backend — wired to
   * the `aiperator_audit_write_failures_total` counter in bootstrap (Req 1.9).
   * Ignored by the in-memory backend, whose writes cannot fail.
   */
  onWriteFailure?: () => void,
): AuditLog {
  if (db === undefined) return new InMemoryAuditLog();
  const auditLog = new PostgresAuditLog(db, logger);
  if (onWriteFailure !== undefined) auditLog.onWriteFailure = onWriteFailure;
  return auditLog;
}
