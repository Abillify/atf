// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/mcp-tool-ctx.ts
 *
 * Shared wiring for the MCP tool-registration modules extracted from
 * handlers/mcp.ts (Requirement 13.6): `mcp-transaction.ts`,
 * `mcp-search-tool.ts`, `mcp-ingest.ts` and `mcp-catalog.ts` (plus the
 * existing `mcp-nav.ts` precedent). `authorize`, `documentGroupOf` and
 * `emitQueryActivity` are the exact helpers the tools always used, passed in
 * so all modules share one implementation; the defaulted option scalars keep
 * the same defaults as `buildMcpServer`.
 */

import type { TokenCounter } from "../token-counter.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "pino";
import type { AccessScope } from "../access-scope.js";
import type { CollectionAcl } from "../collection-access.js";
import type { DocumentGroup } from "../document-identity.js";
import type { EmbeddingClient } from "../embedding-client.js";
import type { PostgresClient } from "../postgres-client.js";
import type { QueryEmbeddingCache } from "../query-cache.js";
import type { SparseEmbeddingClient } from "../sparse-embedding-client.js";
import type { RerankerClient } from "../reranker-client.js";
import type { HydeClient } from "../hyde-client.js";
import type { ChunkingOptions } from "../ingest-jobs.js";
import type { SummaryClient } from "../summary-client.js";
import type { TransactionConfig } from "../transaction-context.js";
import type { InvocationLedger } from "../invocation-ledger.js";

export interface McpToolContext {
  server: McpServer;
  embeddingClient: EmbeddingClient;
  postgresClient: PostgresClient;
  sparseClient: SparseEmbeddingClient | null;
  queryCache: QueryEmbeddingCache | null;
  rerankerClient?: RerankerClient | null;
  /**
   * Tokenizer used to fit the rerank inputs to the real token budget, as
   * `/v2/search` does. null/absent = the character heuristic only.
   */
  tokenCounter?: TokenCounter | null;
  hydeClient?: HydeClient | null;
  logger: Logger;
  defaultCollection?: string;
  hybridSearchDefault?: boolean;
  candidateMultiplier?: number;
  minRerankScore?: number | null;
  /**
   * SEARCH_MAX_QUERY_CHARS: over-long query texts are cut at the last space
   * before this limit (query-limits.ts); the tools report `query_truncated`.
   */
  maxQueryChars?: number;
  /**
   * SEARCH_GROUP_MAX_CHUNKS_PER_DOCUMENT: best-scoring chunks kept per
   * document by `group_by_document`; a cut document reports `truncated`
   * and `omitted_chunks`.
   */
  groupMaxChunksPerDocument?: number;
  /** SEARCH_MCP_PRETTY_JSON: indent the `search` tool's JSON. Default false. */
  mcpPrettyJson?: boolean;
  chunkingOptions?: ChunkingOptions | null;
  summaryClient?: SummaryClient | null;
  transactionConfig: TransactionConfig;
  invocationLedger?: InvocationLedger;
  embeddingModel?: string;
  embeddingModelRevision?: string;
  /**
   * The AssetStore (task 1.11) over `vs_assets` — the single source of truth
   * for the catalog `get_document_asset` tool. Null when not configured.
   */
  assetStore?: import("../asset-store.js").AssetStore | null;
  /** Resolve + authorize a collection for the acting principal (mcp.ts). */
  authorize: (
    collection: string,
  ) => Promise<{ scope: AccessScope; acl: CollectionAcl }>;
  /** The e-mail thread / attachment parent a document belongs to (mcp.ts). */
  documentGroupOf: (
    collection: string,
    baseRef: string,
  ) => Promise<DocumentGroup | undefined>;
  /** Emit a read-only "query" activity event (mcp.ts). */
  emitQueryActivity: (params: {
    tool: string;
    summary: string;
    status: "ok" | "error";
    startTime: number;
    detail: Record<string, unknown>;
  }) => void;
}
