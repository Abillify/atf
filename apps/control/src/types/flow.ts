// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow definition types mirrored from the backend (src/types/flow.ts) plus the
 * `/flows` API response shapes used by the editor.
 */

export type NodeType =
  | "llm"
  | "tool"
  | "router"
  | "classifier"
  | "parallel"
  | "retrieval"
  | "memory";
export type Provider =
  | "openai"
  | "google"
  | "ollama"
  | "azure"
  | "bedrock"
  | "anthropic";

export interface LlmConfig {
  provider: Provider;
  model: string;
  parameters?: {
    temperature?: number;
    maxTokens?: number;
    [k: string]: unknown;
  };
}

export interface FlowNode {
  id: string;
  type: NodeType;
  label?: string;
  llm?: LlmConfig;
  tools?: string[];
  systemPrompt?: string;
  config?: Record<string, unknown>;
  classifierSchema?: { schema: Record<string, unknown>; classKey: string };
  parallelNodes?: ParallelNodeEntry[];
  overrides?: unknown[];
}

/** A `parallelNodes` entry: a plain child node ID or a conditional child. */
export type ParallelNodeEntry = string | { node: string; condition?: string };

/** Extracts the child node ID from a `parallelNodes` entry. */
export function parallelChildId(entry: ParallelNodeEntry): string {
  return typeof entry === "string" ? entry : entry.node;
}

export interface FlowEdge {
  id?: string;
  source: string;
  target: string;
  conditions?: string;
  label?: string;
}

export interface FlowDefinition {
  id: string;
  name: string;
  description?: string;
  /**
   * Flow-scoped variables (name → value). Node/edge strings may reference them
   * via `{{vars.<name>}}`. The backend resolves these at execution time; the
   * stored definition served by the API keeps the placeholders intact, so the
   * monitoring view resolves them against this map for display.
   */
  variables?: Record<string, unknown>;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /**
   * Arbitrary metadata attached to the flow.
   * The optional `ui` key carries canvas layout data used by the visual editor
   * (see `FlowUiMetadata`). Additive and semantically neutral.
   */
  metadata?: Record<string, unknown> & {
    ui?: FlowUiMetadata["ui"];
  };
}

/** Pattern for `{{vars.<dotted.name>}}` references, mirrors the backend parser. */
const VAR_REF_RE = /\{\{\s*vars\.([\w.-]+)\s*\}\}/g;

/**
 * Resolves `{{vars.<name>}}` references embedded in a string against a flow's
 * `variables` map. Dotted names index into object-valued variables; object
 * values are JSON-stringified. Unknown references are left untouched so an
 * unresolved placeholder stays visible rather than silently vanishing.
 *
 * This mirrors the backend's interpolation (src/graph/flow-parser.ts) for the
 * display-only case where the frontend has the unresolved definition plus its
 * declared variable defaults.
 */
export function resolveVarsInString(
  text: string,
  variables: Record<string, unknown> | undefined,
): string {
  if (variables === undefined) return text;
  return text.replace(VAR_REF_RE, (match, name: string) => {
    const segments = name.split(".");
    let cur: unknown = variables;
    for (const seg of segments) {
      if (cur === null || cur === undefined || typeof cur !== "object") {
        return match;
      }
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (cur === undefined) return match;
    return typeof cur === "object" && cur !== null
      ? JSON.stringify(cur)
      : String(cur);
  });
}

// ---- API shapes -----------------------------------------------------------

export interface FlowListEntry {
  id: string;
  name: string;
  source: "file" | "online";
  shadowsFile?: boolean;
  status: "published" | "draft" | "file";
  version: number;
  hasDraft: boolean;
  draftDirty: boolean;
  editable: boolean;
  nodeCount: number;
  edgeCount: number;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface FlowValidationReport {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  meta: { nodeCount: number; edgeCount: number; flowId?: string };
}

export interface FlowDetail {
  id: string;
  source: "file" | "online";
  editable: boolean;
  version: number;
  published: FlowDefinition | null;
  draft: FlowDefinition | null;
  updatedAt?: string;
  updatedBy?: string | null;
}

export interface FlowVersionEntry {
  flowId: string;
  version: number;
  definition: FlowDefinition;
  publishedAt: string;
  publishedBy: string | null;
}

export interface FieldChange<T = unknown> {
  field: string;
  from: T;
  to: T;
}

export interface NodeChange {
  id: string;
  changedFields: string[];
}

export interface EdgeChange {
  key: string;
  changedFields: string[];
}

export interface FlowDiff {
  changed: boolean;
  name?: FieldChange<string>;
  description?: FieldChange<string | undefined>;
  metadataChanged: boolean;
  nodes: { added: string[]; removed: string[]; changed: NodeChange[] };
  edges: { added: string[]; removed: string[]; changed: EdgeChange[] };
  summary: string;
}

export interface FlowDiffResponse {
  from: { kind: string; version?: number };
  to: { kind: string; version?: number };
  diff: FlowDiff;
}

/** Position map persisted in metadata.layout so the canvas round-trips. */
export type LayoutMap = Record<string, { x: number; y: number }>;

/**
 * Per-node canvas layout entry stored in `metadata.ui.layout`.
 * Additive and semantically neutral — never affects flow execution.
 */
export interface UiNodeLayout {
  /** Node ID this layout entry refers to. */
  id: string;
  /** Horizontal canvas position in pixels. */
  x: number;
  /** Vertical canvas position in pixels. */
  y: number;
}

/**
 * Flow-level UI metadata stored additively in `FlowDefinition.metadata.ui`.
 * Used exclusively by the visual editor; ignored by the graph engine.
 */
export interface FlowUiMetadata {
  ui?: {
    /** Canvas position for each node. */
    layout: UiNodeLayout[];
    /** Saved viewport (pan + zoom) of the editor canvas. */
    viewport?: { x: number; y: number; zoom: number };
  };
}
