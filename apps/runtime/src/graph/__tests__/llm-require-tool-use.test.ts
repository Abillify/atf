// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the tool-use enforcement policy (`graph/require-tool-use.ts`).
 *
 * Anchored on trace c44d1214: the personal-assistant flow answered a bare
 * "retry" with `requireToolUseWhenSelected`, semantic selection surfaced
 * `parking/reassign_booking` at 0.49 for a query that means nothing on its own,
 * the model refused to call it three times, and the execution ended in `error`
 * with nothing shown to the user.
 *
 * Two properties keep that from happening again: an intent-free turn does not
 * make tool use mandatory, and a requirement that was only *inferred* is not
 * enforced to the point of failing the turn.
 */
import { describe, test, expect } from "bun:test";
import {
  decideRequireToolUse,
  isNoIntentFollowUp,
  normalizeUserPhrase,
  DEFAULT_REQUIRE_TOOL_USE_MIN_SCORE,
} from "../require-tool-use.js";
import { allowsInferredToolUseFallback } from "../../llm-stream-fallback-policy.js";

describe("isNoIntentFollowUp", () => {
  test("flags the retry family, in German and English", () => {
    for (const query of [
      "retry",
      "Retry",
      "retry!",
      "test",
      "nochmal",
      "noch einmal",
      "versuchs nochmal",
      "versuch es noch einmal",
      "versuchs wieder",
      "probier es erneut",
      "try again",
      "erneut",
    ]) {
      expect(isNoIntentFollowUp(query)).toBe(true);
    }
  });

  test("flags greetings and acknowledgements", () => {
    for (const query of ["hi", "hallo", "huhu", "Moin!", "danke", "ok", "alles klar"]) {
      expect(isNoIntentFollowUp(query)).toBe(true);
    }
  });

  test("does not flag a real request, however short", () => {
    for (const query of [
      "auf welchem parkplatz steh ich heute",
      "wo steh ich?",
      "buche P_10",
      "test the parking export",
      "nochmal alle Buchungen von morgen bitte",
      "meine Arbeitszeit",
    ]) {
      expect(isNoIntentFollowUp(query)).toBe(false);
    }
  });

  test("treats an empty turn as intent-free", () => {
    expect(isNoIntentFollowUp("")).toBe(true);
    expect(isNoIntentFollowUp("   \n ")).toBe(true);
  });

  test("normalisation folds case, punctuation and repeated whitespace", () => {
    expect(normalizeUserPhrase("  Versuchs   NOCHMAL!! ")).toBe(
      "versuchs nochmal",
    );
  });
});

describe("decideRequireToolUse", () => {
  const selection = {
    selectedBoundToolCount: 6,
    selectedBoundToolBestScore: 0.49183032609852684,
  };

  test("an authored contract is mandatory regardless of selection", () => {
    const decision = decideRequireToolUse({
      config: { requireToolUse: true },
      selectedBoundToolCount: 0,
      selectedBoundToolBestScore: Number.NEGATIVE_INFINITY,
      query: "retry",
    });
    expect(decision).toEqual({
      required: true,
      mandatory: true,
      reason: "config_contract",
    });
  });

  test("off by default", () => {
    expect(
      decideRequireToolUse({ config: undefined, ...selection, query: "wo steh ich?" })
        .required,
    ).toBe(false);
  });

  test("trace c44d1214: a bare retry does not force a tool call", () => {
    const decision = decideRequireToolUse({
      config: {
        requireToolUseWhenSelected: true,
        requireToolUseWhenSelectedMinScore: 0.35,
      },
      ...selection,
      query: "retry",
    });
    expect(decision.required).toBe(false);
    expect(decision.reason).toBe("no_intent_query");
  });

  test("a server-validated safe retry requires its read-only tool", () => {
    expect(
      decideRequireToolUse({
        config: undefined,
        selectedBoundToolCount: 1,
        selectedBoundToolBestScore: 1,
        query: "ry again",
        safeRetryToolOverride: true,
      }),
    ).toEqual({
      required: true,
      mandatory: true,
      reason: "safe_retry_override",
    });
  });

  test("a concrete request above the threshold does force a tool call", () => {
    const decision = decideRequireToolUse({
      config: {
        requireToolUseWhenSelected: true,
        requireToolUseWhenSelectedMinScore: 0.35,
      },
      ...selection,
      query: "auf welchem parkplatz steh ich heute",
    });
    expect(decision).toEqual({
      required: true,
      mandatory: false,
      reason: "semantic_selection",
    });
  });

  test("an inferred requirement is never mandatory", () => {
    const decision = decideRequireToolUse({
      config: { requireToolUseWhenSelected: true, requireToolUseWhenSelectedMinScore: 0.1 },
      ...selection,
      query: "buche mir P_10 fuer morgen",
    });
    expect(decision.required).toBe(true);
    expect(decision.mandatory).toBe(false);
  });

  test("a weak selection stays optional", () => {
    const decision = decideRequireToolUse({
      config: {
        requireToolUseWhenSelected: true,
        requireToolUseWhenSelectedMinScore: 0.6,
      },
      ...selection,
      query: "auf welchem parkplatz steh ich heute",
    });
    expect(decision.required).toBe(false);
    expect(decision.reason).toBe("score_below_threshold");
  });

  test("a hit that was not bound to a callable tool cannot force anything", () => {
    const decision = decideRequireToolUse({
      config: { requireToolUseWhenSelected: true },
      selectedBoundToolCount: 0,
      selectedBoundToolBestScore: Number.NEGATIVE_INFINITY,
      query: "auf welchem parkplatz steh ich heute",
    });
    expect(decision.required).toBe(false);
    expect(decision.reason).toBe("no_bound_tool");
  });

  test("falls back to the default threshold when the flow configures none", () => {
    const below = decideRequireToolUse({
      config: { requireToolUseWhenSelected: true },
      selectedBoundToolCount: 1,
      selectedBoundToolBestScore: DEFAULT_REQUIRE_TOOL_USE_MIN_SCORE - 0.01,
      query: "wie waren meine zeiten letzte woche",
    });
    expect(below.required).toBe(false);
    const atThreshold = decideRequireToolUse({
      config: { requireToolUseWhenSelected: true },
      selectedBoundToolCount: 1,
      selectedBoundToolBestScore: DEFAULT_REQUIRE_TOOL_USE_MIN_SCORE,
      query: "wie waren meine zeiten letzte woche",
    });
    expect(atThreshold.required).toBe(true);
  });

  test("explicit requires a node opt-in before inferred tool text is released", () => {
    const decision = decideRequireToolUse({
      config: {
        requireToolUseWhenSelected: true,
        requireToolUseWhenSelectedMinScore: 0.1,
      },
      ...selection,
      query: "buche mir P_10 fuer morgen",
    });
    expect(decision).toMatchObject({ required: true, mandatory: false });
    expect(allowsInferredToolUseFallback("explicit", undefined)).toBe(false);
    expect(
      allowsInferredToolUseFallback("explicit", {
        allowToolUseFallback: true,
      }),
    ).toBe(true);
    expect(
      allowsInferredToolUseFallback("disabled", {
        allowToolUseFallback: true,
      }),
    ).toBe(false);
  });

  test("a non-finite configured threshold does not disable the gate", () => {
    const decision = decideRequireToolUse({
      config: {
        requireToolUseWhenSelected: true,
        requireToolUseWhenSelectedMinScore: Number.NaN,
      },
      selectedBoundToolCount: 1,
      selectedBoundToolBestScore: 0.42,
      query: "wie waren meine zeiten letzte woche",
    });
    // 0.42 < default 0.5 — the NaN is ignored rather than making everything pass.
    expect(decision.required).toBe(false);
    expect(decision.reason).toBe("score_below_threshold");
  });
});
