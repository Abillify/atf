// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { McpServerConfig } from "../../config/index.js";
import type { RawTool } from "./schema.js";

export const MCP_2026_PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_META_KEY = "io.modelcontextprotocol/protocolVersion";

type JsonObject = Record<string, unknown>;
interface RpcResponse { result?: JsonObject; error?: { code?: number; message?: string; data?: unknown } }

export interface McpCacheMetadata {
  ttlMs?: number;
  cacheScope?: "public" | "private";
}

export interface McpResourceDescriptor {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceTemplateDescriptor {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptDescriptor {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpTaskHandle {
  taskId: string;
  state?: string;
  statusMessage?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
}

export interface McpTaskStatus {
  task: McpTaskHandle;
  result?: JsonObject;
}

/** Minimal SDK-compatible surface used by McpWrapper for native stateless MCP 2026. */
export class Stateless2026Client {
  private requestId = 0;
  private instructions: string | undefined;

  constructor(
    private readonly config: McpServerConfig,
    private readonly authToken?: string,
  ) {}

  async connect(): Promise<void> {
    const discovered = await this.request("server/discover", {});
    this.instructions = typeof discovered.instructions === "string" ? discovered.instructions : undefined;
  }

  getInstructions(): string | undefined { return this.instructions; }
  async close(): Promise<void> {}

  async listTools(params: { cursor?: string } = {}): Promise<{ tools: RawTool[]; nextCursor?: string } & McpCacheMetadata> {
    const result = await this.request("tools/list", params);
    if (!Array.isArray(result.tools)) throw new Error("MCP 2026 tools/list returned no tools array");
    const tools = result.tools.filter(isRawTool);
    if (tools.length !== result.tools.length) throw new Error("MCP 2026 tools/list returned an invalid tool schema");
    return {
      tools,
      ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
      ...cacheMetadata(result),
    };
  }

  async listResources(params: { cursor?: string } = {}): Promise<{ resources: McpResourceDescriptor[]; nextCursor?: string } & McpCacheMetadata> {
    const result = await this.request("resources/list", params);
    if (!Array.isArray(result.resources)) throw new Error("MCP 2026 resources/list returned no resources array");
    const resources = result.resources.filter(isResourceDescriptor);
    if (resources.length !== result.resources.length) throw new Error("MCP 2026 resources/list returned an invalid resource descriptor");
    return { resources, ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}), ...cacheMetadata(result) };
  }

  async listResourceTemplates(params: { cursor?: string } = {}): Promise<{ resourceTemplates: McpResourceTemplateDescriptor[]; nextCursor?: string } & McpCacheMetadata> {
    const result = await this.request("resources/templates/list", params);
    if (!Array.isArray(result.resourceTemplates)) throw new Error("MCP 2026 resources/templates/list returned no resourceTemplates array");
    const resourceTemplates = result.resourceTemplates.filter(isResourceTemplateDescriptor);
    if (resourceTemplates.length !== result.resourceTemplates.length) throw new Error("MCP 2026 resources/templates/list returned an invalid template descriptor");
    return { resourceTemplates, ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}), ...cacheMetadata(result) };
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<{ contents: unknown[] } & McpCacheMetadata> {
    const result = await this.request("resources/read", { uri }, signal, uri);
    if (!Array.isArray(result.contents)) throw new Error("MCP 2026 resources/read returned no contents array");
    return { contents: result.contents, ...cacheMetadata(result) };
  }

  async listPrompts(params: { cursor?: string } = {}): Promise<{ prompts: McpPromptDescriptor[]; nextCursor?: string } & McpCacheMetadata> {
    const result = await this.request("prompts/list", params);
    if (!Array.isArray(result.prompts)) throw new Error("MCP 2026 prompts/list returned no prompts array");
    const prompts = result.prompts.filter(isPromptDescriptor);
    if (prompts.length !== result.prompts.length) throw new Error("MCP 2026 prompts/list returned an invalid prompt descriptor");
    return { prompts, ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}), ...cacheMetadata(result) };
  }

  async getPrompt(name: string, args: JsonObject = {}, signal?: AbortSignal): Promise<{ description?: string; messages: unknown[] }> {
    const result = await this.request("prompts/get", { name, arguments: args }, signal, name);
    if (!Array.isArray(result.messages)) throw new Error("MCP 2026 prompts/get returned no messages array");
    return { ...(typeof result.description === "string" ? { description: result.description } : {}), messages: result.messages };
  }

  async getTask(taskId: string, signal?: AbortSignal): Promise<McpTaskStatus> {
    const result = await this.request("io.modelcontextprotocol/tasks/get", { taskId }, signal, taskId);
    return parseTaskStatus(result, taskId);
  }

  async updateTask(taskId: string, input: JsonObject, signal?: AbortSignal): Promise<McpTaskStatus> {
    const result = await this.request("io.modelcontextprotocol/tasks/update", { taskId, input }, signal, taskId);
    return parseTaskStatus(result, taskId);
  }

  async cancelTask(taskId: string, signal?: AbortSignal): Promise<McpTaskStatus> {
    const result = await this.request("io.modelcontextprotocol/tasks/cancel", { taskId }, signal, taskId);
    return parseTaskStatus(result, taskId);
  }

  async callTool(
    input: { name: string; arguments?: JsonObject; _meta?: JsonObject },
    _schema?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<{
    content: unknown;
    isError?: boolean;
    resultType?: "complete" | "input_required" | "task";
    structuredContent?: unknown;
    inputRequests?: unknown;
    task?: McpTaskHandle;
  }> {
    let result = await this.request(
      "tools/call",
      { name: input.name, arguments: input.arguments ?? {}, ...(input._meta ? { _meta: input._meta } : {}) },
      options?.signal,
      input.name,
    );
    if (result.resultType === "task") {
      const rawTask = asObject(result.task);
      const taskId = typeof rawTask?.taskId === "string" ? rawTask.taskId : undefined;
      if (taskId === undefined || taskId === "") throw new Error("MCP 2026 task result has no taskId");
      if (this.config.taskMode === "handle") {
        const task = parseTaskStatus({ task: rawTask }, taskId).task;
        return {
          content: [{ type: "text", text: JSON.stringify({ task }) }],
          isError: false,
          resultType: "task",
          structuredContent: { task },
          task,
        };
      }
      const transactionDeadline = input._meta?.["transaction/deadlineAt"];
      result = await this.pollTask(
        result,
        options?.signal,
        typeof transactionDeadline === "number" ? transactionDeadline : undefined,
      );
    }
    if (result.resultType === "input_required") {
      return {
        content: result.content ?? [{ type: "text", text: "Additional input is required to complete this tool call." }],
        isError: false,
        resultType: "input_required",
        structuredContent: result.structuredContent,
        inputRequests: result.inputRequests,
      };
    }
    if (result.resultType !== "complete") {
      throw new Error(`Unsupported MCP 2026 resultType: ${String(result.resultType)}`);
    }
    return {
      content: result.content ?? [],
      resultType: "complete",
      ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}),
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    };
  }

  async resolveApproval(
    input: { name: string; arguments?: JsonObject; _meta?: JsonObject },
    requestState: string,
    resolution: { decision: "approved" | "denied"; approver?: string },
    options?: { signal?: AbortSignal },
  ): Promise<ReturnType<Stateless2026Client["callTool"]> extends Promise<infer T> ? T | undefined : never> {
    const resolved = await this.request(
      "io.modelcontextprotocol/approvals/resolve",
      {
        requestState,
        decision: resolution.decision,
        ...(resolution.approver !== undefined ? { approver: resolution.approver } : {}),
        ...(input._meta ? { _meta: input._meta } : {}),
      },
      options?.signal,
      undefined,
      requestState,
    );
    if (resolution.decision === "denied") return undefined;
    const approvalToken = resolved.approvalToken;
    if (typeof approvalToken !== "string" || approvalToken === "") {
      throw new Error("MCP 2026 approvals/resolve returned no approvalToken");
    }
    return this.callTool(
      {
        ...input,
        _meta: {
          ...(input._meta ?? {}),
          "io.modelcontextprotocol/approvalToken": approvalToken,
        },
      },
      undefined,
      options,
    );
  }

  private async pollTask(
    initial: JsonObject,
    signal?: AbortSignal,
    transactionDeadline?: number,
  ): Promise<JsonObject> {
    const task = asObject(initial.task);
    const taskId = typeof task?.taskId === "string" ? task.taskId : undefined;
    if (!taskId) throw new Error("MCP 2026 task result has no taskId");
    const intervalMs = this.config.taskPollingIntervalMs ?? 250;
    const maxAttempts = this.config.taskPollingMaxAttempts ?? 120;
    const configuredDeadline = Date.now() + (this.config.taskPollingDeadlineMs ?? 30_000);
    const deadline =
      transactionDeadline === undefined
        ? configuredDeadline
        : Math.min(configuredDeadline, transactionDeadline);
    for (let attempt = 0; attempt < maxAttempts && Date.now() <= deadline; attempt++) {
      if (attempt > 0) await delay(intervalMs, signal);
      const response = await this.request("io.modelcontextprotocol/tasks/get", { taskId }, signal);
      const current = asObject(response.task);
      const state = current?.state;
      if (state === "completed" || state === "failed" || state === "cancelled" || state === "canceled") {
        const completed = asObject(current?.result);
        if (!completed) throw new Error(`MCP 2026 task ${taskId} ${String(state)} without a result`);
        return completed.resultType === undefined
          ? {
              resultType: "complete",
              ...completed,
              ...(state === "completed" ? {} : { isError: true }),
            }
          : completed;
      }
    }
    throw new Error(`MCP 2026 task ${taskId} polling deadline exceeded`);
  }

  private async request(
    method: string,
    params: JsonObject,
    signal?: AbortSignal,
    name?: string,
    requestState?: string,
  ): Promise<JsonObject> {
    const headers: Record<string, string> = {
      ...(this.config.headers ?? {}),
      "Content-Type": "application/json",
      Accept: "application/json",
      "MCP-Protocol-Version": MCP_2026_PROTOCOL_VERSION,
      "Mcp-Method": method,
    };
    if (this.authToken !== undefined) headers.Authorization = `Bearer ${this.authToken}`;
    if (name !== undefined) headers["Mcp-Name"] = name;
    if (requestState !== undefined) headers["Mcp-Request-State"] = requestState;
    const requestMeta = asObject(params._meta);
    const traceparent = requestMeta?.["traceparent"];
    if (typeof traceparent === "string") headers.traceparent = traceparent;
    const transactionId =
      requestMeta?.["transaction/id"] ?? requestMeta?.["transaction/invocationId"];
    if (typeof transactionId === "string") headers["Mcp-Transaction-Id"] = transactionId;
    const deadline =
      requestMeta?.["transaction/deadlineAt"] ??
      requestMeta?.["io.modelcontextprotocol/deadline"];
    if (typeof deadline === "number" || typeof deadline === "string") {
      headers["Mcp-Deadline"] = String(deadline);
    }
    const body = {
      jsonrpc: "2.0",
      id: ++this.requestId,
      method,
      params,
      _meta: {
        ...requestMeta,
        [PROTOCOL_META_KEY]: MCP_2026_PROTOCOL_VERSION,
      },
    };
    const response = await fetch(this.config.url, { method: "POST", headers, body: JSON.stringify(body), signal });
    let payload: RpcResponse;
    try { payload = await response.json() as RpcResponse; }
    catch { throw new Error(`MCP 2026 ${method} returned invalid JSON (HTTP ${response.status})`); }
    if (!response.ok || payload.error) {
      const message = payload.error?.message ?? response.statusText;
      throw new Error(`MCP 2026 ${method} failed (HTTP ${response.status}): ${message}`);
    }
    if (!payload.result || typeof payload.result !== "object") throw new Error(`MCP 2026 ${method} returned no result`);
    return payload.result;
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
function cacheMetadata(value: JsonObject): McpCacheMetadata {
  return {
    ...(typeof value.ttlMs === "number" && value.ttlMs >= 0 ? { ttlMs: value.ttlMs } : {}),
    ...(value.cacheScope === "public" || value.cacheScope === "private" ? { cacheScope: value.cacheScope } : {}),
  };
}
function optionalString(value: JsonObject, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}
function isResourceDescriptor(value: unknown): value is McpResourceDescriptor {
  const resource = asObject(value);
  return typeof resource?.uri === "string";
}
function isResourceTemplateDescriptor(value: unknown): value is McpResourceTemplateDescriptor {
  const resource = asObject(value);
  return typeof resource?.uriTemplate === "string";
}
function isPromptDescriptor(value: unknown): value is McpPromptDescriptor {
  const prompt = asObject(value);
  return typeof prompt?.name === "string";
}
function parseTaskStatus(result: JsonObject, fallbackTaskId: string): McpTaskStatus {
  const raw = asObject(result.task) ?? result;
  const taskId = optionalString(raw, "taskId") ?? fallbackTaskId;
  if (taskId === "") throw new Error("MCP 2026 task response returned no taskId");
  const task: McpTaskHandle = {
    taskId,
    ...(optionalString(raw, "state") !== undefined ? { state: optionalString(raw, "state") } : {}),
    ...(optionalString(raw, "statusMessage") !== undefined ? { statusMessage: optionalString(raw, "statusMessage") } : {}),
    ...(optionalString(raw, "createdAt") !== undefined ? { createdAt: optionalString(raw, "createdAt") } : {}),
    ...(optionalString(raw, "lastUpdatedAt") !== undefined ? { lastUpdatedAt: optionalString(raw, "lastUpdatedAt") } : {}),
  };
  const taskResult = asObject(raw.result);
  return { task, ...(taskResult !== undefined ? { result: taskResult } : {}) };
}
function isRawTool(value: unknown): value is RawTool {
  const tool = asObject(value); const schema = asObject(tool?.inputSchema);
  return typeof tool?.name === "string" && typeof schema?.type === "string" && (schema.properties === undefined || asObject(schema.properties) !== undefined) && (schema.required === undefined || (Array.isArray(schema.required) && schema.required.every((x) => typeof x === "string")));
}
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error("MCP 2026 request aborted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); cleanup(); reject(signal?.reason ?? new Error("MCP 2026 request aborted")); };
    function cleanup() { signal?.removeEventListener("abort", abort); }
    function done() { cleanup(); resolve(); }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
