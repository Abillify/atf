// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Built-in `parallel` node type handler — fan-out + merge.
 *
 * Extracted from the former monolithic `node-handlers.ts` (ADR-0004). A
 * parallel node executes all `parallelNodes` concurrently and merges their
 * state updates. Additionally supports `config.ragProfiles` for data-driven
 * retrieval plans.
 */
import { SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { NodeHandlerRegistration } from "../node-handler-registry.js";
import type { FlowNode } from "../../types/flow.js";
import { parallelChildId, parallelChildCondition } from "../../types/flow.js";
import type { ToolResultEntry } from "../../types/monitoring.js";
import type { StreamError } from "../../types/openai.js";
import { evaluateConditionExpression } from "../condition-evaluator.js";
import {
  RAG_CONTEXT_MARKER,
  getRuntime,
  lastUserQuery,
} from "../exec-runtime.js";
import { buildConditionContext } from "../graph-engine/node-config.js";
import { defaultNodeHandlerRegistry } from "../node-handler-registry.js";
import {
  parseVectorSearchResults,
  selectRerankedChunks,
  selectByRetrievalScore,
  type RagChunk,
} from "../reranker.js";
import { buildCitationEntries } from "../rag-grounding.js";
import { createToolNodeHandler } from "./tool.js";
import { Semaphore } from "../semaphore.js";
import {
  parseRagCompressionConfig,
  compressRagChunks,
} from "../rag-compression.js";
import {
  parseFollowupDownweightConfig,
  applySeenDownweight,
  mergeSeenRefs,
} from "../rag-followup.js";
import type { AgentState } from "../graph-engine.js";

// ---------------------------------------------------------------------------
// RAG profiles — data-driven retrieval plan helpers
// ---------------------------------------------------------------------------

/**
 * One retrieval source in a parallel node's `config.ragProfiles`. Compiled at
 * request time into an ephemeral `vectorsearch/search` tool call.
 */
interface RagSourceSpec {
  collection: string;
  tags?: string[];
  limit?: number;
  hybrid?: boolean;
  minScore?: number;
  scoreWeight?: number;
  when?: string;
  /** Server-side rerank via vectorsearch's cross-encoder. Default true. */
  rerank?: boolean;
  /** Server-side per-document result grouping via vectorsearch. Default true. */
  groupByDocument?: boolean;
}

/** A parallel node's data-driven retrieval plan (`config.ragProfiles`). */
interface RagProfilesConfig {
  select?: Array<{ when: string; use: string }>;
  default?: string;
  shared?: RagSourceSpec[];
  profiles: Record<string, RagSourceSpec[]>;
  /**
   * Model-based fusion: calls `runtime.reranker` (e.g. Bedrock Rerank) on the
   * union of all sources' chunks. For RAG sources that don't already rerank
   * server-side (unlike vectorsearch). Falls back to `selectByRetrievalScore`
   * when no reranker is wired.
   */
  rerank?: { topN?: number };
  /**
   * Score-only fusion: no model call, just sorts the union of all sources'
   * chunks by their already-returned score (e.g. vectorsearch's own
   * rerank/group_by_document result), deduplicates by document, and caps at
   * this many documents. Use instead of `rerank` when sources already rerank
   * themselves. Ignored when `rerank` is also set (rerank takes precedence).
   */
  maxDocuments?: number;
  /**
   * Minimum score (post-rerank or retrieval score, whichever fusion path is
   * active) a chunk must meet to be included, applied before the
   * `rerank.topN` / `maxDocuments` cap.
   */
  minScore?: number;
  /**
   * Minimum length (in characters) of the user query to trigger RAG retrieval.
   * Queries shorter than this threshold are considered trivial (e.g. "ja",
   * "ok", "Ich bin Produktmanager") and RAG is skipped entirely — saving
   * embedding, reranking, and context-window costs. Default: 0 (no skip).
   */
  minQueryLength?: number;
  /**
   * Optional regex pattern tested against the user query. When set, RAG is
   * ONLY executed if the query matches this pattern. Useful for skipping
   * retrieval on simple confirmations/selections while still running it for
   * substantive questions. Evaluated case-insensitively.
   */
  queryPattern?: string;
  /**
   * Name of the `classification` field whose value names the authoritative
   * source tag for this turn. When set and the classifier produced a value,
   * chunks tagged with it are marked authoritative in the fused context and the
   * model is told to prefer them; differently tagged chunks are offered only as
   * cross-reference.
   *
   * The field name belongs in the flow, not here: which tag is authoritative is
   * a deployment's domain policy. Omit it and no source is privileged.
   *
   * Defaults to `clientClientdocs` for compatibility with pre-1.0 flows that
   * relied on that name being hardcoded. The spelling follows the former
   * deployment convention `client` + collection name (`Clientdocs`); it is not
   * a customer identifier or a redaction placeholder. Set this field
   * explicitly in new flows so deployment vocabulary never becomes an engine
   * default again.
   */
  authoritativeTagField?: string;
}

/**
 * Compatibility value only. The neutral constant name is intentional: the
 * literal remains part of the pre-1.0 flow contract, not ATF's domain model.
 */
const LEGACY_AUTHORITATIVE_TAG_FIELD = "clientClientdocs";

/** Reads `config.ragProfiles` into a typed shape, or undefined when absent/malformed. */
function parseRagProfiles(
  config: Record<string, unknown> | undefined,
): RagProfilesConfig | undefined {
  const rp = config?.ragProfiles;
  if (rp === null || typeof rp !== "object") return undefined;
  const profiles = (rp as Record<string, unknown>).profiles;
  if (profiles === null || typeof profiles !== "object") return undefined;
  return rp as unknown as RagProfilesConfig;
}

/**
 * Resolves the active retrieval sources for this turn: picks a profile via the
 * `select` rules (first match) or `default`, concatenates `shared` + the
 * profile's own sources, and drops any whose `when` condition is false.
 */
function selectRagSources(
  cfg: RagProfilesConfig,
  condCtx: Record<string, unknown>,
): RagSourceSpec[] {
  let profileName: string | undefined;
  for (const rule of cfg.select ?? []) {
    if (
      rule !== null &&
      typeof rule === "object" &&
      typeof rule.when === "string" &&
      typeof rule.use === "string" &&
      evaluateConditionExpression(rule.when, condCtx)
    ) {
      profileName = rule.use;
      break;
    }
  }
  if (profileName === undefined) profileName = cfg.default;
  const rawProfile =
    profileName !== undefined ? cfg.profiles[profileName] : undefined;
  const profileSources = Array.isArray(rawProfile) ? rawProfile : [];
  const shared = Array.isArray(cfg.shared) ? cfg.shared : [];
  return [...shared, ...profileSources].filter((s) => {
    if (s === null || typeof s !== "object" || typeof s.collection !== "string")
      return false;
    const when = s.when;
    return (
      when === undefined ||
      when.trim().length === 0 ||
      evaluateConditionExpression(when, condCtx)
    );
  });
}

/**
 * Builds an ephemeral `tool` FlowNode that runs one RAG source as a single
 * `vectorsearch/search` call.
 */
function buildRagSourceNode(
  parentId: string,
  index: number,
  source: RagSourceSpec,
): FlowNode {
  const args: Record<string, unknown> = {
    query: "{{query}}",
    collection: source.collection,
    limit:
      typeof source.limit === "number" && source.limit > 0 ? source.limit : 8,
    hybrid: source.hybrid ?? true,
    // Server-side rerank + per-document grouping (vectorsearch MCP `search`
    // tool). Default on: vectorsearch does the reranking and dedup/merge, so
    // `limit` above is the final document count reaching the responder.
    rerank: source.rerank ?? true,
    group_by_document: source.groupByDocument ?? true,
  };
  if (Array.isArray(source.tags) && source.tags.length > 0)
    args.tags = source.tags;
  if (typeof source.minScore === "number") args.minScore = source.minScore;
  return {
    id: `${parentId}:rag:${index}:${source.collection}`,
    type: "tool",
    tools: ["vectorsearch/search"],
    config: {
      ...(typeof source.scoreWeight === "number"
        ? { scoreWeight: source.scoreWeight }
        : {}),
      toolArgs: { "vectorsearch/search": args },
    },
  };
}

// ---------------------------------------------------------------------------
// Cross-collection content deduplication
// ---------------------------------------------------------------------------

/**
 * Normalises a chunk's content for hash comparison: lowercases, collapses
 * whitespace, strips markdown formatting noise. The goal is to detect when
 * two collections serve the same underlying document (e.g. a page that exists
 * in both "clientdocs" and "docs") even if minor formatting differs.
 */
function normaliseForHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[#*_`~[\]()>|\\-]/g, "")
    .trim();
}

/**
 * Deduplicates chunks that share substantially identical content across
 * collections. Uses the first 512 normalised characters as a fingerprint —
 * if two chunks share the same fingerprint, the one with the higher retrieval
 * score is kept. This catches the common case where the same document is
 * indexed in multiple vectorsearch collections.
 */
function deduplicateByContent(chunks: import("../reranker.js").RagChunk[]): import("../reranker.js").RagChunk[] {
  if (chunks.length <= 1) return chunks;
  const seen = new Map<string, number>(); // fingerprint → index in result
  const result: import("../reranker.js").RagChunk[] = [];
  for (const chunk of chunks) {
    const norm = normaliseForHash(chunk.content);
    // Use first 512 chars as fingerprint — long enough to be unique per
    // document, short enough to tolerate minor tail differences.
    const fp = norm.slice(0, 512);
    if (fp.length < 20) {
      // Chunk is too short to fingerprint reliably (e.g. empty stubs) —
      // also deduplicate by title+id combination.
      const titleKey = `${chunk.title}::${chunk.id}`;
      const existingIdx = seen.get(titleKey);
      if (existingIdx !== undefined) {
        const existing = result[existingIdx];
        if (existing !== undefined && chunk.retrievalScore > existing.retrievalScore) {
          result[existingIdx] = chunk;
        }
      } else {
        seen.set(titleKey, result.length);
        result.push(chunk);
      }
      continue;
    }
    const existingIdx = seen.get(fp);
    if (existingIdx !== undefined) {
      const existing = result[existingIdx];
      if (existing !== undefined && chunk.retrievalScore > existing.retrievalScore) {
        result[existingIdx] = chunk;
      }
    } else {
      seen.set(fp, result.length);
      result.push(chunk);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * A `parallel` node executes all `parallelNodes` concurrently and merges
 * their state updates. Tool messages, errors and tool results are all
 * accumulated. The merged `messages` array preserves insertion order of
 * parallel outputs (sorted by node declaration order in `parallelNodes`).
 *
 * In addition to the statically-referenced `parallelNodes` children, a parallel
 * node may declare `config.ragProfiles`: a data-driven retrieval plan.
 */
export function createParallelNodeHandler(
  node: FlowNode,
  allNodes: Map<string, FlowNode>,
): (
  state: AgentState,
  config?: LangGraphRunnableConfig,
) => Promise<Partial<AgentState>> {
  return async (state, config): Promise<Partial<AgentState>> => {
    const runtime = getRuntime(config);
    if (runtime === undefined) return { currentNodeId: node.id };

    runtime.onNodeStart(node.id);

    // Resolve which children actually run this turn.
    const condCtx = buildConditionContext(state);
    const childIds = (node.parallelNodes ?? [])
      .filter((entry) => {
        const condition = parallelChildCondition(entry);
        return (
          condition === undefined ||
          condition.trim().length === 0 ||
          evaluateConditionExpression(condition, condCtx)
        );
      })
      .map(parallelChildId);

    // Data-driven RAG sources (`config.ragProfiles`).
    const ragCfg = parseRagProfiles(
      node.config as Record<string, unknown> | undefined,
    );

    // Conditional RAG skip: when the user query is too short or doesn't match
    // the configured pattern, skip retrieval entirely to save embedding/reranking
    // costs on trivial follow-ups (confirmations, role statements, etc.).
    const query = lastUserQuery(state);
    const ragSkipped =
      ragCfg !== undefined &&
      ((typeof ragCfg.minQueryLength === "number" &&
        ragCfg.minQueryLength > 0 &&
        query.length < ragCfg.minQueryLength) ||
        (typeof ragCfg.queryPattern === "string" &&
          ragCfg.queryPattern.length > 0 &&
          !new RegExp(ragCfg.queryPattern, "i").test(query)));

    const ragSources = ragCfg && !ragSkipped ? selectRagSources(ragCfg, condCtx) : [];
    const ragNodes = ragSources.map((source, i) =>
      buildRagSourceNode(node.id, i, source),
    );
    // Map each ephemeral RAG-source node id -> its `scoreWeight`, so the fusion
    // step can down/upweight a source's chunks relative to others. Indices of
    // `ragNodes` and `ragSources` align by construction.
    const ragWeightById = new Map<string, number>();
    ragSources.forEach((source, i) => {
      if (typeof source.scoreWeight === "number") {
        const ragNode = ragNodes[i];
        if (ragNode !== undefined) {
          ragWeightById.set(ragNode.id, source.scoreWeight);
        }
      }
    });

    if (childIds.length === 0 && ragNodes.length === 0) {
      return { currentNodeId: node.id };
    }

    // RAG fusion: either model-based rerank (`ragCfg.rerank`) or score-only
    // fusion (`ragCfg.maxDocuments`) collapses all sources into ONE block.
    const ragNodeIds = new Set(ragNodes.map((n) => n.id));
    const reranker = runtime.reranker;
    const modelRerankActive = ragCfg?.rerank !== undefined && reranker !== undefined;
    const fusionActive =
      (ragCfg?.rerank !== undefined || ragCfg?.maxDocuments !== undefined) &&
      ragNodes.length > 0;
    const ragConfig: LangGraphRunnableConfig | undefined =
      fusionActive && config !== undefined
        ? {
            ...config,
            configurable: {
              ...(config.configurable ?? {}),
              // Suppress BOTH citation paths for fused RAG children: the parent
              // registers the FUSED sources itself (below). Without suppressing
              // registerCitations too, each ephemeral vectorsearch `tool` child
              // (which now registers via registerCitations) would emit its raw
              // per-source hits and consume global [n] numbers, corrupting the
              // parent's fused numbering.
              runtime: {
                ...runtime,
                onCitations: async () => {},
                registerCitations: async (entries: unknown[]) =>
                  entries.map(() => 0),
              },
            },
          }
        : config;

    type ChildOutcome = {
      childId: string;
      emitsLifecycle: boolean;
      update: Partial<AgentState>;
    };

    type Task = {
      id: string;
      emitsLifecycle: boolean;
      run: () => Partial<AgentState> | Promise<Partial<AgentState>>;
    };
    const tasks: Task[] = [];

    // 1. Statically-referenced children.
    //
    // De-duplicated: the engine's per-node execution state (streaming guardrail
    // buffer, chunk ids, start time, model, token counts) is keyed by node id
    // alone, so listing a child twice would run one node concurrently with
    // itself — interleaving two token streams through a single guardrail buffer
    // and firing its completion event twice. A repeated entry is a flow-authoring
    // mistake with no useful meaning (same node, same state, same result), so it
    // is dropped rather than serialised.
    const seenChildIds = new Set<string>();
    for (const childId of childIds) {
      if (seenChildIds.has(childId)) {
        runtime.onNodeDiagnostic?.(node.id, {
          level: "warn",
          code: "parallel_duplicate_child",
          message:
            `Parallel node "${node.id}" lists child "${childId}" more than once; ` +
            "the duplicate is ignored (a node cannot run concurrently with itself).",
          details: { child_id: childId },
        });
        continue;
      }
      seenChildIds.add(childId);

      const childNode = allNodes.get(childId);
      if (childNode === undefined) {
        tasks.push({
          id: childId,
          emitsLifecycle: false,
          run: () => ({
            errors: [
              {
                message: `Parallel node "${node.id}": child node "${childId}" not found.`,
                type: "execution_error",
                details: { node_id: node.id },
              },
            ],
          }),
        });
        continue;
      }
      const registration = defaultNodeHandlerRegistry.get(childNode.type);
      const emitsLifecycle = registration?.emitsLifecycle ?? false;
      // A child whose type does not emit a monitoring lifecycle is replaced by a
      // no-op: it cannot be represented as a parallel branch. That is correct for
      // `router` (routing-only, nothing to run in a fan-out), but it also
      // silently swallows a NESTED `parallel` — the child does nothing at all and
      // the flow appears to work. Report it so the author finds out from a
      // diagnostic rather than from a missing result.
      if (registration !== undefined && !registration.emitsLifecycle) {
        runtime.onNodeDiagnostic?.(node.id, {
          // `router` as a parallel child is a plausible (if pointless) authoring
          // choice, not a bug — report it at info. Anything else, notably a
          // nested `parallel`, silently loses work and deserves a warning.
          level: childNode.type === "router" ? "info" : "warn",
          code: "parallel_child_not_executable",
          message:
            `Parallel node "${node.id}": child "${childId}" has type ` +
            `"${childNode.type}", which cannot run as a parallel branch — it is ` +
            "skipped and contributes nothing to the merged state." +
            (childNode.type === "parallel"
              ? " Nested parallel nodes are not supported; flatten the children into this node."
              : ""),
          details: { child_id: childId, child_type: childNode.type },
        });
      }
      const handler =
        registration?.emitsLifecycle
          ? registration.factory(childNode, { nodeMap: allNodes })
          : async (s: AgentState) => ({ currentNodeId: s.currentNodeId });
      tasks.push({
        id: childId,
        emitsLifecycle,
        run: () => handler(state, config),
      });
    }

    // 2. Profile-generated RAG sources (ephemeral tool nodes).
    for (const ragNode of ragNodes) {
      const handler = createToolNodeHandler(ragNode);
      tasks.push({
        id: ragNode.id,
        emitsLifecycle: true,
        run: () => handler(state, ragConfig),
      });
    }

    // Fan-out concurrency cap: without one, a parallel node with many children
    // (e.g. a dozen RAG sources, or a large `parallelNodes` list) launches all
    // of them as one `Promise.all` — every task starts its LLM/tool call in
    // the same instant, which can blow past the provider's own rate limit or
    // spike downstream load far above what a single flow step should need.
    // `config.maxFanoutConcurrency` bounds how many of THIS node's children run
    // simultaneously; default is unbounded (0) to preserve existing behaviour
    // for flows that rely on true fan-out and have few children anyway.
    const maxFanoutConcurrency = (() => {
      const raw = (node.config as Record<string, unknown> | undefined)
        ?.maxFanoutConcurrency;
      return typeof raw === "number" && raw > 0 ? Math.floor(raw) : 0;
    })();
    const fanoutLimiter =
      maxFanoutConcurrency > 0 && tasks.length > maxFanoutConcurrency
        ? new Semaphore(maxFanoutConcurrency)
        : undefined;

    const runTask = async (task: Task): Promise<ChildOutcome> => {
      if (fanoutLimiter !== undefined) await fanoutLimiter.acquire();
      try {
        const update = await task.run();
        return {
          childId: task.id,
          emitsLifecycle: task.emitsLifecycle,
          update,
        };
      } catch (err) {
        return {
          childId: task.id,
          emitsLifecycle: task.emitsLifecycle,
          update: {
            errors: [
              {
                message: `Parallel child "${task.id}" failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
                type: "execution_error",
                details: { node_id: task.id },
              },
            ],
          },
        };
      } finally {
        fanoutLimiter?.release();
      }
    };

    const childResults: ChildOutcome[] = await Promise.all(
      tasks.map((task) => runTask(task)),
    );

    // Merge results + emit a terminal event for every child that opened one.
    const mergedMessages: BaseMessage[] = [];
    const mergedErrors: StreamError[] = [];
    const mergedToolResults: ToolResultEntry[] = [];
    const ragChunks: RagChunk[] = [];

    for (const { childId, emitsLifecycle, update } of childResults) {
      const isRagSource = fusionActive && ragNodeIds.has(childId);
      if (update.messages && !isRagSource) {
        mergedMessages.push(
          ...(Array.isArray(update.messages)
            ? update.messages
            : [update.messages as BaseMessage]),
        );
      }
      const childErrors: StreamError[] = update.errors
        ? Array.isArray(update.errors)
          ? update.errors
          : [update.errors as StreamError]
        : [];
      if (childErrors.length > 0) mergedErrors.push(...childErrors);
      if (update.toolResults) {
        const trs = Array.isArray(update.toolResults)
          ? update.toolResults
          : [update.toolResults as ToolResultEntry];
        mergedToolResults.push(...trs);
        if (isRagSource) {
          // Tag every chunk from this source with the source's scoreWeight so
          // selectByRetrievalScore fuses on `retrievalScore * scoreWeight`.
          const weight = ragWeightById.get(childId);
          for (const tr of trs) {
            const parsed = parseVectorSearchResults(tr.result);
            if (weight !== undefined) {
              for (const c of parsed) c.scoreWeight = weight;
            }
            ragChunks.push(...parsed);
          }
        }
      }
      if (emitsLifecycle) {
        const childErrMsg =
          childErrors.length > 0
            ? childErrors.map((e) => e.message).join("; ")
            : undefined;
        await runtime.onNodeEnd?.(childId, childErrMsg);
      }
    }

    // Fuse collected RAG chunks into ONE doc-deduplicated context: either
    // model-reranked (ragCfg.rerank + a wired reranker) or, for sources that
    // already rerank/group themselves (e.g. vectorsearch), a plain score-sort
    // via ragCfg.maxDocuments — no model call, just filtering on the score
    // each source already returned. Both respect ragCfg.minScore.
    let assembledFindings: RagChunk[] = [];
    let seenDocRefsUpdate: string[] | undefined;
    const followupCfg = parseFollowupDownweightConfig(node.config);
    if (fusionActive && ragChunks.length > 0) {
      // Follow-up down-weighting: documents already shown in earlier turns
      // (state.seenDocRefs) compete at `factor`× their weight this turn, so
      // fresh material is preferred but strongly-relevant seen docs can still
      // resurface. Folded into scoreWeight before score-only fusion. Empty on
      // the first turn / without a conversation_id → no effect.
      if (followupCfg !== undefined && state.seenDocRefs.length > 0) {
        applySeenDownweight(
          ragChunks,
          new Set(state.seenDocRefs),
          followupCfg.factor,
        );
      }
      const minScore = ragCfg?.minScore;
      let selected: RagChunk[];
      if (modelRerankActive && reranker !== undefined) {
        const topN = ragCfg?.rerank?.topN ?? 8;
        const query = lastUserQuery(state);
        const documents = ragChunks.map((c) =>
          c.content !== "" ? c.content : c.title,
        );
        const hits = await reranker.rerank(query, documents, topN);
        selected =
          hits.length > 0
            ? selectRerankedChunks(ragChunks, hits, topN, minScore)
            : selectByRetrievalScore(ragChunks, topN, minScore);
      } else {
        const topN = ragCfg?.maxDocuments ?? ragCfg?.rerank?.topN ?? 8;
        selected = selectByRetrievalScore(ragChunks, topN, minScore);
      }

      // Cross-collection content deduplication: when the same document appears
      // in multiple collections (e.g. clientdocs AND docs) or overlapping chunks
      // from different collections carry near-identical content, deduplicate by
      // normalised content hash. Keeps the higher-scored variant.
      selected = deduplicateByContent(selected);

      // Optional query-focused compression (config.ragCompression): a small LLM
      // condenses each selected source to only the parts relevant to the
      // question and drops off-topic sources, so the responder reads a tight,
      // on-topic context instead of whole passages. Fail-open — on any error /
      // unparseable output the original selection is used unchanged (see
      // compressRagChunks). Runs on the score-fused, deduplicated top-N only,
      // so it is one extra LLM call per RAG turn regardless of source count.
      const compressionCfg = parseRagCompressionConfig(node.config);
      if (compressionCfg !== undefined && selected.length > 0) {
        selected = await compressRagChunks(
          runtime,
          lastUserQuery(state),
          selected,
          compressionCfg,
        );
      }

      assembledFindings = selected;
      // Record the documents actually shown to the responder this turn so later
      // turns can down-weight them (accumulated + capped across the conversation).
      if (followupCfg !== undefined && selected.length > 0) {
        seenDocRefsUpdate = mergeSeenRefs(
          state.seenDocRefs,
          selected,
          followupCfg.cap,
        );
      }
      if (selected.length > 0) {
        const authoritativeTagField =
          ragCfg?.authoritativeTagField ?? LEGACY_AUTHORITATIVE_TAG_FIELD;
        const authoritativeTag =
          typeof (state.classification as Record<string, unknown> | undefined)?.[
            authoritativeTagField
          ] === "string"
            ? ((state.classification as Record<string, unknown>)[
                authoritativeTagField
              ] as string)
            : "";
        const provenance = (c: RagChunk): string => {
          const tags = c.tags ?? [];
          if (tags.length === 0) return "";
          if (authoritativeTag !== "" && tags.includes(authoritativeTag))
            return ` [source: ${authoritativeTag} — authoritative]`;
          return ` [source tags: ${tags.join(", ")}]`;
        };
        const metaLine = (c: RagChunk): string => {
          const m = c.metadata;
          if (m === undefined || m === null || Object.keys(m).length === 0)
            return "";
          try {
            return `\nMetadata: ${JSON.stringify(m)}`;
          } catch {
            return "";
          }
        };
        // Register the fused sources in the per-execution citation registry
        // under their STABLE document key (base_ref → url → title) and number
        // the injected block from the GLOBAL indices it returns. This keeps the
        // `[n]` the block text uses identical to the sources streamed to the
        // client even when another emitter ran earlier, and lets a responder's
        // later self-search of the same document reuse the same `[n]`. Falls
        // back to positional `[1..k]` + onCitations when the registry is not
        // wired (e.g. in unit tests).
        const citationEntries = buildCitationEntries(selected, []);
        let indices: number[] = selected.map((_, i) => i + 1);
        try {
          if (runtime.registerCitations !== undefined) {
            indices = await runtime.registerCitations(citationEntries);
          } else {
            await runtime.onCitations?.(citationEntries.map((e) => e.citation));
          }
        } catch {
          /* ignore client disconnect */
        }
        const evidenceLine = (c: RagChunk): string => {
          const page =
            c.pageStart !== undefined
              ? c.pageEnd !== undefined && c.pageEnd !== c.pageStart
                ? `S. ${c.pageStart}–${c.pageEnd}`
                : `S. ${c.pageStart}`
              : undefined;
          const fields = [
            c.baseRef !== undefined ? `Ref: ${c.baseRef}` : undefined,
            page,
            c.modality !== undefined ? `Modalität: ${c.modality}` : undefined,
            c.figureId !== undefined ? `Abbildung: ${c.figureId}` : undefined,
            c.assetId !== undefined ? `Asset: ${c.assetId}` : undefined,
            c.bbox !== undefined ? `BBox: [${c.bbox.join(", ")}]` : undefined,
          ].filter((value): value is string => value !== undefined);
          return fields.length > 0 ? `\nEvidence: ${fields.join("; ")}` : "";
        };
        const numbered = selected
          .map(
            (c, i) =>
              `[${indices[i]}]${provenance(c)} ${c.title}${evidenceLine(c)}\n${c.content}${metaLine(c)}`,
          )
          .join("\n\n");
        const header =
          authoritativeTag !== ""
            ? `Authoritative source tag for this question: ${authoritativeTag}. ` +
              `Sources carrying that tag are authoritative. Use differently ` +
              `tagged sources only as a cross-reference; do not treat them as ` +
              `binding for this question.\n\n`
            : "";
        mergedMessages.push(
          new SystemMessage({
            content:
              header +
              `${RAG_CONTEXT_MARKER} ` +
              `If your answer uses a source, cite it inline as [n] ` +
              `(for example [1][3]). Cite only sources you actually used.\n\n` +
              numbered,
          }),
        );
      }
    }

    // Surface the assembler's input (which children/RAG sources ran for this
    // turn) and output (assembled context + fused findings) to the live
    // monitoring dashboard, so the Kontext-Assembler node shows meaningful
    // detail instead of nothing.
    runtime.onNodeIo?.(node.id, {
      prompt: JSON.stringify({
        query: lastUserQuery(state),
        staticChildren: childIds,
        ragCollections: ragSources.map((s) => s.collection),
      }),
      response: JSON.stringify({
        childrenRun: childResults.length,
        contextMessages: mergedMessages.length,
        errors: mergedErrors.length,
        ...(assembledFindings.length > 0
          ? {
              totalMatches: assembledFindings.length,
              findings: assembledFindings.map((c) => ({
                id: c.id,
                title: c.title,
                score: c.retrievalScore,
              })),
            }
          : {}),
      }),
    });

    return {
      currentNodeId: node.id,
      messages: mergedMessages,
      errors: mergedErrors,
      toolResults: mergedToolResults,
      ...(seenDocRefsUpdate !== undefined
        ? { seenDocRefs: seenDocRefsUpdate }
        : {}),
    };
  };
}

export const nodeType: NodeHandlerRegistration = {
  type: "parallel",
  emitsLifecycle: false,
  factory: (node, ctx) => createParallelNodeHandler(node, ctx.nodeMap),
};
