"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Node type catalog client (`src/lib/node-types.ts`) — mirrors the runtime's
 * `src/graph/node-type-catalog.ts`, served by `GET /flows/node-types`. Drives
 * the per-type settings forms and the documentation panel in the Studio.
 */

import { useEffect, useState } from "react";
import { useAuth } from "./auth/useAuth";
import { backendUrl } from "./backend-url";

export type ConfigFieldKind =
  | "boolean"
  | "number"
  | "string"
  | "text"
  | "enum"
  | "string-list"
  | "tool-list"
  | "node-ref"
  | "node-list"
  | "condition"
  | "llm"
  | "object"
  | "json";

export interface ConfigField {
  key: string;
  kind: ConfigFieldKind;
  label: string;
  description: string;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  options?: string[];
  fields?: ConfigField[];
  required?: boolean;
  example?: unknown;
  advanced?: boolean;
}

export interface TopLevelField {
  key: string;
  usage: "required" | "recommended" | "optional" | "ignored";
  description: string;
}

export interface NodeTypeDoc {
  type: string;
  title: string;
  summary: string;
  description: string;
  whenToUse: string[];
  topLevel: TopLevelField[];
  config: ConfigField[];
  examples: Array<{ title: string; yaml: string }>;
  notes: string[];
}

/** A `{{path}}` placeholder or condition identifier (runtime flow-reference-data.ts). */
export interface ReferenceSymbol {
  path: string;
  description: string;
  example?: unknown;
}

export interface ReferenceGroup {
  title: string;
  /** Where a placeholder renders: system prompts and/or tool arguments. */
  scopes: Array<"prompt" | "tool">;
  symbols: ReferenceSymbol[];
}

export interface ReferenceOperator {
  text: string;
  label: string;
  description: string;
}

/**
 * Flow authoring reference served with the catalog — the same data
 * docs/FLOWS.md is generated from (runtime `flow-reference-data.ts`).
 */
export interface FlowReference {
  placeholders: ReferenceGroup[];
  conditionFields: ReferenceGroup[];
  conditionOperators: ReferenceOperator[];
  calculationOperators: ReferenceOperator[];
  calculationFunctions: ReferenceOperator[];
}

export interface NodeTypeCatalog {
  common: ConfigField[];
  types: NodeTypeDoc[];
  /** Tool ids of the MCP servers the runtime is connected to. */
  tools: string[];
  /** Model shortcut names from flows/model-shortcuts.yaml. */
  shortcuts: string[];
  /** Shortcut name → "provider · model" / "pool (strategy): …". */
  shortcutInfo?: Record<string, string>;
  /** Concrete model ids of the central model presets. */
  models?: string[];
  /** Global constants from flows/constants.yaml (`{{const.name}}`). */
  constants?: Record<string, unknown>;
  /** Allowlisted `FLOW_PUBLIC_*` environment values (`{{env.NAME}}`). */
  publicEnv?: Record<string, string>;
  /** Placeholders, condition grammar and calculation functions. */
  reference?: FlowReference;
}

async function fetchCatalog(token: string | undefined): Promise<NodeTypeCatalog> {
  const resp = await fetch(backendUrl("/flows/node-types"), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = (await resp.json()) as Partial<NodeTypeCatalog>;
  // Anything but the expected shape (older runtime, proxy error page) means
  // "no catalog" — the forms then fall back to JSON.
  if (!Array.isArray(data.types) || !Array.isArray(data.common)) {
    throw new Error("unexpected node type catalog response");
  }
  return {
    types: data.types,
    common: data.common,
    tools: Array.isArray(data.tools) ? data.tools : [],
    shortcuts: Array.isArray(data.shortcuts) ? data.shortcuts : [],
    ...(data.shortcutInfo && typeof data.shortcutInfo === "object"
      ? { shortcutInfo: data.shortcutInfo }
      : {}),
    ...(Array.isArray(data.models) ? { models: data.models } : {}),
    ...(data.constants && typeof data.constants === "object"
      ? { constants: data.constants }
      : {}),
    ...(data.publicEnv && typeof data.publicEnv === "object"
      ? { publicEnv: data.publicEnv }
      : {}),
    ...(data.reference && typeof data.reference === "object"
      ? { reference: data.reference }
      : {}),
  };
}

// Module-level cache: the catalog only changes with a runtime deploy, and a
// plain promise keeps the hook usable without a QueryClient (tests, embeds).
let cached: NodeTypeCatalog | undefined;
let inflight: Promise<NodeTypeCatalog> | undefined;

/** Test hook: seed or clear the cache. */
export function setNodeTypeCatalogForTests(value: NodeTypeCatalog | undefined): void {
  cached = value;
  inflight = undefined;
}

/** The catalog, fetched once per page load. Undefined while loading/unavailable. */
export function useNodeTypeCatalog(): NodeTypeCatalog | undefined {
  const { token, ready, isAuthenticated } = useAuth();
  const [catalog, setCatalog] = useState<NodeTypeCatalog | undefined>(cached);
  useEffect(() => {
    if (cached) {
      setCatalog(cached);
      return;
    }
    if (!ready || !isAuthenticated) return;
    let alive = true;
    inflight ??= fetchCatalog(token).then(
      (c) => (cached = c),
      (err) => {
        inflight = undefined; // allow a retry on the next mount
        throw err;
      },
    );
    inflight.then(
      (c) => alive && setCatalog(c),
      () => {
        /* older runtime without the endpoint: forms fall back to JSON */
      },
    );
    return () => {
      alive = false;
    };
  }, [token, ready, isAuthenticated]);
  return catalog;
}

/** "What happens when unset" as display text. */
export function formatDefault(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}
