// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Self-optimizing flow loop (`src/graph/flow-optimizer.ts`)
 *
 * Closes the feedback loop between production traffic, quality evaluation, and
 * flow configuration. The optimizer mines recent production snapshots into an
 * eval dataset, generates improved prompt variants for a target node via an LLM,
 * evaluates each variant against the dataset using a judge, and — when a variant
 * clears a configurable improvement threshold — publishes it as a draft and
 * optionally registers it as a canary candidate for live traffic validation.
 *
 * Architecture:
 *
 *   ┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
 *   │  ReplayStore    │───▶│  EvalDataset     │───▶│  runEval()      │
 *   │ (production     │    │ (buildAutoEval)  │    │ (judge score)   │
 *   │  snapshots)     │    └──────────────────┘    └────────┬────────┘
 *   └─────────────────┘                                     │
 *                                                           ▼
 *   ┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
 *   │  FlowStore      │◀───│  PromptVariant   │◀───│  PromptVariant  │
 *   │ (saveDraft +    │    │  Generator       │    │  Generator LLM  │
 *   │  publish)       │    └──────────────────┘    └─────────────────┘
 *   └─────────────────┘
 *
 * The optimizer never modifies the live `published` definition directly — it
 * saves a draft and lets the operator confirm via the existing flows API, or
 * auto-promotes to a canary when `autoPromote` is enabled in the config.
 * Auto-promotion writes the winning variant's definition back as a new published
 * version via the FlowStore, which the composite registry picks up on the next
 * poll (≤10 s). The old stable version is preserved in version history for
 * instant rollback.
 *
 * All I/O is injected, so the core logic is fully unit-testable with fakes.
 *
 * No `any` at module boundaries.
 */

import type { FlowDefinition } from "../types/flow.js";
import type { ReplayStore } from "./replay.js";
import type { FlowStore } from "./flow-store.js";
import type { FlowExecutor } from "../eval/eval-runner.js";
import type { Judge, EvalCase, CaseResult } from "../eval/eval-runner.js";
import type { Logger } from "../observability/logger.js";
import { buildAutoEvalDataset } from "../eval/auto-eval.js";
import { runEval } from "../eval/eval-runner.js";
import {
  generatePromptVariants,
  generateStructuralVariants,
  applyVariant,
  applyStructuralEdit,
  applyStructuralVariant,
  type StructuralVariant,
  type StructuralEdit,
  type GenerateVariantsOptions,
} from "./prompt-variant-generator.js";
import { validateFlow } from "./flow-validator.js";
import { extractSubFlow } from "./sub-flow.js";
import {
  analyzeTrace,
  renderAnalysisContext,
  type TraceAnalysis,
} from "./trace-analyzer.js";
import type { DebugTraceStore } from "../monitoring/debug-trace-store.js";
import type { LanguageModel } from "ai";

/**
 * A generated variant the optimizer can evaluate + promote, unifying prompt-
 * only variants ({@link PromptVariant}) and structural variants
 * ({@link StructuralVariant}). `edit` is present for structural variants and
 * drives promotion via {@link applyStructuralEdit}; `systemPrompt`/`temperature`
 * are present for prompt variants and drive the classic {@link applyVariant}
 * promotion path.
 */
interface GeneratedVariant {
  label: string;
  definition: FlowDefinition;
  systemPrompt?: string;
  temperature?: number;
  edit?: StructuralEdit;
  summary?: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OptimizerConfig {
  /** Flow ID to optimize. */
  flowId: string;
  /**
   * ID of the LLM node whose `systemPrompt` will be varied. When the flow has
   * exactly one LLM node it is used automatically; otherwise this is required.
   */
  targetNodeId?: string;
  /** Number of prompt variants to generate per optimization run. Default 3. */
  variantCount?: number;
  /**
   * Minimum number of production snapshots needed to build the eval dataset.
   * If fewer are available the run is skipped. Default 5.
   */
  minSamples?: number;
  /**
   * Max snapshots to include in the eval dataset per run. Keeps the eval fast.
   * Default 20.
   */
  maxSamples?: number;
  /**
   * Minimum improvement in avg judge score over the current baseline for a
   * variant to be auto-promoted (when `autoPromote` is true). E.g. 0.05 = 5 pp
   * improvement required. Default 0.05.
   */
  minScoreImprovement?: number;
  /**
   * When true, a variant that clears `minScoreImprovement` is automatically
   * saved as a draft and published to the flow store, making it live on the
   * next registry poll. Default false (manual promotion via API).
   *
   * Governance guard: auto-promotion is refused (the run is marked "skipped")
   * when the judge model is the SAME model as the one being optimized. An
   * LLM cannot be trusted to impartially grade its own rewritten output —
   * self-preferencing bias is a documented failure mode of LLM-as-judge
   * evaluation. Configure a judge model distinct from every candidate
   * provider/model the flow under optimization uses.
   */
  autoPromote?: boolean;
  /**
   * Provider/model pair the judge itself runs on. Required when
   * `autoPromote` is true — used solely to verify the judge is not the same
   * model as the flow being optimized (self-grading guard). Optional
   * otherwise (skips the guard, e.g. for manual-review-only runs where a
   * human makes the final call).
   */
  judgeModelId?: { provider: string; model: string };
  /**
   * Goal passed to the prompt variant generator to steer what "better" means.
   * E.g. "Improve factual accuracy for German legal debt-collection text."
   */
  optimizationGoal?: string;
  /** Suggest temperature changes alongside prompt rewrites. Default false. */
  suggestTemperature?: boolean;
  /** Eval concurrency. Default 2. */
  evalConcurrency?: number;
  /**
   * Restrict optimization + evaluation to a SUB-SECTION of the flow: the given
   * node ids are extracted into a runnable sub-flow (see {@link extractSubFlow})
   * and both the baseline and every variant are evaluated against that slice
   * instead of the whole flow. The `targetNodeId` (for prompt variants) must be
   * within the scope. Faster + lower-variance than a full-flow eval; the
   * winning edit is still promoted onto the FULL flow. Omit for whole-flow.
   */
  scopeNodeIds?: string[];
  /**
   * When true, generate STRUCTURAL variants (model swap / temperature /
   * maxTokens / tool-list / — with {@link allowEdgeEdits} — routing changes)
   * instead of prompt-only rewrites. Default false (prompt-only, unchanged).
   */
  allowStructural?: boolean;
  /** Allow structural variants to add/remove routing edges. Default false. */
  allowEdgeEdits?: boolean;
  /**
   * Whitelist of models a structural variant may swap TO. Without it, no model
   * swaps are proposed (a hallucinated model id would fail at runtime).
   */
  modelCandidates?: Array<{ provider: string; model: string }>;
  /**
   * Seed variant generation from the analysis of a captured debug trace. When
   * set (and a trace analyzer + debug-trace store are wired), the optimizer
   * analyses that execution first and feeds the root-cause + findings into the
   * (structural) generator so variants target the real observed problem.
   */
  analysisExecutionId?: string;
  /**
   * Explicit, ready-made structural edits to evaluate as variants — e.g. the
   * auto-applicable suggestions from a trace analysis, seeded straight from the
   * History UI ("create variant from this suggestion"). Each valid edit becomes
   * a labelled variant (`suggestion-N`) evaluated head-to-head with the
   * baseline (and any generated variants). Combine with `variantCount: 0` to
   * evaluate ONLY these edits without spending LLM calls on generation.
   */
  seedEdits?: StructuralEdit[];
  /** MCP tool ids known to the platform — validates structural tool edits. */
  knownToolIds?: ReadonlySet<string>;
}

export interface VariantEvalResult {
  label: string;
  systemPrompt: string;
  avgScore: number | undefined;
  passRate: number;
  avgLatencyMs: number;
  totalCost: number;
  error?: string;
  /** Per-case eval detail for full traceability (what this variant answered per production case). */
  cases: OptimizerCaseResult[];
  /** Optional temperature this variant applies (prompt or structural variant). */
  temperature?: number;
  /**
   * Structural change set for structural variants. When present, promotion
   * applies this edit to the full flow (instead of the prompt-only path), so a
   * model swap / tool change / routing change survives promotion.
   */
  edit?: StructuralEdit;
  /** Human summary of the change (structural variants). */
  summary?: string;
}

/**
 * One evaluated case for a baseline or variant — the traceable unit the UI
 * renders so an operator can see exactly what each variant produced for each
 * real production input and how it was scored.
 */
export interface OptimizerCaseResult {
  /** Stable source execution id for compatibility with existing optimizer consumers. */
  caseId: string;
  /** The user's original prompt (last user message) that seeded this case. */
  userPrompt: string;
  /** The answer this baseline/variant produced for the case. */
  responseText: string;
  /** Judge score in [0,1] for this case (undefined when no judge ran). */
  score?: number;
  /** Whether all assertions (incl. the judge threshold) passed. */
  passed: boolean;
  /** Per-case error (executor/judge failure), when any. */
  error?: string;
}

export type OptimizationRunStatus =
  | "pending"
  | "mining"
  | "generating"
  | "evaluating"
  | "promoting"
  | "done"
  | "error"
  | "skipped";

export interface OptimizationRun {
  id: string;
  flowId: string;
  targetNodeId: string;
  startedAt: string;
  finishedAt?: string;
  status: OptimizationRunStatus;
  /** Number of production snapshots used to build the eval dataset. */
  sampleCount: number;
  /** Avg judge score of the current (baseline) flow before any changes. */
  baselineScore?: number;
  /** Per-case baseline eval detail — the reference every variant is compared against. */
  baselineCases?: OptimizerCaseResult[];
  /** The baseline flow's current system prompt for the target node (for a before/after diff). */
  baselineSystemPrompt?: string;
  variants: VariantEvalResult[];
  /** Label of the promoted variant (when one was auto- or manually promoted). */
  promotedVariant?: string;
  /** Published version number after promotion. */
  promotedVersion?: number;
  /** Node ids the run was scoped to (partial / sub-graph optimization), if any. */
  scopeNodeIds?: string[];
  /** Analysis of the seed trace (when `analysisExecutionId` was provided). */
  analysis?: TraceAnalysis;
  error?: string;
}

export interface FlowOptimizer {
  /**
   * Runs one full optimization cycle synchronously (awaits completion).
   * Returns the final run record. Used by the synchronous API path and tests.
   */
  run(config: OptimizerConfig): Promise<OptimizationRun>;
  /**
   * Starts an optimization cycle in the BACKGROUND and returns the initial run
   * record immediately (status "mining"). The loop executes detached; poll
   * {@link getRun} for progress and the final result. Used by the async API
   * path so a long run does not block the HTTP request.
   */
  start(config: OptimizerConfig): OptimizationRun;
  /**
   * Promotes a specific variant from a completed run to the flow store.
   * Returns the updated run record.
   */
  promote(
    runId: string,
    variantLabel: string,
    by?: string,
  ): Promise<OptimizationRun>;
  /** Returns the run record for a given run id (or undefined). */
  getRun(runId: string): OptimizationRun | undefined;
  /** Returns all runs for a flow, newest first. */
  listRuns(flowId: string): OptimizationRun[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateRunId(): string {
  return `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Finds the single LLM node in a flow, or the explicitly named one.
 * Returns undefined when the target is ambiguous or not found.
 */
function resolveTargetNode(
  flow: FlowDefinition,
  nodeId?: string,
): string | undefined {
  if (nodeId !== undefined) {
    return flow.nodes.some((n) => n.id === nodeId) ? nodeId : undefined;
  }
  const llmNodes = flow.nodes.filter((n) => n.type === "llm");
  return llmNodes.length === 1 ? llmNodes[0]?.id : undefined;
}

/** Extracts the last user message's text from an eval case (for display). */
function lastUserPrompt(messages: EvalCase["messages"]): string {
  for (const m of messages.toReversed()) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((b) => {
          const bb = b as { type?: string; text?: string };
          return bb.type === "text" ? (bb.text ?? "") : `[${bb.type}]`;
        })
        .join(" ")
        .trim();
    }
  }
  return "";
}

/**
 * Projects a runEval report's per-case results into the traceable
 * {@link OptimizerCaseResult} shape, resolving each case's user prompt from the
 * dataset (runEval's CaseResult does not carry the input messages).
 */
function toCaseResults(
  reportCases: CaseResult[],
  promptByCaseId: Map<string, string>,
): OptimizerCaseResult[] {
  return reportCases.map((c) => ({
    caseId: c.id.startsWith("auto-") ? c.id.slice("auto-".length) : c.id,
    userPrompt: promptByCaseId.get(c.id) ?? "",
    responseText: c.responseText,
    ...(c.score !== undefined ? { score: c.score } : {}),
    passed: c.passed,
    ...(caseError(c) !== undefined ? { error: caseError(c) } : {}),
  }));
}

/** The executor error, else the first judge failure (it leaves the case unscored). */
function caseError(c: CaseResult): string | undefined {
  return c.error ?? c.assertions.find((a) => a.detail?.startsWith("judge error") === true)?.detail;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class FlowOptimizerImpl implements FlowOptimizer {
  /** In-memory run registry (bounded to 100 entries per optimizer instance). */
  private readonly runs = new Map<string, OptimizationRun>();
  private readonly runOrder: string[] = [];
  private readonly MAX_RUNS = 100;

  constructor(
    private readonly replayStore: ReplayStore,
    private readonly flowStore: FlowStore,
    private readonly executor: FlowExecutor,
    private readonly judge: Judge,
    private readonly generatorModel: LanguageModel,
    private readonly logger?: Logger,
    /** Optional: model used to analyse a seed trace (defaults to the generator). */
    private readonly analyzerModel?: LanguageModel,
    /** Optional: source of debug traces for `analysisExecutionId` seeding. */
    private readonly debugTraceStore?: DebugTraceStore,
    /** Optional: flows loaded from FLOWS_DIR (source form), see {@link FlowOptimizerDeps.fileFlows}. */
    private readonly fileFlows?: (flowId: string) => FlowDefinition | undefined,
    /** Optional: makes a synthetic definition runnable, see {@link FlowOptimizerDeps.registerFlow}. */
    private readonly registerFlow?: (def: FlowDefinition) => () => void,
  ) {}

  /**
   * Makes a synthetic definition (a variant, a scoped sub-flow) runnable by the
   * executor for the eval; returns its cleanup. Without `registerFlow` it falls
   * back to a draft in the flow store, which only resolves where the executor
   * reads drafts.
   */
  private async registerForEval(def: FlowDefinition): Promise<() => Promise<void>> {
    if (this.registerFlow !== undefined) {
      const dispose = this.registerFlow(def);
      return async () => dispose();
    }
    try {
      await this.flowStore.saveDraft(def.id, def, "optimizer");
    } catch {
      // best-effort
    }
    return async () => {
      try {
        await this.flowStore.delete(def.id);
      } catch {
        // best-effort cleanup
      }
    };
  }

  /**
   * The flow's current definition: the online version (published, else
   * draft) or — for a flow that only exists as a file — the file.
   */
  private async loadFlow(flowId: string): Promise<FlowDefinition | undefined> {
    const record = await this.flowStore.get(flowId);
    return record?.published ?? record?.draft ?? this.fileFlows?.(flowId) ?? undefined;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Creates + registers a fresh run record for a config. */
  private createRun(config: OptimizerConfig): OptimizationRun {
    const run: OptimizationRun = {
      id: generateRunId(),
      flowId: config.flowId,
      targetNodeId: "", // resolved during execution
      startedAt: new Date().toISOString(),
      status: "mining",
      sampleCount: 0,
      variants: [],
    };
    this.registerRun(run);
    return run;
  }

  async run(config: OptimizerConfig): Promise<OptimizationRun> {
    const run = this.createRun(config);
    return this.execute(run, config);
  }

  start(config: OptimizerConfig): OptimizationRun {
    const run = this.createRun(config);
    // Fire-and-forget: the loop mutates `run` in place (tracked in the registry)
    // so a poll of getRun(run.id) observes progress and the final result. A
    // thrown error is captured into the run record by execute()'s own catch.
    void this.execute(run, config).catch((err) => {
      this.logger?.warn("Optimizer: detached run failed unexpectedly", {
        runId: run.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return { ...run };
  }

  private async execute(
    run: OptimizationRun,
    config: OptimizerConfig,
  ): Promise<OptimizationRun> {
    try {
      // --- 1. Load the current flow definition ----------------------------
      const flowDef = await this.loadFlow(config.flowId);
      if (flowDef == null) {
        return this.finishRun(
          run,
          "skipped",
          `Flow "${config.flowId}" not found (neither online nor in FLOWS_DIR)`,
        );
      }

      // --- 2. Resolve evaluation scope (whole flow or a sub-section) -------
      // When scopeNodeIds is set, extract a runnable sub-flow and evaluate the
      // baseline + every variant against that slice instead of the whole flow.
      // The winning edit is still promoted onto the FULL flow (section 7).
      let evalBaseFlow: FlowDefinition = flowDef;
      const scopeNodeIds = config.scopeNodeIds;
      const scoped = scopeNodeIds !== undefined && scopeNodeIds.length > 0;
      if (scoped) {
        try {
          evalBaseFlow = extractSubFlow(flowDef, scopeNodeIds, {
            ...(config.knownToolIds !== undefined
              ? { knownToolIds: config.knownToolIds }
              : {}),
          });
        } catch (err) {
          return this.finishRun(
            run,
            "skipped",
            `Sub-flow extraction failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        run.scopeNodeIds = scopeNodeIds;
      }

      // --- 3. Resolve target node -----------------------------------------
      // Prompt-only variants need a single target LLM node. Structural variants
      // are self-describing (their edits name the nodes), so a target is
      // optional there — used only for the before/after systemPrompt diff.
      const targetNodeId = resolveTargetNode(evalBaseFlow, config.targetNodeId);
      if (targetNodeId === undefined && config.allowStructural !== true) {
        return this.finishRun(
          run,
          "skipped",
          config.targetNodeId !== undefined
            ? `Node "${config.targetNodeId}" not found in ${scoped ? "scope of " : ""}flow "${config.flowId}"`
            : `Flow "${config.flowId}"${scoped ? " (scoped)" : ""} has ${evalBaseFlow.nodes.filter((n) => n.type === "llm").length} LLM nodes — specify targetNodeId`,
        );
      }
      run.targetNodeId = targetNodeId ?? "";

      // --- 3b. Mine production snapshots ----------------------------------
      this.logger?.info("Optimizer: mining production snapshots", {
        flowId: config.flowId,
        targetNode: targetNodeId,
      });
      const minSamples = config.minSamples ?? 5;
      const maxSamples = config.maxSamples ?? 20;
      const flowSnapshots = await this.replayStore.list(maxSamples * 3, { flowId: config.flowId });

      if (flowSnapshots.length < minSamples) {
        // Studio "Canvas" runs execute an unsaved draft under a throwaway id
        // (`<flowId>@studio-<nonce>`) and are deliberately not mined here.
        return this.finishRun(
          run,
          "skipped",
          `Only ${flowSnapshots.length} snapshots available for flow "${config.flowId}" (need ≥ ${minSamples}). ` +
            `Studio test runs on the Canvas target don't count — run the flow on the Live target or via the API.`,
        );
      }

      // Build eval dataset from production snapshots.
      const dataset = buildAutoEvalDataset(flowSnapshots, {
        maxCases: maxSamples,
        keyPhrases: 0,
        judgeCriteria:
          "Does the assistant's answer correctly and completely address the user's question? Is it factually grounded in the conversation context?",
        judgeThreshold: 0.7,
        dedupe: true,
      });

      if (dataset.cases.length < minSamples) {
        return this.finishRun(
          run,
          "skipped",
          `Only ${dataset.cases.length} usable eval cases available for flow "${config.flowId}" after filtering and de-duplication (need ≥ ${minSamples})`,
        );
      }

      run.sampleCount = dataset.cases.length;
      // Build a caseId → user-prompt map so per-case results are traceable
      // back to the real production input that seeded them.
      const promptByCaseId = new Map<string, string>();
      for (const c of dataset.cases) {
        promptByCaseId.set(c.id, lastUserPrompt(c.messages));
      }
      // Capture the baseline's current system prompt for a before/after diff.
      run.baselineSystemPrompt =
        targetNodeId !== undefined
          ? (evalBaseFlow.nodes.find((n) => n.id === targetNodeId)
              ?.systemPrompt ?? "")
          : "";
      this.logger?.info("Optimizer: eval dataset built", {
        cases: dataset.cases.length,
        flowId: config.flowId,
        scoped,
      });

      // --- Self-grading guard (Req: autopilot governance) -----------------
      // An LLM judge grading its own model's rewritten output is a textbook
      // self-preferencing bias risk. Refuse auto-promotion rather than allow
      // a flow to silently drift toward "whatever this specific model
      // prefers" instead of genuinely better quality. Manual promotion via
      // `promote()` remains available — a human reviewer provides the
      // missing independent check.
      if (
        config.autoPromote === true &&
        config.judgeModelId !== undefined &&
        targetNodeId !== undefined
      ) {
        const targetNode = evalBaseFlow.nodes.find(
          (n) => n.id === targetNodeId,
        );
        const candidateModel = targetNode?.llm;
        if (
          candidateModel !== undefined &&
          candidateModel.provider === config.judgeModelId.provider &&
          candidateModel.model === config.judgeModelId.model
        ) {
          return this.finishRun(
            run,
            "skipped",
            `Refusing auto-promotion: the judge model (${config.judgeModelId.provider}/${config.judgeModelId.model}) ` +
              `is the same model being optimized. Configure a distinct OPTIMIZER_JUDGE_MODEL, or use promote() ` +
              `for a manually-reviewed promotion.`,
          );
        }
      }

      // --- 3c. Optional: analyse a seed trace to steer generation ---------
      let analysisContext: string | undefined;
      if (
        config.analysisExecutionId !== undefined &&
        this.debugTraceStore !== undefined
      ) {
        const trace = this.debugTraceStore.getTrace(config.analysisExecutionId);
        if (trace === undefined) {
          this.logger?.warn(
            "Optimizer: analysisExecutionId not found — proceeding without trace analysis",
            { executionId: config.analysisExecutionId },
          );
        } else {
          try {
            const analysis = await analyzeTrace(
              trace,
              this.analyzerModel ?? this.generatorModel,
              {
                ...(config.scopeNodeIds !== undefined
                  ? { scopeNodeIds: config.scopeNodeIds }
                  : {}),
                ...(config.optimizationGoal !== undefined
                  ? { goal: config.optimizationGoal }
                  : {}),
              },
            );
            run.analysis = analysis;
            analysisContext = renderAnalysisContext(analysis);
            this.logger?.info("Optimizer: seed trace analysed", {
              executionId: config.analysisExecutionId,
              suggestions: analysis.suggestions.length,
            });
          } catch (err) {
            this.logger?.warn("Optimizer: trace analysis failed — continuing", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // Register the sub-flow so its (and its variants') synthetic id resolves
      // in the executor. Cleaned up after evaluation.
      const disposeScoped = scoped ? await this.registerForEval(evalBaseFlow) : undefined;

      // --- 4. Evaluate baseline -------------------------------------------
      run.status = "evaluating";
      this.logger?.info("Optimizer: evaluating baseline");
      // When scoped, drive the sub-flow explicitly; otherwise honour each
      // case's own flow id via the injected executor (unchanged behaviour).
      const baselineExecutor: FlowExecutor = scoped
        ? (_f, messages, metadata) =>
            this.executor(evalBaseFlow.id, messages, metadata)
        : this.executor;
      const baselineReport = await runEval(dataset, baselineExecutor, {
        judge: this.judge,
        concurrency: config.evalConcurrency ?? 2,
      });
      run.baselineScore = baselineReport.avgScore;
      run.baselineCases = toCaseResults(baselineReport.cases, promptByCaseId);
      // Without a single baseline score there is nothing to compare variants to
      // (typically the judge is failing) — say why instead of reporting "done".
      if (baselineReport.avgScore === undefined) {
        await disposeScoped?.();
        const reason = run.baselineCases.find((c) => c.error !== undefined)?.error ?? "no case was scored";
        return this.finishRun(run, "error", `Baseline could not be scored: ${reason}`);
      }
      this.logger?.info("Optimizer: baseline evaluated", {
        avgScore: baselineReport.avgScore,
        passRate: baselineReport.passRate,
      });

      // --- 5. Generate variants (prompt-only or structural) ---------------
      run.status = "generating";
      const requestedCount = config.variantCount ?? 3;
      // Explicit, ready-made edits (e.g. auto-applicable analysis suggestions)
      // become variants directly — no LLM generation needed. Built first so a
      // `variantCount: 0` run evaluates ONLY the seeded suggestion(s).
      const seedVariants = this.buildSeedVariants(
        evalBaseFlow,
        config.seedEdits ?? [],
        targetNodeId,
        config.knownToolIds,
      );
      this.logger?.info("Optimizer: generating variants", {
        count: requestedCount,
        seeds: seedVariants.length,
        mode: config.allowStructural === true ? "structural" : "prompt",
      });
      let variants: GeneratedVariant[];
      try {
        if (requestedCount <= 0) {
          // Seed-only run (or a no-op) — skip generation entirely.
          variants = [];
        } else if (config.allowStructural === true) {
          const structural = await generateStructuralVariants(
            evalBaseFlow,
            this.generatorModel,
            {
              count: requestedCount,
              ...(config.optimizationGoal !== undefined
                ? { optimizationGoal: config.optimizationGoal }
                : {}),
              ...(analysisContext !== undefined ? { analysisContext } : {}),
              ...(config.modelCandidates !== undefined
                ? { modelCandidates: config.modelCandidates }
                : {}),
              allowEdgeEdits: config.allowEdgeEdits === true,
              ...(config.knownToolIds !== undefined
                ? { knownToolIds: config.knownToolIds }
                : {}),
            },
          );
          variants = structural.map((v) =>
            this.toGeneratedFromStructural(v, targetNodeId),
          );
        } else {
          if (targetNodeId === undefined) {
            // Unreachable: the guard above (section 3) already required a
            // defined targetNodeId whenever `allowStructural !== true`, and
            // we're in that branch here (the `else` of `allowStructural`).
            throw new Error(
              "Agent optimizer: target node missing for prompt-only variant generation.",
            );
          }
          const variantOptions: GenerateVariantsOptions = {
            count: requestedCount,
            ...(config.optimizationGoal !== undefined
              ? { optimizationGoal: config.optimizationGoal }
              : {}),
            ...(config.suggestTemperature !== undefined
              ? { suggestTemperature: config.suggestTemperature }
              : {}),
          };
          const prompt = await generatePromptVariants(
            evalBaseFlow,
            targetNodeId,
            this.generatorModel,
            variantOptions,
          );
          variants = prompt.map((v) => ({
            label: v.label,
            definition: v.definition,
            systemPrompt: v.systemPrompt,
            ...(v.temperature !== undefined ? { temperature: v.temperature } : {}),
          }));
        }
      } catch (err) {
        return this.finishRun(
          run,
          "error",
          `Variant generation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Seeded suggestion variants are evaluated first (highest operator intent).
      if (seedVariants.length > 0) {
        variants = [...seedVariants, ...variants];
      }
      this.logger?.info("Optimizer: variants generated", {
        count: variants.length,
        seeded: seedVariants.length,
      });

      // --- 6. Evaluate each variant ---------------------------------------
      run.status = "evaluating";
      const variantResults: VariantEvalResult[] = [];
      // Expose the array on the run NOW so a poll observes variants appear
      // one-by-one as they finish (live progress), not all-at-once at the end.
      run.variants = variantResults;

      for (const variant of variants) {
        this.logger?.info("Optimizer: evaluating variant", {
          label: variant.label,
        });

        // Create a variant-specific executor that runs the modified definition.
        const variantExecutor: FlowExecutor = (_, messages, metadata) =>
          this.executor(variant.definition.id, messages, metadata);

        // Register the variant definition temporarily so the executor can find it.
        const disposeVariant = await this.registerForEval(variant.definition);

        let evalResult: VariantEvalResult;
        try {
          const report = await runEval(dataset, variantExecutor, {
            judge: this.judge,
            concurrency: config.evalConcurrency ?? 2,
          });
          evalResult = {
            label: variant.label,
            systemPrompt: variant.systemPrompt ?? "",
            avgScore: report.avgScore,
            passRate: report.passRate,
            avgLatencyMs: report.avgLatencyMs,
            totalCost: report.totalCost,
            cases: toCaseResults(report.cases, promptByCaseId),
            ...(variant.temperature !== undefined
              ? { temperature: variant.temperature }
              : {}),
            ...(variant.edit !== undefined ? { edit: variant.edit } : {}),
            ...(variant.summary !== undefined
              ? { summary: variant.summary }
              : {}),
          };
        } catch (err) {
          evalResult = {
            label: variant.label,
            systemPrompt: variant.systemPrompt ?? "",
            avgScore: undefined,
            passRate: 0,
            avgLatencyMs: 0,
            totalCost: 0,
            error: err instanceof Error ? err.message : String(err),
            cases: [],
            ...(variant.edit !== undefined ? { edit: variant.edit } : {}),
            ...(variant.summary !== undefined
              ? { summary: variant.summary }
              : {}),
          };
        }
        variantResults.push(evalResult);

        this.logger?.info("Optimizer: variant evaluated", {
          label: variant.label,
          avgScore: evalResult.avgScore,
          passRate: evalResult.passRate,
        });

        await disposeVariant();
      }

      await disposeScoped?.();

      // Every variant failed to run (or to be judged): report that as an
      // error rather than a "done" run with nothing to compare.
      if (variantResults.length > 0 && variantResults.every((v) => v.avgScore === undefined)) {
        const reason =
          variantResults.flatMap((v) => v.cases).find((c) => c.error !== undefined)?.error ??
          variantResults.find((v) => v.error !== undefined)?.error ??
          "no case was scored";
        return this.finishRun(run, "error", `No variant could be evaluated: ${reason}`);
      }

      // --- 7. Auto-promote if configured ----------------------------------
      if (config.autoPromote === true) {
        run.status = "promoting";
        const minImprovement = config.minScoreImprovement ?? 0.05;
        const baseline = run.baselineScore ?? 0;

        // Find the best scoring variant that clears the improvement bar.
        const winner = variantResults
          .filter(
            (v) =>
              v.error === undefined &&
              v.avgScore !== undefined &&
              v.avgScore - baseline >= minImprovement,
          )
          .sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0))[0];

        if (winner !== undefined) {
          const promoted = await this.promoteVariant(
            config.flowId,
            flowDef,
            run.targetNodeId,
            winner,
            "optimizer",
          );
          run.promotedVariant = winner.label;
          run.promotedVersion = promoted.version;
          this.logger?.info("Optimizer: variant auto-promoted", {
            label: winner.label,
            score: winner.avgScore,
            improvement:
              winner.avgScore !== undefined
                ? winner.avgScore - baseline
                : undefined,
            version: promoted.version,
          });
        } else {
          this.logger?.info(
            "Optimizer: no variant cleared the improvement threshold",
            {
              threshold: minImprovement,
              baselineScore: baseline,
              bestVariantScore:
                variantResults.length > 0
                  ? Math.max(...variantResults.map((v) => v.avgScore ?? 0))
                  : undefined,
            },
          );
        }
      }

      return this.finishRun(run, "done");
    } catch (err) {
      return this.finishRun(
        run,
        "error",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async promote(
    runId: string,
    variantLabel: string,
    by?: string,
  ): Promise<OptimizationRun> {
    const run = this.runs.get(runId);
    if (run === undefined)
      throw new Error(`Optimization run "${runId}" not found`);
    if (run.status !== "done") {
      throw new Error(`Run "${runId}" is not complete (status: ${run.status})`);
    }

    const variantResult = run.variants.find((v) => v.label === variantLabel);
    if (variantResult === undefined) {
      throw new Error(`Variant "${variantLabel}" not found in run "${runId}"`);
    }

    const flowDef = await this.loadFlow(run.flowId);
    if (flowDef == null) throw new Error(`Flow "${run.flowId}" not found`);

    // Reconstruct the variant definition — a structural edit when the variant
    // carries one, else the classic system-prompt (+temperature) rewrite.
    const variantDef = this.buildPromotedDefinition(
      flowDef,
      run.targetNodeId,
      variantResult,
    );
    // Publish under the original flow id.
    const publishDef: FlowDefinition = { ...variantDef, id: run.flowId };

    await this.flowStore.saveDraft(run.flowId, publishDef, by ?? "optimizer");
    const published = await this.flowStore.publish(
      run.flowId,
      by ?? "optimizer",
    );

    run.promotedVariant = variantLabel;
    run.promotedVersion = published.version;
    this.logger?.info("Optimizer: variant manually promoted", {
      runId,
      label: variantLabel,
      version: published.version,
    });
    return { ...run };
  }

  getRun(runId: string): OptimizationRun | undefined {
    const run = this.runs.get(runId);
    return run ? { ...run } : undefined;
  }

  listRuns(flowId: string): OptimizationRun[] {
    return [...this.runOrder]
      .reverse()
      .map((id) => this.runs.get(id))
      .filter(
        (r): r is OptimizationRun => r !== undefined && r.flowId === flowId,
      )
      .map((r) => ({ ...r }));
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async promoteVariant(
    flowId: string,
    baseFlow: FlowDefinition,
    targetNodeId: string,
    winner: VariantEvalResult,
    by: string,
  ): Promise<{ version: number }> {
    const newDef = this.buildPromotedDefinition(baseFlow, targetNodeId, winner);
    // Restore the original flow id so it is live.
    const publishDef: FlowDefinition = { ...newDef, id: flowId };

    await this.flowStore.saveDraft(flowId, publishDef, by);
    const record = await this.flowStore.publish(flowId, by);
    return { version: record.version };
  }

  /**
   * Reconstructs the flow definition for a winning/selected variant onto
   * `baseFlow`. Structural variants (carrying an `edit`) are applied via
   * {@link applyStructuralEdit}; prompt-only variants via {@link applyVariant}.
   * Note: the winning edit — even one produced against a scoped sub-flow — is
   * applied to the FULL base flow, because a structural edit references real
   * node/edge ids that exist in the full flow too.
   */
  private buildPromotedDefinition(
    baseFlow: FlowDefinition,
    targetNodeId: string,
    variant: VariantEvalResult,
  ): FlowDefinition {
    if (variant.edit !== undefined) {
      return applyStructuralEdit(baseFlow, variant.edit);
    }
    return applyVariant(
      baseFlow,
      targetNodeId,
      variant.systemPrompt,
      variant.label,
      variant.temperature,
    );
  }

  /**
   * Maps a {@link StructuralVariant} to the optimizer's internal
   * {@link GeneratedVariant}, deriving the resulting system prompt for the
   * target node (for the before/after diff) when there is one.
   */
  /**
   * Converts explicit {@link StructuralEdit}s (e.g. the auto-applicable
   * suggestions from a trace analysis, seeded from the History UI) into
   * evaluable variants. Each edit is applied to the base flow, validated
   * (structurally-invalid ones — bad provider, unknown edge target, broken
   * reachability — are dropped), and labelled `suggestion-N`. Reuses the same
   * apply + validate path as the generator, so a seeded variant is
   * indistinguishable from a generated one downstream (eval + promotion).
   */
  private buildSeedVariants(
    baseFlow: FlowDefinition,
    edits: readonly StructuralEdit[],
    targetNodeId: string | undefined,
    knownToolIds: ReadonlySet<string> | undefined,
  ): GeneratedVariant[] {
    const out: GeneratedVariant[] = [];
    let i = 1;
    for (const edit of edits) {
      const hasChange =
        (edit.nodes !== undefined && edit.nodes.length > 0) ||
        (edit.edges !== undefined && edit.edges.length > 0);
      if (!hasChange) continue;
      const label = `suggestion-${i++}`;
      const definition = applyStructuralVariant(baseFlow, edit, label);
      const report = validateFlow(definition, knownToolIds);
      if (!report.valid) {
        this.logger?.warn("Optimizer: dropping structurally-invalid seed edit", {
          label,
        });
        continue;
      }
      out.push(
        this.toGeneratedFromStructural(
          { label, definition, edit, summary: edit.summary ?? label },
          targetNodeId,
        ),
      );
    }
    return out;
  }

  private toGeneratedFromStructural(
    v: StructuralVariant,
    targetNodeId: string | undefined,
  ): GeneratedVariant {
    const systemPrompt =
      targetNodeId !== undefined
        ? v.definition.nodes.find((n) => n.id === targetNodeId)?.systemPrompt
        : undefined;
    return {
      label: v.label,
      definition: v.definition,
      edit: v.edit,
      summary: v.summary,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    };
  }

  private registerRun(run: OptimizationRun): void {
    this.runs.set(run.id, run);
    this.runOrder.push(run.id);
    if (this.runOrder.length > this.MAX_RUNS) {
      const oldest = this.runOrder.shift();
      if (oldest !== undefined) this.runs.delete(oldest);
    }
  }

  private finishRun(
    run: OptimizationRun,
    status: OptimizationRunStatus,
    error?: string,
  ): OptimizationRun {
    run.status = status;
    run.finishedAt = new Date().toISOString();
    if (error !== undefined) run.error = error;
    if (error !== undefined && status === "skipped") {
      this.logger?.info("Optimizer: run skipped", {
        reason: error,
        flowId: run.flowId,
      });
    }
    return { ...run };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface FlowOptimizerDeps {
  replayStore: ReplayStore;
  flowStore: FlowStore;
  executor: FlowExecutor;
  judge: Judge;
  generatorModel: LanguageModel;
  logger?: Logger;
  /**
   * Optional model used to analyse a seed trace when `analysisExecutionId` is
   * given. Falls back to the generator model when omitted.
   */
  analyzerModel?: LanguageModel;
  /** Optional debug-trace source enabling `analysisExecutionId` seeding. */
  debugTraceStore?: DebugTraceStore;
  /**
   * Flows that exist only as files in FLOWS_DIR (source form). Without it
   * such flows can't be optimized. Promoting a variant of one publishes an
   * online version, which then takes precedence over the file — the same as
   * publishing it from the Studio.
   */
  fileFlows?: (flowId: string) => FlowDefinition | undefined;
  /**
   * Makes a synthetic definition (`<flowId>@variant/<label>`, a scoped
   * sub-flow) resolvable by `executor` for the duration of an eval; returns
   * the cleanup. Without it the optimizer saves them as flow-store drafts,
   * which the runtime's executor does not resolve.
   */
  registerFlow?: (def: FlowDefinition) => () => void;
}

/**
 * Creates a {@link FlowOptimizer}. All dependencies are injected so the
 * implementation is fully testable without network calls.
 */
export function createFlowOptimizer(deps: FlowOptimizerDeps): FlowOptimizer {
  return new FlowOptimizerImpl(
    deps.replayStore,
    deps.flowStore,
    deps.executor,
    deps.judge,
    deps.generatorModel,
    deps.logger,
    deps.analyzerModel,
    deps.debugTraceStore,
    deps.fileFlows,
    deps.registerFlow,
  );
}
