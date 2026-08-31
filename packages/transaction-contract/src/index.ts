// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { z } from "zod";

export const TRANSACTION_CONTRACT_VERSION = "1.0.0" as const;
export const TransactionV1Schema = z.object({
  version: z.literal(TRANSACTION_CONTRACT_VERSION),
  id: z.string().uuid(),
  principalId: z.string().min(1),
  action: z.string().min(1),
  occurredAt: z.string().datetime(),
  correlationId: z.string().min(1),
  attributes: z.record(z.string(), z.unknown()).default({}),
});
export type TransactionV1 = z.infer<typeof TransactionV1Schema>;

export const TRANSACTION_ENVELOPE_PROTOCOL_VERSION = "v1" as const;
export const TransactionBudgetSchema = z.object({
  maxCostUsd: z.number().finite().optional(),
  maxTokens: z.number().int().optional(),
  maxDurationMs: z.number().finite().optional(),
  maxRetrievalDocuments: z.number().int().optional(),
  maxToolCalls: z.number().int().optional(),
});
export const DelegationHopSchema = z.object({
  issuer: z.string(),
  subject: z.string(),
  scopes: z.array(z.string()),
  delegatedAt: z.number(),
});
const TransactionEnvelopeBaseSchema = z.object({
  version: z.literal(TRANSACTION_ENVELOPE_PROTOCOL_VERSION),
  iss: z.string().min(1),
  aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(1),
  executionId: z.string().min(1),
  invocationId: z.string().min(1),
  userId: z.string().optional(),
  tenantId: z.string().optional(),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  scopes: z.array(z.string()),
  groups: z.array(z.string()),
  purpose: z.string().optional(),
  policyVersion: z.string().optional(),
  decisionId: z.string().optional(),
  dataClassification: z.string().optional(),
  actionContractHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  evidenceContractHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  budget: TransactionBudgetSchema,
  delegationChain: z.array(DelegationHopSchema),
});
export const TransactionTraceSchema = z.object({
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  traceparent: z.string().optional(),
  deadlineAt: z.number().optional(),
});
export const TransactionConsumerTraceSchema = TransactionTraceSchema.extend({
  deadlineAt: z.union([z.number(), z.string()]).optional(),
});
export const TransactionEnvelopeV1Schema = TransactionEnvelopeBaseSchema.extend({
  trace: TransactionTraceSchema,
});
export const TransactionEnvelopeConsumerV1Schema = TransactionEnvelopeBaseSchema.extend({
  delegationChain: z.array(z.unknown()),
  trace: TransactionConsumerTraceSchema,
});
export type TransactionBudget = z.infer<typeof TransactionBudgetSchema>;
export type TransactionTrace = z.infer<typeof TransactionTraceSchema>;
export type TransactionEnvelopeV1 = z.infer<typeof TransactionEnvelopeV1Schema>;
export type TransactionEnvelopeConsumerV1 = z.infer<typeof TransactionEnvelopeConsumerV1Schema>;
