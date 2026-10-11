// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Guardrails builder (`src/bootstrap/guardrails.ts`)
 *
 * Constructs every guardrail and safety gate:
 *   - Input guardrail (heuristic + optional model-based second opinion)
 *   - Output guardrail (PII redaction / content blocklist)
 *   - Tool-egress DLP guardrail
 *   - Per-flow guardrail resolver
 *   - Human-in-the-loop approval gate (local + optional distributed/Redis)
 *   - Groundedness / citation gate (LLM or semantic)
 *
 * Keeping every "safety control" together makes it easy to audit, and the
 * fail-open/fail-closed semantics (ADR-0002) are visible in one place.
 */

import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { GuardrailPolicyService as GuardrailPolicy } from "../graph/guardrail-policy.js";
import type { Embedder } from "../graph/semantic-cache.js";
import { InputGuardrail } from "../graph/input-guardrails.js";
import { createModelInputClassifier } from "../graph/input-guardrail-model.js";
import {
  createOutputGuardrail,
  createToolEgressGuardrail,
  type OutputGuardrail,
  type ToolEgressGuardrail,
} from "../graph/output-guardrails.js";
import { createFlowGuardrailResolver } from "../graph/flow-guardrail-resolver.js";
import {
  createApprovalGate,
  type ApprovalRegistry as ApprovalGate,
} from "../graph/approval-gate.js";
import { createDistributedApprovalGate } from "../graph/distributed-approval.js";
import {
  createGroundednessGate,
  type GroundednessGate,
} from "../graph/groundedness.js";
import {
  createLlmProvider,
  createEmbeddingProvider,
} from "../graph/llm-factory.js";
import { AiSdkEmbedder } from "../graph/semantic-cache.js";
import { maybeCacheEmbedder } from "../graph/embedding-cache.js";
import {
  createToolOutputValidator,
  type ToolOutputValidator,
} from "../mcp/tool-output-validator.js";

export interface GuardrailsResult {
  inputGuardrail: InputGuardrail | undefined;
  inputGuardrailClassify:
    | ReturnType<typeof createModelInputClassifier>
    | undefined;
  outputGuardrail: OutputGuardrail | undefined;
  toolEgressGuardrail: ToolEgressGuardrail | undefined;
  toolOutputValidator: ToolOutputValidator | undefined;
  flowGuardrailResolver: ReturnType<typeof createFlowGuardrailResolver>;
  approvalGate: ApprovalGate | undefined;
  groundednessGate: GroundednessGate | undefined;
}

export async function buildGuardrails(
  config: AppConfig,
  logger: Logger,
  guardrailPolicy: GuardrailPolicy,
  sharedEmbedder: Embedder | undefined,
): Promise<GuardrailsResult> {
  // ── Heuristic input guardrail ─────────────────────────────────────────────
  const inputGuardrail =
    config.inputGuardrailsEnabled === true
      ? new InputGuardrail({ threshold: config.inputGuardrailThreshold ?? 0.8 })
      : undefined;
  if (inputGuardrail !== undefined) {
    logger.info("Input guardrails enabled", {
      mode: config.inputGuardrailMode ?? "flag",
    });
  }

  // ── Optional model-based second opinion ──────────────────────────────────
  let inputGuardrailClassify:
    | ReturnType<typeof createModelInputClassifier>
    | undefined;
  if (
    inputGuardrail !== undefined &&
    config.inputGuardrailModel !== undefined
  ) {
    try {
      const guardrailModel = createLlmProvider(
        config.inputGuardrailModel,
        config,
      );
      inputGuardrailClassify = createModelInputClassifier(guardrailModel, {
        logger,
        failMode: config.inputGuardrailModelFailMode ?? "open",
        maxChars: config.inputGuardrailMaxChars,
      });
      logger.info("Model-based input guardrail enabled", {
        provider: config.inputGuardrailModel.provider,
        model: config.inputGuardrailModel.model,
        minScore: config.inputGuardrailModelMinScore ?? 0.3,
        failMode: config.inputGuardrailModelFailMode ?? "open",
        maxChars: config.inputGuardrailMaxChars ?? 8000,
      });
    } catch (err) {
      logger.warn("Failed to build model-based input guardrail — disabled", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Output guardrail ──────────────────────────────────────────────────────
  const outputGuardrailOpts = {
    enabled: config.outputGuardrailsEnabled ?? false,
    redactPii: config.guardrailRedactPii ?? true,
    ...(config.guardrailPiiTypes !== undefined
      ? { piiTypes: config.guardrailPiiTypes }
      : {}),
    ...(config.guardrailBlockedPatterns !== undefined
      ? { blockedPatterns: config.guardrailBlockedPatterns }
      : {}),
    mode: config.guardrailMode ?? "redact",
  } as const;
  const outputGuardrail = createOutputGuardrail(outputGuardrailOpts, logger);

  // ── Tool-egress DLP guardrail ─────────────────────────────────────────────
  const toolEgressGuardrail = createToolEgressGuardrail(
    {
      enabled: config.toolEgressGuardrailEnabled ?? false,
      redactPii: config.guardrailRedactPii ?? true,
      ...(config.guardrailPiiTypes !== undefined
        ? { piiTypes: config.guardrailPiiTypes }
        : {}),
      ...(config.guardrailBlockedPatterns !== undefined
        ? { blockedPatterns: config.guardrailBlockedPatterns }
        : {}),
      mode: config.toolEgressMode ?? "redact",
    },
    logger,
  );

  // ── Per-flow guardrail resolver ───────────────────────────────────────────
  const flowGuardrailResolver = createFlowGuardrailResolver(
    guardrailPolicy,
    {
      output: outputGuardrailOpts,
      egress: {
        enabled: config.toolEgressGuardrailEnabled ?? false,
        redactPii: config.guardrailRedactPii ?? true,
        ...(config.guardrailPiiTypes !== undefined
          ? { piiTypes: config.guardrailPiiTypes }
          : {}),
        ...(config.guardrailBlockedPatterns !== undefined
          ? { blockedPatterns: config.guardrailBlockedPatterns }
          : {}),
        mode: config.toolEgressMode ?? "redact",
      },
    },
    logger,
  );

  // ── Approval gate ─────────────────────────────────────────────────────────
  const approvalTimeoutMs = config.approvalTimeoutMs ?? 30_000;
  let approvalGate: ApprovalGate | undefined = createApprovalGate(
    {
      enabled: config.approvalGateEnabled ?? false,
      ...(config.approvalRequireTools !== undefined
        ? { requireApprovalTools: config.approvalRequireTools }
        : {}),
      timeoutMs: approvalTimeoutMs,
    },
    logger,
  );
  if (approvalGate !== undefined && config.redisUrl !== undefined) {
    approvalGate = await createDistributedApprovalGate(
      approvalGate,
      config.redisUrl,
      approvalTimeoutMs,
      logger,
    );
  }

  // ── Groundedness gate ─────────────────────────────────────────────────────
  let groundednessLlm: import("ai").LanguageModel | undefined;
  if (
    config.groundednessEnabled === true &&
    config.groundednessType === "llm" &&
    config.groundednessJudgeModel !== undefined
  ) {
    try {
      groundednessLlm = createLlmProvider(
        config.groundednessJudgeModel,
        config,
      );
    } catch (err) {
      logger.warn("Failed to build model-based groundedness judge", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Dedicated groundedness embedder — optional, falls back to sharedEmbedder.
  let groundednessEmbedder: Embedder | undefined = sharedEmbedder;
  if (
    config.groundednessEnabled === true &&
    config.groundednessType === "semantic" &&
    config.groundednessEmbeddingModel !== undefined
  ) {
    try {
      const raw: Embedder = new AiSdkEmbedder(
        createEmbeddingProvider(config.groundednessEmbeddingModel, config),
      );
      const cached = maybeCacheEmbedder(raw, {
        enabled: config.embeddingCacheEnabled ?? false,
        maxEntries: config.embeddingCacheMaxEntries ?? 2000,
        ttlSeconds: config.embeddingCacheTtlSeconds ?? 3600,
        logger,
      });
      groundednessEmbedder = cached ?? raw;
      logger.info("Dedicated groundedness embedding model enabled", {
        provider: config.groundednessEmbeddingModel.provider,
        model: config.groundednessEmbeddingModel.model,
      });
    } catch (err) {
      logger.warn(
        "Failed to build dedicated groundedness embedder — falling back to shared embedder",
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  const groundednessGate = createGroundednessGate(
    {
      enabled: config.groundednessEnabled ?? false,
      mode: config.groundednessMode ?? "annotate",
      passThreshold: config.groundednessPassThreshold ?? 0.7,
      groundednessType: config.groundednessType,
      semanticThreshold: config.groundednessSemanticThreshold,
      maxSourceChunks: config.groundednessMaxSourceChunks,
      embedder: groundednessEmbedder,
      llmModel: groundednessLlm,
    },
    logger,
  );

  // ── Tool output injection validator ──────────────────────────────────────
  // Default mode is "redact", not "flag": an in-band warning next to
  // adversarial text is not a reliable defence for a model already
  // susceptible to it. See tool-output-validator.ts for the full reasoning.
  const toolOutputValidator = createToolOutputValidator({
    enabled: config.toolOutputValidatorEnabled ?? false,
    mode: config.toolOutputValidatorMode ?? "redact",
    threshold: config.toolOutputValidatorThreshold ?? 0.7,
    logger,
  });

  return {
    inputGuardrail,
    inputGuardrailClassify,
    outputGuardrail,
    toolEgressGuardrail,
    toolOutputValidator,
    flowGuardrailResolver,
    approvalGate,
    groundednessGate,
  };
}
