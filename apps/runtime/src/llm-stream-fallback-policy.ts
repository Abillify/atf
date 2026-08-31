// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/** Global policy for semantic LLM response fallbacks. */
export type LlmStreamFallbackPolicy =
  | "legacy"
  | "report"
  | "explicit"
  | "disabled";

export interface LlmStreamFallbackNodeConfig {
  reasoningSalvage?: boolean;
  emptyResponseFallback?: boolean;
  allowToolUseFallback?: boolean;
}

export const DEFAULT_LLM_STREAM_FALLBACK_POLICY: LlmStreamFallbackPolicy =
  "legacy";

export function resolveLlmStreamFallbackPolicy(
  policy: LlmStreamFallbackPolicy | undefined,
): LlmStreamFallbackPolicy {
  return policy ?? DEFAULT_LLM_STREAM_FALLBACK_POLICY;
}

export function allowsReasoningSalvage(
  policy: LlmStreamFallbackPolicy,
  config: Pick<LlmStreamFallbackNodeConfig, "reasoningSalvage"> | undefined,
): boolean {
  if (policy === "disabled") return false;
  if (policy === "explicit") return config?.reasoningSalvage === true;
  return config?.reasoningSalvage !== false;
}

export function allowsEmptyResponseFallback(
  policy: LlmStreamFallbackPolicy,
  config: Pick<LlmStreamFallbackNodeConfig, "emptyResponseFallback"> | undefined,
): boolean {
  return policy !== "disabled" && config?.emptyResponseFallback === true;
}

export function allowsTerminalEmptyResponseFallback(
  policy: LlmStreamFallbackPolicy,
  config: Pick<LlmStreamFallbackNodeConfig, "emptyResponseFallback"> | undefined,
  policySuppressedToolFallback: boolean,
): boolean {
  return (
    !policySuppressedToolFallback &&
    allowsEmptyResponseFallback(policy, config)
  );
}

export function allowsInferredToolUseFallback(
  policy: LlmStreamFallbackPolicy,
  config: Pick<LlmStreamFallbackNodeConfig, "allowToolUseFallback"> | undefined,
): boolean {
  if (policy === "disabled") return false;
  if (policy === "explicit") return config?.allowToolUseFallback === true;
  return true;
}

export function allowsNonStreamingExceptionMaterialization(
  policy: LlmStreamFallbackPolicy,
): boolean {
  return policy === "legacy" || policy === "report";
}

export function reportsStreamFallbacks(
  policy: LlmStreamFallbackPolicy,
): boolean {
  return policy === "report";
}
