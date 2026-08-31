// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow-declared contract for consequential actions that require multiple tools
 * to have succeeded in a specific order before an LLM answer is accepted.
 */
export interface ToolSequenceContract {
  when: {
    pattern: string;
    flags?: string;
  };
  sequence: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves an active contract from a node configuration. Invalid declarations
 * are ignored so a malformed optional contract cannot break unrelated turns.
 */
export function resolveToolSequenceContract(
  config: Record<string, unknown> | undefined,
  query: string,
): ToolSequenceContract | undefined {
  const raw = config?.toolSequenceContract;
  if (!isRecord(raw) || !isRecord(raw.when) || !Array.isArray(raw.sequence)) {
    return undefined;
  }
  const { pattern, flags } = raw.when;
  if (
    typeof pattern !== "string" ||
    (flags !== undefined && typeof flags !== "string") ||
    raw.sequence.length === 0 ||
    !raw.sequence.every((tool): tool is string => typeof tool === "string" && tool.length > 0)
  ) {
    return undefined;
  }
  try {
    return new RegExp(pattern, flags).test(query)
      ? { when: { pattern, ...(flags === undefined ? {} : { flags }) }, sequence: raw.sequence }
      : undefined;
  } catch {
    return undefined;
  }
}
