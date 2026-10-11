// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type {
  TransactionBudget,
  TransactionEnvelopeV1,
  TransactionTrace,
} from "@atf/transaction-contract";
import { TRANSACTION_ENVELOPE_PROTOCOL_VERSION } from "@atf/transaction-contract";

/**
 * The transaction envelope, budget, delegation hop and trace types come from
 * `@atf/transaction-contract` (Req 11.3) — the Runtime no longer defines its
 * own wire shapes. The runtime-facing names are kept as aliases so existing
 * imports stay stable while the contract package is the single source.
 */
export const TRANSACTION_PROTOCOL_VERSION =
  TRANSACTION_ENVELOPE_PROTOCOL_VERSION;
export type EnforcementMode = "off" | "optional" | "required";

export type { TransactionBudget, TransactionTrace };
export type DelegationHop = TransactionEnvelopeV1["delegationChain"][number];
export type TransactionEnvelope = TransactionEnvelopeV1;
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
