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

import type { AssistantScope } from "../assistants/types.js";
import type { AssistantToolJournal } from "../assistants/session-store.js";
import { ToolJournalConflictError } from "../assistants/session-store.js";
import { tool, jsonSchema, generateText } from "ai";
import type {
  ToolSet,
  ToolExecutionOptions,
  ToolChoice as AiToolChoice,
} from "ai";
import type {
  FlowNode,
  MediaToolConfig,
  ImageInspectionConfig,
} from "../types/flow.js";
import type { OpenAITool, ToolChoice } from "../types/openai.js";
import type { McpWrapperService } from "../mcp/mcp-wrapper.js";
import type { RequestContext } from "../types/monitoring.js";
import type { ApprovalRegistry, PendingApproval } from "./approval-gate.js";
import type { ToolEgressGuardrail } from "./output-guardrails.js";
import { hasFindings } from "./output-guardrails.js";
import type { ToolOutputValidator } from "../mcp/tool-output-validator.js";
import { enforceTaintApproval, type TaintGuard } from "./execution-taint.js";
import type { AppConfig } from "../config/index.js";
import type { CompliancePolicy } from "../compliance/policy-schema.js";
import type { LlmProviderFactory, ProviderResolution, UsageAccumulator } from "./graph-engine.js";
import type { ToolIndex } from "./tool-index.js";
import type {
  GenAiRequest,
  GenAiResponse,
} from "../observability/gen-ai-semconv.js";
import type {
  SpendRecorder,
  CostAttribution,
  ModelPrice,
} from "../observability/cost.js";
import type { Metrics } from "../observability/metrics.js";
import { estimateCost } from "../observability/cost.js";
import { filterLlmParameters } from "./llm-factory.js";
import type { Citation, CitationEvidence } from "../types/openai.js";
import {
  parseVectorSearchResults,
  parseVectorSearchSummaries,
} from "./reranker.js";
import { buildCitationEntries } from "./rag-grounding.js";
import {
  mcpToolResultToModelOutput,
  sanitizeToolResultOutput,
} from "./message-mapping.js";
import {
  IMAGE_INSPECTION_TOOL_NAME,
  parseAssetReference,
  type ImageRefRegistry,
} from "./image-reference.js";
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

/** Approval-gate wiring passed to {@link buildAiTools}. */
export interface AgentApprovalHooks {
  gate: ApprovalRegistry;
  notify?: (pending: PendingApproval) => void;
  onDecision?: (toolRef: string, approved: boolean) => void;
}

/** Egress-DLP wiring passed to {@link buildAiTools}. */
export interface AgentEgressHooks {
  guardrail: ToolEgressGuardrail;
  onFindings?: (toolRef: string, findings: Record<string, number>) => void;
}

/**
 * Citation wiring passed to {@link buildAiTools}. When present, a vectorsearch
 * tool result the MODEL fetched itself (search / get_summaries) is registered
 * in the per-execution citation registry — assigning each document a GLOBAL
 * `[n]` (deduplicated against any grounding node that ran earlier) — and the
 * result the model reads is annotated with those numbers so it can cite the
 * self-fetched sources inline as `[n]`, exactly like injected grounding.
 * Absent → tool results are returned unchanged (no self-search citations).
 */
export interface AgentCitationHooks {
  register: (
    entries: { key: string; citation: Citation }[],
  ) => Promise<number[]>;
}

/**
 * Legacy flow-policy wiring retained for call-site compatibility. MCP actions
 * no longer consult this policy locally: approval authority is mcpgate only.
 */
export interface AgentCompliancePolicyHooks {
  policy: CompliancePolicy;
  flowId?: string;
}

/**
 * Wiring for media-generation tools (see {@link buildMediaTools}).
 *
 * A media tool runs a dedicated generation model (its own {@link MediaToolConfig.llm})
 * when the hosting LLM calls it, then streams the produced media back to the
 * client via {@link AgentMediaHooks.emit}. Instantiating the generation model
 * reuses the same provider factory + app config + per-request key resolution as
 * the hosting node, so BYOK/pooled keys apply uniformly.
 */
export interface AgentMediaHooks {
  appConfig: AppConfig;
  llmProviderFactory: LlmProviderFactory;
  /**
   * The flow's execution-deadline signal (`ExecRuntime.signal`), bound into
   * the media-generation call so a hung provider request does not outlive the
   * engine's timeout. See `ExecRuntime.signal` for the full reasoning.
   */
  signal?: AbortSignal;
  /**
   * Effective per-model token prices for the hosting flow (flow `pricing`
   * merged over `appConfig.llmPricing`). Preferred over `appConfig.llmPricing`
   * alone so a flow-declared price for a model unknown to the global/built-in
   * table is honoured — otherwise cost estimates for that model silently come
   * out as $0 and are never recorded.
   */
  pricingOverrides?: Record<string, ModelPrice>;
  /** Per-request provider-key resolution (BYOK / rotation pool). */
  resolution?: ProviderResolution;
  /**
   * Persists a produced media payload (base64) and returns a short public URL
   * to it, or undefined when media serving is not configured. When a URL is
   * returned, the tool emits a tiny `![](url)` markdown image instead of a
   * megabyte-long data-URI — which Open WebUI cannot render (open-webui#16976).
   */
  publishMedia?: (base64: string, mediaType: string) => string | undefined;
  /**
   * Streams a chunk of produced media (a markdown data-URI image, possibly
   * pre-chunked by the caller) to the client. Mirrors the native image-gen
   * path so generated media renders inline in Open WebUI and CommonMark clients.
   */
  emit: (token: string) => Promise<void>;
  /**
   * Captures GenAI OTel attributes for the synthetic tool-call node so the
   * monitoring dashboard can show which media model was used and how many
   * tokens it consumed. Called with the AI SDK `toolCallId` so the data is
   * attributed to the `generate_image` node rather than the hosting LLM node.
   * Optional — a no-op when monitoring is not wired.
   */
  setGenAiAttributes?: (
    nodeId: string,
    req?: GenAiRequest,
    res?: GenAiResponse,
  ) => void;
  /** Optional per-tenant spend recorder so media-generation costs are included
   * in budget accounting alongside regular LLM calls. */
  costTracker?: SpendRecorder;
  /** Metrics sink for recording the media LLM call statistics. */
  metrics?: Metrics;
  /** Tenant identifier forwarded to {@link costTracker} (may be undefined for
   * single-tenant deployments). */
  clientId?: string;
  /**
   * User/flow attribution forwarded to {@link costTracker} so media-generation
   * spend is broken down per user and per flow like regular LLM calls.
   */
  costAttribution?: CostAttribution;
  /**
   * Reports the final arguments this local tool executes with, as key-value
   * JSON. Local tools run server-side and have no egress DLP, so the model's
   * raw arguments ARE the effective ones — but the engine's `onToolCall`
   * telemetry only records `argument_keys` (pre-DLP policy). Firing this hook
   * lets the live graph / debug trace show the real `{ prompt }` payload
   * instead of the key-only placeholder, mirroring the MCP tool path
   * (`onEffectiveToolArgs` in the MCP execute wrapper).
   */
  onEffectiveArgs?: (
    toolCallId: string,
    toolName: string,
    argsJson: string,
  ) => void | Promise<void>;
}

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

/**
 * Builds an AI SDK ToolSet from a node's MCP tool references.
 *
 * Tool keys are namespaced by server (`server__tool`) and sanitised to a valid
 * AI SDK identifier so that two MCP servers exposing a tool with the same bare
 * name do not collide (which would silently shadow one of them). Any residual
 * collision after sanitisation is disambiguated with a numeric suffix.
 *
 * Returns the built {@link ToolSet} plus the list of requested tool refs whose
 * schema could not be fetched (server down / not connected / unknown tool).
 * The caller surfaces these to the model so it degrades gracefully instead of
 * calling a tool that isn't bound (which the AI SDK rejects as a hard error).
 *
 * Also returns `keyByRef`, mapping each bound tool ref (`server/tool`) to the
 * namespaced AI SDK key it was registered under. Dynamic Tool Retrieval uses
 * this to translate semantically-selected refs into the `activeTools` keys that
 * gate which of the (fully bound) tools the model actually sees.
 */
export interface AgentToolJournalHooks {
  journal: AssistantToolJournal;
  scope: AssistantScope;
  conversationId: string;
  executionId: string;
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
  const toolContext = parseToolContextConfig(
    node.config as Record<string, unknown> | undefined,
  );

  for (const toolRef of node.tools ?? []) {
    const parts = toolRef.split("/");
    const serverName = parts.length >= 2 ? (parts[0] ?? toolRef) : toolRef;
    const bareName = parts.length >= 2 ? parts.slice(1).join("/") : toolRef;
    const configuredArgs = toolArgsCfg?.[toolRef];
    const forcedArgs =
      configuredArgs !== undefined
        ? (substituteTemplates(configuredArgs) as Record<string, unknown>)
        : undefined;

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
        let args =
          forcedArgs !== undefined
            ? { ...modelArgs, ...forcedArgs }
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
                    outboundArgs,
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
                  outboundArgs,
                  ctx,
                  evidenceContract,
                )
              : undefined;
          const wireEvidenceContract =
            wirePreparation?.evidenceContract ?? evidenceContract;
          const wireArgs = wirePreparation?.args ?? outboundArgs;
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
            args: wireArgs,
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

/**
 * Prepends a citation-numbering note to a vectorsearch tool result the model
 * fetched itself, so it can cite the self-fetched documents inline as `[n]` —
 * the same numbering scheme the injected grounding uses. Registers each
 * document under its stable key (base_ref → url → title) in the per-execution
 * registry, which assigns the GLOBAL `[n]` (reusing an existing number when the
 * document was already surfaced by a grounding node earlier in the stream).
 *
 * Returns the content UNCHANGED when it is not a vectorsearch document
 * payload. Search/get_summaries are identified from their response envelope;
 * get_document/get_documents/get_summary additionally use the called tool and
 * its reference arguments because full-document responses may omit identity.
 * The note is appended as an extra text part (MCP text-content array) or as a
 * text suffix (string content), preserving the original JSON at the front.
 *
 * Exported for unit testing.
 */
export async function annotateVectorSearchCitations(
  content: unknown,
  citations: AgentCitationHooks,
  context?: {
    toolRef: string;
    args: Record<string, unknown>;
  },
): Promise<unknown> {
  const chunks = parseVectorSearchResults(content);
  const summaries = parseVectorSearchSummaries(content);
  const parsedEntries = buildCitationEntries(chunks, summaries);

  // Full-document tools do not use the search/get_summaries envelope parsed
  // above. In particular, get_document commonly returns only {title, content};
  // its stable identity is the `reference` argument of the tool call. Without
  // this bridge the model sees the original text but no GLOBAL [n], invents a
  // local [1], and Open WebUI cannot match that marker to sources[index].
  const explicitEntries: { key: string; citation: Citation }[] = [];
  if (context?.toolRef.startsWith("vectorsearch/") === true) {
    let payload: unknown = content;
    try {
      if (
        Array.isArray(payload) &&
        payload.length > 0 &&
        payload[0] !== null &&
        typeof payload[0] === "object" &&
        typeof (payload[0] as { text?: unknown }).text === "string"
      ) {
        payload = JSON.parse((payload[0] as { text: string }).text);
      } else if (typeof payload === "string") {
        payload = JSON.parse(payload);
      }
    } catch {
      payload = undefined;
    }

    const payloadRecord =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : undefined;
    const toolName = context.toolRef.slice("vectorsearch/".length);
    const argumentRefs = [
      context.args.reference,
      context.args.ref,
      context.args.base_ref,
    ].filter((value): value is string =>
      typeof value === "string" && value.trim() !== ""
    );
    const argumentRefLists = [context.args.references, context.args.refs]
      .filter(Array.isArray)
      .flat()
      .filter((value): value is string =>
        typeof value === "string" && value.trim() !== ""
      );

    let documents: Record<string, unknown>[] = [];
    if (toolName === "get_document" || toolName === "get_summary") {
      if (payloadRecord !== undefined) documents = [payloadRecord];
    } else if (toolName === "get_documents") {
      const candidates = payloadRecord?.documents ?? payloadRecord?.results;
      if (Array.isArray(candidates)) {
        documents = candidates.filter(
          (item): item is Record<string, unknown> =>
            item !== null && typeof item === "object" && !Array.isArray(item),
        );
      }
    }

    documents.forEach((document, index) => {
      if (
        document.error !== undefined ||
        document.isError === true ||
        document.success === false
      ) {
        return;
      }
      const referenceCandidates = [
        document.reference,
        document.base_ref,
        argumentRefs[index],
        argumentRefLists[index],
        argumentRefs[0],
      ];
      const reference = referenceCandidates.find(
        (value): value is string =>
          typeof value === "string" && value.trim() !== "",
      );
      if (reference === undefined) return;
      const titleCandidates = [document.title, document.name];
      const title =
        titleCandidates.find(
          (value): value is string =>
            typeof value === "string" && value.trim() !== "",
        ) ?? reference;
      const snippetCandidates = [
        document.content,
        document.text,
        document.summary,
      ];
      const snippet =
        snippetCandidates.find(
          (value): value is string =>
            typeof value === "string" && value.trim() !== "",
        ) ?? "";
      // A successful full-document/summary response must contain actual source
      // text. This prevents an object-shaped not-found/status response from
      // becoming a globally numbered, apparently citable source merely because
      // the request itself carried a valid reference.
      if (snippet === "") return;
      const urlCandidates = [document.url, document.link];
      const url =
        urlCandidates.find(
          (value): value is string => typeof value === "string",
        ) ?? "";
      const stringValue = (value: unknown): string | undefined =>
        typeof value === "string" && value.trim() !== "" ? value : undefined;
      const nonNegativeInt = (value: unknown): number | undefined =>
        typeof value === "number" && Number.isFinite(value) && value >= 0
          ? Math.floor(value)
          : undefined;
      const documentMetadata =
        document.metadata !== null &&
        typeof document.metadata === "object" &&
        !Array.isArray(document.metadata)
          ? (document.metadata as Record<string, unknown>)
          : {};
      const evidenceSpans = Array.isArray(document.evidence_spans)
        ? document.evidence_spans.filter(
            (span): span is Record<string, unknown> =>
              span !== null && typeof span === "object" && !Array.isArray(span),
          )
        : [];
      const evidence: CitationEvidence[] = evidenceSpans.map((span) => {
        const rawPage = span.page ?? span.page_start;
        const page =
          typeof rawPage === "number" && Number.isFinite(rawPage) && rawPage >= 0
            ? Math.floor(rawPage)
            : stringValue(rawPage);
        const section =
          stringValue(span.section) ??
          (Array.isArray(span.section_path)
            ? span.section_path
                .filter((value): value is string => typeof value === "string")
                .join(" > ") || undefined
            : undefined);
        const spanVersion =
          stringValue(span.version) ??
          stringValue(document.version) ??
          stringValue(documentMetadata.version);
        const spanText =
          stringValue(span.text) ??
          stringValue(span.content) ??
          stringValue(span.snippet);
        const documentId =
          stringValue(span.document_id) ??
          stringValue(document.document_id) ??
          stringValue(documentMetadata.document_id) ??
          reference;
        const charStart =
          nonNegativeInt(span.char_start) ?? nonNegativeInt(span.original_start);
        const charEnd =
          nonNegativeInt(span.char_end) ?? nonNegativeInt(span.original_end);
        return {
          ...(stringValue(span.citation_id) !== undefined
            ? { citation_id: stringValue(span.citation_id) }
            : {}),
          document_id: documentId,
          ...(spanVersion !== undefined ? { version: spanVersion } : {}),
          ...(page !== undefined ? { page } : {}),
          ...(section !== undefined ? { section } : {}),
          ...(charStart !== undefined ? { char_start: charStart } : {}),
          ...(charEnd !== undefined ? { char_end: charEnd } : {}),
          ...(stringValue(span.chunk_id) !== undefined
            ? { chunk_id: stringValue(span.chunk_id) }
            : {}),
          ...(spanText !== undefined ? { text: spanText.slice(0, 500) } : {}),
          ...(typeof span.score === "number" ? { score: span.score } : {}),
        };
      });
      const firstEvidence = evidence[0];
      const citationId = stringValue(document.citation_id) ?? firstEvidence?.citation_id;
      const documentId =
        stringValue(document.document_id) ??
        stringValue(documentMetadata.document_id) ??
        reference;
      const version =
        stringValue(document.version) ??
        stringValue(documentMetadata.version) ??
        firstEvidence?.version;
      explicitEntries.push({
        key: reference.trim(),
        citation: {
          title,
          url,
          snippet: snippet.slice(0, 500),
          similarity_score:
            typeof document.score === "number" ? document.score : 0,
          ...(citationId !== undefined ? { citation_id: citationId } : {}),
          document_id: documentId,
          ...(version !== undefined ? { version } : {}),
          ...(firstEvidence?.page !== undefined ? { page: firstEvidence.page } : {}),
          ...(firstEvidence?.section !== undefined ? { section: firstEvidence.section } : {}),
          ...(firstEvidence?.char_start !== undefined ? { char_start: firstEvidence.char_start } : {}),
          ...(firstEvidence?.char_end !== undefined ? { char_end: firstEvidence.char_end } : {}),
          ...(firstEvidence?.chunk_id !== undefined ? { chunk_id: firstEvidence.chunk_id } : {}),
          ...(evidence.length > 0 ? { evidence } : {}),
        },
      });
    });
  }

  const entriesByKey = new Map<string, { key: string; citation: Citation }>();
  for (const entry of [...parsedEntries, ...explicitEntries]) {
    if (!entriesByKey.has(entry.key)) entriesByKey.set(entry.key, entry);
  }
  const entries = [...entriesByKey.values()];

  // Without explicit tool identity, retain the strict payload gate that keeps
  // unrelated tools with a generic {results:[...]} shape out of the registry.
  const hasParsedDocIdentity =
    chunks.some((chunk) => (chunk.baseRef ?? "").trim() !== "") ||
    summaries.some((summary) => summary.reference.trim() !== "");
  if (explicitEntries.length === 0 && !hasParsedDocIdentity) return content;
  if (entries.length === 0) return content;

  const indices = await citations.register(entries);

  const lines = entries.map((entry, index) => {
    const citationIndex = indices[index];
    return `[${citationIndex}] ${entry.citation.title} (Ref: ${entry.key})`;
  });
  const note =
    "Zitier-Hinweis: The self-retrieved hits below are numbered as sources — " +
    "cite used hits inline in your answer with exactly the global [n] given " +
    "here. Never assign local numbers starting at [1] and never derive the " +
    "number from the order in the tool result:\n" +
    lines.join("\n");

  // MCP text-content array → APPEND the note as a trailing text part, keeping
  // the raw payload as content[0] so any downstream re-parse still sees JSON.
  if (
    Array.isArray(content) &&
    content.every(
      (part) =>
        part !== null && typeof part === "object" && "text" in (part as object),
    )
  ) {
    return [...content, { type: "text", text: note }];
  }
  if (typeof content === "string") return `${content}\n\n${note}`;
  return content;
}

/**
 * Produces a deterministic, AI-SDK-valid (`^[A-Za-z0-9_-]{1,64}$`) tool key
 * namespaced by server name, disambiguating any collision with a numeric
 * suffix. Exported for unit testing.
 */
export function uniqueToolKey(
  existing: Record<string, unknown>,
  serverName: string,
  bareName: string,
): string {
  const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const base = `${sanitize(serverName)}__${sanitize(bareName)}`.slice(0, 64);
  if (existing[base] === undefined) return base;
  // Collision (after sanitisation) — append a numeric suffix that still fits 64.
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const candidate = base.slice(0, 64 - suffix.length) + suffix;
    if (existing[candidate] === undefined) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Tool-selection meta-tool (Dynamic Tool Retrieval escape hatch)
// ---------------------------------------------------------------------------

/**
 * Sanitises an arbitrary name into a valid AI SDK tool key
 * (`^[A-Za-z0-9_-]{1,64}$`).
 */
function sanitizeToolName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return s.length > 0 ? s : "select_tools";
}

/**
 * Builds the on-demand `select_tools` meta-tool for a semantic-selection node.
 *
 * The hosting node binds its FULL tool pool but only ADVERTISES a relevant
 * subset (top-K + always-included) initially. This meta-tool lets the model
 * pull in more capabilities on demand: it takes a natural-language `query`,
 * ranks the full pool via the {@link ToolIndex}, and ACTIVATES the best matches
 * by calling `activate` with their AI SDK keys. Because the engine re-reads the
 * active set via `prepareStep` before the next step, the newly-activated tools
 * become callable on the model's next turn.
 *
 * Returns the AI SDK key it should be registered under and the tool itself.
 */
export function buildToolSelectionMetaTool(opts: {
  name: string;
  toolIndex: ToolIndex;
  pool: string[];
  keyByRef: Record<string, string>;
  topK: number;
  minScore?: number;
  /** Caller bearer for token-scoped semantic tool discovery. */
  authToken?: string;
  /**
   * Optional summary of the tool groups NOT already advertised to the model,
   * appended to the tool description so the model knows what it can request.
   */
  groupsSummary?: string;
  /**
   * Looks up the instruction text shown for a server when one of its tools is
   * activated. To keep the activation result lean and avoid leaking large
   * discovery lists (every employee/parking user), callers pass the server's
   * LLM-generated SUMMARY here rather than its full server-level instructions.
   * Returns undefined when no summary is available yet.
   */
  getInstructions?: (server: string) => string | undefined;
  /** Adds the given AI SDK keys to the node's active-tools set. */
  activate: (keys: string[]) => void;
  /**
   * Reports the final arguments this local tool executes with, as key-value
   * JSON — see {@link AgentMediaHooks.onEffectiveArgs} for why local tools
   * must fire it explicitly (no egress DLP, so raw args are effective args).
   */
  onEffectiveArgs?: (
    toolCallId: string,
    toolName: string,
    argsJson: string,
  ) => void | Promise<void>;
}): { key: string; tool: ToolSet[string] } {
  const {
    name,
    toolIndex,
    pool,
    keyByRef,
    topK,
    minScore,
    authToken,
    groupsSummary,
    getInstructions,
    activate,
    onEffectiveArgs,
  } = opts;
  const key = sanitizeToolName(name);

  const baseDescription =
    "Discover and activate additional tools by capability. Call this with a " +
    "precise, action-level description of the single capability you need " +
    "(e.g. 'cancel a parking booking', 'create a vacation request'). " +
    "Be as specific as possible — broad queries activate unrelated tools. " +
    "Only call this when none of the currently available tools fit. " +
    "Activated tools become callable on your next step.";
  const description =
    groupsSummary !== undefined && groupsSummary.trim() !== ""
      ? `${baseDescription}\n\nTool groups you can request (not yet shown to you):\n${groupsSummary}`
      : baseDescription;

  const metaTool = tool<Record<string, unknown>, unknown, never>({
    description,
    inputSchema: jsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language description of the capability you need, e.g. " +
            "'cancel a parking booking' or 'create a vacation day'.",
        },
      },
      required: ["query"],
    }),
    execute: async (
      args: Record<string, unknown>,
      execOpts: ToolExecutionOptions<never>,
    ): Promise<unknown> => {
      const query =
        typeof args.query === "string" ? (args.query as string) : "";
      await onEffectiveArgs?.(
        execOpts.toolCallId,
        key,
        JSON.stringify({ query }),
      );
      if (query.trim() === "") {
        return {
          isError: true,
          error: "missing_query",
          message: "Provide a 'query' describing the capability you need.",
        };
      }
      const hits = await toolIndex.select(query, pool, {
        topK,
        ...(minScore !== undefined ? { minScore } : {}),
        ...(authToken !== undefined ? { authToken } : {}),
      });
      const keys: string[] = [];
      const servers = new Set<string>();
      const activated: Array<{
        name: string;
        description?: string;
        parameters?: unknown;
      }> = [];
      for (const hit of hits) {
        const k = keyByRef[hit.ref];
        if (k === undefined) continue;
        keys.push(k);
        // `name` MUST be the callable AI SDK tool key (e.g. `worktime__status`),
        // NOT the `server/tool` ref — a `/` in a tool name is rejected by some
        // providers (Bedrock: name must match [a-zA-Z0-9_-]+).
        activated.push({
          name: k,
          ...(hit.description !== undefined
            ? { description: hit.description }
            : {}),
          ...(hit.inputSchema !== undefined
            ? { parameters: hit.inputSchema }
            : {}),
        });
        const server = hit.ref.includes("/")
          ? (hit.ref.split("/")[0] ?? "")
          : "";
        if (server !== "") servers.add(server);
      }
      activate(keys);
      if (activated.length === 0) {
        return {
          activated: [],
          message:
            "No additional tools matched. The tools already available to you " +
            "are the most relevant ones.",
        };
      }
      // Return the server-level SUMMARY (not the full instructions, which can
      // contain large discovery lists) for the servers whose tools were
      // activated, so the model gets a lean capability hint for any group it
      // just pulled in.
      const instructions: Record<string, string> = {};
      if (getInstructions !== undefined) {
        for (const server of servers) {
          const instr = getInstructions(server);
          if (instr !== undefined && instr.trim() !== "") {
            instructions[server] = instr;
          }
        }
      }
      return {
        activated,
        ...(Object.keys(instructions).length > 0 ? { instructions } : {}),
        message:
          `Activated ${activated.length} tool(s) — call them by the exact ` +
          `'name' shown above. You can call them on your next step.`,
      };
    },
  });

  return { key, tool: metaTool as ToolSet[string] };
}

// ---------------------------------------------------------------------------
// Client-supplied tools (function-calling passthrough)
// ---------------------------------------------------------------------------

/**
 * Builds an AI SDK ToolSet from the caller's `tools` (function-calling
 * passthrough). Unlike MCP/media tools these are declared WITHOUT an `execute`
 * callback: the AI SDK therefore surfaces the model's tool call as a stream
 * part and stops the step instead of running anything. The engine forwards that
 * call straight back to the caller (as OpenAI `tool_calls`), which executes the
 * tool itself and returns the result on the next turn.
 *
 * The AI SDK tool key is the function's own name verbatim — OpenAI already
 * constrains function names to `^[A-Za-z0-9_-]{1,64}$`, which is exactly the AI
 * SDK key grammar, so the name the caller sent round-trips unchanged in the
 * emitted `tool_calls[].function.name`. Returns the built ToolSet plus the set
 * of keys, so the engine can tell a client tool call apart from an internal
 * (executed) MCP tool call.
 *
 * Entries that are malformed (non-`function` type, missing/invalid name) are
 * skipped rather than failing the whole request.
 */
export function buildClientTools(clientTools: OpenAITool[]): {
  tools: ToolSet;
  keys: Set<string>;
} {
  const tools: ToolSet = {};
  const keys = new Set<string>();
  const VALID_NAME = /^[A-Za-z0-9_-]{1,64}$/;

  for (const entry of clientTools) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      entry.type !== "function" ||
      typeof entry.function?.name !== "string" ||
      !VALID_NAME.test(entry.function.name)
    ) {
      continue;
    }
    const name = entry.function.name;
    // Default to an empty object schema when the caller omits parameters, so a
    // zero-argument tool is still callable.
    const params =
      entry.function.parameters !== undefined &&
      entry.function.parameters !== null &&
      typeof entry.function.parameters === "object"
        ? entry.function.parameters
        : { type: "object", properties: {} };

    // No `execute`: the model's tool call is streamed back to the caller, never
    // run server-side. The cast keeps the input type open (the schema is
    // caller-defined JSON Schema validated at runtime by the SDK).
    tools[name] = tool<Record<string, unknown>, never, never>({
      description: entry.function.description ?? `Client tool ${name}`,
      inputSchema: jsonSchema<Record<string, unknown>>(
        params as Record<string, unknown>,
      ),
    }) as ToolSet[string];
    keys.add(name);
  }

  return { tools, keys };
}

/**
 * Maps an OpenAI `tool_choice` to the AI SDK `toolChoice`. Returns undefined
 * when no choice is supplied (the SDK then defaults to `"auto"`).
 */
export function mapToolChoice(
  choice: ToolChoice | undefined,
): AiToolChoice<ToolSet> | undefined {
  if (choice === undefined) return undefined;
  if (choice === "auto" || choice === "none" || choice === "required") {
    return choice;
  }
  if (
    typeof choice === "object" &&
    choice.type === "function" &&
    typeof choice.function?.name === "string"
  ) {
    return { type: "tool", toolName: choice.function.name };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Media-generation tools
// ---------------------------------------------------------------------------

/**
 * Default provider options for an image-generation model when a media tool's
 * `llm.parameters.providerOptions` is not set. Google's native image models
 * require `responseModalities: ["IMAGE"]` to emit a file part.
 */
const DEFAULT_IMAGE_PROVIDER_OPTIONS = {
  google: { responseModalities: ["IMAGE"] },
} as const;

/**
 * Max characters per streamed media chunk. A single base64-encoded image
 * easily exceeds aiohttp's 131072-byte per-line limit used by Open WebUI, so
 * the markdown data-URI is split before being emitted as SSE frames; the client
 * concatenates them back into the full image. Matches the native image-gen path.
 */
const MEDIA_SSE_CHUNK_SIZE = 60_000;

/**
 * Builds an AI SDK ToolSet from an `llm` node's `config.mediaTools` array.
 *
 * Each media tool exposes a single `prompt` argument to the hosting model. When
 * called, it runs the tool's own configured generation model (e.g. a Google
 * image model with `responseModalities: ["IMAGE"]`), streams every produced
 * image/media file back to the client via {@link AgentMediaHooks.emit}, and
 * returns a short text confirmation so the hosting model continues the
 * conversation without trying to reproduce the (large) media payload as text.
 *
 * Returns an empty ToolSet when the node declares no media tools.
 */
export function buildMediaTools(
  node: FlowNode,
  media: AgentMediaHooks,
): ToolSet {
  const cfg = node.config as { mediaTools?: unknown } | undefined;
  const list = cfg?.mediaTools;
  if (!Array.isArray(list) || list.length === 0) return {};

  const tools: ToolSet = {};
  for (const raw of list) {
    if (
      raw === null ||
      typeof raw !== "object" ||
      typeof (raw as MediaToolConfig).name !== "string" ||
      (raw as MediaToolConfig).llm === undefined
    ) {
      continue;
    }
    const mt = raw as MediaToolConfig;
    const key = uniqueMediaToolKey(tools, mt.name);

    tools[key] = tool<{ prompt: string }, unknown, never>({
      description:
        mt.description ??
        `Generates media (image/audio/video) from a text prompt using ${mt.llm.model}. The generated media is shown directly to the user.`,
      inputSchema: jsonSchema<{ prompt: string }>({
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              mt.promptDescription ??
              "A detailed description of the media to generate.",
          },
        },
        required: ["prompt"],
      }),
      execute: async (
        args: { prompt: string },
        opts: ToolExecutionOptions<never>,
      ): Promise<unknown> => {
        const prompt =
          typeof args.prompt === "string"
            ? args.prompt
            : String(args.prompt ?? "");
        await media.onEffectiveArgs?.(
          opts.toolCallId,
          key,
          JSON.stringify({ prompt }),
        );
        return runMediaGeneration(mt, prompt, media, opts.toolCallId);
      },
    }) as ToolSet[string];
  }
  return tools;
}

/**
 * Runs a single media-generation call and streams any produced files to the
 * client. Returns a compact, model-facing result describing the outcome — never
 * the raw media bytes (those are streamed separately via {@link AgentMediaHooks.emit}).
 */
async function runMediaGeneration(
  mt: MediaToolConfig,
  prompt: string,
  media: AgentMediaHooks,
  toolCallId?: string,
): Promise<unknown> {
  let model: ReturnType<typeof media.llmProviderFactory>;
  try {
    model = media.llmProviderFactory(mt.llm, media.appConfig, media.resolution);
  } catch {
    return {
      isError: true,
      error: "media_provider_error",
      message: "Could not initialise the media model.",
    };
  }

  const params: Parameters<typeof generateText>[0] = { model, prompt };
  const provOpts =
    mt.llm.parameters?.providerOptions ?? DEFAULT_IMAGE_PROVIDER_OPTIONS;
  if (provOpts !== null && typeof provOpts === "object") {
    params.providerOptions = provOpts as unknown as NonNullable<
      (typeof params)["providerOptions"]
    >;
  }
  const mediaParams = filterLlmParameters(
    mt.llm.parameters as Record<string, unknown> | undefined,
    mt.llm.provider,
    mt.llm.model,
  );
  const temperature = mediaParams?.temperature;
  if (typeof temperature === "number") params.temperature = temperature;
  const maxTokens = mediaParams?.maxTokens;
  if (typeof maxTokens === "number") params.maxOutputTokens = maxTokens;
  if (media.signal !== undefined) params.abortSignal = media.signal;

  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText(params);
  } catch {
    return {
      isError: true,
      error: "media_generation_failed",
      message: "Media generation failed.",
    };
  }

  // Report model + token usage to the monitoring/cost layer so the synthetic
  // generate_image tool node shows which model ran and how many tokens it used.
  if (toolCallId !== undefined) {
    const usage = result.usage;
    media.setGenAiAttributes?.(
      toolCallId,
      { provider: mt.llm.provider, model: mt.llm.model },
      {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
      },
    );
    if (usage !== undefined) {
      const cost = estimateCost(
        mt.llm.provider,
        mt.llm.model,
        {
          prompt_tokens: usage.inputTokens ?? 0,
          completion_tokens: usage.outputTokens ?? 0,
        },
        media.pricingOverrides ?? media.appConfig.llmPricing,
      );
      media.metrics?.recordLlmCall(
        mt.llm.provider,
        mt.llm.model,
        "ok",
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
        cost,
      );
      if (cost > 0) {
        media.costTracker?.record(media.clientId, cost, {
          provider: mt.llm.provider,
          model: mt.llm.model,
          promptTokens: usage.inputTokens ?? 0,
          completionTokens: usage.outputTokens ?? 0,
          ...(media.costAttribution ?? {}),
        });
      }
    }
  }

  const files = (result.files ?? []) as Array<{
    base64?: string;
    mediaType?: string;
  }>;
  let emitted = 0;
  for (const f of files) {
    const mediaType = f.mediaType ?? "";
    const base64 = f.base64;
    if (!base64) continue;
    // Prefer a short media URL — Open WebUI cannot render megabyte-long base64
    // data-URIs (open-webui#16976) and they overflow the SSE line limit. When
    // media serving is not configured, fall back to a chunked inline data-URI.
    const mediaUrl = media.publishMedia?.(base64, mediaType);
    if (mediaUrl !== undefined) {
      const markdown = mediaType.startsWith("image/")
        ? `\n\n![](${mediaUrl})\n\n`
        : `\n\n[media](${mediaUrl})\n\n`;
      try {
        await media.emit(markdown);
      } catch {
        /* client disconnect — stop streaming this media */
      }
      emitted++;
      continue;
    }
    const markdown = mediaType.startsWith("image/")
      ? `\n\n![](data:${mediaType};base64,${base64})\n\n`
      : `\n\n[media](data:${mediaType};base64,${base64})\n\n`;
    for (
      let offset = 0;
      offset < markdown.length;
      offset += MEDIA_SSE_CHUNK_SIZE
    ) {
      try {
        await media.emit(markdown.slice(offset, offset + MEDIA_SSE_CHUNK_SIZE));
      } catch {
        /* client disconnect — stop streaming this media */
      }
    }
    emitted++;
  }

  if (emitted === 0) {
    const text = typeof result.text === "string" ? result.text : "";
    return {
      status: "no_media",
      message:
        text.length > 0
          ? text
          : "The model did not return any media for this prompt.",
    };
  }

  return {
    status: "ok",
    generated: emitted,
    message: `Generated ${emitted} media file(s) and displayed ${
      emitted === 1 ? "it" : "them"
    } to the user. Do not repeat the media as text or a data URI.`,
  };
}

/**
 * Wiring for the `inspect_image` tool (see {@link buildImageInspectionTools}).
 *
 * The tool is the read side of the image-reference indirection
 * (`image-reference.ts`): inline images were parked in the run's registry and
 * replaced by `img-N` placeholders, and this tool resolves one of those
 * references and asks a dedicated vision model about it. It runs only when the
 * hosting model explicitly calls it, so a text-only flow pays a vision call
 * exactly when the picture actually matters.
 */
export interface AgentImageInspectionHooks {
  /** Existing model tools, used to choose a non-colliding tool key. */
  existingTools?: ToolSet;
  /** Actual node owning this call; used for node-level trace attribution. */
  nodeId?: string;
  /** The execution accumulator includes on-demand vision usage and cost. */
  usage?: UsageAccumulator;
  onNodeDiagnostic?: (
    nodeId: string,
    diagnostic: { level: "error" | "warn" | "info"; code: string; message: string },
  ) => void;
  registry: ImageRefRegistry;
  /**
   * Fetches a stored document asset by id (Req 16.3), used when the model hands
   * the tool an `asset:<id>[#bbox]` reference instead of an already-parked
   * `img-N`. The engine wires this to the MCP `get_asset` call (task 3.9), which
   * is ACL-checked and fail-closed; `agent-tools.ts` stays decoupled from the
   * MCP client. `region` (a normalised `[x0,y0,x1,y1]` in `0..1`) is forwarded
   * to `get_asset` to trigger its server-side zoom crop. Returns `undefined`
   * when the asset is unavailable/forbidden or the fetch fails — the tool then
   * fails closed exactly like an unknown `img-N` reference (no bytes leak). When
   * the hook is absent, `asset:` references are simply not resolvable.
   */
  fetchAsset?: (
    assetId: string,
    opts: { region?: [number, number, number, number] },
  ) => Promise<{ bytes: Uint8Array; mediaType: string } | undefined>;
  /** The node's `config.imageInspection` block. */
  config: ImageInspectionConfig;
  appConfig: AppConfig;
  llmProviderFactory: LlmProviderFactory;
  /** See {@link AgentMediaHooks.signal} — same deadline, same reason. */
  signal?: AbortSignal;
  pricingOverrides?: Record<string, ModelPrice>;
  resolution?: ProviderResolution;
  costTracker?: SpendRecorder;
  metrics?: Metrics;
  clientId?: string;
  costAttribution?: CostAttribution;
  setGenAiAttributes?: (
    nodeId: string,
    req?: GenAiRequest,
    res?: GenAiResponse,
  ) => void;
  /**
   * Reports the final arguments this local tool executes with, as key-value
   * JSON — see {@link AgentMediaHooks.onEffectiveArgs} for why local tools
   * must fire it explicitly (no egress DLP, so raw args are effective args).
   */
  onEffectiveArgs?: (
    toolCallId: string,
    toolName: string,
    argsJson: string,
  ) => void | Promise<void>;
}

/** Caps the vision answer so one inspection cannot bloat the hosting prompt. */
const DEFAULT_IMAGE_ANSWER_CHARS = 4_000;

/**
 * Builds the `inspect_image` tool for an `llm` node that declares
 * `config.imageInspection`. The node's config block is passed in through
 * {@link AgentImageInspectionHooks.config} — one source of truth, so a caller
 * cannot accidentally enable the tool with one copy of the settings and describe
 * it from another. Returns an empty ToolSet when the block has no `llm`, so a
 * node that does not opt in is completely unaffected.
 */
export function buildImageInspectionTools(
  hooks: AgentImageInspectionHooks,
): ToolSet {
  const cfg = hooks.config as ImageInspectionConfig | undefined;
  if (cfg === null || typeof cfg !== "object" || cfg.llm === undefined) {
    return {};
  }
  const key = uniqueMediaToolKey(
    (hooks.existingTools ?? {}) as Record<string, unknown>,
    IMAGE_INSPECTION_TOOL_NAME,
  );
  const tools: ToolSet = {};
  tools[key] = tool<{ image: string; question: string }, unknown, never>({
    // No list of "currently available" references here: this description is
    // rendered once when the tool set is assembled, which happens BEFORE the
    // prompt's inline images are offloaded, so any such list would be empty (or
    // worse, stale). Each offloaded image names its own reference in place, and
    // an unresolvable reference reports the live list from inside the tool.
    description:
      hooks.config.description ??
      `Inspects an image you cannot see yourself, using a vision model, and ` +
      `returns a factual description answering your question about it. Two ` +
      `kinds of reference are accepted: an inline image parked in this ` +
      `conversation, which appears as an [image ref=img-N …] line — pass that ` +
      `img-N reference exactly as shown; or a stored document asset, referenced ` +
      `as asset:<id> (from a search hit, list_figures or follow_ref), optionally ` +
      `with a normalised bounding box asset:<id>#x0,y0,x1,y1 (each 0..1) to zoom ` +
      `into a region of it.`,
    inputSchema: jsonSchema<{ image: string; question: string }>({
      type: "object",
      properties: {
        image: {
          type: "string",
          description:
            hooks.config.imageDescription ??
            'The image to inspect: an inline reference like "img-1", or a ' +
            'document asset like "asset:<id>" (optionally with a region zoom, ' +
            '"asset:<id>#x0,y0,x1,y1" where each coordinate is between 0 and 1).',
        },
        question: {
          type: "string",
          description:
            "What to look for in the image. Be specific — one focused question " +
            "per call yields a more reliable answer.",
        },
      },
      required: ["image", "question"],
    }),
    execute: async (
      args: { image: string; question: string },
      opts: ToolExecutionOptions<never>,
    ): Promise<unknown> => {
      const image = String(args?.image ?? "");
      const question = String(args?.question ?? "");
      await hooks.onEffectiveArgs?.(
        opts.toolCallId,
        key,
        JSON.stringify({ image, question }),
      );
      return runImageInspection(hooks, image, question, opts.toolCallId);
    },
  }) as ToolSet[string];
  return tools;
}

/**
 * Resolves one image reference and asks the configured vision model about it.
 * Returns a compact, model-facing result — the bytes themselves never go back
 * into the hosting model's context.
 */
async function runImageInspection(
  hooks: AgentImageInspectionHooks,
  image: string,
  question: string,
  toolCallId?: string,
): Promise<unknown> {
  // Resolution order:
  //   1. An already-parked reference (`img-N` or a raw store id) — the inline
  //      image path, unchanged.
  //   2. Failing that, an `asset:<id>[#bbox]` reference (Req 16.3) — fetch the
  //      asset bytes via the engine-wired `get_asset` hook, park them in the
  //      registry as a fresh `img-N`, and inspect that. The `#bbox` becomes the
  //      `region` zoom. Any resolution problem fails closed as `unknown_image`.
  // The `asset:` scheme is checked BEFORE reporting an unknown reference so a
  // malformed asset ref reports a distinct, actionable error.
  let stored = hooks.registry.resolve(image);
  if (stored === undefined) {
    const assetParse = parseAssetReference(image);
    if (assetParse !== undefined) {
      if (!assetParse.ok) {
        return {
          status: "invalid_request",
          message:
            'Malformed asset reference. Use "asset:<id>" or ' +
            '"asset:<id>#x0,y0,x1,y1" where each coordinate is a number ' +
            "between 0 and 1 with x0<x1 and y0<y1.",
        };
      }
      if (hooks.fetchAsset === undefined) {
        return {
          status: "unknown_image",
          message:
            "Document assets cannot be inspected in this run. " +
            "Attach an image to the conversation and reference it as img-N instead.",
        };
      }
      let fetched: { bytes: Uint8Array; mediaType: string } | undefined;
      try {
        fetched = await hooks.fetchAsset(assetParse.ref.assetId, {
          ...(assetParse.ref.region !== undefined
            ? { region: assetParse.ref.region }
            : {}),
        });
      } catch {
        // Fail closed: never surface the fetch error's cause to the model, and
        // never crash the tool call. Treat it exactly like an unavailable asset.
        fetched = undefined;
      }
      if (fetched === undefined) {
        return {
          status: "unknown_image",
          message:
            "The requested document asset is not available or not authorized.",
        };
      }
      const parkedRef = hooks.registry.register(fetched.bytes, fetched.mediaType);
      if (parkedRef === undefined) {
        return {
          status: "unknown_image",
          message:
            "The requested document asset could not be prepared for inspection.",
        };
      }
      stored = hooks.registry.resolve(parkedRef);
    }
  }
  if (stored === undefined) {
    const available = hooks.registry.list().map((info) => info.ref);
    return {
      status: "unknown_image",
      message:
        "The requested image is not available in this run. " +
        (available.length > 0
          ? `Available references: ${available.join(", ")}.`
          : "No images have been attached to this conversation."),
    };
  }
  if (question.trim() === "") {
    return {
      status: "invalid_request",
      message: 'The "question" argument must not be empty.',
    };
  }

  const recordError = (code: string, message: string): void => {
    hooks.metrics?.recordLlmCall(
      hooks.config.llm.provider,
      hooks.config.llm.model,
      "error",
      0,
      0,
      0,
    );
    if (toolCallId !== undefined) {
      hooks.setGenAiAttributes?.(toolCallId, {
        provider: hooks.config.llm.provider,
        model: hooks.config.llm.model,
      });
    }
    if (hooks.nodeId !== undefined) {
      hooks.onNodeDiagnostic?.(hooks.nodeId, { level: "error", code, message });
    }
  };

  let model: ReturnType<typeof hooks.llmProviderFactory>;
  try {
    model = hooks.llmProviderFactory(
      hooks.config.llm,
      hooks.appConfig,
      hooks.resolution,
    );
  } catch {
    const message = "Could not initialise the vision model.";
    recordError("image_inspection_provider_error", message);
    return {
      isError: true,
      status: "vision_provider_error",
      message,
    };
  }

  const dataUrl = `data:${stored.mediaType};base64,${Buffer.from(
    stored.data,
  ).toString("base64")}`;
  const params: Parameters<typeof generateText>[0] = {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Answer the following question about the attached image, ` +
              `strictly from what is visible in it. If the answer is not ` +
              `visible, say so.\n\nQuestion: ${question}`,
          },
          { type: "file", data: new URL(dataUrl), mediaType: stored.mediaType },
        ],
      },
    ],
  };
  const visionParams = filterLlmParameters(
    hooks.config.llm.parameters as Record<string, unknown> | undefined,
    hooks.config.llm.provider,
    hooks.config.llm.model,
  );
  if (typeof visionParams?.temperature === "number") {
    params.temperature = visionParams.temperature;
  }
  if (typeof visionParams?.maxTokens === "number") {
    params.maxOutputTokens = visionParams.maxTokens;
  }
  if (hooks.signal !== undefined) params.abortSignal = hooks.signal;

  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText(params);
  } catch {
    const message = "Vision inspection failed.";
    recordError("image_inspection_call_failed", message);
    return {
      isError: true,
      status: "vision_call_failed",
      message,
    };
  }

  // Report the vision call to the monitoring/cost layer under the tool-call id,
  // exactly as the media-generation path does, so the spend is visible rather
  // than hidden inside a tool result.
  const usage = result.usage;
  if (toolCallId !== undefined) {
    hooks.setGenAiAttributes?.(
      toolCallId,
      { provider: hooks.config.llm.provider, model: hooks.config.llm.model },
      {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
      },
    );
  }
  if (usage !== undefined) {
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    if (hooks.usage !== undefined) {
      hooks.usage.promptTokens += inputTokens;
      hooks.usage.completionTokens += outputTokens;
      hooks.usage.totalTokens += inputTokens + outputTokens;
    }
    const cost = estimateCost(
      hooks.config.llm.provider,
      hooks.config.llm.model,
      {
        prompt_tokens: usage.inputTokens ?? 0,
        completion_tokens: usage.outputTokens ?? 0,
      },
      hooks.pricingOverrides ?? hooks.appConfig.llmPricing,
    );
    hooks.metrics?.recordLlmCall(
      hooks.config.llm.provider,
      hooks.config.llm.model,
      "ok",
      usage.inputTokens ?? 0,
      usage.outputTokens ?? 0,
      cost,
    );
    if (cost > 0) {
      if (hooks.usage !== undefined) {
        hooks.usage.costUsd = (hooks.usage.costUsd ?? 0) + cost;
      }
      hooks.costTracker?.record(hooks.clientId, cost, {
        provider: hooks.config.llm.provider,
        model: hooks.config.llm.model,
        promptTokens: usage.inputTokens ?? 0,
        completionTokens: usage.outputTokens ?? 0,
        ...(hooks.costAttribution ?? {}),
      });
    }
  }

  const cap =
    typeof hooks.config.maxAnswerChars === "number" &&
    hooks.config.maxAnswerChars > 0
      ? Math.floor(hooks.config.maxAnswerChars)
      : DEFAULT_IMAGE_ANSWER_CHARS;
  const answer = typeof result.text === "string" ? result.text.trim() : "";
  if (answer === "") {
    return {
      status: "no_answer",
      image,
      message: "The vision model returned no description for this image.",
    };
  }
  return {
    status: "ok",
    image,
    description: answer.length > cap ? `${answer.slice(0, cap)}…` : answer,
  };
}

/**
 * Produces a deterministic, AI-SDK-valid (`^[A-Za-z0-9_-]{1,64}$`) key for a
 * media tool from its configured name, disambiguating collisions with a numeric
 * suffix. Exported for unit testing.
 */
export function uniqueMediaToolKey(
  existing: Record<string, unknown>,
  name: string,
): string {
  const base =
    name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "media_tool";
  if (existing[base] === undefined) return base;
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const candidate = base.slice(0, 64 - suffix.length) + suffix;
    if (existing[candidate] === undefined) return candidate;
  }
}
