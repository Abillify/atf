// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow authoring reference data — the single source for everything a flow
 * author can write that is NOT a node type's `config` key (those live in
 * `node-type-catalog.ts`) and not a structural schema field (those carry
 * `.describe()` texts in `flow-parser/validate.ts`):
 *
 *   - the `llm` block and its `parameters`
 *   - runtime template placeholders (`{{context.*}}`, `{{now.*}}`, …) and
 *     WHERE each one is rendered
 *   - what an edge condition can read, and its operators
 *   - flow-variable references and calculations
 *   - the files of a flows directory
 *
 * Consumers: the generated `docs/FLOWS.md` (`flow-reference.ts`), the Studio
 * (served with `GET /flows/node-types` → formula editor, variable browser,
 * operator palettes) and tests that pin this data to the engine code it
 * describes. Keep this module free of imports so the Control app's tests can
 * load it directly.
 */

export interface ReferenceField {
  key: string;
  description: string;
  /** Value shape, e.g. "number 0–2" or "object". */
  type?: string;
  example?: unknown;
}

/** Where a template placeholder is rendered. */
export type PlaceholderScope = "prompt" | "tool";

export interface PlaceholderSymbol {
  path: string;
  description: string;
  example?: unknown;
}

export interface PlaceholderGroup {
  title: string;
  /** Fields that render this group. */
  scopes: PlaceholderScope[];
  symbols: PlaceholderSymbol[];
}

export interface ReferenceOperator {
  /** Text inserted by an editor (with spacing / empty quotes). */
  text: string;
  /** Short label for a button or a table. */
  label: string;
  description: string;
}

// ---------------------------------------------------------------------------
// The `llm` block
// ---------------------------------------------------------------------------

export const LLM_BLOCK_FIELDS: ReferenceField[] = [
  {
    key: "shortcut",
    type: "string",
    description:
      "Name of a model shortcut from `model-shortcuts.yaml` (or a `{{vars.*}}` reference to one). Expanded when the flow loads into `provider`, `model` and the preset's `parameters` (node-level `parameters` win); a pool shortcut additionally attaches its candidates. Use it instead of `provider` + `model`.",
    example: "fast-pool",
  },
  {
    key: "provider",
    type: "string",
    description:
      "A provider instance name from the `PROVIDERS` environment variable, a built-in protocol name, or a `{{vars.*}}` reference. Checked against the provider registry when the flow loads.",
    example: "eu-openai",
  },
  {
    key: "model",
    type: "string (1–256)",
    description: "The model id passed to the provider.",
    example: "a-chat-model",
  },
  {
    key: "parameters",
    type: "object (max. 20 keys)",
    description: "Generation parameters; see the table below. Unknown keys are passed through unchanged.",
  },
];

export const LLM_PARAMETERS: ReferenceField[] = [
  { key: "temperature", type: "number 0–2", description: "Sampling temperature." },
  { key: "maxTokens", type: "integer 1–65536", description: "Output token budget. Too small a budget for a thinking model ends in an empty answer." },
  {
    key: "contextLength",
    type: "integer",
    description:
      "The model's context window in tokens. Overrides the capability registry; the engine uses it to truncate prompts deterministically before clamping the output budget.",
  },
  {
    key: "reasoningEffort",
    type: "string",
    description:
      "Sent as `reasoning_effort` to OpenAI-compatible servers (e.g. `none` disables thinking in LM Studio).",
    example: "none",
  },
  {
    key: "chatTemplateKwargs",
    type: "object",
    description: "Sent as `chat_template_kwargs` to OpenAI-compatible servers (vLLM, Ollama).",
    example: { enable_thinking: false },
  },
  {
    key: "extraBody",
    type: "object",
    description:
      "Fields merged verbatim into the request body of OpenAI-compatible servers, e.g. anti-repetition penalties (`repeat_penalty`, `frequency_penalty`, `presence_penalty`, `top_k`, `min_p`).",
    example: { repeat_penalty: 1.15 },
  },
  {
    key: "visionInput",
    type: "boolean",
    description: "Attests that a model unknown to the capability registry accepts images. Unknown models otherwise fail closed.",
  },
  {
    key: "providerOptions",
    type: "object",
    description: "Provider-specific options handed to the AI SDK as `providerOptions` (e.g. Google image model settings).",
  },
];

// ---------------------------------------------------------------------------
// Runtime template placeholders
// ---------------------------------------------------------------------------

export const PLACEHOLDER_SCOPES: Record<PlaceholderScope, string> = {
  prompt: "System prompts (`systemPrompt` of `llm` nodes and overrides).",
  tool: "Tool arguments (`tool` node args and `toolArgs` of `llm` nodes), including retrieval filters.",
};

/**
 * `{{path}}` placeholders filled in at run time. A known root with a missing
 * sub-path renders as an empty string; an unknown root stays as written in
 * prompts and renders empty in tool arguments. Pinned to
 * `resolveContextPlaceholders` (prompts) and the tool template context by tests.
 */
export const TEMPLATE_PLACEHOLDERS: PlaceholderGroup[] = [
  {
    title: "Request",
    scopes: ["tool"],
    symbols: [{ path: "query", description: "The latest user message.", example: "Ist ein Parkplatz frei?" }],
  },
  {
    title: "Classification (this turn)",
    scopes: ["tool"],
    symbols: [
      { path: "classLabel", description: "Value of the last classifier's `classKey` field.", example: "RETOURE" },
      { path: "classification.<field>", description: "A field of the merged classification of this turn (classifiers, structured `llm` output, `transform` nodes)." },
    ],
  },
  {
    title: "Per node / earlier turns",
    scopes: ["prompt", "tool"],
    symbols: [
      {
        path: "node.<id>.classification.<field>",
        description: "A field as node `<id>` set it in this run, even if a later classifier overwrote `classification.<field>`.",
      },
      {
        path: "turn[<n>].<id>.classification.<field>",
        description: "A field from node `<id>` n runs ago (`turn[0]` = this run, `turn[1]` = the previous one).",
      },
    ],
  },
  {
    title: "User context",
    scopes: ["prompt", "tool"],
    symbols: [
      { path: "context.userName", description: "Caller's display name.", example: "Erika Muster" },
      { path: "context.userEmail", description: "Caller's email.", example: "user@example.com" },
      { path: "context.userId", description: "Caller's id.", example: "u-123" },
      { path: "context.role", description: "Caller's role.", example: "user" },
      { path: "context.groups", description: "Caller's groups (list).", example: ["staff"] },
      { path: "context.plan", description: "Tenant plan.", example: "pro" },
      { path: "context.language", description: "Request language.", example: "de" },
      { path: "context.clientId", description: "Calling client id.", example: "openwebui" },
      { path: "context.chatId", description: "Chat id sent by the client.", example: "c-1" },
      { path: "context.executionId", description: "Id of this execution.", example: "exec-1" },
      { path: "context.claims.<name>", description: "Any claim of the caller's token." },
      { path: "context.requestParams.<name>", description: "Any request parameter (metadata, conversation id, requested model, …)." },
    ],
  },
  {
    title: "Date & time (Europe/Berlin)",
    scopes: ["prompt"],
    symbols: [
      { path: "now.date", description: "YYYY-MM-DD", example: "2026-09-25" },
      { path: "now.time", description: "HH:MM", example: "14:05" },
      { path: "now.datetime", description: "YYYY-MM-DD HH:MM", example: "2026-09-25 14:05" },
      { path: "now.weekday", description: "Weekday in German, e.g. Dienstag.", example: "Donnerstag" },
      { path: "now.iso", description: "Full ISO-8601 timestamp.", example: "2026-09-25T12:05:00.000Z" },
      { path: "now.timezone", description: "IANA timezone used.", example: "Europe/Berlin" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Edge conditions
// ---------------------------------------------------------------------------

/**
 * What an edge condition (and a `parallelNodes` condition) can read. Pinned to
 * `buildConditionContext` by a test.
 */
export const CONDITION_FIELDS: PlaceholderGroup[] = [
  {
    title: "Run state",
    scopes: [],
    symbols: [
      { path: "lastMessageText", description: "Text of the latest message.", example: "Ist ein Parkplatz frei?" },
      { path: "messageCount", description: "Number of messages so far.", example: 1 },
      { path: "lastMessageType", description: "`human`, `ai`, `system` or `tool`.", example: "human" },
      { path: "currentNodeId", description: "Node that just ran.", example: "router" },
      { path: "toolResultCount", description: "Tool results collected so far.", example: 0 },
      { path: "hasErrors", description: "Whether a node reported an error.", example: false },
      { path: "errorCount", description: "Number of node errors.", example: 0 },
    ],
  },
  {
    title: "Classification",
    scopes: [],
    symbols: [
      { path: "classLabel", description: "Value of the last classifier's `classKey` field.", example: "RETOURE" },
      { path: "classification.<field>", description: "A field of the merged classification of this turn." },
      { path: "node.<id>.classification.<field>", description: "A field as node `<id>` set it in this run (node ids with hyphens cannot be used here)." },
      { path: "turn[<n>].<id>.classification.<field>", description: "A field from node `<id>` n runs ago." },
    ],
  },
  {
    title: "User & request",
    scopes: [],
    symbols: [
      { path: "role", description: "Caller's role.", example: "user" },
      { path: "groups", description: "Caller's groups (list); use `groups.includes('x')`.", example: ["staff"] },
      { path: "plan", description: "Tenant plan.", example: "pro" },
      { path: "language", description: "Request language.", example: "de" },
      { path: "userEmail", description: "Caller's email.", example: "user@example.com" },
      { path: "clientId", description: "Calling client id.", example: "openwebui" },
      { path: "claims.<name>", description: "Any claim of the caller's token." },
      { path: "params.<name>", description: "Any request parameter (metadata, conversation id, requested model, …)." },
    ],
  },
];

/** Operators and helpers of the condition grammar (`condition-evaluator.ts`). */
export const CONDITION_OPERATORS: ReferenceOperator[] = [
  { text: " == ", label: "==", description: "equal" },
  { text: " != ", label: "!=", description: "not equal" },
  { text: " > ", label: ">", description: "greater than" },
  { text: " >= ", label: "≥", description: "greater or equal" },
  { text: " < ", label: "<", description: "less than" },
  { text: " <= ", label: "≤", description: "less or equal" },
  { text: " && ", label: "and", description: "both must be true" },
  { text: " || ", label: "or", description: "either may be true" },
  { text: "!", label: "not", description: "negation" },
  { text: " =~ ''", label: "=~", description: "case-insensitive regex match, e.g. `lastMessageText =~ 'park|stellplatz'`" },
  { text: ".includes('')", label: ".includes()", description: "list contains value / text contains substring (alias `.contains()`)" },
  { text: ".startsWith('')", label: ".startsWith()", description: "text starts with" },
  { text: ".endsWith('')", label: ".endsWith()", description: "text ends with" },
  { text: ".length", label: ".length", description: "length of a text or list" },
  { text: "()", label: "( )", description: "grouping" },
  { text: "''", label: "'text'", description: "string literal" },
  { text: "true", label: "true", description: "boolean" },
  { text: "false", label: "false", description: "boolean" },
  { text: "null", label: "null", description: "no value" },
];

// ---------------------------------------------------------------------------
// Flow variables
// ---------------------------------------------------------------------------

/**
 * Load-time references: resolved when the flow loads (and again per request
 * when variables are overridden), in variable values AND in any node or edge
 * value. They cannot read run-time values — use runtime placeholders for those.
 */
export const VARIABLE_REFERENCES: ReferenceField[] = [
  {
    key: "{{vars.<name>}}",
    description:
      "A flow variable. Variable values may reference each other (evaluated in dependency order; cycles are errors). Dotted names read into object values. An undeclared variable is a warning, since a request may supply it.",
  },
  {
    key: "{{const.<name>}}",
    description: "A global constant from `constants.yaml`.",
  },
  {
    key: "{{env.FLOW_PUBLIC_<NAME>}}",
    description:
      "An environment value whose name starts with `FLOW_PUBLIC_`; no other environment variable is readable.",
  },
  {
    key: "{{= <expression> }}",
    description:
      "A calculation over variables, constants and public env values. Inside it references are written without braces (`vars.x`, `const.y`, `env.FLOW_PUBLIC_Z`), strings in single quotes. Evaluated at load time, so it cannot read run-time values such as `context.*` or `classification.*`.",
  },
];

export const CALCULATION_OPERATORS: ReferenceOperator[] = [
  { text: "{{=  }}", label: "{{= }}", description: "Start a calculation" },
  { text: " + ", label: "+", description: "Add numbers / join text (when either side is text)" },
  { text: " - ", label: "−", description: "Subtract" },
  { text: " * ", label: "×", description: "Multiply" },
  { text: " / ", label: "÷", description: "Divide (division by zero is an error)" },
  { text: " % ", label: "%", description: "Remainder" },
  { text: "()", label: "( )", description: "Group" },
  { text: " == ", label: "==", description: "Equal" },
  { text: " != ", label: "!=", description: "Not equal" },
  { text: " < ", label: "<", description: "Less than (also <=)" },
  { text: " > ", label: ">", description: "Greater than (also >=)" },
  { text: " && ", label: "&&", description: "And" },
  { text: " || ", label: "||", description: "Or" },
  { text: "!", label: "!", description: "Not" },
  { text: " ? '' : ''", label: "a ? b : c", description: "If a then b else c" },
  { text: "''", label: "'text'", description: "Text literal" },
];

/** Functions of the calculation language; keys pinned to `EXPRESSION_FUNCTIONS` by a test. */
export const CALCULATION_FUNCTIONS: ReferenceOperator[] = [
  { text: "round()", label: "round(x, digits)", description: "Rounds to `digits` decimals (default 0)." },
  { text: "min()", label: "min(a, b, …)", description: "Smallest number." },
  { text: "max()", label: "max(a, b, …)", description: "Largest number." },
  { text: "floor()", label: "floor(x)", description: "Rounds down." },
  { text: "ceil()", label: "ceil(x)", description: "Rounds up." },
  { text: "abs()", label: "abs(x)", description: "Absolute value." },
  { text: "number()", label: "number(x)", description: "Text → number (error if not numeric)." },
  { text: "string()", label: "string(x)", description: "Value → text." },
  { text: "upper()", label: "upper(s)", description: "Upper case." },
  { text: "lower()", label: "lower(s)", description: "Lower case." },
  { text: "trim()", label: "trim(s)", description: "Strips leading and trailing spaces." },
  { text: "length()", label: "length(x)", description: "Length of a text or list." },
  { text: "concat()", label: "concat(a, b, …)", description: "Joins values as text." },
  { text: "coalesce()", label: "coalesce(a, b, …)", description: "First value that is not null or empty." },
];

// ---------------------------------------------------------------------------
// Flows directory
// ---------------------------------------------------------------------------

export const FLOWS_DIR_ENTRIES: ReferenceField[] = [
  { key: "<id>.yaml / .yml / .json", description: "One flow per file. Reloaded on change without a restart." },
  {
    key: "model-shortcuts.yaml",
    description:
      "Engines (named `PROVIDERS` instances), model presets (model id + parameters) and shortcuts — single engine/model pairs or pools with a selection strategy. Referenced as `llm.shortcut`. A change reloads all flows.",
  },
  {
    key: "constants.yaml",
    description: "`constants: { name: value }` shared by all flows, read as `{{const.<name>}}` in variable values. No secrets. A change reloads all flows.",
  },
  { key: "prompts/", description: "Prompt files included with `#[[file:prompts/<name>.md]]` in a `systemPrompt` (node or override); includes may nest up to 5 levels." },
  {
    key: "subflows/",
    description: "Sub-flow files merged into a flow via `metadata.$include.subflows`; the Studio writes their nodes back into them. `metadata.$include.patches` changes included nodes from the parent without redefining them.",
  },
  {
    key: "*.example.yaml",
    description: "Documentation templates; never loaded.",
  },
  {
    key: "dispatch, access, canary, guardrails, experiments, mcp, tool-authz, compliance-policy, shadow (.yaml)",
    description: "Reserved configuration files of other subsystems, never loaded as flows.",
  },
];

/** Everything above, as served to the Studio with `GET /flows/node-types`. */
export const FLOW_REFERENCE = {
  llmBlock: LLM_BLOCK_FIELDS,
  llmParameters: LLM_PARAMETERS,
  placeholderScopes: PLACEHOLDER_SCOPES,
  placeholders: TEMPLATE_PLACEHOLDERS,
  conditionFields: CONDITION_FIELDS,
  conditionOperators: CONDITION_OPERATORS,
  variableReferences: VARIABLE_REFERENCES,
  calculationOperators: CALCULATION_OPERATORS,
  calculationFunctions: CALCULATION_FUNCTIONS,
  flowsDir: FLOWS_DIR_ENTRIES,
};

export type FlowReference = typeof FLOW_REFERENCE;
