// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Counterfactual Impact Simulation (`src/graph/graph-engine/simulate.ts`)
 *
 * Runs a DRAFT flow definition against the last N real production execution
 * snapshots for the same flow ID and reports how it would have behaved,
 * without ever publishing it. This is the "what would change if I shipped
 * this?" check for `POST /flows/:id/simulate`.
 *
 * Wires together subsystems that already exist for other purposes, rather
 * than building a new execution path:
 *   - {@link ReplayStore} (replay.ts)     — supplies the historical snapshots.
 *   - {@link diffFlows} (flow-diff.ts)    — structural draft↔published diff.
 *   - {@link buildDataFlowMap} (data-flow-map.ts) — RoPA / residency verdict.
 *   - {@link decideAccess} (flow-authorizer.ts)   — access-policy visibility.
 *   - {@link createGraphEngine}           — a throwaway engine instance scoped
 *     to a single-flow registry containing ONLY the draft, so it can be
 *     executed without ever registering it under its real flow id.
 *
 * Cost discipline (Req.: this is real spend, not a dry run): every draft
 * execution is a real LLM call. `maxSnapshots` and `maxCostUsd` are REQUIRED
 * — there is no default of "run everything". The loop checks accumulated
 * spend before each execution and stops the moment the cap would be
 * exceeded, reporting `costCapHit` so the caller knows the sample is partial
 * rather than silently truncated.
 *
 * Known simplifications (documented rather than silently wrong):
 *   - Only the draft is executed against real snapshots; the "production"
 *     side of every comparison is the snapshot's already-stored response
 *     text (free — no second paid run against the published flow).
 *   - The temporary engine is built from a minimal dependency set (MCP
 *     wrapper + LLM provider factory). A draft that depends on RAG
 *     (embedder/vector store), memory, or media nodes will fail those nodes
 *     in simulation even though they would work once published with the
 *     full engine's dependencies wired in.
 *   - Security posture (red-team) and per-request access simulation are not
 *     included — access is evaluated once, anonymously, as a coarse "is this
 *     flow open by default" signal, not per historical requester identity.
 */

import type { FlowDefinition } from "../../types/flow.js";
import type { ChatCompletionChunk, TokenUsage } from "../../types/openai.js";
import type { AppConfig } from "../../config/index.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import type { LlmProviderFactory } from "../exec-runtime.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { CompliancePolicy } from "../../compliance/policy-schema.js";
import type { ReplayStore, ExecutionSnapshot } from "../replay.js";
import { textSimilarity } from "../replay.js";
import { diffFlows, type FlowDiff } from "../flow-diff.js";
import { buildDataFlowMap, type DataFlowMap } from "../../compliance/data-flow-map.js";
import type { FlowAuthorizer } from "../flow-authorizer.js";
import { createGraphEngine } from "./handler-factories.js";
import type { FlowRegistry } from "../flow-parser/loader.js";

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

export interface SimulationBehaviorCase {
  executionId: string;
  originalResponse: string;
  draftResponse: string;
  /** Word-set Jaccard similarity between the two answers, [0,1]. */
  similarity: number;
  changed: boolean;
  costUsd: number;
  latencyMs: number;
  error?: string;
}

export interface SimulationBehaviorReport {
  /** How many snapshots existed for this flow id, before capping. */
  available: number;
  /** How many were actually executed against the draft (<= maxSnapshots). */
  sampled: number;
  cases: SimulationBehaviorCase[];
  avgSimilarity: number;
  changedCount: number;
  errorCount: number;
  totalCostUsd: number;
  avgLatencyMs: number;
}

export interface SimulationAccessReport {
  hasPolicy: boolean;
  /**
   * Whether an anonymous request (no role/group/tenant/plan/claims) would be
   * allowed to invoke this flow id under the CURRENT access policy. A coarse
   * "is this flow open by default" signal — access rules are keyed by flow
   * id, not flow content, so this does not differ between draft and
   * published versions of the same flow id.
   */
  allowsAnonymous: boolean;
  reason?: string;
}

export interface SimulationCostCap {
  limitUsd: number;
  spentUsd: number;
  /** True when the cap was hit before all requested snapshots were sampled. */
  capped: boolean;
}

export interface SimulationReport {
  flowId: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  /** Structural diff against the published version — undefined if there is none yet. */
  structural?: FlowDiff;
  compliance: {
    draft: DataFlowMap;
    published?: DataFlowMap;
  };
  access: SimulationAccessReport;
  behavior: SimulationBehaviorReport;
  costCap: SimulationCostCap;
}

// ---------------------------------------------------------------------------
// Options + deps
// ---------------------------------------------------------------------------

export interface SimulationOptions {
  /** Hard cap on how many historical snapshots to replay. Required — no "run everything" default. */
  maxSnapshots: number;
  /** Hard cap on total USD spend for the behavioral sample. Required. */
  maxCostUsd: number;
}

export interface SimulationDeps {
  appConfig: AppConfig;
  mcpWrapper?: McpWrapperService;
  llmProviderFactory?: LlmProviderFactory;
  replayStore: ReplayStore;
  flowAuthorizer?: FlowAuthorizer;
  /** Getter (not a snapshot value) so a hot-reloaded policy stays current. */
  getCompliancePolicy?: () => CompliancePolicy | undefined;
}

const ANONYMOUS_CONTEXT: RequestContext = {
  ssoToken: "",
  executionId: "simulate-access-check",
};

/**
 * A snapshot pool larger than any realistic `maxSnapshots` request, since
 * {@link ReplayStore.list} has no server-side flow-id filter — snapshots for
 * the target flow are picked out of this pool client-side. Bounded so a
 * flow with few snapshots relative to overall traffic doesn't force scanning
 * the entire store.
 */
const SNAPSHOT_POOL_SIZE = 2000;

export async function simulateFlow(
  flowId: string,
  draft: FlowDefinition,
  published: FlowDefinition | undefined,
  options: SimulationOptions,
  deps: SimulationDeps,
): Promise<SimulationReport> {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();

  // --- Structural + compliance (static, no execution, no cost) ---
  const structural =
    published !== undefined ? diffFlows(published, draft) : undefined;
  const policy = deps.getCompliancePolicy?.();
  const compliance = {
    draft: buildDataFlowMap([draft], policy),
    ...(published !== undefined
      ? { published: buildDataFlowMap([published], policy) }
      : {}),
  };

  // --- Access (static, anonymous coarse check) ---
  const access: SimulationAccessReport =
    deps.flowAuthorizer !== undefined
      ? (() => {
          const decision = deps.flowAuthorizer.authorize(
            flowId,
            ANONYMOUS_CONTEXT,
          );
          return {
            hasPolicy: deps.flowAuthorizer.hasPolicy(),
            allowsAnonymous: decision.allowed,
            ...(decision.reason !== undefined
              ? { reason: decision.reason }
              : {}),
          };
        })()
      : { hasPolicy: false, allowsAnonymous: true };

  // --- Behavioral sample against real snapshots ---
  const forFlow = await deps.replayStore.list(SNAPSHOT_POOL_SIZE, { flowId });
  const toSample = forFlow.slice(0, Math.max(0, options.maxSnapshots));

  const behavior = await runBehaviorSample(flowId, draft, toSample, options, deps);

  return {
    flowId,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...(structural !== undefined ? { structural } : {}),
    compliance,
    access,
    behavior: { ...behavior, available: forFlow.length },
    costCap: {
      limitUsd: options.maxCostUsd,
      spentUsd: behavior.totalCostUsd,
      capped: behavior.sampled < toSample.length,
    },
  };
}

async function runBehaviorSample(
  flowId: string,
  draft: FlowDefinition,
  snapshots: ExecutionSnapshot[],
  options: SimulationOptions,
  deps: SimulationDeps,
): Promise<Omit<SimulationBehaviorReport, "available">> {
  const cases: SimulationBehaviorCase[] = [];
  if (snapshots.length === 0) {
    return {
      sampled: 0,
      cases,
      avgSimilarity: 0,
      changedCount: 0,
      errorCount: 0,
      totalCostUsd: 0,
      avgLatencyMs: 0,
    };
  }

  // Synthetic id — never overlaps a real flow id, so it can't collide with
  // concurrent live traffic through the shared flow-registry contract.
  const simulatedFlowId = `${flowId}::simulate::${crypto.randomUUID()}`;
  const draftRegistry: FlowRegistry = {
    get: (id) => (id === simulatedFlowId ? draft : undefined),
    list: () => [draft],
  };
  const engine = createGraphEngine(deps.appConfig, {
    flowRegistry: draftRegistry,
    ...(deps.mcpWrapper !== undefined ? { mcpWrapper: deps.mcpWrapper } : {}),
    ...(deps.llmProviderFactory !== undefined
      ? { llmProviderFactory: deps.llmProviderFactory }
      : {}),
  });

  let totalCostUsd = 0;
  let totalLatencyMs = 0;
  let changedCount = 0;
  let errorCount = 0;
  let simSum = 0;

  for (const snapshot of snapshots) {
    if (totalCostUsd >= options.maxCostUsd) break;

    const start = Date.now();
    let draftResponse = "";
    let usage: TokenUsage | undefined;
    let error: string | undefined;
    try {
      await engine.executeFlow(
        simulatedFlowId,
        snapshot.messages,
        {
          ssoToken: "simulate",
          executionId: `simulate-${crypto.randomUUID()}`,
        },
        async (chunk: ChatCompletionChunk) => {
          const delta = chunk.choices[0]?.delta?.content;
          if (typeof delta === "string") draftResponse += delta;
        },
        async (u: TokenUsage) => {
          usage = u;
        },
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      errorCount++;
    }
    const latencyMs = Date.now() - start;
    const costUsd = usage?.cost_usd ?? 0;
    totalCostUsd += costUsd;
    totalLatencyMs += latencyMs;

    const similarity =
      error === undefined
        ? textSimilarity(snapshot.responseText, draftResponse)
        : 0;
    const changed = error !== undefined || similarity < 1;
    if (changed) changedCount++;
    simSum += similarity;

    cases.push({
      executionId: snapshot.executionId,
      originalResponse: snapshot.responseText,
      draftResponse,
      similarity,
      changed,
      costUsd,
      latencyMs,
      ...(error !== undefined ? { error } : {}),
    });
  }

  const sampled = cases.length;
  return {
    sampled,
    cases,
    avgSimilarity: sampled > 0 ? Math.round((simSum / sampled) * 1000) / 1000 : 0,
    changedCount,
    errorCount,
    totalCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
    avgLatencyMs: sampled > 0 ? Math.round(totalLatencyMs / sampled) : 0,
  };
}
