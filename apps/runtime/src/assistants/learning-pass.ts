// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Learning pass runner (`src/assistants/learning-pass.ts`)
 *
 * Executes one post-turn learning pass: renders the reviewed turn's transcript, asks
 * a model whether it taught a reusable procedure, and writes at most one proposal.
 *
 * ## The budget is the safety boundary
 *
 * The pass reads a transcript that may contain arbitrary user or tool content,
 * including text engineered to look like a directive. Three things bound what a
 * successful injection can achieve:
 *
 *   - the pass has NO tools at all — it returns a structured object, so there is no
 *     tool call to hijack;
 *   - it may produce at most ONE proposal, enforced here rather than trusted from the
 *     model;
 *   - the proposal is scanned before it can be applied, and applied only under the
 *     assistant's autonomy rules.
 *
 * The prompt also says the transcript is untrusted evidence, but a prompt is a
 * request. These three are the enforcement.
 *
 * ## Why a structured object and not a tool
 *
 * A tool-calling loop would give the pass a mechanism to invoke, and every tool it
 * could reach would need its own gating for this context. `generateObject` gives it
 * exactly one shape to fill and no mechanism at all.
 *
 * No `any` at module boundaries.
 */

import { generateObject, jsonSchema, type LanguageModel } from "ai";
import type { Logger } from "../observability/logger.js";
import type { AssistantRuntime } from "./assistant-runtime.js";
import { decideCaptureDisposition, type ReviewCandidate } from "./experience-review.js";
import {
  buildReviewPrompt,
  isNothingToLearn,
  renderReviewTranscript,
  type ReviewTranscriptMessage,
} from "./review-prompt.js";
import { scanProposal } from "./proposal-scanner.js";
import { SKILL_TRIGGER_MAX_CHARS, SKILL_BODY_MAX_CHARS } from "./types.js";

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

/**
 * What the pass returns.
 *
 * `capture: false` is a first-class outcome and the expected one: most turns teach
 * nothing. Making "nothing" expressible as data rather than as an absent field stops
 * the model from inventing a procedure to satisfy a required shape.
 */
interface ReviewOutput {
  capture: boolean;
  skillName?: string;
  triggerLine?: string;
  body?: string;
  goal?: string;
  evidence?: string;
}

const REVIEW_OUTPUT_SCHEMA = jsonSchema<ReviewOutput>({
  type: "object",
  properties: {
    capture: {
      type: "boolean",
      description:
        "True only when the turn clearly taught a reusable, non-obvious procedure. False otherwise — this is the normal answer.",
    },
    skillName: {
      type: "string",
      description:
        "Short searchable name. Letters, digits, spaces, - and _ only. Required when capture is true.",
    },
    triggerLine: {
      type: "string",
      description: `One line stating WHEN the procedure applies (max ${SKILL_TRIGGER_MAX_CHARS} characters). Required when capture is true.`,
    },
    body: {
      type: "string",
      description: `The self-contained procedure (max ${SKILL_BODY_MAX_CHARS} characters). Required when capture is true.`,
    },
    goal: {
      type: "string",
      description: "What this procedure improves.",
    },
    evidence: {
      type: "string",
      description: "The concrete moment in the trajectory that justifies it.",
    },
  },
  required: ["capture"],
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface LearningPassOptions {
  runtime: AssistantRuntime;
  /**
   * Model the pass runs on.
   *
   * Resolved by the caller from the deployment's utility/default model. A dedicated
   * setting is deliberately not introduced: the pass is a short judgement over a
   * bounded transcript, and the model that already serves the deployment's side tasks
   * is the right one.
   */
  model: LanguageModel;
  /** Loads the reviewed turn's transcript. */
  loadTranscript: (candidate: ReviewCandidate) => Promise<ReviewTranscriptMessage[]>;
  logger?: Logger;
  /** Ceiling on one pass. */
  timeoutMs?: number;
}

/** Default ceiling on one pass. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Builds the runner the scheduler calls.
 *
 * Returns a function rather than a class: the scheduler needs exactly one operation,
 * and a class would invite adding state that outlives a pass.
 */
export function createLearningPassRunner(
  options: LearningPassOptions,
): (candidate: ReviewCandidate) => Promise<void> {
  const { runtime, logger } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (candidate: ReviewCandidate): Promise<void> => {
    const messages = await options.loadTranscript(candidate);
    if (messages.length === 0) {
      // Nothing to review. Marked reviewed so the scheduler does not re-offer a turn
      // whose transcript is gone.
      await runtime.markTurnReviewed(candidate.scope, candidate.executionId);
      return;
    }

    const [existingSkills, pendingProposals] = await Promise.all([
      runtime.stores.skills.listForPrompt(candidate.scope),
      runtime.stores.proposals.list(candidate.scope, { status: "pending" }),
    ]);

    const prompt = buildReviewPrompt({
      transcript: renderReviewTranscript(messages),
      modelIterations: candidate.turn.modelIterations,
      turnAborted: candidate.turn.aborted,
      existingSkills: existingSkills.map((skill) => ({
        name: skill.name,
        triggerLine: skill.triggerLine,
      })),
      pendingProposals: pendingProposals.map((proposal) => ({
        id: proposal.id,
        targetSkill: proposal.targetSkill,
        title: proposal.title,
      })),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();

    let output: ReviewOutput;
    try {
      const result = await generateObject({
        model: options.model,
        schema: REVIEW_OUTPUT_SCHEMA,
        prompt,
        abortSignal: controller.signal,
      });
      output = result.object;
    } catch (err) {
      clearTimeout(timer);
      // The turn is NOT marked reviewed: a provider failure is transient and the
      // evidence is still valid, so the scheduler may retry it.
      logger?.debug("Learning pass model call failed", {
        assistantId: candidate.scope.assistantId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    clearTimeout(timer);

    // Reviewed regardless of the outcome: the pass ran, and re-running it on the same
    // evidence would produce the same answer at the same cost.
    await runtime.markTurnReviewed(candidate.scope, candidate.executionId);

    if (!output.capture) {
      logger?.debug("Learning pass captured nothing", {
        assistantId: candidate.scope.assistantId,
      });
      return;
    }
    // A model that sets `capture: true` without the required fields has not produced
    // a procedure. Treated as "nothing to learn" rather than as an error: the pass is
    // discretionary and a malformed answer is not worth surfacing to anyone.
    const skillName = output.skillName?.trim();
    const triggerLine = output.triggerLine?.trim();
    const body = output.body?.trim();
    if (
      skillName === undefined ||
      skillName.length === 0 ||
      triggerLine === undefined ||
      triggerLine.length === 0 ||
      body === undefined ||
      body.length === 0
    ) {
      logger?.debug("Learning pass returned an incomplete capture", {
        assistantId: candidate.scope.assistantId,
      });
      return;
    }
    // A sentinel inside the body means the model answered in prose despite the
    // structured shape. Honour the sentinel over the flag.
    if (isNothingToLearn(body)) return;

    const existing = existingSkills.find(
      (skill) => skill.name.toLowerCase() === skillName.toLowerCase(),
    );

    let proposalId: string;
    try {
      const proposal = await runtime.stores.proposals.create({
        scope: candidate.scope,
        kind: existing !== undefined ? "update" : "create",
        targetSkill: skillName,
        title: output.goal?.trim().slice(0, 200) ?? skillName,
        triggerLine,
        body,
        ...(output.goal !== undefined ? { goal: output.goal } : {}),
        ...(output.evidence !== undefined ? { evidence: output.evidence } : {}),
        createdBy: "experience-review",
        autonomousCapture: true,
        originExecutionId: candidate.executionId,
        actorType: "agent",
        actorId: candidate.scope.assistantId,
      });
      proposalId = proposal.id;

      // Re-scanned here purely to decide auto-apply. The store already scanned and
      // stored the verdict; reading it back would be a second round trip for a value
      // this function can compute from data it holds.
      const scan = scanProposal({ triggerLine, body });
      const disposition = decideCaptureDisposition({
        autonomy: candidate.autonomy,
        scanClean: scan.state === "clean",
        autonomousCapture: true,
      });

      if (disposition.action === "await-decision") {
        logger?.info("Assistant captured a procedure for review", {
          assistantId: candidate.scope.assistantId,
          skill: skillName,
          reason: disposition.reason,
        });
        return;
      }

      // Auto-apply always goes through a canary: the scan proves the procedure is not
      // dangerous, which is a different claim from it being useful.
      const applied = await runtime.stores.proposals.apply({
        scope: candidate.scope,
        proposalId,
        actorType: "system",
        reason: disposition.reason,
        asCanary: true,
      });
      await runtime.stores.canaries.start({
        scope: candidate.scope,
        skillId: applied.skill.id,
      });
      logger?.info("Assistant learned a procedure (canary)", {
        assistantId: candidate.scope.assistantId,
        skill: applied.skill.name,
      });
    } catch (err) {
      // A refused proposal (pending cap reached, invalid name, oversized body) is a
      // normal outcome of a discretionary pass, not an incident.
      logger?.debug("Learning pass could not record its capture", {
        assistantId: candidate.scope.assistantId,
        skill: skillName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
