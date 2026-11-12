// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Agent tool conversion (`src/graph/agent-tools.ts`)
 *
 * Builds the Vercel AI SDK `ToolSet` an LLM node exposes to the model during
 * its agent loop, from the node's MCP tool references. Extracted from
 * `graph-engine.ts` so the orchestration core stays lean and the
 * security-sensitive tool boundary (approval gate + egress DLP + protected-
 * parameter injection) lives in one focused, testable place.
 *
 * Each tool's `parameters` is the FILTERED schema (protected params removed,
 * Req 7.2) and `execute` calls the MCP wrapper which re-injects protected
 * params from the request context (Req 7.4, 7.5). Two cross-cutting controls
 * wrap every call:
 *   - approval gate — a consequential tool must be human-approved first;
 *   - egress DLP    — outbound model-supplied args are scrubbed/denied for PII.
 *
 * No `any` at module boundaries.
 */

import { ToolJournalConflictError } from "../assistants/session-store.js";
import {
  tool,
  jsonSchema,
} from "ai";
import type {
  ToolSet,
  ToolExecutionOptions,
} from "ai";
import type {
  FlowNode,
} from "../types/flow.js";
import type { McpWrapperService } from "../mcp/mcp-wrapper.js";
import type { RequestContext } from "../types/monitoring.js";
import { applyStickyArgs, resolveForcedToolArgs } from "./tool-args-merge.js";
import { getPiiContextScope, getPiiToolBoundary } from "./pii-tool-boundary.js";
import { hasFindings } from "./output-guardrails.js";
import type { ToolOutputValidator } from "../mcp/tool-output-validator.js";
import { enforceTaintApproval, type TaintGuard } from "./execution-taint.js";
import { createLogger } from "../observability/logger.js";
import {
  CollectionCapabilityCache,
  NAVIGATION_TOOL_CAPABILITY,
  shouldHideTool,
} from "./collection-capabilities.js";
import {
  mcpToolResultToModelOutput,
  sanitizeToolResultOutput,
} from "./message-mapping.js";
import {
  resolveRefHandleArgs,
  type RefHandleArgResolution,
  type RefHandleRegistry,
} from "./ref-handles.js";
import {
  getTransactionOrchestrator,
  thrownToolOutcome,
} from "../transaction/orchestrator.js";
import { shouldIssueTransaction } from "../transaction/capabilities.js";
import {
  enrichToolArguments,
  groundToolResult,
  matchesToolContext,
  parseToolContextConfig,
} from "./tool-context.js";
import { renderTemplateAggressive } from "./classification-access.js";
import {
  createEvidenceActionContract,
  serializeEvidenceActionContract,
} from "../transaction/evidence-contract.js";
import {
  annotateVectorSearchCitations,
} from "./agent-tools-citations.js";
import {
  uniqueToolKey,
} from "./agent-tools-client.js";
import type {
  AgentApprovalHooks,
  AgentCitationHooks,
  AgentCompliancePolicyHooks,
  AgentEgressHooks,
  AgentToolJournalHooks,
} from "./agent-tools-hooks.js";
export type {
  AgentApprovalHooks,
  AgentCitationHooks,
  AgentCompliancePolicyHooks,
  AgentEgressHooks,
  AgentImageInspectionHooks,
  AgentMediaHooks,
  AgentToolJournalHooks,
} from "./agent-tools-hooks.js";
export {
  annotateVectorSearchCitations,
} from "./agent-tools-citations.js";
export {
  buildClientTools,
  buildToolSelectionMetaTool,
  mapToolChoice,
  uniqueToolKey,
} from "./agent-tools-client.js";
export {
  buildMediaTools,
  editMediaToolNames,
  uniqueMediaToolKey,
} from "./agent-tools-media.js";
export {
  buildImageInspectionTools,
} from "./agent-tools-image-inspection.js";

/**
 * Model-facing error for a tool call rejected by the ref-handle check. The
 * `unknown_ref_handle` shape is unchanged; `unregistered_ref` uses the same
 * form (isError/error/message + the rejected values) and tells the model how
 * to reach a neighbouring chapter correctly.
 */
function refHandleRejection(
  registry: RefHandleRegistry,
  resolution: Extract<RefHandleArgResolution, { ok: false }>,
): Record<string, unknown> {
  const valid =
    registry.list().length > 0
      ? registry
          .list()
          .map((i) => `${i.handle}`)
          .join(", ")
      : "(none retrieved yet — run a search first)";
  if (resolution.kind === "unknown_ref_handle") {
    return {
      isError: true,
      error: "unknown_ref_handle",
      message:
        `The reference handle(s) ${resolution.unknownHandles.join(", ")} are not valid. ` +
        "Use one of the handles exactly as shown in the tool results: " +
        valid,
      unknown_handles: resolution.unknownHandles,
    };
  }
  const values = resolution.unregisteredRefs.map((r) => r.value);
  const prefixes = Array.from(
    new Set(
      values
        .map(suggestedPathPrefix)
        .filter((prefix): prefix is string => prefix !== undefined),
    ),
  );
  const wayOut =
    prefixes.length > 0
      ? prefixes
          .map(
            (prefix) =>
              ` Call list_documents with path_prefix "${prefix}" and use the handle it returns for the chapter you need.`,
          )
          .join("")
      : " To read a neighbouring chapter of the same file, call list_documents with path_prefix set to its folder and use the handle it returns.";
  return {
    isError: true,
    error: "unregistered_ref",
    message:
      `The reference(s) ${values.join(", ")} were not returned by any tool in this run and are rejected. ` +
      "Do not build references from `link`, folder paths, chapter numbers or titles. " +
      "Use one of the handles exactly as shown in the tool results: " +
      valid +
      "." +
      wayOut +
      " Never build a reference yourself.",
    unregistered_refs: values,
    suggested_path_prefixes: prefixes,
  };
}

/**
 * A path segment that ends in a file extension (`….pdf`, `….docx`). The
 * extension must start with a letter, so numbered titles ("Kapitel 4.12")
 * are not mistaken for files.
 */
const FILE_SEGMENT = /\.[A-Za-z][A-Za-z0-9]{1,4}$/u;

/**
 * The `list_documents` path_prefix that lists the chapters next to a rejected,
 * model-built reference: the path up to and including the first segment with
 * a file extension (the file whose chapters are separate documents); without
 * such a segment the parent folder. Undefined for a value without `/`.
 */
export function suggestedPathPrefix(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.includes("/")) return undefined;
  const segments = trimmed.split("/");
  const fileIndex = segments.findIndex((segment) =>
    FILE_SEGMENT.test(segment.trim()),
  );
  if (fileIndex >= 0) {
    // A value that IS the file path (nothing after it) lists its own chapters.
    return segments.slice(0, fileIndex + 1).join("/");
  }
  const parent = trimmed.slice(0, trimmed.lastIndexOf("/"));
  return parent === "" ? undefined : parent;
}

const capabilityLog = createLogger("info");

let collectionCapabilityCache: CollectionCapabilityCache | undefined;
let collectionCapabilityCacheResolved = false;

/**
 * Module-level capabilities cache, built once from
 * `COLLECTION_CAPABILITY_TTL_MS` (default 300000, 0 disables the feature).
 * `buildAiTools` has no config parameter and its signature is fixed, so the
 * value is read from the environment on first use.
 */
function getCollectionCapabilityCache(): CollectionCapabilityCache | undefined {
  if (!collectionCapabilityCacheResolved) {
    collectionCapabilityCacheResolved = true;
    const raw = Number(process.env.COLLECTION_CAPABILITY_TTL_MS ?? 300_000);
    if (Number.isFinite(raw) && raw > 0) {
      collectionCapabilityCache = new CollectionCapabilityCache({ ttlMs: raw });
    }
  }
  return collectionCapabilityCache;
}

/**
 * Fetch `collection_stats` for one collection through the same MCP wrapper
 * path the tool loop uses, returning the result content as text for
 * `parseCollectionStats`. Throws on an error result so the cache stores it
 * as a negative entry.
 */
async function fetchCollectionStats(
  mcpWrapper: McpWrapperService,
  serverName: string,
  collection: string,
  ctx: RequestContext,
): Promise<string> {
  const result = await mcpWrapper.callTool(
    serverName,
    "collection_stats",
    { collection },
    ctx,
  );
  if (result.isError === true) {
    throw new Error("collection_stats returned an error result");
  }
  return typeof result.content === "string"
    ? result.content
    : JSON.stringify(result.content);
}

export async function buildAiTools(
  node: FlowNode,
  mcpWrapper: McpWrapperService,
  ctx: RequestContext,
  approval?: AgentApprovalHooks,
  egress?: AgentEgressHooks,
  toolOutputValidator?: ToolOutputValidator,
  _compliancePolicy?: AgentCompliancePolicyHooks,
  citations?: AgentCitationHooks,
  /**
   * `signal` is the flow's execution deadline, applied to every tool call the
   * model makes in the agent loop — without it an expired run keeps invoking
   * tools (and paying for them) after the client has been sent `[DONE]`.
   */
  opts?: {
    signal?: AbortSignal;
    /**
     * Per-execution memory of `config.stickyArgs` (see `applyStickyArgs`). The
     * engine passes one map for the whole run, so a value the model sets in one
     * node still applies in the next; absent, this builder keeps its own.
     */
    stickyArgs?: Map<string, unknown>;
    /** Runtime graph state exposed to forced tool-argument templates. */
    templateContext?: Record<string, unknown>;
    journal?: AgentToolJournalHooks;
    onEffectiveToolArgs?: (
      toolCallId: string,
      toolRef: string,
      args: Record<string, unknown>,
    ) => void | Promise<void>;
    executeToolCall?: (
      toolCallId: string,
      toolRef: string,
      args: Record<string, unknown>,
      execute: () => Promise<unknown>,
    ) => Promise<unknown>;
    /**
     * Run-scoped reference-handle registry (see `ref-handles.ts`). When set
     * (a node with `config.refHandles: true`), every tool result is scanned
     * for document references, the model is shown short handles instead of the
     * long real paths, and handle-valued arguments are resolved back to the
     * real reference before the MCP call. Absent → tool args/results flow
     * through unchanged (the default for every existing flow).
     */
    refHandles?: RefHandleRegistry;
    /**
     * Called when a tool call is rejected before the MCP call because of an
     * unknown handle or (strict mode) an unregistered, model-assembled
     * reference. Diagnostics only.
     */
    onRefHandleRejected?: (info: {
      toolCallId: string;
      toolRef: string;
      kind: "unknown_ref_handle" | "unregistered_ref";
      values: string[];
    }) => void;
    /**
     * Called on a resolution while the strict check is unavailable (the
     * registry's seen-reference cap overflowed). Callers deduplicate.
     */
    onRefStrictCheckDisabled?: () => void;
    /**
     * Run-scoped registry to OBSERVE (not mask) tool-result references on a
     * node without `config.refHandles`, so masking nodes of the same run accept
     * those real references. Ignored when `refHandles` is set.
     */
    refObserver?: RefHandleRegistry;
    /**
     * Injection taint rule. After a validator finding in this run, a tool
     * that is not declared read-only needs human approval before the call.
     * Absent → no taint enforcement.
     */
    taint?: TaintGuard;
    /**
     * Called with every successful tool result BEFORE the output validator
     * redacts it, so a Search `injection_risk: "suspected"` label taints the
     * run (see `injection-findings.ts` → `markTaintFromSearchLabels`).
     * Absent → Search labels are ignored in the agent loop.
     */
    onSearchInjectionLabel?: (
      sourceRef: string,
      content: unknown,
      resultMeta?: unknown,
    ) => void;
  },
): Promise<{
  tools: ToolSet;
  unavailable: string[];
  /** Why each unavailable tool's schema could not be fetched (keyed by tool ref). */
  unavailableReasons: Record<string, string>;
  keyByRef: Record<string, string>;
}> {
  const tools: ToolSet = {};
  const unavailable: string[] = [];
  const unavailableReasons: Record<string, string> = {};
  const keyByRef: Record<string, string> = {};

  // Per-tool forced arguments (`config.toolArgs[toolRef]`), merged OVER the
  // model-supplied args before every call. This is the `llm`-node counterpart
  // to `handlers/tool.ts`'s `resolveArgs` for deterministic `type: tool`
  // nodes: that mechanism lets a node fix e.g. `collection` server-side so a
  // multi-step MCP tool (like vectorsearch/search) always hits the right
  // store — but it only ever existed for `type: tool`, not for an `llm`
  // node's own agent tool-loop. A prompt instruction alone ("always set
  // collection to X") is not reliable enforcement: a local model can still
  // omit/mis-set the parameter, and the MCP server then silently falls back
  // to ITS OWN default collection instead of erroring loudly (observed trace
  // 52e73443: the researcher called vectorsearch/get_documents without a
  // valid `collection`, the server fell back to its internal default
  // ("doca"), and every read in that research step failed). Unlike
  // `tool.ts`'s `resolveArgs` (which fully REPLACES args — appropriate there
  // since a `type: tool` node has no model choosing params at all), this is a
  // MERGE: the model still supplies free-form args (query, limit, …), only
  // the explicitly configured keys are forced/overridden. Resolve templates
  // recursively against the same graph-state namespaces as deterministic tool
  // nodes so a scope such as {{classification.pathPrefix}} is enforced as its
  // concrete value rather than forwarded as a literal placeholder.
  const toolArgsCfg = (
    node.config as
      | { toolArgs?: Record<string, Record<string, unknown>> }
      | undefined
  )?.toolArgs;
  const substituteTemplates = (value: unknown): unknown => {
    if (typeof value === "string") {
      return opts?.templateContext !== undefined
        ? renderTemplateAggressive(value, opts.templateContext)
        : value;
    }
    if (Array.isArray(value)) return value.map(substituteTemplates);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(
          ([key, nested]) => [key, substituteTemplates(nested)],
        ),
      );
    }
    return value;
  };
  const stickyNames = (() => {
    const raw = (node.config as { stickyArgs?: unknown } | undefined)?.stickyArgs;
    return Array.isArray(raw)
      ? raw.filter((name): name is string => typeof name === "string" && name !== "")
      : undefined;
  })();
  const stickyStore = opts?.stickyArgs ?? new Map<string, unknown>();
  const toolContext = parseToolContextConfig(
    node.config as Record<string, unknown> | undefined,
  );

  for (const toolRef of node.tools ?? []) {
    const parts = toolRef.split("/");
    const serverName = parts.length >= 2 ? (parts[0] ?? toolRef) : toolRef;
    const bareName = parts.length >= 2 ? parts.slice(1).join("/") : toolRef;

    let filtered: Awaited<ReturnType<typeof mcpWrapper.getFilteredToolSchema>>;
    try {
      filtered = await mcpWrapper.getFilteredToolSchema(serverName, bareName, {
        authToken: ctx.ssoToken,
      });
    } catch (err) {
      // Skip tools whose schema cannot be fetched, but remember them (and why)
      // so the caller can tell the model the tool is unavailable and record the
      // cause for operators. Wrapper errors carry no token material.
      unavailable.push(toolRef);
      unavailableReasons[toolRef] = (
        err instanceof Error ? err.message : String(err)
      ).slice(0, 300);
      continue;
    }

    // Forced arguments for THIS tool, merged over the `"*"` and `"<server>/*"`
    // entries (see `tool-args-merge.ts`). Computed after the schema fetch
    // because a wildcard may only set arguments the tool actually declares.
    const declaredProps =
      filtered.inputSchema.properties === undefined ||
      filtered.inputSchema.properties === null
        ? undefined
        : new Set(Object.keys(filtered.inputSchema.properties));
    const forcedArgs = resolveForcedToolArgs(
      toolArgsCfg,
      toolRef,
      declaredProps,
      substituteTemplates,
    );

    // Hide Search navigation tools the pinned collection cannot serve
    // (`collection_stats.capabilities`, cached per server/collection,
    // fail-open on any error). Only a collection pinned through `toolArgs`
    // is checked — a model-chosen collection stays fully visible.
    const pinnedCollection =
      typeof forcedArgs?.collection === "string" &&
      forcedArgs.collection.length > 0
        ? forcedArgs.collection
        : undefined;
    if (
      pinnedCollection !== undefined &&
      NAVIGATION_TOOL_CAPABILITY[bareName] !== undefined
    ) {
      const capabilityCache = getCollectionCapabilityCache();
      if (capabilityCache !== undefined) {
        const caps = await capabilityCache.get(
          serverName,
          pinnedCollection,
          () =>
            fetchCollectionStats(mcpWrapper, serverName, pinnedCollection, ctx),
        );
        const hiddenCapability = shouldHideTool(bareName, caps);
        if (hiddenCapability !== undefined) {
          // No node-diagnostic channel reaches this builder, so the same
          // code and text go to the info log for operators.
          capabilityLog.info(
            `${toolRef} hidden: collection "${pinnedCollection}" has no ${hiddenCapability}`,
            { level: "info", code: "tool_hidden_by_capability" },
          );
          continue;
        }
      }
    }

    // Namespaced, collision-free, AI-SDK-valid tool key.
    const key = uniqueToolKey(tools, serverName, bareName);
    keyByRef[toolRef] = key;

    // Approval is intentionally server-driven for MCP actions. mcpgate evaluates
    // its GovernancePolicy and, only when needed, responds with the opaque
    // `input_required` continuation handled below. Aiperator never creates a
    // second pre-action approval decision for the same tool call.

    // `ToolSet`'s value union requires INPUT/OUTPUT to be `any`/`never` (it is
    // a heterogeneous record of differently-shaped tools), so the concretely
    // typed `Tool<Record<string, unknown>, unknown, never>` built by `tool()`
    // is cast to `ToolSet[string]` at the point of insertion — the standard
    // AI SDK pattern for a dynamically-keyed tool map (see the `metaTool`
    // assignment below, which does the same for the same reason).
    tools[key] = tool<Record<string, unknown>, unknown, never>({
      description: filtered.description ?? `MCP tool ${toolRef}`,
      inputSchema: jsonSchema<Record<string, unknown>>({
        type: "object",
        properties: filtered.inputSchema.properties as Record<string, never>,
        ...(filtered.inputSchema.required
          ? { required: filtered.inputSchema.required }
          : {}),
      }),
      // Preserve MCP image content as an actual AI SDK file/image part in the
      // next agent step instead of JSON-stringifying the base64 payload.
      toModelOutput: ({ output }) =>
        mcpToolResultToModelOutput(sanitizeToolResultOutput(output)),
      execute: async (
        modelArgs: Record<string, unknown>,
        toolOptions: ToolExecutionOptions<never>,
      ): Promise<unknown> => {
        // Force configured args over the model-supplied ones BEFORE anything
        // else touches them, so the required-params guard, the approval-gate
        // audit record, and egress scrubbing all see (and log) the final,
        // enforced values — never the model's un-overridden originals.
        // Order: model < sticky < toolArgs. A value the model set earlier in
        // this execution (config.stickyArgs) is enforced on later calls;
        // flow-author `toolArgs` still win over it.
        const stickyApplied = applyStickyArgs(
          stickyNames,
          stickyStore,
          modelArgs,
          declaredProps,
        );
        let args =
          forcedArgs !== undefined || Object.keys(stickyApplied).length > 0
            ? { ...modelArgs, ...stickyApplied, ...forcedArgs }
            : modelArgs;
        // Ref-handle indirection (config.refHandles): the model quotes short
        // handles (K3NQ) where a long document reference belongs, because
        // small models cannot copy verbatim paths reliably (trace 55c5b138).
        // Resolve them back to the real reference BEFORE the required-params
        // guard, egress DLP, and the audit/journal trail — every downstream
        // consumer (including the MCP server) sees only real references, never
        // a handle. A handle-shaped argument that was never registered is the
        // hallucination this feature exists to catch: reject it with the valid
        // list instead of forwarding a value the tool would silently miss.
        // Real paths (not handle-shaped) are not rewritten. Without
        // refHandles (non-masking nodes) they pass through unchanged.
        // Strict mode (always on here, refHandles nodes only): on a masking
        // node every genuine reference reaches the model as a handle, so a
        // path-shaped value no tool result of this run contained was
        // assembled by the model (e.g. `link` + chapter title, trace
        // 42474444) — reject it the same way, before the MCP call. This
        // includes paths that appear only in the user's message or the system
        // prompt: they were never returned by a tool and are rejected too.
        // Flow-author forced args (`config.toolArgs`) are exempt.
        if (opts?.refHandles !== undefined) {
          if (!opts.refHandles.strictCheckAvailable()) {
            opts.onRefStrictCheckDisabled?.();
          }
          const handleResolution = resolveRefHandleArgs(opts.refHandles, args, {
            strict: true,
            exemptKeys: new Set(Object.keys(forcedArgs ?? {})),
          });
          if (handleResolution.ok === false) {
            const rejectedValues =
              handleResolution.kind === "unknown_ref_handle"
                ? handleResolution.unknownHandles
                : handleResolution.unregisteredRefs.map((r) => r.value);
            opts.onRefHandleRejected?.({
              toolCallId: toolOptions.toolCallId,
              toolRef,
              kind: handleResolution.kind,
              values: rejectedValues,
            });
            return refHandleRejection(opts.refHandles, handleResolution);
          }
          args = handleResolution.args;
        }
        // Required-parameter guard: the JSON-Schema `required` array is a hint
        // to the LLM but is NOT enforced by the AI SDK before invoking
        // execute(). Catch missing/null/empty required fields here so the model
        // receives a structured, actionable error and can self-correct instead
        // of forwarding an incomplete call to the MCP server.
        const requiredFields = filtered.inputSchema.required ?? [];
        const missing = requiredFields.filter(
          (k) => args[k] === undefined || args[k] === null || args[k] === "",
        );
        if (missing.length > 0) {
          return {
            isError: true,
            error: "missing_required_params",
            message: `Tool '${toolRef}' requires: ${missing.join(", ")}. Provide all required parameters and try again.`,
            required: missing,
          };
        }

        // Egress DLP: scrub PII/secrets out of the model-supplied arguments
        // before they leave to the external tool. In "block" mode a tool call
        // carrying detected PII is denied (the model gets a notice and can
        // adapt); in "redact" mode the scrubbed args are forwarded.
        let outboundArgs = args;
        if (egress !== undefined) {
          const scrubbed = egress.guardrail.scrub(args);
          if (hasFindings(scrubbed.findings)) {
            egress.onFindings?.(toolRef, scrubbed.findings);
            if (egress.guardrail.mode === "block") {
              return {
                isError: true,
                error: "egress_blocked",
                message:
                  "The tool call was blocked because its arguments contained " +
                  "sensitive data (PII or secrets) that may not leave the platform.",
              };
            }
            outboundArgs = scrubbed.args;
          }
        }
        // Injection taint: earlier content in this run was flagged by the
        // injection scan, so a write tool must be confirmed by a human. Read-
        // only tools skip this entirely (no extra latency, no behaviour change).
        if (opts?.taint?.taint.tainted === true) {
          const taintDecision = await enforceTaintApproval(opts.taint, {
            toolRef,
            nodeId: node.id,
            args: outboundArgs,
            annotations: filtered.annotations,
            ctx,
          });
          if (!taintDecision.allowed) {
            return {
              isError: true,
              error: "approval_denied",
              message: taintDecision.reason,
              tainted: true,
            };
          }
        }
        const contextualized = await enrichToolArguments(
          mcpWrapper,
          toolContext,
          toolRef,
          outboundArgs,
          ctx,
          opts?.signal,
        );
        outboundArgs = contextualized.args;
        await opts?.onEffectiveToolArgs?.(
          toolOptions.toolCallId,
          toolRef,
          outboundArgs,
        );
        const executePrepared = async (): Promise<unknown> => {
          // PII vault at the tool boundary (ADR 0036). Everything above — the
          // egress DLP, the taint and approval decisions, the effective-args
          // trace — worked on `outboundArgs`, which still carry the vault's
          // placeholders. For a tool on PII_VAULT_DETOKENIZE_TOOLS the real
          // values are put back here, so the evidence contract, the
          // transaction token and the wire call agree on what is sent.
          // `outboundArgs` itself stays untouched: the audit record, the tool
          // journal and the result bookkeeping below keep the placeholder form.
          const piiBoundary = getPiiToolBoundary();
          const callArgs =
            piiBoundary !== undefined
              ? await piiBoundary.detokenizeArgs(
                  toolRef,
                  ctx.executionId,
                  outboundArgs,
                )
              : outboundArgs;
          const argsDetokenized = callArgs !== outboundArgs;
          const contractConfig = toolContext?.evidenceContract;
          const evidenceBound =
            contractConfig !== undefined &&
            toolContext !== undefined &&
            toolRef !== `${toolContext.server}/${toolContext.tool}` &&
            matchesToolContext(contractConfig.match, toolRef);
          const evidenceContract =
            evidenceBound && contractConfig !== undefined
              ? (() => {
                  const contract = createEvidenceActionContract(
                    bareName,
                    callArgs,
                    contextualized.evidence,
                  );
                  if (contract === undefined && contractConfig.required) {
                    throw new Error(
                      `Verified evidence is required before '${toolRef}' can run.`,
                    );
                  }
                  return contract === undefined
                    ? undefined
                    : serializeEvidenceActionContract(contract);
                })()
              : undefined;
          const wirePreparation =
            evidenceContract !== undefined &&
            mcpWrapper.prepareEvidenceActionContract !== undefined
              ? await mcpWrapper.prepareEvidenceActionContract(
                  serverName,
                  bareName,
                  callArgs,
                  ctx,
                  evidenceContract,
                )
              : undefined;
          const wireEvidenceContract =
            wirePreparation?.evidenceContract ?? evidenceContract;
          const wireArgs = wirePreparation?.args ?? callArgs;
          const invocationId: string =
            toolOptions.toolCallId ?? crypto.randomUUID();
          const transactionEnabled = await shouldIssueTransaction(
            mcpWrapper,
            serverName,
            process.env,
            // Negotiate on the same session the call will use (forwardAuthToken).
            { authToken: ctx.ssoToken },
          );
          // Token-exchange peers authenticate the EXCHANGED subject, not the
          // caller's login `sub`; the envelope must bind the same identity.
          const targetUserId = transactionEnabled
            ? await mcpWrapper.targetSubject?.(serverName, ctx.ssoToken)
            : undefined;
          const transactionInvocation = transactionEnabled
            ? await getTransactionOrchestrator()?.begin(
                ctx,
                serverName,
                toolRef,
                invocationId,
                {
                  payload: {
                    action: wireArgs,
                    ...(wireEvidenceContract !== undefined
                      ? {
                          actionContractHash:
                            wireEvidenceContract.actionContractHash,
                          evidenceContractHash:
                            wireEvidenceContract.actionContractHash,
                        }
                      : {}),
                  },
                  ...(wireEvidenceContract !== undefined
                    ? {
                        actionContractHash:
                          wireEvidenceContract.actionContractHash,
                        evidenceContractHash:
                          wireEvidenceContract.actionContractHash,
                      }
                    : {}),
                  bindSession:
                    mcpWrapper.forwardsCallerSession?.(serverName) ?? true,
                  ...(targetUserId !== undefined
                    ? { userId: targetUserId }
                    : {}),
                },
              )
            : undefined;
          const journal = opts?.journal;
          // Providers only guarantee tool call ids to be unique inside one
          // response, while the journal is keyed per conversation and a
          // conversation spans many executions. Scoping the durable id to this
          // execution keeps at-most-once protection where it belongs and stops a
          // reused id (short numeric ids are common) from colliding with a
          // settled row of an earlier turn.
          const journalCallId =
            journal === undefined
              ? invocationId
              : `${journal.executionId}:${invocationId}`;
          // Bookkeeping that runs *after* the external call must never discard the
          // real outcome: the side effect already happened, so a lost race on the
          // journal row is recorded, not raised.
          const settleJournal = async (
            settle: () => Promise<unknown>,
          ): Promise<void> => {
            try {
              await settle();
            } catch (error) {
              if (!(error instanceof ToolJournalConflictError)) throw error;
            }
          };
          // This commit is intentionally immediately before the external call. If it
          // fails, do not perform a side effect we could not recover or audit.
          await journal?.journal.beforeTool({
            scope: journal.scope,
            conversationId: journal.conversationId,
            executionId: journal.executionId,
            toolCallId: journalCallId,
            tool: toolRef,
            // The journal is durable: it records the placeholder form when the
            // wire arguments carry real values put back at the PII boundary.
            args: argsDetokenized ? outboundArgs : wireArgs,
            operationId: journalCallId,
          });
          // `running` is distinct from `pending`: a crash between the durable intent
          // and transport dispatch remains recoverable as pending; once dispatched a
          // lease makes competing workers fail closed until recovery marks it unknown.
          const started = await journal?.journal.startTool?.({
            scope: journal.scope,
            conversationId: journal.conversationId,
            toolCallId: journalCallId,
            workerId: ctx.executionId,
          });
          // A lost race or a recovered lease is a fail-closed outcome: executing
          // anyway would turn a durable at-most-once intent into a duplicate side
          // effect. Non-durable journals return undefined and retain legacy flow.
          if (started === false) {
            return {
              isError: true,
              error: "tool_lease_unavailable",
              message:
                "This tool operation is already owned by another worker or is being recovered.",
            };
          }
          let result: Awaited<ReturnType<typeof mcpWrapper.callTool>>;
          try {
            result = await mcpWrapper.callTool(
              serverName,
              bareName,
              wireArgs,
              ctx,
              opts?.signal !== undefined
                ? {
                    signal: opts.signal,
                    invocationId,
                    transaction: transactionInvocation?.transaction,
                    ...(wireEvidenceContract !== undefined
                      ? { evidenceContract: wireEvidenceContract }
                      : {}),
                    ...(wirePreparation !== undefined
                      ? {
                          preparedEvidenceCallId:
                            wirePreparation.preparedCallId,
                        }
                      : {}),
                  }
                : {
                    invocationId,
                    transaction: transactionInvocation?.transaction,
                    ...(wireEvidenceContract !== undefined
                      ? { evidenceContract: wireEvidenceContract }
                      : {}),
                    ...(wirePreparation !== undefined
                      ? {
                          preparedEvidenceCallId:
                            wirePreparation.preparedCallId,
                        }
                      : {}),
                  },
            );

            // MCP-2026 server-driven approvals are deliberately handled only
            // after the original call. Aiperator does not make a preceding local
            // policy decision and never substitutes for the server's opaque
            // requestState decision.
            while (result.resultType === "input_required") {
              await settleJournal(async () =>
                journal?.journal.markAwaitingApproval?.({
                  scope: journal.scope,
                  conversationId: journal.conversationId,
                  toolCallId: journalCallId,
                }),
              );
              const request = result.inputRequests?.find(
                (item) => item.type === "approval",
              );
              if (
                request === undefined ||
                result.resolveApproval === undefined
              ) {
                await transactionInvocation?.complete("failed", result.content);
                return {
                  isError: true,
                  error: "approval_denied",
                  message:
                    "The MCP server requested approval, but no supported approval continuation was available.",
                };
              }
              if (approval === undefined) {
                await result.resolveApproval(request, { decision: "denied" });
                await transactionInvocation?.complete(
                  "failed",
                  "approval gate unavailable",
                );
                return {
                  isError: true,
                  error: "approval_denied",
                  message:
                    "The MCP server requested human approval, but no approval UI is configured.",
                };
              }
              const expiresAtMs =
                request.expiresAt === undefined
                  ? Number.NaN
                  : Date.parse(request.expiresAt);
              const timeoutMs = Number.isFinite(expiresAtMs)
                ? Math.max(
                    1,
                    Math.min(approval.gate.timeoutMs, expiresAtMs - Date.now()),
                  )
                : undefined;
              const decision = await approval.gate.request(
                {
                  executionId: ctx.executionId,
                  nodeId: node.id,
                  tool: toolRef,
                  args: outboundArgs,
                  title: request.title,
                  message: request.message,
                  ...(request.fields !== undefined
                    ? { fields: request.fields }
                    : {}),
                  ...(request.expiresAt !== undefined
                    ? { expiresAt: request.expiresAt }
                    : {}),
                  ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                  ...(ctx.clientId !== undefined
                    ? { tenantId: ctx.clientId }
                    : {}),
                  ...((ctx.userName ?? ctx.userEmail ?? ctx.userId) !==
                  undefined
                    ? {
                        requestedBy:
                          ctx.userName ?? ctx.userEmail ?? ctx.userId,
                      }
                    : {}),
                },
                approval.notify,
              );
              approval.onDecision?.(toolRef, decision.approved);
              let resumed: Awaited<
                ReturnType<NonNullable<typeof result.resolveApproval>>
              >;
              if (decision.approved) {
                resumed = await result.resolveApproval(request, {
                  decision: "approved",
                  ...(decision.by !== undefined
                    ? { approver: decision.by }
                    : {}),
                });
              } else {
                // Denial is fail-closed locally. Notify the server best-effort,
                // but never turn a human denial/timeout into an opaque transport
                // exception for the model.
                try {
                  await result.resolveApproval(request, {
                    decision: "denied",
                    ...(decision.by !== undefined
                      ? { approver: decision.by }
                      : {}),
                  });
                } catch {
                  // The action is already denied and must not be retried.
                }
                await transactionInvocation?.complete(
                  "failed",
                  decision.reason,
                );
                await settleJournal(async () =>
                  journal?.journal.cancelTool?.({
                    scope: journal.scope,
                    conversationId: journal.conversationId,
                    toolCallId: journalCallId,
                    reason:
                      decision.reason ??
                      "The requested action was not approved by a human reviewer.",
                  }),
                );
                return {
                  isError: true,
                  error: "approval_denied",
                  message:
                    decision.reason ??
                    "The requested action was not approved by a human reviewer.",
                  ...(decision.timedOut === true ? { timedOut: true } : {}),
                };
              }
              // Approval clears the old lease while a human is deciding. Acquire a
              // new one before continuing the opaque server-side invocation.
              const resumedJournal =
                await journal?.journal.resumeApprovedTool?.({
                  scope: journal.scope,
                  conversationId: journal.conversationId,
                  toolCallId: journalCallId,
                });
              if (resumedJournal === false) {
                await transactionInvocation?.complete(
                  "failed",
                  "approved journal continuation was no longer claimable",
                );
                return {
                  isError: true,
                  error: "tool_lease_unavailable",
                  message:
                    "The approved tool operation is no longer claimable for continuation.",
                };
              }
              const resumedLease = await journal?.journal.startTool?.({
                scope: journal.scope,
                conversationId: journal.conversationId,
                toolCallId: journalCallId,
                workerId: ctx.executionId,
              });
              if (resumedLease === false) {
                await transactionInvocation?.complete(
                  "failed",
                  "approved journal continuation lease was unavailable",
                );
                return {
                  isError: true,
                  error: "tool_lease_unavailable",
                  message:
                    "The approved tool operation could not acquire a continuation lease.",
                };
              }
              if (resumed === undefined) {
                await transactionInvocation?.complete(
                  "failed",
                  "approved continuation returned no result",
                );
                return {
                  isError: true,
                  error: "approval_denied",
                  message: "The approved MCP action could not be resumed.",
                };
              }
              result = resumed;
            }
          } catch (error) {
            await transactionInvocation?.complete(
              thrownToolOutcome(bareName),
              error,
            );
            await settleJournal(async () =>
              journal?.journal.completeTool({
                scope: journal.scope,
                conversationId: journal.conversationId,
                toolCallId: journalCallId,
                succeeded: false,
                error,
              }),
            );
            throw error;
          }
          await transactionInvocation?.complete(
            result.isError === true ? "failed" : "committed",
            result.isError === true ? result.content : undefined,
          );
          await settleJournal(async () =>
            journal?.journal.completeTool({
              scope: journal.scope,
              conversationId: journal.conversationId,
              toolCallId: journalCallId,
              succeeded: result.isError !== true,
              result: result.content,
              ...(result.isError === true ? { error: result.content } : {}),
            }),
          );

          // Preserve MCP's error envelope for the model and trace pipeline. Returning
          // only `result.content` used to discard `isError`, so failed calls appeared
          // as `result: null, is_error: false` and synthetic tool nodes completed OK.
          let content: unknown =
            result.isError === true || result.retry !== undefined
              ? {
                  ...(result.isError === true ? { isError: true } : {}),
                  content: result.content,
                  ...(result.retry !== undefined
                    ? { retry: result.retry }
                    : {}),
                  ...(result.structuredContent !== undefined
                    ? { structuredContent: result.structuredContent }
                    : {}),
                }
              : result.content;
          content = await groundToolResult(
            mcpWrapper,
            toolContext,
            toolRef,
            outboundArgs,
            content,
            ctx,
            opts?.signal,
          );
          // Search labels its stored text itself; a `suspected` label taints the
          // run even when the runtime's own regex scan misses the payload.
          // Scanned before redaction so the label is still inside the payload.
          opts?.onSearchInjectionLabel?.(toolRef, content, result._meta);
          if (toolOutputValidator?.enabled) {
            content = toolOutputValidator.validate(content, toolRef).content;
          }

          // Self-search citations: if this is a vectorsearch payload and a
          // citation sink is wired, register the retrieved documents (assigning a
          // global [n], deduped against earlier grounding) and annotate the
          // result the model reads with those numbers so it can cite them inline.
          // A no-op for non-vectorsearch tools (parse yields no documents).
          if (citations !== undefined) {
            content = await annotateVectorSearchCitations(content, citations, {
              toolRef,
              args: outboundArgs,
            });
          }

          // Ref-handle masking (config.refHandles) — deliberately LAST, after
          // citation registration above: the CitationRegistry and the client's
          // `sources` must receive the REAL references, and only the copy the
          // MODEL reads gets the short handles. Registering from the payload
          // first makes every document identity in the result (reference/ref/
          // base_ref, incl. inside MCP text-part JSON) resolvable before the
          // substitution. The user never sees a handle: the SSE layer maps them
          // back to real references on the way out.
          if (opts?.refHandles !== undefined) {
            opts.refHandles.registerFromPayload(content);
            content = opts.refHandles.maskContent(content);
          } else {
            // Non-masking node in a run that masks elsewhere: remember the real
            // references it saw, so a masking node that later quotes one of
            // them (via findings/state) is not rejected as unregistered.
            opts?.refObserver?.observeFromPayload(content);
          }

          // PII_VAULT_SCOPE=messages+context (ADR 0036, step 4): what the
          // model reads is tokenized LAST — the citation registry and the
          // ref-handle registry above saw the real values, the model and the
          // stored tool result do not.
          const piiScope = getPiiContextScope();
          if (piiScope !== undefined) {
            content = await piiScope.tokenizeValue(ctx, content);
          }

          return content;
        };
        return opts?.executeToolCall !== undefined
          ? opts.executeToolCall(
              toolOptions.toolCallId,
              toolRef,
              outboundArgs,
              executePrepared,
            )
          : executePrepared();
      },
    }) as ToolSet[string];
  }

  return { tools, unavailable, unavailableReasons, keyByRef };
}
