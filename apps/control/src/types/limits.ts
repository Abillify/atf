// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Types for the token-limits + usage dashboard, mirroring the backend
 * (src/observability/token-limits.ts).
 */

export type LimitPeriod = "day" | "week" | "month";
export type LimitScopeType = "global" | "user" | "flow";
export type UsageBucket = "hour" | "day" | "week";

/** A configured limit rule. */
export interface TokenLimit {
  id: string;
  scopeType: LimitScopeType;
  scopeId: string | null;
  model: string | null;
  period: LimitPeriod;
  limitTokens: number;
  createdAt: string;
  updatedAt: string;
}

/** Payload sent when creating/updating a limit. */
export interface TokenLimitInput {
  scopeType: LimitScopeType;
  scopeId?: string | null;
  model?: string | null;
  period: LimitPeriod;
  limitTokens: number;
}

export interface TokenUsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

/** A limit plus its current consumption in the period window. */
export interface LimitConsumption extends TokenLimit {
  used: TokenUsageTotals;
  usedFraction: number;
  windowStart: string;
}

/** One point of the usage time-series. */
export interface UsageSeriesPoint {
  bucket: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}
