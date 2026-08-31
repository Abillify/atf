// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Cache builder (`src/bootstrap/cache.ts`)
 *
 * Builds all caching layers:
 *   - Shared embedding model (used by semantic cache, RAG, memory, groundedness)
 *   - Semantic (vector similarity) cache — pgvector-backed or in-memory
 *   - Exact-match response cache — Redis-backed or in-memory
 *   - Vector store for RAG
 *   - Vector store for long-term memory
 *   - Memory store + optional LLM-based memory extractor
 *   - RAG reranker (Bedrock)
 *
 * Centralising embedding-model creation here avoids the "which of the three
 * Embedder instances is the real one?" ambiguity that existed in index.ts.
 */

import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { Database } from "../db/database.js";
import type { StoreFactory } from "../db/store/index.js";
import {
  createSemanticCache,
  createVectorStoreSemanticCache,
  AiSdkEmbedder,
  FallbackEmbedder,
  type Embedder,
  type SemanticCache,
} from "../graph/semantic-cache.js";
import { maybeCacheEmbedder } from "../graph/embedding-cache.js";
import {
  createResponseCache,
  type ResponseCache,
  type CachedResponse,
} from "../graph/response-cache.js";
import { createVectorStore, type VectorStore } from "../graph/vector-store.js";
import { createMemoryStore, type MemoryStore } from "../graph/memory-store.js";
import {
  createMemoryExtractor,
  type MemoryExtract,
} from "../graph/memory-extractor.js";
import { createReranker, type Reranker } from "../graph/reranker.js";
import {
  createEmbeddingProvider,
  createLlmProvider,
} from "../graph/llm-factory.js";

export interface CacheResult {
  embedder: Embedder | undefined;
  semanticCache: SemanticCache | undefined;
  responseCache: ResponseCache | undefined;
  vectorStore: VectorStore | undefined;
  memoryStore: MemoryStore | undefined;
  memoryExtractor: MemoryExtract | undefined;
  reranker: Reranker | undefined;
}

export async function buildCache(
  config: AppConfig,
  logger: Logger,
  database: Database | undefined,
  storeFactory?: StoreFactory,
): Promise<CacheResult> {
  // ── Shared embedder ────────────────────────────────────────────────────────
  let embedder: Embedder | undefined;
  if (
    (config.semanticCacheEnabled === true ||
      config.ragEnabled === true ||
      config.memoryEnabled === true ||
      (config.groundednessEnabled === true &&
        config.groundednessType === "semantic" &&
        config.groundednessEmbeddingModel === undefined)) &&
    config.embeddingModel !== undefined
  ) {
    try {
      const cacheOptions = {
        enabled: config.embeddingCacheEnabled ?? false,
        maxEntries: config.embeddingCacheMaxEntries ?? 2000,
        ttlSeconds: config.embeddingCacheTtlSeconds ?? 3600,
        logger,
      };
      const primaryConfig = config.embeddingModel;
      const rawPrimary = new AiSdkEmbedder(
        createEmbeddingProvider(primaryConfig, config),
      );
      const primary =
        maybeCacheEmbedder(rawPrimary, cacheOptions) ?? rawPrimary;

      if (config.embeddingFallbackModel !== undefined) {
        const fallbackConfig = config.embeddingFallbackModel;
        const rawFallback = new AiSdkEmbedder(
          createEmbeddingProvider(fallbackConfig, config),
        );
        const fallback =
          maybeCacheEmbedder(rawFallback, cacheOptions) ?? rawFallback;
        embedder = new FallbackEmbedder(
          primary,
          fallback,
          logger,
          config.embeddingExpectedDimension,
        );
        logger.info("Embedding fallback enabled", {
          primaryProvider: primaryConfig.provider,
          primaryModel: primaryConfig.model,
          fallbackProvider: fallbackConfig.provider,
          fallbackModel: fallbackConfig.model,
          expectedDimension: config.embeddingExpectedDimension,
        });
      } else {
        embedder = primary;
      }
    } catch (err) {
      logger.warn("Failed to create embedding model", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Semantic cache ─────────────────────────────────────────────────────────
  const semanticCacheOpts = {
    enabled: config.semanticCacheEnabled ?? false,
    threshold: config.semanticCacheThreshold ?? 0.92,
    maxEntries: config.semanticCacheMaxEntries ?? 500,
    ttlSeconds: config.semanticCacheTtlSeconds ?? 300,
  };
  let semanticCache: SemanticCache | undefined;
  if (
    config.semanticCacheEnabled === true &&
    embedder !== undefined &&
    database !== undefined
  ) {
    const cacheVectorStore = createVectorStore(
      { enabled: true, tableName: "semantic_cache" },
      database,
      logger,
    );
    semanticCache = createVectorStoreSemanticCache(
      semanticCacheOpts,
      embedder,
      cacheVectorStore,
      logger,
    );
  } else {
    semanticCache = createSemanticCache(semanticCacheOpts, embedder, logger);
  }

  // ── Exact-match response cache ─────────────────────────────────────────────
  const responseCache = createResponseCache(
    {
      enabled: config.responseCacheEnabled ?? false,
      ttlSeconds: config.responseCacheTtlSeconds ?? 300,
      maxEntries: config.responseCacheMaxEntries ?? 1000,
      ...(storeFactory !== undefined
        ? {
            genericStore: storeFactory.keyValue<string, CachedResponse>(
              "response-cache",
            ),
          }
        : config.redisUrl !== undefined
          ? { redisUrl: config.redisUrl }
          : {}),
    },
    logger,
  );

  // ── RAG vector store ───────────────────────────────────────────────────────
  let vectorStore: VectorStore | undefined;
  if (config.ragEnabled === true && embedder !== undefined) {
    vectorStore = createVectorStore(
      { enabled: true, maxDocuments: config.ragMaxDocuments ?? 10_000 },
      database,
      logger,
    );
  } else if (config.ragEnabled === true && embedder === undefined) {
    logger.warn(
      "RAG_ENABLED is set but no EMBEDDING_MODEL is configured; RAG disabled.",
    );
  }

  // ── Memory vector store + memory store ────────────────────────────────────
  let memoryVectorStore: VectorStore | undefined;
  if (config.memoryEnabled === true && embedder !== undefined) {
    memoryVectorStore = createVectorStore(
      {
        enabled: true,
        tableName: "agent_memories",
        maxDocuments: config.ragMaxDocuments ?? 10_000,
      },
      database,
      logger,
    );
  }
  const memoryStore: MemoryStore | undefined = createMemoryStore(
    { enabled: config.memoryEnabled ?? false },
    memoryVectorStore,
    embedder,
    logger,
  );
  if (config.memoryEnabled === true && memoryStore === undefined) {
    logger.warn(
      "MEMORY_ENABLED is set but no EMBEDDING_MODEL is configured; long-term memory disabled.",
    );
  }

  // ── Memory extractor (LLM-based fact distillation) ─────────────────────────
  let memoryExtractor: MemoryExtract | undefined;
  if (memoryStore !== undefined && config.memoryAutoCapture === true) {
    const extractionModelConfig =
      config.memoryExtractionModel ?? config.defaultLlm;
    if (extractionModelConfig === undefined) {
      logger.warn(
        "MEMORY_AUTO_CAPTURE is set but no MEMORY_EXTRACTION_MODEL or DEFAULT_LLM is configured; auto-capture disabled.",
      );
    } else {
      try {
        const extractionModel = createLlmProvider(
          extractionModelConfig,
          config,
        );
        memoryExtractor = createMemoryExtractor(extractionModel, { logger });
        logger.info(
          "Long-term memory auto-capture enabled (LLM fact extraction)",
          {
            provider: extractionModelConfig.provider,
            model: extractionModelConfig.model,
          },
        );
      } catch (err) {
        logger.warn(
          "Failed to build memory extraction model — auto-capture disabled",
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
    }
  }

  // ── RAG reranker ───────────────────────────────────────────────────────────
  let reranker: Reranker | undefined;
  if (config.rerankEnabled === true) {
    reranker = createReranker(config, logger);
    if (reranker === undefined) {
      logger.warn(
        "RERANK_ENABLED=true but no reranker could be built; configure " +
          "RERANK_URL + RERANK_MODEL for TEI or the legacy Bedrock fields.",
      );
    } else if (config.rerankUrl !== undefined) {
      logger.info("RAG reranking enabled with TEI primary", {
        primaryUrl: config.rerankUrl,
        primaryModel: config.rerankModel,
        ...(config.rerankFallbackModel !== undefined
          ? {
              fallbackModel: config.rerankFallbackModel,
              fallbackProvider: config.rerankFallbackProvider,
              fallbackRegion: config.rerankFallbackRegion,
            }
          : {}),
      });
    } else {
      logger.info("RAG reranking enabled with Bedrock", {
        model: config.rerankModel ?? "cohere.rerank-v3-5:0",
        ...(config.rerankProvider !== undefined
          ? { provider: config.rerankProvider }
          : {}),
        ...(config.rerankRegion !== undefined
          ? { region: config.rerankRegion }
          : {}),
      });
    }
  }

  return {
    embedder,
    semanticCache,
    responseCache,
    vectorStore,
    memoryStore,
    memoryExtractor,
    reranker,
  };
}
