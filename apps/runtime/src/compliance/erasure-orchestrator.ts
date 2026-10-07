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
 * fail the operation. The route layer maps the aggregate to HTTP 200/207/502.
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
export type ErasureOperationStatus = "complete" | "partial" | "failed";

/**
 * A persisted erasure operation: the request identity plus the merged
 * per-store results. `storeGroups` records which store names each service
 * reported so a retry can re-run only the failed ones.
 */
export interface ErasureOperation {
  requestId: string;
  tenantId: string;
  scope: ErasureScope;
  subject?: ContractErasureSubject;
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
  execute(request: ErasureRequest): Promise<ErasureOperation>;
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

function rowToOperation(row: RowShape): ErasureOperation | null {
  if (!isScope(row.scope)) return null;
  const results = Array.isArray(row.results) ? row.results : [];
  return {
    requestId: row.request_id,
    tenantId: row.tenant_id,
    scope: row.scope,
    ...(row.subject !== null && row.subject !== undefined
      ? { subject: row.subject }
      : {}),
    ...(row.doc_references !== null && row.doc_references !== undefined
      ? { references: row.doc_references }
      : {}),
    status: row.status === "complete" || row.status === "partial" || row.status === "failed" ? row.status : "partial",
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Persistence abstraction so the orchestrator works with Postgres
 * (`erasure_requests`) or a process-local map when no database is configured.
 */
interface OperationStore {
  insert(op: ErasureOperation): Promise<ErasureOperation | null>;
  update(op: ErasureOperation): Promise<void>;
  load(requestId: string): Promise<ErasureOperation | null>;
  loadByReceiptId(receiptId: string): Promise<ErasureOperation | null>;
}

class InMemoryOperationStore implements OperationStore {
  private readonly map = new Map<string, ErasureOperation>();
  async insert(op: ErasureOperation): Promise<ErasureOperation | null> {
    const existing = this.map.get(op.requestId);
    if (existing !== undefined) return existing;
    this.map.set(op.requestId, op);
    return null;
  }
  async update(op: ErasureOperation): Promise<void> {
    this.map.set(op.requestId, op);
  }
  async load(requestId: string): Promise<ErasureOperation | null> {
    return this.map.get(requestId) ?? null;
  }
  async loadByReceiptId(receiptId: string): Promise<ErasureOperation | null> {
    for (const op of this.map.values()) {
      const payload = (op.receipt as ErasureReceiptEnvelope | undefined)?.payload;
      if (payload?.receiptId === receiptId) return op;
    }
    return null;
  }
}

class PostgresOperationStore implements OperationStore {
  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
  ) {}

  async insert(op: ErasureOperation): Promise<ErasureOperation | null> {
    const rows = await this.db.query<{ request_id: string }>(
      `INSERT INTO erasure_requests
         (request_id, tenant_id, scope, subject, doc_references, status,
          results, store_groups)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8::jsonb)
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
      ],
    );
    if (rows.length > 0) return null;
    // Conflict → an earlier request with this id exists; replay it.
    return this.load(op.requestId);
  }

  async update(op: ErasureOperation): Promise<void> {
    await this.db.query(
      `UPDATE erasure_requests
          SET status = $2, results = $3::jsonb, store_groups = $4::jsonb,
              receipt = COALESCE($5::jsonb, receipt), updated_at = now()
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
  ): Promise<{ service: string; results: ErasureStoreResult[] }[]> => {
    const selected =
      onlyServices === undefined
        ? targets
        : targets.filter((t) => onlyServices.includes(t.service));
    const settled = await Promise.all(
      selected.map(async (target) => ({
        service: target.service,
        results: await callRemoteTarget(target, request, {
          fetchImpl,
          token: envLookup(target.tokenEnv),
          timeoutMs,
          attempts,
          backoffBaseMs,
          ...(logger !== undefined ? { logger } : {}),
        }),
      })),
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
  ): Promise<ErasureOperation> => {
    const now = new Date().toISOString();
    const operation: ErasureOperation = {
      requestId: request.requestId,
      tenantId: request.tenantId,
      scope: request.scope,
      ...(request.subject !== undefined ? { subject: request.subject } : {}),
      ...(request.references !== undefined
        ? { references: request.references }
        : {}),
      status: "partial",
      results: [],
      erased: 0,
      storeGroups: [],
      createdAt: now,
      updatedAt: now,
    };
    const conflict = await store.insert(operation);
    if (conflict !== null) return conflict; // idempotent replay (Req 2.9)

    const subject: ErasureSubject = {
      tenantId: request.tenantId,
      ...(request.subject?.userId !== undefined
        ? { userId: request.subject.userId }
        : {}),
    };

    const [localResults, remoteGroups] = await Promise.all([
      localForget(subject),
      runRemote(request),
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

    const completed: ErasureOperation = {
      ...operation,
      status: aggregateStatus(results),
      results,
      erased: results.reduce((n, r) => n + r.erased, 0),
      storeGroups: groups,
      updatedAt: new Date().toISOString(),
    };
    await store.update(completed);
    return attachReceipt(completed);
  };

  const retry = async (requestId: string): Promise<ErasureOperation | null> => {
    const existing = await store.load(requestId);
    if (existing === null) return null;
    const failedStores = existing.results
      .filter((r) => r.status === "failed")
      .map((r) => r.store);
    if (failedStores.length === 0) return existing;

    const request: ErasureRequest = {
      // A fresh idempotency key: the remote stores replay completed requests,
      // so a retry must present itself as a new (identical) erasure. The
      // operations are deletion-idempotent, so re-running is safe.
      requestId: randomUUID(),
      tenantId: existing.tenantId,
      scope: existing.scope,
      ...(existing.subject !== undefined ? { subject: existing.subject } : {}),
      ...(existing.references !== undefined
        ? { references: existing.references }
        : {}),
      dryRun: false,
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
              ...(existing.subject?.userId !== undefined
                ? { userId: existing.subject.userId }
                : {}),
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
    return attachReceipt(updated);
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
