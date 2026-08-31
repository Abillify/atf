// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { McpWrapperService } from "../mcp/mcp-wrapper.js";
import type { RequestContext } from "../types/monitoring.js";

export interface ToolContextStage {
  match: string[];
  queryTemplate: string;
  arguments: Record<string, unknown>;
  handleArgument?: string;
  required: boolean;
  appendEvidence: boolean;
  maxResultChars: number;
}

/** Declares which actions must carry a verified evidence pack into governance. */
export interface EvidenceContractConfig {
  match: string[];
  required: boolean;
}

export interface ToolContextConfig {
  server: string;
  tool: string;
  pre?: ToolContextStage;
  post?: ToolContextStage;
  evidenceContract?: EvidenceContractConfig;
}

function stage(value: unknown): ToolContextStage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.queryTemplate !== "string" || raw.queryTemplate.trim() === "") return undefined;
  return {
    match: Array.isArray(raw.match) ? raw.match.filter((item): item is string => typeof item === "string") : ["*"],
    queryTemplate: raw.queryTemplate,
    arguments: raw.arguments !== null && typeof raw.arguments === "object" && !Array.isArray(raw.arguments)
      ? raw.arguments as Record<string, unknown>
      : {},
    ...(typeof raw.handleArgument === "string" && raw.handleArgument !== "" ? { handleArgument: raw.handleArgument } : {}),
    required: raw.required === true,
    appendEvidence: raw.appendEvidence !== false,
    maxResultChars: typeof raw.maxResultChars === "number" && Number.isFinite(raw.maxResultChars)
      ? Math.max(256, Math.floor(raw.maxResultChars))
      : 8_000,
  };
}

function evidenceContract(value: unknown): EvidenceContractConfig | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    match: Array.isArray(raw.match)
      ? raw.match.filter((item): item is string => typeof item === "string")
      : ["*"],
    required: raw.required === true,
  };
}

export function parseToolContextConfig(config: Record<string, unknown> | undefined): ToolContextConfig | undefined {
  const value = config?.toolContext;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const server = typeof raw.server === "string" && raw.server !== "" ? raw.server : "vectorsearch";
  const tool = typeof raw.tool === "string" && raw.tool !== "" ? raw.tool : "retrieve_evidence";
  const pre = stage(raw.pre);
  const post = stage(raw.post);
  const contract = evidenceContract(raw.evidenceContract);
  if (pre === undefined && post === undefined && contract === undefined) return undefined;
  return {
    server,
    tool,
    ...(pre !== undefined ? { pre } : {}),
    ...(post !== undefined ? { post } : {}),
    ...(contract !== undefined ? { evidenceContract: contract } : {}),
  };
}

function matches(pattern: string, toolRef: string): boolean {
  if (pattern === "*" || pattern === toolRef) return true;
  const slash = toolRef.indexOf("/");
  const server = slash >= 0 ? toolRef.slice(0, slash) : "";
  const bare = slash >= 0 ? toolRef.slice(slash + 1) : toolRef;
  return pattern === bare || pattern === `${server}/*`;
}

export function matchesToolContext(match: string[], toolRef: string): boolean {
  return match.some((pattern) => matches(pattern, toolRef));
}

function render(template: string, toolRef: string, args: Record<string, unknown>, result?: unknown, maxResultChars = 8_000): string {
  const argsJson = JSON.stringify(args);
  const resultJson = result === undefined ? "" : JSON.stringify(result).slice(0, maxResultChars);
  return template
    .replaceAll("{{tool}}", toolRef)
    .replaceAll("{{args}}", argsJson)
    .replaceAll("{{result}}", resultJson);
}

function parseJsonStrings(value: unknown): unknown[] {
  const candidates: unknown[] = [value];
  if (typeof value === "string") {
    try { candidates.push(JSON.parse(value) as unknown); } catch { /* Non-JSON text is still valid evidence. */ }
  }
  if (Array.isArray(value)) {
    for (const part of value) {
      if (part !== null && typeof part === "object" && "text" in part) {
        candidates.push(...parseJsonStrings((part as { text?: unknown }).text));
      }
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (object.structuredContent !== undefined) candidates.push(object.structuredContent);
    if (object.content !== undefined) candidates.push(...parseJsonStrings(object.content));
  }
  return candidates;
}

export function extractEvidenceHandle(value: unknown): string | undefined {
  const queue = parseJsonStrings(value);
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) { queue.push(...current); continue; }
    const object = current as Record<string, unknown>;
    for (const key of ["evidenceHandle", "evidence_handle", "handle"]) {
      if (typeof object[key] === "string" && object[key] !== "") return object[key];
    }
    queue.push(...Object.values(object));
  }
  return undefined;
}

async function retrieve(
  mcp: McpWrapperService,
  config: ToolContextConfig,
  stageConfig: ToolContextStage,
  toolRef: string,
  args: Record<string, unknown>,
  ctx: RequestContext,
  signal: AbortSignal | undefined,
  result?: unknown,
): Promise<unknown> {
  return (await mcp.callTool(
    config.server,
    config.tool,
    {
      ...stageConfig.arguments,
      query: render(stageConfig.queryTemplate, toolRef, args, result, stageConfig.maxResultChars),
    },
    ctx,
    signal !== undefined ? { signal } : undefined,
  )).content;
}

export async function enrichToolArguments(
  mcp: McpWrapperService,
  config: ToolContextConfig | undefined,
  toolRef: string,
  args: Record<string, unknown>,
  ctx: RequestContext,
  signal?: AbortSignal,
): Promise<{ args: Record<string, unknown>; evidence?: unknown }> {
  const pre = config?.pre;
  if (config === undefined || pre === undefined || !pre.match.some((pattern) => matches(pattern, toolRef)) || toolRef === `${config.server}/${config.tool}`) return { args };
  try {
    const evidence = await retrieve(mcp, config, pre, toolRef, args, ctx, signal);
    const handle = extractEvidenceHandle(evidence);
    if (pre.handleArgument !== undefined && handle === undefined && pre.required) throw new Error("VectorSearch returned no evidence handle");
    return {
      args: pre.handleArgument !== undefined && handle !== undefined ? { ...args, [pre.handleArgument]: handle } : args,
      evidence,
    };
  } catch (error) {
    if (pre.required) throw error;
    return { args };
  }
}

export async function groundToolResult(
  mcp: McpWrapperService,
  config: ToolContextConfig | undefined,
  toolRef: string,
  args: Record<string, unknown>,
  result: unknown,
  ctx: RequestContext,
  signal?: AbortSignal,
): Promise<unknown> {
  const post = config?.post;
  if (config === undefined || post === undefined || !post.match.some((pattern) => matches(pattern, toolRef)) || toolRef === `${config.server}/${config.tool}`) return result;
  try {
    const evidence = await retrieve(mcp, config, post, toolRef, args, ctx, signal, result);
    if (!post.appendEvidence) return result;
    return { result, evidence, evidenceHandle: extractEvidenceHandle(evidence) };
  } catch (error) {
    if (post.required) throw error;
    return result;
  }
}
