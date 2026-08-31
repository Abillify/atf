// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  allowsEmptyResponseFallback,
  allowsTerminalEmptyResponseFallback,
  allowsInferredToolUseFallback,
  allowsNonStreamingExceptionMaterialization,
  allowsReasoningSalvage,
  reportsStreamFallbacks,
  resolveLlmStreamFallbackPolicy,
  type LlmStreamFallbackPolicy,
} from "../llm-stream-fallback-policy.js";

const policies: LlmStreamFallbackPolicy[] = [
  "legacy",
  "report",
  "explicit",
  "disabled",
];

describe("LLM stream fallback policy matrix", () => {
  test("defaults to legacy", () => {
    expect(resolveLlmStreamFallbackPolicy(undefined)).toBe("legacy");
  });

  test.each([
    ["legacy", true, true, true, true],
    ["report", true, true, true, true],
    ["explicit", false, true, false, true],
    ["disabled", false, false, false, false],
  ] as const)(
    "%s applies the expected implicit/explicit semantic fallbacks",
    (policy, implicitReasoning, explicitReasoning, implicitTool, explicitTool) => {
      expect(allowsReasoningSalvage(policy, undefined)).toBe(implicitReasoning);
      expect(allowsReasoningSalvage(policy, { reasoningSalvage: true })).toBe(
        explicitReasoning,
      );
      expect(
        allowsInferredToolUseFallback(policy, undefined),
      ).toBe(implicitTool);
      expect(
        allowsInferredToolUseFallback(policy, { allowToolUseFallback: true }),
      ).toBe(explicitTool);
    },
  );

  test.each(policies)("%s keeps empty fallback node-explicit", (policy) => {
    expect(allowsEmptyResponseFallback(policy, undefined)).toBe(false);
    expect(
      allowsEmptyResponseFallback(policy, { emptyResponseFallback: true }),
    ).toBe(policy !== "disabled");
  });

  test("a suppressed tool fallback cannot be rematerialized as terminal empty output", () => {
    expect(
      allowsTerminalEmptyResponseFallback(
        "explicit",
        { emptyResponseFallback: true },
        true,
      ),
    ).toBe(false);
    expect(
      allowsTerminalEmptyResponseFallback(
        "explicit",
        { emptyResponseFallback: true },
        false,
      ),
    ).toBe(true);
  });

  test("only legacy/report materialize non-streaming exceptions", () => {
    expect(policies.map(allowsNonStreamingExceptionMaterialization)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(policies.map(reportsStreamFallbacks)).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });
});
