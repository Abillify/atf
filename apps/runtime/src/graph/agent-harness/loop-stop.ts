// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Harness stop helper (Req 8.1, 8.2, 8.3, 12.4) — extracted verbatim from
 * `loop.ts` (Req 13.6).
 *
 * Every harness exit goes through this helper: it renders the final
 * user-facing messages (real delegated answers when present, otherwise the
 * assembled task summary), attaches coverage completion status, emits the
 * final reasoning/status events, and returns a well-typed
 * `Partial<AgentState>` with a non-error completion.
 *
 * Verification and coverage-ledger state is read through getters because the
 * handler mutates it after the helper is constructed.
 *
 * @module agent-harness/loop-stop
 */

import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage } from "@langchain/core/messages";
import type { FlowNode } from "../../types/flow.js";
import type { Citation, StreamError } from "../../types/openai.js";
import type { AgentState, ExecRuntime } from "../graph-engine.js";
import type {
  CoverageLedger,
  CoverageQueueConfig,
} from "./coverage.js";
import { coverageCompletionStatus } from "./coverage.js";
import {
  assembleResult,
  collapseDuplicateLines,
  messageText,
  statusMessageFor,
} from "./loop-findings.js";
import type {
  HarnessProgress,
  HarnessConfig,
  StopReason,
} from "./types.js";

export interface StopHelperDeps {
  node: FlowNode;
  runtime: ExecRuntime;
  cfg: HarnessConfig;
  emitHarnessStatus: (text: string) => void;
  answerMessages: BaseMessage[];
  contextFindings: string[];
  answerCitations: Citation[];
  verificationActive: boolean;
  getVerificationRounds: () => number;
  getVerified: () => boolean;
  getCoverageLedger: () => CoverageLedger | undefined;
  coverageConfig: CoverageQueueConfig | undefined;
}

/**
 * Builds the handler-local `stop()` helper. The returned function has the
 * same signature as the original inline closure.
 */
export const createStopHelper =
  ({
    node,
    runtime,
    cfg,
    emitHarnessStatus,
    answerMessages,
    contextFindings,
    answerCitations,
    verificationActive,
    getVerificationRounds,
    getVerified,
    getCoverageLedger,
    coverageConfig,
  }: StopHelperDeps) =>
  (
    reason: StopReason,
    prog: HarnessProgress,
    errs: StreamError[],
  ): Partial<AgentState> => {
    prog.stopReason = reason;
    prog.partial = reason !== "completed";
    prog.statusMessage = statusMessageFor(reason);
    const coverageLedger = getCoverageLedger();
    // Only reported when a gate was actually configured, so an absent
    // `verified` field means "not checked" rather than "failed".
    if (verificationActive || cfg.verification?.failClosed === true) {
      prog.verificationRounds = getVerificationRounds();
      prog.verified = getVerified();
    }
    if (coverageLedger !== undefined) prog.coverage = coverageLedger;

    const assembled = assembleResult(prog.tasks);
    const statusNote = `[${prog.statusMessage}]`;
    const summary = prog.partial ? `${statusNote}\n\n${assembled}` : assembled;

    // Prefer the real responder answers as the user-facing message(s). When
    // the run produced no assistant answer (no-tasks / planning-failure /
    // exhausted), fall back to the assembled status summary so the node
    // always yields a non-empty assistant turn. On a partial stop the
    // assembled summary is prepended (Req 8.2: surface completed outcomes +
    // the limit reason) followed by whatever real answers were produced.
    //
    // A harness followed by a synthesizer opts into `resultMode: "context"`:
    // return ONE task-marker-free message so delegated findings cannot become
    // several competing final answers. The default remains backward
    // compatible for harnesses that are themselves user-facing end nodes.
    const findingContext = (
      contextFindings.length > 0
        ? contextFindings
        : answerMessages.map(messageText).filter((text) => text.trim() !== "")
    ).join("\n\n");
    const coverageContext =
      coverageLedger === undefined
        ? ""
        : coverageCompletionStatus(coverageLedger, coverageConfig, {
            partial: prog.partial === true,
            ...(prog.verified !== undefined
              ? { verified: prog.verified }
              : {}),
            ...(prog.stopReason !== undefined
              ? { stopReason: prog.stopReason }
              : {}),
          });
    const contextText = collapseDuplicateLines(
      [findingContext, coverageContext]
        .filter((text) => text !== "")
        .join("\n\n"),
    );
    const finalMessages: BaseMessage[] =
      cfg.resultMode === "context"
        ? [
            new AIMessage(
              contextText.length > 0
                ? prog.partial
                  ? `${statusNote}\n\n${contextText}`
                  : contextText
                : statusNote,
            ),
          ]
        : answerMessages.length > 0
          ? prog.partial
            ? [new AIMessage(summary), ...answerMessages]
            : [...answerMessages]
          : [new AIMessage(summary)];

    // Emit final status via onReasoning (Req 9.4). onNodeIo keeps the status
    // summary for the monitoring dashboard view.
    emitHarnessStatus(
      `--- Harness stopped: ${reason} ---\n${prog.statusMessage}`,
    );
    runtime.onNodeIo?.(node.id, { response: summary });
    // A bounded/verified partial stop is a successful harness completion: its
    // stop reason and coverage gaps are already carried in the structured
    // harness state and in the synthesis context. Marking every partial stop
    // as a node error made the whole flow fail, suppressed onFinalResponse,
    // and contradicted the usable partial answer produced downstream. Only a
    // stop that carries an actual StreamError ends the node as an error.
    runtime.onNodeEnd?.(
      node.id,
      errs.length > 0 ? prog.statusMessage : undefined,
    );

    const result: Partial<AgentState> & { harness?: HarnessProgress } = {
      currentNodeId: node.id,
      messages: finalMessages,
      harness: prog,
      ...(answerCitations.length > 0 ? { citations: answerCitations } : {}),
      ...(errs.length > 0 ? { errors: errs } : {}),
    };
    return result as Partial<AgentState>;
  };
