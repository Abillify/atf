// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHash } from "node:crypto";

export type InvocationState = "pending" | "running" | "committed" | "failed" | "outcome_unknown" | "compensated";

export interface InvocationRecord<Result = unknown> {
  key: string;
  fingerprint: string;
  state: InvocationState;
  result?: Result;
  updatedAt: string;
}

export type ClaimResult<Result = unknown> =
  | { kind: "claimed"; record: InvocationRecord<Result> }
  | { kind: "replay"; record: InvocationRecord<Result> }
  | { kind: "mismatch"; record: InvocationRecord<Result> }
  | { kind: "in_flight"; record: InvocationRecord<Result> }
  | { kind: "terminal"; record: InvocationRecord<Result> };

export interface InvocationLedger {
  readonly durability: "postgres" | "redis" | "single-process";
  claim(key: string, fingerprint: string): Promise<ClaimResult>;
  transition(key: string, fingerprint: string, state: InvocationState, result?: unknown): Promise<void>;
}

export interface PostgresInvocationExecutor {
  queryInvocationLedger(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function invocationFingerprint(tool: string, args: unknown, executionId: string): string {
  return createHash("sha256").update(canonical({ tool, args, executionId })).digest("hex");
}

export class MemoryInvocationLedger implements InvocationLedger {
  readonly durability = "single-process" as const;
  private readonly records = new Map<string, InvocationRecord>();

  async claim(key: string, fingerprint: string): Promise<ClaimResult> {
    const existing = this.records.get(key);
    if (!existing) {
      const record: InvocationRecord = { key, fingerprint, state: "pending", updatedAt: new Date().toISOString() };
      this.records.set(key, record);
      return { kind: "claimed", record };
    }
    if (existing.fingerprint !== fingerprint) return { kind: "mismatch", record: existing };
    if (existing.state === "committed") return { kind: "replay", record: existing };
    if (existing.state === "pending" || existing.state === "running") return { kind: "in_flight", record: existing };
    return { kind: "terminal", record: existing };
  }

  async transition(key: string, fingerprint: string, state: InvocationState, result?: unknown): Promise<void> {
    const existing = this.records.get(key);
    if (!existing || existing.fingerprint !== fingerprint) throw new Error("Invocation ledger transition conflict");
    this.records.set(key, { ...existing, state, ...(result === undefined ? {} : { result }), updatedAt: new Date().toISOString() });
  }
}

/** Minimal interface implemented by node-redis/ioredis adapters. EVAL keeps claim atomic across processes. */
export interface RedisEvalClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

const CLAIM_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return {'claimed', ARGV[1]}
end
local record = cjson.decode(current)
if record.fingerprint ~= ARGV[3] then return {'mismatch', current} end
if record.state == 'committed' then return {'replay', current} end
if record.state == 'pending' or record.state == 'running' then return {'in_flight', current} end
return {'terminal', current}
`;

const TRANSITION_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local record = cjson.decode(current)
if record.fingerprint ~= ARGV[2] then return -1 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
return 1
`;

export class RedisInvocationLedger implements InvocationLedger {
  readonly durability = "redis" as const;
  constructor(private readonly redis: RedisEvalClient, private readonly ttlMs = 86_400_000, private readonly prefix = "vectorsearch:invocation:") {}

  async claim(key: string, fingerprint: string): Promise<ClaimResult> {
    const record: InvocationRecord = { key, fingerprint, state: "pending", updatedAt: new Date().toISOString() };
    const raw = await this.redis.eval(CLAIM_SCRIPT, { keys: [this.prefix + key], arguments: [JSON.stringify(record), String(this.ttlMs), fingerprint] });
    if (!Array.isArray(raw) || raw.length !== 2) throw new Error("Invalid Redis invocation-ledger response");
    const kind = String(raw[0]) as ClaimResult["kind"];
    const stored = JSON.parse(String(raw[1])) as InvocationRecord;
    return { kind, record: stored } as ClaimResult;
  }

  async transition(key: string, fingerprint: string, state: InvocationState, result?: unknown): Promise<void> {
    const record: InvocationRecord = { key, fingerprint, state, ...(result === undefined ? {} : { result }), updatedAt: new Date().toISOString() };
    const changed = await this.redis.eval(TRANSITION_SCRIPT, { keys: [this.prefix + key], arguments: [JSON.stringify(record), fingerprint, String(this.ttlMs)] });
    if (Number(changed) !== 1) throw new Error("Invocation ledger transition conflict");
  }
}


const POSTGRES_LEDGER_TABLE = "vs_invocation_ledger";

/** Durable invocation ledger backed by the application's existing PostgreSQL pool. */
export class PostgresInvocationLedger implements InvocationLedger {
  readonly durability = "postgres" as const;

  constructor(
    private readonly postgres: PostgresInvocationExecutor,
    private readonly ttlMs = 86_400_000,
  ) {}

  async initialize(): Promise<void> {
    await this.postgres.queryInvocationLedger(`
      CREATE TABLE IF NOT EXISTS ${POSTGRES_LEDGER_TABLE} (
        key text PRIMARY KEY,
        fingerprint text NOT NULL,
        state text NOT NULL CHECK (state IN ('pending','running','committed','failed','outcome_unknown','compensated')),
        result jsonb,
        updated_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )
    `);
    await this.postgres.queryInvocationLedger(
      `CREATE INDEX IF NOT EXISTS vs_invocation_ledger_expires_at_idx ON ${POSTGRES_LEDGER_TABLE} (expires_at)`,
    );
    // Opportunistic retention keeps storage bounded without another timer or dependency.
    await this.postgres.queryInvocationLedger(
      `DELETE FROM ${POSTGRES_LEDGER_TABLE} WHERE expires_at <= now()`,
    );
  }

  async claim(key: string, fingerprint: string): Promise<ClaimResult> {
    const response = await this.postgres.queryInvocationLedger(
      `INSERT INTO ${POSTGRES_LEDGER_TABLE} AS ledger
         (key, fingerprint, state, updated_at, expires_at)
       VALUES ($1, $2, 'pending', now(), now() + ($3 * interval '1 millisecond'))
       ON CONFLICT (key) DO UPDATE SET
         fingerprint = EXCLUDED.fingerprint,
         state = 'pending', result = NULL,
         updated_at = now(), expires_at = EXCLUDED.expires_at
       WHERE ledger.expires_at <= now()
       RETURNING key, fingerprint, state, result, updated_at, (xmax = 0) AS inserted`,
      [key, fingerprint, this.ttlMs],
    );

    let row = response.rows[0];
    let claimed = row !== undefined;
    if (!row) {
      const existing = await this.postgres.queryInvocationLedger(
        `SELECT key, fingerprint, state, result, updated_at
           FROM ${POSTGRES_LEDGER_TABLE} WHERE key = $1`,
        [key],
      );
      row = existing.rows[0];
      claimed = false;
    }
    if (!row) throw new Error("Invocation ledger claim lost its record");

    const record = this.toRecord(row);
    if (claimed) return { kind: "claimed", record };
    if (record.fingerprint !== fingerprint) return { kind: "mismatch", record };
    if (record.state === "committed") return { kind: "replay", record };
    if (record.state === "pending" || record.state === "running") return { kind: "in_flight", record };
    return { kind: "terminal", record };
  }

  async transition(key: string, fingerprint: string, state: InvocationState, result?: unknown): Promise<void> {
    const response = await this.postgres.queryInvocationLedger(
      `UPDATE ${POSTGRES_LEDGER_TABLE}
          SET state = $3, result = $4::jsonb, updated_at = now(),
              expires_at = now() + ($5 * interval '1 millisecond')
        WHERE key = $1 AND fingerprint = $2
          AND state IN ('pending', 'running')`,
      [key, fingerprint, state, result === undefined ? null : JSON.stringify(result), this.ttlMs],
    );
    if (response.rowCount !== 1) throw new Error("Invocation ledger transition conflict");
  }

  private toRecord(row: Record<string, unknown>): InvocationRecord {
    const updated = row["updated_at"];
    return {
      key: String(row["key"]),
      fingerprint: String(row["fingerprint"]),
      state: String(row["state"]) as InvocationState,
      ...(row["result"] === null || row["result"] === undefined ? {} : { result: row["result"] }),
      updatedAt: updated instanceof Date ? updated.toISOString() : String(updated),
    };
  }
}
