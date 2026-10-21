// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Pure helpers for the flows management routes (Phase 18.4 split of
 * flows.ts, Req. 13.6). No request state: every function takes its inputs
 * explicitly so the route modules can share them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { mergeFlowIntoYaml } from "../graph/flow-yaml-merge.js";
import { includeEdgeKey } from "../graph/flow-parser/normalize.js";
import type { FlowDefinition } from "../types/flow.js";
import type { CopilotFocus } from "../graph/flow-copilot.js";


// ---------------------------------------------------------------------------
// Flow write request (Req. 22, §3.3)
// ---------------------------------------------------------------------------

/** Request body for POST/PUT /flows/write. */
export interface FlowWriteRequest {
  /** Flow filename without extension and without path traversal. */
  id: string;
  /** Serialization format of the written file. */
  format: "yaml" | "json";
  /** Raw flow definition — validated server-side before writing. */
  definition: unknown;
  /** SHA-256 hex hash of the current file content for conflict detection (Req. 14.6). */
  baseHash?: string;
}

/** Compute the SHA-256 hex digest of a UTF-8 string. */
/** A `{ start, end }` character range from a request body. */
export function isSelection(v: unknown): v is { start: number; end: number } {
  if (v === null || typeof v !== "object") return false;
  const { start, end } = v as { start?: unknown; end?: unknown };
  return Number.isInteger(start) && Number.isInteger(end) && (start as number) >= 0 && (end as number) >= 0;
}

/** The Studio selection sent with a flow copilot request (`focus`), sanitised. */
export function parseCopilotFocus(v: unknown): CopilotFocus | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const f = v as { nodeIds?: unknown; edge?: unknown; field?: unknown; fieldSelection?: unknown };
  const nodeIds = Array.isArray(f.nodeIds)
    ? f.nodeIds.filter((id): id is string => typeof id === "string").slice(0, 50)
    : [];
  const e = f.edge as { source?: unknown; target?: unknown } | null | undefined;
  const edge =
    e && typeof e.source === "string" && typeof e.target === "string"
      ? { source: e.source, target: e.target }
      : undefined;
  const field = typeof f.field === "string" && f.field !== "" ? f.field.slice(0, 200) : undefined;
  const fieldSelection =
    typeof f.fieldSelection === "string" && f.fieldSelection !== "" ? f.fieldSelection.slice(0, 2000) : undefined;
  if (nodeIds.length === 0 && edge === undefined) return undefined;
  return {
    nodeIds,
    ...(edge !== undefined ? { edge } : {}),
    ...(field !== undefined ? { field } : {}),
    ...(fieldSelection !== undefined ? { fieldSelection } : {}),
  };
}

export function sha256Hex(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Resolves the absolute, canonical target path for writing a flow file and
 * verifies it is strictly inside `flowsDir`.
 *
 * Req. 22.2: no `..` segments, realpath prefix check.
 *
 * @returns The safe absolute target path.
 * @throws  `Error` with `code === "PATH_TRAVERSAL"` when the resolved path
 *          escapes `flowsDir`.
 */
export function resolveFlowWritePath(
  flowsDir: string,
  id: string,
  format: "yaml" | "json",
): string {
  // Reject explicit traversal sequences in the id before any resolution.
  if (
    id.includes("..") ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0")
  ) {
    const err = new Error(
      `Illegal flow id: "${id}" contains forbidden characters.`,
    );
    (err as NodeJS.ErrnoException).code = "PATH_TRAVERSAL";
    throw err;
  }

  // Resolve the flows directory to its realpath (follows symlinks).
  // If flowsDir does not exist yet we fall back to its absolute path so the
  // caller can create it; the prefix check still applies.
  let canonicalDir: string;
  try {
    canonicalDir = fs.realpathSync(flowsDir);
  } catch {
    canonicalDir = path.resolve(flowsDir);
  }

  const ext = format === "yaml" ? ".yaml" : ".json";
  const target = path.resolve(canonicalDir, `${id}${ext}`);

  // Ensure the resolved target stays inside the flows directory.
  if (!target.startsWith(canonicalDir + path.sep) && target !== canonicalDir) {
    const err = new Error(
      `Resolved path "${target}" escapes the flows directory "${canonicalDir}".`,
    );
    (err as NodeJS.ErrnoException).code = "PATH_TRAVERSAL";
    throw err;
  }

  return target;
}

/**
 * Resolves a sub-flow include path (e.g. "subflows/guard.yaml", from
 * `metadata.$includeOrigins` — see `flow-parser/normalize.ts`) to an
 * absolute path strictly inside `flowsDir`, rejecting traversal.
 *
 * Unlike {@link resolveFlowWritePath} (used for the top-level flow id), an
 * include path already carries its own extension and is EXPECTED to contain
 * subdirectory segments (that's the point of organizing sub-flows under
 * `subflows/`) — so only `..` traversal, null bytes, and absolute paths are
 * rejected, not `/` itself.
 *
 * @throws `Error` with `code === "PATH_TRAVERSAL"` when the resolved path
 *         escapes `flowsDir`.
 */
export function resolveIncludeWritePath(flowsDir: string, relPath: string): string {
  if (
    relPath.includes("..") ||
    relPath.includes("\0") ||
    path.isAbsolute(relPath)
  ) {
    const err = new Error(
      `Illegal sub-flow include path: "${relPath}" contains forbidden segments.`,
    );
    (err as NodeJS.ErrnoException).code = "PATH_TRAVERSAL";
    throw err;
  }

  let canonicalDir: string;
  try {
    canonicalDir = fs.realpathSync(flowsDir);
  } catch {
    canonicalDir = path.resolve(flowsDir);
  }

  const target = path.resolve(canonicalDir, relPath);
  if (!target.startsWith(canonicalDir + path.sep) && target !== canonicalDir) {
    const err = new Error(
      `Resolved path "${target}" escapes the flows directory "${canonicalDir}".`,
    );
    (err as NodeJS.ErrnoException).code = "PATH_TRAVERSAL";
    throw err;
  }

  return target;
}

/**
 * A prompt include path as it may appear in `#[[file:...]]` and be edited via
 * `/flows/prompts/*`: strictly inside `prompts/`, a Markdown/text file, no
 * traversal. Sub-directories under `prompts/` are allowed (flows organise
 * prompts per route), the `..` check below is what keeps that safe.
 */
export const PROMPT_FILE_RE = /^prompts\/(?:[\w.-]+\/)*[\w.-]+\.(?:md|markdown|txt)$/i;

/** Human-readable reason a prompt path was rejected, or null when it is fine. */
export function promptPathProblem(relPath: string): string | null {
  if (relPath.length === 0) return "Field 'path' is required.";
  if (relPath.length > 512) return "Field 'path' is too long.";
  if (relPath.includes("..") || relPath.includes("\0") || path.isAbsolute(relPath)) {
    return `Illegal prompt path: "${relPath}" contains forbidden segments.`;
  }
  if (!PROMPT_FILE_RE.test(relPath)) {
    return "Field 'path' must name a Markdown file under prompts/ (e.g. prompts/researcher.md).";
  }
  return null;
}

/**
 * Resolves a prompt include path (`prompts/x.md`) to an absolute path strictly
 * inside `baseDir`. Same realpath prefix check as
 * {@link resolveIncludeWritePath}; the caller is expected to have run
 * {@link promptPathProblem} first, which is what pins the file to `prompts/`.
 *
 * @throws `Error` with `code === "PATH_TRAVERSAL"` when the resolved path
 *         escapes `baseDir`.
 */
export function resolvePromptFilePath(baseDir: string, relPath: string): string {
  return resolveIncludeWritePath(baseDir, relPath);
}

/**
 * Reads `metadata.$includeOrigins` (`nodeId -> relPath`) off a raw, already
 * schema-validated flow definition. Returns `undefined` when absent/empty —
 * the common case for the overwhelming majority of flows that don't use
 * `$include.subflows` at all, which keeps `/flows/write` a no-op passthrough
 * for them (see `splitByIncludeOrigin` below).
 */
export function parseIncludeOrigins(definition: FlowDefinition): Record<string, string> | undefined {
  const raw = (definition.metadata as Record<string, unknown> | undefined)?.$includeOrigins;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [nodeId, relPath] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof relPath === "string" && relPath.trim().length > 0) {
      result[nodeId] = relPath.trim();
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Reads `metadata.$includeEdgeOrigins` (edge key -> relPath) off a source-form definition. */
export function parseIncludeEdgeOrigins(
  definition: FlowDefinition,
): Record<string, string> | undefined {
  const raw = (definition.metadata as Record<string, unknown> | undefined)?.[
    "$includeEdgeOrigins"
  ];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === "string" && e[1].trim().length > 0,
    ),
  );
}

/** Serializes a bare `{nodes, edges}` sub-flow fragment per its file extension. */
export function serializeSubflowFragment(
  ext: string,
  fragment: { nodes: FlowDefinition["nodes"]; edges: FlowDefinition["edges"] },
): string {
  return ext === ".yaml" || ext === ".yml"
    ? stringifyYaml(fragment, { lineWidth: 120 })
    : `${JSON.stringify(fragment, null, 2)}\n`;
}

/**
 * Splits an `$include`-composed flow definition back into its sub-flow
 * file(s) plus a parent-only definition, writing each sub-flow file directly
 * (atomically, path-traversal-checked) and returning the parent definition
 * for the caller to write via the normal path.
 *
 * This is what lets the Studio builder round-trip a flow composed via
 * `metadata.$include.subflows` without flattening the sub-flow's nodes back
 * into the parent file on every save — see `flow-parser/normalize.ts` for
 * how `$includeOrigins` is produced on load. A cross-boundary edge (only one
 * endpoint tagged, or endpoints tagged with different origins) stays with
 * the parent — after the files are re-merged on next load it still resolves
 * correctly either way.
 */
export async function splitByIncludeOrigin(
  definition: FlowDefinition,
  origins: Record<string, string>,
  flowsDir: string,
  options: {
    /** `metadata.$includeEdgeOrigins` of a source-form definition. */
    edgeOrigins?: Record<string, string>;
    /** The parent file as currently on disk (parsed), if any. */
    existingParent?: Record<string, unknown>;
  } = {},
): Promise<FlowDefinition> {
  const originOf = (nodeId: string): string | undefined => origins[nodeId];
  const edgeOrigins = options.edgeOrigins ?? {};

  const byOrigin = new Map<
    string,
    { nodes: FlowDefinition["nodes"]; edges: FlowDefinition["edges"] }
  >();
  const bucketFor = (origin: string) => {
    const bucket = byOrigin.get(origin) ?? { nodes: [], edges: [] };
    byOrigin.set(origin, bucket);
    return bucket;
  };
  const parentNodes: FlowDefinition["nodes"] = [];
  for (const node of definition.nodes) {
    const origin = originOf(node.id);
    if (origin === undefined) {
      parentNodes.push(node);
      continue;
    }
    bucketFor(origin).nodes.push(node);
  }

  const parentEdges: FlowDefinition["edges"] = [];
  for (const edge of definition.edges) {
    // An edge loaded from a sub-flow goes back to that file even when it links
    // nodes of two different sub-flows; otherwise fall back to "both endpoints
    // share an origin", and everything else stays with the parent.
    const key = includeEdgeKey(edge);
    const recorded = key !== undefined ? edgeOrigins[key] : undefined;
    const sourceOrigin = originOf(edge.source);
    const targetOrigin = originOf(edge.target);
    const origin =
      recorded ??
      (sourceOrigin !== undefined && sourceOrigin === targetOrigin
        ? sourceOrigin
        : undefined);
    if (origin !== undefined) {
      bucketFor(origin).edges.push(edge);
    } else {
      parentEdges.push(edge);
    }
  }

  for (const [relPath, fragment] of byOrigin) {
    const targetPath = resolveIncludeWritePath(flowsDir, relPath);
    const ext = path.extname(targetPath).toLowerCase();
    let existing: string | null = null;
    try {
      existing = await fs.promises.readFile(targetPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    let content: string;
    if (existing !== null && (ext === ".yaml" || ext === ".yml")) {
      // Same comment-preserving merge as the parent file; other top-level keys
      // of the sub-flow file (description, notes, …) are kept as they are, and
      // an `edges` key the file never had isn't invented.
      try {
        const current = parseYaml(existing) as Record<string, unknown> | null;
        const base =
          current !== null && typeof current === "object" && !Array.isArray(current)
            ? current
            : {};
        const next: Record<string, unknown> = { ...base, nodes: fragment.nodes };
        if (fragment.edges.length > 0 || "edges" in base) next.edges = fragment.edges;
        else delete next.edges;
        content = mergeFlowIntoYaml(existing, next, { lineWidth: 120 });
      } catch {
        content = serializeSubflowFragment(ext, fragment);
      }
    } else {
      content = serializeSubflowFragment(ext, fragment);
    }
    await atomicWriteFile(targetPath, content);
  }

  const {
    $includeOrigins: _omit,
    $includeEdgeOrigins: _omitEdges,
    $subflowVersions: _omitVersions,
    $includePatches: _omitPatches,
    ...restMetadata
  } = (definition.metadata ?? {}) as Record<string, unknown>;
  void _omit;
  void _omitEdges;
  void _omitVersions;
  // The patches live on in the parent's own `$include` directive (kept below).
  void _omitPatches;

  // Keep the parent's existing `$include` directive (its other keys such as a
  // `_comment`, and its order — the merge order matters) and only reconcile
  // the list of files with what is still in use.
  const existingMeta = options.existingParent?.["metadata"];
  const existingInclude =
    typeof existingMeta === "object" && existingMeta !== null
      ? ((existingMeta as Record<string, unknown>)["$include"] as
          | Record<string, unknown>
          | undefined)
      : undefined;
  const inUse = [...byOrigin.keys()];
  const previous = Array.isArray(existingInclude?.["subflows"])
    ? (existingInclude["subflows"] as unknown[]).filter(
        (p): p is string => typeof p === "string",
      )
    : [];
  const subflowPaths = [
    ...previous.filter((p) => inUse.includes(p.trim())),
    ...inUse.filter((p) => !previous.some((q) => q.trim() === p)),
  ];

  const parent: Record<string, unknown> = {
    ...definition,
    nodes: parentNodes,
    edges: parentEdges,
    metadata: {
      ...restMetadata,
      ...(subflowPaths.length > 0
        ? { $include: { ...(existingInclude ?? {}), subflows: subflowPaths } }
        : {}),
    },
  };
  // A parent that only assembles sub-flows has no nodes/edges keys of its own;
  // don't add empty ones.
  for (const key of ["nodes", "edges"] as const) {
    if (
      (parent[key] as unknown[]).length === 0 &&
      options.existingParent !== undefined &&
      !(key in options.existingParent)
    ) {
      delete parent[key];
    }
  }
  return parent as unknown as FlowDefinition;
}

/**
 * Atomically writes `content` to `targetPath` by first writing to a temp file
 * in the same directory, then renaming it into place.
 *
 * Req. 22.4: no partial file left on failure — temp file is cleaned up on error.
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(targetPath);
  // Use the OS temp dir as a first choice — but rename is only atomic when
  // source and target are on the same filesystem, so we write into the same
  // target directory instead.
  const tmpPath = path.join(
    dir,
    `.tmp-${crypto.randomBytes(8).toString("hex")}`,
  );
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(tmpPath, content, "utf-8");
    await fs.promises.rename(tmpPath, targetPath);
  } catch (err) {
    // Clean up the temp file so no partial content is left on disk.
    await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

export interface FlowListEntry {
  id: string;
  name: string;
  /** Where the live definition comes from. */
  source: "file" | "online";
  /** True when an online flow shadows a same-id file flow. */
  shadowsFile?: boolean;
  status: "published" | "draft" | "file";
  version: number;
  hasDraft: boolean;
  draftDirty: boolean;
  /** How many drafts (default + named) the flow has. */
  draftCount: number;
  /**
   * The flow's drafts (default first) with their display labels, so selectors
   * (e.g. the /flow-diff dropdowns) can offer each draft without a request
   * per flow. Absent for file-only flows (they hold no drafts).
   */
  drafts?: { draftId: string; label: string }[];
  editable: boolean;
  nodeCount: number;
  edgeCount: number;
}
