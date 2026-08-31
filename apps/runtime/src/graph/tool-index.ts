// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Dynamic tool retrieval — per-tool embedding index (`src/graph/tool-index.ts`)
 *
 * Implements "RAG for tools": instead of advertising every MCP tool a node
 * declares to the model up front (which bloats the context window and degrades
 * tool-selection accuracy once a node has dozens of tools), we embed each
 * tool's identity (server + name + description + parameter names) once and, at
 * request time, rank the node's candidate pool against the user's query by
 * cosine similarity. The LLM node then only ADVERTISES the top-K most relevant
 * tools (plus any always-included ones and an on-demand `select_tools`
 * meta-tool) while keeping the full pool bound and callable — the SOTA
 * "tool search tool" pattern (Anthropic, Nov 2025; RAG-MCP, arXiv 2505.03275).
 *
 * Design notes:
 *   - The index is per-replica and in-memory. Tool sets are small and bounded
 *     (tens to low hundreds), so a linear cosine scan is more than fast enough
 *     and needs no vector DB. Embeddings are computed lazily on first use and
 *     cached by tool ref for the process lifetime; an injected {@link Embedder}
 *     may itself be cache-backed (see embedding-cache.ts).
 *   - The embedding TEXT is sourced from the FILTERED tool schema (protected
 *     params already removed, Req 7.2), so nothing sensitive is ever embedded.
 *   - A tool whose schema cannot be fetched (server down / not connected) is
 *     skipped: it simply won't be selectable, and the caller's full-pool
 *     `buildAiTools` already degrades gracefully for unavailable tools.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import { cosineSimilarity } from "./semantic-cache.js";
import type { Embedder } from "./semantic-cache.js";
import type { McpWrapperService } from "../mcp/mcp-wrapper.js";

export interface ToolIndexAuthOptions {
  authToken?: string;
}

function tokenScope(authToken: string | undefined): string {
  return authToken === undefined || authToken === ""
    ? "shared"
    : crypto.createHash("sha256").update(authToken, "utf8").digest("hex");
}

function scopedKey(scope: string, key: string): string {
  return `${scope}\u0000${key}`;
}

/** A ranked tool-selection result. */
export interface ToolSelectionHit {
  /** Full tool reference (`server/tool`). */
  ref: string;
  /** Cosine similarity to the query embedding, in [-1, 1] (typically [0, 1]). */
  score: number;
  /** The tool's (filtered) description, for surfacing in the meta-tool result. */
  description?: string;
  /** The tool's (filtered) input schema, so the meta-tool can show how to call it. */
  inputSchema?: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type McpCapabilityKind =
  | "tool"
  | "resource"
  | "resource-template"
  | "prompt"
  | "instructions";

export interface McpCapabilityHit {
  ref: string;
  server: string;
  kind: McpCapabilityKind;
  score: number;
  description?: string;
}

/** Splits a `server/tool` ref into its two parts (tool may itself contain `/`). */
function splitRef(ref: string): { server: string; tool: string } {
  const parts = ref.split("/");
  if (parts.length >= 2) {
    return { server: parts[0] ?? "", tool: parts.slice(1).join("/") };
  }
  return { server: "", tool: ref };
}

/**
 * Builds the text embedded for a tool. Combines the server name, the tool name
 * (both raw and space-split so `vacation_create` also matches "vacation
 * create"), the description, and the parameter names — the signals a query is
 * most likely to align with.
 */
function toolEmbeddingText(
  server: string,
  name: string,
  description: string | undefined,
  paramNames: readonly string[],
): string {
  const spacedName = name.replace(/[_\-/]+/g, " ");
  const params = paramNames.length > 0 ? `Parameters: ${paramNames.join(", ")}.` : "";
  return [
    server !== "" ? `${server} ${name}` : name,
    spacedName !== name ? spacedName : "",
    description ?? "",
    params,
  ]
    .filter((s) => s.length > 0)
    .join("\n");
}

/**
 * In-memory, lazily-populated embedding index over MCP tool references.
 *
 * One instance is created per graph engine (when an embedder + MCP wrapper are
 * available) and shared across all requests via the execution runtime.
 */
export class McpCapabilityIndex {
  /** ref → embedding vector. */
  private readonly vectors = new Map<string, number[]>();
  /** ref → filtered description (for meta-tool result text). */
  private readonly descriptions = new Map<string, string>();
  /** ref → filtered input schema (so the meta-tool can show call parameters). */
  private readonly schemas = new Map<
    string,
    { type: string; properties: Record<string, unknown>; required?: string[] }
  >();
  /** ref → in-flight embedding promise, so concurrent requests dedupe work. */
  private readonly inflight = new Map<string, Promise<void>>();
  /** refs known to be unembeddable (schema fetch failed) — don't retry every call. */
  private readonly failed = new Set<string>();
  /** All MCP capability vectors, including non-tool context primitives. */
  private readonly capabilityVectors = new Map<string, number[]>();
  private readonly capabilities = new Map<string, Omit<McpCapabilityHit, "score">>();
  private readonly capabilityDiscovery = new Map<string, Promise<void>>();
  private readonly capabilityExpiresAt = new Map<string, number>();

  constructor(
    private readonly embedder: Embedder,
    private readonly mcp: McpWrapperService,
  ) {}

  /**
   * Ensures an embedding exists for every ref in `pool` that can be embedded.
   * Idempotent and concurrency-safe: a ref already embedded, in flight, or
   * known-failed is skipped. Embeds missing refs in parallel.
   */
  async ensure(pool: readonly string[], opts: ToolIndexAuthOptions = {}): Promise<void> {
    const scope = tokenScope(opts.authToken);
    const tasks: Promise<void>[] = [];
    const servers = new Set<string>();
    for (const ref of pool) {
      const { server } = splitRef(ref);
      if (server !== "") servers.add(server);
      const key = scopedKey(scope, ref);
      if (this.vectors.has(key) || this.failed.has(key)) continue;
      let task = this.inflight.get(key);
      if (task === undefined) {
        task = this.embedRef(ref, scope, opts).finally(() => this.inflight.delete(key));
        this.inflight.set(key, task);
      }
      tasks.push(task);
    }
    for (const server of servers) tasks.push(this.ensureServerCapabilities(server, scope, opts));
    if (tasks.length > 0) await Promise.all(tasks);
  }

  private async addCapability(
    capability: Omit<McpCapabilityHit, "score">,
    text: string,
    scope: string,
  ): Promise<void> {
    const key = scopedKey(scope, capability.ref);
    if (this.capabilityVectors.has(key)) return;
    const vector = await this.embedder.embed(text);
    this.capabilityVectors.set(key, vector);
    this.capabilities.set(key, capability);
  }

  private async ensureServerCapabilities(
    server: string,
    scope: string,
    opts: ToolIndexAuthOptions,
  ): Promise<void> {
    const key = scopedKey(scope, server);
    if ((this.capabilityExpiresAt.get(key) ?? 0) > Date.now()) return;
    const pending = this.capabilityDiscovery.get(key);
    if (pending !== undefined) return await pending;
    const task = this.discoverServerCapabilities(server, scope, opts).finally(() =>
      this.capabilityDiscovery.delete(key),
    );
    this.capabilityDiscovery.set(key, task);
    await task;
  }

  private async discoverServerCapabilities(
    server: string,
    scope: string,
    opts: ToolIndexAuthOptions,
  ): Promise<void> {
    let ttlMs = 60_000;
    const additions: Promise<void>[] = [];
    const instructions = this.mcp.getInstructions?.(server);
    if (instructions !== undefined && instructions.trim() !== "") {
      additions.push(
        this.addCapability(
          {
            ref: `${server}#instructions`,
            server,
            kind: "instructions",
            description: instructions,
          },
          `${server} server instructions\n${instructions}`,
          scope,
        ),
      );
    }
    try {
      const result = await this.mcp.listResources?.(server, opts);
      if (result !== undefined) {
        if (result.ttlMs !== undefined) ttlMs = Math.min(ttlMs, result.ttlMs);
        for (const resource of result.resources) {
          const description = resource.description ?? resource.title ?? resource.name;
          additions.push(
            this.addCapability(
              {
                ref: `${server}#resource:${resource.uri}`,
                server,
                kind: "resource",
                ...(description !== undefined ? { description } : {}),
              },
              [
                server,
                "resource",
                resource.uri,
                resource.name,
                resource.title,
                resource.description,
                resource.mimeType,
              ]
                .filter((v): v is string => typeof v === "string")
                .join("\n"),
              scope,
            ),
          );
        }
      }
    } catch {
      /* Optional capability; unsupported servers remain tool-only. */
    }
    try {
      const result = await this.mcp.listResourceTemplates?.(server, opts);
      if (result !== undefined) {
        if (result.ttlMs !== undefined) ttlMs = Math.min(ttlMs, result.ttlMs);
        for (const resource of result.resourceTemplates) {
          const description = resource.description ?? resource.title ?? resource.name;
          additions.push(
            this.addCapability(
              {
                ref: `${server}#resource-template:${resource.uriTemplate}`,
                server,
                kind: "resource-template",
                ...(description !== undefined ? { description } : {}),
              },
              [
                server,
                "resource template",
                resource.uriTemplate,
                resource.name,
                resource.title,
                resource.description,
                resource.mimeType,
              ]
                .filter((v): v is string => typeof v === "string")
                .join("\n"),
              scope,
            ),
          );
        }
      }
    } catch {
      /* Optional capability. */
    }
    try {
      const result = await this.mcp.listPrompts?.(server, opts);
      if (result !== undefined) {
        if (result.ttlMs !== undefined) ttlMs = Math.min(ttlMs, result.ttlMs);
        for (const prompt of result.prompts) {
          const description = prompt.description ?? prompt.title;
          const args = prompt.arguments?.map((arg) => arg.name).join(", ");
          additions.push(
            this.addCapability(
              {
                ref: `${server}#prompt:${prompt.name}`,
                server,
                kind: "prompt",
                ...(description !== undefined ? { description } : {}),
              },
              [server, "prompt", prompt.name, prompt.title, prompt.description, args]
                .filter((v): v is string => typeof v === "string")
                .join("\n"),
              scope,
            ),
          );
        }
      }
    } catch {
      /* Optional capability. */
    }
    await Promise.all(additions);
    this.capabilityExpiresAt.set(scopedKey(scope, server), Date.now() + Math.max(1_000, ttlMs));
  }

  /** Fetches a tool's filtered schema, builds its text, and embeds it. */
  private async embedRef(ref: string, scope: string, opts: ToolIndexAuthOptions): Promise<void> {
    const key = scopedKey(scope, ref);
    const { server, tool } = splitRef(ref);
    try {
      const schema = await this.mcp.getFilteredToolSchema(server, tool, opts);
      const paramNames = Object.keys(schema.inputSchema.properties ?? {});
      const text = toolEmbeddingText(server, schema.name, schema.description, paramNames);
      const embedding = await this.embedder.embed(text);
      this.vectors.set(key, embedding);
      this.capabilityVectors.set(key, embedding);
      this.capabilities.set(key, {
        ref,
        server,
        kind: "tool",
        ...(schema.description !== undefined ? { description: schema.description } : {}),
      });
      this.schemas.set(key, schema.inputSchema);
      if (schema.description !== undefined && schema.description !== "") {
        this.descriptions.set(key, schema.description);
      }
    } catch {
      // Server down / unknown tool — mark failed so we don't retry it every
      // request. It just won't participate in semantic selection.
      this.failed.add(key);
    }
  }

  /** Semantically ranks tools, resources, templates, prompts and instructions together. */
  async selectCapabilities(
    query: string,
    servers: readonly string[],
    opts: {
      topK: number;
      minScore?: number;
      kinds?: readonly McpCapabilityKind[];
      authToken?: string;
    },
  ): Promise<McpCapabilityHit[]> {
    const q = query.trim();
    if (q === "" || servers.length === 0) return [];
    const scope = tokenScope(opts.authToken);
    await Promise.all(
      [...new Set(servers)].map((server) => this.ensureServerCapabilities(server, scope, opts)),
    );
    const queryEmbedding = await this.embedder.embed(q);
    const allowedServers = new Set(servers);
    const allowedKinds = opts.kinds !== undefined ? new Set(opts.kinds) : undefined;
    const hits: McpCapabilityHit[] = [];
    for (const [key, capability] of this.capabilities) {
      if (!key.startsWith(`${scope}\u0000`)) continue;
      if (
        !allowedServers.has(capability.server) ||
        (allowedKinds !== undefined && !allowedKinds.has(capability.kind))
      )
        continue;
      const vector = this.capabilityVectors.get(key);
      if (vector === undefined) continue;
      const score = cosineSimilarity(queryEmbedding, vector);
      if (opts.minScore !== undefined && score < opts.minScore) continue;
      hits.push({ ...capability, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(0, opts.topK));
  }

  /** Returns the cached (filtered) description for a tool ref, if embedded. */
  getDescription(ref: string, opts: ToolIndexAuthOptions = {}): string | undefined {
    return this.descriptions.get(scopedKey(tokenScope(opts.authToken), ref));
  }

  /**
   * Ranks the embeddable refs in `pool` against `query` by cosine similarity,
   * returning the top-`topK` at/above `minScore` (highest first). Refs whose
   * embedding is unavailable are silently omitted. Returns an empty list when
   * the query is blank.
   */
  async select(
    query: string,
    pool: readonly string[],
    opts: { topK: number; minScore?: number; authToken?: string },
  ): Promise<ToolSelectionHit[]> {
    const q = query.trim();
    if (q === "" || pool.length === 0) return [];
    const scope = tokenScope(opts.authToken);
    await this.ensure(pool, opts);
    const queryEmbedding = await this.embedder.embed(q);

    const hits: ToolSelectionHit[] = [];
    const seen = new Set<string>();
    for (const ref of pool) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      const key = scopedKey(scope, ref);
      const vec = this.vectors.get(key);
      if (vec === undefined) continue;
      const score = cosineSimilarity(queryEmbedding, vec);
      if (opts.minScore !== undefined && score < opts.minScore) continue;
      const description = this.descriptions.get(key);
      const inputSchema = this.schemas.get(key);
      hits.push({
        ref,
        score,
        ...(description !== undefined ? { description } : {}),
        ...(inputSchema !== undefined ? { inputSchema } : {}),
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(0, opts.topK));
  }
}

/** Backwards-compatible name for callers that only consume tool hits. */
export { McpCapabilityIndex as ToolIndex };
