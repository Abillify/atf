// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import crypto from "node:crypto";
import { NO_TENANT } from "../assistants/types.js";
import type { AgentExecutionContext } from "../types/monitoring.js";
import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";
import { TransactionBudgetCoordinator } from "./budget.js";
import {
  createInvocationLedger,
  type InvocationLedgerStore,
  type InvocationSideEffectDescriptor,
} from "./ledger.js";
import { TransactionTokenIssuer, transactionTokenConfigFromEnv } from "./token.js";
import type { TransactionBudget, TransactionMeta, TransactionTrace } from "./types.js";

const DEFAULT_MAX_TOOL_CALLS = 100;
const DEFAULT_MAX_DURATION_MS = 60_000;

export type TransactionCompletion = "committed" | "failed" | "outcome_unknown";

export interface TransactionInvocation {
  invocationId: string;
  transaction?: TransactionMeta;
  complete(outcome: TransactionCompletion, detail?: unknown): Promise<void>;
}

export interface TransactionBeginOptions {
  payload?: unknown;
  payloadFingerprint?: string;
  /** Preferred SHA-256 of the canonical Evidence-Bound Action Contract. */
  actionContractHash?: string;
  /** Compatibility alias for actionContractHash. */
  evidenceContractHash?: string;
  sideEffect?: InvocationSideEffectDescriptor;
  /**
   * Bind the envelope to the caller's authenticated IdP session (`sid`).
   * Default true. Must be false when the target server receives an exchanged
   * token, whose session does not match the caller's — the gate would
   * otherwise reject every call with "Envelope.sessionId does not match".
   */
  bindSession?: boolean;
}

export interface TransactionOrchestratorOptions {
  env?: Record<string, string | undefined>;
  now?: () => number;
  ledger?: InvocationLedgerStore<unknown>;
  database?: Database;
  logger?: Logger;
  budgetCoordinator?: TransactionBudgetCoordinator;
}

function canonicalContractHash(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/iu.test(value)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
  return value.toLowerCase();
}

function positiveNumber(value: string | undefined, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Transaction budget values must be positive numbers");
  }
  return parsed;
}

function budgetFromEnv(env: Record<string, string | undefined>): TransactionBudget {
  return {
    maxToolCalls: positiveNumber(env.AGENT_TRANSACTION_MAX_TOOL_CALLS, DEFAULT_MAX_TOOL_CALLS),
    maxDurationMs: positiveNumber(env.AGENT_TRANSACTION_MAX_DURATION_MS, DEFAULT_MAX_DURATION_MS),
    ...(positiveNumber(env.AGENT_TRANSACTION_MAX_COST_USD) !== undefined
      ? { maxCostUsd: positiveNumber(env.AGENT_TRANSACTION_MAX_COST_USD) }
      : {}),
    ...(positiveNumber(env.AGENT_TRANSACTION_MAX_TOKENS) !== undefined
      ? { maxTokens: positiveNumber(env.AGENT_TRANSACTION_MAX_TOKENS) }
      : {}),
    ...(positiveNumber(env.AGENT_TRANSACTION_MAX_RETRIEVAL_DOCUMENTS) !== undefined
      ? {
          maxRetrievalDocuments: positiveNumber(env.AGENT_TRANSACTION_MAX_RETRIEVAL_DOCUMENTS),
        }
      : {}),
  };
}

function audiencesFromEnv(env: Record<string, string | undefined>): ReadonlyMap<string, string> {
  const raw = env.AGENT_TRANSACTION_AUDIENCES;
  if (raw === undefined || raw.trim() === "") return new Map();
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("AGENT_TRANSACTION_AUDIENCES must be a JSON object");
  }
  const entries = Object.entries(parsed);
  if (
    entries.some(
      ([server, audience]) =>
        server.trim() === "" || typeof audience !== "string" || audience.trim() === "",
    )
  ) {
    throw new Error("AGENT_TRANSACTION_AUDIENCES must map server names to audiences");
  }
  return new Map(entries as Array<[string, string]>);
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/[\s,]+/u)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item !== "");
  }
  return [];
}

const DEFAULT_SCOPE_CLAIM_SOURCES = ["scope", "scp"] as const;

function scopeClaimSourcesFromEnv(env: Record<string, string | undefined>): string[] {
  const configured = stringList(env.AGENT_TRANSACTION_SCOPE_CLAIMS);
  return [...new Set(configured.length > 0 ? configured : DEFAULT_SCOPE_CLAIM_SOURCES)];
}

function scopesFromContext(ctx: AgentExecutionContext, claimSources: readonly string[]): string[] {
  const claims = ctx.claims;
  // OAuth providers may expose application permissions in custom claims rather
  // than the standard `scope` or `scp` claims. Source names are operator
  // configured, so the transaction envelope preserves granted permissions
  // without requiring server-specific scope knowledge.
  const scopes = claimSources.flatMap((claim) => stringList(claims?.[claim]));
  const role = ctx.role ?? (typeof claims?.role === "string" ? claims.role : undefined);
  if (role !== undefined && role.trim() !== "") scopes.push(`role:${role}`);
  return [...new Set(scopes)];
}

function groupsFromContext(ctx: AgentExecutionContext): string[] {
  return [
    ...new Set([
      ...(ctx.groups ?? []),
      ...stringList(ctx.claims?.groups),
      ...stringList(ctx.claims?.group),
    ]),
  ];
}

function traceFromContext(ctx: AgentExecutionContext, deadlineAt: number): TransactionTrace {
  const trace = ctx.traceContext;
  return {
    ...(trace?.traceId !== undefined ? { traceId: trace.traceId } : {}),
    ...(trace?.spanId !== undefined ? { spanId: trace.spanId } : {}),
    ...(trace !== undefined
      ? {
          traceparent: `00-${trace.traceId}-${trace.spanId}-${trace.sampled ? "01" : "00"}`,
        }
      : {}),
    deadlineAt,
  };
}

function stablePayload(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stablePayload).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stablePayload(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function payloadFingerprint(payload: unknown): string {
  return crypto.createHash("sha256").update(stablePayload(payload)).digest("hex");
}

function evidence(detail: unknown): { summary: string; kind?: string } {
  const raw = detail instanceof Error ? detail.message : typeof detail === "string" ? detail : JSON.stringify(detail);
  return { summary: (raw ?? "undefined").slice(0, 1024), kind: detail instanceof Error ? detail.name : typeof detail };
}

export class TransactionOrchestrator {
  readonly ledger: InvocationLedgerStore<unknown>;
  readonly budgetCoordinator: TransactionBudgetCoordinator;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => number;
  private readonly config: NonNullable<ReturnType<typeof transactionTokenConfigFromEnv>>;
  private readonly audiences: ReadonlyMap<string, string>;
  private readonly budget: TransactionBudget;
  private readonly scopeClaimSources: readonly string[];

  constructor(options: TransactionOrchestratorOptions = {}) {
    this.env = options.env ?? process.env;
    const config = transactionTokenConfigFromEnv(this.env);
    if (config === undefined) throw new Error("Transaction signing is not configured");
    this.config = config;
    this.now = options.now ?? (() => Date.now());
    this.ledger = options.ledger ?? createInvocationLedger({
      redisUrl: this.env.REDIS_URL,
      database: options.database,
      logger: options.logger,
      now: this.now,
    });
    this.budgetCoordinator = options.budgetCoordinator ?? new TransactionBudgetCoordinator();
    this.audiences = audiencesFromEnv(this.env);
    this.budget = budgetFromEnv(this.env);
    this.scopeClaimSources = scopeClaimSourcesFromEnv(this.env);
  }

  async begin(
    ctx: AgentExecutionContext,
    serverName: string,
    toolRef: string,
    invocationId: string = crypto.randomUUID(),
    options: TransactionBeginOptions = {},
  ): Promise<TransactionInvocation> {
    const claim = await this.ledger.claim({
      invocationId,
      payloadFingerprint: options.payloadFingerprint ?? payloadFingerprint(options.payload),
      sideEffect: options.sideEffect ?? { tool: toolRef, semantics: "non_idempotent" },
    });
    if (!claim.acquired) {
      const mismatch = claim.record.payloadFingerprint !== (options.payloadFingerprint ?? payloadFingerprint(options.payload));
      throw new Error(`Transaction invocation already claimed: ${invocationId}${mismatch ? " (payload mismatch)" : ""}`);
    }
    try {
      // This coordinator is process-local, even when the invocation ledger is Redis-backed.
      // A cluster-wide budget guarantee requires a shared atomic budget store.
      this.budgetCoordinator.reserve(ctx.executionId, this.budget, {
        invocationId,
        requested: { toolCalls: 1 },
      });
      await this.ledger.transition(invocationId, "running");
      const audience = this.audiences.get(serverName) ?? serverName;
      const maxDurationMs = this.budget.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
      const tokenTtlMs = (this.config.ttlSeconds ?? 60) * 1000;
      const deadlineAt = this.now() + Math.min(tokenTtlMs, maxDurationMs);
      const trace = traceFromContext(ctx, deadlineAt);
      const issuer = new TransactionTokenIssuer({ ...this.config, audience }, this.now);
      const preferredActionContractHash =
        options.actionContractHash === undefined
          ? undefined
          : canonicalContractHash(options.actionContractHash, "Action-contract hash");
      const compatibilityActionContractHash =
        options.evidenceContractHash === undefined
          ? undefined
          : canonicalContractHash(options.evidenceContractHash, "Evidence-contract hash");
      if (
        preferredActionContractHash !== undefined &&
        compatibilityActionContractHash !== undefined &&
        preferredActionContractHash !== compatibilityActionContractHash
      ) {
        throw new Error("Action-contract hash aliases must be identical");
      }
      const actionContractHash = preferredActionContractHash ?? compatibilityActionContractHash;
      const token = await issuer.issue({
        executionId: ctx.executionId,
        invocationId,
        ...(ctx.userId !== undefined ? { userId: ctx.userId } : {}),
        // NO_TENANT is an internal SQL/RLS sentinel for single-tenant
        // deployments, not an externally authenticated OIDC tenant claim.
        // Emitting it would make mcpgate correctly reject the transaction as
        // an unattested tenant assertion. Real tenant IDs remain fail-closed
        // and must match a claim in the forwarded bearer token.
        ...(ctx.clientId !== undefined && ctx.clientId !== NO_TENANT
          ? { tenantId: ctx.clientId }
          : {}),
        agentId: this.env.AGENT_TRANSACTION_AGENT_ID ?? "agent-runtime",
        ...(ctx.authenticatedSessionId !== undefined && options.bindSession !== false
          ? { sessionId: ctx.authenticatedSessionId }
          : {}),
        scopes: [
          ...scopesFromContext(ctx, this.scopeClaimSources),
          `tool:${toolRef.includes("/") ? toolRef.slice(toolRef.indexOf("/") + 1) : toolRef}`,
        ].filter((scope, index, all) => all.indexOf(scope) === index),
        groups: groupsFromContext(ctx),
        purpose: toolRef,
        ...(actionContractHash !== undefined
          ? {
              actionContractHash,
              evidenceContractHash: actionContractHash,
            }
          : {}),
        budget: this.budget,
        delegationChain: [],
        trace,
      });
      let completed = false;
      return {
        invocationId,
        transaction: {
          token,
          invocationId,
          trace,
          ...(actionContractHash !== undefined
            ? {
                actionContractHash,
                evidenceContractHash: actionContractHash,
              }
            : {}),
        },
        complete: async (outcome, detail) => {
          if (completed) return;
          completed = true;
          this.budgetCoordinator.commit(ctx.executionId, invocationId);
          if (outcome === "committed") {
            await this.ledger.transition(invocationId, "committed", {
              resultEvidence: evidence(detail),
            });
          } else {
            await this.ledger.transition(invocationId, outcome, {
              error: detail instanceof Error ? detail.message : String(detail ?? outcome),
              errorEvidence: evidence(detail ?? outcome),
            });
          }
        },
      };
    } catch (error) {
      this.budgetCoordinator.release(invocationId);
      await this.ledger.transition(invocationId, "failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

export function createTransactionOrchestrator(
  options: TransactionOrchestratorOptions = {},
): TransactionOrchestrator | undefined {
  if (transactionTokenConfigFromEnv(options.env ?? process.env) === undefined) {
    return undefined;
  }
  return new TransactionOrchestrator(options);
}

let singleton: TransactionOrchestrator | undefined;
let singletonSecret: string | undefined;

export function getTransactionOrchestrator(): TransactionOrchestrator | undefined {
  const secret = process.env.AGENT_TRANSACTION_SECRET;
  if (secret === undefined || secret === "") return undefined;
  if (singleton === undefined || singletonSecret !== secret) {
    singleton = createTransactionOrchestrator();
    singletonSecret = secret;
  }
  return singleton;
}

export function thrownToolOutcome(toolName: string): TransactionCompletion {
  return /^(get|list|read|search|lookup|find|query|fetch)(?:_|-|$)/iu.test(toolName)
    ? "failed"
    : "outcome_unknown";
}
