// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuthContext } from "../auth/context.ts";
import type { GovernanceConfig, ServerConfig } from "../config/schema.ts";
import type { ApprovalConsumptionStore } from "./approval-store.ts";
import {
  APPROVAL_TOKEN_META_KEY,
  GovernancePolicy,
  type GovernancePolicyRef,
} from "./governance.ts";
import { evidenceActionContractHash } from "./evidence-contract.ts";
import { logger } from "../logger.ts";
import type { MonitorBus } from "../monitor/events.ts";
import { withSpan } from "../observability/tracing.ts";
import type { IdentityRateLimiter } from "../server/identity-rate-limit.ts";
import { contentTrustLabel, type ToolDefinition, type ToolResult } from "../tools/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { validateArgs } from "../tools/validate.ts";
import { runWithNestedInvoker } from "./invocation-context.ts";
import {
  LEGACY_TRANSACTION_TOKEN_META_KEY,
  TRANSACTION_CAPABILITY_TOOL,
  TRANSACTION_TOKEN_META_KEY,
  type TransactionFabric,
} from "../transaction/fabric.ts";

export interface McpServerDeps {
  serverConfig: ServerConfig;
  registry: ToolRegistry;
  bus: MonitorBus;
  instructions?: () => string | undefined;
  /** Optional per-identity rate limiter, additive to the IP-based HTTP limit. */
  identityRateLimiter?: IdentityRateLimiter;
  transactionFabric?: TransactionFabric;
  authorizationEnabled?: boolean;
  policies?: GovernanceConfig;
  /**
   * Shared compiled policy holder (Req 6.3): `buildApp` compiles the policy
   * set once per configuration version and hot-reload swaps it in place, so
   * no request recompiles globs or rule lists. Falls back to compiling
   * `policies` per dispatcher when absent (tests, auxiliary paths).
   */
  policyRef?: GovernancePolicyRef;
  /**
   * Shared redeemed-JTI store for approval tokens (Req 6.1). Redis-backed when
   * Redis is configured so a redemption is honored across replicas; the policy
   * falls back to the process-wide memory map when absent.
   */
  approvalStore?: ApprovalConsumptionStore;
}

export interface ToolCallInput {
  name: string;
  arguments?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

function missingScopesResult(
  requiredScopes: readonly string[],
  context: AuthContext,
): ToolResult | undefined {
  const missing = requiredScopes.filter((scope) => !context.scopes.includes(scope));
  return missing.length > 0
    ? {
        content: [{ type: "text", text: `Missing required scope(s): ${missing.join(", ")}` }],
        isError: true,
      }
    : undefined;
}

/**
 * Returns a bounded operator-facing error summary. Tool output remains available
 * to the MCP caller, but the monitor and INFO logs must not mirror arbitrary
 * (possibly large) result payloads.
 */
function errorSummary(result: ToolResult): string | undefined {
  if (result.isError !== true) return undefined;
  const text = result.content.find((item) => item.type === "text")?.text;
  if (text === undefined) return "Tool returned an error without a text detail.";
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 512 ? normalized : `${normalized.slice(0, 512)}…[truncated]`;
}

function errorCode(result: ToolResult): string | undefined {
  const code = result.structuredContent?.code;
  return typeof code === "string" && /^[A-Z0-9_:-]{1,128}$/.test(code) ? code : undefined;
}

/**
 * A tool's outputSchema describes successful structured content. Some MCP
 * clients nevertheless validate structuredContent on error results against
 * that success schema. Keep the machine-readable error internally for audit
 * and flow control, but omit it at the protocol boundary so the original error
 * is not replaced by an output-schema validation failure.
 */
export function protocolToolResult(result: ToolResult): ToolResult {
  if (result.isError !== true || result.structuredContent === undefined) return result;
  const wireResult = { ...result };
  delete wireResult.structuredContent;
  return wireResult;
}

const TRANSACTION_ACTION_TOKENS_META_KEY = "transaction/actionTokens";
const APPROVAL_ACTION_TOKENS_META_KEY = "approval/actionTokens";

function tokenFromActionMap(
  meta: Record<string, unknown> | undefined,
  mapKey: string,
  actionContractHash: string | undefined,
  fallbackKey: string,
): unknown {
  const fallback = meta?.[fallbackKey];
  const tokens = meta?.[mapKey];
  if (tokens === undefined) return fallback;
  if (tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) {
    throw new Error(`${mapKey} must be an object keyed by SHA-256 digest`);
  }

  const normalized = new Map<string, string>();
  for (const [key, token] of Object.entries(tokens as Record<string, unknown>)) {
    if (!/^[a-f0-9]{64}$/iu.test(key)) {
      throw new Error(`${mapKey} contains malformed SHA-256 digest key '${key}'`);
    }
    if (typeof token !== "string" || token.trim() === "") {
      throw new Error(`${mapKey} contains an invalid token for SHA-256 digest '${key.toLowerCase()}'`);
    }
    const digest = key.toLowerCase();
    if (normalized.has(digest) && normalized.get(digest) !== token) {
      throw new Error(`${mapKey} contains conflicting tokens for SHA-256 digest '${digest}'`);
    }
    normalized.set(digest, token);
  }

  if (actionContractHash === undefined) return fallback;
  return normalized.has(actionContractHash.toLowerCase())
    ? normalized.get(actionContractHash.toLowerCase())
    : fallback;
}

function transactionTokenForAction(
  meta: Record<string, unknown> | undefined,
  actionContractHash: string | undefined,
): unknown {
  const preferred = tokenFromActionMap(
    meta,
    TRANSACTION_ACTION_TOKENS_META_KEY,
    actionContractHash,
    TRANSACTION_TOKEN_META_KEY,
  );
  return preferred ?? meta?.[LEGACY_TRANSACTION_TOKEN_META_KEY];
}

function approvalTokenForAction(
  meta: Record<string, unknown> | undefined,
  actionContractHash: string | undefined,
): unknown {
  return tokenFromActionMap(
    meta,
    APPROVAL_ACTION_TOKENS_META_KEY,
    actionContractHash,
    APPROVAL_TOKEN_META_KEY,
  );
}

function invalidActionTokenMapResult(cause: unknown): ToolResult {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    content: [{ type: "text", text: `Invalid action token metadata: ${message}` }],
    isError: true,
    structuredContent: { code: "ACTION_TOKEN_MAP_INVALID" },
  };
}

/** Transport-neutral MCP tool dispatcher shared by session and stateless endpoints. */
export class McpToolDispatcher {
  private readonly context: AuthContext;

  constructor(
    ctx: AuthContext,
    private readonly requestId: string,
    private readonly deps: McpServerDeps,
  ) {
    this.context = { ...ctx, sessionId: requestId };
  }

  /**
   * Resolve the governance policy for this dispatcher: the shared compiled
   * instance from the hot-reloadable holder when wired (Req 6.3), otherwise
   * a locally compiled one from `policies` (tests and auxiliary paths).
   */
  private policy(withStore = true): GovernancePolicy | undefined {
    if (this.deps.authorizationEnabled === false) return undefined;
    if (this.deps.policyRef) return this.deps.policyRef.current;
    if (!this.deps.policies) return undefined;
    return withStore
      ? new GovernancePolicy(this.deps.policies, this.deps.approvalStore)
      : new GovernancePolicy(this.deps.policies);
  }

  /**
   * Governance gate for a dry-run (`explain`). A dry-run never executes, so it
   * needs no approval token and consumes no rate-limit budget, but it renders
   * the tool's internals (SQL, bindings, URL, body), which is exactly what a
   * caller without the tool's scopes, or one the policy denies, must not see.
   * Returns the refusal result, or `undefined` when the dry-run may proceed.
   */
  authorizeExplain(
    name: string,
    args: Record<string, unknown>,
  ): ToolResult | undefined {
    const registry = this.deps.registry;
    const scopeError = missingScopesResult(
      registry.requiredScopesOf(name),
      this.context,
    );
    if (scopeError) return scopeError;
    const access = registry.accessOf(name) ?? "read";
    const decision = this.policy(false)?.evaluate(
      this.context,
      name,
      access,
      args,
    );
    if (decision?.effect === "deny") {
      return {
        content: [{ type: "text", text: `Policy denied tool '${name}'.` }],
        isError: true,
        structuredContent: { code: "POLICY_DENIED" },
      };
    }
    return undefined;
  }

  /**
   * Discovery has no call arguments, so this evaluates the same scope and
   * policy checks as a tool call using an empty argument object. Approval-only
   * tools remain discoverable because they are callable through the approval
   * flow; only an outright policy denial hides a tool.
   */
  private isToolDiscoverable(tool: ToolDefinition): boolean {
    const requiredScopes = this.deps.registry.requiredScopesOf(tool.name);
    if (!requiredScopes.every((scope) => this.context.scopes.includes(scope)))
      return false;

    const policy = this.policy(false);
    const access = this.deps.registry.accessOf(tool.name) ?? "read";
    return (
      (policy?.decide(this.context, tool.name, access, {}) ?? "allow") !==
      "deny"
    );
  }

  listTools(): ToolDefinition[] {
    const tools = this.deps.registry
      .list()
      .filter((tool) => this.isToolDiscoverable(tool));
    const transactionFabric = this.deps.transactionFabric;
    const capabilityAdvertised =
      transactionFabric !== undefined &&
      transactionFabric.config.enforcement !== "off";

    if (capabilityAdvertised) {
      tools.push({
        name: TRANSACTION_CAPABILITY_TOOL,
        description:
          "Return the Agent Transaction Fabric v1 capability document.",
        inputSchema: { type: "object", additionalProperties: false },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      });
    }

    if (transactionFabric !== undefined) {
      const reason = capabilityAdvertised
        ? "advertised"
        : transactionFabric.config.enforcement === "off"
          ? "enforcement_off"
          : "fabric_unavailable";
      const context = {
        event: "mcp_transaction_capability_list",
        session: this.requestId,
        auth_method: this.context.method,
        scope_count: this.context.scopes.length,
        transaction_enforcement: transactionFabric.config.enforcement,
        capability_advertised: capabilityAdvertised,
        reason,
        listed_tool_count: tools.length,
      };
      if (capabilityAdvertised) {
        logger.debug("transaction capability listed", context);
      } else {
        logger.info("transaction capability not listed", context);
      }
    }
    return tools;
  }

  async preflight(input: ToolCallInput): Promise<ToolResult | undefined> {
    const args = input.arguments ?? {};
    let evidenceContractHash: string | undefined;
    try {
      evidenceContractHash = evidenceActionContractHash(
        input._meta,
        input.name,
        args,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        content: [
          {
            type: "text",
            text: `Invalid Evidence-Bound Action Contract: ${message}`,
          },
        ],
        isError: true,
        structuredContent: { code: "EVIDENCE_CONTRACT_INVALID" },
      };
    }
    let approvalToken: unknown;
    try {
      transactionTokenForAction(input._meta, evidenceContractHash);
      approvalToken = approvalTokenForAction(input._meta, evidenceContractHash);
    } catch (cause) {
      return invalidActionTokenMapResult(cause);
    }
    if (
      input.name === TRANSACTION_CAPABILITY_TOOL &&
      this.deps.transactionFabric !== undefined &&
      this.deps.transactionFabric.config.enforcement !== "off"
    ) {
      return undefined;
    }
    const executor = this.deps.registry.get(input.name);
    if (!executor)
      return {
        content: [{ type: "text", text: `Unknown tool: ${input.name}` }],
        isError: true,
      };
    const scopeError = missingScopesResult(
      this.deps.registry.requiredScopesOf(input.name),
      this.context,
    );
    if (scopeError) return scopeError;
    const policy = this.policy();
    const access = this.deps.registry.accessOf(input.name) ?? "read";
    // One rule scan per call resolves effect, rule and evidence requirement (Req 6.3).
    const decision = policy?.evaluate(this.context, input.name, access, args);
    if (
      decision?.requiresEvidenceContract === true &&
      evidenceContractHash === undefined
    )
      return {
        content: [
          {
            type: "text",
            text: `Evidence-Bound Action Contract required for tool '${input.name}'.`,
          },
        ],
        isError: true,
        structuredContent: { code: "EVIDENCE_CONTRACT_REQUIRED" },
      };
    const effect = decision?.effect ?? "allow";
    if (effect === "deny")
      return {
        content: [
          { type: "text", text: `Policy denied tool '${input.name}'.` },
        ],
        isError: true,
        structuredContent: { code: "POLICY_DENIED" },
      };
    if (
      effect === "approval" &&
      !(await policy?.verifyApproval(
        approvalToken,
        this.context,
        input.name,
        args,
        evidenceContractHash,
      ))
    )
      return {
        content: [
          { type: "text", text: `Approval required for tool '${input.name}'.` },
        ],
        isError: true,
        structuredContent: {
          code: "APPROVAL_REQUIRED",
          approvalRequest: policy?.approvalRequest(
            this.context,
            input.name,
            args,
          ),
        },
      };
    return undefined;
  }

  async callTool(
    input: ToolCallInput,
    requestSignal?: AbortSignal,
    preflighted = false,
    /** Internal router/composite call: retain governance and use the real target. */
    nested = false,
    /** Stable logical identity supplied by the parent action for child ledger binding. */
    logicalActionId?: string,
    /**
     * Gate-internal approval enrichment (policy `approval.lookup`). It runs before
     * the action exists, so there is no transaction token or parent context to
     * bind it to; it skips the TransactionFabric and is restricted to read tools.
     * Nested composite/router steps inherit it, so each step is checked too.
     * Never reachable from protocol input.
     */
    approvalLookup = false,
  ): Promise<ToolResult> {
    const { registry, bus, identityRateLimiter } = this.deps;
    const { name } = input;
    const args = input.arguments ?? {};
    let evidenceContractHash: string | undefined;
    try {
      evidenceContractHash = evidenceActionContractHash(
        input._meta,
        name,
        args,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        content: [
          {
            type: "text",
            text: `Invalid Evidence-Bound Action Contract: ${message}`,
          },
        ],
        isError: true,
        structuredContent: { code: "EVIDENCE_CONTRACT_INVALID" },
      };
    }
    let transactionToken: unknown;
    let approvalToken: unknown;
    try {
      transactionToken = transactionTokenForAction(
        input._meta,
        evidenceContractHash,
      );
      approvalToken = approvalTokenForAction(input._meta, evidenceContractHash);
    } catch (cause) {
      return invalidActionTokenMapResult(cause);
    }
    const started = Date.now();

    const transactionFabric = this.deps.transactionFabric;
    if (name === TRANSACTION_CAPABILITY_TOOL) {
      const transactionEnforcement =
        transactionFabric?.config.enforcement ?? "unavailable";
      if (
        transactionFabric === undefined ||
        transactionFabric.config.enforcement === "off"
      ) {
        logger.info("transaction capability call unavailable", {
          event: "mcp_transaction_capability_call",
          session: this.requestId,
          auth_method: this.context.method,
          scope_count: this.context.scopes.length,
          transaction_enforcement: transactionEnforcement,
          outcome: "unavailable",
          reason:
            transactionFabric === undefined
              ? "fabric_unavailable"
              : "enforcement_off",
        });
      } else {
        const capability = transactionFabric.capabilityDocument();
        logger.info("transaction capability served", {
          event: "mcp_transaction_capability_call",
          session: this.requestId,
          auth_method: this.context.method,
          scope_count: this.context.scopes.length,
          transaction_enforcement: transactionEnforcement,
          outcome: "served",
          document_version: capability.version,
          signing_algorithm_count: Array.isArray(capability.signingAlgorithms)
            ? capability.signingAlgorithms.length
            : 0,
          ledger_backing:
            typeof capability.idempotency === "object" &&
            capability.idempotency !== null &&
            "backing" in capability.idempotency
              ? capability.idempotency.backing
              : "unknown",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(capability) }],
          structuredContent: capability,
        };
      }
    }

    if (identityRateLimiter) {
      // Bucket key: issuer + tenant + subject (Req 6.9). Static/disabled
      // auth has no `iss` claim, so the auth method stands in for it.
      const issuer =
        typeof this.context.claims.iss === "string"
          ? this.context.claims.iss
          : this.context.method;
      const decision = await identityRateLimiter.check(
        `${issuer}:${this.context.tenantId}:${this.context.subject}`,
      );
      if (!decision.allowed) {
        const message = `Rate limit exceeded for '${this.context.subject}'${
          decision.retryAfterMs !== undefined
            ? `; retry after ${Math.ceil(decision.retryAfterMs / 1000)}s`
            : ""
        }.`;
        bus.publish({
          tenantId: this.context.tenantId,
          type: "error",
          sessionId: this.requestId,
          username: this.context.username,
          tool: name,
          status: "error",
          message,
        });
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }

    bus.publish({
      tenantId: this.context.tenantId,
      type: "tool_call",
      sessionId: this.requestId,
      username: this.context.username,
      subject: this.context.subject,
      ...(this.context.actor !== undefined
        ? { actor: this.context.actor.subject }
        : {}),
      authMethod: this.context.method,
      tool: name,
      meta: { arguments: args },
    });

    const executor = nested ? registry.getReal(name) : registry.get(name);
    if (!executor) {
      bus.publish({
        tenantId: this.context.tenantId,
        type: "error",
        sessionId: this.requestId,
        username: this.context.username,
        tool: name,
        status: "error",
        message: `Unknown tool: ${name}`,
      });
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const requiredScopes = registry.requiredScopesOf(name);
    const access = registry.accessOf(name) ?? "read";
    // Fail closed: skipping the fabric is only acceptable for a read-only lookup.
    if (approvalLookup && access !== "read") {
      return {
        content: [
          {
            type: "text",
            text: `Approval lookup tool '${name}' must be read-only.`,
          },
        ],
        isError: true,
        structuredContent: { code: "APPROVAL_LOOKUP_NOT_READ_ONLY" },
      };
    }
    const policy = this.policy();
    // One rule scan per call resolves effect, rule and evidence requirement (Req 6.3).
    const decision = preflighted
      ? undefined
      : policy?.evaluate(this.context, name, access, args);
    if (
      decision?.requiresEvidenceContract === true &&
      evidenceContractHash === undefined
    ) {
      return {
        content: [
          {
            type: "text",
            text: `Evidence-Bound Action Contract required for tool '${name}'.`,
          },
        ],
        isError: true,
        structuredContent: { code: "EVIDENCE_CONTRACT_REQUIRED" },
      };
    }
    const effect = preflighted ? "allow" : (decision?.effect ?? "allow");
    if (effect === "deny") {
      return {
        content: [{ type: "text", text: `Policy denied tool '${name}'.` }],
        isError: true,
        structuredContent: { code: "POLICY_DENIED" },
      };
    }
    // Scopes before approval: a caller without them must not create an approval
    // request or burn a one-shot approval token. A policy deny still wins.
    const scopeError = missingScopesResult(requiredScopes, this.context);
    if (scopeError) {
      const message =
        scopeError.content[0]?.text ?? "Missing required scope(s)";
      bus.publish({
        tenantId: this.context.tenantId,
        type: "error",
        sessionId: this.requestId,
        username: this.context.username,
        tool: name,
        status: "error",
        durationMs: Date.now() - started,
        message,
      });
      return scopeError;
    }
    if (
      effect === "approval" &&
      !(await policy?.verifyApproval(
        approvalToken,
        this.context,
        name,
        args,
        evidenceContractHash,
      ))
    ) {
      return {
        content: [
          { type: "text", text: `Approval required for tool '${name}'.` },
        ],
        isError: true,
        structuredContent: {
          code: "APPROVAL_REQUIRED",
          approvalRequest: policy?.approvalRequest(this.context, name, args),
        },
      };
    }

    try {
      const validation = validateArgs(executor.definition.inputSchema, args);
      if (!validation.ok) {
        const message = `Invalid arguments for '${name}': ${validation.errors.join("; ")}`;
        bus.publish({
          tenantId: this.context.tenantId,
          type: "error",
          sessionId: this.requestId,
          username: this.context.username,
          tool: name,
          status: "error",
          durationMs: Date.now() - started,
          message,
        });
        return { content: [{ type: "text", text: message }], isError: true };
      }

      if (requestSignal?.aborted)
        throw requestSignal.reason ?? new Error("Request aborted");
      const run = (signal?: AbortSignal) => {
        const effectiveSignal =
          requestSignal && signal
            ? AbortSignal.any([requestSignal, signal])
            : (requestSignal ?? signal);
        return executor.execute(args, this.context, effectiveSignal);
      };
      // Every delegated call returns through the same request-local gate and
      // receives its own TransactionFabric execution. The fabric binds nested
      // effective actions to deterministic child ledger records (or a supplied
      // action-specific token), while this dispatcher independently repeats
      // governance, approval, validation, audit and scope checks.
      const gatedRun = (fabricSignal?: AbortSignal) =>
        runWithNestedInvoker(
          (nestedName, nestedArgs, nestedCtx, nestedSignal, nestedOptions) => {
            if (nestedCtx !== this.context) {
              return Promise.resolve({
                content: [
                  {
                    type: "text" as const,
                    text: "Nested invocation context mismatch.",
                  },
                ],
                isError: true,
                structuredContent: { code: "INVOCATION_CONTEXT_MISMATCH" },
              });
            }
            // Steps of a composite/router approval lookup inherit the lookup
            // mode: no fabric (there is no parent transaction), and every step
            // must itself be read-only.
            return this.callTool(
              { name: nestedName, arguments: nestedArgs, _meta: input._meta },
              nestedSignal,
              false,
              true,
              nestedOptions.logicalActionId,
              approvalLookup,
            );
          },
          () => run(fabricSignal),
        );
      const result = await withSpan(
        `mcp.tool_call ${name}`,
        { "mcpgate.tool": name, "mcpgate.username": this.context.username },
        () =>
          this.deps.transactionFabric && !approvalLookup
            ? this.deps.transactionFabric.execute({
                token: transactionToken,
                tool: name,
                args,
                actionContractHash: evidenceContractHash,
                logicalActionId,
                requiredScopes,
                access,
                authContext: this.context,
                run: (signal) => gatedRun(signal),
                onTelemetry: (event) =>
                  bus.publish({
                    tenantId: this.context.tenantId,
                    type: "transaction",
                    sessionId: this.requestId,
                    username: this.context.username,
                    tool: name,
                    meta: { transaction: event },
                  }),
              })
            : gatedRun(),
      );
      const durationMs = Date.now() - started;
      const entryType = registry.typeOf(name) ?? "tool";
      const failure = errorSummary(result);
      const code = errorCode(result);
      bus.publish({
        tenantId: this.context.tenantId,
        type: "tool_result",
        sessionId: this.requestId,
        username: this.context.username,
        tool: name,
        status: result.isError ? "error" : "ok",
        durationMs,
        ...(failure !== undefined ? { message: failure } : {}),
        meta: {
          ...result.meta,
          content: result.content,
          ...(code !== undefined ? { error_code: code } : {}),
        },
      });

      const bytes = result.content?.reduce(
        (n, content) =>
          n +
          (typeof content.text === "string"
            ? Buffer.byteLength(content.text, "utf8")
            : 0),
        0,
      );
      logger.debug("tool response dispatched", {
        tool: name,
        session: this.requestId,
        bytes,
        ms: durationMs,
      });
      return {
        content: result.content,
        isError: result.isError,
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
        // Everything a tool returned is data from a downstream system: say so.
        _meta: { ...result._meta, ...contentTrustLabel(entryType) },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      bus.publish({
        tenantId: this.context.tenantId,
        type: "error",
        sessionId: this.requestId,
        username: this.context.username,
        tool: name,
        status: "error",
        durationMs: Date.now() - started,
        message,
      });
      // The full text may carry driver, host or SQL details; it goes to the
      // log and the monitor, the client gets a reference to look it up by.
      logger.error(`tool '${name}' failed (reference ${this.requestId}): ${message}`);
      return {
        content: [
          { type: "text", text: `Tool execution failed (reference ${this.requestId})` },
        ],
        isError: true,
      };
    }
  }
}

/** Build a fresh SDK MCP Server bound to a single authenticated connection. */
export function createMcpServer(ctx: AuthContext, sessionId: string, deps: McpServerDeps): Server {
  const instructions = deps.instructions?.();
  const dispatcher = new McpToolDispatcher(ctx, sessionId, deps);
  const server = new Server(
    { name: deps.serverConfig.name, version: deps.serverConfig.version },
    {
      capabilities: { tools: {} },
      ...(instructions !== undefined && instructions.length > 0 ? { instructions } : {}),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: dispatcher.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await dispatcher.callTool(
      {
        name: request.params.name,
        arguments: (request.params.arguments ?? {}) as Record<string, unknown>,
        _meta: (request.params as typeof request.params & { _meta?: Record<string, unknown> })
          ._meta,
      },
      extra.signal,
    );
    // The SDK's generated result union is wider than the stable ToolResult shape.
    return protocolToolResult(result) as CallToolResult;
  });
  return server;
}
