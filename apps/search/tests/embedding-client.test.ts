// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// vectorsearch/tests/embedding-client.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { createEmbeddingClient } from "../src/embedding-client.js";
import { createCircuitBreaker } from "../src/retry.js";
import pino from "pino";

const logger = pino({ level: "silent" });

describe("createEmbeddingClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns vector on successful embedding", async () => {
    // Validates: Requirements 7.1, 7.3
    const mockVector = [0.1, 0.2, 0.3];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: mockVector }] }),
        text: async () => "",
      }),
    );

    const client = createEmbeddingClient({
      llmUrl: "http://llm:8080",
      llmModel: "text-embedding-3-small",
      logger,
    });

    const result = await client.embed("hello world");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.vector).toEqual(mockVector);
    }
  });

  it("sends request to /v1/embeddings with correct body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = createEmbeddingClient({
      embedUrl: "http://llm:8080/v1/embeddings",
      embedModel: "text-embedding-3-small",
      inputField: "input",
      logger,
    });

    await client.embed("test input");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://llm:8080/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: "test input",
        }),
      }),
    );
  });

  it("treats caller cancellation as terminal and circuit-breaker neutral", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const breaker = createCircuitBreaker({ name: "embedding", failureThreshold: 1 });
    const client = createEmbeddingClient({
      embedUrl: "http://llm:8080/v1/embeddings",
      embedModel: "text-embedding-3-small",
      logger,
      circuitBreaker: breaker,
    });
    const controller = new AbortController();
    controller.abort();

    const result = await client.embed("cancelled", controller.signal);

    expect(result).toMatchObject({ ok: false, error: { code: "LLM_TIMEOUT" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(breaker.failures).toBe(0);
    expect(breaker.state).toBe("CLOSED");
  });

  it("returns LLM_UNREACHABLE when fetch throws", async () => {
    // Validates: Requirements 7.4
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );

    const client = createEmbeddingClient({
      llmUrl: "http://llm:8080",
      llmModel: "text-embedding-3-small",
      logger,
    });

    const result = await client.embed("hello world");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("LLM_UNREACHABLE");
    }
  });

  it("returns LLM_HTTP_ERROR when LLM returns HTTP 500", async () => {
    // Validates: Requirements 7.4
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "Internal Server Error",
      }),
    );

    const client = createEmbeddingClient({
      llmUrl: "http://llm:8080",
      llmModel: "text-embedding-3-small",
      logger,
    });

    const result = await client.embed("hello world");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("LLM_HTTP_ERROR");
    }
  });

  it("returns LLM_HTTP_ERROR when LLM returns HTTP 404", async () => {
    // Validates: Requirements 7.4
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => "Not Found",
      }),
    );

    const client = createEmbeddingClient({
      llmUrl: "http://llm:8080",
      llmModel: "text-embedding-3-small",
      logger,
    });

    const result = await client.embed("hello world");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("LLM_HTTP_ERROR");
    }
  });

  it("returns LLM_INVALID_RESPONSE when response is missing data field", async () => {
    // Validates: Requirements 7.3, 13.2
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ someOtherField: [0.1, 0.2] }),
        text: async () => "",
      }),
    );

    const client = createEmbeddingClient({
      llmUrl: "http://llm:8080",
      llmModel: "text-embedding-3-small",
      logger,
    });

    const result = await client.embed("hello world");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("LLM_INVALID_RESPONSE");
    }
  });

  it("returns LLM_INVALID_RESPONSE when embedding field is not an array", async () => {
    // Validates: Requirements 7.3, 13.2
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: "not-an-array" }] }),
        text: async () => "",
      }),
    );

    const client = createEmbeddingClient({
      llmUrl: "http://llm:8080",
      llmModel: "text-embedding-3-small",
      logger,
    });

    const result = await client.embed("hello world");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("LLM_INVALID_RESPONSE");
    }
  });

  it("returns LLM_INVALID_RESPONSE when data array is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
        text: async () => "",
      }),
    );

    const client = createEmbeddingClient({
      llmUrl: "http://llm:8080",
      llmModel: "text-embedding-3-small",
      logger,
    });

    const result = await client.embed("hello world");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("LLM_INVALID_RESPONSE");
    }
  });
});
