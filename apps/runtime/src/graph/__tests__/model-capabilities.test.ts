// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect } from "bun:test";
import {
  getModelCapabilities,
  isLocalInferenceProvider,
} from "../model-capabilities.js";

describe("getModelCapabilities", () => {
  test("openai-compatible providers use response_format", () => {
    for (const provider of ["openai", "ollama", "azure"]) {
      const caps = getModelCapabilities(provider, "any-model");
      expect(caps.structuredOutput).toBe("response_format");
      expect(caps.promptCache).toBe("none");
      expect(caps.allowSystemInMessages).toBe(true);
    }
  });

  test("google uses generateObject, no prompt cache", () => {
    const caps = getModelCapabilities("google", "models/gemini-3-flash-preview");
    expect(caps.structuredOutput).toBe("generateObject");
    expect(caps.promptCache).toBe("none");
  });

  test("bedrock Claude (Haiku) uses generateObject + bedrock cache", () => {
    const caps = getModelCapabilities(
      "bedrock",
      "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
    expect(caps.structuredOutput).toBe("generateObject");
    expect(caps.promptCache).toBe("bedrock");
    expect(caps.allowSystemInMessages).toBe(true);
  });

  test("bedrock claude-sonnet-5 overrides to prompt_validate but keeps bedrock cache", () => {
    const caps = getModelCapabilities("bedrock", "eu.anthropic.claude-sonnet-5");
    // more-specific model rule wins over provider rule for structuredOutput
    expect(caps.structuredOutput).toBe("prompt_validate");
    // but the provider-level prompt cache is still inherited
    expect(caps.promptCache).toBe("bedrock");
  });

  test("bedrock sonnet-4-5 (not sonnet-5) stays on generateObject", () => {
    const caps = getModelCapabilities(
      "bedrock",
      "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
    );
    expect(caps.structuredOutput).toBe("generateObject");
  });

  test("anthropic direct uses generateObject + anthropic cache", () => {
    const caps = getModelCapabilities("anthropic", "claude-3-5-sonnet");
    expect(caps.structuredOutput).toBe("generateObject");
    expect(caps.promptCache).toBe("anthropic");
  });

  test("unknown provider falls back to the safe prompt_validate default", () => {
    const caps = getModelCapabilities("mystery", "whatever");
    expect(caps.structuredOutput).toBe("prompt_validate");
    expect(caps.promptCache).toBe("none");
    expect(caps.allowSystemInMessages).toBe(true);
    expect(caps.unsupportedParameters).toEqual([]);
  });

  test("sonnet-5 rejects temperature on bedrock and anthropic; haiku does not", () => {
    expect(
      getModelCapabilities("bedrock", "eu.anthropic.claude-sonnet-5")
        .unsupportedParameters,
    ).toEqual(["temperature"]);
    expect(
      getModelCapabilities("anthropic", "claude-sonnet-5").unsupportedParameters,
    ).toEqual(["temperature"]);
    expect(
      getModelCapabilities("bedrock", "eu.anthropic.claude-haiku-4-5-20251001-v1:0")
        .unsupportedParameters,
    ).toEqual([]);
  });

  test("local vLLM Qwen3 NVFP4 build declares vision; other local models fail closed", () => {
    // Verified against a live gpuvllm endpoint (openai protocol). A named
    // instance resolves to its protocol, so the openai model glob applies.
    expect(
      getModelCapabilities("openai", "unsloth/Qwen3.8-27B-NVFP4").visionInput,
    ).toBe(true);
    // Unmatched local text model stays closed (safe default).
    expect(getModelCapabilities("openai", "unsloth/Qwen3-8B").visionInput).toBe(
      false,
    );
    expect(getModelCapabilities("openai", "some-local-model").visionInput).toBe(
      false,
    );
  });

  test("isLocalInferenceProvider is true only for always-local providers", () => {
    expect(isLocalInferenceProvider("ollama")).toBe(true);
    // openai can be local (LM Studio) but not guaranteed by the provider alone
    expect(isLocalInferenceProvider("openai")).toBe(false);
    expect(isLocalInferenceProvider("bedrock")).toBe(false);
    expect(isLocalInferenceProvider("google")).toBe(false);
    expect(isLocalInferenceProvider(undefined)).toBe(false);
  });

  test("glob matching is case-insensitive and anchored", () => {
    expect(
      getModelCapabilities("bedrock", "EU.ANTHROPIC.CLAUDE-SONNET-5").structuredOutput,
    ).toBe("prompt_validate");
    // 'sonnet-50' contains 'sonnet-5' as a substring; the *sonnet-5* glob is a
    // contains-match by design, so it also matches — assert that explicitly so
    // the intended semantics are documented.
    expect(
      getModelCapabilities("bedrock", "claude-sonnet-50").structuredOutput,
    ).toBe("prompt_validate");
  });
});
