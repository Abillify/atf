// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Node type catalog (`src/graph/node-type-catalog.ts`)
 *
 * One machine-readable description of every built-in node type: what it does,
 * which top-level node fields it uses, and EVERY `config` key its handler (or a
 * cross-cutting engine feature) reads — with type, default, bounds, meaning
 * and an example. It is the single source for:
 *
 *   - the Studio's per-type settings forms (`GET /flows/node-types`),
 *   - the documentation panel shown next to a selected node,
 *   - the Copilot prompt, so it can configure nodes instead of guessing keys.
 *
 * Keeping it next to the handlers — and checked by
 * `__tests__/node-type-catalog.test.ts` against the zod config schemas and the
 * `node.config` keys the code actually reads — is what keeps it complete when
 * a handler gains a new option.
 *
 * Texts describe the code's behaviour as implemented; where a default depends
 * on runtime configuration that is said explicitly.
 */

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
  /** What it does, when to use it, what happens when it is absent. */
  description: string;
  /** Effective behaviour when the key is absent (as a value or a sentence). */
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  /** For `enum`. */
  options?: string[];
  /** For `object`: its sub-fields (rendered as a nested form). */
  fields?: ConfigField[];
  /** Required within its object (top-level config keys are all optional unless said). */
  required?: boolean;
  /** Example value (used for JSON fields and in the docs). */
  example?: unknown;
  /** Rarely needed; the form tucks it under "Advanced". */
  advanced?: boolean;
}

export interface TopLevelField {
  key: "llm" | "systemPrompt" | "tools" | "classifierSchema" | "parallelNodes" | "overrides" | "priority" | "label";
  usage: "required" | "recommended" | "optional" | "ignored";
  description: string;
}

export interface NodeTypeDoc {
  type: string;
  title: string;
  /** One sentence for lists and the palette. */
  summary: string;
  /** Longer explanation, paragraphs separated by blank lines (Markdown). */
  description: string;
  whenToUse: string[];
  topLevel: TopLevelField[];
  config: ConfigField[];
  examples: Array<{ title: string; yaml: string }>;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Reusable field definitions
// ---------------------------------------------------------------------------

const LLM_REF_DESC =
  "A model: `{ shortcut: <name from flows/model-shortcuts.yaml> }` or `{ provider, model, parameters? }` (provider = a PROVIDERS name or protocol).";

/** Cross-cutting keys the engine reads on every node type. */
export const COMMON_CONFIG_FIELDS: ConfigField[] = [
  {
    key: "errorStrategy",
    kind: "enum",
    label: "Error strategy",
    options: ["fail-fast", "continue", "fallback"],
    default: "fail-fast",
    description:
      "What the engine does when this node throws. `fail-fast` aborts the run with the error. `continue` records the error and carries on with the next node (the run can still succeed). `fallback` runs `fallbackNodeId` instead; without a fallback node it behaves like `continue`.",
  },
  {
    key: "fallbackNodeId",
    kind: "node-ref",
    label: "Fallback node",
    description:
      "Node executed when this node fails and `errorStrategy` is `fallback`. If the fallback node also fails, the run fails with both errors.",
  },
  {
    key: "requiresApproval",
    kind: "tool-list",
    label: "Tools requiring approval",
    description:
      "Tool refs or patterns (`server/tool`, `server/*`, bare name) that must be approved by a human before this node may call them. The call pauses, an approval request appears in Approvals / the client stream, and it is denied automatically when nobody answers in time (fail-closed). Applies to `llm` agent loops and `tool` nodes.",
    example: ["taiga/task_create", "parking/*"],
  },
  {
    key: "progress",
    kind: "object",
    label: "Progress messages",
    description:
      "Opt-in, server-authored lifecycle lines streamed to the client while this node runs (instead of exposing model reasoning). Any node with a `progress` object switches progress reporting on for the whole flow.",
    advanced: true,
    fields: [
      { key: "start", kind: "string", label: "On start", description: "Shown when the node starts. Falls back to the node label / id." },
      { key: "complete", kind: "string", label: "On completion", description: "Shown when the node finishes successfully." },
      { key: "error", kind: "string", label: "On error", description: "Shown when the node fails." },
    ],
    example: { start: "Suche in den Akten…", complete: "Akten durchsucht", error: "Aktensuche fehlgeschlagen" },
  },
];

const TOOL_ARGS_FIELD: ConfigField = {
  key: "toolArgs",
  kind: "json",
  label: "Forced tool arguments",
  description:
    "Per tool ref, arguments fixed server-side: `{ \"server/tool\": { arg: value } }`. On `llm` nodes they are MERGED over what the model supplies (the model still chooses e.g. `query`, the configured keys are enforced); on `tool` nodes they are the complete argument set. String values may contain templates resolved against the run state: `{{query}}`, `{{classification.<field>}}`, `{{node.<id>.classification.<field>}}`, `{{turn[1].<id>.classification.<field>}}`, `{{context.<key>}}`. Use it to pin e.g. a vectorsearch `collection` so a model can't hit the wrong store.",
  example: { "vectorsearch/search": { collection: "cases", tags: ["{{classification.clientTags}}"] } },
};

const STREAM_TOOL_DETAILS_FIELD: ConfigField = {
  key: "streamToolResultDetails",
  kind: "boolean",
  label: "Stream tool result details",
  default: true,
  description:
    "When false, tool calls stay visible in the client stream (name, status, duration) but their result payload is not streamed. The result still feeds grounding, citations, monitoring and the next model call. Use for private worker nodes.",
};

const TOOL_CONTEXT_FIELD: ConfigField = {
  key: "toolContext",
  kind: "json",
  label: "Evidence retrieval around actions",
  advanced: true,
  description:
    "Retrieves evidence with a context tool before (`pre`) and/or after (`post`) matching tool calls and attaches it to the call — e.g. look up the case file before creating a ticket. `server`/`tool` default to `vectorsearch`/`retrieve_evidence`. Each stage: `match` (tool patterns, default `[\"*\"]`), `queryTemplate` (required), `arguments`, `handleArgument`, `required` (fail the action when no evidence, default false), `appendEvidence` (default true), `maxResultChars` (default 8000, min 256). `evidenceContract: { match, required }` declares actions that must carry a verified evidence pack into governance.",
  example: {
    server: "vectorsearch",
    tool: "retrieve_evidence",
    pre: { match: ["taiga/task_create"], queryTemplate: "{{query}}", required: true },
  },
};

const LLM_REF_FIELD = (key: string, label: string, description: string): ConfigField => ({
  key,
  kind: "llm",
  label,
  description: `${description} ${LLM_REF_DESC}`,
});

/**
 * Inside the node's top-level `llm` field — the model selection. Not part of
 * any type's `config` (it edits `node.llm`, not `node.config`), so the Studio
 * renders it as its own documentation section and marks these dotted keys when
 * the corresponding form control or JSON cursor position is inside `llm`.
 */
export const LLM_MODEL_FIELDS: ConfigField[] = [
  {
    key: "llm.shortcut",
    kind: "string",
    label: "Shortcut",
    description:
      "Name of a preset in `flows/model-shortcuts.yaml` (or a `{{vars.*}}` reference to one). A shortcut carries provider, model and preset parameters in one place, and may resolve to a **pool** (an ordered fallback/round-robin chain of models). Mutually exclusive with `provider`/`model` on the same node — the parser expands the shortcut over them at load time.",
    example: "fast-pool",
  },
  {
    key: "llm.provider",
    kind: "string",
    label: "Provider",
    description:
      "A PROVIDERS entry name (a named instance with its own base URL and key) or a protocol (`openai`, `google`, `anthropic`, `ollama`, `azure`, `bedrock`). Use it with `model` when no shortcut fits; omit both to fall back to the deployment's `DEFAULT_LLM`.",
    example: "openai",
  },
  {
    key: "llm.model",
    kind: "string",
    label: "Model",
    description:
      "Concrete model id served by `provider` (e.g. `qwen3-32b`, `gpt-4o`). Only meaningful together with `provider`; a shortcut sets both itself, so don't mix the two.",
    example: "qwen3-32b",
  },
  {
    key: "llm.parameters",
    kind: "object",
    label: "Generation parameters",
    description:
      "Generation parameters for this node's model calls (max 20 keys). Values here override what a shortcut preset carries. Unknown keys are forwarded to the provider SDK, so provider-specific options (e.g. `topP`) work without a code change.",
    fields: [
      {
        key: "temperature",
        kind: "number",
        label: "Temperature",
        min: 0,
        max: 2,
        step: 0.05,
        description:
          "Sampling temperature 0–2. Lower = deterministic (classification, extraction); higher = creative. Omitted = provider default.",
      },
      {
        key: "maxTokens",
        kind: "number",
        label: "Max output tokens",
        integer: true,
        min: 1,
        max: 65536,
        description:
          "Hard cap on output tokens. Raise it for long answers or structured output; the request fails when the answer would exceed it.",
      },
      {
        key: "reasoningEffort",
        kind: "enum",
        label: "Reasoning effort",
        options: ["none", "minimal", "low", "medium", "high"],
        description:
          "How much thinking the model invests, mapped per provider (OpenAI `reasoning_effort`, Anthropic thinking budget, Gemini/Ollama `thinking_config`/`think`). `none` disables reasoning where supported. Ignored by models without reasoning support.",
      },
      {
        key: "contextLength",
        kind: "number",
        label: "Context window (tokens)",
        integer: true,
        min: 1,
        description:
          "Explicit context-window size for this model. Overrides the capability registry and drives history compression and the tool-result budget — set it when a self-hosted model's window is unknown to the platform or served with a reduced one.",
      },
    ],
    example: { temperature: 0.2, maxTokens: 4096 },
  },
  {
    key: "llm.weight",
    kind: "number",
    label: "Pool weight",
    min: 0,
    step: 0.1,
    advanced: true,
    description:
      "Relative weight of this model inside a pool — used by `weighted-round-robin` and `weighted-random`. Ignored outside a pool. Set on a pool candidate, not usually on the node itself.",
  },
  {
    key: "llm.pool",
    kind: "json",
    label: "Model pool",
    description:
      "Ordered model chain attached by a POOL shortcut, or written directly: `{ strategy?, candidates: [{ provider, model, parameters? }, …] }`. `strategy`: `fallback` (default — strict order, each later member is a failover), `round-robin`, `weighted-round-robin`, `random`, `weighted-random`, `least-used`. The host `llm` always carries the first candidate's provider/model, so consumers that ignore `pool` still see a valid model. A candidate may itself carry a nested `pool`.",
    example: { strategy: "fallback", candidates: [{ provider: "openai", model: "gpt-4o" }, { provider: "ollama", model: "qwen3-32b" }] },
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const LLM: NodeTypeDoc = {
  type: "llm",
  title: "LLM",
  summary:
    "Streaming model call, optionally with an agent tool loop over MCP tools.",
  description: [
    "Calls a language model with the conversation so far, the node's system prompt and any grounding context injected by earlier nodes (retrieval, parallel/RAG, memory). The answer streams to the client unless a later node produces the final answer.",
    "With `tools`, the node runs an **agent loop**: the model may call MCP tools, sees their results and continues until it answers or the step budget (`maxToolSteps`) is used up. Tool results are budgeted to the model's context window (`toolResultBudget`) and can be grounded/cited.",
    "The model comes from `llm` (a shortcut or provider/model); without `llm` the runtime's `DEFAULT_LLM` is used. A shortcut that resolves to a **pool** gives the node an ordered fallback/round-robin chain of models.",
    "Structured output: with `config.outputSchema` the node returns a JSON object instead of prose (see below). Classification-style routing is usually better done with a `classifier` node.",
  ].join("\n\n"),
  whenToUse: [
    "Answering the user (responder, synthesizer).",
    "Agentic work with tools: research, lookups, actions (with approval for consequential tools).",
    "Any free-text transformation step (summarise, rewrite, extract into prose).",
  ],
  topLevel: [
    {
      key: "llm",
      usage: "recommended",
      description: "Model to call. Omit to use DEFAULT_LLM.",
    },
    {
      key: "systemPrompt",
      usage: "recommended",
      description:
        "Instructions for this step. Supports `#[[file:prompts/x.md]]` includes and `{{vars.*}}` / `{{context.*}}` / `{{node.<id>.classification.*}}` placeholders.",
    },
    {
      key: "tools",
      usage: "optional",
      description:
        "MCP tool refs (`server/tool`, `server/*`) the agent loop may call. Empty = plain model call.",
    },
    {
      key: "overrides",
      usage: "optional",
      description:
        'Conditional per-request variants, applied in order — the FIRST matching entry wins and replaces `llm`, `systemPrompt` and `tools` wholesale (keys it omits stay as on the node). Match conditions (all present ones must hold): `whenClass` (classLabel, `*` wildcard), `whenClaim` (expression over JWT claims, e.g. `role == \'admin\'`), `whenParam` (expression over requestParams), `whenPlan` (exact), `whenGroup` (ctx.groups contains), `whenLanguage` (BCP-47 prefix, `de` matches `de-AT`). Example: `[{ whenClass: "SIMPLE", llm: { shortcut: fast }, systemPrompt: "..." }]`.',
    },
    {
      key: "priority",
      usage: "optional",
      description:
        "Queue priority for model requests from this node; higher runs first. A flow's effective priority is the maximum of its own and those of its `llm`/`classifier` nodes.",
    },
    {
      key: "classifierSchema",
      usage: "ignored",
      description:
        "Not used — that is the `classifier` type. For a schema-constrained answer from an `llm` node use `config.finalAnswerContract` or a structured downstream classifier.",
    },
    {
      key: "label",
      usage: "optional",
      description:
        "Human-readable name shown on the canvas, in lists and as the default progress text. Purely cosmetic — edges, templates and references address the node by its `id`.",
    },
  ],
  config: [
    {
      key: "maxToolSteps",
      kind: "number",
      label: "Max tool steps",
      integer: true,
      min: 1,
      default: "runtime MAX_TOOL_STEPS",
      description:
        "Upper bound on model↔tool round trips in one turn. Raise it for agentic nodes that read many documents; invalid values fall back to the global setting.",
    },
    TOOL_ARGS_FIELD,
    {
      key: "toolSelection",
      kind: "object",
      label: "Dynamic tool selection",
      description:
        "With many tools, advertise only the relevant ones. In `semantic` mode the node's full `tools` list becomes a candidate pool: all stay callable, but only `alwaysInclude` + the top-K semantic matches (+ an optional `select_tools` meta-tool the model can use to pull more in) are advertised initially.",
      fields: [
        {
          key: "mode",
          kind: "enum",
          label: "Mode",
          options: ["static", "semantic"],
          default: "static",
          description:
            "`static` advertises every tool; `semantic` gates by embedding similarity to the request.",
        },
        {
          key: "topK",
          kind: "number",
          label: "Top K",
          integer: true,
          min: 1,
          default: 5,
          description: "Max semantically selected tools advertised initially.",
        },
        {
          key: "minScore",
          kind: "number",
          label: "Min score",
          min: 0,
          max: 1,
          step: 0.05,
          description: "Drop semantic hits below this cosine similarity.",
        },
        {
          key: "alwaysInclude",
          kind: "tool-list",
          label: "Always include",
          description:
            "Refs/patterns always advertised (full ref, bare name, `server/*`, `*`).",
        },
        {
          key: "metaTool",
          kind: "boolean",
          label: "Meta tool",
          description: "Expose the on-demand `select_tools` meta-tool.",
        },
        {
          key: "metaToolName",
          kind: "string",
          label: "Meta tool name",
          default: "select_tools",
          description: "Name advertised for the meta-tool.",
        },
        {
          key: "metaTopK",
          kind: "number",
          label: "Meta top K",
          integer: true,
          min: 1,
          default: 2,
          description: "Max tools activated per meta-tool call.",
        },
        {
          key: "cacheStable",
          kind: "boolean",
          label: "Cache-stable",
          default: false,
          description:
            "Advertise the full pool in a stable order instead of gating per request — keeps the tools+system prompt prefix byte-identical so provider prompt caching hits. Good for hot multi-turn nodes with a large stable prompt.",
        },
      ],
    },
    {
      key: "requireToolUse",
      kind: "boolean",
      label: "Require tool use (contract)",
      default: false,
      description:
        "A contract: a text-only answer is worthless, so the node must call at least one tool before it may answer. If the model keeps refusing, the node FAILS rather than emitting ungrounded prose. Use for researcher nodes whose findings must come from real retrieval.",
    },
    {
      key: "requireToolUseWhenSelected",
      kind: "boolean",
      label: "Require tool use when selected (heuristic)",
      default: false,
      description:
        'A heuristic: force a tool call only when semantic tool selection found a plausibly relevant tool. Unlike `requireToolUse` it never fails the turn — when the forced call is refused the user still gets an answer. Messages without own intent ("retry", "test", "ok"…) never trigger it.',
    },
    {
      key: "requireToolUseWhenSelectedMinScore",
      kind: "number",
      label: "…minimum selection score",
      min: 0,
      max: 1,
      step: 0.05,
      description:
        "Minimum semantic score the best-selected tool needs before `requireToolUseWhenSelected` forces a call.",
    },
    {
      key: "toolSequenceContract",
      kind: "json",
      label: "Tool sequence contract",
      advanced: true,
      description:
        "For consequential actions: when the user message matches `when.pattern` (a regex, optional `when.flags`), the tools in `sequence` must all have succeeded in that order before the answer is accepted. Invalid declarations are ignored.",
      example: {
        when: { pattern: "buche|reservier", flags: "i" },
        sequence: ["parking/availability", "parking/book_space"],
      },
    },
    {
      key: "toolLoopGuard",
      kind: "object",
      label: "Tool-call loop guard",
      advanced: true,
      default: "disabled (enable with `true` for defaults)",
      description:
        "Opt-in guard against a model stuck in a tool-call loop. `true` enables it with defaults; an object tunes the detectors. Counts identical calls, same-tool churn (varying args, time-windowed), mutating calls with no observable effect, and A→B→A→B cycles — each with a warn threshold (a steering notice is injected) and a block threshold (the repeated call is refused). Failed tool outcomes count toward churn so a retry storm is caught; policy/approval waits pause the clock.",
      fields: [
        {
          key: "enabled",
          kind: "boolean",
          label: "Enabled",
          default: true,
          description:
            "Master switch — only relevant when the object form is used; `toolLoopGuard: true` enables with defaults.",
        },
        {
          key: "identicalWarnAt",
          kind: "number",
          label: "Identical warn at",
          integer: true,
          min: 2,
          default: 3,
          description:
            "Identical calls (same tool, same args) before a warning is injected.",
        },
        {
          key: "identicalBlockAt",
          kind: "number",
          label: "Identical block at",
          integer: true,
          min: 2,
          default: 5,
          description: "Identical calls before the repeat is blocked.",
        },
        {
          key: "churnWarnAt",
          kind: "number",
          label: "Churn warn at",
          integer: true,
          min: 2,
          default: 6,
          description:
            "Same-tool calls with varying args inside the window before a warning.",
        },
        {
          key: "churnBlockAt",
          kind: "number",
          label: "Churn block at",
          integer: true,
          min: 2,
          default: 10,
          description:
            "Same-tool calls with varying args inside the window before blocking.",
        },
        {
          key: "churnWindowMs",
          kind: "number",
          label: "Churn window (ms)",
          integer: true,
          min: 1000,
          default: 120000,
          description:
            "Time window in which churn is counted; paused time (approvals) is excluded.",
        },
        {
          key: "noProgressWarnAt",
          kind: "number",
          label: "No-progress warn at",
          integer: true,
          min: 2,
          default: 3,
          description:
            "Mutating calls with no observable effect before a warning.",
        },
        {
          key: "noProgressBlockAt",
          kind: "number",
          label: "No-progress block at",
          integer: true,
          min: 2,
          default: 5,
          description:
            "Mutating calls with no observable effect before blocking.",
        },
        {
          key: "cycleWarnAt",
          kind: "number",
          label: "Cycle warn at",
          integer: true,
          min: 2,
          default: 3,
          description: "A→B→A→B cycle repetitions before a warning.",
        },
        {
          key: "cycleBlockAt",
          kind: "number",
          label: "Cycle block at",
          integer: true,
          min: 2,
          default: 4,
          description: "A→B→A→B cycle repetitions before blocking.",
        },
      ],
      example: { identicalWarnAt: 2, identicalBlockAt: 4 },
    },
    {
      key: "clientTools",
      kind: "boolean",
      label: "Accept client tools",
      default: true,
      description:
        "Whether tools sent by the caller (OpenAI `tools` in the request, e.g. Open WebUI knowledge/functions) are offered to this node when client tools are enabled globally. Set false for RAG-only nodes that must answer strictly from the flow's own tools.",
    },
    {
      key: "suppressToolPreamble",
      kind: "boolean",
      label: "Suppress pre-tool narration",
      default: false,
      description:
        'Buffer any text the model writes before a tool call until it is known whether a tool follows. If one does, the narration ("I will now search…") is discarded; if not, it is emitted as the answer. Keeps internal plans out of the client.',
    },
    STREAM_TOOL_DETAILS_FIELD,
    {
      key: "toolResultBudget",
      kind: "object",
      label: "Tool result budget",
      description:
        "Caps on tool output fed back to the model. Derived from the model's context window by default (fixed defaults when the window is unknown); set to override.",
      fields: [
        {
          key: "perResultChars",
          kind: "number",
          label: "Per result (chars)",
          integer: true,
          min: 1000,
          max: 1_000_000,
          description: "Max characters kept from one tool result.",
        },
        {
          key: "perTurnChars",
          kind: "number",
          label: "Per turn (chars)",
          integer: true,
          min: 1000,
          max: 2_000_000,
          description: "Max tool-result characters across one turn.",
        },
      ],
    },
    TOOL_CONTEXT_FIELD,
    {
      key: "refHandles",
      kind: "boolean",
      label: "Short reference handles",
      default: false,
      description:
        "Replace long document references in tool results with short 4-character handles (e.g. `K3NQ`) that the model reads and quotes; the runtime maps them back to the real references before the tool call and in everything the user sees. Use on tool-loop nodes whose model must re-quote `reference`/`base_ref` arguments — small models truncate long paths. Unknown handles are rejected with the valid list instead of hitting the backend. Path-shaped references that no tool returned in this run are rejected the same way (`unregistered_ref`); `link` is never a reference.",
    },
    {
      key: "turnContext",
      kind: "text",
      label: "Turn context",
      description:
        "Per-request context appended to the newest user turn (not the system prompt). Supports {{context.*}}, {{now.*}}, {{node.<id>.classification.<field>}} and {{turn[n]...}}. Omitted when every referenced placeholder resolves empty. Use for classifier output such as an image transcription.",
    },
    {
      key: "sourcesCheck",
      kind: "object",
      label: "Post-answer sources check",
      description:
        "Opt-in deterministic check of the final answer (every switch defaults to off). `completeSection` appends each inline-cited `[n]` that the sources section lacks, built only from the sources registered in this execution, as a trailing stream chunk; it creates the section when missing. Unregistered `[n]` are reported, never invented. `stripRuleMarkers` removes the pseudo marker `[Regel: …]` from answer text that has not been streamed yet (buffered answers, e.g. with `suppressToolPreamble`). Results are reported in the `answer_sources_check` diagnostic.",
      example: {
        completeSection: true,
        heading: "## Quellen",
        stripRuleMarkers: true,
      },
      fields: [
        {
          key: "completeSection",
          kind: "boolean",
          label: "Complete sources section",
          default: false,
          description:
            "Append inline-cited `[n]` missing from the sources section, from registered sources only.",
        },
        {
          key: "heading",
          kind: "text",
          label: "Sources heading",
          description:
            "Markdown heading of the sources section, matched by its text (default `## Quellen`).",
        },
        {
          key: "stripRuleMarkers",
          kind: "boolean",
          label: "Remove [Regel: …] markers",
          default: false,
          description:
            "Remove the pseudo marker `[Regel: …]` from not-yet-streamed answer text. Other bracketed content is left untouched.",
        },
      ],
    },
    {
      key: "outputSchema",
      kind: "json",
      label: "Structured output schema",
      description:
        'Makes the node return a JSON object instead of prose: `{ name?: string (default "output"), schema: <JSON Schema> }`. Uses native structured output where the model supports it, otherwise a schema hint + tolerant parse. A malformed schema is treated as not configured (the node streams normally). Cannot be combined with `finalAnswerContract`.',
      example: {
        name: "result",
        schema: {
          type: "object",
          properties: { status: { type: "string" } },
          required: ["status"],
        },
      },
    },
    {
      key: "finalAnswerContract",
      kind: "object",
      label: "Final answer markers",
      advanced: true,
      description:
        "Only the text between two markers is the answer; everything else (plans, scratch work) is dropped. The output is buffered and validated (both markers present once, in order, non-empty, not a placeholder like `...`). Cannot be combined with `outputSchema`.",
      fields: [
        {
          key: "startMarker",
          kind: "string",
          label: "Start marker",
          required: true,
          description: "Exact marker the model writes before the final answer.",
        },
        {
          key: "endMarker",
          kind: "string",
          label: "End marker",
          required: true,
          description: "Exact marker after the final answer.",
        },
        {
          key: "streamAfterStartMarker",
          kind: "boolean",
          label: "Stream after start marker",
          default: false,
          description:
            "Start streaming once the start marker appeared (marker text itself never reaches the client) instead of buffering the whole answer.",
        },
      ],
      example: { startMarker: "<<ANSWER>>", endMarker: "<<END>>" },
    },
    {
      key: "maxOutputChars",
      kind: "number",
      label: "Max output (chars)",
      integer: true,
      min: 1000,
      max: 1_000_000,
      default: "runtime LLM_MAX_OUTPUT_CHARS, else 64000",
      description:
        "Hard ceiling on generated characters (answer and reasoning together); generation is cut off there. Protects against runaway or looping generations.",
    },
    {
      key: "emptyResponseFallback",
      kind: "boolean",
      label: "Empty-response fallback",
      default: false,
      description:
        "When every attempt and every fallback model returned an empty completion, emit a short neutral answer instead of failing the node. Use on worker nodes inside an agent harness so one empty turn doesn't abort the whole run.",
    },
    {
      key: "emptyResponseFallbackText",
      kind: "string",
      label: "…fallback text",
      default: "(No answer was produced for this step.)",
      description: "The text emitted by `emptyResponseFallback`.",
    },
    {
      key: "reasoningSalvage",
      kind: "boolean",
      label: "Salvage reasoning as answer",
      default:
        "true (unless the runtime fallback policy is `explicit`/`disabled`)",
      description:
        "When a reasoning model puts its whole answer into the reasoning channel and returns empty visible text, use the reasoning as the answer. Set false where reasoning must never be shown.",
    },
    {
      key: "allowToolUseFallback",
      kind: "boolean",
      label: "Allow inferred tool-use fallback",
      advanced: true,
      default:
        "true (unless the runtime fallback policy is `explicit`/`disabled`)",
      description:
        "Allow the runtime to recover a tool call the model described in text instead of emitting it natively.",
    },
    {
      key: "dropRagContext",
      kind: "boolean",
      label: "Drop RAG context",
      default: false,
      description:
        "Remove injected RAG / collection-overview system messages from this node's prompt. For synthesizers that work only from carried-forward findings (which already contain the [n] citations). Citations stay registered.",
    },
    {
      key: "maxHistoryTurns",
      kind: "number",
      label: "Max history turns",
      integer: true,
      min: 1,
      description:
        "Keep only the last N conversation turns in this node's prompt. Absent = full history.",
    },
    {
      key: "historyCompression",
      kind: "object",
      label: "History compression",
      advanced: true,
      description:
        "Summarises older turns when the context gets full. Identical tool results are always deduplicated; summarisation engages above the threshold and needs a known context window. The summary is cached per conversation+node so the prompt prefix stays stable.",
      fields: [
        {
          key: "enabled",
          kind: "boolean",
          label: "Enabled",
          default: false,
          description:
            "Turns history summarisation on; without it only duplicate tool results are removed.",
        },
        {
          key: "thresholdRatio",
          kind: "number",
          label: "Threshold ratio",
          min: 0,
          max: 1,
          step: 0.05,
          description:
            "Share of the context window above which summarisation starts.",
        },
        {
          key: "llm",
          kind: "llm",
          label: "Summariser model",
          description: `Model used for summaries; defaults to this node's model. ${LLM_REF_DESC}`,
        },
      ],
    },
    {
      key: "allowTrailingAssistantTurn",
      kind: "boolean",
      label: "Allow trailing assistant turn",
      advanced: true,
      default: false,
      description:
        "Normally a user turn is appended when the prompt would end on an assistant message (local Qwen builds answer that with an immediate end token, i.e. an empty completion). Set true only for a node that should continue its own last message.",
    },
    {
      key: "inputFilter",
      kind: "enum",
      label: "Run only for attachments",
      options: ["attachments", "current-turn-attachments"],
      description:
        "Skip this node unless the conversation (`attachments`) or the latest user message (`current-turn-attachments`) contains attachments. For vision/extraction steps.",
    },
    {
      key: "imageInspection",
      kind: "object",
      label: "Image inspection",
      advanced: true,
      description:
        "Keeps a text-only node usable with images: inline images are parked as `img-N` references and the node gets a tool to ask a vision model about them. The vision model is mandatory (it must support vision input).",
      fields: [
        {
          key: "llm",
          kind: "llm",
          label: "Vision model",
          required: true,
          description: `Model that looks at the images. ${LLM_REF_DESC}`,
        },
        {
          key: "description",
          kind: "text",
          label: "Tool description",
          description:
            "Description of the inspection tool shown to the hosting model (max 2000 chars).",
        },
        {
          key: "imageDescription",
          kind: "string",
          label: "Image parameter description",
          description: "Description of the image argument (max 1000 chars).",
        },
        {
          key: "maxAnswerChars",
          kind: "number",
          label: "Max answer (chars)",
          integer: true,
          min: 200,
          max: 100_000,
          description: "Cap on the vision answer injected into the context.",
        },
        {
          key: "assetSource",
          kind: "json",
          label: "Asset source",
          advanced: true,
          description:
            "Enables `asset:<id>[#bbox]` references, fetched via the MCP `get_asset` tool. Object with `server` (required, the MCP server exposing get_asset), optional `collection`, and optional `variant` (thumb|preview|full).",
        },
      ],
    },
    {
      key: "mediaTools",
      kind: "json",
      label: "Media generation tools",
      advanced: true,
      description:
        "Tools that generate images/audio/video with their own model and stream the result straight to the user: an array of `{ name, llm, description?, promptDescription? }`. The hosting model only passes a `prompt`.",
      example: [
        {
          name: "generate_image",
          llm: { shortcut: "gemini-image" },
          description: "Erzeugt ein Bild zur Beschreibung",
        },
      ],
    },
    {
      key: "routing",
      kind: "json",
      label: "Cost routing",
      advanced: true,
      description:
        "Picks the model per request from `candidates` (LlmConfig list): `strategy` `cheapest` (blended cost/token), `balanced` (cost for this prompt size) or `quality-aware` (cheapest with observed quality ≥ `minQualityScore`, default 0.7; fewer than `minQualitySamples`, default 5, observations = exploration). Also what the Studio's Optimize panel analyses.",
      example: {
        strategy: "quality-aware",
        candidates: [{ shortcut: "fast-pool" }, { shortcut: "sonnet" }],
        minQualityScore: 0.8,
      },
    },
    {
      key: "objective",
      kind: "json",
      label: "Objective solver",
      advanced: true,
      description:
        'Generalised routing (takes precedence over `routing`): `candidates` (LlmConfig list) walked cheapest-first, the first one meeting ALL `objectives` (`{ metric: "quality"|"cost", op: "gte"|"lte", value }`) wins. `minQualitySamples` (default 5; fewer = unproven, treated as eligible), `maxAttempts`, `fallback` (`cheapest` | `best-quality` | `first`). Every attempt is recorded in the explainability card.',
      example: {
        candidates: [{ shortcut: "fast-pool" }, { shortcut: "sonnet" }],
        objectives: [{ metric: "quality", op: "gte", value: 0.8 }],
        fallback: "best-quality",
      },
    },
  ],
  examples: [
    {
      title: "Responder with a model shortcut",
      yaml: `- id: answer
  type: llm
  label: Antwort
  llm:
    shortcut: "{{vars.model_responder}}"
    parameters: { temperature: 0.2, maxTokens: 4096 }
  systemPrompt: "#[[file:prompts/answer.md]]"`,
    },
    {
      title: "Researcher with pinned vectorsearch collection",
      yaml: `- id: research
  type: llm
  llm: { shortcut: fast-pool }
  tools: [vectorsearch/search, vectorsearch/get_documents]
  config:
    maxToolSteps: 14
    requireToolUse: true
    suppressToolPreamble: true
    toolArgs:
      vectorsearch/search: { collection: cases }
      vectorsearch/get_documents: { collection: cases }`,
    },
  ],
  notes: [
    "Unknown config keys are kept and ignored by the runtime — a typo silently does nothing. The Studio lists them under “Other keys”.",
    "Tool refs of MCP servers the runtime isn't connected to only produce a warning; the node works where the server is available.",
  ],
};

const TOOL: NodeTypeDoc = {
  type: "tool",
  title: "Tool",
  summary: "Deterministic MCP tool calls — no model involved.",
  description: [
    "Calls every tool in `tools` with fixed arguments from `config.toolArgs` (templates resolved against the run state) and accumulates the results. No LLM decides anything — use it for lookups whose parameters are known, e.g. from a classifier.",
    "Search-style results (vectorsearch) become grounding context and citations for the next LLM node; other results are only visible downstream when `injectResultContext` is set.",
  ].join("\n\n"),
  whenToUse: [
    "Fetch data with parameters taken from a classification (ticket id, client, date).",
    "Page through a complete listing (`paginate`) to build an overview.",
  ],
  topLevel: [
    { key: "tools", usage: "required", description: "Tool refs to call, in order." },
    { key: "overrides", usage: "optional", description: "Conditional per-request variants of `tools` — the only way to vary which tools this node calls. Entries match on `whenClass`/`whenClaim`/`whenParam`/`whenPlan`/`whenGroup`/`whenLanguage`, first match wins. The `llm`/`systemPrompt` of a matching entry are resolved but unused, like the node-level ones." },
    { key: "llm", usage: "ignored", description: "Not used — no model is involved." },
    { key: "systemPrompt", usage: "ignored", description: "Not used — no model is involved." },
    { key: "label", usage: "optional", description: "Human-readable name shown on the canvas, in lists and as the default progress text. Purely cosmetic — edges, templates and references address the node by its `id`." },
  ],
  config: [
    TOOL_ARGS_FIELD,
    {
      key: "args",
      kind: "json",
      label: "Default tool arguments",
      description:
        "Arguments applied to EVERY tool this node calls; `toolArgs[ref]` overrides them per tool. String values may contain templates (`{{query}}`, `{{classification.<field>}}`, …) resolved against the run state. Use it when several tools share the same parameter instead of repeating it in each `toolArgs` entry.",
      example: { format: "json", limit: 50 },
    },
    {
      key: "paginate",
      kind: "json",
      label: "Auto-pagination",
      description:
        "Per tool ref: call it repeatedly with an increasing offset until the server-reported `total` is fetched or `maxPages` (default 50) is hit. `{ \"server/tool\": { offsetParam?: \"offset\", limitParam?: \"limit\", maxPages?: 50 } }`; page size defaults to 200.",
      example: { "vectorsearch/list_documents": { offsetParam: "offset", limitParam: "limit", maxPages: 20 } },
    },
    {
      key: "overviewCharBudget",
      kind: "number",
      label: "Overview budget (chars)",
      integer: true,
      description: "Raise the character budget of the injected collection overview so large dossiers list all document titles, not just the leading subset.",
    },
    STREAM_TOOL_DETAILS_FIELD,
    {
      key: "injectResultContext",
      kind: "boolean",
      label: "Inject results for the next LLM",
      default: false,
      description: "Pass non-search tool results (and errors) to the next LLM node as one system message. Without it only search results become context.",
    },
    {
      key: "maxResultContextChars",
      kind: "number",
      label: "…max injected chars",
      integer: true,
      min: 1000,
      max: 100_000,
      default: 20000,
      description: "Size cap for the injected result message.",
    },
    TOOL_CONTEXT_FIELD,
  ],
  examples: [
    {
      title: "Read a ticket by the id a transform extracted",
      yaml: `- id: taiga-ticket-live
  type: tool
  tools: [taiga/userstory_detail]
  config:
    toolArgs:
      taiga/userstory_detail: { ref: "{{classification.ticketId}}" }
    injectResultContext: true`,
    },
  ],
  notes: ["An unresolved template becomes an empty string, never the literal `{{…}}`."],
};

const ROUTER: NodeTypeDoc = {
  type: "router",
  title: "Router",
  summary: "Routing only — evaluates the conditions on its outgoing edges.",
  description: [
    "Does no work itself. After it runs, its outgoing edges are evaluated: the first edge whose `conditions` expression is true is taken; an edge without condition is the default.",
    "Expressions can read `classLabel`, `classification.<field>`, `node.<id>.classification.<field>` (this run), `turn[<n>].<id>.classification.<field>` (earlier turns), `messageCount`, `hasErrors`, `errorCount`, `toolResultCount`, `lastMessageText`, `currentNodeId`. Operators: `== != === !== < <= > >= && || !`, `+ -`, parentheses, and `=~` (case-insensitive regex test, e.g. `lastMessageText =~ 'parkplatz|stellplatz'`). Methods: `.includes(x)` / `.contains(x)`, `.startsWith(x)`, `.endsWith(x)`, `.length`; array index `x[0]`. Literals: numbers, 'strings', true/false, null. No code execution — anything else is a validation error.",
  ].join("\n\n"),
  whenToUse: [
    "Branch after a classifier.",
    "Merge point that fans out to several alternatives.",
  ],
  topLevel: [
    {
      key: "llm",
      usage: "ignored",
      description: "Not used — routing is deterministic, no model runs.",
    },
    {
      key: "systemPrompt",
      usage: "ignored",
      description:
        "Not used — no model runs. The routing logic lives in the edges' `conditions`.",
    },
    {
      key: "tools",
      usage: "ignored",
      description:
        "Not used — MCP tools are called by `llm` and `tool` nodes. Route to one of those when this step needs a tool.",
    },
    {
      key: "label",
      usage: "optional",
      description:
        "Human-readable name shown on the canvas, in lists and as the default progress text. Purely cosmetic — edges, templates and references address the node by its `id`.",
    },
  ],
  config: [],
  examples: [
    {
      title: "Route by a classification field",
      yaml: `edges:
  - { source: router, target: retoure, conditions: "classification.route == 'RETOURE'" }
  - { source: router, target: answer-fast }   # default`,
    },
  ],
  notes: [
    "Hyphenated node ids can't be referenced in edge expressions (they work in templates). Use ids with underscores for classifiers you route on.",
  ],
};

const CLASSIFIER: NodeTypeDoc = {
  type: "classifier",
  title: "Classifier",
  summary:
    "Structured output that sets `classification` (and `classLabel`) for routing.",
  description: [
    "Asks the model for an object matching `classifierSchema.schema` and stores it as `state.classification`; the field named by `classifierSchema.classKey` also becomes `classLabel`. Edge conditions, templates (`{{classification.x}}`) and later nodes read it.",
    "Uses native structured output where the model supports it, otherwise a schema hint and tolerant JSON parsing. With a model pool, an unparseable answer rotates to the next model; when nothing parses, `config.fallback` is used instead of failing the turn.",
  ].join("\n\n"),
  whenToUse: [
    "Triage/intent detection before a router.",
    "Extracting routing-relevant fields (client, needsInfo, hasAttachment).",
  ],
  topLevel: [
    {
      key: "classifierSchema",
      usage: "required",
      description:
        "`{ classKey, schema }` — JSON Schema of the result; `classKey` names the label field.",
    },
    {
      key: "llm",
      usage: "recommended",
      description: "Model; a pool gives per-model fallback.",
    },
    {
      key: "systemPrompt",
      usage: "recommended",
      description:
        "Classification instructions; may reference earlier classifiers via `{{node.<id>.classification.*}}`.",
    },
    {
      key: "priority",
      usage: "optional",
      description:
        "Queue priority for model requests from this node; a flow's effective priority is the maximum of its own and those of its `llm`/`classifier` nodes.",
    },
    {
      key: "tools",
      usage: "ignored",
      description:
        "Not used — a classifier makes one structured call and never enters a tool loop. Classify first, then let an `llm` or `tool` node act on the result.",
    },
    {
      key: "overrides",
      usage: "ignored",
      description:
        "NOT applied: unlike `llm` and `tool` nodes, a classifier reads `llm`/`systemPrompt` directly and never consults `overrides`. Put the variation in the prompt or split the node.",
    },
    {
      key: "label",
      usage: "optional",
      description:
        "Human-readable name shown on the canvas, in lists and as the default progress text. Purely cosmetic — edges, templates and references address the node by its `id`.",
    },
  ],
  config: [
    {
      key: "responseFormat",
      kind: "enum",
      label: "Response format",
      options: ["json", "xml"],
      default: "json",
      description:
        "Output format asked of the model. `xml` helps models that struggle with JSON.",
    },
    {
      key: "fallback",
      kind: "json",
      label: "Fallback classification",
      description:
        "Classification used when no model produced parseable output, so the turn continues on a safe route instead of failing.",
      example: { route: "ALLGEMEINES", needsInfo: false },
    },
    {
      key: "inputFilter",
      kind: "enum",
      label: "Run only for attachments",
      options: ["attachments", "current-turn-attachments"],
      description:
        'Skip this node unless the conversation (`attachments`) or the latest user message (`current-turn-attachments`) contains attachments — for vision-preprocessing classifiers that would otherwise burn a model call on every text-only turn to answer "no image". The skip resolves to `config.fallback` (required — without it the filter is ignored with a trace warning), records the node as completed with a `classifier_skipped_no_attachments` diagnostic, and makes no model call.',
    },
  ],
  examples: [
    {
      title: "Triage",
      yaml: `- id: triage
  type: classifier
  llm: { shortcut: structured-pool }
  classifierSchema:
    classKey: route
    schema:
      type: object
      properties:
        route: { type: string, enum: [RETOURE, TENANTS, BETRIEB, ALLGEMEINES] }
        needsInfo: { type: boolean }
      required: [route, needsInfo]
  config:
    fallback: { route: ALLGEMEINES, needsInfo: false }`,
    },
  ],
  notes: [],
};

const PARALLEL: NodeTypeDoc = {
  type: "parallel",
  title: "Parallel",
  summary: "Fan-out to child nodes and/or data-driven RAG sources, then merge.",
  description: [
    "Runs the nodes listed in `parallelNodes` concurrently (each entry a node id or `{ node, condition }` — the child only runs when the condition is true) and merges their messages/results.",
    "With `config.ragProfiles` it also acts as a **context assembler**: a retrieval plan per request profile, compiled at runtime into `vectorsearch/search` calls. Results of all sources are fused (reranker or score-only), deduplicated per document and injected as grounding context with citations.",
  ].join("\n\n"),
  whenToUse: [
    "Assemble context from several collections at once.",
    "Run independent enrichment steps (memory recall, vision extraction) side by side.",
  ],
  topLevel: [
    {
      key: "parallelNodes",
      usage: "recommended",
      description:
        "Child node ids, or `{ node, condition }` for conditional children. Without it the node only runs `config.ragProfiles`.",
    },
    {
      key: "llm",
      usage: "ignored",
      description:
        "Not used — the children carry their own models. The RAG compression model is `config.ragCompression.llm`.",
    },
    {
      key: "systemPrompt",
      usage: "ignored",
      description: "Not used — the children carry their own prompts.",
    },
    {
      key: "tools",
      usage: "ignored",
      description:
        "Not used — `config.ragProfiles` is compiled into the search calls, and children call their own tools.",
    },
    {
      key: "label",
      usage: "optional",
      description:
        "Human-readable name shown on the canvas, in lists and as the default progress text. Purely cosmetic — edges, templates and references address the node by its `id`.",
    },
  ],
  config: [
    {
      key: "ragProfiles",
      kind: "json",
      label: "RAG profiles",
      description:
        "`profiles`: name → list of sources; `select`: `[{ when: <condition>, use: <profile> }]` (first match wins), else `default`; `shared`: sources added to every profile. A source: `{ collection (required), tags?, limit? (≤100), hybrid?, minScore? (0–1), scoreWeight?, when?, rerank? (default true), groupByDocument? (default true), includeAllVersions?, validAt? (RFC 3339), filter?, filterV2?, pathPrefix?, hyde?, expand?, granularity?, includeAssets?, assets? }` — `tags` may be `{{…}}` templates. `filter` (metadata equality), `filterV2` (eq/in/range operators), `pathPrefix` (folder scope) and `hyde` (HyDE query expansion) are forwarded to vectorsearch. v2 retrieval: `expand` (none|neighbors|section|page) pulls in surrounding context, `granularity` (chunk|section|page|document) picks the unit size, `includeAssets` (none|refs|thumbnails, sent as `include_assets`) returns figure assets per hit; omitted → pre-v2 behaviour. `assets: { attach? (none|auto|always, default none), maxImages? (1–20, default 4), variant? (thumb|preview|full, default preview) }` attaches hit figures as image parts to the responder message — `auto` only when `config.responderLlm` confirms vision input, `always` regardless; the first source declaring `assets` sets the policy for the node. Fusion: `rerank: { topN }` (model rerank) or `maxDocuments` (score-only), plus `minScore`.",
      example: {
        select: [{ when: "classification.route == 'RETOURE'", use: "retoure" }],
        default: "allgemein",
        profiles: {
          retoure: [
            {
              collection: "retoure-docs",
              tags: ["{{classification.clientTag}}"],
              limit: 8,
            },
          ],
          allgemein: [{ collection: "docs", limit: 6 }],
        },
        maxDocuments: 8,
      },
    },
    {
      key: "ragCompression",
      kind: "object",
      label: "Query-focused compression",
      advanced: true,
      description:
        "After fusion, a small model condenses each source to the parts relevant to the question and drops irrelevant ones. Fail-open: on any problem the original chunks are used.",
      fields: [
        {
          key: "enabled",
          kind: "boolean",
          label: "Enabled",
          required: true,
          description:
            "Turns the compression pass on; without it the fused chunks are used as retrieved.",
        },
        {
          key: "llm",
          kind: "llm",
          label: "Model",
          required: true,
          description: `Small extraction model. ${LLM_REF_DESC}`,
        },
        {
          key: "minChars",
          kind: "number",
          label: "Min chunk chars",
          integer: true,
          min: 0,
          default: 400,
          description: "Only compress chunks at least this long.",
        },
        {
          key: "maxTokens",
          kind: "number",
          label: "Max tokens",
          integer: true,
          min: 1,
          default: 2048,
          description: "Output budget of the extraction call.",
        },
      ],
    },
    {
      key: "followupDownweight",
      kind: "object",
      label: "Follow-up down-weighting",
      advanced: true,
      description:
        "In threaded conversations, documents already shown in earlier turns compete at a reduced weight so follow-ups prefer fresh material (they can still resurface when strongly relevant). No effect on the model-rerank path.",
      fields: [
        {
          key: "enabled",
          kind: "boolean",
          label: "Enabled",
          description:
            "Turns down-weighting on (only effective in threaded conversations).",
        },
        {
          key: "factor",
          kind: "number",
          label: "Factor",
          min: 0,
          max: 1,
          step: 0.05,
          default: 0.5,
          description: "Weight multiplier for already-seen documents.",
        },
        {
          key: "cap",
          kind: "number",
          label: "Remembered documents",
          integer: true,
          min: 1,
          default: 100,
          description: "How many seen documents are remembered across turns.",
        },
      ],
    },
    {
      key: "maxFanoutConcurrency",
      kind: "number",
      label: "Max concurrent children",
      integer: true,
      min: 0,
      default: 0,
      description:
        "Limit how many children run at the same time (0 = all at once). Protects provider rate limits and single local inference servers.",
    },
  ],
  examples: [
    {
      title: "Context assembler with a conditional vision child",
      yaml: `- id: rag-context
  type: parallel
  parallelNodes:
    - recall
    - { node: vision-extract, condition: "classification.hasAttachment == true" }
  config:
    ragProfiles:
      default: allgemein
      profiles:
        allgemein: [{ collection: docs, limit: 6 }]`,
    },
  ],
  notes: [
    "Children referenced only via `parallelNodes` need no edges; the Studio draws them as dashed reference links.",
  ],
};

const RETRIEVAL: NodeTypeDoc = {
  type: "retrieval",
  title: "Retrieval",
  summary: "RAG: embeds the query and injects the top-K chunks of one collection.",
  description:
    "Embeds the latest user message, fetches the most similar chunks from `config.collection` in the platform vector store and injects them as grounding context and citations for the next LLM node. Requires RAG to be configured (vector store + embedding model); without a collection or RAG the node is a no-op and the flow runs ungrounded. For vectorsearch collections and multi-source plans use a `parallel` node with `ragProfiles` or a `tool` node instead.",
  whenToUse: ["Simple single-collection grounding on the built-in vector store."],
  topLevel: [
    { key: "llm", usage: "ignored", description: "Not used. The embedding model is a deployment setting (`EMBEDDING_MODEL`), not a node field — this node cannot be pointed at a different one." },
    { key: "systemPrompt", usage: "ignored", description: "Not used — no model is prompted here. The retrieved chunks are injected for the NEXT llm node, whose prompt applies." },
    { key: "tools", usage: "ignored", description: "Not used — this node queries the platform vector store directly. For vectorsearch MCP collections use a `tool` or `parallel` node." },
    { key: "label", usage: "optional", description: "Human-readable name shown on the canvas, in lists and as the default progress text. Purely cosmetic — edges, templates and references address the node by its `id`." },
  ],
  config: [
    { key: "collection", kind: "string", label: "Collection", required: true, description: "Vector collection to search. Without it the node does nothing." },
    { key: "topK", kind: "number", label: "Top K", integer: true, min: 1, default: 4, description: "Number of chunks to inject." },
    { key: "minScore", kind: "number", label: "Min score", min: 0, max: 1, step: 0.05, description: "Drop chunks below this cosine similarity." },
  ],
  examples: [{ title: "Docs retrieval", yaml: `- id: retrieve\n  type: retrieval\n  config: { collection: docs, topK: 6, minScore: 0.3 }` }],
  notes: [],
};

const MEMORY: NodeTypeDoc = {
  type: "memory",
  title: "Memory",
  summary: "Recalls long-term memories of the user/tenant for personalisation.",
  description:
    "Recalls the memories most relevant to the request for the caller's scope and injects them as a system message for the next LLM. Memories are personalisation, not sources: they are not cited and don't affect the groundedness gate. No-op when memory is disabled or the request is anonymous.",
  whenToUse: ["Personal assistants and support flows that should remember user facts."],
  topLevel: [
    { key: "llm", usage: "ignored", description: "Not used. Recall runs against the memory store with the deployment's embedding model, not a per-node one." },
    { key: "systemPrompt", usage: "ignored", description: "Not used — no model is prompted. The recalled memories become a system message for the next llm node." },
    { key: "tools", usage: "ignored", description: "Not used — MCP tools are called by `llm` and `tool` nodes. Route to one of those when this step needs a tool." },
    { key: "label", usage: "optional", description: "Human-readable name shown on the canvas, in lists and as the default progress text. Purely cosmetic — edges, templates and references address the node by its `id`." },
  ],
  config: [
    { key: "topK", kind: "number", label: "Top K", integer: true, min: 1, default: "MEMORY_TOP_K, else 5", description: "Number of memories to recall." },
    { key: "minScore", kind: "number", label: "Min score", min: 0, max: 1, step: 0.05, description: "Minimum similarity for a memory to be included." },
  ],
  examples: [{ title: "Recall", yaml: `- id: recall\n  type: memory\n  config: { topK: 5 }` }],
  notes: [],
};

const AGENT_HARNESS: NodeTypeDoc = {
  type: "agent-harness",
  title: "Agent harness",
  summary:
    "Planner/worker loop that delegates tasks to other nodes within budgets.",
  description: [
    "An orchestrator: a planner model splits the request into tasks and delegates each to a node from `allowlist` (the delegated nodes run like normal nodes). After each round it re-plans with the findings until done, a stop signal appears, or a budget (iterations, cost, time) is exhausted.",
    "Optional **verification** delegates the findings to a reviewer node that must answer with the pass signal before the run counts as complete. **Plannerless** mode skips the planner and loops a worker (optionally over a deterministic document coverage queue).",
    "Results either stay the delegated answers (`resultMode: delegated`, harness is the end node) or are aggregated into one context message for a downstream synthesizer (`context`).",
  ].join("\n\n"),
  whenToUse: [
    "Multi-step, multi-domain questions.",
    "Exhaustive research over a corpus (coverage queue).",
  ],
  topLevel: [
    {
      key: "llm",
      usage: "optional",
      description: "Default planner model (overridden by `config.plannerLlm`).",
    },
    {
      key: "systemPrompt",
      usage: "optional",
      description:
        "Domain guidance for the PLANNER, prepended to the generic planning instructions — not a prompt for the delegated nodes (those carry their own). Ignored entirely when `config.plannerless` is true, because no planner runs.",
    },
    {
      key: "tools",
      usage: "ignored",
      description:
        "Not used — the harness calls no tools itself, it delegates to the `config.allowlist` nodes, which carry their own tools.",
    },
    {
      key: "overrides",
      usage: "ignored",
      description:
        "NOT applied: only `llm` and `tool` nodes consult `overrides`.",
    },
    {
      key: "label",
      usage: "optional",
      description:
        "Human-readable name shown on the canvas, in lists and as the default progress text. Purely cosmetic — edges, templates and references address the node by its `id`.",
    },
  ],
  config: [
    {
      key: "allowlist",
      kind: "node-list",
      label: "Delegation targets",
      required: true,
      description:
        "Node ids the harness may delegate to (at least one). The Studio draws them as dotted links when the harness is selected.",
    },
    {
      key: "maxIterations",
      kind: "number",
      label: "Max iterations",
      integer: true,
      min: 1,
      max: 1000,
      default: 12,
      description: "Hard cap on plan/delegate rounds.",
    },
    {
      key: "maxCost",
      kind: "number",
      label: "Max cost (USD)",
      min: 0,
      step: 0.01,
      description: "Stop when the accumulated cost reaches this.",
    },
    {
      key: "maxTimeMs",
      kind: "number",
      label: "Max time (ms)",
      integer: true,
      min: 1,
      description:
        "Wall-clock ceiling for the whole harness run; it stops with the findings so far.",
    },
    {
      key: "consequentialTargets",
      kind: "node-list",
      label: "Targets needing approval",
      description:
        "Delegations to these nodes pause for human approval; such a task always runs alone.",
    },
    {
      key: "maxDelegationDepth",
      kind: "number",
      label: "Max nesting depth",
      integer: true,
      min: 0,
      default: 2,
      description:
        "How deep harnesses may delegate to other harnesses (0 forbids it). Guards against self-referential loops.",
    },
    {
      key: "maxConcurrentTasks",
      kind: "number",
      label: "Max concurrent tasks",
      integer: true,
      min: 1,
      max: 8,
      default: 3,
      description:
        "Parallel tasks when the planner marks them parallelizable (never the same node twice at once).",
    },
    {
      key: "maxTaskAttempts",
      kind: "number",
      label: "Task retries",
      integer: true,
      min: 0,
      default: 0,
      description:
        "Retries of a failed task before it is recorded as failed (transient provider/tool errors).",
    },
    {
      key: "verification",
      kind: "object",
      label: "Verification gate",
      description:
        "A reviewer node checks the findings before the run may report completion; a rejection feeds its feedback into a re-plan.",
      fields: [
        {
          key: "target",
          kind: "node-ref",
          label: "Reviewer node",
          required: true,
          description:
            "Node id of the reviewer (not scheduled as ordinary work).",
        },
        {
          key: "passSignal",
          kind: "string",
          label: "Pass signal",
          required: true,
          description:
            "Exact verdict the reviewer emits to pass (case-insensitive); anything else is a rejection.",
        },
        {
          key: "maxAttempts",
          kind: "number",
          label: "Rounds",
          integer: true,
          min: 1,
          description:
            "Verification rounds (each costs a verifier call and a re-plan).",
        },
        {
          key: "failClosed",
          kind: "boolean",
          label: "Fail closed",
          default: false,
          description:
            "Reject completion when the verifier is missing/unavailable instead of accepting unverified.",
        },
      ],
    },
    LLM_REF_FIELD(
      "plannerLlm",
      "Planner model",
      "Model for planning/re-planning; falls back to the node's `llm`, then DEFAULT_LLM.",
    ),
    {
      key: "progressNarrator",
      kind: "object",
      label: "Progress narrator",
      advanced: true,
      description:
        "Phrases one status line from completed findings for the client. Sees only a sanitized summary, never reasoning or tool payloads; failures never affect the run.",
      fields: [
        {
          key: "enabled",
          kind: "boolean",
          label: "Enabled",
          default: true,
          description: "Defaults to true when the object is present.",
        },
        {
          key: "llm",
          kind: "llm",
          label: "Model",
          required: true,
          description: `Small fast model. ${LLM_REF_DESC}`,
        },
        {
          key: "timeoutMs",
          kind: "number",
          label: "Timeout (ms)",
          integer: true,
          min: 1,
          description:
            "Deadline per narration call; a timeout just skips that status line.",
        },
        {
          key: "maxOutputChars",
          kind: "number",
          label: "Max chars",
          integer: true,
          min: 80,
          description: "Ceiling on the status line.",
        },
        {
          key: "includeHypotheses",
          kind: "json",
          label: "Include hypotheses",
          description:
            "`{ active?, confirmed?, rejected? }` — which labelled hypotheses may be mentioned.",
        },
      ],
    },
    {
      key: "carryForward",
      kind: "enum",
      label: "Carry forward",
      options: ["full", "condensed"],
      default: "full",
      description:
        "`full` passes each worker's entire output to later rounds; `condensed` only its final answer — needed for long loops over large corpora.",
    },
    {
      key: "condensedFindingMaxChars",
      kind: "number",
      label: "Finding cap (chars)",
      integer: true,
      min: 6000,
      default: 6000,
      description: "Per-finding cap in `condensed` mode.",
    },
    {
      key: "resultMode",
      kind: "enum",
      label: "Result mode",
      options: ["delegated", "context"],
      default: "delegated",
      description:
        "`delegated`: keep the delegated answers (harness is the end node). `context`: one aggregated context message for a downstream synthesizer.",
    },
    {
      key: "streamDelegates",
      kind: "boolean",
      label: "Stream delegates",
      default: true,
      description:
        "Stream workers' tokens to the client. Set false when only a later synthesizer should be visible.",
    },
    {
      key: "stopSignal",
      kind: "string",
      label: "Stop signal",
      description:
        "When a finding contains this text (case-insensitive) the loop stops as completed without another planner call.",
    },
    {
      key: "requiredFindingMarkers",
      kind: "string-list",
      label: "Required finding markers",
      description:
        "Line prefixes a worker result must contain to count as a finding.",
    },
    {
      key: "plannerless",
      kind: "boolean",
      label: "Plannerless",
      default: false,
      description:
        "Skip all planner calls and loop the first allowlist target (or coverage-queue targets).",
    },
    {
      key: "maxStagnantIterations",
      kind: "number",
      label: "Max stagnant passes",
      integer: true,
      min: 1,
      description:
        "Plannerless: stop after this many passes without a new finding (stagnation-limit), keeping all findings.",
    },
    {
      key: "coverageQueue",
      kind: "json",
      label: "Coverage queue",
      advanced: true,
      description:
        "Deterministic plannerless document coverage: assigns documents to workers until the corpus is covered. See the flow schema for the full shape (targets per assignment mode must be allowlisted).",
    },
    {
      key: "coverageWorkerContextMaxChars",
      kind: "number",
      label: "Worker context cap",
      integer: true,
      min: 16000,
      advanced: true,
      description:
        "Max stable context passed to a coverage worker (besides its assignment).",
    },
    {
      key: "verificationContextMaxChars",
      kind: "number",
      label: "Verifier context cap",
      integer: true,
      advanced: true,
      description: "Ceiling for the complete verifier state.",
    },
  ],
  examples: [
    {
      title: "Orchestrator with verifier",
      yaml: `- id: orchestrator
  type: agent-harness
  llm: { shortcut: structured-pool }
  config:
    allowlist: [rag-context, betrieb-responder, retoure-responder]
    maxIterations: 6
    maxCost: 0.5
    carryForward: condensed
    resultMode: context
    streamDelegates: false
    verification: { target: agent-verifier, passSignal: "VERIFIKATION OK", maxAttempts: 2 }`,
    },
  ],
  notes: [
    "The verifier is referenced only via `verification.target`; the Studio draws that link dashed.",
    "`systemPrompt` steers the planner only. A plannerless harness (`config.plannerless: true`) never reads it — the wording of the actual work belongs on the `allowlist` nodes.",
  ],
};

const TRANSFORM: NodeTypeDoc = {
  type: "transform",
  title: "Transform",
  summary: "Deterministic lookup/regex rules that add fields to `classification`.",
  description:
    "Runs no model. `derive` rules look up the value of a classification field in a static table and write the matched row's fields onto the classification (e.g. client → collection tags). `extract` rules apply a bounded regex to the user message (`from: query`) or a classification field and write a capture group to `target`. A non-match always writes an empty string, so the shape stays stable. At least one rule is required.",
  whenToUse: ["Map a classifier value to technical parameters.", "Pull ids (ticket numbers) out of the message without an LLM."],
  topLevel: [
    { key: "llm", usage: "ignored", description: "Not used — the rules are deterministic, nothing is inferred. Use a `classifier` when you need a model." },
    { key: "systemPrompt", usage: "ignored", description: "Not used — no model runs." },
    { key: "tools", usage: "ignored", description: "Not used — MCP tools are called by `llm` and `tool` nodes. Route to one of those when this step needs a tool." },
    { key: "label", usage: "optional", description: "Human-readable name shown on the canvas, in lists and as the default progress text. Purely cosmetic — edges, templates and references address the node by its `id`." },
  ],
  config: [
    {
      key: "derive",
      kind: "json",
      label: "Lookup rules",
      description: "`[{ from, lookup: { <value>: { field: value } }, default? }]` (max 50). Without `default`, every field used anywhere in `lookup` is set to \"\" on a miss.",
      example: [{ from: "client", lookup: { mueller: { clientTaiga: "mueller-gmbh" } }, default: { clientTaiga: "" } }],
    },
    {
      key: "extract",
      kind: "json",
      label: "Regex rules",
      description: "`[{ from: \"query\" | <classification field>, pattern (≤200 chars), target, group? (default 1) }]` (max 20). Input is capped at 2000 characters.",
      example: [{ from: "query", pattern: "#(\\d{2,6})", target: "ticketId" }],
    },
  ],
  examples: [],
  notes: [],
};

const TRIGGER: NodeTypeDoc = {
  type: "trigger",
  title: "Trigger",
  summary: "Declares how the flow starts without a chat request (webhook or schedule).",
  description:
    "A pass-through at run time; its config registers the flow with the webhook endpoint (`POST /triggers/:flowId`, HMAC-signed) or the scheduler. The Triggers page lists and test-fires registered triggers.",
  whenToUse: ["Flows started by external systems or on a schedule."],
  topLevel: [
    { key: "llm", usage: "ignored", description: "Not used — the node is a pass-through at run time." },
    { key: "systemPrompt", usage: "ignored", description: "Not used. The message a trigger produces comes from `config.messageTemplate` / `config.scheduledMessage`." },
    { key: "tools", usage: "ignored", description: "Not used — MCP tools are called by `llm` and `tool` nodes. Route to one of those when this step needs a tool." },
    { key: "label", usage: "optional", description: "Human-readable name shown on the canvas, in lists and as the default progress text. Purely cosmetic — edges, templates and references address the node by its `id`." },
  ],
  config: [
    { key: "mode", kind: "enum", label: "Mode", options: ["webhook", "schedule"], required: true, description: "`webhook`: signed POST starts the flow. `schedule`: interval or cron." },
    { key: "webhookSecret", kind: "string", label: "Webhook secret", description: "HMAC-SHA256 secret to verify webhook signatures." },
    { key: "messageTemplate", kind: "text", label: "Message template", description: "User message built from the webhook payload; supports `{{body.*}}`." },
    { key: "synchronous", kind: "boolean", label: "Synchronous", default: false, description: "Wait for the run and return its answer in the webhook response." },
    { key: "intervalSeconds", kind: "number", label: "Interval (s)", integer: true, min: 60, description: "Fixed schedule interval (min 60). Mutually exclusive with `cron`." },
    { key: "cron", kind: "string", label: "Cron", description: "5-field cron expression. Mutually exclusive with `intervalSeconds`." },
    { key: "scheduledMessage", kind: "text", label: "Scheduled message", description: "Message for scheduled runs; supports `{{now.*}}`." },
    { key: "tenantId", kind: "string", label: "Tenant", description: "Tenant context for scheduled runs." },
    { key: "maxConcurrent", kind: "number", label: "Max concurrent", integer: true, min: 1, max: 100, default: 1, description: "Max simultaneous scheduled runs." },
  ],
  examples: [{ title: "Nightly", yaml: `- id: nightly\n  type: trigger\n  config: { mode: schedule, cron: "0 3 * * *", scheduledMessage: "Tagesbericht {{now.date}}" }` }],
  notes: [],
};

const ASSISTANT_CONTEXT: NodeTypeDoc = {
  type: "assistant-context",
  title: "Assistant context",
  summary: "Loads a personal assistant's identity, skills, inbox and credentials.",
  description:
    "Resolves the assistant for the request (from the request, a model name `assistant-<id>`, or `defaultAssistantId`) and injects its soul, skill index, peer inbox and credential state before the answering `llm` node. Fail-closed: without a complete (tenant, user, assistant) scope it passes the turn through with an explanatory message instead of borrowing another identity.",
  whenToUse: ["First node of an assistant flow (paired with `assistant-learn` at the end)."],
  topLevel: [
    { key: "systemPrompt", usage: "ignored", description: "Not used. The assistant's prompt sections are rendered from its own identity, skills and inbox — put flow-level wording on the answering `llm` node instead." },
    { key: "llm", usage: "ignored", description: "Not used — this node loads context, it does not call a model." },
    { key: "tools", usage: "ignored", description: "Not used. Which tools the assistant may use follows from its credentials and `config.requiresToolAuthority`." },
    { key: "label", usage: "optional", description: "Human-readable name shown on the canvas, in lists and as the default progress text. Purely cosmetic — edges, templates and references address the node by its `id`." },
  ],
  config: [
    { key: "defaultAssistantId", kind: "string", label: "Default assistant", description: "Assistant used when the request names none (max 64 chars)." },
    { key: "maxContextChars", kind: "number", label: "Context budget (chars)", integer: true, min: 500, max: 100_000, description: "Budget for all assistant-owned prompt sections." },
    { key: "requiresToolAuthority", kind: "boolean", label: "May use protected tools", description: "False for maintenance flows that must never act on a user's behalf." },
  ],
  examples: [],
  notes: [],
};

const ASSISTANT_LEARN: NodeTypeDoc = {
  type: "assistant-learn",
  title: "Assistant learn",
  summary: "Records the turn for the assistant and offers it to the learning pass.",
  description:
    "Terminal node of an assistant flow: records what happened (depth, tools, aborts), settles skill canaries and offers the turn to the learning scheduler. Never fails the turn — the answer has already been delivered. Requires an `assistant-context` node earlier in the flow.",
  whenToUse: ["Last node of an assistant flow."],
  topLevel: [
    { key: "llm", usage: "ignored", description: "Not used — the learning pass runs on the scheduler's own model, outside this node." },
    { key: "systemPrompt", usage: "ignored", description: "Not used — no model is prompted here." },
    { key: "tools", usage: "ignored", description: "Not used — MCP tools are called by `llm` and `tool` nodes. Route to one of those when this step needs a tool." },
    { key: "label", usage: "optional", description: "Human-readable name shown on the canvas, in lists and as the default progress text. Purely cosmetic — edges, templates and references address the node by its `id`." },
  ],
  config: [{ key: "learn", kind: "boolean", label: "Offer for learning", default: true, description: "False for flows whose turns should be recorded but never learned from." }],
  examples: [],
  notes: [],
};

export const NODE_TYPE_CATALOG: NodeTypeDoc[] = [
  LLM,
  TOOL,
  ROUTER,
  CLASSIFIER,
  PARALLEL,
  RETRIEVAL,
  MEMORY,
  AGENT_HARNESS,
  TRANSFORM,
  TRIGGER,
  ASSISTANT_CONTEXT,
  ASSISTANT_LEARN,
];

export function nodeTypeDoc(type: string): NodeTypeDoc | undefined {
  return NODE_TYPE_CATALOG.find((d) => d.type === type);
}

/**
 * Compact plain-text reference for prompts (the Copilot): every type as a one
 * line summary, and the config keys (kind/default/example) of `detailTypes`
 * (all types when omitted) plus the keys available on every node. Terse on
 * purpose — the model needs key names and shapes, not the prose.
 */
export function catalogPromptReference(detailTypes?: readonly string[]): string {
  const detailed = detailTypes ? new Set(detailTypes) : undefined;
  const fieldLine = (f: ConfigField, indent = "    "): string[] => {
    const head = `${f.key} (${f.kind}${f.options ? `: ${f.options.join("|")}` : ""}${f.default !== undefined ? `, default ${JSON.stringify(f.default)}` : ""})`;
    const desc = f.description.split(". ")[0] ?? f.description;
    const lines = [`${indent}- ${head}: ${desc.slice(0, 180)}`];
    if (f.example !== undefined) lines.push(`${indent}  e.g. ${JSON.stringify(f.example).slice(0, 220)}`);
    for (const sub of f.fields ?? []) lines.push(...fieldLine(sub, `${indent}    `));
    return lines;
  };
  const out: string[] = ["Node types:"];
  for (const doc of NODE_TYPE_CATALOG) out.push(`  - ${doc.type}: ${doc.summary}`);
  out.push("Node field `llm` (model selection, every key optional):");
  for (const f of LLM_MODEL_FIELDS) out.push(...fieldLine(f, "  "));
  out.push("Config keys available on every node:");
  for (const f of COMMON_CONFIG_FIELDS) out.push(...fieldLine(f, "  "));
  for (const doc of NODE_TYPE_CATALOG) {
    if (detailed && !detailed.has(doc.type)) continue;
    out.push(`Config keys of "${doc.type}":`);
    if (doc.config.length === 0) out.push("    (none)");
    for (const f of doc.config) out.push(...fieldLine(f));
  }
  return out.join("\n");
}

/** Words in an instruction that point at a node type (German and English). */
const TYPE_HINTS: Array<[RegExp, string[]]> = [
  [/\brag\b|retriev|vector|vektor|such|search|kontext|context|collection|sammlung/i, ["retrieval", "parallel", "tool"]],
  [/tool|mcp|werkzeug/i, ["tool", "llm"]],
  [/harness|orchestr|agent|deleg|verif|prüf/i, ["agent-harness"]],
  [/klassifi|classif|triage|intent|routing|route/i, ["classifier", "router"]],
  [/memory|erinner|gedächtnis|speicher/i, ["memory"]],
  [/transform|mapping|lookup|regex|extrah|extract/i, ["transform"]],
  [/trigger|webhook|cron|zeitplan|schedule/i, ["trigger"]],
  [/parallel|fan.?out|gleichzeitig/i, ["parallel"]],
  [/assistant|assistent/i, ["assistant-context", "assistant-learn"]],
  [/llm|modell|model|prompt|antwort|answer|shortcut/i, ["llm"]],
];

/** Types whose config details a prompt about `instruction` on `presentTypes` needs. */
export function relevantNodeTypes(
  presentTypes: readonly string[],
  instruction: string,
): string[] {
  const out = new Set(presentTypes);
  for (const doc of NODE_TYPE_CATALOG) {
    if (instruction.toLowerCase().includes(doc.type)) out.add(doc.type);
  }
  for (const [re, types] of TYPE_HINTS) {
    if (re.test(instruction)) for (const t of types) out.add(t);
  }
  return [...out];
}
