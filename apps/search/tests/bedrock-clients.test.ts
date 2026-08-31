// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEmbeddingClient } from "../src/embedding-client.js";
import { createHydeClient } from "../src/hyde-client.js";
import { createSummaryClient } from "../src/summary-client.js";
import { createRerankerClient } from "../src/reranker-client.js";
import { createSparseEmbeddingClient } from "../src/sparse-embedding-client.js";
import pino from "pino";

const logger = pino({ level: "silent" });

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  return {
    BedrockRuntimeClient: class {
      send = mockSend;
    },
    InvokeModelCommand: class {
      constructor(public input: any) {}
    },
    ConverseCommand: class {
      constructor(public input: any) {}
    },
  };
});

describe("Bedrock Integration Clients", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  describe("Embedding Client with Bedrock", () => {
    it("uses Bedrock for Amazon Titan model", async () => {
      mockSend.mockResolvedValueOnce({
        body: new TextEncoder().encode(JSON.stringify({ embedding: [0.1, 0.2] })),
      });

      const client = createEmbeddingClient({
        embedUrl: "bedrock://us-west-2",
        embedModel: "amazon.titan-embed-text-v1",
        logger,
      });

      const result = await client.embed("test query");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.vector).toEqual([0.1, 0.2]);
      }
      expect(mockSend).toHaveBeenCalled();
    });

    it("uses Bedrock for Cohere Embed model", async () => {
      mockSend.mockResolvedValueOnce({
        body: new TextEncoder().encode(
          JSON.stringify({ embeddings: [[0.5, 0.6]] }),
        ),
      });

      const client = createEmbeddingClient({
        embedUrl: "bedrock",
        embedModel: "cohere.embed-english-v3",
        logger,
      });

      const result = await client.embed("test query");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.vector).toEqual([0.5, 0.6]);
      }
      expect(mockSend).toHaveBeenCalled();
    });
  });

  describe("HyDE Client with Bedrock", () => {
    it("uses ConverseCommand to generate hypothetical documents", async () => {
      mockSend.mockResolvedValueOnce({
        output: {
          message: {
            content: [{ text: "This is a hypothetical answer." }],
          },
        },
      });

      const client = createHydeClient({
        url: "bedrock",
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        logger,
      });

      const result = await client.expand("test question");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toBe("This is a hypothetical answer.");
      }
      expect(mockSend).toHaveBeenCalled();
    });
  });

  describe("Summary Client with Bedrock", () => {
    it("uses ConverseCommand to generate summaries", async () => {
      mockSend.mockResolvedValueOnce({
        output: {
          message: {
            content: [{ text: "Summarized text." }],
          },
        },
      });

      const client = createSummaryClient({
        url: "bedrock",
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        logger,
      });

      const result = await client.summarize("Long text to summarize");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toBe("Summarized text.");
      }
      expect(mockSend).toHaveBeenCalled();
    });
  });

  describe("Reranker Client with Bedrock", () => {
    it("uses InvokeModelCommand for Cohere Rerank model", async () => {
      mockSend.mockResolvedValueOnce({
        body: new TextEncoder().encode(
          JSON.stringify({
            results: [{ index: 0, relevance_score: 2.5 }],
          }),
        ),
      });

      const client = createRerankerClient({
        rerankUrl: "bedrock",
        rerankModel: "cohere.rerank-v3-5:0",
        endpoint: "rerank",
        separator: "\n",
        documentsField: "texts",
        logger,
      });

      const result = await client.rerank("query", ["doc1"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result[0]?.index).toBe(0);
        expect(result.result[0]?.score).toBeGreaterThan(0.5); // Sigmoid(2.5) > 0.5
      }
      expect(mockSend).toHaveBeenCalled();
    });
  });

  describe("Sparse Embedding Client with Bedrock", () => {
    it("obtains dense embedding and performs dense-to-sparse conversion", async () => {
      mockSend.mockResolvedValueOnce({
        body: new TextEncoder().encode(
          JSON.stringify({ embedding: [0.0, 0.5, -0.2, 0.00001] }),
        ),
      });

      const client = createSparseEmbeddingClient({
        url: "bedrock",
        model: "amazon.titan-embed-text-v1",
        vocabSize: 4,
        threshold: 0.1,
        logger,
      });

      const result = await client.embedSparse("sparse test");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.indices).toEqual([1, 2]);
        expect(result.result.values).toEqual([0.5, -0.2]);
        expect(result.result.dim).toBe(4);
      }
      expect(mockSend).toHaveBeenCalled();
    });
  });
});
