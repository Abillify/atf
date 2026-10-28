// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { trimTrailingSlashes } from "@atf/security-kit";

import { createHash } from "node:crypto";
import type { AuthContext } from "../auth/context.ts";
import type { TaigaApiTool } from "../config/schema.ts";
import { logger } from "../logger.ts";
import { secureOutboundFetch, validateOutboundUrl } from "./outbound.ts";
import type { ToolDefinition, ToolExecutor, ToolResult, ToolRuntime } from "./types.ts";

interface CachedToken {
  token: string;
  expiresAt: number;
}

interface TaigaRequestResult {
  status: number;
  ok: boolean;
  value: unknown;
}

const tokenCache = new Map<string, CachedToken>();
const pendingExchanges = new Map<string, Promise<CachedToken>>();
const MAX_TOKEN_CACHE_ENTRIES = 1000;

export class TaigaApiToolExecutor implements ToolExecutor {
  readonly definition: ToolDefinition;
  private readonly allowedHosts: string[];
  private readonly outboundFetch?: typeof fetch;
  private readonly apiBaseUrl: string;
  private readonly allowedPrivateHosts: string[];

  constructor(
    private readonly cfg: TaigaApiTool,
    runtime: ToolRuntime,
  ) {
    this.allowedHosts = runtime.outboundAllowedHosts ?? [];
    this.outboundFetch = runtime.outboundFetch;
    this.apiBaseUrl = trimTrailingSlashes(cfg.apiBaseUrl);
    this.allowedPrivateHosts = cfg.allowPrivateAddress
      ? [new URL(this.apiBaseUrl).hostname]
      : [];
    this.definition = {
      name: cfg.name,
      description: cfg.description,
      inputSchema: cfg.inputSchema as Record<string, unknown>,
      ...(cfg.outputSchema !== undefined
        ? { outputSchema: cfg.outputSchema as Record<string, unknown> }
        : {}),
    };
  }

  async execute(
    args: Record<string, unknown>,
    ctx: AuthContext,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (!ctx.rawToken) return errorResult("TAIGA_USER_TOKEN_MISSING", 401);

    try {
      const token = await this.taigaToken(ctx, signal);
      switch (this.cfg.operation) {
        case "task_create":
          return await this.createTask(args, ctx, token, signal);
        case "task_update":
          return await this.updateTask(args, ctx, token, signal);
        case "story_points_update":
          return await this.updateStoryPoints(args, ctx, token, signal);
      }
    } catch (cause) {
      const code = cause instanceof TaigaToolError ? cause.code : "TAIGA_REQUEST_FAILED";
      const status = cause instanceof TaigaToolError ? cause.status : 502;
      logger.warn("taiga api tool failed", {
        tool: this.cfg.name,
        operation: this.cfg.operation,
        code,
        status,
      });
      return errorResult(code, status);
    }
  }

  async explain(args: Record<string, unknown>, _ctx: AuthContext): Promise<ToolResult> {
    const target = targetFor(this.cfg.operation, this.apiBaseUrl, args);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          operation: this.cfg.operation,
          target,
          authentication: "user-bound Taiga token exchange (credentials redacted)",
          arguments: args,
        }, null, 2),
      }],
      meta: { dryRun: true, operation: this.cfg.operation, target },
    };
  }

  private cacheKey(ctx: AuthContext): string {
    const issuer = typeof ctx.claims.iss === "string" ? ctx.claims.iss : "";
    return createHash("sha256")
      .update(JSON.stringify([this.apiBaseUrl, issuer, ctx.subject, ctx.tenantId]))
      .digest("hex");
  }

  private async taigaToken(ctx: AuthContext, signal?: AbortSignal): Promise<string> {
    const key = this.cacheKey(ctx);
    const now = Date.now();
    pruneTokenCache(now);
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt > now) return cached.token;
    tokenCache.delete(key);

    let pending = pendingExchanges.get(key);
    if (!pending) {
      pending = this.exchangeToken(ctx, signal);
      pendingExchanges.set(key, pending);
    }
    try {
      const exchanged = await pending;
      storeToken(key, exchanged);
      return exchanged.token;
    } finally {
      if (pendingExchanges.get(key) === pending) pendingExchanges.delete(key);
    }
  }

  private async exchangeToken(ctx: AuthContext, signal?: AbortSignal): Promise<CachedToken> {
    const response = await this.request(
      `${this.apiBaseUrl}/api/v1/auth`,
      "POST",
      { type: "openid", access_token: ctx.rawToken },
      undefined,
      signal,
    );
    if (!response.ok || !isRecord(response.value) || typeof response.value.auth_token !== "string") {
      throw new TaigaToolError("TAIGA_TOKEN_EXCHANGE_FAILED", response.status || 502);
    }

    const oidcExpiry = typeof ctx.claims.exp === "number"
      ? ctx.claims.exp * 1000
      : Date.now() + this.cfg.tokenCacheTtlMs;
    const expiresAt = Math.max(
      Date.now(),
      Math.min(oidcExpiry, Date.now() + this.cfg.tokenCacheTtlMs),
    );
    return { token: response.value.auth_token, expiresAt };
  }

  private async createTask(
    args: Record<string, unknown>,
    ctx: AuthContext,
    token: string,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const body: Record<string, unknown> = {
      project: positiveInteger(args.project, "project"),
      user_story: positiveInteger(args.user_story, "user_story"),
      subject: nonEmptyString(args.subject, "subject"),
    };
    copyOptional(body, args, "status");
    copyOptional(body, args, "assigned_to");
    copyOptional(body, args, "description");

    const response = await this.authorizedRequest(
      ctx,
      token,
      `${this.apiBaseUrl}/api/v1/tasks`,
      "POST",
      body,
      signal,
      false,
    );
    if (!response.ok) throw apiError(response.status);
    const task = sanitizeTask(response.value);
    return successResult({ operation: "task_create", task }, response.status);
  }

  private async updateTask(
    args: Record<string, unknown>,
    ctx: AuthContext,
    token: string,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const taskId = positiveInteger(args.task_id, "task_id");
    const url = `${this.apiBaseUrl}/api/v1/tasks/${taskId}`;
    const current = await this.authorizedRequest(ctx, token, url, "GET", undefined, signal);
    if (!current.ok) throw apiError(current.status);
    if (!isRecord(current.value) || typeof current.value.version !== "number") {
      throw new TaigaToolError("TAIGA_RESPONSE_INVALID", 502);
    }
    const body: Record<string, unknown> = {
      version: nonNegativeInteger(current.value.version, "version"),
    };
    copyOptional(body, args, "status");
    copyOptional(body, args, "assigned_to");
    if (!("status" in body) && !("assigned_to" in body)) {
      throw new TaigaToolError("TAIGA_UPDATE_HAS_NO_CHANGES", 400);
    }

    const response = await this.authorizedRequest(
      ctx,
      token,
      url,
      "PATCH",
      body,
      signal,
    );
    if (!response.ok) throw apiError(response.status);
    const task = sanitizeTask(response.value);
    return successResult({ operation: "task_update", task }, response.status);
  }

  private async updateStoryPoints(
    args: Record<string, unknown>,
    ctx: AuthContext,
    token: string,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const storyId = positiveInteger(args.user_story_id, "user_story_id");
    const roleId = positiveInteger(args.role_id, "role_id");
    const pointId = positiveInteger(args.point_id, "point_id");
    const url = `${this.apiBaseUrl}/api/v1/userstories/${storyId}`;

    const current = await this.authorizedRequest(ctx, token, url, "GET", undefined, signal);
    if (!current.ok) throw apiError(current.status);
    if (!isRecord(current.value) || !isRecord(current.value.points) || typeof current.value.version !== "number") {
      throw new TaigaToolError("TAIGA_POINTS_RESPONSE_INVALID", 502);
    }
    const currentVersion = nonNegativeInteger(current.value.version, "version");

    const points = { ...current.value.points, [String(roleId)]: pointId };
    const response = await this.authorizedRequest(
      ctx,
      token,
      url,
      "PATCH",
      { version: currentVersion, points },
      signal,
    );
    if (!response.ok) throw apiError(response.status);
    const story = sanitizeStory(response.value);
    return successResult({ operation: "story_points_update", story }, response.status);
  }

  private async authorizedRequest(
    ctx: AuthContext,
    token: string,
    url: string,
    method: "GET" | "POST" | "PATCH",
    body: Record<string, unknown> | undefined,
    signal?: AbortSignal,
    retryUnauthorized = true,
  ): Promise<TaigaRequestResult> {
    let response = await this.request(url, method, body, token, signal);
    if (response.status !== 401 || !retryUnauthorized) return response;

    tokenCache.delete(this.cacheKey(ctx));
    const refreshed = await this.taigaToken(ctx, signal);
    response = await this.request(url, method, body, refreshed, signal);
    return response;
  }

  private async request(
    url: string,
    method: "GET" | "POST" | "PATCH",
    body: Record<string, unknown> | undefined,
    bearer: string | undefined,
    signal?: AbortSignal,
  ): Promise<TaigaRequestResult> {
    const blocked = await validateOutboundUrl(url, this.allowedHosts, this.allowedPrivateHosts);
    if (blocked) throw new TaigaToolError("TAIGA_OUTBOUND_BLOCKED", 502);

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(`Taiga request timed out after ${this.cfg.timeoutMs}ms`)),
      this.cfg.timeoutMs,
    );
    timer.unref?.();

    const headers: Record<string, string> = { Accept: "application/json" };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    try {
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
        redirect: "manual",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      };
      const response = this.outboundFetch
        ? await this.outboundFetch(url, init)
        : await secureOutboundFetch(url, init, this.allowedHosts, {
            allowedPrivateHosts: this.allowedPrivateHosts,
          });
      const value = await readJsonCapped(response, this.cfg.maxResponseBytes);
      return { status: response.status, ok: response.ok, value };
    } catch (cause) {
      if (cause instanceof TaigaToolError) throw cause;
      throw new TaigaToolError(
        controller.signal.aborted ? "TAIGA_REQUEST_TIMEOUT" : "TAIGA_REQUEST_FAILED",
        502,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function pruneTokenCache(now: number): void {
  for (const [key, entry] of tokenCache) {
    if (entry.expiresAt <= now) tokenCache.delete(key);
  }
}

function storeToken(key: string, entry: CachedToken): void {
  pruneTokenCache(Date.now());
  tokenCache.delete(key);
  while (tokenCache.size >= MAX_TOKEN_CACHE_ENTRIES) {
    const oldest = tokenCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    tokenCache.delete(oldest);
  }
  tokenCache.set(key, entry);
}

class TaigaToolError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

function targetFor(operation: TaigaApiTool["operation"], baseUrl: string, args: Record<string, unknown>): string {
  switch (operation) {
    case "task_create": return `${baseUrl}/api/v1/tasks`;
    case "task_update": return `${baseUrl}/api/v1/tasks/${String(args.task_id ?? ":task_id")}`;
    case "story_points_update": return `${baseUrl}/api/v1/userstories/${String(args.user_story_id ?? ":user_story_id")}`;
  }
}

function apiError(status: number): TaigaToolError {
  if (status === 400 || status === 422) return new TaigaToolError("TAIGA_VALIDATION_FAILED", status);
  if (status === 401) return new TaigaToolError("TAIGA_AUTH_FAILED", status);
  if (status === 403) return new TaigaToolError("TAIGA_FORBIDDEN", status);
  if (status === 404) return new TaigaToolError("TAIGA_NOT_FOUND", status);
  if (status === 409 || status === 412) return new TaigaToolError("TAIGA_VERSION_CONFLICT", status);
  return new TaigaToolError("TAIGA_API_FAILED", status || 502);
}

function successResult(value: Record<string, unknown>, status: number): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    meta: { status },
  };
}

function errorResult(code: string, status: number): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: code, status }) }],
    structuredContent: { error: code, status },
    isError: true,
    meta: { status },
  };
}

function sanitizeTask(value: unknown): Record<string, unknown> {
  return pickFields(value, [
    "id", "ref", "subject", "project", "user_story", "status", "assigned_to",
    "version", "is_closed", "created_date", "modified_date",
  ]);
}

function sanitizeStory(value: unknown): Record<string, unknown> {
  return pickFields(value, ["id", "ref", "subject", "project", "points", "version", "modified_date"]);
}

function pickFields(value: unknown, fields: string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new TaigaToolError("TAIGA_RESPONSE_INVALID", 502);
  const result: Record<string, unknown> = {};
  for (const field of fields) if (Object.hasOwn(value, field)) result[field] = value[field];
  return result;
}

function copyOptional(target: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  if (Object.hasOwn(source, key)) target[key] = source[key];
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new TaigaToolError(`TAIGA_INVALID_${field.toUpperCase()}`, 400);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TaigaToolError(`TAIGA_INVALID_${field.toUpperCase()}`, 400);
  }
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TaigaToolError(`TAIGA_INVALID_${field.toUpperCase()}`, 400);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonCapped(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new TaigaToolError("TAIGA_RESPONSE_TOO_LARGE", 502);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new TaigaToolError("TAIGA_RESPONSE_INVALID", 502);
  }
}
