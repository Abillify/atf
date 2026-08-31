// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for OTel GenAI semantic-convention helpers
 * (`src/observability/gen-ai-semconv.ts`).
 */

import { describe, it, expect } from "bun:test";
import {
  GEN_AI_ATTRS,
  genAiSystem,
  genAiSpanName,
  setGenAiRequestAttributes,
  setGenAiResponseAttributes,
  startLlmSpan,
} from "../gen-ai-semconv.js";
import { createTracer, type Span } from "../tracing.js";

/** Minimal Span stub that records attribute writes. */
function recordingSpan(): { span: Span; attrs: Record<string, unknown> } {
  const attrs: Record<string, unknown> = {};
  const span: Span = {
    spanContext: () => ({
      traceId: "0".repeat(32),
      spanId: "0".repeat(16),
      sampled: true,
    }),
    setAttribute(key, value) {
      attrs[key] = value;
      return this;
    },
    setAttributes(a) {
      Object.assign(attrs, a);
      return this;
    },
    setStatus() {
      return this;
    },
    recordException() {
      return this;
    },
    end() {
      /* no-op */
    },
  };
  return { span, attrs };
}

describe("genAiSystem", () => {
  it("maps internal providers to conventional system values", () => {
    expect(genAiSystem("openai")).toBe("openai");
    expect(genAiSystem("google")).toBe("gcp.gemini");
    expect(genAiSystem("azure")).toBe("azure.ai.openai");
    expect(genAiSystem("bedrock")).toBe("aws.bedrock");
    expect(genAiSystem("ollama")).toBe("ollama");
  });
  it("passes through unknown providers", () => {
    expect(genAiSystem("custom")).toBe("custom");
  });
});

describe("genAiSpanName", () => {
  it("follows the '{operation} {model}' convention", () => {
    expect(genAiSpanName("chat", "gpt-4o-mini")).toBe("chat gpt-4o-mini");
    expect(genAiSpanName("embeddings", "text-embedding-3-small")).toBe(
      "embeddings text-embedding-3-small",
    );
  });
});

describe("setGenAiRequestAttributes", () => {
  it("sets system, operation, model and optional sampling params", () => {
    const { span, attrs } = recordingSpan();
    setGenAiRequestAttributes(span, {
      provider: "openai",
      model: "gpt-4o",
      temperature: 0.7,
      maxTokens: 1024,
    });
    expect(attrs[GEN_AI_ATTRS.system]).toBe("openai");
    expect(attrs[GEN_AI_ATTRS.operationName]).toBe("chat");
    expect(attrs[GEN_AI_ATTRS.requestModel]).toBe("gpt-4o");
    expect(attrs[GEN_AI_ATTRS.requestTemperature]).toBe(0.7);
    expect(attrs[GEN_AI_ATTRS.requestMaxTokens]).toBe(1024);
  });

  it("omits sampling params when unset", () => {
    const { span, attrs } = recordingSpan();
    setGenAiRequestAttributes(span, { provider: "ollama", model: "llama3.2" });
    expect(attrs[GEN_AI_ATTRS.requestTemperature]).toBeUndefined();
    expect(attrs[GEN_AI_ATTRS.requestMaxTokens]).toBeUndefined();
  });
});

describe("setGenAiResponseAttributes", () => {
  it("sets usage, response model, finish reasons and cost", () => {
    const { span, attrs } = recordingSpan();
    setGenAiResponseAttributes(span, {
      model: "gpt-4o-2024",
      inputTokens: 120,
      outputTokens: 40,
      finishReasons: ["stop"],
      cost: 0.0012,
    });
    expect(attrs[GEN_AI_ATTRS.responseModel]).toBe("gpt-4o-2024");
    expect(attrs[GEN_AI_ATTRS.usageInputTokens]).toBe(120);
    expect(attrs[GEN_AI_ATTRS.usageOutputTokens]).toBe(40);
    expect(attrs[GEN_AI_ATTRS.responseFinishReasons]).toBe("stop");
    expect(attrs[GEN_AI_ATTRS.usageCost]).toBe(0.0012);
  });

  it("ignores empty finish-reason arrays", () => {
    const { span, attrs } = recordingSpan();
    setGenAiResponseAttributes(span, { finishReasons: [] });
    expect(attrs[GEN_AI_ATTRS.responseFinishReasons]).toBeUndefined();
  });
});

describe("startLlmSpan", () => {
  it("returns a no-op span when tracing is disabled (no throw)", () => {
    const tracer = createTracer({ tracingEnabled: false });
    const span = startLlmSpan(tracer, {
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(span).toBeDefined();
    span.end();
  });
});
