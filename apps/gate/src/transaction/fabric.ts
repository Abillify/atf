// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import type { AuthContext } from "../auth/context.ts";
import type { ToolResult } from "../tools/types.ts";

export const TRANSACTION_TOKEN_META_KEY = "transaction/token";
export const LEGACY_TRANSACTION_TOKEN_META_KEY = "aiperator/transactionToken";
export const TRANSACTION_CAPABILITY_TOOL = "mcpgate_transaction_capabilities";

export type EnforcementMode = "off" | "optional" | "required";
export type InvocationState =
  | "pending"
  | "running"
  | "committed"
  | "failed"
  | "outcome_unknown"
  | "compensated";
export type ReservationKind = "acquired" | "replay" | "conflict" | "in_flight" | "unknown";

export interface TransactionBudget {
  maxCostUsd?: number;
  maxTokens?: number;
  maxDurationMs?: number;
  maxRetrievalDocuments?: number;
  maxToolCalls?: number;
}
export interface TransactionEnvelope {
  version: "v1";
  iss: string;
  aud: string | string[];
  iat: number;
  exp: number;
  jti: string;
  executionId: string;
  invocationId: string;
  userId?: string;
  tenantId?: string;
  agentId?: string;
  sessionId?: string;
  scopes: string[];
  groups: string[];
  purpose?: string;
  policyVersion?: string;
  decisionId?: string;
  dataClassification?: string;
  /** Preferred SHA-256 hash of the canonical Action Contract, when present. */
  actionContractHash?: string;
  /** Backward-compatible alias for actionContractHash. Conflicts fail closed. */
  evidenceContractHash?: string;
  budget: TransactionBudget;
  delegationChain: unknown[];
  trace: { traceId?: string; spanId?: string; traceparent?: string; deadlineAt?: string | number };
}
export interface TransactionContext {
  envelope: TransactionEnvelope;
  tool: string;
  payloadFingerprint: string;
  startedAt: number;
  /** Branch-local active tool chain; never shared across parallel nested actions. */
  ancestry: readonly string[];
  /** Branch-local stable logical path used to derive retry-safe child ledger IDs. */
  actionPath: readonly string[];
  /** Shared execution state for deterministic child ledger binding and root budgets. */
  execution: {
    readonly rootMaxToolCalls?: number;
    readonly rootDeadline?: number;
    toolCalls: number;
  };
}
export interface TransactionErrorBody {
  code: string;
  category:
    | "authentication"
    | "authorization"
    | "validation"
    | "conflict"
    | "budget"
    | "deadline"
    | "execution";
  retryable: boolean;
  outcome: InvocationState;
  invocationId?: string;
  traceId?: string;
}
export interface TransactionalSideEffect {
  sideEffect: "none" | "idempotent" | "non_idempotent";
  compensate?(context: TransactionContext, cause: unknown): Promise<void>;
}
export interface InvocationRecord {
  invocationId: string;
  fingerprint: string;
  state: InvocationState;
  result?: ToolResult;
  updatedAt: number;
}
export interface InvocationReservation {
  kind: ReservationKind;
  record: InvocationRecord;
}

/** Durable implementations must make reserve atomic across all replicas. */
export interface InvocationLedgerStore {
  readonly backing: "memory" | "redis";
  reserve(invocationId: string, fingerprint: string): Promise<InvocationReservation>;
  transition(invocationId: string, state: InvocationState, result?: ToolResult): Promise<void>;
  get(invocationId: string): Promise<InvocationRecord | undefined>;
  healthcheck?(): Promise<void>;
  close?(): Promise<void>;
}

export interface InvocationLedgerRetention {
  ttlSec: number;
  memoryMaxEntries?: number;
}
export interface MemoryInvocationLedgerOptions {
  ttlSec?: number;
  maxEntries?: number;
  now?: () => number;
}
const DEFAULT_RETENTION_TTL_SEC = 86_400;
const DEFAULT_MEMORY_MAX_ENTRIES = 10_000;
const protectedInvocationStates = new Set<InvocationState>([
  "pending",
  "running",
  "outcome_unknown",
]);

/** Single-process compatibility store only; not safe for replicas or restart recovery. */
export class MemoryInvocationLedger implements InvocationLedgerStore {
  readonly backing = "memory" as const;
  private readonly records = new Map<string, InvocationRecord>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  constructor(options: MemoryInvocationLedgerOptions = {}) {
    this.ttlMs = (options.ttlSec ?? DEFAULT_RETENTION_TTL_SEC) * 1_000;
    this.maxEntries = options.maxEntries ?? DEFAULT_MEMORY_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }
  private sweep(): void {
    const now = this.now();
    for (const [id, record] of this.records)
      if (!protectedInvocationStates.has(record.state) && now - record.updatedAt >= this.ttlMs)
        this.records.delete(id);
    if (this.records.size <= this.maxEntries) return;
    const evictable = [...this.records.values()]
      .filter((record) => !protectedInvocationStates.has(record.state))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const record of evictable) {
      if (this.records.size <= this.maxEntries) break;
      this.records.delete(record.invocationId);
    }
  }
  async reserve(invocationId: string, fingerprint: string): Promise<InvocationReservation> {
    this.sweep();
    const current = this.records.get(invocationId);
    if (!current) {
      const record: InvocationRecord = {
        invocationId,
        fingerprint,
        state: "pending",
        updatedAt: this.now(),
      };
      this.records.set(invocationId, record);
      this.sweep();
      return { kind: "acquired", record: structuredClone(record) };
    }
    if (current) current.updatedAt = this.now();
    if (current.fingerprint !== fingerprint)
      return { kind: "conflict", record: structuredClone(current) };
    if (current.state === "committed" && current.result)
      return { kind: "replay", record: structuredClone(current) };
    if (current.state === "pending" || current.state === "running")
      return { kind: "in_flight", record: structuredClone(current) };
    if (current.state === "outcome_unknown")
      return { kind: "unknown", record: structuredClone(current) };
    const record: InvocationRecord = {
      invocationId,
      fingerprint,
      state: "pending",
      updatedAt: this.now(),
    };
    this.records.set(invocationId, record);
    this.sweep();
    return { kind: "acquired", record: structuredClone(record) };
  }
  async transition(
    invocationId: string,
    state: InvocationState,
    result?: ToolResult,
  ): Promise<void> {
    this.sweep();
    const record = this.records.get(invocationId);
    if (!record) throw new Error(`Unknown invocation '${invocationId}'`);
    record.state = state;
    record.updatedAt = this.now();
    if (result !== undefined) record.result = structuredClone(result);
    this.sweep();
  }
  async get(invocationId: string): Promise<InvocationRecord | undefined> {
    this.sweep();
    const value = this.records.get(invocationId);
    return value ? structuredClone(value) : undefined;
  }
}
/** Backward-compatible name for callers that explicitly want single-process semantics. */
export class InvocationLedger extends MemoryInvocationLedger {}

type RedisClient = {
  connect(): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
};
export class RedisInvocationLedger implements InvocationLedgerStore {
  readonly backing = "redis" as const;
  private readonly ttlMs: number;
  constructor(
    private readonly client: RedisClient,
    private readonly prefix = "mcpgate:transaction:",
    ttlSec = DEFAULT_RETENTION_TTL_SEC,
  ) {
    this.ttlMs = ttlSec * 1_000;
  }
  private key(id: string): string {
    return `${this.prefix}${id}`;
  }
  async reserve(invocationId: string, fingerprint: string): Promise<InvocationReservation> {
    const now = String(Date.now());
    const raw = await this.client.eval(
      `
      local raw = redis.call('GET', KEYS[1])
      if not raw then
        local rec = cjson.encode({invocationId=ARGV[1], fingerprint=ARGV[2], state='pending', updatedAt=tonumber(ARGV[3])})
        redis.call('SET', KEYS[1], rec)
        return {'acquired', rec}
      end
      local rec = cjson.decode(raw)
      if rec.state == 'pending' or rec.state == 'running' or rec.state == 'outcome_unknown' then redis.call('PERSIST', KEYS[1]) else redis.call('PEXPIRE', KEYS[1], ARGV[4]) end
      if rec.fingerprint ~= ARGV[2] then return {'conflict', raw} end
      if rec.state == 'committed' and rec.result ~= nil then return {'replay', raw} end
      if rec.state == 'pending' or rec.state == 'running' then return {'in_flight', raw} end
      if rec.state == 'outcome_unknown' then return {'unknown', raw} end
      local next = cjson.encode({invocationId=ARGV[1], fingerprint=ARGV[2], state='pending', updatedAt=tonumber(ARGV[3])})
      redis.call('SET', KEYS[1], next)
      return {'acquired', next}
    `,
      {
        keys: [this.key(invocationId)],
        arguments: [invocationId, fingerprint, now, String(this.ttlMs)],
      },
    );
    const pair = raw as [ReservationKind, string];
    return { kind: pair[0], record: JSON.parse(pair[1]) as InvocationRecord };
  }
  async transition(
    invocationId: string,
    state: InvocationState,
    result?: ToolResult,
  ): Promise<void> {
    const encodedResult = result === undefined ? "" : JSON.stringify(result);
    const changed = await this.client.eval(
      `
      local raw = redis.call('GET', KEYS[1]); if not raw then return 0 end
      local rec = cjson.decode(raw); rec.state = ARGV[1]; rec.updatedAt = tonumber(ARGV[2])
      if ARGV[3] ~= '' then rec.result = cjson.decode(ARGV[3]) end
      if ARGV[1] == 'pending' or ARGV[1] == 'running' or ARGV[1] == 'outcome_unknown' then
        redis.call('SET', KEYS[1], cjson.encode(rec))
      else
        redis.call('SET', KEYS[1], cjson.encode(rec), 'PX', ARGV[4])
      end
      return 1
    `,
      {
        keys: [this.key(invocationId)],
        arguments: [state, String(Date.now()), encodedResult, String(this.ttlMs)],
      },
    );
    if (Number(changed) !== 1) throw new Error(`Unknown invocation '${invocationId}'`);
  }
  async get(invocationId: string): Promise<InvocationRecord | undefined> {
    const raw = await this.client.get(this.key(invocationId));
    return raw ? (JSON.parse(raw) as InvocationRecord) : undefined;
  }
  async healthcheck(): Promise<void> {
    const response = await this.client.ping();
    if (response !== "PONG") throw new Error("Transaction Redis healthcheck did not return PONG");
  }
  async close(): Promise<void> {
    await this.client.quit();
  }
}

export async function createInvocationLedger(
  redisUrl?: string,
  prefix?: string,
  retention: Partial<InvocationLedgerRetention> = {},
): Promise<InvocationLedgerStore> {
  const ttlSec = retention.ttlSec ?? DEFAULT_RETENTION_TTL_SEC;
  const memoryMaxEntries = retention.memoryMaxEntries ?? DEFAULT_MEMORY_MAX_ENTRIES;
  if (!redisUrl) return new MemoryInvocationLedger({ ttlSec, maxEntries: memoryMaxEntries });
  const redis = await import("redis");
  const client = redis.createClient({ url: redisUrl }) as unknown as RedisClient;
  await client.connect();
  return new RedisInvocationLedger(client, prefix, ttlSec);
}

export type TransactionSigningAlgorithm = "HS256" | "RS256" | "ES256" | "EdDSA";
const supportedSigningAlgorithms = new Set<TransactionSigningAlgorithm>([
  "HS256",
  "RS256",
  "ES256",
  "EdDSA",
]);
const asymmetricSigningAlgorithms = new Set<TransactionSigningAlgorithm>([
  "RS256",
  "ES256",
  "EdDSA",
]);

export interface TransactionFabricConfig {
  enforcement: EnforcementMode;
  secret?: string;
  jwksUri?: string;
  algorithms?: TransactionSigningAlgorithm[];
  issuer?: string;
  audience?: string;
  clockToleranceSec: number;
  maxTtlSec: number;
  userClaims?: string[];
  tenantClaims?: string[];
  groupClaims?: string[];
  sessionClaims?: string[];
  redisUrl?: string;
  redisPrefix?: string;
  retentionTtlSec?: number;
  memoryMaxEntries?: number;
}
const claimList = (raw: string | undefined, fallback: string[]): string[] =>
  raw === undefined
    ? fallback
    : raw
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
function signingAlgorithms(
  raw: string | undefined,
  secret?: string,
  jwksUri?: string,
  enforcement: EnforcementMode = "off",
): TransactionSigningAlgorithm[] {
  if (enforcement === "off" && !raw && !secret && !jwksUri) return [];
  const defaults: TransactionSigningAlgorithm[] = [
    ...(secret ? ["HS256" as const] : []),
    ...(jwksUri ? ["RS256" as const, "ES256" as const, "EdDSA" as const] : []),
  ];
  const values = claimList(raw, defaults);
  if (
    values.length === 0 ||
    values.some((value) => !supportedSigningAlgorithms.has(value as TransactionSigningAlgorithm))
  ) {
    throw new Error(
      "MCPGATE_TRANSACTION_ALGORITHMS must contain only HS256, RS256, ES256, or EdDSA",
    );
  }
  return [...new Set(values)] as TransactionSigningAlgorithm[];
}
export function transactionConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TransactionFabricConfig {
  const enforcement = (env.MCPGATE_TRANSACTION_ENFORCEMENT ?? "off") as EnforcementMode;
  if (!["off", "optional", "required"].includes(enforcement))
    throw new Error("MCPGATE_TRANSACTION_ENFORCEMENT must be off, optional, or required");
  const number = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`${name} must be a non-negative number`);
    return value;
  };
  const positiveInteger = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const secret = env.MCPGATE_TRANSACTION_HS256_SECRET;
  const jwksUri = env.MCPGATE_TRANSACTION_JWKS_URI;
  return {
    enforcement,
    secret,
    jwksUri,
    algorithms: signingAlgorithms(env.MCPGATE_TRANSACTION_ALGORITHMS, secret, jwksUri, enforcement),
    issuer: env.MCPGATE_TRANSACTION_ISSUER,
    audience: env.MCPGATE_TRANSACTION_AUDIENCE,
    clockToleranceSec: number("MCPGATE_TRANSACTION_CLOCK_TOLERANCE_SEC", 5),
    maxTtlSec: number("MCPGATE_TRANSACTION_MAX_TTL_SEC", 300),
    userClaims: claimList(env.MCPGATE_TRANSACTION_USER_CLAIMS, ["sub"]),
    tenantClaims: claimList(env.MCPGATE_TRANSACTION_TENANT_CLAIMS, ["tenant", "tid", "client_id"]),
    groupClaims: claimList(env.MCPGATE_TRANSACTION_GROUP_CLAIMS, ["groups"]),
    sessionClaims: claimList(env.MCPGATE_TRANSACTION_SESSION_CLAIMS, ["sid", "session_id"]),
    redisUrl: env.MCPGATE_TRANSACTION_REDIS_URL,
    redisPrefix: env.MCPGATE_TRANSACTION_REDIS_PREFIX ?? "mcpgate:transaction:",
    retentionTtlSec: positiveInteger(
      "MCPGATE_TRANSACTION_RETENTION_TTL_SEC",
      DEFAULT_RETENTION_TTL_SEC,
    ),
    memoryMaxEntries: positiveInteger(
      "MCPGATE_TRANSACTION_MEMORY_MAX_ENTRIES",
      DEFAULT_MEMORY_MAX_ENTRIES,
    ),
  };
}
export const transactionContext = new AsyncLocalStorage<TransactionContext>();
export const currentTransactionContext = (): TransactionContext | undefined =>
  transactionContext.getStore();

function normalizedStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}
function securityContext(
  auth: AuthContext | undefined,
  config: TransactionFabricConfig,
): Record<string, unknown> | null {
  if (!auth) return null;
  const claimValues = (names: string[]) =>
    Object.fromEntries(
      [...new Set(names)]
        .sort((a, b) => a.localeCompare(b))
        .map((name) => [name, normalizedStrings(valuesAt(auth.claims, [name]))]),
    );
  return {
    subject: auth.subject,
    tenantClaims: claimValues(config.tenantClaims ?? ["tenant", "tid", "client_id"]),
    sessions: authenticatedSessionIds(auth, config),
    groups: normalizedStrings(valuesAt(auth.claims, config.groupClaims ?? ["groups"])),
    scopes: normalizedStrings(auth.scopes),
  };
}
function canonicalSha256(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/iu.test(value)) throw new Error(`${label} must be a SHA-256 hex digest`);
  return value.toLowerCase();
}

function effectiveActionContractHash(envelope: TransactionEnvelope): string | undefined {
  const preferred =
    envelope.actionContractHash === undefined
      ? undefined
      : canonicalSha256(envelope.actionContractHash, "Envelope.actionContractHash");
  const alias =
    envelope.evidenceContractHash === undefined
      ? undefined
      : canonicalSha256(envelope.evidenceContractHash, "Envelope.evidenceContractHash");
  if (preferred !== undefined && alias !== undefined && preferred !== alias) {
    throw new Error("Envelope actionContractHash conflicts with evidenceContractHash alias");
  }
  if (preferred !== undefined) envelope.actionContractHash = preferred;
  if (alias !== undefined) envelope.evidenceContractHash = alias;
  return preferred ?? alias;
}

function fingerprint(
  tool: string,
  args: Record<string, unknown>,
  envelope: TransactionEnvelope,
  auth: AuthContext | undefined,
  config: TransactionFabricConfig,
  actionContractHash = effectiveActionContractHash(envelope),
): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, stable(v)]),
          )
        : value;
  return createHash("sha256")
    .update(
      JSON.stringify(
        stable({
          tool,
          args,
          executionId: envelope.executionId,
          actionContractHash,
          securityContext: securityContext(auth, config),
        }),
      ),
    )
    .digest("hex");
}
function errorResult(body: TransactionErrorBody, message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    structuredContent: { error: body },
  };
}
function validateEnvelope(payload: Record<string, unknown>): TransactionEnvelope {
  if (payload.version !== "v1") throw new Error("Envelope.version must be v1");
  for (const key of ["iss", "jti", "executionId", "invocationId"])
    if (typeof payload[key] !== "string" || payload[key] === "")
      throw new Error(`Envelope.${key} is required`);
  if (
    (!Array.isArray(payload.aud) && typeof payload.aud !== "string") ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number"
  )
    throw new Error("Envelope aud/iat/exp are invalid");
  if (!Array.isArray(payload.scopes) || !payload.scopes.every((v) => typeof v === "string"))
    throw new Error("Envelope.scopes must be a string array");
  if (
    !Array.isArray(payload.groups) ||
    !payload.groups.every((v) => typeof v === "string") ||
    !Array.isArray(payload.delegationChain)
  )
    throw new Error("Envelope groups/delegationChain must be arrays");
  if (
    !payload.budget ||
    typeof payload.budget !== "object" ||
    !payload.trace ||
    typeof payload.trace !== "object"
  )
    throw new Error("Envelope budget/trace are required");
  if (payload.evidencePackHash !== undefined) {
    throw new Error("Envelope.evidencePackHash is not a Transaction Envelope claim");
  }
  for (const key of ["actionContractHash", "evidenceContractHash"] as const) {
    const value = payload[key];
    if (value !== undefined) {
      if (typeof value !== "string")
        throw new Error(`Envelope.${key} must be a SHA-256 hex digest`);
      payload[key] = canonicalSha256(value, `Envelope.${key}`);
    }
  }
  effectiveActionContractHash(payload as unknown as TransactionEnvelope);
  return payload as unknown as TransactionEnvelope;
}
function valuesAt(claims: Record<string, unknown>, names: string[]): string[] {
  return names.flatMap((name) => {
    const value = claims[name];
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : typeof value === "string"
        ? [value]
        : [];
  });
}
/**
 * Session identifiers proven by the verified bearer. Only token claims count:
 * `AuthContext.sessionId` is the gate's own MCP transport/request id (see
 * `McpToolDispatcher`), never an IdP session, so including it made every
 * envelope that carried a real OIDC `sid` fail the binding check.
 */
function authenticatedSessionIds(auth: AuthContext, config: TransactionFabricConfig): string[] {
  return normalizedStrings(valuesAt(auth.claims, config.sessionClaims ?? ["sid", "session_id"]));
}
function assertIdentity(
  envelope: TransactionEnvelope,
  auth: AuthContext,
  config: TransactionFabricConfig,
): void {
  const userValues = new Set([
    auth.subject,
    ...valuesAt(auth.claims, config.userClaims ?? ["sub"]),
  ]);
  if (envelope.userId !== undefined && !userValues.has(envelope.userId))
    throw new Error("Envelope.userId does not match the authenticated subject");
  const tenant = auth.tenantId;
  if (envelope.tenantId !== undefined && envelope.tenantId !== tenant)
    throw new Error("Envelope.tenantId does not match the authenticated tenant claim");
  if (envelope.sessionId !== undefined) {
    const authenticatedSessions = new Set(authenticatedSessionIds(auth, config));
    if (authenticatedSessions.size > 0 && !authenticatedSessions.has(envelope.sessionId))
      throw new Error(
        `Envelope.sessionId does not match the authenticated session ` +
          `(session claims: ${(config.sessionClaims ?? ["sid", "session_id"]).join(", ")})`,
      );
  }
  const authenticatedGroups = new Set(valuesAt(auth.claims, config.groupClaims ?? ["groups"]));
  if (envelope.groups.some((group) => !authenticatedGroups.has(group)))
    throw new Error("Envelope.groups are not a subset of authenticated groups");
}

export class TransactionFabric {
  private readonly algorithms: TransactionSigningAlgorithm[];
  private readonly remoteJwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    readonly config: TransactionFabricConfig = transactionConfigFromEnv(),
    readonly ledger: InvocationLedgerStore = new MemoryInvocationLedger(),
  ) {
    this.algorithms = config.algorithms?.length
      ? config.algorithms
      : [
          ...(config.secret ? ["HS256" as const] : []),
          ...(config.jwksUri ? ["RS256" as const, "ES256" as const, "EdDSA" as const] : []),
        ];
    if (config.enforcement !== "off") {
      if (!config.issuer || !config.audience) {
        throw new Error(
          "MCPGATE_TRANSACTION_ISSUER and MCPGATE_TRANSACTION_AUDIENCE are required when transaction enforcement is enabled",
        );
      }
      if (!config.secret && !config.jwksUri) {
        throw new Error(
          "MCPGATE_TRANSACTION_HS256_SECRET or MCPGATE_TRANSACTION_JWKS_URI is required when transaction enforcement is enabled",
        );
      }
      if (this.algorithms.length === 0) {
        throw new Error(
          "At least one transaction signing algorithm is required when enforcement is enabled",
        );
      }
      if (this.algorithms.includes("HS256") && !config.secret) {
        throw new Error("MCPGATE_TRANSACTION_HS256_SECRET is required when HS256 is enabled");
      }
      if (
        this.algorithms.some((algorithm) => asymmetricSigningAlgorithms.has(algorithm)) &&
        !config.jwksUri
      ) {
        throw new Error(
          "MCPGATE_TRANSACTION_JWKS_URI is required when an asymmetric transaction algorithm is enabled",
        );
      }
    }
    if (this.algorithms.some((algorithm) => !supportedSigningAlgorithms.has(algorithm))) {
      throw new Error(
        "Transaction signing algorithms must contain only HS256, RS256, ES256, or EdDSA",
      );
    }
    if (config.jwksUri) this.remoteJwks = createRemoteJWKSet(new URL(config.jwksUri));
  }
  capabilityDocument(): Record<string, unknown> {
    return {
      version: "v1",
      tokenMetaKey: TRANSACTION_TOKEN_META_KEY,
      tokenMetaAliases: [LEGACY_TRANSACTION_TOKEN_META_KEY],
      enforcement: this.config.enforcement,
      signingAlgorithms: this.algorithms,
      idempotency: {
        states: ["pending", "running", "committed", "failed", "outcome_unknown", "compensated"],
        replayCommittedResults: true,
        backing: this.ledger.backing,
        retention: {
          ttlSec: this.config.retentionTtlSec ?? DEFAULT_RETENTION_TTL_SEC,
          ...(this.ledger.backing === "memory"
            ? {
                maxEntries: this.config.memoryMaxEntries ?? DEFAULT_MEMORY_MAX_ENTRIES,
                protectedStates: [...protectedInvocationStates],
              }
            : {}),
        },
      },
      envelopeFields: [
        "iss",
        "aud",
        "iat",
        "exp",
        "jti",
        "executionId",
        "invocationId",
        "userId?",
        "tenantId?",
        "agentId?",
        "sessionId?",
        "scopes",
        "groups",
        "purpose?",
        "policyVersion?",
        "decisionId?",
        "dataClassification?",
        "actionContractHash?",
        "evidenceContractHash? (compatibility alias)",
        "budget",
        "delegationChain",
        "trace",
      ],
      budgets: {
        semantics: "per-invocation admission",
        enforced: ["maxDurationMs", "maxToolCalls"],
      },
      evidenceActionContract: {
        metaKeys: [
          "evidence/actionContract",
          "evidence/actionContractHash",
          "evidence/evidenceContractHash",
          "evidence/evidencePackHash",
        ],
        transactionBinding: "actionContractHash",
        transactionBindingAliases: ["evidenceContractHash"],
        canonicalHashEncoding: "lowercase",
        responseEvidenceBinding:
          "evidence/evidencePackHash (metadata only; never an envelope claim)",
      },
    };
  }
  async execute(options: {
    token?: unknown;
    tool: string;
    args: Record<string, unknown>;
    /** Preferred SHA-256 of the canonical Action Contract from MCP metadata. */
    actionContractHash?: string;
    /** Backward-compatible alias for actionContractHash. */
    evidenceContractHash?: string;
    /** Stable identity of this nested action within its parent, reused across retries. */
    logicalActionId?: string;
    requiredScopes: string[];
    access?: "read" | "write";
    authContext?: AuthContext;
    run: (signal?: AbortSignal) => Promise<ToolResult>;
    sideEffect?: TransactionalSideEffect;
    onTelemetry?: (event: Record<string, unknown>) => void;
  }): Promise<ToolResult> {
    const preferredActionContractHash =
      options.actionContractHash === undefined
        ? undefined
        : canonicalSha256(options.actionContractHash, "actionContractHash");
    const compatibilityActionContractHash =
      options.evidenceContractHash === undefined
        ? undefined
        : canonicalSha256(options.evidenceContractHash, "evidenceContractHash");
    const suppliedActionContractHash =
      preferredActionContractHash ?? compatibilityActionContractHash;
    if (
      preferredActionContractHash !== undefined &&
      compatibilityActionContractHash !== undefined &&
      preferredActionContractHash !== compatibilityActionContractHash
    ) {
      return errorResult(
        {
          code: "ACTION_CONTRACT_CONFLICT",
          category: "validation",
          retryable: false,
          outcome: "failed",
        },
        "actionContractHash conflicts with evidenceContractHash alias",
      );
    }
    const parent = currentTransactionContext();
    if (
      this.config.enforcement === "off" ||
      (this.config.enforcement === "optional" &&
        options.token === undefined &&
        parent === undefined)
    )
      return options.run();
    if (typeof options.token !== "string" || options.token.length === 0)
      return errorResult(
        {
          code: "TRANSACTION_TOKEN_REQUIRED",
          category: "authentication",
          retryable: false,
          outcome: "failed",
        },
        "Transaction token required",
      );
    let envelope: TransactionEnvelope;
    try {
      const { alg } = decodeProtectedHeader(options.token);
      if (!alg || !this.algorithms.includes(alg as TransactionSigningAlgorithm))
        throw new Error(`Transaction token algorithm '${alg ?? "missing"}' is not allowed`);
      const verifyOptions = {
        algorithms: this.algorithms,
        issuer: this.config.issuer,
        audience: this.config.audience,
        clockTolerance: this.config.clockToleranceSec,
      };
      const verified =
        alg === "HS256"
          ? await jwtVerify(
              options.token,
              new TextEncoder().encode(this.config.secret),
              verifyOptions,
            )
          : await jwtVerify(options.token, this.remoteJwks!, verifyOptions);
      envelope = validateEnvelope(verified.payload);
      if (envelope.exp - envelope.iat > this.config.maxTtlSec)
        throw new Error("Envelope TTL exceeds maximum");
      if (options.authContext) assertIdentity(envelope, options.authContext, this.config);
    } catch (cause) {
      return errorResult(
        {
          code: "TRANSACTION_TOKEN_INVALID",
          category: "authentication",
          retryable: false,
          outcome: "failed",
        },
        `Invalid transaction token: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const envelopeActionContractHash = effectiveActionContractHash(envelope);
    if (envelopeActionContractHash !== suppliedActionContractHash) {
      return errorResult(
        {
          code: "EVIDENCE_CONTRACT_MISMATCH",
          category: "validation",
          retryable: false,
          outcome: "failed",
          invocationId: envelope.invocationId,
          traceId: envelope.trace.traceId,
        },
        "Evidence action contract is not bound to the transaction token",
      );
    }
    const traceId = envelope.trace.traceId;
    let effectiveInvocationId = envelope.invocationId;
    const base = {
      get invocationId() {
        return effectiveInvocationId;
      },
      traceId,
    };
    const tokenDeadline =
      typeof envelope.trace.deadlineAt === "number"
        ? envelope.trace.deadlineAt
        : envelope.trace.deadlineAt
          ? Date.parse(envelope.trace.deadlineAt)
          : undefined;
    if (tokenDeadline !== undefined && !Number.isFinite(tokenDeadline))
      return errorResult(
        {
          code: "TRANSACTION_DEADLINE_EXCEEDED",
          category: "deadline",
          retryable: false,
          outcome: "failed",
          ...base,
        },
        "Transaction deadline is invalid",
      );
    if (envelope.budget.maxDurationMs !== undefined && envelope.budget.maxDurationMs <= 0)
      return errorResult(
        {
          code: "TRANSACTION_BUDGET_EXCEEDED",
          category: "budget",
          retryable: false,
          outcome: "failed",
          ...base,
        },
        "Transaction duration budget exhausted",
      );
    const execution = parent?.execution ?? {
      ...(envelope.budget.maxToolCalls !== undefined
        ? { rootMaxToolCalls: envelope.budget.maxToolCalls }
        : {}),
      ...(tokenDeadline !== undefined ? { rootDeadline: tokenDeadline } : {}),
      toolCalls: 0,
    };
    if (parent && parent.envelope.executionId !== envelope.executionId)
      return errorResult(
        {
          code: "NESTED_TRANSACTION_CONTEXT_MISMATCH",
          category: "validation",
          retryable: false,
          outcome: "failed",
          ...base,
        },
        "Nested action transaction token does not match the active execution",
      );
    const effectiveDeadline = [execution.rootDeadline, tokenDeadline]
      .filter((value): value is number => value !== undefined)
      .reduce<number | undefined>(
        (earliest, value) => (earliest === undefined ? value : Math.min(earliest, value)),
        undefined,
      );
    if (effectiveDeadline !== undefined && Date.now() >= effectiveDeadline)
      return errorResult(
        {
          code: "TRANSACTION_DEADLINE_EXCEEDED",
          category: "deadline",
          retryable: false,
          outcome: "failed",
          ...base,
        },
        "Transaction deadline exceeded",
      );
    const ancestry = parent?.ancestry ?? [];
    if (ancestry.includes(options.tool) || ancestry.length >= 32)
      return errorResult(
        {
          code: "NESTED_TRANSACTION_RECURSION",
          category: "validation",
          retryable: false,
          outcome: "failed",
          ...base,
        },
        "Nested action recursion or maximum depth detected",
      );
    const effectiveMaxToolCalls = [execution.rootMaxToolCalls, envelope.budget.maxToolCalls]
      .filter((value): value is number => value !== undefined)
      .reduce<number | undefined>(
        (strictest, value) => (strictest === undefined ? value : Math.min(strictest, value)),
        undefined,
      );
    if (effectiveMaxToolCalls !== undefined && execution.toolCalls >= effectiveMaxToolCalls)
      return errorResult(
        {
          code: "TRANSACTION_BUDGET_EXCEEDED",
          category: "budget",
          retryable: false,
          outcome: "failed",
          ...base,
        },
        "Transaction tool-call budget exhausted",
      );
    const missing = options.requiredScopes.filter((scope) => !envelope.scopes.includes(scope));
    if (missing.length)
      return errorResult(
        {
          code: "TRANSACTION_SCOPE_DENIED",
          category: "authorization",
          retryable: false,
          outcome: "failed",
          ...base,
        },
        `Transaction envelope missing scope(s): ${missing.join(", ")}`,
      );
    if (
      parent &&
      (typeof options.logicalActionId !== "string" || options.logicalActionId.length === 0)
    )
      return errorResult(
        {
          code: "NESTED_ACTION_ID_REQUIRED",
          category: "validation",
          retryable: false,
          outcome: "failed",
          ...base,
        },
        "Nested action requires a stable logical identity",
      );
    execution.toolCalls++;
    const actionPath = parent ? [...parent.actionPath, options.logicalActionId!] : [];
    const childPathHash = createHash("sha256").update(JSON.stringify(actionPath)).digest("hex");
    const invocationId = parent
      ? `${envelope.invocationId}:child:${childPathHash}`
      : envelope.invocationId;
    effectiveInvocationId = invocationId;
    const payloadFingerprint = fingerprint(
      options.tool,
      options.args,
      envelope,
      options.authContext,
      this.config,
      suppliedActionContractHash,
    );
    const reservation = await this.ledger.reserve(invocationId, payloadFingerprint);
    if (reservation.kind === "replay" && reservation.record.result)
      return structuredClone(reservation.record.result);
    if (reservation.kind === "conflict")
      return errorResult(
        {
          code: "INVOCATION_CONFLICT",
          category: "conflict",
          retryable: false,
          outcome: reservation.record.state,
          ...base,
        },
        "Invocation ID was already used with a different payload",
      );
    if (reservation.kind === "in_flight")
      return errorResult(
        {
          code: "INVOCATION_IN_FLIGHT",
          category: "conflict",
          retryable: true,
          outcome: reservation.record.state,
          ...base,
        },
        "Invocation is already in flight",
      );
    if (reservation.kind === "unknown")
      return errorResult(
        {
          code: "INVOCATION_OUTCOME_UNKNOWN",
          category: "execution",
          retryable: false,
          outcome: "outcome_unknown",
          ...base,
        },
        "Previous invocation outcome is unknown; automatic retry refused",
      );
    const context: TransactionContext = {
      envelope,
      tool: options.tool,
      payloadFingerprint,
      startedAt: Date.now(),
      ancestry: [...ancestry, options.tool],
      actionPath,
      execution,
    };
    await this.ledger.transition(invocationId, "running");
    options.onTelemetry?.({
      phase: "running",
      executionId: envelope.executionId,
      invocationId,
      traceId,
      payloadFingerprint,
    });
    const runtimeLimitMs = Math.min(
      envelope.budget.maxDurationMs ?? Number.POSITIVE_INFINITY,
      effectiveDeadline === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, effectiveDeadline - Date.now()),
    );
    const hasRuntimeLimit = Number.isFinite(runtimeLimitMs);
    let timedOut = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = transactionContext.run(context, () => options.run(controller.signal));
      let result: ToolResult;
      if (!hasRuntimeLimit) result = await operation;
      else
        result = await new Promise<ToolResult>((resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            const deadlineExceeded =
              effectiveDeadline !== undefined && effectiveDeadline - Date.now() <= 0;
            const reason = deadlineExceeded
              ? "Transaction deadline exceeded"
              : "Transaction duration budget exceeded";
            controller.abort(new Error(reason));
            reject(new Error(`${reason}; cancellation requested but completion is not confirmed`));
          }, runtimeLimitMs);
          timer.unref?.();
          operation.then(resolve, reject);
        });
      const state: InvocationState = result.isError ? "failed" : "committed";
      await this.ledger.transition(invocationId, state, result);
      options.onTelemetry?.({
        phase: state,
        executionId: envelope.executionId,
        invocationId,
        traceId,
      });
      return result;
    } catch (cause) {
      let state: InvocationState =
        timedOut ||
        options.access === "write" ||
        options.sideEffect?.sideEffect === "non_idempotent"
          ? "outcome_unknown"
          : "failed";
      if (!timedOut && options.sideEffect?.compensate) {
        try {
          await options.sideEffect.compensate(context, cause);
          state = "compensated";
        } catch {
          state = "outcome_unknown";
        }
      }
      await this.ledger.transition(invocationId, state);
      options.onTelemetry?.({
        phase: state,
        executionId: envelope.executionId,
        invocationId,
        traceId,
      });
      return errorResult(
        {
          code:
            state === "outcome_unknown" ? "INVOCATION_OUTCOME_UNKNOWN" : "TOOL_EXECUTION_FAILED",
          category: "execution",
          retryable: state === "failed" && !timedOut,
          outcome: state,
          ...base,
        },
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
