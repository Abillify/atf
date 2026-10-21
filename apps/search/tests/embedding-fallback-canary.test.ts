// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// vectorsearch/tests/embedding-fallback-canary.test.ts
import { describe, it, expect, vi } from "vitest";
import type pino from "pino";
import {
  createFallbackEmbeddingClient,
  runEmbeddingFallbackCanary,
  EMBEDDING_CANARY_TEXT,
  type EmbeddingClient,
  type EmbeddingResponse,
  type EmbeddingBatchResponse,
} from "../src/embedding-client.js";
import { HttpMetrics } from "../src/http-metrics.js";

function fixedClient(vector: number[]): EmbeddingClient {
  return {
    async embed(): Promise<EmbeddingResponse> {
      return { ok: true, result: { vector } };
    },
    async embedBatch(texts: string[]): Promise<EmbeddingBatchResponse> {
      return { ok: true, result: { vectors: texts.map(() => vector) } };
    },
  };
}

function failingClient(message: string): EmbeddingClient {
  return {
    async embed(): Promise<EmbeddingResponse> {
      return { ok: false, error: { code: "LLM_UNREACHABLE", message } };
    },
    async embedBatch(): Promise<EmbeddingBatchResponse> {
      return { ok: false, error: { code: "LLM_UNREACHABLE", message } };
    },
  };
}

function spyLogger(): { logger: pino.Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { logger: { warn } as unknown as pino.Logger, warn };
}

describe("runEmbeddingFallbackCanary", () => {
  it("passes silently when both endpoints produce the same space", async () => {
    const { logger, warn } = spyLogger();
    const primary = fixedClient([1, 2, 3]);
    const fallback = fixedClient([1, 2, 3]);

    await expect(
      runEmbeddingFallbackCanary(primary, fallback, logger, {
        abortOnMismatch: false,
      }),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("embeds the canary text with both endpoints", async () => {
    const primaryEmbed = vi.fn(async (): Promise<EmbeddingResponse> => ({
      ok: true,
      result: { vector: [1, 0] },
    }));
    const fallbackEmbed = vi.fn(async (): Promise<EmbeddingResponse> => ({
      ok: true,
      result: { vector: [1, 0] },
    }));
    const primary: EmbeddingClient = {
      embed: primaryEmbed,
      embedBatch: async () => ({ ok: true, result: { vectors: [] } }),
    };
    const fallback: EmbeddingClient = {
      embed: fallbackEmbed,
      embedBatch: async () => ({ ok: true, result: { vectors: [] } }),
    };
    const { logger } = spyLogger();

    await runEmbeddingFallbackCanary(primary, fallback, logger, {
      abortOnMismatch: false,
    });

    expect(primaryEmbed).toHaveBeenCalledWith(EMBEDDING_CANARY_TEXT);
    expect(fallbackEmbed).toHaveBeenCalledWith(EMBEDDING_CANARY_TEXT);
  });

  it("warns with the cosine in the message when the spaces differ", async () => {
    const { logger, warn } = spyLogger();
    const primary = fixedClient([1, 0]);
    const fallback = fixedClient([1, 1]);

    await runEmbeddingFallbackCanary(primary, fallback, logger, {
      abortOnMismatch: false,
    });

    expect(warn).toHaveBeenCalledWith(
      "Embedding fallback produces vectors in a different space (cosine 0.7071); results after a failover are not comparable.",
    );
  });

  it("aborts startup when the spaces differ and abortOnMismatch is set", async () => {
    const { logger, warn } = spyLogger();
    const primary = fixedClient([1, 0]);
    const fallback = fixedClient([0, 1]);

    await expect(
      runEmbeddingFallbackCanary(primary, fallback, logger, {
        abortOnMismatch: true,
      }),
    ).rejects.toThrow(
      "Embedding fallback produces vectors in a different space (cosine 0.0000); results after a failover are not comparable.",
    );
    expect(warn).toHaveBeenCalled();
  });

  it("treats differing dimensions as a mismatch", async () => {
    const { logger, warn } = spyLogger();
    const primary = fixedClient([1, 2, 3]);
    const fallback = fixedClient([1, 2]);

    await runEmbeddingFallbackCanary(primary, fallback, logger, {
      abortOnMismatch: false,
    });

    expect(warn).toHaveBeenCalledWith(
      "Embedding fallback produces vectors in a different space (cosine 0.0000); results after a failover are not comparable.",
    );
  });

  it("only warns when an endpoint is unreachable", async () => {
    const { logger, warn } = spyLogger();
    const primary = fixedClient([1, 0]);
    const fallback = failingClient("connection refused");

    await expect(
      runEmbeddingFallbackCanary(primary, fallback, logger, {
        abortOnMismatch: true,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toContain(
      "Embedding fallback canary could not run",
    );
  });
});

describe("embedding per-source metric", () => {
  it("counts primary and fallback attempts through the fallback client", async () => {
    const metrics = new HttpMetrics();
    const { logger } = spyLogger();
    const primary = failingClient("primary down");
    const fallback = fixedClient([1, 2, 3]);

    const client = createFallbackEmbeddingClient(
      primary,
      fallback,
      logger as pino.Logger,
      undefined,
      (source) => metrics.recordEmbeddingRequest(source),
    );

    const result = await client.embed("hello");
    expect(result.ok).toBe(true);

    const rendered = metrics.render();
    expect(rendered).toContain('search_embedding_requests_total{source="primary"} 1');
    expect(rendered).toContain('search_embedding_requests_total{source="fallback"} 1');
  });

  it("counts only primary when the primary succeeds", async () => {
    const metrics = new HttpMetrics();
    const client = createFallbackEmbeddingClient(
      fixedClient([1, 2, 3]),
      fixedClient([4, 5, 6]),
      spyLogger().logger,
      undefined,
      (source) => metrics.recordEmbeddingRequest(source),
    );

    await client.embed("hello");
    await client.embedBatch(["a", "b"]);

    const rendered = metrics.render();
    expect(rendered).toContain('search_embedding_requests_total{source="primary"} 2');
    expect(rendered).toContain('search_embedding_requests_total{source="fallback"} 0');
  });

  it("renders both series with zero before any request", () => {
    const rendered = new HttpMetrics().render();
    expect(rendered).toContain("# TYPE search_embedding_requests_total counter");
    expect(rendered).toContain('search_embedding_requests_total{source="primary"} 0');
    expect(rendered).toContain('search_embedding_requests_total{source="fallback"} 0');
  });
});
