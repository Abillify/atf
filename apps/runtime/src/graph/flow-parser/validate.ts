// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow Parser — Zod Schemas and Validation Logic
 *
 * Implements schema validation for flow definitions per Requirements 3.3–3.9.
 * Per-node-type `configSchema` validation is delegated to the node handler
 * registry or the built-in config schema map.
 */

import { z } from "zod";
import { isKnownProviderName } from "../../config/providers.js";
import type {
  FlowDefinition,
  FlowEdge,
  FlowNode,
  LlmConfig,
  LlmParameters,
} from "../../types/flow.js";
import { DATA_CLASSES } from "../../types/flow.js";
import { defaultNodeHandlerRegistry } from "../node-handler-registry.js";

// ---------------------------------------------------------------------------
// Validation Error Type
// ---------------------------------------------------------------------------

export interface ValidationError {
  fileName?: string;
  reason: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Structured Error Logger
// ---------------------------------------------------------------------------

/**
 * Logs a structured validation error to stderr with fileName and reason.
 * Requirements 3.4: structured validation error log with filename and reason.
 */
export function logValidationError(
  fileName: string,
  reason: string,
  details?: unknown,
): void {
  const entry: Record<string, unknown> = {
    level: "error",
    component: "flow-parser",
    fileName,
    reason,
  };
  if (details !== undefined) {
    entry.details = details;
  }
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

/**
 * Matches a string that is exactly one `{{vars.<dotted.name>}}` reference.
 * Used by schemas to accept variable placeholders in otherwise constrained
 * fields (for example a provider name), since placeholders are only resolved to
 * concrete values at execution time.
 */
export const VAR_PLACEHOLDER_RE = /^\{\{\s*vars\.([\w.-]+)\s*\}\}$/;

/**
 * LlmParameters schema:
 * - temperature: 0.0–2.0
 * - maxTokens: 1–65536 (raised from 32768 to accommodate large-context local
 *   models, e.g. LM Studio with a 100k context window where thinking-enabled
 *   nodes need 40k+ output budget to avoid token-exhaustion empty responses)
 * - max 20 total keys
 */
export const LlmParametersSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (obj) => {
      const temp = obj.temperature;
      if (temp !== undefined) {
        if (typeof temp !== "number" || temp < 0.0 || temp > 2.0) return false;
      }
      return true;
    },
    { message: "temperature must be a number between 0.0 and 2.0" },
  )
  .refine(
    (obj) => {
      const maxTokens = obj.maxTokens;
      if (maxTokens !== undefined) {
        if (
          typeof maxTokens !== "number" ||
          !Number.isInteger(maxTokens) ||
          maxTokens < 1 ||
          maxTokens > 65536
        )
          return false;
      }
      return true;
    },
    { message: "maxTokens must be an integer between 1 and 65536" },
  )
  .refine((obj) => Object.keys(obj).length <= 20, {
    message: "LlmParameters may have at most 20 keys",
  }) as z.ZodType<LlmParameters>;

/**
 * LlmConfig schema:
 * - provider: a name from `PROVIDERS`, a built-in protocol name, or a
 *   {{vars.*}} reference. Validated against the provider registry so a typo
 *   still fails the flow loudly instead of erroring at first model call.
 * - model: string max 256 chars
 * - parameters: optional LlmParameters
 */
export const LlmConfigSchema: z.ZodType<LlmConfig> = z.object({
  provider: z.union([
    z.string().min(1).max(64).refine(isKnownProviderName, {
      message:
        "provider must be a configured PROVIDERS name or a built-in protocol",
    }),
    z
      .string()
      .regex(
        VAR_PLACEHOLDER_RE,
        "provider must be a known provider or a {{vars.*}} reference",
      ),
  ]),
  model: z.string().min(1).max(256),
  parameters: LlmParametersSchema.optional(),
}) as unknown as z.ZodType<LlmConfig>;

const FinalAnswerContractSchema = z
  .object({
    startMarker: z.string().min(8).max(128),
    endMarker: z.string().min(8).max(128),
    streamAfterStartMarker: z.boolean().optional(),
  })
  .superRefine((contract, ctx) => {
    if (contract.startMarker === contract.endMarker) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endMarker"],
        message: "endMarker must differ from startMarker",
      });
    }
    if (
      contract.startMarker.includes(contract.endMarker) ||
      contract.endMarker.includes(contract.startMarker)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endMarker"],
        message: "final-answer markers must not contain each other",
      });
    }
  });

/**
 * LLM node config remains extensible, but security-sensitive output framing is
 * validated explicitly. By default the runtime buffers all ordinary content;
 * the opt-in live mode starts emitting only after the start marker while
 * retaining marker-sized lookbehind so framing tokens never reach clients.
 */
export const LlmNodeConfigSchema = z
  .object({
    finalAnswerContract: FinalAnswerContractSchema.optional(),
    maxOutputChars: z.number().int().min(1_000).max(1_000_000).optional(),
    toolResultBudget: z
      .object({
        perResultChars: z.number().int().min(1_000).max(1_000_000).optional(),
        perTurnChars: z.number().int().min(1_000).max(2_000_000).optional(),
      })
      .optional(),
  })
  .passthrough()
  .superRefine((config, ctx) => {
    if (
      config.finalAnswerContract !== undefined &&
      config.outputSchema !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finalAnswerContract"],
        message: "finalAnswerContract cannot be combined with outputSchema",
      });
    }
  });

/**
 * HarnessConfigSchema validates the `config` field when a node's type is
 * "agent-harness". Applied as a superRefine on FlowNodeSchema below.
 */
export const HarnessConfigSchema = z.object({
  allowlist: z.array(z.string().min(1)).min(1, "allowlist must be non-empty"),
  maxIterations: z.number().int().positive().max(1000).optional(),
  maxCost: z.number().positive().optional(),
  maxTimeMs: z.number().int().positive().optional(),
  consequentialTargets: z.array(z.string().min(1)).max(200).optional(),
  plannerLlm: LlmConfigSchema.optional(),
  progressNarrator: z
    .object({
      enabled: z.boolean().optional(),
      llm: LlmConfigSchema,
      timeoutMs: z.number().int().min(1000).max(120000).optional(),
      maxOutputChars: z.number().int().min(80).max(500).optional(),
      includeHypotheses: z
        .object({
          active: z.boolean().optional(),
          confirmed: z.boolean().optional(),
          rejected: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  carryForward: z.enum(["full", "condensed"]).optional(),
  // A downstream synthesizer needs one clean context turn rather than every
  // delegated answer as a separate, potentially user-visible assistant turn.
  resultMode: z.enum(["delegated", "context"]).optional(),
  // Default true preserves the legacy live worker-streaming behaviour. Flows
  // with a final synthesizer can opt out to keep intermediary findings private.
  streamDelegates: z.boolean().optional(),
  stopSignal: z.string().min(1).max(256).optional(),
  requiredFindingMarkers: z
    .array(z.string().min(1).max(128))
    .min(1)
    .max(20)
    .optional(),
  plannerless: z.boolean().optional(),
  // Stops a plannerless loop after N consecutive passes without a unique
  // condensed finding. Opt-in to preserve existing harness behaviour.
  maxStagnantIterations: z.number().int().min(1).max(20).optional(),
  condensedFindingMaxChars: z.number().int().min(6000).max(30000).optional(),
  // Coverage workers receive the user/system request plus bounded verifier
  // feedback; the global dossier overview and prior findings are excluded.
  coverageWorkerContextMaxChars: z
    .number()
    .int()
    .min(16000)
    .max(300000)
    .optional(),
  // Complete verifier state budget, including the mandatory ledger manifest.
  verificationContextMaxChars: z
    .number()
    .int()
    .min(32000)
    .max(500000)
    .optional(),
  coverageQueue: z
    .object({
      enabled: z.boolean(),
      mode: z.enum(["legacy", "staged"]).optional(),
      sourceTool: z.string().min(1).max(256),
      batchSize: z.number().int().min(1).max(100).optional(),
      maxOriginalsPerBatch: z.number().int().min(1).max(10).optional(),
      assignmentCharBudget: z.number().int().min(1000).max(100000).optional(),
      documentWindowChars: z.number().int().min(1000).max(100000).optional(),
      hybridSearch: z
        .object({
          minDistinctQueries: z.number().int().min(2).max(10),
          requireHydeVariants: z.boolean(),
          requireGroupedResults: z.boolean(),
          requireReranking: z.boolean().optional(),
          requireEffectiveHyde: z.boolean().optional(),
        })
        .optional(),
      // Second retrieval path: targeted search discovery whose hits promote
      // documents into original review independently of the summary triage.
      searchDiscovery: z
        .object({
          rounds: z.number().int().min(1).max(10),
          maxAttemptsPerRound: z.number().int().min(1).max(10),
          maxHitsPerPass: z.number().int().min(1).max(100),
          rerankScoreThreshold: z.number().min(0).max(1).optional(),
          maxExpansionRounds: z.number().int().min(0).max(2).optional(),
          maxExpansionSeeds: z.number().int().min(1).max(100).optional(),
          maxQueriesPerExpansionRound: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional(),
          maxCandidates: z.number().int().min(1).max(10000).optional(),
        })
        .optional(),
      markers: z
        .object({
          start: z.string().min(1).max(128),
          end: z.string().min(1).max(128),
        })
        .refine((markers) => markers.start !== markers.end, {
          message: "coverage report markers must differ",
        })
        .optional(),
    })
    .optional(),
  // 0 is a valid, meaningful value (forbid nesting entirely) — hence
  // `nonnegative`, not `positive`. Capped at the same ceiling the runtime
  // enforces so a flow cannot declare an unreachable depth and appear to work.
  maxDelegationDepth: z.number().int().nonnegative().max(5).optional(),
  // Concurrency for `parallelizable` task batches. Capped at the same ceiling
  // the runtime enforces so a flow cannot declare a value it will not get.
  maxConcurrentTasks: z.number().int().min(1).max(8).optional(),
  // 0 disables retries, so `nonnegative` rather than `positive`.
  maxTaskAttempts: z.number().int().nonnegative().max(3).optional(),
  // Verification gate. `passSignal` is mandatory: a gate that can never pass
  // would turn every run into `verification-failed`, which is worse than no gate.
  verification: z
    .object({
      target: z.string().min(1),
      passSignal: z.string().min(1).max(256),
      maxAttempts: z.number().int().min(1).max(3).optional(),
      failClosed: z.boolean().optional(),
    })
    .optional(),
});

/**
 * RagSourceSchema validates one retrieval source inside a parallel node's
 * `config.ragProfiles`. Each source is compiled at request time into a
 * `vectorsearch/search` call. `tags` values may be `{{...}}` placeholders.
 */
export const RagSourceSchema = z.object({
  collection: z.string().min(1),
  tags: z.array(z.string()).max(20).optional(),
  limit: z.number().int().positive().max(100).optional(),
  hybrid: z.boolean().optional(),
  minScore: z.number().min(0).max(1).optional(),
  scoreWeight: z.number().optional(),
  when: z.string().max(1024).optional(),
  rerank: z.boolean().optional(),
  groupByDocument: z.boolean().optional(),
  includeAllVersions: z.boolean().optional(),
  validAt: z.string().datetime({ offset: true }).optional(),
});

/**
 * ParallelConfigSchema validates the `config` field when a node's type is
 * "parallel". Today that is only the optional `ragProfiles` data-driven
 * retrieval plan; `.passthrough()` keeps any future/unrelated keys valid.
 */
export const ParallelConfigSchema = z
  .object({
    ragProfiles: z
      .object({
        select: z
          .array(
            z.object({
              when: z.string().min(1).max(1024),
              use: z.string().min(1),
            }),
          )
          .max(50)
          .optional(),
        default: z.string().min(1).optional(),
        shared: z.array(RagSourceSchema).max(50).optional(),
        profiles: z.record(z.string(), z.array(RagSourceSchema).max(50)),
        rerank: z
          .object({
            topN: z.number().int().positive().max(50).optional(),
          })
          .optional(),
        maxDocuments: z.number().int().positive().max(50).optional(),
        minScore: z.number().min(0).max(1).optional(),
      })
      .optional(),
  })
  .passthrough();

/**
 * TransformConfigSchema validates the `config` field when a node's type is
 * "transform". `config.derive` holds static lookup rules; `config.extract`
 * holds bounded regex-capture rules for deterministic values from the request.
 */
export const TransformConfigSchema = z
  .object({
    derive: z
      .array(
        z.object({
          from: z.string().min(1),
          lookup: z.record(z.string(), z.record(z.string(), z.string())),
          default: z.record(z.string(), z.string()).optional(),
        }),
      )
      .min(1, "transform config.derive must have at least one rule")
      .max(50)
      .optional(),
    extract: z
      .array(
        z.object({
          from: z.string().min(1).max(128),
          pattern: z.string().min(1).max(200),
          target: z.string().min(1).max(128),
          group: z.number().int().min(0).max(20).optional(),
        }),
      )
      .min(1, "transform config.extract must have at least one rule")
      .max(20)
      .optional(),
  })
  .refine(
    (config) =>
      (config.derive !== undefined && config.derive.length > 0) ||
      (config.extract !== undefined && config.extract.length > 0),
    { message: "transform config requires derive or extract rules" },
  )
  .passthrough();

/**
 * Config schemas for BUILT-IN node types, consulted by the parser even when the
 * handler registry has not been populated.
 */
const BUILTIN_CONFIG_SCHEMAS: Record<string, z.ZodTypeAny> = {
  llm: LlmNodeConfigSchema,
  "agent-harness": HarnessConfigSchema,
  parallel: ParallelConfigSchema,
  transform: TransformConfigSchema,
};

/**
 * Names of the built-in node types.
 */
const BUILTIN_NODE_TYPES: ReadonlySet<string> = new Set([
  "llm",
  "tool",
  "router",
  "classifier",
  "parallel",
  "retrieval",
  "memory",
  "agent-harness",
  "transform",
  "trigger",
  // Per-user assistant nodes. Listed here as well as registered in
  // `handlers/index.ts` because the parser is deliberately usable without the
  // engine — it must be able to validate a flow file without loading the runtime
  // that registers handlers. Adding a built-in therefore means touching both, and
  // `flow-parser-reserved.test.ts` pins the two lists against each other.
  "assistant-context",
  "assistant-learn",
]);

/**
 * Node ids that collide with a LangGraph state channel.
 *
 * LangGraph refuses to compile a graph whose node name matches a channel of its
 * state annotation ("context is already being used as a state attribute … cannot
 * also be used as a node name"). Without this check that failure surfaces only at
 * `compileFlow` — i.e. at REQUEST time for a file-based flow, with no signal until a
 * user hits it. Rejecting it in the parser turns a runtime outage into a load-time
 * error naming the offending node.
 *
 * Kept in sync with `AgentStateAnnotation` in `graph-engine/state.ts`. It is a
 * literal list rather than a derivation because the annotation object is built by
 * LangGraph's `Annotation.Root` and does not expose its channel names as a value the
 * parser could read without importing the engine — which the parser deliberately
 * does not do.
 */
const RESERVED_NODE_IDS: ReadonlySet<string> = new Set([
  "messages",
  "context",
  "citations",
  "toolResults",
  "errors",
  "currentNodeId",
  "classification",
  "classLabel",
  "turns",
  "seenDocRefs",
  "harness",
]);

/**
 * FlowNode schema:
 * - id: non-empty string
 * - type: validated dynamically (built-in OR registered plugin type)
 * - llm: optional LlmConfig
 * - tools: optional array of max 50 strings, each max 128 chars
 * - label: optional string
 * - config: optional record
 */
export const FlowNodeSchema: z.ZodType<FlowNode> = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    label: z.string().optional(),
    llm: LlmConfigSchema.optional(),
    tools: z.array(z.string().max(128)).max(50).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    classifierSchema: z
      .object({
        schema: z.record(z.string(), z.unknown()),
        classKey: z.string().min(1),
      })
      .optional(),
    systemPrompt: z.string().max(65536).optional(),
    overrides: z
      .array(
        z
          .object({
            whenClass: z.string().min(1).optional(),
            whenClaim: z.string().min(1).max(1024).optional(),
            whenParam: z.string().min(1).max(1024).optional(),
            whenPlan: z.string().min(1).optional(),
            whenGroup: z.string().min(1).optional(),
            whenLanguage: z.string().min(1).optional(),
            llm: LlmConfigSchema.optional(),
            tools: z.array(z.string().max(128)).max(50).optional(),
            systemPrompt: z.string().max(65536).optional(),
          })
          .refine(
            (o) =>
              o.whenClass !== undefined ||
              o.whenClaim !== undefined ||
              o.whenParam !== undefined ||
              o.whenPlan !== undefined ||
              o.whenGroup !== undefined ||
              o.whenLanguage !== undefined,
            {
              message:
                "each override must declare at least one 'when…' condition",
            },
          )
          .refine(
            (o) =>
              o.llm !== undefined ||
              o.tools !== undefined ||
              o.systemPrompt !== undefined,
            {
              message:
                "each override must set at least one of llm, tools, or systemPrompt",
            },
          ),
      )
      .max(20)
      .optional(),
    parallelNodes: z
      .array(
        z.union([
          z.string().min(1),
          z.object({
            node: z.string().min(1),
            condition: z.string().max(1024).optional(),
          }),
        ]),
      )
      .max(20)
      .optional(),
  })
  .superRefine((node, ctx) => {
    if (RESERVED_NODE_IDS.has(node.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["id"],
        message:
          `node id "${node.id}" is reserved: it collides with a graph state channel, ` +
          "and LangGraph refuses to compile such a graph. Rename the node.",
      });
    }
    const registration = defaultNodeHandlerRegistry.get(node.type);
    if (!BUILTIN_NODE_TYPES.has(node.type) && registration === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["type"],
        message: `unknown node type "${node.type}" (no built-in and no registered plugin handler)`,
      });
      return;
    }
    // `config.errorStrategy` is cross-cutting (it applies to every node type, so
    // it lives here rather than in any one type's config schema). Validated
    // explicitly because an unrecognised value silently resolves to the
    // "fail-fast" default — a flow that meant `continue` would keep aborting the
    // whole run and nothing would say why.
    const rawStrategy = (node.config as Record<string, unknown> | undefined)
      ?.errorStrategy;
    if (rawStrategy !== undefined) {
      if (
        rawStrategy !== "continue" &&
        rawStrategy !== "fail-fast" &&
        rawStrategy !== "fallback"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["config", "errorStrategy"],
          message: `invalid errorStrategy "${String(rawStrategy)}" (expected "continue", "fail-fast" or "fallback")`,
        });
      } else if (rawStrategy === "fallback") {
        const fallbackId = (node.config as Record<string, unknown>)
          .fallbackNodeId;
        if (fallbackId !== undefined && typeof fallbackId !== "string") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["config", "fallbackNodeId"],
            message: "fallbackNodeId must be a string (a node id in this flow)",
          });
        }
      }
    }

    if (
      node.type === "llm" &&
      (node.config as Record<string, unknown> | undefined)
        ?.finalAnswerContract !== undefined &&
      (node.tools?.length ?? 0) > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["config", "finalAnswerContract"],
        message: "finalAnswerContract requires a tool-less LLM node",
      });
    }

    const configSchema =
      registration?.configSchema ?? BUILTIN_CONFIG_SCHEMAS[node.type];
    if (configSchema !== undefined) {
      const result = configSchema.safeParse(node.config ?? {});
      if (!result.success) {
        for (const issue of result.error.issues) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["config", ...issue.path],
            message: issue.message,
          });
        }
      }
    }
  }) as unknown as z.ZodType<FlowNode>;

/**
 * FlowEdge schema:
 * - id: optional string
 * - source: non-empty string
 * - target: non-empty string
 * - conditions: optional string max 1024 chars
 * - label: optional string
 */
export const FlowEdgeSchema: z.ZodType<FlowEdge> = z.object({
  id: z.string().optional(),
  source: z.string().min(1),
  target: z.string().min(1),
  conditions: z.string().max(1024).optional(),
  label: z.string().optional(),
});

/**
 * FlowDefinition schema:
 * - id: non-empty string
 * - name: non-empty string
 * - nodes: 1–100 elements
 * - edges: 0–500 elements
 * - description: optional string
 * - metadata: optional record
 * - dataClasses: optional list of compliance data classifications this flow
 *   processes (see ADR-0009) — feeds the compliance-policy `dataRules` check.
 * - requiredScopes: optional OAuth/OIDC scopes required to discover and execute
 *   this flow; each entry is non-blank and all entries are required.
 * - recovery: optional crash-recovery policy for async execution (ADR-0023) —
 *   `retry` states whether re-running this flow from the beginning is safe,
 *   `maxAttempts` optionally lowers the per-flow ceiling.
 */
export const FlowDefinitionSchema: z.ZodType<FlowDefinition> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  pricing: z
    .record(
      z.string(),
      z.object({
        prompt: z.number().min(0),
        completion: z.number().min(0),
      }),
    )
    .optional(),
  dataClasses: z.array(z.enum(DATA_CLASSES)).optional(),
  requiredScopes: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(256)
        .regex(/\S/u, "scope must contain a non-whitespace character"),
    )
    .max(100)
    .optional(),
  recovery: z
    .object({
      retry: z.boolean(),
      // Upper bound matches JOB_RECOVERY_MAX_ATTEMPTS's own ceiling; the
      // effective value is additionally clamped to the global setting at
      // dispatch time, so a flow can never exceed what the operator allows.
      maxAttempts: z.number().int().min(1).max(10).optional(),
    })
    .optional(),
  nodes: z.array(FlowNodeSchema).min(1).max(100),
  edges: z.array(FlowEdgeSchema).min(0).max(500),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Semantic Validation Helpers
// ---------------------------------------------------------------------------

/**
 * Checks for duplicate node IDs within a flow definition.
 * Returns the first duplicate ID found, or null if none.
 */
function findDuplicateNodeId(nodes: FlowNode[]): string | null {
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) {
      return node.id;
    }
    seen.add(node.id);
  }
  return null;
}

/**
 * Checks that all edge source/target IDs reference valid node IDs.
 * Returns the first unknown ID reference found, or null if all are valid.
 */
function findUnknownEdgeReference(
  edges: FlowEdge[],
  nodeIds: Set<string>,
): { edgeIndex: number; unknownId: string } | null {
  for (let i = 0; i < edges.length; i++) {
    const edge: FlowEdge | undefined = edges[i];
    if (edge === undefined) continue;
    if (!nodeIds.has(edge.source)) {
      return { edgeIndex: i, unknownId: edge.source };
    }
    if (!nodeIds.has(edge.target)) {
      return { edgeIndex: i, unknownId: edge.target };
    }
  }
  return null;
}

/**
 * Validates a conditions string (basic non-empty check).
 * Returns the index of the first invalid edge, or null if all valid.
 */
function findInvalidConditions(
  edges: FlowEdge[],
): { edgeIndex: number; conditions: string } | null {
  for (let i = 0; i < edges.length; i++) {
    const edge: FlowEdge | undefined = edges[i];
    if (edge === undefined) continue;
    if (edge.conditions !== undefined && edge.conditions.trim().length === 0) {
      return { edgeIndex: i, conditions: edge.conditions };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main Validation Function
// ---------------------------------------------------------------------------

export type ValidationResult =
  | { success: true; data: FlowDefinition }
  | { success: false; error: ValidationError };

/**
 * Validates a raw unknown value as a FlowDefinition.
 *
 * Steps:
 * 1. Zod schema validation (structure + field constraints)
 * 2. Duplicate node ID check
 * 3. Edge source/target reference check (all IDs must exist in nodes)
 * 4. Conditions syntax validity (non-empty string check)
 *
 * Requirements: 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9
 */
export function validateFlowDefinition(raw: unknown): ValidationResult {
  // Step 1: Zod schema validation
  const zodResult = FlowDefinitionSchema.safeParse(raw);
  if (!zodResult.success) {
    return {
      success: false,
      error: {
        reason: "Schema validation failed",
        details: zodResult.error.flatten(),
      },
    };
  }

  const flow = zodResult.data;

  // Step 2: Duplicate node ID check
  const duplicateId = findDuplicateNodeId(flow.nodes);
  if (duplicateId !== null) {
    return {
      success: false,
      error: {
        reason: `Duplicate node ID found: "${duplicateId}"`,
        details: { duplicateNodeId: duplicateId },
      },
    };
  }

  // Build node ID set for edge reference checks
  const nodeIds = new Set(flow.nodes.map((n) => n.id));

  // Step 3: Edge reference check
  const unknownRef = findUnknownEdgeReference(flow.edges, nodeIds);
  if (unknownRef !== null) {
    return {
      success: false,
      error: {
        reason: `Edge at index ${unknownRef.edgeIndex} references unknown node ID: "${unknownRef.unknownId}"`,
        details: {
          edgeIndex: unknownRef.edgeIndex,
          unknownNodeId: unknownRef.unknownId,
        },
      },
    };
  }

  // Step 4: Conditions syntax validity
  const invalidCond = findInvalidConditions(flow.edges);
  if (invalidCond !== null) {
    return {
      success: false,
      error: {
        reason: `Edge at index ${invalidCond.edgeIndex} has an empty conditions string`,
        details: {
          edgeIndex: invalidCond.edgeIndex,
          conditions: invalidCond.conditions,
        },
      },
    };
  }

  return { success: true, data: flow };
}

/**
 * Validates a raw flow object that may contain `{{vars.<name>}}` references.
 *
 * Correctness is checked against the flow's *default* variable values. The
 * returned FlowDefinition keeps the placeholders intact when structurally valid.
 */
export function validateFlowSource(
  raw: unknown,
  resolveRawFlowVariables: (
    raw: Record<string, unknown>,
    overrides: Record<string, unknown> | undefined,
    fileName: string,
  ) => void,
): ValidationResult {
  if (typeof raw !== "object" || raw === null) {
    return validateFlowDefinition(raw);
  }

  // Validate against default variable values for full correctness checking.
  const defaultsClone = structuredClone(raw) as Record<string, unknown>;
  resolveRawFlowVariables(defaultsClone, undefined, "<validation>");
  const checked = validateFlowDefinition(defaultsClone);
  if (!checked.success) return checked;

  // Prefer registering the placeholder-preserving form so variables stay
  // overridable at execution time.
  const template = validateFlowDefinition(raw);
  return template.success ? template : checked;
}
