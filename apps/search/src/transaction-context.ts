// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { jwtVerify } from "jose";
import * as z from "zod";
import type { RequestPrincipal } from "./request-principal.js";

export type TransactionEnforcement = "off" | "optional" | "required";

const budgetSchema = z.object({
  maxCostUsd: z.number().nonnegative().optional(),
  maxTokens: z.number().int().nonnegative().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  maxRetrievalDocuments: z.number().int().nonnegative().optional(),
  maxToolCalls: z.number().int().nonnegative().optional(),
}).strict();

const traceSchema = z.object({
  traceId: z.string().min(1).optional(),
  spanId: z.string().min(1).optional(),
  traceparent: z.string().min(1).optional(),
  deadlineAt: z.union([z.string().datetime(), z.number().int().positive()]).optional(),
}).strict();

export const transactionEnvelopeSchema = z.object({
  version: z.literal("v1"),
  iss: z.string().min(1), aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  iat: z.number().int(), exp: z.number().int(), jti: z.string().min(1),
  executionId: z.string().min(1), invocationId: z.string().min(1),
  userId: z.string().min(1).optional(), tenantId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(), sessionId: z.string().min(1).optional(),
  /** Preferred v1 binding supplied by an orchestrator for the input action contract. */
  actionContractHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  /** Compatibility alias for actionContractHash; never denotes a response evidence pack. */
  evidenceContractHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  scopes: z.array(z.string()), groups: z.array(z.string()), purpose: z.string().optional(),
  policyVersion: z.string().optional(), decisionId: z.string().optional(),
  dataClassification: z.string().optional(), budget: budgetSchema,
  delegationChain: z.array(z.unknown()), trace: traceSchema,
}).strict().superRefine((value, context) => {
  if (value.actionContractHash && value.evidenceContractHash &&
      value.actionContractHash.toLowerCase() !== value.evidenceContractHash.toLowerCase()) {
    context.addIssue({
      code: "custom",
      path: ["evidenceContractHash"],
      message: "actionContractHash and evidenceContractHash alias must match",
    });
  }
});

export type TransactionEnvelope = z.infer<typeof transactionEnvelopeSchema>;
export interface TransactionContext { envelope: TransactionEnvelope | null; legacy: boolean; }
export interface TransactionConfig {
  enforcement: TransactionEnforcement; secret: string | null; issuer: string;
  audience: string; clockToleranceSeconds: number; maxTtlSeconds: number;
}
export interface FabricErrorBody {
  code: string; category: "authentication" | "authorization" | "budget" | "deadline" | "validation" | "conflict" | "internal";
  retryable: boolean; outcome: "denied" | "failed" | "outcome_unknown"; invocationId?: string; traceId?: string;
}
const transactionErrorBrand = Symbol.for("@atf/search/TransactionError");

export class TransactionError extends Error {
  readonly [transactionErrorBrand] = true;

  constructor(public readonly status: number, public readonly body: FabricErrorBody, message: string) {
    super(message);
    this.name = "TransactionError";
  }
}

/** Recognize transaction errors across duplicate ESM module instances. */
export function isTransactionError(value: unknown): value is TransactionError {
  return typeof value === "object" && value !== null &&
    (value as Record<PropertyKey, unknown>)[transactionErrorBrand] === true;
}

const storage = new AsyncLocalStorage<TransactionContext>();
export const runWithTransaction = <T>(context: TransactionContext, fn: () => T): T => storage.run(context, fn);
export const getTransactionContext = (): TransactionContext | undefined => storage.getStore();
export const requireTransactionContext = (): TransactionContext => {
  const value = storage.getStore();
  if (!value) throw new TransactionError(500, { code: "TRANSACTION_CONTEXT_MISSING", category: "internal", retryable: false, outcome: "failed" }, "Transaction context missing");
  return value;
};

function error(code: string, category: FabricErrorBody["category"], status: number, envelope?: Partial<TransactionEnvelope>): TransactionError {
  return new TransactionError(status, { code, category, retryable: false, outcome: "denied", ...(envelope?.invocationId ? { invocationId: envelope.invocationId } : {}), ...(envelope?.trace?.traceId ? { traceId: envelope.trace.traceId } : {}) }, code);
}
function deadlineMs(value: string | number): number { return typeof value === "number" ? (value < 10_000_000_000 ? value * 1000 : value) : Date.parse(value); }

/** Canonical set semantics prevent ordering/duplicate differences across fabric participants. */
function canonicalClaims(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function canonicalEnvelope(envelope: TransactionEnvelope): TransactionEnvelope {
  return {
    ...envelope,
    ...(envelope.tenantId ? { tenantId: envelope.tenantId.trim() } : {}),
    ...(envelope.actionContractHash ? { actionContractHash: envelope.actionContractHash.toLowerCase() } : {}),
    ...(envelope.evidenceContractHash ? { evidenceContractHash: envelope.evidenceContractHash.toLowerCase() } : {}),
    scopes: canonicalClaims(envelope.scopes),
    groups: canonicalClaims(envelope.groups),
  };
}

export function canonicalActionContractHash(envelope: Pick<TransactionEnvelope, "actionContractHash" | "evidenceContractHash">): string | undefined {
  const preferred = envelope.actionContractHash?.toLowerCase();
  const alias = envelope.evidenceContractHash?.toLowerCase();
  // Schema validation rejects disagreement. Keep this guard for callers that
  // construct a TransactionEnvelope outside verifyTransactionToken.
  if (preferred && alias && preferred !== alias) {
    throw error("ACTION_CONTRACT_HASH_MISMATCH", "validation", 400, envelope);
  }
  return preferred ?? alias;
}

export async function verifyTransactionToken(token: string | undefined, config: TransactionConfig, principal: RequestPrincipal, now = Date.now()): Promise<TransactionContext> {
  if (config.enforcement === "off") return { envelope: null, legacy: true };
  if (!token) {
    if (config.enforcement === "required") throw error("TRANSACTION_TOKEN_REQUIRED", "authentication", 401);
    return { envelope: null, legacy: true };
  }
  if (!config.secret) throw error("TRANSACTION_CONFIG_INVALID", "internal", 500);
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(config.secret), { algorithms: ["HS256"], issuer: config.issuer, audience: config.audience, clockTolerance: config.clockToleranceSeconds }));
  } catch { throw error("TRANSACTION_TOKEN_INVALID", "authentication", 401); }
  const parsed = transactionEnvelopeSchema.safeParse(payload);
  if (!parsed.success) throw error("TRANSACTION_ENVELOPE_INVALID", "validation", 400);
  const envelope = canonicalEnvelope(parsed.data);
  if (envelope.exp - envelope.iat > config.maxTtlSeconds) throw error("TRANSACTION_TTL_EXCEEDED", "authentication", 401, envelope);
  if (principal.tenantId !== undefined && envelope.tenantId !== principal.tenantId) throw error("TENANT_MISMATCH", "authorization", 403, envelope);
  if (principal.tenantId === undefined && envelope.tenantId !== undefined) throw error("TENANT_MISMATCH", "authorization", 403, envelope);
  if (principal.userId && envelope.userId !== principal.userId) throw error("TRANSACTION_IDENTITY_MISMATCH", "authorization", 403, envelope);
  if (envelope.groups.some((group) => !principal.userGroups?.includes(group))) throw error("TRANSACTION_IDENTITY_MISMATCH", "authorization", 403, envelope);
  const deadlines = [envelope.trace.deadlineAt === undefined ? undefined : deadlineMs(envelope.trace.deadlineAt), envelope.budget.maxDurationMs === undefined ? undefined : envelope.iat * 1000 + envelope.budget.maxDurationMs].filter((v): v is number => v !== undefined);
  if (deadlines.some((deadline) => now >= deadline)) throw error("TRANSACTION_DEADLINE_EXCEEDED", "deadline", 408, envelope);
  return { envelope, legacy: false };
}

export function enforceRetrievalBudget(requested: number): number {
  const envelope = requireTransactionContext().envelope;
  const maximum = envelope?.budget.maxRetrievalDocuments;
  if (maximum !== undefined && requested > maximum) throw error("RETRIEVAL_BUDGET_EXCEEDED", "budget", 403, envelope ?? undefined);
  return requested;
}
export function transactionCorrelation(): Record<string, string> {
  const e = storage.getStore()?.envelope;
  return e ? { executionId: e.executionId, invocationId: e.invocationId, ...(e.tenantId ? { tenantId: e.tenantId } : {}), ...(e.agentId ? { agentId: e.agentId } : {}), ...(e.trace.traceId ? { traceId: e.trace.traceId } : {}) } : {};
}
export function stableHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
/**
 * Extract a transaction token from a JSON-RPC tool call.
 *
 * `transaction/token` is the product-neutral v1 key. The former
 * `aiperator/transactionToken` key remains a compatibility alias so existing
 * clients can migrate without a flag day. HTTP handlers may additionally pass
 * an `X-Transaction-Token` header as `headerToken`; this is useful for clients
 * that cannot attach MCP request metadata.
 */
export function extractTransactionToken(
  body: unknown,
  headerToken?: string,
): string | undefined {
  if (typeof headerToken === "string" && headerToken.trim().length > 0) {
    return headerToken.trim();
  }
  if (!body || typeof body !== "object") return undefined;
  const params = (body as Record<string, unknown>)["params"];
  if (!params || typeof params !== "object") return undefined;
  const meta = (params as Record<string, unknown>)["_meta"];
  if (!meta || typeof meta !== "object") return undefined;
  const values = meta as Record<string, unknown>;
  const token = values["transaction/token"] ?? values["aiperator/transactionToken"];
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

export const READ_TOOL_SCOPES = ["retrieve", "search", "read"] as const;
export const WRITE_TOOL_SCOPES: Readonly<Record<string, readonly string[]>> = {
  ingest: ["write", "ingest"],
  delete_document: ["write", "delete"],
};

export function enforceToolScope(tool: string): void {
  const context = requireTransactionContext();
  if (context.legacy || !context.envelope) return;
  const accepted = WRITE_TOOL_SCOPES[tool] ?? READ_TOOL_SCOPES;
  if (context.envelope.scopes.includes(`tool:${tool}`) || accepted.some((scope) => context.envelope!.scopes.includes(scope))) return;
  throw error("TOOL_SCOPE_DENIED", "authorization", 403, context.envelope);
}
