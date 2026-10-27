// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * DSAR Erasure Orchestrator (platform-hardening Req 2.9).
 *
 * Distributes an erasure request (self-service `DELETE /v1/me/data`, operator
 * DSAR, tenant offboarding) to every configured store:
 *
 * - **Local stores** — the Runtime's own `RetentionService` targets.
 * - **Remote stores** — the `POST /v1/erasure` endpoints configured via
 *   `ERASURE_TARGETS` (`[{service, url, tokenEnv}]`), called in parallel
 *   with a per-call timeout and up to three attempts (exponential backoff).
 *
 * The operation and its per-store partial results are persisted in the
 * `erasure_requests` table (Migration 44) so the request is idempotent: a
 * repeated `requestId` replays the stored outcome instead of erasing twice.
 * Without a database an in-memory store keeps the same semantics for the
 * process lifetime (mirroring the optional-persistence pattern).
 *
 * Honesty rule (Req 2.10): the aggregate status is `complete` only when no
 * store reports `failed`; `not_configured` is a deliberate state and does not
 * fail the operation. An operation that addressed no store at all is `failed`
 * (a synthetic `runtime.no_stores` result says why), never vacuously
 * `complete`. The route layer maps the aggregate to HTTP 200/202/207/502.
 *
 * Lifecycle: an operation is stored as `in_progress` before any store is
 * touched, so a crash cannot leave a row that looks finished. The row's
 * `updated_at` is its lease: a replay of the same `requestId` inside the lease
 * returns the running operation, after the lease it takes the operation over
 * and runs it again (stores are deletion-idempotent, remote ones replay by
 * `requestId`). Once an operation is `complete` the cleartext subject is
 * removed from the stored row — the signed receipt keeps only salted hashes;
 * operations that are not complete keep it until a retry finishes them.
 *
 * No `any` at module boundaries.
 */

import { randomUUID } from "node:crypto";

import {
  ErasureResponseSchema,
  type ErasureRequest,
  type ErasureScope,
  type ErasureStoreResult,
  type ErasureSubject as ContractErasureSubject,
} from "@atf/erasure-contract";

import type { Database } from "../db/database.js";
import { jsonColumn } from "../db/json-column.js";
import type { Logger } from "../observability/logger.js";
import type {
  ErasureSubject,
  RetentionService,
} from "../observability/retention.js";
import type { ErasureTargetConfig } from "./erasure-targets.js";
import {
  createSignedReceipt,
  type ErasureReceiptEnvelope,
  type ErasureReceiptKey,
} from "./erasure-receipt.js";

/** Aggregate outcome of an erasure operation. */
export type ErasureOperationStatus =
  | "in_progress"
  | "complete"
  | "partial"
  | "failed";

/**
 * A persisted erasure operation: the request identity plus the merged
 * per-store results. `storeGroups` records which store names each service
 * reported so a retry can re-run only the failed ones.
 */
export interface ErasureOperation {
  requestId: string;
  tenantId: string;
  scope: ErasureScope;
  subject?: ContractErasureSubject & {
    /** Verified token issuer of a self-service erasure (scopes local stores). */
    issuer?: string;
  };
  references?: string[];
  status: ErasureOperationStatus;
  results: ErasureStoreResult[];
  /** Sum of `erased` across all stores (honest total, Req 2.10). */
  erased: number;
  /** Which store names each service (incl. `runtime`) reported. */
  storeGroups: { service: string; stores: string[] }[];
  /** Signed Erasure_Receipt envelope (Req 2.11), set once available. */
  receipt?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ErasureOrchestratorOptions {
  retention: RetentionService;
  /** Remote `POST /v1/erasure` endpoints (`ERASURE_TARGETS`). */
  targets?: ErasureTargetConfig[];
  /** Persistence; in-memory fallback when absent. */
  database?: Database;
  logger?: Logger;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-call timeout in ms. Default 10 000. */
  timeoutMs?: number;
  /**
   * How long an `in_progress` operation counts as running before a replay or
   * retry takes it over. Default 15 minutes.
   */
  leaseMs?: number;
  /** Total attempts per remote target (incl. the first). Default 3. */
  attempts?: number;
  /** First backoff step in ms between attempts. Default 200. */
  backoffBaseMs?: number;
  /** Env lookup for `tokenEnv`; injectable for tests. */
  envLookup?: (name: string) => string | undefined;
  /**
   * Signing key for the Erasure_Receipt (Req 2.11). When set, every
   * completed operation (and every retry that changes the outcome) gets a
   * signed receipt persisted with it; without it no receipt is issued.
   */
  receiptKey?: ErasureReceiptKey;
}

export interface ErasureOrchestrator {
  /** Run (or replay, when the requestId is known) an erasure operation. */
  execute(
    request: ErasureRequest,
    options?: { issuer?: string },
  ): Promise<ErasureOperation>;
  /** Re-run only the stores that reported `failed`. */
  retry(requestId: string): Promise<ErasureOperation | null>;
  /** Load a stored operation (operator-plane read). */
  get(requestId: string): Promise<ErasureOperation | null>;
  /** Load the operation whose persisted receipt carries this receipt id. */
  getByReceiptId(receiptId: string): Promise<ErasureOperation | null>;
  /** Attach a signed receipt to a stored operation (Req 2.11). */
  setReceipt(requestId: string, receipt: unknown): Promise<void>;
}

/** Name of the pseudo-service the local retention targets report under. */
export const RUNTIME_STORE_SERVICE = "runtime";
/** Store name of the synthetic failure for an operation that addressed no store. */
export const NO_STORES_ADDRESSED = `${RUNTIME_STORE_SERVICE}.no_stores`;
/** The lease of an `in_progress` operation was taken over by another worker. */
class ErasureLeaseLostError extends Error {
  constructor(requestId: string) {
    super(`erasure lease lost for ${requestId}`);
    this.name = "ErasureLeaseLostError";
  }
}
/** Default lease of an `in_progress` operation. */
const DEFAULT_LEASE_MS = 15 * 60_000;

interface RowShape {
  request_id: string;
  tenant_id: string;
  scope: string;
  subject: ErasureOperation["subject"] | null;
  doc_references: string[] | null;
  status: string;
  results: ErasureStoreResult[];
  store_groups: { service: string; stores: string[] }[];
  receipt: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isScope(value: string): value is ErasureScope {
  return value === "subject" || value === "tenant" || value === "reference";
}

function rowToOperation(raw: RowShape): ErasureOperation | null {
  const scope = raw.scope;
  if (!isScope(scope)) return null;
  // Rows written before the `::text::jsonb` fix hold string scalars.
  const row: RowShape = {
    ...raw,
    subject: jsonColumn<RowShape["subject"]>(raw.subject) ?? null,
    doc_references: jsonColumn<string[]>(raw.doc_references) ?? null,
    results: jsonColumn<ErasureStoreResult[]>(raw.results) ?? [],
    store_groups: jsonColumn<RowShape["store_groups"]>(raw.store_groups) ?? [],
    receipt: jsonColumn(raw.receipt) ?? null,
  };
  const results = Array.isArray(row.results) ? row.results : [];
  return {
    requestId: row.request_id,
    tenantId: row.tenant_id,
    scope,
    ...(row.subject !== null && row.subject !== undefined
      ? { subject: row.subject }
      : {}),
    ...(row.doc_references !== null && row.doc_references !== undefined
      ? { references: row.doc_references }
      : {}),
    status:
      row.status === "complete" ||
      row.status === "partial" ||
      row.status === "failed" ||
      row.status === "in_progress"
        ? row.status
        : "partial",
    results,
    erased: results.reduce((n, r) => n + r.erased, 0),
    storeGroups: Array.isArray(row.store_groups) ? row.store_groups : [],
    ...(row.receipt !== null && row.receipt !== undefined ? { receipt: row.receipt } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Honest aggregation (Req 2.10 / Property 4): `complete` iff no store reports
 * `failed` (`not_configured` is a deliberate state and does not fail the
 * operation); `failed` iff every store failed; `partial` otherwise.
 */
export function aggregateStatus(results: ErasureStoreResult[]): ErasureOperationStatus {
  const failed = results.filter((r) => r.status === "failed").length;
  if (failed === 0) return "complete";
  if (failed < results.length) return "partial";
  return "failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The runtime-store identity of a contract subject. Every identifier the
 * request names (userId, email, externalIds) is kept, so a subject given only
 * by email or external id still erases user-scoped instead of degrading to a
 * tenant-only subject — which the local stores read as "the whole tenant".
 */
function localUserIdentity(
  subject: ErasureOperation["subject"],
): Pick<ErasureSubject, "userId" | "userAliases" | "issuer"> {
  const ids = [
    ...new Set(
      [subject?.userId, subject?.email, ...(subject?.externalIds ?? [])]
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  ];
  const [userId, ...userAliases] = ids;
  if (userId === undefined) return {};
  const issuer = subject?.issuer;
  return {
    userId,
    ...(userAliases.length > 0 ? { userAliases } : {}),
    ...(typeof issuer === "string" && issuer !== "" ? { issuer } : {}),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** The contract form of a stored subject (drops the runtime-only issuer). */
function contractSubject(
  subject: NonNullable<ErasureOperation["subject"]>,
): ContractErasureSubject {
  return {
    ...(subject.userId !== undefined ? { userId: subject.userId } : {}),
    ...(subject.email !== undefined ? { email: subject.email } : {}),
    externalIds: subject.externalIds,
  };
}
function noStoresAddressed(): ErasureStoreResult {
  return {
    store: NO_STORES_ADDRESSED,
    status: "failed",
    erased: 0,
    error:
      "No erasure store was addressed: no local store applies to this request and no remote target is configured (ERASURE_TARGETS).",
  };
}

/**
 * Persistence abstraction so the orchestrator works with Postgres
 * (`erasure_requests`) or a process-local map when no database is configured.
 */
interface OperationStore {
  /** Insert a new operation holding the lease `leaseToken`; `null` when it was inserted. */
  insert(op: ErasureOperation, leaseToken: string): Promise<ErasureOperation | null>;
  update(op: ErasureOperation): Promise<void>;
  load(requestId: string): Promise<ErasureOperation | null>;
  loadByReceiptId(receiptId: string): Promise<ErasureOperation | null>;
  /**
   * Atomically take over an `in_progress` operation whose lease has expired
   * (and renew the lease). Returns the claimed operation, or `null` when it is
   * not in progress, still leased, or another caller claimed it first.
   */
  claimExpired(
    requestId: string,
    leaseMs: number,
    leaseToken: string,
  ): Promise<ErasureOperation | null>;
  /**
   * Heartbeat: extend the lease, but only while `leaseToken` still holds it
   * (the operation is `in_progress` and no other worker claimed it). `false`
   * means the lease was lost and the run must stop.
   */
  renewLease(requestId: string, leaseToken: string): Promise<boolean>;
  /** Remove the cleartext subject from a stored operation. */
  redactSubject(requestId: string): Promise<void>;
}

class InMemoryOperationStore implements OperationStore {
  private readonly map = new Map<string, ErasureOperation>();
  private readonly leases = new Map<string, string>();
  async insert(op: ErasureOperation, leaseToken: string): Promise<ErasureOperation | null> {
    const existing = this.map.get(op.requestId);
    if (existing !== undefined) return existing;
    this.map.set(op.requestId, op);
    this.leases.set(op.requestId, leaseToken);
    return null;
  }
  async renewLease(requestId: string, leaseToken: string): Promise<boolean> {
    const op = this.map.get(requestId);
    if (op === undefined || op.status !== "in_progress" || this.leases.get(requestId) !== leaseToken) {
      return false;
    }
    this.map.set(requestId, { ...op, updatedAt: new Date().toISOString() });
    return true;
  }
  async update(op: ErasureOperation): Promise<void> {
    this.map.set(op.requestId, op);
  }
  async load(requestId: string): Promise<ErasureOperation | null> {
    return this.map.get(requestId) ?? null;
  }
  async claimExpired(
    requestId: string,
    leaseMs: number,
    leaseToken: string,
  ): Promise<ErasureOperation | null> {
    const op = this.map.get(requestId);
    if (op === undefined || op.status !== "in_progress") return null;
    if (Date.now() - Date.parse(op.updatedAt) < leaseMs) return null;
    const claimed = { ...op, updatedAt: new Date().toISOString() };
    this.map.set(requestId, claimed);
    this.leases.set(requestId, leaseToken);
    return claimed;
  }
  async redactSubject(requestId: string): Promise<void> {
    const op = this.map.get(requestId);
    if (op === undefined || op.subject === undefined) return;
    const rest: ErasureOperation = { ...op };
    delete rest.subject;
    this.map.set(requestId, rest);
  }
  async loadByReceiptId(receiptId: string): Promise<ErasureOperation | null> {
    for (const op of this.map.values()) {
      const payload = (op.receipt as ErasureReceiptEnvelope | undefined)?.payload;
      if (payload?.receiptId === receiptId) return op;
    }
    return null;
  }
}

export class PostgresOperationStore implements OperationStore {
  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
  ) {}

  async insert(op: ErasureOperation, leaseToken: string): Promise<ErasureOperation | null> {
    const rows = await this.db.query<{ request_id: string }>(
      `INSERT INTO erasure_requests
         (request_id, tenant_id, scope, subject, doc_references, status,
          results, store_groups, lease_token)
       VALUES ($1, $2, $3, $4::text::jsonb, $5::text::jsonb, $6, $7::text::jsonb, $8::text::jsonb, $9)
       ON CONFLICT (request_id) DO NOTHING
       RETURNING request_id`,
      [
        op.requestId,
        op.tenantId,
        op.scope,
        op.subject === undefined ? null : JSON.stringify(op.subject),
        op.references === undefined ? null : JSON.stringify(op.references),
        op.status,
        JSON.stringify(op.results),
        JSON.stringify(op.storeGroups),
        leaseToken,
      ],
    );
    if (rows.length > 0) return null;
    // Conflict → an earlier request with this id exists; replay it.
    return this.load(op.requestId);
  }

  async update(op: ErasureOperation): Promise<void> {
    await this.db.query(
      `UPDATE erasure_requests
          SET status = $2, results = $3::text::jsonb, store_groups = $4::text::jsonb,
              receipt = COALESCE($5::text::jsonb, receipt), updated_at = now()
        WHERE request_id = $1`,
      [
        op.requestId,
        op.status,
        JSON.stringify(op.results),
        JSON.stringify(op.storeGroups),
        op.receipt === undefined ? null : JSON.stringify(op.receipt),
      ],
    );
  }

  async claimExpired(
    requestId: string,
    leaseMs: number,
    leaseToken: string,
  ): Promise<ErasureOperation | null> {
    // One statement: only the caller whose UPDATE matches the expired row wins,
    // and it replaces the lease token, fencing out the previous holder.
    const rows = await this.db.query<RowShape>(
      `UPDATE erasure_requests
          SET updated_at = now(), lease_token = $3
        WHERE request_id = $1 AND status = 'in_progress'
          AND updated_at < now() - ($2::bigint * interval '1 millisecond')
        RETURNING request_id, tenant_id, scope, subject, doc_references, status,
                  results, store_groups, receipt, created_at, updated_at`,
      [requestId, Math.max(0, Math.floor(leaseMs)), leaseToken],
    );
    return rows.length > 0 ? rowToOperation(rows[0]) : null;
  }

  async renewLease(requestId: string, leaseToken: string): Promise<boolean> {
    const rows = await this.db.query<{ request_id: string }>(
      `UPDATE erasure_requests
          SET updated_at = now()
        WHERE request_id = $1 AND status = 'in_progress' AND lease_token = $2
        RETURNING request_id`,
      [requestId, leaseToken],
    );
    return rows.length > 0;
  }
  async redactSubject(requestId: string): Promise<void> {
    await this.db.query(
      `UPDATE erasure_requests SET subject = NULL WHERE request_id = $1`,
      [requestId],
    );
  }
  async load(requestId: string): Promise<ErasureOperation | null> {
    // Operator plane: erasure operations are cross-tenant admin data.
    return this.loadBy("request_id = $1", requestId, "requestId");
  }

  async loadByReceiptId(receiptId: string): Promise<ErasureOperation | null> {
    return this.loadBy(
      "receipt->'payload'->>'receiptId' = $1",
      receiptId,
      "receiptId",
    );
  }

  private async loadBy(
    predicate: string,
    value: string,
    label: string,
  ): Promise<ErasureOperation | null> {
    const run = (d: Database) =>
      d.query<RowShape>(
        `SELECT request_id, tenant_id, scope, subject, doc_references, status,
                results, store_groups, receipt, created_at, updated_at
           FROM erasure_requests WHERE ${predicate}`,
        [value],
      );
    try {
      const rows =
        this.db.withOperator !== undefined
          ? await this.db.withOperator(run)
          : await run(this.db);
      return rows.length > 0 ? rowToOperation(rows[0]) : null;
    } catch (error) {
      this.logger?.warn("erasure_requests load failed", {
        [label]: value,
        error: errorMessage(error),
      });
      return null;
    }
  }
}

/**
 * Call one remote erasure endpoint with timeout and retry. Returns the
 * per-store results on success, or a single synthetic `failed` result named
 * after the service when every attempt failed.
 */
async function callRemoteTarget(
  target: ErasureTargetConfig,
  request: ErasureRequest,
  options: {
    fetchImpl: typeof fetch;
    token: string | undefined;
    timeoutMs: number;
    attempts: number;
    backoffBaseMs: number;
    logger?: Logger;
  },
): Promise<ErasureStoreResult[]> {
  if (options.token === undefined || options.token === "") {
    return [
      {
        store: `${target.service}.endpoint`,
        status: "failed",
        erased: 0,
        error: `token environment variable ${target.tokenEnv} is not set`,
      },
    ];
  }
  let lastError = "unknown error";
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      const response = await options.fetchImpl(target.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
      } else {
        const parsed = ErasureResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          lastError = "malformed erasure response";
        } else {
          return parsed.data.results.map((r) => ({
            ...r,
            store: r.store.includes(".") ? r.store : `${target.service}.${r.store}`,
          }));
        }
      }
    } catch (error) {
      lastError = errorMessage(error);
    }
    if (attempt < options.attempts) {
      await sleep(options.backoffBaseMs * 2 ** (attempt - 1));
    }
  }
  options.logger?.warn("remote erasure target failed", {
    service: target.service,
    error: lastError,
  });
  return [
    {
      store: `${target.service}.endpoint`,
      status: "failed",
      erased: 0,
      error: lastError,
    },
  ];
}

export function createErasureOrchestrator(
  options: ErasureOrchestratorOptions,
): ErasureOrchestrator {
  const { retention, logger } = options;
  const targets = options.targets ?? [];
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const leaseMs = Math.max(0, options.leaseMs ?? DEFAULT_LEASE_MS);
  const attempts = Math.max(1, options.attempts ?? 3);
  const backoffBaseMs = options.backoffBaseMs ?? 200;
  const envLookup = options.envLookup ?? ((name: string) => process.env[name]);
  const { receiptKey } = options;
  const store: OperationStore =
    options.database !== undefined
      ? new PostgresOperationStore(options.database, logger)
      : new InMemoryOperationStore();

  const localForget = async (
    subject: ErasureSubject,
    only?: readonly string[],
  ): Promise<ErasureStoreResult[]> => {
    const report = await retention.forget(subject, only);
    return report.map((entry) => ({
      store: entry.target,
      status: entry.error !== undefined ? ("failed" as const) : ("ok" as const),
      erased: entry.erased,
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    }));
  };

  const runRemote = async (
    request: ErasureRequest,
    onlyServices?: readonly string[],
    /** Called after each service finished (lease heartbeat); may throw to stop the run. */
    onServiceDone?: () => Promise<void>,
  ): Promise<{ service: string; results: ErasureStoreResult[] }[]> => {
    const selected =
      onlyServices === undefined
        ? targets
        : targets.filter((t) => onlyServices.includes(t.service));
    const settled = await Promise.all(
      selected.map(async (target) => {
        const results = await callRemoteTarget(target, request, {
          fetchImpl,
          token: envLookup(target.tokenEnv),
          timeoutMs,
          attempts,
          backoffBaseMs,
          ...(logger !== undefined ? { logger } : {}),
        });
        await onServiceDone?.();
        return { service: target.service, results };
      }),
    );
    return settled;
  };

  const mergeResults = (
    previous: ErasureStoreResult[],
    updates: ErasureStoreResult[],
  ): ErasureStoreResult[] => {
    const byStore = new Map(previous.map((r) => [r.store, r]));
    for (const update of updates) byStore.set(update.store, update);
    return [...byStore.values()];
  };

  /**
   * Replace every previous result belonging to `service` (by its recorded
   * store group or the `<service>.` name prefix) with the service's fresh
   * report. A service always reports its complete current store set, so a
   * stale synthetic `<service>.endpoint` failure must not survive a later
   * successful response that names concrete stores instead.
   */
  const replaceServiceResults = (
    previous: ErasureStoreResult[],
    groups: { service: string; stores: string[] }[],
    service: string,
    updates: ErasureStoreResult[],
  ): ErasureStoreResult[] => {
    const groupStores = new Set(
      groups.filter((g) => g.service === service).flatMap((g) => g.stores),
    );
    const prefix = `${service}.`;
    const kept = previous.filter(
      (r) => !groupStores.has(r.store) && !r.store.startsWith(prefix),
    );
    return mergeResults(kept, updates);
  };

  const mergeGroups = (
    previous: { service: string; stores: string[] }[],
    service: string,
    stores: string[],
  ): { service: string; stores: string[] }[] => {
    const found = previous.find((g) => g.service === service);
    if (found !== undefined) {
      found.stores = [...new Set([...found.stores, ...stores])];
      return previous;
    }
    return [...previous, { service, stores: [...new Set(stores)] }];
  };

  const execute = async (
    request: ErasureRequest,
    options?: { issuer?: string },
  ): Promise<ErasureOperation> => {
    const now = new Date().toISOString();
    const issuer = options?.issuer?.trim();
    const operation: ErasureOperation = {
      requestId: request.requestId,
      tenantId: request.tenantId,
      scope: request.scope,
      // The issuer is kept on the persisted subject only (never sent to remote
      // targets) so a retry scopes the local stores the same way.
      ...(request.subject !== undefined
        ? {
            subject: {
              ...request.subject,
              ...(issuer !== undefined && issuer !== "" ? { issuer } : {}),
            },
          }
        : {}),
      ...(request.references !== undefined
        ? { references: request.references }
        : {}),
      status: "in_progress",
      results: [],
      erased: 0,
      storeGroups: [],
      createdAt: now,
      updatedAt: now,
    };
    const leaseToken = randomUUID();
    const conflict = await store.insert(operation, leaseToken);
    // Idempotent replay (Req 2.9); an operation whose lease ran out is a
    // zombie of a crashed run and is taken over instead of replayed as-is.
    if (conflict !== null) return takeOverIfExpired(conflict);
    return runOperation(operation, request, leaseToken);
  };
  /** The wire request of a persisted operation (the issuer never leaves the runtime). */
  const requestOf = (op: ErasureOperation): ErasureRequest => ({
    requestId: op.requestId,
    tenantId: op.tenantId,
    scope: op.scope,
    ...(op.subject !== undefined ? { subject: contractSubject(op.subject) } : {}),
    ...(op.references !== undefined ? { references: op.references } : {}),
    dryRun: false,
  });
  const takeOverIfExpired = async (
    op: ErasureOperation,
  ): Promise<ErasureOperation> => {
    if (op.status !== "in_progress") return op;
    const leaseToken = randomUUID();
    const claimed = await store.claimExpired(op.requestId, leaseMs, leaseToken);
    if (claimed === null) return op; // still running, or another caller won
    logger?.warn("erasure operation lease expired — taking it over", {
      requestId: op.requestId,
    });
    return runOperation(claimed, requestOf(claimed), leaseToken);
  };
  const runOperation = async (
    operation: ErasureOperation,
    request: ErasureRequest,
    leaseToken: string,
  ): Promise<ErasureOperation> => {
    try {
      return await runLeased(operation, request, leaseToken);
    } catch (error) {
      if (!(error instanceof ErasureLeaseLostError)) throw error;
      // Another worker took the operation over: it owns the result now. This
      // run writes nothing further and reports what is stored.
      logger?.warn("erasure lease lost — stopping this run", { requestId: operation.requestId });
      return (await store.load(operation.requestId)) ?? operation;
    }
  };
  const runLeased = async (
    operation: ErasureOperation,
    request: ErasureRequest,
    leaseToken: string,
  ): Promise<ErasureOperation> => {
    /**
     * Lease heartbeat after every store group: a run longer than the lease
     * would otherwise be mistaken for a zombie and taken over while it is
     * still erasing. A lost lease (fencing token replaced) stops the run; a
     * database error on the heartbeat itself does not — the run goes on and
     * the lease may simply expire.
     */
    const heartbeat = async (): Promise<void> => {
      let held: boolean;
      try {
        held = await store.renewLease(operation.requestId, leaseToken);
      } catch (error) {
        logger?.warn("erasure lease heartbeat failed", {
          requestId: operation.requestId,
          error: errorMessage(error),
        });
        return;
      }
      if (!held) throw new ErasureLeaseLostError(operation.requestId);
    };
    const subject: ErasureSubject = {
      tenantId: request.tenantId,
      ...localUserIdentity(operation.subject),
    };
    // Only a tenant-scoped request may reach the local stores without a user:
    // they read a tenant-only subject as "erase the whole tenant". The runtime
    // holds no reference-addressed documents, so `reference` stays remote.
    const runLocal =
      request.scope === "tenant" ||
      (request.scope === "subject" && subject.userId !== undefined);

    const [localResults, remoteGroups] = await Promise.all([
      runLocal
        ? localForget(subject).then(async (local) => {
            await heartbeat();
            return local;
          })
        : Promise.resolve<ErasureStoreResult[]>([]),
      runRemote(request, undefined, heartbeat),
    ]);

    let results = localResults;
    let groups: { service: string; stores: string[] }[] = [];
    if (localResults.length > 0) {
      groups = mergeGroups(groups, RUNTIME_STORE_SERVICE, localResults.map((r) => r.store));
    }
    for (const group of remoteGroups) {
      results = mergeResults(results, group.results);
      groups = mergeGroups(groups, group.service, group.results.map((r) => r.store));
    }
    if (results.length === 0) {
      // Nothing was addressed (no local target applied, no remote target
      // configured): attesting `complete` would be a false erasure claim.
      results = [noStoresAddressed()];
      groups = mergeGroups(groups, RUNTIME_STORE_SERVICE, [NO_STORES_ADDRESSED]);
    }
    const completed: ErasureOperation = {
      ...operation,
      status: aggregateStatus(results),
      results,
      erased: results.reduce((n, r) => n + r.erased, 0),
      storeGroups: groups,
      updatedAt: new Date().toISOString(),
    };
    await store.update(completed);
    return finish(completed);
  };
  /** Receipt first (it hashes the subject), then drop the cleartext of a finished operation. */
  const finish = async (op: ErasureOperation): Promise<ErasureOperation> => {
    const withReceipt = await attachReceipt(op);
    if (withReceipt.status !== "complete") return withReceipt;
    await store.redactSubject(withReceipt.requestId);
    const redacted: ErasureOperation = { ...withReceipt };
    delete redacted.subject;
    return redacted;
  };
  const retry = async (requestId: string): Promise<ErasureOperation | null> => {
    const loaded = await store.load(requestId);
    if (loaded === null) return null;
    // A zombie (`in_progress` past its lease) is resumed; a live one is returned.
    const existing = await takeOverIfExpired(loaded);
    if (existing !== loaded || existing.status === "in_progress") return existing;
    const failedStores = existing.results
      .filter((r) => r.status === "failed")
      .map((r) => r.store);
    if (failedStores.length === 0) return existing;
    // Without its subject a subject-scoped operation cannot be re-run: the
    // local stores would read the missing user as "the whole tenant".
    if (existing.scope === "subject" && existing.subject === undefined) return existing;
    const request: ErasureRequest = {
      // A fresh idempotency key: the remote stores replay completed requests,
      // so a retry must present itself as a new (identical) erasure. The
      // operations are deletion-idempotent, so re-running is safe.
      ...requestOf(existing),
      requestId: randomUUID(),
    };

    const failedLocal = failedStores.filter(
      (s) => !existing.storeGroups.some((g) => g.service !== RUNTIME_STORE_SERVICE && g.stores.includes(s)),
    );
    const failedServices = [
      ...new Set(
        existing.storeGroups
          .filter((g) => g.service !== RUNTIME_STORE_SERVICE && g.stores.some((s) => failedStores.includes(s)))
          .map((g) => g.service),
      ),
    ];

    const [localResults, remoteGroups] = await Promise.all([
      failedLocal.length > 0
        ? localForget(
            {
              tenantId: existing.tenantId,
              ...localUserIdentity(existing.subject),
            },
            failedLocal,
          )
        : Promise.resolve<ErasureStoreResult[]>([]),
      runRemote(request, failedServices),
    ]);

    let results = existing.results;
    let groups = existing.storeGroups;
    if (localResults.length > 0) {
      results = mergeResults(results, localResults);
      groups = mergeGroups(groups, RUNTIME_STORE_SERVICE, localResults.map((r) => r.store));
    }
    for (const group of remoteGroups) {
      results = replaceServiceResults(results, groups, group.service, group.results);
      groups = mergeGroups(groups, group.service, group.results.map((r) => r.store));
    }

    const updated: ErasureOperation = {
      ...existing,
      status: aggregateStatus(results),
      results,
      erased: results.reduce((n, r) => n + r.erased, 0),
      storeGroups: groups,
      updatedAt: new Date().toISOString(),
    };
    await store.update(updated);
    return finish(updated);
  };
  const setReceipt = async (requestId: string, receipt: unknown): Promise<void> => {
    const existing = await store.load(requestId);
    if (existing === null) return;
    await store.update({ ...existing, receipt, updatedAt: new Date().toISOString() });
  };

  /**
   * Issue and persist the signed Erasure_Receipt for a completed operation
   * (Req 2.11). No-op without a configured key or without store results.
   */
  const attachReceipt = async (
    operation: ErasureOperation,
  ): Promise<ErasureOperation> => {
    if (receiptKey === undefined) return operation;
    const envelope = createSignedReceipt(operation, receiptKey);
    if (envelope === undefined) return operation;
    await setReceipt(operation.requestId, envelope);
    return { ...operation, receipt: envelope };
  };

  return {
    execute,
    retry,
    get: (requestId) => store.load(requestId),
    getByReceiptId: (receiptId) => store.loadByReceiptId(receiptId),
    setReceipt,
  };
}
