// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";
import { createRedisClient, type RedisClientLike } from "../util/redis-client.js";
import { jsonColumn, repairStringScalarJsonSql } from "../db/json-column.js";

export type InvocationState =
  | "pending"
  | "running"
  | "committed"
  | "failed"
  | "outcome_unknown"
  | "compensated";

export type SideEffectSemantics = "read_only" | "idempotent" | "non_idempotent";

export interface InvocationSideEffectDescriptor {
  tool: string;
  semantics: SideEffectSemantics;
  reversible?: boolean;
}

export interface InvocationEvidence {
  summary: string;
  kind?: string;
}

export interface InvocationRecord<T = unknown> {
  invocationId: string;
  payloadFingerprint: string;
  state: InvocationState;
  createdAt: number;
  updatedAt: number;
  sideEffect: InvocationSideEffectDescriptor;
  result?: T;
  resultEvidence?: InvocationEvidence;
  error?: string;
  errorEvidence?: InvocationEvidence;
  retryable?: boolean;
  compensationInvocationId?: string;
}

export interface InvocationClaim<T = unknown> {
  acquired: boolean;
  record: InvocationRecord<T>;
}

export interface InvocationClaimInput {
  invocationId: string;
  payloadFingerprint: string;
  sideEffect: InvocationSideEffectDescriptor;
}

export interface InvocationUpdate<T = unknown> {
  result?: T;
  resultEvidence?: InvocationEvidence;
  error?: string;
  errorEvidence?: InvocationEvidence;
  retryable?: boolean;
  compensationInvocationId?: string;
}

export interface InvocationLedgerStore<T = unknown> {
  claim(input: InvocationClaimInput): InvocationClaim<T> | Promise<InvocationClaim<T>>;
  get(invocationId: string): InvocationRecord<T> | undefined | Promise<InvocationRecord<T> | undefined>;
  transition(
    invocationId: string,
    state: InvocationState,
    update?: InvocationUpdate<T>,
  ): InvocationRecord<T> | Promise<InvocationRecord<T>>;
  listStale(before: number, states?: readonly InvocationState[]): InvocationRecord<T>[] | Promise<InvocationRecord<T>[]>;
}

const transitions: Record<InvocationState, readonly InvocationState[]> = {
  pending: ["running", "failed", "outcome_unknown"],
  running: ["committed", "failed", "outcome_unknown"],
  committed: ["compensated"],
  failed: [],
  outcome_unknown: ["committed", "failed", "compensated"],
  compensated: [],
};

function clone<T>(record: InvocationRecord<T>): InvocationRecord<T> {
  return structuredClone(record);
}

function assertTransition(from: InvocationState, to: InvocationState): void {
  if (!transitions[from].includes(to)) {
    throw new Error(`Invalid invocation transition: ${from} -> ${to}`);
  }
}

const legacySideEffect: InvocationSideEffectDescriptor = {
  tool: "unknown",
  semantics: "non_idempotent",
};

/** Process-local fallback. Its claim is atomic within one JS isolate, not cluster-wide. */
export class InMemoryInvocationLedger<T = unknown> implements InvocationLedgerStore<T> {
  private readonly records = new Map<string, InvocationRecord<T>>();
  constructor(private readonly now = () => Date.now()) {}

  claim(input: InvocationClaimInput | string): InvocationClaim<T> {
    const normalized: InvocationClaimInput =
      typeof input === "string"
        ? { invocationId: input, payloadFingerprint: input, sideEffect: legacySideEffect }
        : input;
    const existing = this.records.get(normalized.invocationId);
    if (existing) return { acquired: false, record: clone(existing) };
    const at = this.now();
    const record: InvocationRecord<T> = {
      ...normalized,
      sideEffect: { ...normalized.sideEffect },
      state: "pending",
      createdAt: at,
      updatedAt: at,
    };
    this.records.set(normalized.invocationId, record);
    return { acquired: true, record: clone(record) };
  }

  get(invocationId: string): InvocationRecord<T> | undefined {
    const value = this.records.get(invocationId);
    return value ? clone(value) : undefined;
  }

  transition(invocationId: string, state: InvocationState, update: InvocationUpdate<T> = {}): InvocationRecord<T> {
    const current = this.records.get(invocationId);
    if (!current) throw new Error(`Unknown invocation: ${invocationId}`);
    assertTransition(current.state, state);
    const next = { ...current, ...update, state, updatedAt: this.now() };
    this.records.set(invocationId, next);
    return clone(next);
  }

  listStale(before: number, states: readonly InvocationState[] = ["pending", "running"]): InvocationRecord<T>[] {
    return [...this.records.values()]
      .filter((record) => record.updatedAt <= before && states.includes(record.state))
      .map(clone);
  }
}

const CLAIM_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return {0, redis.call('GET', KEYS[1])} end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
return {1, ARGV[1]}`;

const TRANSITION_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {0, 'missing'} end
local rec = cjson.decode(raw)
local allowed = false
for state in string.gmatch(ARGV[1], '[^,]+') do if rec.state == state then allowed = true end end
if not allowed then return {0, rec.state} end
local next = cjson.decode(ARGV[2])
redis.call('SET', KEYS[1], ARGV[2])
redis.call('ZADD', KEYS[2], next.updatedAt, next.invocationId)
return {1, ARGV[2]}`;

export interface RedisInvocationLedgerOptions { prefix?: string }

/** Redis-backed ledger. Claim and compare-and-transition are single Lua operations. */
export class RedisInvocationLedger<T = unknown> implements InvocationLedgerStore<T> {
  private readonly prefix: string;
  constructor(
    private readonly client: RedisClientLike,
    private readonly now = () => Date.now(),
    options: RedisInvocationLedgerOptions = {},
  ) {
    this.prefix = options.prefix ?? "aiperator:invocation";
  }
  private key(id: string): string { return `${this.prefix}:${id}`; }
  private index(): string { return `${this.prefix}:updated`; }

  async claim(input: InvocationClaimInput): Promise<InvocationClaim<T>> {
    const at = this.now();
    const record: InvocationRecord<T> = { ...input, state: "pending", createdAt: at, updatedAt: at };
    const value = await this.client.send("EVAL", [CLAIM_SCRIPT, "2", this.key(input.invocationId), this.index(), JSON.stringify(record), String(at), input.invocationId]);
    const tuple = value as unknown[];
    return { acquired: Number(tuple?.[0]) === 1, record: JSON.parse(String(tuple?.[1])) as InvocationRecord<T> };
  }

  async get(invocationId: string): Promise<InvocationRecord<T> | undefined> {
    const raw = await this.client.send("GET", [this.key(invocationId)]);
    return raw === null || raw === undefined ? undefined : JSON.parse(String(raw)) as InvocationRecord<T>;
  }

  async transition(invocationId: string, state: InvocationState, update: InvocationUpdate<T> = {}): Promise<InvocationRecord<T>> {
    const current = await this.get(invocationId);
    if (!current) throw new Error(`Unknown invocation: ${invocationId}`);
    assertTransition(current.state, state);
    const next: InvocationRecord<T> = { ...current, ...update, state, updatedAt: this.now() };
    const allowedFrom = Object.entries(transitions).filter(([, targets]) => targets.includes(state)).map(([from]) => from).join(",");
    const value = await this.client.send("EVAL", [TRANSITION_SCRIPT, "2", this.key(invocationId), this.index(), allowedFrom, JSON.stringify(next)]);
    const tuple = value as unknown[];
    if (Number(tuple?.[0]) !== 1) throw new Error(`Invalid invocation transition: ${String(tuple?.[1])} -> ${state}`);
    return JSON.parse(String(tuple?.[1])) as InvocationRecord<T>;
  }

  async listStale(before: number, states: readonly InvocationState[] = ["pending", "running"]): Promise<InvocationRecord<T>[]> {
    const ids = await this.client.send("ZRANGEBYSCORE", [this.index(), "-inf", String(before)]);
    const records = await Promise.all((Array.isArray(ids) ? ids : []).map((id) => this.get(String(id))));
    return records.filter((record): record is InvocationRecord<T> => record !== undefined && states.includes(record.state));
  }
}

/** Postgres-backed ledger using a primary-key insert for claim and row locks for transitions. */
export class PostgresInvocationLedger<T = unknown> implements InvocationLedgerStore<T> {
  private initialized?: Promise<void>;
  constructor(private readonly db: Database, private readonly now = () => Date.now()) {}
  private init(): Promise<void> {
    this.initialized ??= this.db.query(`CREATE TABLE IF NOT EXISTS invocation_ledger (
      invocation_id TEXT PRIMARY KEY, record JSONB NOT NULL, updated_at BIGINT NOT NULL
    )`)
      // Records written before the `::text::jsonb` fix are string scalars.
      .then(() => this.db.query(repairStringScalarJsonSql("invocation_ledger", "record")))
      .then(() => undefined);
    return this.initialized;
  }
  async claim(input: InvocationClaimInput): Promise<InvocationClaim<T>> {
    await this.init();
    const at = this.now();
    const record: InvocationRecord<T> = { ...input, state: "pending", createdAt: at, updatedAt: at };
    const rows = await this.db.query<{ record: InvocationRecord<T> }>(
      `INSERT INTO invocation_ledger(invocation_id, record, updated_at) VALUES ($1,$2::text::jsonb,$3)
       ON CONFLICT (invocation_id) DO NOTHING RETURNING record`,
      [input.invocationId, JSON.stringify(record), at],
    );
    if (rows[0]) return { acquired: true, record: jsonColumn<InvocationRecord<T>>(rows[0].record) as InvocationRecord<T> };
    const existing = await this.get(input.invocationId);
    if (!existing) throw new Error(`Invocation claim lost: ${input.invocationId}`);
    return { acquired: false, record: existing };
  }
  async get(invocationId: string): Promise<InvocationRecord<T> | undefined> {
    await this.init();
    const rows = await this.db.query<{ record: InvocationRecord<T> }>("SELECT record FROM invocation_ledger WHERE invocation_id=$1", [invocationId]);
    return jsonColumn<InvocationRecord<T>>(rows[0]?.record);
  }
  async transition(invocationId: string, state: InvocationState, update: InvocationUpdate<T> = {}): Promise<InvocationRecord<T>> {
    await this.init();
    const allowed = Object.entries(transitions).filter(([, targets]) => targets.includes(state)).map(([from]) => from);
    const at = this.now();
    const rows = await this.db.query<{ record: InvocationRecord<T> }>(
      `UPDATE invocation_ledger SET record = record || $2::text::jsonb, updated_at=$3
       WHERE invocation_id=$1
         AND record->>'state' IN (
           SELECT jsonb_array_elements_text(
             CASE jsonb_typeof($4::text::jsonb)
               WHEN 'array' THEN $4::text::jsonb
               ELSE jsonb_build_array($4::text::jsonb)
             END
           )
         )
       RETURNING record`,
      [invocationId, JSON.stringify({ ...update, state, updatedAt: at }), at, JSON.stringify(allowed)],
    );
    if (!rows[0]) {
      const current = await this.get(invocationId);
      if (!current) throw new Error(`Unknown invocation: ${invocationId}`);
      throw new Error(`Invalid invocation transition: ${current.state} -> ${state}`);
    }
    return jsonColumn<InvocationRecord<T>>(rows[0].record) as InvocationRecord<T>;
  }
  async listStale(before: number, states: readonly InvocationState[] = ["pending", "running"]): Promise<InvocationRecord<T>[]> {
    await this.init();
    const rows = await this.db.query<{ record: InvocationRecord<T> }>(
      `SELECT record FROM invocation_ledger
        WHERE updated_at <= $1
          AND record->>'state' IN (
            SELECT jsonb_array_elements_text(
              CASE jsonb_typeof($2::text::jsonb)
                WHEN 'array' THEN $2::text::jsonb
                ELSE jsonb_build_array($2::text::jsonb)
              END
            )
          )`,
      [before, JSON.stringify(states)],
    );
    return rows.map((row) => jsonColumn<InvocationRecord<T>>(row.record) as InvocationRecord<T>);
  }
}

export function createInvocationLedger(options: {
  redisUrl?: string;
  database?: Database;
  logger?: Logger;
  now?: () => number;
} = {}): InvocationLedgerStore<unknown> {
  const now = options.now ?? Date.now;
  if (options.redisUrl) {
    const client = createRedisClient(options.redisUrl, "Invocation ledger", options.logger);
    if (client) return new RedisInvocationLedger(client, now);
  }
  if (options.database) return new PostgresInvocationLedger(options.database, now);
  options.logger?.warn("Invocation ledger has no durable backing; using process-local memory", { deduplicationScope: "single-process" });
  return new InMemoryInvocationLedger(now);
}
