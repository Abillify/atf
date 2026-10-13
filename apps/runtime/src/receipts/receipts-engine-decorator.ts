// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Decision_Receipt engine decorator (Req 15.1, 15.2, 15.6).
 *
 * Wraps the RAW graph engine (below the PII vault in the decorator stack) so
 * that after every execution — success or failure — the sealed Debug_Trace is
 * turned into signed Decision_Receipts: one `chat_completion` receipt plus one
 * `tool_call` receipt per tool call. Because this decorator sits INSIDE
 * `withPiiVault`, the trace it reads still carries vault placeholders rather
 * than raw PII, and the vault's per-execution action summary (types + counts,
 * no values) is still readable for the PII proof.
 *
 * Receipt issuance is best-effort by design: a receipt failure (missing
 * trace, signing error) logs a warning and never breaks the user's request.
 * The receipts themselves are fail-loud at startup instead — a malformed
 * `RECEIPT_SIGNING_KEY` prevents boot (see `signing-key.ts`).
 */

import { randomUUID } from "node:crypto";

import type {
  GraphEngineService,
  CompiledAgentGraph,
} from "../graph/graph-engine/state.js";
import type { RequestContext } from "../types/monitoring.js";
import type {
  ChatMessage,
  ChatCompletionChunk,
  TokenUsage,
} from "../types/openai.js";
import type { MonitoringServiceInterface } from "../monitoring/monitoring-service.js";
import type { FlowGuardrailOverride } from "../graph/flow-guardrail-resolver.js";
import type { FlowDefinition } from "../types/flow.js";
import type { DebugTraceStore } from "../monitoring/debug-trace-store.js";
import type { PiiVault } from "../graph/pii-vault.js";
import type { ApprovalRegistry } from "../graph/approval-gate.js";
import type { Logger } from "../observability/logger.js";

import {
  buildReceiptPayloads,
  signReceiptPayload,
  sha256Canonical,
  COMPLIANCE_NONE_MARKER,
  type ReceiptBuildContext,
} from "./receipt-builder.js";
import type { ReceiptStore } from "./receipt-store.js";
import type { ReceiptSigningKey } from "./signing-key.js";
import type { TransparencyLog } from "./transparency-log.js";

/** Collaborators the decorator consults per execution (all hot-reload safe). */
export interface DecisionReceiptDeps {
  /** Sealed traces are read from here after the inner execution finishes. */
  debugTraceStore: DebugTraceStore;
  /** Where signed receipts are published for routes / header lookup. */
  receiptStore: ReceiptStore;
  /** Ed25519 signing key (parsed at startup). */
  signingKey: ReceiptSigningKey;
  logger: Logger;
  /** Current tool-authz policy hash (from the live ToolAuthzEngine). */
  getToolAuthzHash: () => string;
  /** Current compliance policy object; undefined when none is loaded. */
  getCompliancePolicy: () => unknown;
  /** Resolve the flow definition for the prompt-template hash; undefined when unknown. */
  getFlowDefinition: (flowId: string) => FlowDefinition | undefined;
  /** PII vault for the per-execution tokenization proof, when enabled. */
  vault?: PiiVault;
  /** Approval registry for the approval chain, when enabled. */
  approvalGate?: ApprovalRegistry;
  /**
   * RFC-6962 transparency log (Req 15.3): every signed receipt is appended
   * so inclusion proofs become possible. Optional — without it the receipts
   * are still signed and stored, just not anchored in a Merkle tree.
   */
  transparencyLog?: TransparencyLog;
}

async function resolvedApprovalsFor(
  gate: ApprovalRegistry | undefined,
  executionId: string,
) {
  if (gate === undefined) return [];
  try {
    const resolved = await gate.listResolved();
    return resolved.filter((a) => a.executionId === executionId);
  } catch {
    return [];
  }
}

/**
 * Build, sign and store the receipts for one finished execution. Never
 * throws — every failure degrades to a warning so receipt issuance cannot
 * take down the chat path.
 */
async function issueReceipts(
  engineFlowId: string,
  ctx: RequestContext,
  deps: DecisionReceiptDeps,
): Promise<void> {
  const { debugTraceStore, receiptStore, signingKey, logger } = deps;
  try {
    const trace = debugTraceStore.getTrace(ctx.executionId);
    if (trace === undefined) {
      logger.warn("decision receipt skipped: no debug trace for execution", {
        executionId: ctx.executionId,
      });
      return;
    }
    const flowDefinition = deps.getFlowDefinition(trace.flow_id ?? engineFlowId);
    const compliancePolicy = deps.getCompliancePolicy();
    const buildCtx: ReceiptBuildContext = {
      // The chat route pre-generates the parent receipt id so the
      // `X-ATF-Receipt` header can be sent before the run finishes (Req 15.4);
      // fall back to a fresh UUID for engines called without that plumbing.
      receiptId: ctx.decisionReceiptId ?? randomUUID(),
      tenantId: ctx.clientId ?? null,
      promptTemplateHash:
        flowDefinition === undefined
          ? null
          : sha256Canonical(flowDefinition),
      toolAuthzHash: deps.getToolAuthzHash(),
      complianceHash:
        compliancePolicy === undefined
          ? COMPLIANCE_NONE_MARKER
          : sha256Canonical(compliancePolicy),
      piiSummary:
        deps.vault !== undefined
          ? deps.vault.getActionSummary(ctx.executionId)
          : undefined,
      approvals: await resolvedApprovalsFor(deps.approvalGate, ctx.executionId),
    };
    const payloads = buildReceiptPayloads(trace, buildCtx);
    for (const payload of payloads) {
      const signed = await signReceiptPayload(
        payload,
        signingKey.privateKey,
        signingKey.kid,
      );
      receiptStore.put(signed);
      // Append-only transparency log: a failing append must not lose the
      // receipt (it stays in receiptStore) — degrade to a warning, matching
      // the best-effort issuance contract of this decorator.
      if (deps.transparencyLog !== undefined) {
        try {
          await deps.transparencyLog.append(
            payload.receipt_id,
            signed.coseBytes,
          );
        } catch (err) {
          logger.warn("decision receipt transparency-log append failed", {
            executionId: ctx.executionId,
            receiptId: payload.receipt_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    logger.debug("decision receipts issued", {
      executionId: ctx.executionId,
      count: payloads.length,
      receiptId: payloads[0]?.receipt_id,
    });
  } catch (err) {
    logger.warn("decision receipt issuance failed", {
      executionId: ctx.executionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Wrap `engine` so every {@link GraphEngineService.executeFlow} produces
 * signed Decision_Receipts after the run finishes. All other methods delegate
 * unchanged (mirroring the `withPiiVault` decorator shape).
 */
export function withDecisionReceipts(
  engine: GraphEngineService,
  deps: DecisionReceiptDeps,
): GraphEngineService {
  return {
    buildGraph(
      flow: FlowDefinition,
      knownToolIds?: Set<string>,
    ): CompiledAgentGraph {
      return engine.buildGraph(flow, knownToolIds);
    },

    async executeFlow(
      flowId: string,
      messages: ChatMessage[],
      ctx: RequestContext,
      onChunk: (chunk: ChatCompletionChunk) => Promise<void>,
      onDone: (usage: TokenUsage) => Promise<void>,
      monitoring?: MonitoringServiceInterface,
      guardrailOverride?: FlowGuardrailOverride,
      onFinalResponse?: (response: string) => void | Promise<void>,
    ): Promise<void> {
      try {
        await engine.executeFlow(
          flowId,
          messages,
          ctx,
          onChunk,
          onDone,
          monitoring,
          guardrailOverride,
          onFinalResponse,
        );
      } finally {
        // The engine seals the trace (finishTrace) before both the success
        // return and the error throw, so the trace is complete here either
        // way. Issuance itself never throws.
        await issueReceipts(flowId, ctx, deps);
      }
    },

    invalidateCache(flowId: string): void {
      engine.invalidateCache(flowId);
    },

    hasCapacity(): boolean {
      return engine.hasCapacity();
    },

    getQueueState() {
      return engine.getQueueState();
    },

    ...(engine.setDebugStore !== undefined
      ? { setDebugStore: engine.setDebugStore.bind(engine) }
      : {}),
    ...(engine.setToolAuthzEngine !== undefined
      ? { setToolAuthzEngine: engine.setToolAuthzEngine.bind(engine) }
      : {}),
    ...(engine.setCompliancePolicy !== undefined
      ? { setCompliancePolicy: engine.setCompliancePolicy.bind(engine) }
      : {}),
  };
}
