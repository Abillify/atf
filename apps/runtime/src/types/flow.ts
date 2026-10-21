// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow Definition TypeScript Interfaces
 *
 * Exported interfaces for flow graph structure, LLM configuration,
 * and all flow-related data models. No `any` at module boundaries.
 */

/**
 * Data classification labels (GDPR/EU-AI-Act oriented, extensible via the
 * compliance policy — see `compliance/policy-schema.ts` and ADR-0009).
 * Defined here (not in the compliance module) so `FlowDefinition.dataClasses`
 * below can reference it without the core flow-type module depending on a
 * feature module — `compliance/policy-schema.ts` imports it from here instead.
 */
export const DATA_CLASSES = [
  "public",
  "internal",
  "confidential",
  "personal", // GDPR-relevant personal data
  "sensitive", // GDPR Art.9 special categories
  "financial",
  "legal",
  "health",
] as const;

export type DataClass = (typeof DATA_CLASSES)[number];

/**
 * A flow's crash-recovery policy for async/batch execution — see
 * {@link FlowDefinition.recovery} for the full reasoning.
 */
export interface FlowRecoveryPolicy {
  /**
   * Whether re-running this flow from the beginning after a crash is safe.
   * This is a statement about the flow's TOOLS, not about its cost: a flow
   * whose tools only read may be retried; one that writes to a foreign system
   * may repeat that write.
   */
  retry: boolean;
  /**
   * Optional per-flow attempt cap. Clamped to the global
   * `JOB_RECOVERY_MAX_ATTEMPTS`, so a flow can ask for FEWER attempts than the
   * deployment allows but never more — the operator keeps the ceiling. Useful
   * for an expensive long-running flow where a third full re-run costs more
   * than it is worth.
   */
  maxAttempts?: number;
}

/**
 * LLM inference parameters for a node's language model call.
 */
export interface LlmParameters {
  /** Sampling temperature in range 0.0–2.0 */
  temperature?: number;
  /** Maximum output tokens in range 1–32768 */
  maxTokens?: number;
  /** Additional provider-specific parameters (max 20 total keys including above) */
  [key: string]: unknown;
}

/**
 * Selection strategy for a model pool (see {@link LlmPoolConfig}).
 *
 * - `"fallback"` — try the members strictly in configured order; the first is
 *   the primary and each later member is a failover for the ones before it.
 * - `"round-robin"` — distribute calls evenly across the members by advancing a
 *   shared cursor each call; the member the cursor lands on becomes the primary
 *   and the remaining members (in configured order, wrapped) act as failovers,
 *   so a pool still degrades gracefully when the rotated-to member is down.
 */
export type LlmPoolStrategy =
  | "fallback"
  | "round-robin"
  | "weighted-round-robin"
  | "random"
  | "weighted-random"
  | "least-used";

/**
 * Stickiness for a model pool (see {@link LlmPoolConfig}): how long calls
 * should stay on the endpoint the pool selected once.
 *
 * - `"none"` (default) — the strategy is applied fresh on every call.
 * - `"execution"` — the leaf chosen on the pool's FIRST call within one flow
 *   execution is reused for all later calls of that execution.
 * - `"conversation"` — like `"execution"`, but the scope is the conversation
 *   (`conversationId`/`sessionId` from the request context; falls back to the
 *   execution when the request carries neither).
 *
 * Stickiness only pins the PRIMARY; the rest of the ordered chain is unchanged,
 * so failover keeps working. When the pinned leaf becomes unavailable it is
 * dropped as usual and the sticky entry follows the new head.
 */
export type LlmPoolStickiness = "none" | "execution" | "conversation";

/**
 * A runtime model pool attached to an {@link LlmConfig} by the flow parser when
 * a node references a POOL shortcut in `flows/model-shortcuts.yaml` (a shortcut
 * composed of several engine/model pairs or other shortcuts).
 *
 * The host {@link LlmConfig} itself always carries the FIRST candidate's
 * `provider`/`model`/`parameters`, so every consumer that only understands a
 * plain LlmConfig (admission, compliance, cost, capability collection, the
 * structured-output path) sees a valid single model even if it ignores `pool`.
 * The streaming `llm` handler and the `classifier` handler additionally read
 * `pool` to build the ordered candidate chain per {@link LlmPoolStrategy}.
 *
 * `candidates` are expanded configs. A candidate is normally a concrete
 * provider/model pair, but it MAY itself carry a nested `pool` — this is how a
 * pool shortcut that references ANOTHER pool shortcut is represented: the inner
 * pool keeps its own strategy instead of being flattened into the parent's
 * order. `buildPoolCandidateChain` resolves a nested candidate recursively (its
 * own strategy first, then the parent's), so e.g. an outer `fallback` pool whose
 * first member is an inner `round-robin` sub-pool rotates between the sub-pool's
 * members and only falls through to the outer pool's next member when the whole
 * sub-pool is unavailable. The host config's own `provider`/`model` is always the
 * first LEAF of the (possibly nested) candidate list, so plain consumers still
 * see a valid single model.
 */
export interface LlmPoolConfig {
  /** Selection strategy; defaults to `"fallback"` when omitted. */
  strategy?: LlmPoolStrategy;
  /**
   * Ordered candidates (>= 1). Each is a concrete provider/model pair or a
   * nested sub-pool (a candidate carrying its own `pool`). The first leaf
   * matches the host config.
   */
  candidates: LlmConfig[];
  /**
   * Prefix-cache affinity: keep calls on the endpoint selected on the pool's
   * first call (see {@link LlmPoolStickiness}). Defaults to `"none"`.
   */
  sticky?: LlmPoolStickiness;
}

/**
 * Configuration for a specific LLM provider and model on a flow node.
 */
export interface LlmConfig {
  /**
   * Load-time-only model-shortcut reference (see flows/model-shortcuts.yaml).
   * When present, the flow parser expands it into concrete `provider`, `model`
   * and preset `parameters` (merged under any node-level parameters) BEFORE Zod
   * validation and strips this key. A validated/registered LlmConfig therefore
   * never carries `shortcut`; it exists only on the pre-validation raw form.
   */
  shortcut?: string;
  /**
   * Provider reference: either a NAME declared in the `PROVIDERS` environment
   * variable (which carries that endpoint's URL and credentials) or a bare wire
   * protocol name (`openai`, `bedrock`, …) that uses the legacy per-protocol env
   * vars. Not a closed union, because a deployment may run any number of named
   * instances of the same protocol — e.g. two vLLM servers. Resolution and the
   * list of protocols live in `src/config/providers.ts`.
   */
  provider: string;
  /** Model identifier, max 256 characters. For Azure this is the deployment name; for Bedrock the model ID. */
  model: string;
  /** Optional inference parameters */
  parameters?: LlmParameters;
  /**
   * Optional characters-per-token estimate (1.0–8.0) for context fitting and
   * tool-result budgets on this node. Overrides the `CHARS_PER_TOKEN` env
   * default; carried from a model shortcut unless the node sets its own value.
   */
  charsPerToken?: number;
  /** Optional relative pool weight. Ignored outside a pool. */
  weight?: number;
  /**
   * Optional model pool, set by the parser when the node's shortcut resolves to
   * a POOL (see {@link LlmPoolConfig}). When present, the streaming `llm` and
   * `classifier` handlers select among `candidates` by `strategy` instead of
   * using only this config's own `provider`/`model`. All other consumers keep
   * working off the host config (the first leaf candidate). A candidate may
   * itself carry a `pool` (a nested sub-pool with its own strategy).
   */
  pool?: LlmPoolConfig;
}

/**
 * Declaration of a media-generation tool exposed to an `llm` node's agent loop.
 *
 * Unlike MCP tools (which are external processes referenced by `node.tools`), a
 * media tool wraps a dedicated generation model configured inline. The hosting
 * LLM can call it like any other function tool; on invocation the engine runs
 * the configured `llm` (e.g. an image model with Google `responseModalities:
 * ["IMAGE"]`) with the model-supplied prompt and streams the produced media
 * back to the client. The tool itself returns a short text confirmation so the
 * hosting model can continue the conversation.
 *
 * Configured under an `llm` node's `config.mediaTools` array.
 */
export interface MediaToolConfig {
  /**
   * Function name the hosting LLM uses to call the tool. Must match the AI SDK
   * tool-name grammar (`^[A-Za-z0-9_-]{1,64}$`); other characters are sanitised.
   */
  name: string;
  /** Human/LLM-facing description of when to use the tool. */
  description?: string;
  /** Description of the single `prompt` argument the model must supply. */
  promptDescription?: string;
  /** The generation model to run when the tool is invoked (its own model). */
  llm: LlmConfig;
}

/**
 * Vision-inspection settings for an `llm` node that must stay text-only.
 *
 * Configured under an `llm` node's `config.imageInspection`. When present, any
 * inline image in the conversation is parked in the run's image-reference
 * registry before the request is built (so the hosting model never receives
 * image bytes, nor the base64 that carries them) and replaced by a short
 * `img-N` reference. The node is then given an `inspect_image` tool that
 * resolves a reference and asks {@link ImageInspectionConfig.llm} — a vision
 * model — about it.
 *
 * This keeps image *input* reachable in a flow whose answering model cannot see,
 * instead of either failing the request (`vision_not_supported`) or silently
 * dropping what the user pasted.
 */
export interface ImageInspectionConfig {
  /**
   * The vision model to consult. Must be a model with vision input support;
   * it is only ever invoked when the hosting model calls the tool.
   */
  llm: LlmConfig;
  /** Overrides the generated tool description. */
  description?: string;
  /** Overrides the generated `image` argument description. */
  imageDescription?: string;
  /** Caps the answer length returned to the hosting model. Default 4000 chars. */
  maxAnswerChars?: number;
  /**
   * Enables `inspect_image` to resolve `asset:<id>[#bbox]` references (Req 16.3)
   * by fetching the asset via the MCP `get_asset` tool (task 3.9). Absent → the
   * tool only resolves inline `img-N` references (unchanged behaviour). The
   * fetched bytes are parked as an `img-N` and inspected via the same vision
   * sub-LLM, so the responder model never receives the base64.
   */
  assetSource?: {
    /**
     * MCP server exposing `get_asset` (e.g. `"vectorsearch"`). The engine calls
     * `<server>/get_asset` with the caller's context, so the asset read honours
     * the caller's ACL and fails closed on an unauthorized/unknown asset.
     */
    server: string;
    /** Collection to read the asset from. Defaults to the server's default. */
    collection?: string;
    /** Image size for a whole-asset fetch (ignored for a region zoom). */
    variant?: "thumb" | "preview" | "full";
  };
}

/**
 * Figure-embedding settings for an `llm` node whose answer may show document
 * figures directly to the end user.
 *
 * Configured under an `llm` node's `config.figureEmbedding`. When present — and
 * only when the deployment gate `EMBED_SEARCH_FIGURES=true` plus a configured
 * `MEDIA_BASE_URL` are on as well — the node gets a `show_figure` tool: the
 * hosting model passes an `asset:<id>[#bbox]` reference (or a bare asset id)
 * from its own search results, the engine fetches the bytes through the MCP
 * `get_asset` tool (caller ACL, fail-closed), parks them in the run's media
 * store, and the tool returns a markdown image with a short-lived media URL
 * (`<MEDIA_BASE_URL>/v1/media/<id>.<ext>`) that the model pastes into its
 * answer. The bytes never enter the model context.
 *
 * The link is capability-style: anyone who knows it can fetch the figure until
 * the media store's TTL expires. Enable it only where that is acceptable, and
 * prefer a small `variant` (thumb/preview) over `full`.
 */
export interface FigureEmbeddingConfig {
  /** Overrides the generated tool description. */
  description?: string;
  /**
   * Where the figure bytes come from — same shape as
   * {@link ImageInspectionConfig.assetSource}. Required: without an MCP
   * `get_asset` source there is nothing to embed.
   */
  assetSource: NonNullable<ImageInspectionConfig["assetSource"]>;
}

/**
 * Schema definition for structured output from a `classifier` node.
 * Uses a JSON Schema subset that the AI SDK's generateObject supports.
 */
export interface ClassifierOutputSchema {
  /** JSON Schema for the structured output object */
  schema: Record<string, unknown>;
  /**
   * Key within the output object whose value is used as the routing label.
   * Must be a string-valued field.
   */
  classKey: string;
}

/**
 * Dynamic model/tool selection based on classification labels AND request context.
 *
 * A node can declare multiple overrides; the first matching one wins.
 * Matching logic (all supplied conditions must be true):
 *   - `whenClass`   — matches `state.classLabel` (supports "*" wildcard)
 *   - `whenClaim`   — expression evaluated against JWT claims (e.g. "role == 'admin'")
 *   - `whenParam`   — expression evaluated against requestParams
 *   - `whenPlan`    — matches `ctx.plan` exactly
 *   - `whenGroup`   — checks if one of `ctx.groups` includes the value
 *   - `whenLanguage`— matches `ctx.language` (prefix match, e.g. "de" matches "de-AT")
 */
export interface NodeOverride {
  /** Classification label condition — supports wildcard "*" */
  whenClass?: string;
  /** Expression evaluated against `ctx.claims` — uses the same safe evaluator */
  whenClaim?: string;
  /** Expression evaluated against `ctx.requestParams` */
  whenParam?: string;
  /** Matches `ctx.plan` exactly */
  whenPlan?: string;
  /** Matches if `ctx.groups` contains this value */
  whenGroup?: string;
  /** Language prefix match: "de" matches "de", "de-AT", "de-CH" */
  whenLanguage?: string;
  /** LLM config to use instead of the node's static config */
  llm?: LlmConfig;
  /** MCP tool refs to use instead of the node's static tools list */
  tools?: string[];
  /** Override the node's systemPrompt for this condition */
  systemPrompt?: string;
}

/**
 * A rule in the flow dispatch table.
 * Rules are evaluated top-to-bottom; the first matching rule's `targetFlow`
 * is used instead of the model field from the request.
 * All declared conditions must match simultaneously (AND semantics).
 */
export interface FlowDispatchRule {
  /** Human-readable description of this rule */
  description?: string;
  /** Match on `ctx.role` */
  whenRole?: string;
  /** Match if `ctx.groups` contains this value */
  whenGroup?: string;
  /** Match on `ctx.plan` (e.g. "pro", "enterprise") */
  whenPlan?: string;
  /** Match on language prefix (e.g. "de" matches "de-AT") */
  whenLanguage?: string;
  /** Expression evaluated against JWT claims */
  whenClaim?: string;
  /** Expression evaluated against requestParams */
  whenParam?: string;
  /** Regex pattern matched against the requested model/flow name */
  whenModel?: string;
  /** The flow ID to execute when this rule matches */
  targetFlow: string;
}

/**
 * Flow dispatch table, stored in a JSON file at `flowsDir/dispatch.json`.
 * Allows user/tenant/request-attribute-based flow selection without touching
 * individual flow definitions.
 *
 * Example `flows/dispatch.json`:
 * {
 *   "rules": [
 *     { "whenRole": "admin", "targetFlow": "admin-flow" },
 *     { "whenGroup": "premium", "whenLanguage": "de", "targetFlow": "de-premium-flow" },
 *     { "whenParam": "plan == 'enterprise'", "targetFlow": "enterprise-flow" }
 *   ]
 * }
 */
export interface FlowDispatchTable {
  rules: FlowDispatchRule[];
}
export interface FlowNode {
  /** Unique identifier within the flow */
  id: string;
  /**
   * Node handler type:
   * - `llm`            — streaming LLM call with optional agent tool-loop
   * - `tool`           — deterministic MCP tool calls
   * - `router`         — routing-only; no LLM, evaluates edges
   * - `classifier`     — structured JSON output via generateObject; writes to state.classification
   * - `parallel`       — fan-out: executes all child node IDs concurrently, then merges
   * - `retrieval`      — RAG: embeds the query, fetches top-K chunks from a vector
   *                      collection, injects them as grounding context + citations
   * - `memory`         — recalls long-term memories for the user/tenant scope and
   *                      injects them as personalisation context
   * - `agent-harness`  — orchestrates over the graph: plans tasks via an LLM then
   *                      delegates each task to allowlisted worker nodes/subflows
   *
   * Built-in types are listed for editor autocomplete; any other string is a
   * plugin-provided type resolved at runtime via the node handler registry
   * (`string & {}` keeps the literal suggestions while accepting any value).
   */
  type:
    | "llm"
    | "tool"
    | "router"
    | "classifier"
    | "parallel"
    | "retrieval"
    | "memory"
    | "agent-harness"
    | "transform"
    | "trigger"
    | "assistant-context"
    | "assistant-learn"
    | (string & {});
  /** Human-readable display label */
  label?: string;
  /** Queue priority for requests reaching this LLM node; higher runs first. */
  priority?: number;
  /** LLM configuration — falls back to global default if omitted */
  llm?: LlmConfig;
  /** MCP tool identifiers this node may invoke (max 50, each max 128 chars) */
  tools?: string[];
  /** Node-type-specific extra configuration */
  config?: Record<string, unknown>;
  /**
   * Schema for structured output (classifier nodes only).
   * The result is stored in state.classification and exposed to routing conditions.
   */
  classifierSchema?: ClassifierOutputSchema;
  /**
   * System prompt override for this node (llm/classifier nodes).
   * Prepended to the message list as a system message.
   */
  systemPrompt?: string;
  /**
   * Dynamic overrides applied based on the current classification label.
   * Checked in order; first matching override wins.
   */
  overrides?: NodeOverride[];
  /**
   * Children for `parallel` nodes. Each entry is either:
   *   - a plain node ID string (always runs), or
   *   - `{ node, condition }` where `condition` is a routing-style expression
   *     (same grammar as edge `conditions`, evaluated against the run state /
   *     classification). The child runs only when the condition is true.
   *
   * All entries that run do so concurrently; their state updates are merged.
   * This lets one parallel node fan out an optional source (e.g. a vision
   * extraction gated on `classification.hasAttachment == true`) instead of
   * duplicating the whole node for the with/without variants.
   */
  parallelNodes?: ParallelNodeEntry[];
}

/**
 * A conditional child reference inside a `parallel` node's `parallelNodes`.
 * The referenced node runs only when `condition` evaluates to true (or always
 * when `condition` is omitted).
 */
export interface ParallelChild {
  /** ID of the child node to execute. */
  node: string;
  /**
   * Optional condition expression (same grammar as edge `conditions`). The
   * child is skipped when the expression evaluates to false. Omit to always run.
   */
  condition?: string;
}

/** An entry in `parallelNodes`: a plain node ID or a conditional child. */
export type ParallelNodeEntry = string | ParallelChild;

/** Extracts the child node ID from a `parallelNodes` entry. */
export function parallelChildId(entry: ParallelNodeEntry): string {
  return typeof entry === "string" ? entry : entry.node;
}

/**
 * Extracts the optional condition expression from a `parallelNodes` entry.
 * Returns `undefined` for plain-string entries (which always run).
 */
export function parallelChildCondition(
  entry: ParallelNodeEntry,
): string | undefined {
  return typeof entry === "string" ? undefined : entry.condition;
}

/**
 * A directed edge between two nodes in a flow graph.
 */
export interface FlowEdge {
  /** Optional unique identifier for the edge */
  id?: string;
  /** Source node ID */
  source: string;
  /** Target node ID */
  target: string;
  /** Routing condition expression string, max 1024 characters */
  conditions?: string;
  /** Human-readable label */
  label?: string;
}

/**
 * Complete definition of an agent flow, stored as a JSON file.
 */
export interface FlowDefinition {
  /** Unique flow identifier — maps to the `model` field in chat requests */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Optional description */
  description?: string;
  /** Queue priority for flow requests; higher values run first, default 50. */
  priority?: number;
  /**
   * Flow-scoped variables.
   *
   * A map of variable name → value. Any string anywhere in the flow's nodes or
   * edges may reference a variable with the `{{vars.<name>}}` placeholder. These
   * references are resolved once at load time:
   *   - When the whole string is exactly `{{vars.x}}`, it is replaced with the
   *     variable's value preserving its JSON type (string, number, boolean,
   *     object, array).
   *   - When the placeholder is embedded in a larger string, the value is
   *     stringified and interpolated.
   * Dotted names address into object-valued variables, e.g. `{{vars.models.fast}}`.
   *
   * This lets a flow declare things like the LLM model names once and reference
   * them throughout, so changing a model only requires editing this one block.
   * The resolved values are baked into the flow definition and therefore are
   * available unchanged for the whole execution and to every downstream node.
   */
  variables?: Record<string, unknown>;
  /**
   * Per-model token prices used to estimate the cost of each LLM call in this
   * flow. Keyed by `"provider/model"` (e.g.
   * `"bedrock/eu.anthropic.claude-haiku-4-5-20251001-v1:0"`) or by a bare model
   * id. Values are price units per 1,000,000 tokens, split into `prompt`
   * (input) and `completion` (output). The unit is currency-agnostic — use
   * whatever monetary or abstract unit fits your accounting. These take
   * precedence over the built-in pricing table and the global `LLM_PRICING`
   * config for this flow, so each flow can declare the exact prices it is
   * billed at.
   */
  pricing?: Record<string, FlowModelPrice>;
  /**
   * Data classifications this flow processes (e.g. `["personal", "financial"]`)
   * — declared once for the whole flow so the compliance policy engine's
   * `dataRules` (`compliance-policy.yaml`, ADR-0009) can enforce provider/region
   * allow-lists for it. Deliberately static/declarative rather than
   * auto-detected from message content: a content-based heuristic (regex over
   * user text) risks false-positive denials on live traffic, which is a worse
   * failure mode than an omitted declaration (silently not enforced, same as
   * before this field existed). The flow author states what the flow is FOR;
   * the policy decides what's allowed for that. Optional — a flow that omits
   * this carries no `dataClasses` into policy evaluation, so `dataRules` stay
   * a no-op for it exactly as before this field existed.
   */
  dataClasses?: DataClass[];
  /**
   * OAuth/OIDC scopes required to discover and execute this flow. Every listed
   * scope must be present in one of the configured JWT scope claims.
   */
  requiredScopes?: string[];
  /**
   * Whether the Durable Agent Runtime may re-run this flow after the executing
   * replica crashed mid-run (ADR-0023).
   *
   * Why this is per-flow and not just a global switch
   * ─────────────────────────────────────────────────
   * `JOB_RECOVERY_ENABLED` turns crash recovery on for the whole deployment,
   * and the retry re-runs the flow **from the beginning** — it is not a
   * step-exact resumption from a checkpoint. For a read-only flow (retrieval,
   * research, classification) that is harmless. For a flow whose tools write to
   * a foreign system — send an e-mail, create a ticket, post a payment — it can
   * repeat that side effect.
   *
   * Before this field existed the choice was all-or-nothing: either every async
   * job was retryable or none was. That is the wrong granularity for the actual
   * risk, which is a property of the individual flow's tools.
   *
   * Semantics:
   *   - `retry: true`  — safe to re-run; retried when recovery is enabled
   *                      globally.
   *   - `retry: false` — never retried, even with recovery enabled globally. The
   *                      sweeper fails such a job with a stated reason instead,
   *                      so the client sees a clean terminal state.
   *   - omitted        — the global default applies, i.e. exactly the behaviour
   *                      from before this field existed. Deliberately NOT
   *                      fail-closed, because silently disabling recovery for a
   *                      deployment that had opted into it would be a
   *                      regression the operator did not ask for. The
   *                      production-readiness gate reports when the carve-out is
   *                      unused so the gap stays visible rather than implied.
   */
  recovery?: FlowRecoveryPolicy;
  /**
   * Per-execution budgets (tokens, tool calls, wall-clock). Enforced centrally
   * by the engine: once a limit is reached the execution stops BEFORE the next
   * model or tool call (a call already in flight is never aborted) and finishes
   * with `finishReason: "budget_exceeded"`, returning the text produced so far.
   * Absent → no budget enforcement (behaviour unchanged).
   */
  budgets?: FlowExecutionBudget;
  /** Flow nodes — between 1 and 100 */
  nodes: FlowNode[];
  /** Flow edges — between 0 and 500 */
  edges: FlowEdge[];
  /**
   * Arbitrary metadata attached to the flow.
   * The optional `ui` key carries canvas layout data used by the visual editor
   * (see `FlowUiMetadata`). It is additive and semantically neutral — the graph
   * engine never inspects it.
   */
  metadata?: Record<string, unknown> & {
    ui?: FlowUiMetadata["ui"];
  };
}

/**
 * Per-execution budget limits declared by a flow (`budgets` block). All three
 * dimensions are optional and independent; a dimension that is omitted is
 * simply not enforced. Enforced by `ExecutionBudget` in
 * `graph/execution-budget.ts`.
 */
export interface FlowExecutionBudget {
  /** Max sum of prompt + completion tokens over all LLM calls of the execution. */
  maxTokens?: number;
  /** Max sum of all MCP/tool calls of the execution. */
  maxToolCalls?: number;
  /** Max wall-clock milliseconds since the execution started. */
  maxWallMs?: number;
}

/**
 * Token price for a single model, in currency-agnostic units per 1,000,000
 * tokens. Mirrors the `ModelPrice` shape used by the cost estimator so
 * flow-declared prices thread straight into the estimator as overrides.
 */
export interface FlowModelPrice {
  /** Price units per 1,000,000 prompt (input) tokens. */
  prompt: number;
  /** Price units per 1,000,000 completion (output) tokens. */
  completion: number;
}

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
 * This information is used exclusively by the visual editor; the graph engine
 * ignores it entirely. Storing it inside `metadata` keeps the YAML/JSON format
 * stable and avoids introducing a new top-level key.
 */
export interface FlowUiMetadata {
  ui?: {
    /** Canvas position for each node, keyed by node ID. */
    layout: UiNodeLayout[];
    /** Saved viewport (pan + zoom) of the editor canvas. */
    viewport?: { x: number; y: number; zoom: number };
  };
}
