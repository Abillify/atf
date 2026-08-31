// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tool-selection configuration + helpers (`src/graph/tool-selection.ts`)
 *
 * Parses an LLM node's `config.toolSelection` block and provides the pure
 * helpers the node handler uses to drive Dynamic Tool Retrieval. Kept separate
 * from the handler so the (testable) parsing/matching logic has no dependency
 * on the AI SDK or the execution runtime.
 *
 * `config.toolSelection` shape (all fields optional except when noted):
 *
 *   toolSelection:
 *     mode: semantic            # "static" (default) | "semantic"
 *     topK: 5                   # max semantically-selected tools to advertise
 *     minScore: 0.2             # drop hits below this cosine similarity
 *     alwaysInclude:            # refs/patterns always advertised (never gated)
 *       - base/*
 *     metaTool: true            # expose the on-demand `select_tools` meta-tool
 *     metaToolName: select_tools
 *     metaTopK: 2               # max tools activated per select_tools call (default 2)
 *     cacheStable: false        # advertise the full pool (stable) for robust prompt caching
 *
 * In `semantic` mode the node's full `tools` list becomes the CANDIDATE POOL:
 * every tool stays bound (and therefore callable), but only the always-included
 * tools + the top-K semantic matches + the meta-tool are advertised to the
 * model initially. The model can pull more in on demand via the meta-tool.
 *
 * No `any` at module boundaries.
 */

/** Resolved, defaulted tool-selection settings for a node. */
export interface ToolSelectionConfig {
  mode: "static" | "semantic";
  /** Max semantically-selected tools advertised initially. */
  topK: number;
  /** Minimum cosine similarity for a semantic hit to count (optional). */
  minScore?: number;
  /** Refs/patterns always advertised (full ref, bare name, `server/*`, `*`). */
  alwaysInclude: string[];
  /** Whether to expose the on-demand `select_tools` meta-tool. */
  metaTool: boolean;
  /** Name advertised for the meta-tool. */
  metaToolName: string;
  /** Max tools activated per select_tools call. Defaults to 2 (narrower than topK). */
  metaTopK: number;
  /**
   * When true the node advertises its FULL tool pool in a stable, deterministic
   * order instead of dynamically gating per request. This keeps the tools block
   * (which precedes the system block in the Anthropic/Bedrock cache prefix)
   * byte-identical across turns, so prompt caching of the large `tools+system`
   * prefix reliably hits. Trades the per-request token savings of dynamic
   * selection for robust cache hits — a win for hot, multi-turn conversational
   * nodes whose system prompt is large and stable. Default false.
   */
  cacheStable: boolean;
}

const DEFAULT_TOP_K = 5;
const DEFAULT_META_TOP_K = 2;
const DEFAULT_META_TOOL_NAME = "select_tools";

/**
 * Reads `config.toolSelection`. Returns undefined when absent or malformed (the
 * node then keeps its classic static behaviour — every declared tool is
 * advertised). Defaults: mode "static", topK 5, metaTool true, name
 * "select_tools".
 */
export function parseToolSelection(
  config: Record<string, unknown> | undefined,
): ToolSelectionConfig | undefined {
  const raw = config?.toolSelection;
  if (raw === null || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;

  const mode = obj.mode === "semantic" ? "semantic" : "static";

  const topKRaw = obj.topK;
  const topK =
    typeof topKRaw === "number" && Number.isFinite(topKRaw) && topKRaw > 0
      ? Math.floor(topKRaw)
      : DEFAULT_TOP_K;

  const minScoreRaw = obj.minScore;
  const minScore =
    typeof minScoreRaw === "number" && Number.isFinite(minScoreRaw)
      ? minScoreRaw
      : undefined;

  const alwaysRaw = obj.alwaysInclude;
  const alwaysInclude = Array.isArray(alwaysRaw)
    ? alwaysRaw.filter((x): x is string => typeof x === "string")
    : [];

  const metaTool = obj.metaTool !== false; // default true
  const metaNameRaw = obj.metaToolName;
  const metaToolName =
    typeof metaNameRaw === "string" && metaNameRaw.trim() !== ""
      ? metaNameRaw.trim()
      : DEFAULT_META_TOOL_NAME;

  const metaTopKRaw = obj.metaTopK;
  const metaTopK =
    typeof metaTopKRaw === "number" &&
    Number.isFinite(metaTopKRaw) &&
    metaTopKRaw > 0
      ? Math.floor(metaTopKRaw)
      : DEFAULT_META_TOP_K;

  const cacheStable = obj.cacheStable === true;

  return {
    mode,
    topK,
    ...(minScore !== undefined ? { minScore } : {}),
    alwaysInclude,
    metaTool,
    metaToolName,
    metaTopK,
    cacheStable,
  };
}

/**
 * Tests whether a single pattern matches a tool ref. Mirrors the approval-gate
 * matcher: full ref (`server/tool`), bare tool name, `server/*`, or `*`.
 */
function patternMatches(pattern: string, ref: string): boolean {
  const p = pattern.trim();
  if (p === "") return false;
  if (p === "*") return true;
  if (p === ref) return true;

  const parts = ref.split("/");
  const server = parts.length >= 2 ? (parts[0] ?? "") : "";
  const bare = parts.length >= 2 ? parts.slice(1).join("/") : ref;
  if (p === bare) return true;
  if (server !== "" && p === `${server}/*`) return true;
  return false;
}

/**
 * Expands a list of patterns against a candidate `pool`, returning the matching
 * refs (de-duplicated, pool order preserved). Used to resolve `alwaysInclude`
 * to concrete refs the node actually declares.
 */
export function expandPatterns(
  patterns: readonly string[],
  pool: readonly string[],
): string[] {
  if (patterns.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ref of pool) {
    if (seen.has(ref)) continue;
    if (patterns.some((p) => patternMatches(p, ref))) {
      out.push(ref);
      seen.add(ref);
    }
  }
  return out;
}

/** First sentence of a description, whitespace-collapsed and length-capped. */
function shortDescription(desc: string | undefined): string {
  if (desc === undefined) return "";
  const collapsed = desc.replace(/\s+/g, " ").trim();
  if (collapsed === "") return "";
  const firstSentence = collapsed.split(/(?<=[.!?])\s/)[0] ?? collapsed;
  return firstSentence.length > 140
    ? `${firstSentence.slice(0, 137)}...`
    : firstSentence;
}

/**
 * Builds a compact, server-grouped summary of the given tool refs for the
 * `select_tools` meta-tool description, so the model knows which capability
 * groups exist that it has NOT already been shown (it can request them on
 * demand). `describe` yields a tool's short description (e.g.
 * {@link import("./tool-index.js").ToolIndex.getDescription}). Returns "" when
 * there is nothing to advertise.
 */
export function buildGroupSummary(
  refs: readonly string[],
  describe: (ref: string) => string | undefined,
): string {
  const byServer = new Map<string, string[]>();
  for (const ref of refs) {
    const parts = ref.split("/");
    const server = parts.length >= 2 ? (parts[0] ?? "(local)") : "(local)";
    const bare = parts.length >= 2 ? parts.slice(1).join("/") : ref;
    const line = shortDescription(describe(ref));
    const list = byServer.get(server) ?? [];
    list.push(line !== "" ? `${bare} — ${line}` : bare);
    byServer.set(server, list);
  }
  const blocks: string[] = [];
  for (const [server, entries] of byServer) {
    blocks.push(`• ${server}: ${entries.join("; ")}`);
  }
  return blocks.join("\n");
}
