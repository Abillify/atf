// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Reversible PII tokenization vault (`src/graph/pii-vault.ts`)
 *
 * The output guardrail (`output-guardrails.ts`) can REDACT PII in model
 * output — a one-way `[REDACTED_EMAIL]` marker. That protects the end user
 * from seeing a leak, but it does nothing for the actual privacy problem:
 * the PII still went to the LLM provider in the prompt. A provider that logs
 * prompts, or a model that memorizes training-adjacent data, has already
 * seen the customer's email/IBAN/phone number.
 *
 * This module closes that gap by working at the OTHER boundary — the
 * request going OUT to the provider, not the response coming back:
 *
 *   1. Before a user's message is sent to any LLM, every PII span the
 *      detectors ({@link findPiiMatches}) find is replaced with a stable,
 *      meaningless placeholder token (e.g. `[[PII:a1b2c3d4]]`).
 *   2. The token → real value mapping is stored ENCRYPTED AT REST (reusing
 *      {@link SecretCipher}, the same AES-256-GCM primitive as BYOK keys),
 *      scoped to the single execution that created it.
 *   3. The LLM (and any provider/tool it calls) only ever sees the
 *      placeholder — never the real value.
 *   4. When the model's response streams back, every placeholder token is
 *      re-substituted with the real value BEFORE it reaches the end user —
 *      so from the human's point of view nothing changed; the PII is only
 *      hidden from the model and the network hop to the provider.
 *
 * This is strictly opt-in per flow/tenant (`PII_VAULT_ENABLED` or a flow-level
 * override) and orthogonal to the output guardrail — a deployment can run
 * both (vault at ingress, guardrail as a backstop on egress) or either alone.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { Database } from "../db/database.js";
import type { SecretCipher } from "./secret-cipher.js";
import type { Logger } from "../observability/logger.js";
import { findPiiMatches, nerOnlyTypes, type PiiType } from "./output-guardrails.js";
import type { PiiDetectorResolver } from "./pii-detector.js";

/**
 * Associated-data string binding a vault entry's ciphertext to the exact
 * (executionId, token) pair it was written for. See {@link SecretCipher} for
 * why this matters: without it, a ciphertext copied to a different row (a
 * different execution or a different token) would decrypt successfully but
 * resolve under the wrong identity.
 */
function vaultAad(executionId: string, token: string): string {
  return `pii-vault:${executionId}:${token}`;
}

// ---------------------------------------------------------------------------
// Tokenization (pure)
// ---------------------------------------------------------------------------

/**
 * Token wrapper — distinctive enough that a model reproducing it verbatim is
 * unambiguous, and cheap to detect on the way back out.
 *
 * Two forms exist (ADR 0036):
 *   - typed    `[[PII:EMAIL:<16 hex>]]` — the default; the model learns what
 *     kind of value stands there (an address, an IBAN, a name);
 *   - untyped  `[[PII:<16 hex>]]`       — the original form, still minted with
 *     `PII_VAULT_TYPED_TOKENS=false`.
 * Both are always accepted on the way back, so a response that quotes an
 * older placeholder still resolves. The 16-hex id alone identifies the vault
 * entry; the type tag is a hint for the model and is never trusted.
 */
const TOKEN_PREFIX = "[[PII:";
const TOKEN_SUFFIX = "]]";
/** Longest type tag a placeholder may carry. */
const TOKEN_TYPE_MAX = 16;
const TOKEN_PATTERN = `\\[\\[PII:(?:[A-Z_]{1,${TOKEN_TYPE_MAX}}:)?([a-f0-9]{16})\\]\\]`;
/** Marker a string must contain before it is worth scanning for placeholders. */
export const PII_TOKEN_MARKER = TOKEN_PREFIX;

/** Uppercase type tag of a placeholder, e.g. `creditCard` → `CREDIT_CARD`. */
export function piiTypeTag(type: PiiType): string {
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .replace(/[^A-Z_]/g, "_")
    .slice(0, TOKEN_TYPE_MAX);
}

/** Renders the placeholder for a vault token id. */
export function piiPlaceholder(
  token: string,
  type: PiiType,
  typed: boolean,
): string {
  return typed
    ? `${TOKEN_PREFIX}${piiTypeTag(type)}:${token}${TOKEN_SUFFIX}`
    : TOKEN_PREFIX + token + TOKEN_SUFFIX;
}
/** Builds a fresh regex instance — never share one `g`-flagged RegExp across calls (its `lastIndex` is mutable shared state). */
function tokenRegex(): RegExp {
  return new RegExp(TOKEN_PATTERN, "g");
}

/** Generates an unpredictable, collision-resistant token id (not derived from the value — a value cannot be recovered from the token alone). */
function newTokenId(): string {
  // A token id must never look like personal data itself. Sixteen random hex
  // characters contain a run of seven or more decimal digits in a few percent
  // of all draws, and such a run is a phone number to the detectors: a second
  // pass over already tokenized text (tool output, a debug-trace redaction,
  // the output guardrail in front of the detokenizer) would then cut a
  // placeholder in half and leave it unresolvable. Ids with four or more
  // consecutive digits are therefore redrawn — about two bits of the 64 are
  // spent on it.
  for (;;) {
    const id = crypto.randomBytes(8).toString("hex");
    if (!/[0-9]{4}/.test(id)) return id;
  }
}

export interface TokenizeResult {
  /** The text with every detected PII span replaced by a placeholder token. */
  text: string;
  /** One entry per substitution made, in left-to-right order. */
  entries: Array<{
    token: string;
    type: PiiType;
    value: string;
    /** Which detector produced this span (provenance). */
    detector?: string;
  }>;
}

/**
 * Replaces every detected PII span in `text` with a fresh, untyped
 * `[[PII:<id>]]` placeholder. Pure — does not touch a vault and keeps no
 * state, so every occurrence gets its own token. This is the stateless
 * building block; {@link PiiVault.tokenize} is what a request goes through,
 * and it adds the type tag and the per-execution reuse of ADR 0036.
 */
export function tokenizeText(
  text: string,
  types?: readonly PiiType[],
): TokenizeResult {
  const matches = findPiiMatches(text, types);
  if (matches.length === 0) return { text, entries: [] };

  const entries: TokenizeResult["entries"] = [];
  let out = "";
  let cursor = 0;
  for (const m of matches) {
    out += text.slice(cursor, m.start);
    const token = newTokenId();
    out += TOKEN_PREFIX + token + TOKEN_SUFFIX;
    // This pure path is regex-only (findPiiMatches), so provenance is "regex".
    entries.push({ token, type: m.type, value: m.value, detector: "regex" });
    cursor = m.end;
  }
  out += text.slice(cursor);
  return { text: out, entries };
}

/**
 * Replaces every `[[PII:<id>]]` placeholder in `text` for which `resolve`
 * returns a value. Placeholders with no match (unknown token, expired entry,
 * or plain text that coincidentally looks like a token) are left as-is rather
 * than silently dropped, so a vault miss is visible instead of corrupting the
 * response.
 */
export function detokenizeText(
  text: string,
  resolve: (token: string) => string | undefined,
): string {
  return text.replace(tokenRegex(), (whole, token: string) => {
    const value = resolve(token);
    return value !== undefined ? value : whole;
  });
}

/**
 * Streaming-safe detokenizer: a placeholder token is short and bounded
 * (`[[PII:` + optional type tag and `:` + 16 hex chars + `]]`, at most 41
 * chars), so — unlike the guardrail's
 * PII detectors, which can match unbounded-length values — a small trailing
 * buffer is enough to guarantee a token split across two deltas is never
 * missed. Mirrors {@link "./output-guardrails.js"}'s `GuardrailStream` shape.
 */
const DETOKENIZE_WINDOW =
  TOKEN_PREFIX.length + TOKEN_TYPE_MAX + 1 + 16 + TOKEN_SUFFIX.length; // 41, the longest typed form

/**
 * Computes the index up to which `buffer` is safe to emit: the naive
 * `length - window` cut can still land INSIDE an as-yet-incomplete token (the
 * window only guarantees enough trailing context exists for a token that
 * starts within it — not that the cut itself avoids one). This walks back to
 * the start of the nearest `[[PII:` prefix that has not been closed by `]]`
 * before the naive cut point, so a token is never split. Returns -1 when
 * nothing is safe to emit yet (buffer at/under the window, or the only
 * content is an open token right at the start).
 */
function safeCutIndex(buffer: string, window: number): number {
  if (buffer.length <= window) return -1;
  let cut = buffer.length - window;
  const lastOpen = buffer.lastIndexOf(TOKEN_PREFIX, cut - 1);
  if (lastOpen !== -1) {
    const closeIdx = buffer.indexOf(TOKEN_SUFFIX, lastOpen + TOKEN_PREFIX.length);
    if (closeIdx === -1 || closeIdx + TOKEN_SUFFIX.length > cut) {
      cut = lastOpen;
    }
  }
  return cut > 0 ? cut : -1;
}

export class DetokenizeStream {
  private buffer = "";

  constructor(private readonly resolve: (token: string) => string | undefined) {}

  /** Feeds a delta; returns the detokenized text that is safe to emit now (may be ""). */
  push(delta: string): string {
    this.buffer += delta;
    const cut = safeCutIndex(this.buffer, DETOKENIZE_WINDOW);
    if (cut === -1) return "";
    const head = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    return detokenizeText(head, this.resolve);
  }

  /** Drains and detokenizes any remaining buffered text. Call once at stream end. */
  flush(): string {
    if (this.buffer.length === 0) return "";
    const remaining = this.buffer;
    this.buffer = "";
    return detokenizeText(remaining, this.resolve);
  }
}

// ---------------------------------------------------------------------------
// Vault store
// ---------------------------------------------------------------------------

export interface PiiVaultEntry {
  token: string;
  type: PiiType;
  value: string;
  /** Which detector produced this span (provenance; ADR-0015). Optional for legacy callers. */
  detector?: string;
}

export interface PiiVaultStore {
  /** Persists a batch of entries for one execution (best-effort; never throws into the caller). */
  put(
    executionId: string,
    tenantId: string | undefined,
    entries: readonly PiiVaultEntry[],
  ): Promise<void>;
  /** Resolves a single token's original value for an execution, or undefined when absent/foreign. */
  resolve(executionId: string, token: string): Promise<string | undefined>;
  /** Deletes every entry for an execution (called when the run finishes streaming). */
  clear(executionId: string): Promise<number>;
  /**
   * Age-based purge — safety net for orphaned entries from a crashed/abandoned
   * run. Errors MUST propagate to the caller (Req 2.1): a retention sweep that
   * silently returns `0` would report a completed purge that never happened.
   */
  purgeOlderThan?(cutoffIso: string): Promise<number>;
  /**
   * Right-to-be-forgotten — deletes every entry for a tenant/user across all
   * executions, including the in-memory mirror (Req 2.2). Errors MUST
   * propagate to the caller (Req 2.1): a DSAR response may only claim success
   * when the durable delete actually succeeded.
   */
  eraseTenant?(tenantId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// In-memory store (per-replica; lost on restart — fine, since entries are
// meant to live only for the duration of one streaming response)
// ---------------------------------------------------------------------------

interface MemEntry {
  type: PiiType;
  value: string;
  tenantId: string | undefined;
  createdAtMs: number;
}

export class InMemoryPiiVaultStore implements PiiVaultStore {
  private readonly byExecution = new Map<string, Map<string, MemEntry>>();

  async put(
    executionId: string,
    tenantId: string | undefined,
    entries: readonly PiiVaultEntry[],
  ): Promise<void> {
    let m = this.byExecution.get(executionId);
    if (m === undefined) {
      m = new Map();
      this.byExecution.set(executionId, m);
    }
    const now = Date.now();
    for (const e of entries) {
      m.set(e.token, { type: e.type, value: e.value, tenantId, createdAtMs: now });
    }
  }

  async resolve(
    executionId: string,
    token: string,
  ): Promise<string | undefined> {
    return this.byExecution.get(executionId)?.get(token)?.value;
  }

  async clear(executionId: string): Promise<number> {
    const m = this.byExecution.get(executionId);
    if (m === undefined) return 0;
    this.byExecution.delete(executionId);
    return m.size;
  }

  async purgeOlderThan(cutoffIso: string): Promise<number> {
    const cutoffMs = new Date(cutoffIso).getTime();
    let purged = 0;
    for (const [execId, m] of this.byExecution) {
      for (const [token, e] of m) {
        if (e.createdAtMs < cutoffMs) {
          m.delete(token);
          purged++;
        }
      }
      if (m.size === 0) this.byExecution.delete(execId);
    }
    return purged;
  }

  async eraseTenant(tenantId: string): Promise<number> {
    let erased = 0;
    for (const [execId, m] of this.byExecution) {
      for (const [token, e] of m) {
        if (e.tenantId === tenantId) {
          m.delete(token);
          erased++;
        }
      }
      if (m.size === 0) this.byExecution.delete(execId);
    }
    return erased;
  }
}

// ---------------------------------------------------------------------------
// Postgres store (durable; values encrypted at rest)
// ---------------------------------------------------------------------------

interface VaultRow {
  token: string;
  pii_type: string;
  encrypted_value: string;
}

/**
 * Columns written per vault entry, in statement order. One entry contributes
 * exactly this many positional parameters, which is what
 * {@link vaultInsertBatchRows} divides the driver's parameter ceiling by.
 */
const VAULT_INSERT_COLUMNS =
  "token, execution_id, tenant_id, pii_type, encrypted_value, detector";
const VAULT_INSERT_PARAMS_PER_ROW = 6;

/**
 * Largest batch written by one statement. PostgreSQL's ceiling is 65 535
 * parameters, which six parameters per row would put at over 10 000 rows — the
 * limit here is 500 instead, well clear of it, so that a column added to
 * {@link VAULT_INSERT_COLUMNS} later cannot push a full batch past the ceiling,
 * and so a single statement stays small enough that a failure tells the warning
 * log which 500 entries were lost rather than which 10 000.
 */
const VAULT_INSERT_MAX_ROWS = 500;

/** How many entries fit in one INSERT without exceeding the parameter ceiling. */
export function vaultInsertBatchRows(
  paramsPerRow: number = VAULT_INSERT_PARAMS_PER_ROW,
): number {
  if (paramsPerRow < 1) return VAULT_INSERT_MAX_ROWS;
  return Math.max(1, Math.min(VAULT_INSERT_MAX_ROWS, Math.floor(65_535 / paramsPerRow)));
}

/**
 * One multi-row `INSERT … ON CONFLICT (token) DO NOTHING` for `rowCount`
 * entries. Placeholders are positional across the whole statement, so row `i`
 * occupies `$6i+1 … $6i+6` — {@link vaultInsertParams} builds the values in the
 * same order.
 */
function vaultInsertStatement(rowCount: number): string {
  const rows: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const base = i * VAULT_INSERT_PARAMS_PER_ROW;
    rows.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
    );
  }
  return (
    `INSERT INTO pii_vault_entries (${VAULT_INSERT_COLUMNS}) VALUES ${rows.join(", ")} ` +
    "ON CONFLICT (token) DO NOTHING"
  );
}

/** Flatten one batch of entries into positional parameters, row by row. */
function vaultInsertParams(
  batch: readonly PiiVaultEntry[],
  executionId: string,
  tenantId: string | undefined,
  encrypt: (value: string, token: string) => string,
): unknown[] {
  const params: unknown[] = [];
  for (const e of batch) {
    params.push(
      e.token,
      executionId,
      tenantId ?? null,
      e.type,
      // AAD binds the ciphertext to (executionId, token) — the exact pair the
      // WHERE clause in `resolve()` looks up by. Copying an `encrypted_value`
      // row into a different execution_id/token (SQL-injection, backup
      // restore, or an insider with DB access) then fails to decrypt instead
      // of silently resolving under the wrong execution's authority.
      encrypt(e.value, e.token),
      e.detector ?? null,
    );
  }
  return params;
}

export class PostgresPiiVaultStore implements PiiVaultStore {
  private readonly mirror = new InMemoryPiiVaultStore();

  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher,
    private readonly logger?: Logger,
  ) {}

  /**
   * Writes `entries` in as few statements as possible — one multi-row INSERT
   * per {@link vaultInsertBatchRows} entries — instead of one round-trip per
   * entry. A single message that tokenizes 1 200 spans used to cost 1 200
   * sequential queries on the request path, before the first provider call;
   * it now costs three (500 rows each). Encryption and the per-entry AAD are unchanged, and so
   * is the durability contract: a failing database logs a warning, stops
   * issuing batches, and the in-memory mirror below still serves every
   * `resolve()`/`clear()` for this execution.
   */
  async put(
    executionId: string,
    tenantId: string | undefined,
    entries: readonly PiiVaultEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const maxRows = vaultInsertBatchRows();
    try {
      for (let offset = 0; offset < entries.length; offset += maxRows) {
        const batch = entries.slice(offset, offset + maxRows);
        await this.db.query(
          vaultInsertStatement(batch.length),
          vaultInsertParams(
            batch,
            executionId,
            tenantId,
            (value, token) => this.cipher.encrypt(value, vaultAad(executionId, token)),
          ),
        );
      }
    } catch (err) {
      this.logger?.warn("Failed to persist PII vault entries; falling back to in-memory mirror", {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Always mirror — a same-process resolve()/clear() must succeed even if
    // the durable write failed (best-effort persistence, never blocks the
    // request path), and cross-replica resolution simply isn't needed since a
    // single execution streams from one replica.
    await this.mirror.put(executionId, tenantId, entries);
  }

  async resolve(
    executionId: string,
    token: string,
  ): Promise<string | undefined> {
    const memHit = await this.mirror.resolve(executionId, token);
    if (memHit !== undefined) return memHit;
    try {
      const rows = await this.db.query<VaultRow>(
        `SELECT token, pii_type, encrypted_value FROM pii_vault_entries
           WHERE execution_id = $1 AND token = $2`,
        [executionId, token],
      );
      const row = rows[0];
      if (row === undefined) return undefined;
      return this.cipher.decrypt(row.encrypted_value, vaultAad(executionId, token));
    } catch (err) {
      this.logger?.warn("PII vault resolve query failed", {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  async clear(executionId: string): Promise<number> {
    await this.mirror.clear(executionId);
    try {
      const rows = await this.db.query<{ token: string }>(
        `DELETE FROM pii_vault_entries WHERE execution_id = $1 RETURNING token`,
        [executionId],
      );
      return rows.length;
    } catch (err) {
      this.logger?.warn("Failed to clear PII vault entries", {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  async purgeOlderThan(cutoffIso: string): Promise<number> {
    // Mirror first, then durable — and let DB errors propagate (Req 2.1):
    // a sweep that swallowed the failure and returned `0` would report a
    // completed purge that never happened. The mirror is always cleaned so a
    // retry (or the next sweep) never resolves PII from this process while
    // the durable rows are gone or being re-purged.
    const mirrorPurged = await this.mirror.purgeOlderThan(cutoffIso);
    const rows = await this.db.withOperator((db) =>
      db.query<{ token: string }>(
        `DELETE FROM pii_vault_entries WHERE created_at < $1 RETURNING token`,
        [cutoffIso],
      ),
    );
    return Math.max(rows.length, mirrorPurged);
  }

  async eraseTenant(tenantId: string): Promise<number> {
    // See purgeOlderThan: mirror always cleaned (Req 2.2), DB errors
    // propagate (Req 2.1) so the DSAR layer reports the store as failed
    // instead of claiming a completed erasure.
    const mirrorErased = await this.mirror.eraseTenant(tenantId);
    const rows = await this.db.withOperator((db) =>
      db.query<{ token: string }>(
        `DELETE FROM pii_vault_entries WHERE tenant_id = $1 RETURNING token`,
        [tenantId],
      ),
    );
    return Math.max(rows.length, mirrorErased);
  }
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

/**
 * Narrow metrics sink the vault uses to emit per-detector tokenization counts.
 * Structurally satisfied by the app-wide `Metrics` (`observability/metrics.ts`)
 * — kept minimal here so the vault does not depend on the full interface.
 */
export interface PiiVaultMetrics {
  recordCounter(name: string, labels: Record<string, string>, by?: number): void;
}

/** Prometheus counter name for per-detector, per-type tokenization counts. */
export const PII_VAULT_TOKENS_METRIC = "aiperator_pii_vault_tokens_total";

export interface PiiVaultConfig {
  enabled: boolean;
  /** When non-empty, only these PII detectors run. Empty/absent = all types. */
  piiTypes?: PiiType[];
  /**
   * Optional per-flow detector resolver for the extensible pipeline (ADR-0015).
   * When set (and a `flowId` is supplied to `tokenize`), the vault resolves the
   * detector registry for that flow and uses the async pipeline (NER + remote).
   * When absent — or when the resolver returns `undefined` for a flow — the
   * vault falls back to the sync regex-only path (`findPiiMatches`).
   * Can also be injected after construction via {@link PiiVault.setDetectorResolver}
   * (the resolver depends on the guardrail policy, which is built later at bootstrap).
   */
  detectorResolver?: PiiDetectorResolver;
  /**
   * Mint typed placeholders (`[[PII:EMAIL:…]]`). Default true
   * (`PII_VAULT_TYPED_TOKENS`); false keeps the untyped form.
   */
  typedTokens?: boolean;
  /**
   * Reuse one placeholder for a repeated value of the same type within one
   * execution, so the model can tell that two mentions are the same entity.
   * Default true (`PII_VAULT_CONSISTENT_TOKENS`); false mints a fresh token
   * per occurrence. Never shared across executions.
   */
  consistentTokens?: boolean;
}

/**
 * Facade combining tokenization + the store, scoped to one execution.
 * `tokenize` is called once per outbound message (ingress); `detokenize` /
 * `createDetokenizeStream` are called on every chunk of the model's response
 * (egress) so the end user always sees their real data.
 */
export interface PiiVault {
  enabled: boolean;
  /**
   * Tokenizes text and persists the mapping for `executionId`. Returns the
   * tokenized text. `flowId` (when supplied by the engine decorator) selects
   * the per-flow detector set via the resolver; when omitted, the vault uses
   * its sync regex-only path.
   *
   * @throws when detection runs under a fail-closed registry and a detector
   *         failed — the vault refuses to forward un-tokenized text.
   */
  tokenize(
    executionId: string,
    tenantId: string | undefined,
    text: string,
    flowId?: string,
  ): Promise<string>;
  /** Detokenizes a complete text (non-streaming path). */
  detokenize(executionId: string, text: string): Promise<string>;
  /** Creates a per-stream incremental detokenizer for the SSE path. */
  createDetokenizeStream(executionId: string): DetokenizeStreamHandle;
  /** Releases the vault entries for a finished execution. */
  release(executionId: string): Promise<void>;
  /** Late-binds the per-flow detector resolver (built after the guardrail policy at bootstrap). */
  setDetectorResolver(resolver: PiiDetectorResolver): void;
  /** Late-binds the metrics sink for per-detector tokenization counts (built after persistence at bootstrap). */
  setMetrics(metrics: PiiVaultMetrics): void;
  /**
   * Reads the (PII-value-free) action summary for a past execution, or
   * `undefined` when the execution never tokenized anything or has aged out of
   * the bounded ring (see {@link PiiVaultActionSummary}). Survives `release()`.
   */
  getActionSummary(executionId: string): PiiVaultActionSummary | undefined;
}

export interface DetokenizeStreamHandle {
  push(delta: string): Promise<string>;
  flush(): Promise<string>;
}

/**
 * Per-execution summary of vault actions — counts of tokenized spans by PII
 * type and by detector, plus the total. Unlike the vault ENTRIES (the actual
 * token→value mappings, released as soon as the run finishes streaming per
 * ADR-0007), this summary carries no PII values and is deliberately kept in a
 * short-lived bounded ring AFTER `release()` so a post-completion caller (the
 * Decision-Provenance Explainability Card, `GET
 * /monitoring/explain/:executionId`) can still report "this run tokenized N
 * PII spans (email×2, iban×1)" without needing to read the vault while the
 * run is still streaming.
 */
export interface PiiVaultActionSummary {
  executionId: string;
  totalTokenized: number;
  byType: Record<string, number>;
  byDetector: Record<string, number>;
}

/**
 * Distinct values one execution may map to a reusable token. Beyond it new
 * values still get a placeholder, just not a reusable one, so a pathological
 * input cannot grow the per-execution map without bound.
 */
const VALUE_TOKEN_CAP = 10_000;

/** Bounded ring size for post-release action summaries (per replica). */
const ACTION_SUMMARY_RING_SIZE = 500;

class PiiVaultImpl implements PiiVault {
  readonly enabled = true;
  private readonly piiTypes: PiiType[] | undefined;
  private detectorResolver?: PiiDetectorResolver;
  private metrics?: PiiVaultMetrics;
  private readonly actionSummaries = new Map<string, PiiVaultActionSummary>();
  private readonly actionSummaryOrder: string[] = [];
  private readonly typedTokens: boolean;
  private readonly consistentTokens: boolean;
  /** executionId → (`type\0value` → token id); see {@link mintToken}. */
  private readonly valueTokens = new Map<string, Map<string, string>>();

  constructor(
    private readonly store: PiiVaultStore,
    config: PiiVaultConfig,
  ) {
    this.piiTypes = config.piiTypes;
    this.detectorResolver = config.detectorResolver;
    this.typedTokens = config.typedTokens ?? true;
    this.consistentTokens = config.consistentTokens ?? true;
  }

  /** Merges a batch of tokenized entries into the execution's action summary. */
  private recordActionSummary(
    executionId: string,
    entries: readonly PiiVaultEntry[],
  ): void {
    if (entries.length === 0) return;
    let summary = this.actionSummaries.get(executionId);
    if (summary === undefined) {
      summary = {
        executionId,
        totalTokenized: 0,
        byType: {},
        byDetector: {},
      };
      this.actionSummaries.set(executionId, summary);
      this.actionSummaryOrder.push(executionId);
      while (this.actionSummaryOrder.length > ACTION_SUMMARY_RING_SIZE) {
        const oldest = this.actionSummaryOrder.shift();
        if (oldest !== undefined) this.actionSummaries.delete(oldest);
      }
    }
    for (const e of entries) {
      summary.totalTokenized += 1;
      summary.byType[e.type] = (summary.byType[e.type] ?? 0) + 1;
      const detector = e.detector ?? "regex";
      summary.byDetector[detector] = (summary.byDetector[detector] ?? 0) + 1;
    }
  }

  getActionSummary(executionId: string): PiiVaultActionSummary | undefined {
    return this.actionSummaries.get(executionId);
  }

  setDetectorResolver(resolver: PiiDetectorResolver): void {
    this.detectorResolver = resolver;
  }

  setMetrics(metrics: PiiVaultMetrics): void {
    this.metrics = metrics;
  }

  /**
   * Emits one `aiperator_pii_vault_tokens_total{detector,type}` increment per
   * tokenized span — the runtime consumer of detector provenance. Cheap and
   * safe when no metrics sink is wired (no-op).
   */
  private recordProvenance(entries: readonly PiiVaultEntry[]): void {
    if (this.metrics === undefined) return;
    for (const e of entries) {
      this.metrics.recordCounter(PII_VAULT_TOKENS_METRIC, {
        detector: e.detector ?? "unknown",
        type: e.type,
      });
    }
  }

  async tokenize(
    executionId: string,
    tenantId: string | undefined,
    text: string,
    flowId?: string,
  ): Promise<string> {
    // With a resolver and a concrete flow, use the per-flow async pipeline
    // (regex/NER/remote). A plan of undefined means "this flow has no detector
    // config" → fall through to the sync regex-only path below. The plan may
    // carry a per-flow PII type subset; when absent, the vault's global default
    // (`PII_VAULT_TYPES`) applies.
    //
    // Fail-mode of the pipeline: `registry.detect` returns `[]` when detection
    // ran and found no PII (→ the text passes through unchanged), and THROWS a
    // `PiiDetectionError` when a detector failed under `failMode: "closed"`.
    // That throw propagates out of `tokenize` so the request fails rather than
    // forwarding un-tokenized PII to the provider.
    if (this.detectorResolver !== undefined && flowId !== undefined) {
      const plan = this.detectorResolver.resolve(flowId);
      if (plan !== undefined) {
        const matches = await plan.registry.detect(
          text,
          plan.piiTypes ?? this.piiTypes,
        );
        return this.replaceSpans(executionId, tenantId, text, matches);
      }
    }
    // The sync path is regex-only (findPiiMatches), so provenance is "regex".
    const matches = findPiiMatches(text, this.piiTypes).map((m) => ({
      start: m.start,
      end: m.end,
      type: m.type,
      detector: "regex",
    }));
    return this.replaceSpans(executionId, tenantId, text, matches);
  }

  /**
   * Returns the token id standing for `(type, value)` in this execution and
   * whether it was minted now. With consistent tokens a repeated value gets
   * the id it already has, so the model sees one entity instead of two; the
   * map lives only in this process and only until `release()`, and it is never
   * consulted for another execution. Past {@link VALUE_TOKEN_CAP} distinct
   * values the execution keeps working with a fresh token per occurrence.
   */
  private mintToken(
    executionId: string,
    type: PiiType,
    value: string,
  ): { token: string; fresh: boolean } {
    if (!this.consistentTokens) return { token: newTokenId(), fresh: true };
    let byValue = this.valueTokens.get(executionId);
    if (byValue === undefined) {
      byValue = new Map();
      this.valueTokens.set(executionId, byValue);
    }
    const key = `${type}\u0000${value}`;
    const known = byValue.get(key);
    if (known !== undefined) return { token: known, fresh: false };
    const token = newTokenId();
    if (byValue.size < VALUE_TOKEN_CAP) byValue.set(key, token);
    return { token, fresh: true };
  }

  /**
   * Replaces every detected span with its placeholder and persists the
   * mappings minted for it. Spans are expected sorted and non-overlapping; one
   * that runs backwards or outside the text is skipped (defensive — the remote
   * detector already validates, and the merge keeps spans ordered).
   *
   * The vault stores the ACTUAL sliced text, not a detector-reported value, so
   * the egress round-trip restores exactly what was removed even if a detector
   * normalized its report (e.g. NER subword artifacts).
   */
  private async replaceSpans(
    executionId: string,
    tenantId: string | undefined,
    text: string,
    matches: ReadonlyArray<{
      start: number;
      end: number;
      type: PiiType;
      detector?: string;
    }>,
  ): Promise<string> {
    if (matches.length === 0) return text; // ran, found nothing → pass through

    /** Every replaced occurrence — what the summary and the metric count. */
    const occurrences: PiiVaultEntry[] = [];
    /** The mappings minted here — what the store still has to learn. */
    const minted: PiiVaultEntry[] = [];
    let out = "";
    let cursor = 0;
    for (const m of matches) {
      if (m.start < cursor || m.end > text.length || m.end <= m.start) continue;
      const value = text.slice(m.start, m.end);
      const { token, fresh } = this.mintToken(executionId, m.type, value);
      out += text.slice(cursor, m.start);
      out += piiPlaceholder(token, m.type, this.typedTokens);
      const entry: PiiVaultEntry = {
        token,
        type: m.type,
        value,
        ...(m.detector !== undefined ? { detector: m.detector } : {}),
      };
      occurrences.push(entry);
      if (fresh) minted.push(entry);
      cursor = m.end;
    }
    out += text.slice(cursor);

    if (minted.length > 0) {
      await this.store.put(executionId, tenantId, minted);
    }
    if (occurrences.length > 0) {
      this.recordProvenance(occurrences);
      this.recordActionSummary(executionId, occurrences);
    }
    return out;
  }

  async detokenize(executionId: string, text: string): Promise<string> {
    const tokens = new Set<string>();
    for (const [, token] of text.matchAll(tokenRegex())) {
      if (token !== undefined) tokens.add(token);
    }
    if (tokens.size === 0) return text;
    const resolved = new Map<string, string>();
    await Promise.all(
      [...tokens].map(async (token) => {
        const value = await this.store.resolve(executionId, token);
        if (value !== undefined) resolved.set(token, value);
      }),
    );
    return detokenizeText(text, (token) => resolved.get(token));
  }

  createDetokenizeStream(executionId: string): DetokenizeStreamHandle {
    // Own buffering (mirrors DetokenizeStream's window logic) so token
    // resolution always runs against the FULL accumulated buffer, not just
    // the latest delta — a token can straddle two push() calls, and scanning
    // only the incoming delta would miss the half that arrived earlier.
    let buffer = "";
    const cache = new Map<string, string | undefined>();

    const resolvePendingIn = async (chunk: string): Promise<void> => {
      const pending: string[] = [];
      for (const [, token] of chunk.matchAll(tokenRegex())) {
        if (token !== undefined && !cache.has(token)) pending.push(token);
      }
      if (pending.length === 0) return;
      await Promise.all(
        pending.map(async (token) => {
          cache.set(token, await this.store.resolve(executionId, token));
        }),
      );
    };

    return {
      push: async (delta: string): Promise<string> => {
        buffer += delta;
        const cut = safeCutIndex(buffer, DETOKENIZE_WINDOW);
        if (cut === -1) return "";
        const head = buffer.slice(0, cut);
        buffer = buffer.slice(cut);
        await resolvePendingIn(head);
        return detokenizeText(head, (token) => cache.get(token));
      },
      flush: async (): Promise<string> => {
        if (buffer.length === 0) return "";
        const remaining = buffer;
        buffer = "";
        await resolvePendingIn(remaining);
        return detokenizeText(remaining, (token) => cache.get(token));
      },
    };
  }

  async release(executionId: string): Promise<void> {
    this.valueTokens.delete(executionId);
    await this.store.clear(executionId);
  }
}

/** Builds a {@link PiiVault}, or undefined when disabled. */
export function createPiiVault(
  store: PiiVaultStore,
  config: PiiVaultConfig,
  logger?: Logger,
): PiiVault | undefined {
  if (config.enabled !== true) return undefined;
  const requestedNerOnly = nerOnlyTypes(config.piiTypes ?? []);
  if (requestedNerOnly.length > 0 && config.detectorResolver === undefined) {
    logger?.warn(
      "PII vault configured with NER-only PII types but no detector pipeline is wired — " +
        "these types tokenize NOTHING on the regex-only path. Enable PII_DETECTORS (e.g. regex,ner) " +
        "so a NER/remote detector can produce person/location/organization spans.",
      { nerOnlyTypes: requestedNerOnly },
    );
  }
  logger?.info("Reversible PII tokenization vault enabled", {
    piiTypes: config.piiTypes && config.piiTypes.length > 0 ? config.piiTypes : "all",
    typedTokens: config.typedTokens ?? true,
    consistentTokens: config.consistentTokens ?? true,
  });
  return new PiiVaultImpl(store, config);
}
