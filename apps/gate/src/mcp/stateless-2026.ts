// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHash, randomUUID } from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import { AuthError, type Authenticator, extractBearer } from "../auth/authenticator.ts";
import type { AuthContext } from "../auth/context.ts";
import { bearerChallenge } from "../auth/well-known.ts";
import type { GovernanceConfig, ServerConfig } from "../config/schema.ts";
import type { MonitorBus } from "../monitor/events.ts";
import type { IdentityRateLimiter } from "../server/identity-rate-limit.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { validateArgs } from "../tools/validate.ts";
import type { TransactionFabric } from "../transaction/fabric.ts";
import { McpToolDispatcher, protocolToolResult } from "./server.ts";
import type { ApprovalConsumptionStore } from "./approval-store.ts";
import {
  APPROVAL_TOKEN_META_KEY,
  GovernancePolicy,
  approvalArgsFingerprint,
  approvalOwner,
  mintApprovalToken,
  type GovernancePolicyRef,
} from "./governance.ts";
import { evidenceActionContractHash } from "./evidence-contract.ts";
import { MemoryTaskStore, TaskCapacityError } from "./tasks.ts";

export const MCP_2026_PROTOCOL_VERSION = "2026-07-28";
type Scoped = { requiredScopes: string[] };
type Primitive = Record<string, unknown> & Scoped;
interface StatelessDeps {
  serverConfig: ServerConfig;
  authenticator: Authenticator;
  registry: ToolRegistry;
  bus: MonitorBus;
  identityRateLimiter?: IdentityRateLimiter;
  transactionFabric?: TransactionFabric;
  authorizationEnabled?: boolean;
  policies?: GovernanceConfig;
  /** Shared compiled policy holder, hot-reloaded by `buildApp` (Req 6.3). */
  policyRef?: GovernancePolicyRef;
  /** Shared redeemed-JTI store for approval tokens (Req 6.1). */
  approvalStore?: ApprovalConsumptionStore;
  resources: Array<Primitive & { uri: string; name: string; text: string }>;
  prompts: Array<Primitive & { name: string; message: string }>;
  skills: Array<Primitive & { name: string }>;
  apps: Array<Primitive & { name: string; resourceUri: string }>;
  tasks: { asyncTools: string[]; ttlMs: number; maxEntries: number };
}
interface Body {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}
const tokenFingerprint = (token: string | undefined): string | undefined =>
  token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : undefined;
const requestedTool = (body: Body): string | undefined => {
  const name = body.method === "tools/call" ? body.params?.name : undefined;
  return typeof name === "string" && /^[\w.:-]{1,128}$/.test(name) ? name : undefined;
};
const header = (req: Request, name: string) => req.get(name)?.trim() || undefined;
const error = (res: Response, status: number, id: unknown, code: number, message: string) =>
  res.status(status).json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const visible = <T extends Scoped>(items: T[], scopes: string[], authorizationEnabled = true) =>
  authorizationEnabled
    ? items.filter((item) => item.requiredScopes.every((scope) => scopes.includes(scope)))
    : items;
const publicItem = (item: Record<string, unknown>) => {
  const { requiredScopes: _, text: __, message: ___, ...rest } = item;
  return rest;
};
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
function paginate<T>(
  items: T[],
  params: Record<string, unknown>,
): { items: T[]; nextCursor?: string } {
  const rawPageSize = params.pageSize;
  const pageSize = rawPageSize === undefined ? DEFAULT_PAGE_SIZE : rawPageSize;
  if (
    typeof pageSize !== "number" ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_PAGE_SIZE
  ) {
    throw new Error(`pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  const rawCursor = params.cursor;
  if (rawCursor !== undefined && (typeof rawCursor !== "string" || !/^\d+$/.test(rawCursor))) {
    throw new Error("Invalid pagination cursor");
  }
  const offset = rawCursor === undefined ? 0 : Number(rawCursor);
  if (!Number.isSafeInteger(offset)) throw new Error("Invalid pagination cursor");
  const pageItems = items.slice(offset, offset + pageSize);
  const nextOffset = offset + pageItems.length;
  return {
    items: pageItems,
    ...(nextOffset < items.length ? { nextCursor: String(nextOffset) } : {}),
  };
}
const envelope = (serverInfo: object, fields: object, responseMeta: object = {}) => ({
  resultType: "complete",
  ...fields,
  ttlMs: 0,
  cacheScope: "request",
  _meta: { serverInfo, ...responseMeta },
});
const requestMetadata = (req: Request, body: Body, params: Record<string, unknown>) => {
  const meta = {
    ...(body._meta ?? {}),
    ...((params._meta as Record<string, unknown> | undefined) ?? {}),
  };
  for (const [headerName, metaName] of [
    ["traceparent", "traceparent"],
    ["tracestate", "tracestate"],
    ["Mcp-Transaction-Id", "transaction/id"],
    ["Mcp-Deadline", "deadlineAt"],
  ] as const) {
    const value = header(req, headerName);
    if (value !== undefined && meta[metaName] === undefined) meta[metaName] = value;
  }
  return meta;
};
const deadlineSignal = (meta: Record<string, unknown>): AbortSignal | undefined => {
  const raw =
    meta.deadlineAt ??
    meta["transaction/deadlineAt"] ??
    meta["io.modelcontextprotocol/deadline"];
  if (raw === undefined) return undefined;
  const deadline =
    typeof raw === "number"
      ? raw
      : /^\d+$/.test(String(raw))
        ? Number(raw)
        : Date.parse(String(raw));
  if (!Number.isFinite(deadline)) throw new Error("Invalid deadline metadata");
  return AbortSignal.timeout(Math.max(0, deadline - Date.now()));
};
const valueAt = (values: Record<string, unknown>, path: string): unknown => {
  let current: unknown = values;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};
function render(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
    const current = valueAt(values, key);
    return current === undefined || current === null ? "" : String(current);
  });
}
const renderValue = (value: unknown, values: Record<string, unknown>): unknown => {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{\s*([\w.-]+)\s*\}\}$/);
    return whole ? valueAt(values, whole[1]!) : render(value, values);
  }
  if (Array.isArray(value)) return value.map((item) => renderValue(item, values));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, renderValue(v, values)]));
  return value;
};

interface PendingApproval {
  requestState: string;
  owner: string;
  tool: string;
  args: Record<string, unknown>;
  fingerprint: string;
  evidenceContractHash?: string;
  expiresAt: number;
}
class PendingApprovalStore {
  private readonly entries = new Map<string, PendingApproval>();
  constructor(private readonly ttlMs: number, private readonly maxEntries: number) {}
  private sweep(now = Date.now()) {
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
  }
  create(
    owner: string,
    tool: string,
    args: Record<string, unknown>,
    evidenceContractHash?: string,
  ): PendingApproval {
    this.sweep();
    if (this.entries.size >= this.maxEntries) throw new TaskCapacityError();
    const entry = {
      requestState: randomUUID(), owner, tool,
      args: structuredClone(args),
      fingerprint: approvalArgsFingerprint(args),
      ...(evidenceContractHash !== undefined ? { evidenceContractHash } : {}),
      expiresAt: Date.now() + this.ttlMs,
    };
    this.entries.set(entry.requestState, entry);
    return entry;
  }
  take(requestState: string, owner: string): PendingApproval | undefined {
    this.sweep();
    const entry = this.entries.get(requestState);
    if (!entry || entry.owner !== owner) return undefined;
    this.entries.delete(requestState);
    return entry;
  }
  clear() { this.entries.clear(); }
}

function taskOwner(ctx: {
  method: string;
  subject: string;
  claims: Record<string, unknown>;
  tenantId: string;
  headers: Record<string, string>;
}): string {
  const identity = {
    method: ctx.method,
    issuer: ctx.claims.iss,
    subject: ctx.subject,
    tenant: ctx.tenantId,
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("base64url");
}

export function createStateless2026Router(deps: StatelessDeps): Router {
  const { serverConfig, authenticator, bus } = deps;
  const store = new MemoryTaskStore(deps.tasks.ttlMs, deps.tasks.maxEntries);
  const approvalStore = new PendingApprovalStore(
    deps.policies?.approval.ttlMs ?? 300_000,
    deps.policies?.approval.maxPending ?? 1000,
  );
  const prepareApproval = async (
    ctx: AuthContext,
    tool: string,
    args: Record<string, unknown>,
    evidenceContractHash?: string,
  ): Promise<Record<string, unknown>> => {
    const policy = deps.policyRef
      ? deps.policyRef.current
      : deps.policies
        ? new GovernancePolicy(deps.policies, deps.approvalStore)
        : undefined;
    if (!policy) throw new Error("Approval policy is not configured");
    const rule = policy.matchingRule(ctx, tool, deps.registry.accessOf(tool) ?? "read", args);
    const presentation = rule?.approval;
    let lookup: Record<string, unknown> = {};
    if (presentation?.lookup) {
      const executor = deps.registry.getReal(presentation.lookup.tool);
      if (!executor) throw new Error(`Approval lookup tool '${presentation.lookup.tool}' not found`);
      const missing = deps.registry.requiredScopesOf(presentation.lookup.tool).filter((scope) => !ctx.scopes.includes(scope));
      if (missing.length) throw new Error("Approval lookup is not authorized");
      const lookupArgs = renderValue(presentation.lookup.arguments, { args }) as Record<string, unknown>;
      const validation = validateArgs(executor.definition.inputSchema, lookupArgs);
      if (!validation.ok) throw new Error("Approval lookup arguments are invalid");
      const lookupResult = await executor.execute(lookupArgs, ctx);
      if (lookupResult.isError) throw new Error("Approval lookup failed");
      const rows = (lookupResult.structuredContent as { rows?: unknown[] } | undefined)?.rows;
      if (rows && rows.length === 0)
        throw new Error("Approval lookup returned no matching result");
      lookup = (rows?.[0] as Record<string, unknown> | undefined) ?? lookupResult.structuredContent ?? {};
    }
    const pending = approvalStore.create(approvalOwner(ctx), tool, args, evidenceContractHash);
    bus.publish({
      type: "approval_requested",
      username: ctx.username,
      subject: ctx.subject,
      authMethod: ctx.method,
      tool,
      status: "pending",
      meta: { requestState: pending.requestState, expiresAt: new Date(pending.expiresAt).toISOString() },
    });
    const values = {
      args,
      lookup,
      auth: { subject: ctx.subject, username: ctx.username, scopes: ctx.scopes, claims: ctx.claims },
    };
    return {
      type: "approval",
      requestState: pending.requestState,
      title: render(presentation?.title ?? `Approve ${tool}`, values),
      message: render(presentation?.message ?? `Approve execution of '${tool}'?`, values),
      ...(presentation?.fields ? { fields: renderValue(presentation.fields, values) } : {}),
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  };
  const router = Router();
  const path = serverConfig.mcp2026.path;
  router.use(path, express.json({ limit: "4mb" }));
  router.post(path, async (req, res) => {
    const body = (req.body ?? {}) as Body;
    const token = extractBearer(req.headers.authorization);
    try {
      const ctx = await authenticator.authenticate(token, req.headers as Record<string, unknown>);
      bus.publish({
        type: "auth",
        username: ctx.username,
        subject: ctx.subject,
        authMethod: ctx.method,
        status: "ok",
        meta: { scopes: ctx.scopes, claims: ctx.claims, transport: "stateless-http" },
      });
      const protocol = header(req, "MCP-Protocol-Version");
      if (body._meta?.["io.modelcontextprotocol/protocolVersion"] !== protocol)
        return error(res, 400, body.id, -32020, "HeaderMismatch");
      if (protocol !== MCP_2026_PROTOCOL_VERSION)
        return error(res, 400, body.id, -32022, "UnsupportedProtocolVersion");
      const method = typeof body.method === "string" ? body.method : undefined;
      if (!method || header(req, "Mcp-Method") !== method)
        return error(res, 400, body.id, -32020, "HeaderMismatch");
      const params = body.params ?? {};
      const keyed =
        method === "tools/call" ||
        method === "prompts/get" ||
        method === "io.modelcontextprotocol/skills/get" ||
        method === "io.modelcontextprotocol/apps/get";
      const uriMethod = method === "resources/read";
      const key = uriMethod ? params.uri : params.name;
      if ((keyed || uriMethod) && (typeof key !== "string" || header(req, "Mcp-Name") !== key))
        return error(res, 400, body.id, -32020, "HeaderMismatch");
      if (
        method === "io.modelcontextprotocol/approvals/resolve" &&
        (typeof params.requestState !== "string" || header(req, "Mcp-Request-State") !== params.requestState)
      )
        return error(res, 400, body.id, -32020, "HeaderMismatch");
      const serverInfo = { name: serverConfig.name, version: serverConfig.version };
      const metadata = requestMetadata(req, body, params);
      const responseMeta = {
        serverInfo,
        ...(metadata.traceparent !== undefined ? { traceparent: metadata.traceparent } : {}),
        ...(metadata["transaction/id"] !== undefined
          ? { "transaction/id": metadata["transaction/id"] }
          : {}),
      };
      const dispatcher = new McpToolDispatcher(ctx, randomUUID(), deps);
      let result: Record<string, unknown>;
      if (method === "server/discover") {
        const capabilities: Record<string, unknown> = { tools: { list: true, call: true } };
        if (deps.resources.length) capabilities.resources = { list: true, read: true };
        if (deps.prompts.length) capabilities.prompts = { list: true, get: true };
        const extensions: Record<string, unknown> = {};
        if (deps.skills.length)
          extensions["io.modelcontextprotocol/skills"] = { list: true, get: true };
        if (deps.apps.length)
          extensions["io.modelcontextprotocol/apps"] = { list: true, get: true, rendering: false };
        if (deps.tasks.asyncTools.length)
          extensions["io.modelcontextprotocol/tasks"] = {
            get: true,
            cancel: true,
            durable: false,
            states: ["working", "completed", "failed", "cancelled"],
          };
        if (deps.authorizationEnabled !== false && deps.policies)
          extensions["io.modelcontextprotocol/approvals"] = {
            resolve: true,
            resultType: "input_required",
            decisions: ["approved", "denied"],
          };
        result = {
          resultType: "complete",
          protocolVersion: MCP_2026_PROTOCOL_VERSION,
          serverInfo,
          service: {
            name: serverConfig.name,
            version: serverConfig.version,
            endpoint: path,
            transport: "stateless-http",
          },
          features: {
            pagination: {
              cursor: true,
              defaultPageSize: DEFAULT_PAGE_SIZE,
              maxPageSize: MAX_PAGE_SIZE,
            },
            structuredResults: true,
            inputRequired: true,
            requestMetadata: ["transaction", "trace", "deadline"],
          },
          capabilities,
          ...(Object.keys(extensions).length ? { extensions } : {}),
          _meta: responseMeta,
        };
      } else if (method === "tools/list") {
        const page = paginate(
          dispatcher.listTools().sort((a, b) => a.name.localeCompare(b.name)),
          params,
        );
        result = envelope(serverInfo, {
          tools: page.items,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        });
      } else if (method === "resources/list" && deps.resources.length) {
        const page = paginate(
          visible(deps.resources, ctx.scopes, deps.authorizationEnabled)
            .map(publicItem)
            .sort((a, b) => String(a.uri).localeCompare(String(b.uri))),
          params,
        );
        result = envelope(serverInfo, {
          resources: page.items,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        });
      } else if (method === "resources/read" && deps.resources.length) {
        const item = visible(deps.resources, ctx.scopes, deps.authorizationEnabled).find((x) => x.uri === params.uri);
        if (!item) return error(res, 404, body.id, -32004, "Resource not found");
        result = envelope(serverInfo, {
          contents: [{ uri: item.uri, mimeType: item.mimeType, text: item.text }],
        });
      } else if (method === "prompts/list") {
        const page = paginate(
          visible(deps.prompts, ctx.scopes, deps.authorizationEnabled)
            .map(publicItem)
            .sort((a, b) => String(a.name).localeCompare(String(b.name))),
          params,
        );
        result = envelope(serverInfo, {
          prompts: page.items,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        });
      } else if (method === "prompts/get") {
        const item = visible(deps.prompts, ctx.scopes, deps.authorizationEnabled).find((x) => x.name === params.name);
        if (!item) return error(res, 404, body.id, -32004, "Prompt not found");
        result = envelope(serverInfo, {
          description: item.description,
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: render(item.message, (params.arguments ?? {}) as Record<string, unknown>),
              },
            },
          ],
        });
      } else if (method === "io.modelcontextprotocol/skills/list") {
        const page = paginate(
          visible(deps.skills, ctx.scopes, deps.authorizationEnabled)
            .map(publicItem)
            .sort((a, b) => String(a.name).localeCompare(String(b.name))),
          params,
        );
        result = envelope(serverInfo, {
          skills: page.items,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        });
      } else if (method === "io.modelcontextprotocol/skills/get") {
        const item = visible(deps.skills, ctx.scopes, deps.authorizationEnabled).find((x) => x.name === params.name);
        if (!item) return error(res, 404, body.id, -32004, "Skill not found");
        result = envelope(serverInfo, { skill: publicItem(item) });
      } else if (method === "io.modelcontextprotocol/apps/list") {
        const page = paginate(
          visible(deps.apps, ctx.scopes, deps.authorizationEnabled)
            .map(publicItem)
            .sort((a, b) => String(a.name).localeCompare(String(b.name))),
          params,
        );
        result = envelope(serverInfo, {
          apps: page.items,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        });
      } else if (method === "io.modelcontextprotocol/apps/get") {
        const item = visible(deps.apps, ctx.scopes, deps.authorizationEnabled).find((x) => x.name === params.name);
        if (!item) return error(res, 404, body.id, -32004, "App not found");
        result = envelope(serverInfo, { app: publicItem(item) });
      } else if (method === "io.modelcontextprotocol/tasks/get") {
        const task = store.get(String(params.taskId ?? ""), taskOwner(ctx));
        if (!task) return error(res, 404, body.id, -32004, "Task not found");
        result = envelope(serverInfo, {
          task: {
            taskId: task.id,
            state: task.state,
            createdAt: task.createdAt,
            expiresAt: task.expiresAt,
            ...(task.result ? { result: protocolToolResult(task.result) } : {}),
          },
        });
      } else if (method === "io.modelcontextprotocol/tasks/cancel") {
        const task = store.cancel(String(params.taskId ?? ""), taskOwner(ctx));
        if (!task) return error(res, 404, body.id, -32004, "Task not found");
        result = envelope(serverInfo, {
          task: {
            taskId: task.id,
            state: task.state,
            createdAt: task.createdAt,
            expiresAt: task.expiresAt,
            ...(task.result ? { result: protocolToolResult(task.result) } : {}),
          },
        });
      } else if (
        method === "io.modelcontextprotocol/approvals/resolve" &&
        deps.authorizationEnabled !== false
      ) {
        const decision = params.decision;
        if (decision !== "approved" && decision !== "denied")
          return error(res, 400, body.id, -32602, "decision must be approved or denied");
        if (params.approver !== undefined && (typeof params.approver !== "string" || !params.approver.trim()))
          return error(res, 400, body.id, -32602, "approver must be a non-empty string");
        const secret =
          decision === "approved"
            ? deps.policies?.approval.secret || process.env.MCPGATE_APPROVAL_SECRET
            : undefined;
        if (decision === "approved" && !secret)
          return error(res, 503, body.id, -32003, "Approval service is not configured");
        const pending = approvalStore.take(String(params.requestState), approvalOwner(ctx));
        if (!pending) return error(res, 404, body.id, -32004, "Approval request not found or expired");
        bus.publish({
          type: "approval_resolved",
          username: ctx.username,
          subject: ctx.subject,
          authMethod: ctx.method,
          tool: pending.tool,
          status: decision,
          meta: {
            requestState: pending.requestState,
            decision,
            approver: typeof params.approver === "string" ? params.approver : ctx.subject,
          },
        });
        if (decision === "denied") {
          result = envelope(serverInfo, { requestState: pending.requestState, decision: "denied" });
        } else {
          if (!secret) throw new Error("Approval service is not configured");
          const approvalToken = mintApprovalToken({
            subject: pending.owner,
            tool: pending.tool,
            argsFingerprint: pending.fingerprint,
            requestState: pending.requestState,
            ...(pending.evidenceContractHash !== undefined
              ? { evidenceContractHash: pending.evidenceContractHash }
              : {}),
            approver: typeof params.approver === "string" ? params.approver : ctx.subject,
            secret,
            ttlMs: deps.policies?.approval.ttlMs ?? 300_000,
          });
          result = envelope(serverInfo, {
            requestState: pending.requestState,
            decision: "approved",
            approvalToken,
            tokenMetaKey: APPROVAL_TOKEN_META_KEY,
          });
        }
      } else if (method === "tools/call") {
        const callInput = {
          name: String(params.name),
          arguments: (params.arguments ?? {}) as Record<string, unknown>,
          _meta: metadata,
        };
        const requestDeadlineSignal = deadlineSignal(metadata);
        const run = (signal?: AbortSignal, preflighted = false) => {
          const effectiveSignal =
            signal && requestDeadlineSignal
              ? AbortSignal.any([signal, requestDeadlineSignal])
              : (signal ?? requestDeadlineSignal);
          return dispatcher.callTool(callInput, effectiveSignal, preflighted);
        };
        if (deps.tasks.asyncTools.includes(String(params.name))) {
          const preflight = await dispatcher.preflight(callInput);
          if (preflight?.structuredContent?.code === "APPROVAL_REQUIRED") {
            result = {
              resultType: "input_required",
              content: preflight.content,
              isError: preflight.isError,
              structuredContent: { code: "APPROVAL_REQUIRED" },
              inputRequests: [
                  await prepareApproval(
                    ctx,
                    callInput.name,
                    callInput.arguments,
                    evidenceActionContractHash(
                      callInput._meta,
                      callInput.name,
                      callInput.arguments,
                    ),
                  ),
                ],
              _meta: { serverInfo },
            };
          } else if (preflight) {
            result = {
              resultType: "complete",
              ...protocolToolResult(preflight),
              _meta: { serverInfo },
            };
          } else {
            const task = store.start(taskOwner(ctx), (signal) => run(signal, true));
            result = {
              resultType: "task",
              task: { taskId: task.id, state: task.state, expiresAt: task.expiresAt },
              _meta: { serverInfo },
            };
          }
        } else {
          const controller = new AbortController();
          const abort = () => controller.abort(new Error("Request aborted"));
          req.once("aborted", abort);
          res.once("close", () => {
            if (!res.writableEnded) abort();
          });
          const call = await run(controller.signal);
          req.off("aborted", abort);
          const approval = call.structuredContent?.code === "APPROVAL_REQUIRED";
          result = approval
            ? {
                resultType: "input_required",
                content: call.content,
                isError: call.isError,
                structuredContent: { code: "APPROVAL_REQUIRED" },
                inputRequests: [
                  await prepareApproval(
                    ctx,
                    callInput.name,
                    callInput.arguments,
                    evidenceActionContractHash(
                      callInput._meta,
                      callInput.name,
                      callInput.arguments,
                    ),
                  ),
                ],
                _meta: { serverInfo },
              }
            : {
                resultType: "complete",
                ...protocolToolResult(call),
                _meta: { serverInfo },
              };
        }
      } else return error(res, 404, body.id, -32601, "Method not found");
      res.json({ jsonrpc: "2.0", id: body.id ?? null, result });
    } catch (err) {
      const status =
        err instanceof AuthError ? err.status : err instanceof TaskCapacityError ? 503 : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof AuthError) {
        if (status === 401)
          res.set(
            "WWW-Authenticate",
            bearerChallenge(serverConfig, authenticator.authConfig, message) ?? "Bearer",
          );
        const fingerprint = tokenFingerprint(token);
        bus.publish({
          type: "auth_failure",
          tool: requestedTool(body),
          status: "error",
          message,
          meta: { ...(fingerprint ? { tokenFingerprint: fingerprint } : {}) },
        });
      } else {
        bus.publish({ type: "error", status: "error", message });
      }
      error(res, status, body.id, status === 503 ? -32003 : -32603, message);
    }
  });
  router.get(path, (_req, res) => error(res, 405, null, -32600, "Method not allowed"));
  router.delete(path, (_req, res) => error(res, 405, null, -32600, "Method not allowed"));
  (router as Router & { clearTasks?: () => void }).clearTasks = () => {
    store.clear();
    approvalStore.clear();
  };
  return router;
}
