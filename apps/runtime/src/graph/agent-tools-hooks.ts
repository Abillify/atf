// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Hook interfaces `buildAiTools` takes from its callers (approval, egress, citations,
 * compliance policy, media, tool journal, image inspection). Split out of `agent-tools.ts`
 * unchanged; that module re-exports them.
 */

import type { AssistantScope } from "../assistants/types.js";
import type { AssistantToolJournal } from "../assistants/session-store.js";
import type { ImageModelV4 } from "@ai-sdk/provider";
import type {
  ToolSet,
} from "ai";
import type {
  LlmConfig,
  MediaToolConfig,
  ImageInspectionConfig,
} from "../types/flow.js";
import type { ApprovalRegistry, PendingApproval } from "./approval-gate.js";
import type { ToolEgressGuardrail } from "./output-guardrails.js";
import type { AppConfig } from "../config/index.js";
import type { CompliancePolicy } from "../compliance/policy-schema.js";
import type { LlmProviderFactory, ProviderResolution, UsageAccumulator } from "./graph-engine.js";
import type { ExecutionBudget } from "./execution-budget.js";
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
import { createImageProvider } from "./llm-factory.js";
import type { Citation } from "../types/openai.js";
import type {
  ImageRefRegistry,
} from "./image-reference.js";

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
   * Builds the {@link ImageModelV4} for a media tool with an images-API mode
   * (`image-generation` / `image-edit`). Defaults to
   * {@link createImageProvider}; injectable for tests so the mode logic
   * (reference resolution, size parsing, error mapping) can be exercised
   * without a live image server, mirroring {@link llmProviderFactory} for the
   * chat path.
   */
  imageProviderFactory?: (
    config: LlmConfig,
    appConfig: AppConfig,
    options?: { apiKey?: string },
  ) => ImageModelV4;
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
   * Run-scoped image references (`img-N`), the input source for a media tool
   * with `mode: "image-edit"`. The same registry the `inspect_image` tool uses
   * (see `image-reference.ts`), so a reference the model can quote is exactly
   * the picture the user pasted or an earlier node produced. Absent without a
   * media store — an edit tool then reports `media_input_unavailable` instead
   * of silently generating from text alone.
   */
  imageRefs?: ImageRefRegistry;
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
  /** Per-execution budget; vision usage counts against its token cap. */
  executionBudget?: ExecutionBudget;
  onNodeDiagnostic?: (
    nodeId: string,
    diagnostic: { level: "error" | "warn" | "info"; code: string; message: string },
  ) => void;
  registry: ImageRefRegistry;
  /**
   * Fetches a stored document asset by id (Req 16.3), used when the model hands
   * the tool an `asset:<id>[#bbox]` reference instead of an already-parked
   * `img-N`. The engine wires this to the MCP `get_asset` call, which
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
