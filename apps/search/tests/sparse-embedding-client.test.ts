// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// vectorsearch/tests/sparse-embedding-client.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { createSparseEmbeddingClient } from "../src/sparse-embedding-client.js";
import pino from "pino";

const logger = pino({ level: "silent" });

describe("createSparseEmbeddingClient — Authorization header (apiKey)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function okFetch(): ReturnType<typeof vi.fn> {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [0.5, 0, 0, 0.8] }] }),
      text: async () => "",
    });
  }

  it("sends Authorization: Bearer when apiKey is set", async () => {
    const mockFetch = okFetch();
    vi.stubGlobal("fetch", mockFetch);

    const client = createSparseEmbeddingClient({
      url: "http://gateway:4000/v1/embeddings",
      model: "splade",
      vocabSize: 4,
      apiKey: "sk-sparse-token",
      logger,
    });

    const result = await client.embedSparse("hello");
    expect(result.ok).toBe(true);

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-sparse-token");
  });

  it("omits Authorization when apiKey is not set", async () => {
    const mockFetch = okFetch();
    vi.stubGlobal("fetch", mockFetch);

    const client = createSparseEmbeddingClient({
      url: "http://tei:8080/v1/embeddings",
      model: "splade",
      vocabSize: 4,
      logger,
    });

    const result = await client.embedSparse("hello");
    expect(result.ok).toBe(true);

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });
});
