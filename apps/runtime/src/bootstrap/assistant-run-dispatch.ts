// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Durable assistant run dispatching (extracted verbatim from index.ts, 18.3).
 *
 * Durable assistant work uses the same public engine entry point as triggers.
 * Bootstrap is built before the engine, so this deliberately closes that cycle
 * only after the final (PII-decorated) engine exists.
 *
 * The execution-admission gate is supplied as a lazy getter: the dispatcher is
 * registered before the admission service is constructed, and the original
 * closure read the not-yet-initialised `let` binding at request time — the
 * getter preserves that late-read semantics exactly.
 */

import type { AssistantRun } from "../assistants/run-store.js";
import {
  REQUEST_NODE_ID,
  RESPONSE_NODE_ID,
  emitBoundaryNode,
} from "../routes/chat/handler.js";
import type { ExecutionAdmissionService } from "../graph/execution-admission.js";
import { requireExecutionAdmission } from "../graph/execution-admission.js";
import type { GraphEngineService } from "../graph/graph-engine.js";
import type { JwtVerifier } from "../middleware/jwt-verifier.js";
import type { MonitoringServiceInterface } from "../monitoring/monitoring-service.js";
import type { Logger } from "../observability/logger.js";
import type { AssistantsResult } from "./assistants.js";

export interface AssistantRunDispatchDeps {
  assistantsResult: AssistantsResult;
  graphEngine: GraphEngineService;
  monitoringService: MonitoringServiceInterface;
  jwtVerifier: JwtVerifier;
  /** Lazy — the admission service is constructed after this registration. */
  getExecutionAdmission: () => ExecutionAdmissionService;
  logger: Logger;
}

function rocketChatProgressMessage(raw: string): string | undefined {
  const toolDetails = Array.from(
    raw.matchAll(
      /<details\b(?=[^>]*\btype=["']tool_calls["'])[^>]*\bname=["']([^"']+)["']/gi,
    ),
  );
  const toolName =
    toolDetails.at(-1)?.[1] ??
    Array.from(raw.matchAll(/🔧\s*Tool:\s*\*\*([^*]+)\*\*/gi)).at(-1)?.[1];
  if (toolName !== undefined) {
    const readable = toolName.split(" · ")[0]?.replaceAll("__", "/").trim();
    if (readable !== undefined && readable.length > 0) {
      return `Working …\n\nQuerying the ${readable} tool …`;
    }
  }
  const structured = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:🧭|📚|⚙️|🧠)\s+/.test(line))
    .at(-1);
  if (structured === undefined) return undefined;
  return `Working …\n\n${structured.slice(0, 240)}`;
}

export function registerAssistantRunDispatcher(
  deps: AssistantRunDispatchDeps,
): void {
  const { assistantsResult, graphEngine, monitoringService, jwtVerifier, logger } =
    deps;
  assistantsResult.setRunDispatcher(async (run: AssistantRun) => {
    const flowId = run.resumePayload.flowId;
    if (typeof flowId !== "string" || flowId.length === 0) {
      throw new Error("Assistant run payload requires a non-empty flowId.");
    }
    const message =
      typeof run.resumePayload.message === "string"
        ? run.resumePayload.message
        : JSON.stringify(run.resumePayload);
    const conversationId =
      typeof run.resumePayload.conversationId === "string"
        ? run.resumePayload.conversationId
        : undefined;
    const runTrigger = run.origin === "schedule" ? "schedule" : "message";
    const userName =
      typeof run.resumePayload.userName === "string" &&
      run.resumePayload.userName.trim().length > 0
        ? run.resumePayload.userName.trim()
        : run.scope.userId;
    const authority = await assistantsResult.resolveRunAuthority({
      scope: run.scope,
      trigger: runTrigger,
      userInitiated: run.origin === "rocket-chat",
    });
    let authorityClaims: Record<string, unknown> | undefined;
    if (authority.token.length > 0) {
      if (!(await jwtVerifier.verify(authority.token))) {
        throw new Error(
          "Resolved assistant authority token failed JWT verification.",
        );
      }
      authorityClaims = jwtVerifier.decodePayload(authority.token) ?? undefined;
      if (authorityClaims === undefined) {
        throw new Error(
          "Resolved assistant authority token has no decodable JWT payload.",
        );
      }
    }
    const responseParts: string[] = [];
    let finalResponse = "";
    const rocketChat =
      run.resumePayload.delivery === "rocket-chat"
        ? assistantsResult.rocketChat
        : undefined;
    let reasoning = "";
    let lastProgress = "";
    let lastProgressAt = 0;
    const boundaryMeta = {
      flowId,
      tenantId: run.scope.tenantId,
    };
    const executionContext = {
      ssoToken: authority.token,
      // Durable assistant runs bypass the HTTP auth middleware. Verify the
      // resolved bearer above and preserve its complete JWT payload so custom
      // permission claims (for example `tools`) can be attested by the signed
      // transaction envelope instead of being reduced to the OAuth response's
      // generic `scope` string.
      ...(authorityClaims !== undefined ? { claims: authorityClaims } : {}),
      executionId: run.id,
      clientId: run.scope.tenantId,
      userId: run.scope.userId,
      userName,
      ...(conversationId !== undefined ? { chatId: conversationId } : {}),
      requestParams: {
        trigger: runTrigger,
        assistant_id: run.scope.assistantId,
        assistant_run_id: run.id,
        ...(conversationId !== undefined
          ? { conversation_id: conversationId }
          : {}),
        ...(authority.notice !== undefined
          ? { authority_notice: authority.notice }
          : {}),
      },
    };
    emitBoundaryNode(monitoringService, run.id, boundaryMeta, {
      nodeId: REQUEST_NODE_ID,
      sequence: 0,
      userName,
      userId: run.scope.userId,
      userPrompt: message.slice(0, 500),
      prompt: JSON.stringify({
        origin: run.origin,
        trigger: runTrigger,
        flowId,
        assistantId: run.scope.assistantId,
        conversationId: conversationId ?? null,
      }),
    });

    try {
      await requireExecutionAdmission(
        deps.getExecutionAdmission(),
        flowId,
        executionContext,
      );
      await graphEngine.executeFlow(
        flowId,
        [{ role: "user", content: message }],
        executionContext,
        async (chunk) => {
          const delta = chunk.choices[0]?.delta;
          if (typeof delta?.content === "string")
            responseParts.push(delta.content);
          if (
            rocketChat !== undefined &&
            typeof delta?.reasoning_content === "string"
          ) {
            reasoning = `${reasoning}${delta.reasoning_content}`.slice(-8_000);
            const progress = rocketChatProgressMessage(reasoning);
            const now = Date.now();
            const reachedBoundary = /[.!?…]\s*$|\n/.test(
              delta.reasoning_content,
            );
            if (
              progress !== undefined &&
              progress !== lastProgress &&
              (reachedBoundary || now - lastProgressAt >= 1_000)
            ) {
              lastProgress = progress;
              lastProgressAt = now;
              try {
                const queued = await rocketChat.outbox.enqueueRunProgress(
                  run,
                  progress,
                );
                if (queued !== undefined) await rocketChat.flushOutbox();
              } catch (error) {
                logger.warn(
                  "Rocket.Chat progress update failed; the durable run continues",
                  {
                    runId: run.id,
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                );
              }
            }
          }
        },
        async () => {},
        monitoringService,
        undefined,
        async (response) => {
          finalResponse = response;
        },
      );
    } catch (error) {
      emitBoundaryNode(monitoringService, run.id, boundaryMeta, {
        nodeId: RESPONSE_NODE_ID,
        hadError: true,
        response: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const streamedResponse = responseParts.join("");
    const responseText =
      streamedResponse.trim().length > 0 ? streamedResponse : finalResponse;
    emitBoundaryNode(monitoringService, run.id, boundaryMeta, {
      nodeId: RESPONSE_NODE_ID,
      response: responseText,
    });
    if (run.resumePayload.delivery === "rocket-chat") {
      if (rocketChat === undefined) {
        throw new Error(
          "Rocket.Chat delivery was requested but the channel is unavailable.",
        );
      }
      const queued = await rocketChat.outbox.enqueueRunResult(
        run,
        responseText,
      );
      if (queued === undefined) {
        throw new Error(
          "Rocket.Chat delivery was requested but no active binding or response was available.",
        );
      }
      try {
        await rocketChat.flushOutbox();
      } catch (error) {
        logger.warn(
          "Immediate Rocket.Chat final delivery failed; durable outbox will retry",
          {
            runId: run.id,
            error:
              error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  });
}
