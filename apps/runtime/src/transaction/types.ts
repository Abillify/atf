// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

export const TRANSACTION_PROTOCOL_VERSION = "v1" as const;
export type EnforcementMode = "off" | "optional" | "required";

export interface TransactionBudget {
  maxCostUsd?: number;
  maxTokens?: number;
  maxDurationMs?: number;
  maxRetrievalDocuments?: number;
  maxToolCalls?: number;
}
export interface DelegationHop { issuer: string; subject: string; scopes: string[]; delegatedAt: number }
export interface TransactionTrace { traceId?: string; spanId?: string; traceparent?: string; deadlineAt?: number }
export interface TransactionEnvelope {
  version: typeof TRANSACTION_PROTOCOL_VERSION;
  iss: string; aud: string | string[]; iat: number; exp: number; jti: string;
  executionId: string; invocationId: string;
  userId?: string; tenantId?: string; agentId?: string; sessionId?: string;
  scopes: string[]; groups: string[]; purpose?: string; policyVersion?: string;
  decisionId?: string; dataClassification?: string;
  /** Preferred canonical action-contract hash. */
  actionContractHash?: string;
  /** Compatibility alias; always identical to actionContractHash. */
  evidenceContractHash?: string;
  budget: TransactionBudget;
  delegationChain: DelegationHop[]; trace: TransactionTrace;
}
export type TransactionErrorCategory = "authentication" | "authorization" | "budget" | "deadline" | "conflict" | "dependency" | "internal";
export type TransactionOutcome = "denied" | "failed" | "outcome_unknown";
export interface TransactionError { code: string; category: TransactionErrorCategory; retryable: boolean; outcome: TransactionOutcome; message?: string; invocationId?: string; traceId?: string }
export interface CapabilityDocument {
  protocol: typeof TRANSACTION_PROTOCOL_VERSION;
  issuer: string;
  audiences: string[];
  enforcement: EnforcementMode;
  signingAlgorithms: readonly ["HS256"];
  features: { idempotency: boolean; budgets: boolean; compensation: boolean; evidenceLineage: boolean };
  maxTokenTtlSeconds: number;
}
export interface TransactionMeta {
  token?: string;
  invocationId?: string;
  trace?: TransactionTrace;
  actionContractHash?: string;
  /** Compatibility alias; always identical to actionContractHash. */
  evidenceContractHash?: string;
}
