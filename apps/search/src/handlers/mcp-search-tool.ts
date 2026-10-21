// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/mcp-search-tool.ts
 *
 * The MCP `search` tool: semantic / hybrid / FTS search with
 * reranking, grouping, expansion and v2 filters.
 *
 * Extracted verbatim from handlers/mcp.ts (Requirement 13.6). The tools are
 * registered onto the SAME {@link McpServer} built by buildMcpServer, so they
 * inherit its one registration boundary — identical Fabric scope,
 * authorization and idempotency semantics.
 */

import { z } from "zod";
import { accessScopeForMcp, requireActingUser } from "../access-scope.js";
import { emitActivity } from "../activity-emitter.js";
import { DEFAULT_EXPAND_BUDGET_CHARS, MAX_EXPAND_BUDGET_CHARS, defaultBudgetCharsFor, type ExpandMode } from "../expansion.js";
import { FIGURE_KINDS } from "../figure-kinds.js";
import { FILTER_V2, UNIT_FILTER_V2, normalizeFilterV2, unitFilterV2HasPredicates, type UnitFilterV2 } from "../metadata.js";
import {
  decodeCursor,
  encodeCursor,
  prepareFtsContent,
} from "../postgres-client.js";
import {
  groupResultsBySection,
  retrievalScoreKind,
  type GroupByMode,
  type ScoreThreshold,
} from "../rerank-context.js";
import { parseRfc3339DateTime } from "../rfc3339.js";
import { shapeHitV2, type IncludeAssets } from "../search-v2-response.js";
import { getUsageContext } from "../usage-context.js";
import { newActivityId } from "./activity-stream.js";
import {
  CandidateSearchError,
  EmbeddingFailedError,
  runRetrievalPipeline,
  type RetrievalPipelineResult,
} from "./retrieval-pipeline.js";
import { BadRequest, parseFilters } from "./search-v2.js";
import { buildSearchDetail, buildSearchSummary } from "./search.js";
import { clampQuery, DEFAULT_MAX_QUERY_CHARS } from "../query-limits.js";
import { aggregateTrustLabels, trustLabels } from "../content-trust.js";
import type { McpToolContext } from "./mcp-tool-ctx.js";

export function registerSearchTool(opts: McpToolContext): void {
  const {
    server,
    embeddingClient,
    postgresClient,
    sparseClient,
    queryCache,
    rerankerClient = null,
    tokenCounter = null,
    hydeClient = null,
    logger,
    defaultCollection = "documents",
    hybridSearchDefault = true,
    candidateMultiplier = 4,
    minRerankScore = null,
    maxQueryChars = DEFAULT_MAX_QUERY_CHARS,
    groupMaxChunksPerDocument = 8,
    authorize,
  } = opts;

  // ── Tool: search ───────────────────────────────────────────────────────────
  server.tool(
    "search",
    "Semantically search the vector index. Returns ranked document chunks with scores.",
    {
      query: z.string().min(1).describe("Natural-language search query"),
      collection: z
        .string()
        .optional()
        .describe(`Collection to search (default: "${defaultCollection}")`),
      requesting_user: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Explicit owner for private searches. Must exactly match the authenticated end-user principal.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum results to return (default: 10)"),
      hybrid: z
        .boolean()
        .optional()
        .describe(
          "Use hybrid search (dense + PostgreSQL FTS/ts_rank RRF). Default: server setting",
        ),
      filter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Metadata equality filter, e.g. {"product": "acme"}'),
      filter_v2: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Canonical metadata filter with eq/in/range operators"),
      minScore: z
        .number()
        .finite()
        .optional()
        .describe("Minimum score applied after final grouping/reranking"),
      path_prefix: z
        .string()
        .optional()
        .describe(
          'Restrict the search to documents beneath this folder path (matched against the document reference/base_ref), e.g. "/Unterlagen Teil 1". Combine with query for folder-scoped semantic search.',
        ),
      hyde: z
        .boolean()
        .optional()
        .describe(
          "Expand the query into a hypothetical answer document before embedding (HyDE) for better recall on natural-language questions. Requires HYDE_MODEL configured server-side; ignored otherwise. Default: false",
        ),
      tags: z
        .array(z.string())
        .optional()
        .describe("Document must contain ALL of these tags"),
      include_all_versions: z
        .boolean()
        .optional()
        .describe("Include every eligible historical version; default false selects one version per document"),
      valid_at: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe("RFC 3339 instant with timezone; combines orthogonally with include_all_versions"),
      rerank: z
        .boolean()
        .optional()
        .describe(
          "Rerank results with the cross-encoder reranker (requires RERANK_MODEL configured server-side). Default: false",
        ),
      group_by_document: z
        .boolean()
        .optional()
        .describe(
          "Collapse multi-chunk results into one merged result per document; an e-mail thread " +
            "counts as one document (its messages merged chronologically). Default: false",
        ),
      expand: z
        .enum(["none", "neighbors", "section", "page", "document"])
        .optional()
        .describe(
          "Small-to-big expansion: augment each hit with an `expanded` field " +
            "carrying the neighbouring chunks (`neighbors`), the whole section " +
            "(`section`), the whole page (`page`), or the whole document " +
            "(`document`; for an e-mail the whole thread, chronologically), bounded by budget_chars. " +
            "Honours the same visibility/ACL/revision rules as the search. " +
            "Default / `none`: no expansion.",
        ),
      budget_chars: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          `Character budget for expand. When expand is set but this is omitted, defaults to ${DEFAULT_EXPAND_BUDGET_CHARS}; values above ${MAX_EXPAND_BUDGET_CHARS} are clamped. The expansion reports truncated=true when it had to drop units to fit.`,
        ),
      granularity: z
        .enum(["chunk", "section", "page", "document"])
        .optional()
        .describe(
          "v2: restrict hits to one unit level (applied as a unit_type filter unless unit_type is given).",
        ),
      include_assets: z
        .enum(["none", "refs", "thumbnails"])
        .optional()
        .describe(
          "v2: attach figure assets (the hit figure + referenced figures) to each hit. refs = ids/metadata only; thumbnails = plus ACL-checked thumb_url/url. Default: refs when any v2 parameter is used, else none.",
        ),
      group_by: z
        .enum(["none", "document", "section"])
        .optional()
        .describe(
          "v2: merge hits per document (base_ref) or per section (section_id within its document): best score, content merged in document order, `group` provenance on each result. Overrides group_by_document / group_by_section.",
        ),
      pages: z
        .union([
          z.array(z.number().int().min(1)).min(1).max(2),
          z.object({ start: z.number().int().min(1), end: z.number().int().min(1) }),
        ])
        .optional()
        .describe("v2 filter: page [p], range [start, end] or { start, end } (inclusive)."),
      unit_type: z
        .enum(["chunk", "table", "figure", "section", "page", "document"])
        .optional()
        .describe("v2 filter: only units of this type."),
      figure_kind: z
        .string()
        .min(1)
        .optional()
        .describe(
          `v2 filter: only figures of this kind: ${FIGURE_KINDS.join(" | ")}. Aliases: process (bpmn + flowchart), drawing (technical_drawing), data (chart), mask (ui_mask), table (table_image).`,
        ),
      section_prefix: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe('v2 filter: section path prefix, e.g. ["4 Wareneingang", "4.2 Anmeldung"].'),
      identifier: z
        .string()
        .min(1)
        .optional()
        .describe(
          'v2: an identifier the answer must be anchored on (e.g. "WE-01/A"); its exact occurrences join the ranking as a third fused list.',
        ),
      identifier_search: z
        .boolean()
        .optional()
        .describe(
          "Fuse exact identifier occurrences (vs_identifiers + ts_ident) as a third ranked list in hybrid search. Default: on when any v2 parameter is used, else off (legacy ranking).",
        ),
      group_by_section: z
        .boolean()
        .optional()
        .describe(
          "For a single large document: diversify hits (cap per section, collapse " +
            "same table/figure) and group the results by section path. Returns a " +
            "`sections` array alongside the flat `results`. Default: false",
        ),
      cursor: z
        .string()
        .optional()
        .describe(
          "Opaque keyset cursor from a previous search response (next_cursor field). " +
            "Use for stable, O(1) pagination instead of offset. NOT supported when " +
            "hybrid=true: reciprocal-rank fusion scores depend on the candidate pool, " +
            "so a cursor cannot page stably — use offset for hybrid search.",
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Number of results to skip (legacy; prefer cursor for large datasets)",
        ),
    },
    async ({
      query: rawQuery,
      collection,
      requesting_user,
      limit = 10,
      hybrid,
      filter,
      filter_v2,
      minScore,
      path_prefix,
      hyde,
      tags,
      include_all_versions,
      valid_at,
      rerank,
      group_by_document,
      group_by_section,
      expand,
      budget_chars,
      granularity,
      include_assets,
      group_by,
      pages,
      unit_type,
      figure_kind,
      section_prefix,
      identifier,
      identifier_search,
      cursor: cursorStr,
      offset = 0,
    }) => {
      const searchStartTime = Date.now();
      // Query-cost bound: cut an over-long query before it reaches HyDE, the
      // embedding, the lexical list, or the reranker.
      const { query, truncated: queryTruncated } = clampQuery(
        rawQuery,
        maxQueryChars,
      );
      const col = collection ?? defaultCollection;
      const secured = await authorize(col);
      if (requesting_user !== undefined) {
        requireActingUser(secured.scope, requesting_user);
      }
      const useHybrid = hybrid ?? hybridSearchDefault;
      const hydeRequested = hyde === true;
      const useHyde = hydeRequested && hydeClient !== null;
      const rerankRequested = rerank === true;
      const rerankActive = rerankRequested && rerankerClient !== null;
      // MIN_RERANK_SCORE (task 6.10, Requirement 4.8): the server-side default
      // threshold applies when the call omits its per-request minScore. Each
      // threshold carries its scale: the server default is a reranker
      // threshold; a per-request minScore is on the scale the call asked for
      // (rerank when it requested reranking, else its retrieval mode).
      const effectiveMinScore = minScore ?? minRerankScore ?? undefined;
      const minScoreThreshold: ScoreThreshold | undefined =
        minScore !== undefined
          ? {
              value: minScore,
              kind: rerankRequested
                ? "rerank"
                : retrievalScoreKind({ ftsOnly: false, hybrid: useHybrid }),
            }
          : minRerankScore !== null && minRerankScore !== undefined
            ? { value: minRerankScore, kind: "rerank" }
            : undefined;
      // v2 mode (Req 15.2): any Requirement-13.3 parameter switches on the v2
      // extras (identifier list, v2 hit fields, assets). A legacy call with none
      // of them keeps its exact previous request/response (Req 13.7).
      const v2Requested =
        granularity !== undefined ||
        include_assets !== undefined ||
        group_by !== undefined ||
        pages !== undefined ||
        unit_type !== undefined ||
        figure_kind !== undefined ||
        section_prefix !== undefined ||
        identifier !== undefined ||
        (expand !== undefined && expand !== "none") ||
        budget_chars !== undefined;
      const identifierList = identifier_search ?? v2Requested;
      const includeAssets: IncludeAssets =
        include_assets ?? (v2Requested ? "refs" : "none");
      // An explicit group_by wins over the legacy boolean flags.
      const groupByV2: GroupByMode | undefined =
        group_by !== undefined && group_by !== "none" ? group_by : undefined;
      const groupByDocument =
        group_by === undefined ? group_by_document === true : false;
      const groupBySection =
        group_by === undefined
          ? group_by_section === true && !groupByDocument
          : false;
      const fetchLimit =
        rerankActive ||
        groupByDocument ||
        groupBySection ||
        groupByV2 !== undefined ||
        effectiveMinScore !== undefined
          ? Math.min(limit * Math.max(1, candidateMultiplier), 500)
          : limit;
      let effectiveFilter = filter as Record<string, unknown> | undefined;
      if (filter_v2 !== undefined) {
        try {
          const filterV2 = normalizeFilterV2(filter_v2);
          effectiveFilter = { ...(effectiveFilter ?? {}) };
          (
            effectiveFilter as Record<string, unknown> & {
              [FILTER_V2]?: typeof filterV2;
            }
          )[FILTER_V2] = filterV2;
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text:
                  error instanceof Error ? error.message : "Invalid filter_v2",
              },
            ],
            isError: true,
          };
        }
      }

      // v2 unit filters (pages / unit_type / figure_kind / section_prefix /
      // identifier), validated with the same parser as /v2/search.
      let explicitIdentifier: string | undefined;
      try {
        const parsed = parseFilters({
          ...(pages !== undefined ? { pages } : {}),
          ...(unit_type !== undefined ? { unit_type } : {}),
          ...(figure_kind !== undefined ? { figure_kind } : {}),
          ...(section_prefix !== undefined ? { section_prefix } : {}),
          ...(identifier !== undefined ? { identifier } : {}),
        });
        const unit: UnitFilterV2 = parsed.unit;
        explicitIdentifier = parsed.identifier;
        if (granularity !== undefined && unit.unitType === undefined)
          unit.unitType = granularity;
        if (unitFilterV2HasPredicates(unit)) {
          effectiveFilter = { ...(effectiveFilter ?? {}) };
          (
            effectiveFilter as Record<string, unknown> & {
              [UNIT_FILTER_V2]?: UnitFilterV2;
            }
          )[UNIT_FILTER_V2] = unit;
        }
      } catch (error) {
        if (error instanceof BadRequest) {
          return {
            content: [{ type: "text", text: error.message }],
            isError: true,
          };
        }
        throw error;
      }

      // Decode cursor if provided
      let cursor: import("../postgres-client.js").SearchCursor | undefined;
      if (cursorStr) {
        const decoded = decodeCursor(cursorStr);
        if (!decoded) {
          return {
            content: [{ type: "text", text: "Invalid cursor value" }],
            isError: true,
          };
        }
        cursor = decoded;
      }

      // Refuse cursor + hybrid explicitly. RRF scores are pool-relative, so
      // filtering the candidate pool by a cursor reranks whatever is left —
      // keyset pagination cannot be stable. This combination used to be accepted
      // and silently lost high-ranking results.
      if (cursor && useHybrid) {
        return {
          content: [
            {
              type: "text",
              text:
                "cursor is not supported together with hybrid=true: reciprocal-rank " +
                "fusion scores depend on the candidate pool, so a keyset cursor cannot " +
                "page stably. Use offset, or set hybrid=false.",
            },
          ],
          isError: true,
        };
      }

      // HyDE query expansion (optional): generate a hypothetical answer
      // document and embed THAT instead of the raw query. The original `query`
      // is still used for the PostgreSQL FTS/ts_rank/lexical branch below (keeps exact terms).
      // Same normalisation the other search surfaces apply before embedding
      // (markdown/URL/long-token cleanup); a query that is nothing but such
      // noise embeds as written.
      let embedText = prepareFtsContent(query) || query;
      let hydeApplied = false;
      let hydeFallbackReason:
        | "not-requested"
        | "unavailable"
        | "failed"
        | null = hydeRequested
        ? hydeClient === null
          ? "unavailable"
          : null
        : "not-requested";
      if (useHyde && hydeClient) {
        const hydeRes = await hydeClient.expand(
          query,
          accessScopeForMcp().tenantId,
        );
        if (hydeRes.ok) {
          embedText = hydeRes.result;
          hydeApplied = true;
        } else {
          hydeFallbackReason = "failed";
          logger.warn(
            { error: hydeRes.error },
            "[MCP] HyDE expansion failed; falling back to raw query",
          );
        }
      }

      // Embed → sparse → candidates → rerank → document groups → diversify /
      // threshold → slice → expansion → figure lookup: the shared retrieval
      // core (see retrieval-pipeline.ts). The MCP-specific stage configuration:
      // rerank WITH token fitting (the `tokenCounter`, like /v2/search) but
      // without a minimum-candidate guard, the relevance threshold BEFORE the
      // limit slice (so the page fills from the qualified set and
      // `rerank_score_hits` can name every qualified document), document-group
      // annotation on every hit, and figure resolution only in v2 mode when
      // assets are enabled.
      const expandMode =
        expand === undefined || expand === "none"
          ? undefined
          : (expand as ExpandMode);
      let pipe: RetrievalPipelineResult;
      try {
        pipe = await runRetrievalPipeline(
          {
            embeddingClient,
            postgresClient,
            queryCache,
            sparseClient,
            rerankerClient,
          },
          logger,
          {
            query,
            embedText,
            collection: col,
            scope: accessScopeForMcp(),
            filter: effectiveFilter,
            limit,
            fetchLimit,
            hybrid: useHybrid,
            includeAllVersions: include_all_versions ?? false,
            offset: cursor ? 0 : offset,
            candidateMultiplier,
            tags: tags?.length ? tags : undefined,
            cursor,
            ftsOnly: false,
            pathPrefix: path_prefix,
            validAt: parseRfc3339DateTime(valid_at),
            // Identifier RRF list only in v2 mode / on explicit request (Req 13.7).
            searchOptions: identifierList
              ? {
                  identifierList: true,
                  ...(explicitIdentifier
                    ? { identifiers: [explicitIdentifier] }
                    : {}),
                }
              : undefined,
            logSparseFailure: false,
            rerank: { active: rerankActive, tokenCounter },
            documentGroups: true,
            legacyGroupByDocument: groupByDocument,
            groupMaxChunksPerDocument,
            diversify: groupBySection
              ? "default"
              : groupByV2 !== undefined
                ? "uncapped"
                : "none",
            groupBy: groupByV2 ?? "none",
            minScore: {
              threshold: minScoreThreshold,
              position: "before-slice",
            },
            expand:
              expandMode !== undefined
                ? {
                    mode: expandMode,
                    budgetChars:
                      budget_chars ?? defaultBudgetCharsFor(expandMode),
                    validAt: parseRfc3339DateTime(valid_at),
                  }
                : undefined,
            resolveFigures: v2Requested && includeAssets !== "none",
          },
        );
      } catch (err) {
        if (err instanceof EmbeddingFailedError) {
          logger.warn({ err }, "[MCP] Embedding failed");
          return {
            content: [
              { type: "text", text: `Embedding failed: ${err.message}` },
            ],
            isError: true,
          };
        }
        if (err instanceof CandidateSearchError) {
          logger.warn({ error: err.message }, "[MCP] Search failed");
          return {
            content: [{ type: "text", text: `Search failed: ${err.message}` }],
            isError: true,
          };
        }
        throw err;
      }
      const rerankStatus: {
        requested: boolean;
        available: boolean;
        applied: boolean;
        complete: boolean;
        scoredCount: number;
        inputCount: number;
        fallbackReason:
          | "not-requested"
          | "unavailable"
          | "failed"
          | "empty-or-invalid"
          | null;
      } = pipe.rerank
        ? {
            requested: true,
            available: true,
            applied: pipe.rerank.applied,
            complete: pipe.rerank.complete,
            scoredCount: pipe.rerank.scoredCount,
            inputCount: pipe.rerank.inputCount,
            fallbackReason: pipe.rerank.fallbackReason,
          }
        : {
            requested: rerankRequested,
            available: rerankerClient !== null,
            applied: false,
            complete: false,
            scoredCount: 0,
            inputCount: pipe.candidateCount,
            fallbackReason: rerankRequested
              ? rerankerClient === null
                ? "unavailable"
                : null
              : "not-requested",
          };
      // Preserve compact provenance for every fully reranked candidate before
      // the normal response limit truncates content-heavy result objects. This
      // lets score-threshold consumers select all qualified documents without
      // expanding the public `results` payload to the full candidate pool.
      // `pipe.qualified` is the post-threshold, pre-slice candidate list.
      const rerankScoreHits =
        rerankStatus.applied && rerankStatus.complete
          ? pipe.qualified.map((item, index) => ({
              base_ref: item.base_ref,
              reference: item.reference,
              score: item.score,
              rank: index + 1,
            }))
          : [];
      const finalScoreKind = pipe.scoreKind;
      const minScoreOutcome = pipe.minScore;
      const countBeforeMinScore = pipe.countBeforeMinScore;
      const countAfterMinScore = pipe.countAfterMinScore;

      const hits = pipe.results.map((r) => {
        const v2 = v2Requested
          ? shapeHitV2(r, {
              collection: col,
              includeAssets,
              figureInfo: pipe.figureInfo,
            })
          : null;
        return {
          id: r.id,
          score: r.score,
          vector_score: r.vector_score ?? undefined,
          reference: r.reference,
          base_ref: r.base_ref,
          title: r.title ?? null,
          source: r.source ?? null,
          link: r.link ?? null,
          tags: r.tags ?? [],
          content: r.content,
          // Retrieved text is untrusted data; injection_risk is a heuristic hint.
          ...trustLabels(r.content),
          chunk: r.chunk ?? null,
          evidence: r.evidence ?? null,
          asset_url: r.asset_url ?? null,
          metadata: r.metadata,
          modified: r.modified,
          valid_from: r.valid_from?.toISOString() ?? null,
          effective_valid_from: r.effective_valid_from.toISOString(),
          ...(r.document_group ? { document_group: r.document_group } : {}),
          ...(r.group_members ? { group_members: r.group_members } : {}),
          ...(r.truncated
            ? { truncated: true, omitted_chunks: r.omitted_chunks }
            : {}),
          ...("expanded" in r && r.expanded ? { expanded: r.expanded } : {}),
          // v2 hit fields (design §7.2), only in v2 mode so legacy output is unchanged.
          ...(v2
            ? {
                ...(v2.unit_id ? { unit_id: v2.unit_id } : {}),
                ...(v2.unit_type ? { unit_type: v2.unit_type } : {}),
                section_path: v2.section_path,
                pages: v2.pages,
                navigation: v2.navigation,
                evidence: v2.evidence ?? null,
                ...(v2.assets ? { assets: v2.assets } : {}),
                ...(v2.group ? { group: v2.group } : {}),
                ...(v2.revision_state
                  ? { revision_state: v2.revision_state }
                  : {}),
                ...(v2.pages_available
                  ? { pages_available: v2.pages_available }
                  : {}),
              }
            : {}),
        };
      });

      // Section grouping (task 3.5, Requirement 13.6): group the final
      // (diversified, limited) results by section path, scoped to each hit's
      // document. Emitted as a parallel `sections` array; the flat `results`
      // stay unchanged so existing consumers are unaffected.
      const sections = groupBySection
        ? groupResultsBySection(pipe.results).map((g) => ({
            section_path: g.section_path,
            base_ref: g.base_ref,
            score: g.score,
            references: g.results.map((r) => r.reference),
          }))
        : undefined;

      // Build next_cursor when the full page was returned (and no reranking —
      // rerank reorders results, so keyset pagination would be unreliable).
      let nextCursor: string | undefined;
      if (
        !rerankActive &&
        !groupBySection &&
        groupByV2 === undefined &&
        hits.length === limit
      ) {
        const last = pipe.results[pipe.results.length - 1];
        if (last) {
          // Include `score` — it is the value the query ordered by and thus part
          // of the keyset key. A cursor without it pages on `created` alone
          // against a relevance-ordered set and silently loses top hits.
          nextCursor = encodeCursor({
            created: last.created.toISOString(),
            id: last.id,
            score: last.score,
          });
        }
      }

      const usage = getUsageContext();
      emitActivity({
        id: newActivityId(),
        tenantId: accessScopeForMcp().tenantId,
        type: "search",
        status: "ok",
        summary: buildSearchSummary({
          query,
          collection: col,
          mode: useHybrid ? "hybrid" : "dense",
          reranked: rerankStatus.applied,
          results: pipe.results,
          filter: filter as
            | import("../postgres-client.js").SearchFilter
            | undefined,
          tags: tags?.length ? tags : undefined,
        }),
        timestamp: new Date().toISOString(),
        duration_ms: Date.now() - searchStartTime,
        detail: buildSearchDetail({
          results: pipe.results,
          hybrid: useHybrid,
          reranked: rerankStatus.applied,
          collection: col,
          filter: filter as
            | import("../postgres-client.js").SearchFilter
            | undefined,
          tags: tags?.length ? tags : undefined,
          source: "mcp",
        }),
        usage: usage
          ? {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cost: usage.cost,
              modelCosts: usage.modelCosts,
            }
          : undefined,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                results: hits,
                count: hits.length,
                ...(queryTruncated ? { query_truncated: true } : {}),
                ...aggregateTrustLabels(hits.map((h) => h.injection_risk)),
                rerank: rerankStatus,
                ...(rerankScoreHits.length > 0
                  ? { rerank_score_hits: rerankScoreHits }
                  : {}),
                hyde: {
                  requested: hydeRequested,
                  available: hydeClient !== null,
                  applied: hydeApplied,
                  fallbackReason: hydeFallbackReason,
                },
                score_kind: rerankStatus.applied ? "rerank" : "retrieval",
                score_scale: finalScoreKind,
                minScore: effectiveMinScore ?? null,
                score_filter: {
                  applied:
                    minScoreOutcome.abstention !== undefined &&
                    minScoreOutcome.abstention.skipped === undefined,
                  score_kind: rerankStatus.applied ? "rerank" : "retrieval",
                  score_scale: finalScoreKind,
                  ...(minScoreOutcome.abstention?.skipped !== undefined
                    ? { skipped: minScoreOutcome.abstention.skipped }
                    : {}),
                  before: countBeforeMinScore,
                  after: countAfterMinScore,
                  removed: countBeforeMinScore - countAfterMinScore,
                },
                ...(minScoreOutcome.abstention !== undefined
                  ? { abstention: minScoreOutcome.abstention }
                  : {}),
                ...(sections ? { sections } : {}),
                ...(nextCursor ? { next_cursor: nextCursor } : {}),
                ...(usage !== undefined &&
                (usage.inputTokens > 0 ||
                  usage.outputTokens > 0 ||
                  usage.cost > 0)
                  ? {
                      usage: {
                        inputTokens: usage.inputTokens,
                        outputTokens: usage.outputTokens,
                        cost: usage.cost,
                        modelCosts: usage.modelCosts,
                      },
                    }
                  : {}),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
