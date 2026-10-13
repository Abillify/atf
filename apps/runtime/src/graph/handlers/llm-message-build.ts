// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Prompt/message assembly for the `llm` node handler.
 *
 * Extracted verbatim from `llm.ts` (task 18.1, Req 13.6) — behaviour is
 * unchanged. Builds the model-facing message array: RAG masking, assistant
 * context frames, history trimming/compression, tool-result budgeting, MCP
 * instructions, volatile guidance, the system prompt, and inline-image
 * offloading.
 */
import type { ModelMessage } from "ai";
import type { FlowNode, LlmConfig } from "../../types/flow.js";
import {
  isAssistantContextFrame,
  stripLeakedContextEcho,
} from "../../assistants/context-frame.js";
import type { ExecRuntime } from "../exec-runtime.js";
import {
  sanitizeSystemMessages,
  ensureValidConversationStart,
  ensureTrailingUserTurn,
  resolveTurnContext,
  deduplicateRagContext,
  isRagContextMessage,
  maskRagContextForModel,
  trimConversationHistory,
  dedupeGuidanceListLines,
  attachVolatileGuidance,
} from "../exec-runtime.js";
import type { AgentState } from "../graph-engine.js";
import type { resolveNodeConfig } from "../graph-engine/node-config.js";
import { buildClassificationNamespaces } from "../classification-access.js";
import {
  baseMessagesToModelMessages,
  coreMessagesToText,
} from "../message-mapping.js";
import { modelKey as modelKeyOf } from "../cost-router.js";
import {
  offloadInlineImages,
  inlineImageBytes,
  IMAGE_INSPECTION_TOOL_NAME,
} from "../image-reference.js";
import {
  measureContextPressure,
} from "../context-window.js";
import {
  compressHistory,
  dedupeRepeatedToolResults,
  effectiveThresholdRatio,
} from "../history-compression.js";
import { createHistorySummarizer } from "../history-summarizer.js";
import { applyToolResultBudget } from "../tool-result-budget.js";
import {
  promptPrefixTracker,
  streamKey,
} from "../prompt-prefix-stability.js";
import { PROMPT_INLINE_IMAGE_WARN_BYTES } from "./llm-history-copy.js";
import type { setupLlmTools } from "./llm-tool-setup.js";

type ToolSetupResult = Awaited<ReturnType<typeof setupLlmTools>>;

/**
 * Assembles the prompt (system prompt + conversation history) sent to the
 * model for one `llm` node execution.
 */
export async function buildLlmMessages(params: {
  runtime: ExecRuntime;
  node: FlowNode;
  state: AgentState;
  resolved: ReturnType<typeof resolveNodeConfig>;
  llmConfig: LlmConfig;
  maxTokens: number | undefined;
  toolResultBudget: { perResultChars: number; perTurnChars: number };
  tools: Pick<
    ToolSetupResult,
    | "assistantSessionBinding"
    | "unavailableTools"
    | "toolKeyByRef"
    | "activeToolKeys"
    | "imageInspectionEnabled"
    | "imageInspectionToolName"
  >;
}): Promise<{ messagesWithSystemPrompt: ModelMessage[] }> {
  const {
    runtime,
    node,
    state,
    resolved,
    llmConfig,
    maxTokens,
    toolResultBudget,
  } = params;
  const {
    assistantSessionBinding,
    unavailableTools,
    toolKeyByRef,
    activeToolKeys,
    imageInspectionEnabled,
    imageInspectionToolName,
  } = params.tools;
  const dropRagContext =
    (node.config as { dropRagContext?: boolean } | undefined)
      ?.dropRagContext === true;
  const groundedMessages = dropRagContext
    ? state.messages.filter((m) => {
        if (m._getType() !== "system") return true;
        const c = (m as { content?: unknown }).content;
        return !(typeof c === "string" && isRagContextMessage(c));
      })
    : state.messages;
  // Ref-handle opt-in (config.refHandles): the tool node registered the
  // grounding references; swap them for short handles on the MODEL-FACING
  // copy only. The grounding header advertises `(Ref: ...)` as the
  // get_document argument, and a small model truncates those long paths
  // (trace 55c5b138) — a 4-char handle it can copy verbatim cannot. The
  // persisted state keeps the real references, so history, client citations
  // and audit surfaces are unaffected; resolution maps the handle back
  // before every tool call.
  const modelFacingMessages =
    runtime.refHandles !== undefined &&
    (node.config as { refHandles?: unknown } | undefined)?.refHandles === true
      ? maskRagContextForModel(groundedMessages, runtime.refHandles)
      : groundedMessages;
  const rawModelMessages = baseMessagesToModelMessages(
    deduplicateRagContext(modelFacingMessages),
  );

  // `assistant-context` runs after the human turn and therefore emits a
  // non-leading SystemMessage. `sanitizeSystemMessages` must normally fold
  // such messages into an adjacent provider-valid user turn, but doing that
  // to the assistant's own identity made Qwen interpret "Name: Assistant1" as the
  // user's identity and echo the block on every response. Extract this
  // explicitly framed block before generic sanitization and merge it into the
  // one leading system message below.
  const assistantContextBlocks: string[] = [];
  const promptHistory = rawModelMessages.flatMap((message) => {
    if (
      message.role === "system" &&
      typeof message.content === "string" &&
      isAssistantContextFrame(message.content)
    ) {
      assistantContextBlocks.push(message.content.trim());
      return [];
    }

    // Existing LangGraph checkpoints may already contain prompt echoes as
    // assistant turns, or as user turns polluted by an old retry/context
    // fold. Clean only the model-facing copy; durable audit history remains
    // byte-for-byte intact. The transform is idempotent.
    if (
      (message.role === "assistant" || message.role === "user") &&
      typeof message.content === "string"
    ) {
      const content = stripLeakedContextEcho(message.content);
      return [{ ...message, content } as ModelMessage];
    }
    return [message];
  });
  const sanitized = sanitizeSystemMessages(promptHistory);
  const maxHistoryTurns = (
    node.config as { maxHistoryTurns?: number } | undefined
  )?.maxHistoryTurns;
  const trimmed =
    maxHistoryTurns !== undefined && maxHistoryTurns > 0
      ? trimConversationHistory(sanitized, maxHistoryTurns)
      : sanitized;

  // ── History compression ────────────────────────────────────────────────
  // Runs BEFORE the system prompt is prepended, so compaction only ever
  // touches conversation turns and can never rewrite the cacheable system
  // prefix. Applied here (at prompt assembly) rather than in state because
  // `AgentStateAnnotation.messages` has an append-only reducer — a node cannot
  // replace history. The summary is cached per (conversation, node) and keyed
  // by a fingerprint of the range it covers, so an unchanged range re-emits
  // identical bytes and the prompt prefix survives across turns.
  //
  // Stage 1 (identical-tool-result dedup) is deterministic and free, so it
  // runs on every request; the summarising stage only engages over the
  // trigger and requires a known context window.
  const compressionCfg = (
    node.config as
      | {
          historyCompression?: {
            enabled?: boolean;
            thresholdRatio?: number;
            llm?: LlmConfig;
          };
        }
      | undefined
  )?.historyCompression;
  let compressedMessages = trimmed;
  if (compressionCfg?.enabled === true) {
    const summarizerLlm = compressionCfg.llm ?? llmConfig;
    const pressure = measureContextPressure(trimmed, llmConfig, maxTokens);
    const result = await compressHistory(trimmed, {
      key: `${runtime.ctx.chatId ?? "-"}::${node.id}`,
      ...(pressure.inputBudget !== undefined
        ? { inputBudget: pressure.inputBudget }
        : {}),
      thresholdRatio: effectiveThresholdRatio(
        pressure.contextLength,
        compressionCfg.thresholdRatio,
      ),
      summarize: createHistorySummarizer(runtime, summarizerLlm, node.id),
    });
    compressedMessages = result.messages;

    if (result.dedupe.collapsed > 0) {
      runtime.metrics.recordCounter(
        "aiperator_history_dedupe_total",
        { node: node.id },
        result.dedupe.collapsed,
      );
    }
    if (result.summarized) {
      runtime.metrics.recordCounter("aiperator_history_compaction_total", {
        node: node.id,
        source: result.summaryFromCache ? "cache" : "generated",
      });

      // Persist a newly generated summary as immutable session provenance. The
      // prompt transform remains fail-open, while the snapshot makes the exact
      // compacted bytes inspectable and reusable after a process restart.
      if (
        !result.summaryFromCache &&
        result.summary !== undefined &&
        assistantSessionBinding !== undefined
      ) {
        const sessionStore = runtime.assistants?.stores.sessionStore;
        if (sessionStore !== undefined) {
          try {
            const transcript = await sessionStore.read(
              assistantSessionBinding.scope,
              assistantSessionBinding.conversationId,
              1_000,
            );
            const localEntries = transcript.filter(
              (entry) =>
                entry.conversationId ===
                  assistantSessionBinding.conversationId &&
                entry.sequence !== undefined,
            );
            const first = localEntries[0];
            const latest = localEntries.at(-1);
            if (
              first?.sequence !== undefined &&
              latest?.sequence !== undefined
            ) {
              const snapshot = await sessionStore.createSnapshot({
                scope: assistantSessionBinding.scope,
                conversationId: assistantSessionBinding.conversationId,
                sequence: latest.sequence,
                kind: "summary",
                content: result.summary,
                // Prompt transformations (sanitization, trimming and tool-result
                // dedupe) currently do not preserve event IDs. Do not claim
                // sequence-exact provenance until that mapping exists.
              });
              if (runtime.ctx.ssoToken !== "") {
                try {
                  await runtime.assistants?.indexSessionDocument({
                    scope: assistantSessionBinding.scope,
                    conversationId: assistantSessionBinding.conversationId,
                    documentId: snapshot.id,
                    content: snapshot.content,
                    kind: "snapshot",
                    sequence: snapshot.sequence,
                    token: runtime.ctx.ssoToken,
                  });
                } catch {
                  runtime.onNodeDiagnostic?.(node.id, {
                    level: "warn",
                    code: "history_snapshot_index_failed",
                    message:
                      "The durable history snapshot was stored, but its Vectorsearch projection failed.",
                  });
                }
              }
            }
          } catch {
            runtime.onNodeDiagnostic?.(node.id, {
              level: "warn",
              code: "history_snapshot_persist_failed",
              message:
                "History compaction succeeded, but its durable session snapshot could not be persisted.",
            });
          }
        }
      }
    } else if (result.skipped !== undefined) {
      runtime.metrics.recordCounter("aiperator_history_compaction_skipped", {
        node: node.id,
        reason: result.skipped,
      });
    }
  } else {
    // Even with compaction disabled, the deterministic pre-pass is worth
    // running: collapsing byte-identical repeated tool results removes only
    // content the model has already been shown in that exact form, needs no
    // model call, and is idempotent — so it cannot cost anything or shift the
    // prompt prefix between turns.
    const deduped = dedupeRepeatedToolResults(trimmed);
    compressedMessages = deduped.messages;
    if (deduped.stats.collapsed > 0) {
      runtime.metrics.recordCounter(
        "aiperator_history_dedupe_total",
        { node: node.id },
        deduped.stats.collapsed,
      );
    }
  }

  // Bound tool output that arrived in the INCOMING history, not just output
  // this node produces. Two paths feed oversized results into a prompt:
  // (a) the agent loop, handled in `prepareStep` below, and (b) history — an
  // OpenAI-compatible client legitimately replays `role: "tool"` messages, and
  // a checkpointed thread carries the ones earlier turns produced. Without this
  // pass a single huge inbound tool result can exceed the window before the
  // loop even starts. Deterministic and idempotent, so re-capping content that
  // was already capped on a previous turn is a no-op and the prefix holds.
  const historyBudgeted = applyToolResultBudget(
    compressedMessages,
    toolResultBudget,
  );
  if (historyBudgeted.stats.charsSaved > 0) {
    runtime.metrics.recordCounter(
      "aiperator_tool_result_chars_saved_total",
      { node: node.id, stage: "inbound" },
      historyBudgeted.stats.charsSaved,
    );
  }

  const validStart = ensureValidConversationStart(historyBudgeted.messages);

  // A prompt that ENDS on an assistant turn asks the model to open a second
  // consecutive assistant turn, which local Qwen builds answer with an
  // immediate end token — an empty completion on every attempt and every
  // fallback candidate. See `ensureTrailingUserTurn` for the full mechanism.
  // Opt out with `config.allowTrailingAssistantTurn: true` for a node that
  // genuinely wants the model to continue its own last message.
  const allowTrailingAssistantTurn =
    (node.config as { allowTrailingAssistantTurn?: boolean } | undefined)
      ?.allowTrailingAssistantTurn === true;
  const trailingTurn = allowTrailingAssistantTurn
    ? { messages: validStart, appended: false }
    : ensureTrailingUserTurn(validStart);
  if (trailingTurn.appended) {
    runtime.onNodeDiagnostic?.(node.id, {
      level: "info",
      code: "prompt_trailing_assistant_turn",
      message:
        "The assembled prompt ended on an assistant turn (engine-injected " +
        "context); appended a short user turn so the model has a turn " +
        "boundary to answer at.",
      details: { message_count: validStart.length },
    });
  }
  const coreMessages = trailingTurn.messages;

  const unavailableNote =
    unavailableTools.length > 0
      ? "\n\n[System] These tools are currently unavailable and MUST NOT be " +
        "called: " +
        unavailableTools.map((t) => t.split("/").pop()).join(", ") +
        ". If the user's request requires one of them, briefly tell the user " +
        "(in their language) that the function is temporarily unavailable and " +
        "continue with whatever you can do without it."
      : "";
  let instructionsNote = "";
  if (runtime.mcpWrapper !== undefined) {
    const activeServers = new Set<string>();
    if (activeToolKeys !== undefined) {
      for (const [ref, key] of Object.entries(toolKeyByRef)) {
        if (activeToolKeys.has(key)) {
          const server = ref.includes("/") ? (ref.split("/")[0] ?? "") : "";
          if (server !== "") activeServers.add(server);
        }
      }
    } else {
      for (const ref of resolved.tools) {
        const server = ref.includes("/") ? (ref.split("/")[0] ?? "") : "";
        if (server !== "") activeServers.add(server);
      }
    }
    const blocks: string[] = [];
    // Sorted, not insertion-ordered: the iteration order of `toolKeyByRef` /
    // `resolved.tools` is an implementation detail, and semantic tool
    // selection can surface the same SET of servers in a different order from
    // one request to the next. Emitting them in a different order would
    // change these bytes — and therefore break prompt-cache reuse — without
    // any change in meaning.
    for (const server of [...activeServers].sort()) {
      const instr = runtime.mcpWrapper.getInstructions(server);
      if (instr !== undefined && instr.trim() !== "") {
        // Compact repeated entries in list lines (e.g. taiga's duplicated
        // "Known epics") before injecting — this text is re-sent on every
        // agent-loop step, so trimming it saves input tokens per turn.
        blocks.push(
          `### ${server}\n${dedupeGuidanceListLines(instr.trim())}`,
        );
      }
    }
    if (blocks.length > 0) {
      instructionsNote =
        "\n\n[Tool guidance — follow these conventions when calling the " +
        "respective tools]\n" +
        blocks.join("\n\n");
    }
  }

  // Volatile, per-request guidance. Deliberately NOT concatenated onto the
  // system prompt: both notes depend on live MCP server state and on the
  // per-request semantic tool selection, and the system message is message 0 —
  // changing a single byte there re-prefills the entire conversation. It is
  // attached to the last user message below instead (see
  // `attachVolatileGuidance`), which keeps the cacheable prefix byte-stable.
  //
  // `config.turnContext` joins it for the same reason: per-request context
  // derived from untrusted input (e.g. a classifier's image transcription)
  // belongs on the user turn — it keeps the cacheable prefix stable and gives
  // that text no system authority. Omitted entirely when every placeholder it
  // references resolves empty (see `resolveTurnContext`).
  const turnContextText = resolveTurnContext(
    (node.config as { turnContext?: unknown } | undefined)?.turnContext,
    state.context,
    buildClassificationNamespaces(state.turns),
  );
  const volatileGuidance = [
    turnContextText ?? "",
    (instructionsNote + unavailableNote).trim(),
  ]
    .filter((part) => part !== "")
    .join("\n\n");

  // The leading system prompt contains the node's stable instructions plus
  // assistant-owned identity/limits extracted above. Keeping those sections
  // in the system role is a correctness boundary: they must never be parsed
  // as user-authored text. Per-request MCP guidance remains on the newest user
  // turn below for cache locality.
  const currentAssistantContext = assistantContextBlocks.at(-1);
  const effectiveSystemSections = [
    resolved.systemPrompt,
    currentAssistantContext,
  ].filter(
    (section): section is string =>
      typeof section === "string" && section.trim() !== "",
  );
  const effectiveSystemPrompt =
    effectiveSystemSections.length > 0
      ? effectiveSystemSections.join("\n\n")
      : undefined;

  let messagesWithSystemPrompt: ModelMessage[];
  if (effectiveSystemPrompt) {
    const firstCoreMessage = coreMessages[0];
    if (
      firstCoreMessage !== undefined &&
      firstCoreMessage.role === "system"
    ) {
      const existingContent = firstCoreMessage.content;
      const existing =
        typeof existingContent === "string"
          ? existingContent
          : JSON.stringify(existingContent);
      const trimmed = existing.trim();
      const merged =
        trimmed.length > 0 && trimmed !== "User Context:"
          ? `${effectiveSystemPrompt}\n\n${existing}`
          : effectiveSystemPrompt;
      messagesWithSystemPrompt = [
        { role: "system", content: merged } as ModelMessage,
        ...coreMessages.slice(1),
      ];
    } else {
      messagesWithSystemPrompt = [
        { role: "system", content: effectiveSystemPrompt } as ModelMessage,
        ...coreMessages,
      ];
    }
  } else {
    messagesWithSystemPrompt = coreMessages;
  }

  // Attach the volatile guidance to the newest user turn, leaving the system
  // message (and thus the whole cacheable prefix) untouched.
  if (volatileGuidance !== "") {
    const attachment = attachVolatileGuidance(
      messagesWithSystemPrompt,
      volatileGuidance,
    );
    if (attachment.attached) {
      messagesWithSystemPrompt = attachment.messages;
    } else {
      // No user message to attach to (e.g. a system-prompt-only invocation).
      // Correctness wins over cache efficiency: fold the guidance into the
      // system message, or create one, so the model still receives it.
      const first = messagesWithSystemPrompt[0];
      if (first !== undefined && first.role === "system") {
        const existing =
          typeof first.content === "string"
            ? first.content
            : JSON.stringify(first.content);
        messagesWithSystemPrompt = [
          {
            role: "system",
            content: `${existing}\n\n${volatileGuidance}`,
          } as ModelMessage,
          ...messagesWithSystemPrompt.slice(1),
        ];
      } else {
        messagesWithSystemPrompt = [
          { role: "system", content: volatileGuidance } as ModelMessage,
          ...messagesWithSystemPrompt,
        ];
      }
    }
  }

  // ── Inline images → references ────────────────────────────────────────
  // Runs once the prompt is final and before any candidate request is built,
  // so the base64 never reaches the provider (or the prompt-cache key, or the
  // context-window accounting) for a node that opted into reference-based
  // image handling. The bytes live in the run-scoped registry and are reachable
  // again through `inspect_image`; identical images reuse the same `img-N`, so
  // a re-sent attachment does not change the prompt across turns.
  //
  // This also lifts the vision guard: a node that offloads its images sends no
  // image parts at all, so `vision_not_supported` below no longer skips a
  // text-only model that would otherwise reject the whole request.
  //
  // Scope note: what is rewritten here is the *incoming* prompt, including
  // images a tool returned on an earlier turn. A tool result produced later in
  // the SAME provider loop is appended by the SDK itself and goes out with its
  // bytes — the AI SDK exposes no per-step message hook to rewrite it.
  if (imageInspectionEnabled && runtime.imageRefs !== undefined) {
    const offloaded = offloadInlineImages(
      messagesWithSystemPrompt,
      runtime.imageRefs,
      imageInspectionToolName,
    );
    if (offloaded.offloaded > 0) {
      messagesWithSystemPrompt = offloaded.messages;
      runtime.onNodeDiagnostic?.(node.id, {
        level: "info",
        code: "llm_images_offloaded",
        message:
          `Replaced ${offloaded.offloaded} inline image(s) with ` +
          `${IMAGE_INSPECTION_TOOL_NAME} references (${offloaded.refs.join(
            ", ",
          )}), keeping ${offloaded.bytesRemoved} image bytes out of the prompt.`,
        details: {
          offloaded: offloaded.offloaded,
          refs: offloaded.refs,
          bytesRemoved: offloaded.bytesRemoved,
        },
      });
      runtime.metrics.recordCounter(
        "aiperator_image_offload_total",
        { node: node.id },
        offloaded.offloaded,
      );
      runtime.metrics.recordCounter(
        "aiperator_image_offload_bytes_total",
        { node: node.id },
        offloaded.bytesRemoved,
      );
    }
    if (offloaded.unresolved > 0) {
      const message =
        `${offloaded.unresolved} image reference(s) could not be parked because ` +
        "they are remote or otherwise undecodable; refusing to send them to the hosting model.";
      runtime.onNodeDiagnostic?.(node.id, {
        level: "error",
        code: "image_inspection_remote_image_unavailable",
        message,
        details: { unresolved: offloaded.unresolved },
      });
      throw new Error("IMAGE_INSPECTION_REMOTE_IMAGE_UNAVAILABLE");
    }
  }

  // Prompt-size guard for images that are *still* inline: a node without
  // `config.imageInspection` (or a remote image URL that cannot be parked)
  // sends those bytes to the provider on every single turn, which is both a
  // cost and a context-window problem long before it becomes an error. Loudly
  // visible here rather than inferred from a truncated answer.
  const remainingImages = inlineImageBytes(messagesWithSystemPrompt);
  if (remainingImages.totalBytes > PROMPT_INLINE_IMAGE_WARN_BYTES) {
    runtime.onNodeDiagnostic?.(node.id, {
      level: "warn",
      code: "llm_prompt_image_payload_large",
      message:
        `${remainingImages.count} inline image(s) totalling ` +
        `${remainingImages.totalBytes} bytes are part of this prompt. ` +
        "Consider config.imageInspection so images are referenced instead of " +
        "re-sent on every turn.",
      details: {
        images: remainingImages.count,
        totalBytes: remainingImages.totalBytes,
        maxBytes: remainingImages.maxBytes,
      },
    });
  }

  runtime.onNodeIo?.(node.id, {
    prompt: coreMessagesToText(messagesWithSystemPrompt),
  });

  // ── Prompt-prefix stability probe ──────────────────────────────────────
  // Measured on the UNDECORATED message list (before cache_control markers
  // are applied) because those markers are cache metadata, not part of the
  // token stream the caches key on.
  //
  // This is the only prompt-cache signal available for local OpenAI-compatible
  // servers (LM Studio / llama.cpp / vLLM), which reuse a KV cache for a
  // byte-identical prefix but report no `cachedInputTokens`. `appendOnly` is
  // the goal state; a divergence at index 0 means the system prompt is not
  // byte-stable and the whole prompt re-prefills every turn.
  if (llmConfig !== undefined) {
    const prefixReport = promptPrefixTracker.observe(
      streamKey(runtime.ctx.chatId, node.id, modelKeyOf(llmConfig)),
      messagesWithSystemPrompt,
    );
    if (prefixReport !== undefined) {
      runtime.metrics.recordCounter(
        "aiperator_prompt_prefix_observations_total",
        {
          node: node.id,
          model: modelKeyOf(llmConfig),
          shape: prefixReport.appendOnly ? "append_only" : "diverged",
        },
      );
      // Char counters, so a reuse ratio is derivable in PromQL across many
      // observations instead of only per-call.
      if (prefixReport.currentChars > 0) {
        runtime.metrics.recordCounter(
          "aiperator_prompt_prefix_chars_total",
          { node: node.id, model: modelKeyOf(llmConfig), part: "total" },
          prefixReport.currentChars,
        );
      }
      if (prefixReport.stableChars > 0) {
        runtime.metrics.recordCounter(
          "aiperator_prompt_prefix_chars_total",
          { node: node.id, model: modelKeyOf(llmConfig), part: "stable" },
          prefixReport.stableChars,
        );
      }
      // Only a divergence is worth a diagnostic entry — append-only is the
      // expected shape and would flood the timeline.
      if (!prefixReport.appendOnly) {
        runtime.onNodeDiagnostic?.(node.id, {
          level: prefixReport.firstDivergenceIndex === 0 ? "warn" : "info",
          code: "prompt_prefix_diverged",
          message:
            prefixReport.firstDivergenceIndex === 0
              ? "Prompt prefix diverged at the SYSTEM message — the whole " +
                "prompt re-prefills this turn (no prompt/KV cache reuse). " +
                "Something volatile is being injected into the system prompt."
              : `Prompt prefix diverged at message ${prefixReport.firstDivergenceIndex} ` +
                `(role: ${prefixReport.firstDivergenceRole ?? "?"}) — history was ` +
                "rewritten mid-array; everything from that point re-prefills.",
          details: {
            firstDivergenceIndex: prefixReport.firstDivergenceIndex,
            ...(prefixReport.firstDivergenceRole !== undefined
              ? { firstDivergenceRole: prefixReport.firstDivergenceRole }
              : {}),
            stableMessages: prefixReport.stableMessages,
            previousMessages: prefixReport.previousMessages,
            currentMessages: prefixReport.currentMessages,
            reuseRatio: prefixReport.reuseRatio,
          },
        });
      }
    }
  }
  return { messagesWithSystemPrompt };
}
