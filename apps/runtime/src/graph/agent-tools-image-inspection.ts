// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The `inspect_image` tool: a vision sub-model answers questions about one parked image.
 * Split out of `agent-tools.ts` unchanged; that module re-exports the public functions.
 */

import {
  tool,
  jsonSchema,
  generateText,
} from "ai";
import type {
  ToolSet,
  ToolExecutionOptions,
} from "ai";
import type {
  ImageInspectionConfig,
} from "../types/flow.js";
import { estimateCost } from "../observability/cost.js";
import { filterLlmParameters } from "./llm-factory.js";
import {
  IMAGE_INSPECTION_TOOL_NAME,
  parseAssetReference,
} from "./image-reference.js";
import type {
  AgentImageInspectionHooks,
} from "./agent-tools-hooks.js";
import {
  uniqueMediaToolKey,
} from "./agent-tools-media.js";

/** Caps the vision answer so one inspection cannot bloat the hosting prompt. */
const DEFAULT_IMAGE_ANSWER_CHARS = 4_000;

/**
 * Builds the `inspect_image` tool for an `llm` node that declares
 * `config.imageInspection`. The node's config block is passed in through
 * {@link AgentImageInspectionHooks.config} — one source of truth, so a caller
 * cannot accidentally enable the tool with one copy of the settings and describe
 * it from another. Returns an empty ToolSet when the block has no `llm`, so a
 * node that does not opt in is completely unaffected.
 */
export function buildImageInspectionTools(
  hooks: AgentImageInspectionHooks,
): ToolSet {
  const cfg = hooks.config as ImageInspectionConfig | undefined;
  if (cfg === null || typeof cfg !== "object" || cfg.llm === undefined) {
    return {};
  }
  const key = uniqueMediaToolKey(
    (hooks.existingTools ?? {}) as Record<string, unknown>,
    IMAGE_INSPECTION_TOOL_NAME,
  );
  const tools: ToolSet = {};
  tools[key] = tool<{ image: string; question: string }, unknown, never>({
    // No list of "currently available" references here: this description is
    // rendered once when the tool set is assembled, which happens BEFORE the
    // prompt's inline images are offloaded, so any such list would be empty (or
    // worse, stale). Each offloaded image names its own reference in place, and
    // an unresolvable reference reports the live list from inside the tool.
    description:
      hooks.config.description ??
      `Inspects an image you cannot see yourself, using a vision model, and ` +
      `returns a factual description answering your question about it. Two ` +
      `kinds of reference are accepted: an inline image parked in this ` +
      `conversation, which appears as an [image ref=img-N …] line — pass that ` +
      `img-N reference exactly as shown; or a stored document asset, referenced ` +
      `as asset:<id> (from a search hit, list_figures or follow_ref), optionally ` +
      `with a normalised bounding box asset:<id>#x0,y0,x1,y1 (each 0..1) to zoom ` +
      `into a region of it.`,
    inputSchema: jsonSchema<{ image: string; question: string }>({
      type: "object",
      properties: {
        image: {
          type: "string",
          description:
            hooks.config.imageDescription ??
            'The image to inspect: an inline reference like "img-1", or a ' +
            'document asset like "asset:<id>" (optionally with a region zoom, ' +
            '"asset:<id>#x0,y0,x1,y1" where each coordinate is between 0 and 1).',
        },
        question: {
          type: "string",
          description:
            "What to look for in the image. Be specific — one focused question " +
            "per call yields a more reliable answer.",
        },
      },
      required: ["image", "question"],
    }),
    execute: async (
      args: { image: string; question: string },
      opts: ToolExecutionOptions<never>,
    ): Promise<unknown> => {
      const image = String(args?.image ?? "");
      const question = String(args?.question ?? "");
      await hooks.onEffectiveArgs?.(
        opts.toolCallId,
        key,
        JSON.stringify({ image, question }),
      );
      return runImageInspection(hooks, image, question, opts.toolCallId);
    },
  }) as ToolSet[string];
  return tools;
}

/**
 * Resolves one image reference and asks the configured vision model about it.
 * Returns a compact, model-facing result — the bytes themselves never go back
 * into the hosting model's context.
 */
async function runImageInspection(
  hooks: AgentImageInspectionHooks,
  image: string,
  question: string,
  toolCallId?: string,
): Promise<unknown> {
  // Resolution order:
  //   1. An already-parked reference (`img-N` or a raw store id) — the inline
  //      image path, unchanged.
  //   2. Failing that, an `asset:<id>[#bbox]` reference (Req 16.3) — fetch the
  //      asset bytes via the engine-wired `get_asset` hook, park them in the
  //      registry as a fresh `img-N`, and inspect that. The `#bbox` becomes the
  //      `region` zoom. Any resolution problem fails closed as `unknown_image`.
  // The `asset:` scheme is checked BEFORE reporting an unknown reference so a
  // malformed asset ref reports a distinct, actionable error.
  let stored = hooks.registry.resolve(image);
  if (stored === undefined) {
    const assetParse = parseAssetReference(image);
    if (assetParse !== undefined) {
      if (!assetParse.ok) {
        return {
          status: "invalid_request",
          message:
            'Malformed asset reference. Use "asset:<id>" or ' +
            '"asset:<id>#x0,y0,x1,y1" where each coordinate is a number ' +
            "between 0 and 1 with x0<x1 and y0<y1.",
        };
      }
      if (hooks.fetchAsset === undefined) {
        return {
          status: "unknown_image",
          message:
            "Document assets cannot be inspected in this run. " +
            "Attach an image to the conversation and reference it as img-N instead.",
        };
      }
      let fetched: { bytes: Uint8Array; mediaType: string } | undefined;
      try {
        fetched = await hooks.fetchAsset(assetParse.ref.assetId, {
          ...(assetParse.ref.region !== undefined
            ? { region: assetParse.ref.region }
            : {}),
        });
      } catch {
        // Fail closed: never surface the fetch error's cause to the model, and
        // never crash the tool call. Treat it exactly like an unavailable asset.
        fetched = undefined;
      }
      if (fetched === undefined) {
        return {
          status: "unknown_image",
          message:
            "The requested document asset is not available or not authorized.",
        };
      }
      const parkedRef = hooks.registry.register(fetched.bytes, fetched.mediaType);
      if (parkedRef === undefined) {
        return {
          status: "unknown_image",
          message:
            "The requested document asset could not be prepared for inspection.",
        };
      }
      stored = hooks.registry.resolve(parkedRef);
    }
  }
  if (stored === undefined) {
    const available = hooks.registry.list().map((info) => info.ref);
    return {
      status: "unknown_image",
      message:
        "The requested image is not available in this run. " +
        (available.length > 0
          ? `Available references: ${available.join(", ")}.`
          : "No images have been attached to this conversation."),
    };
  }
  if (question.trim() === "") {
    return {
      status: "invalid_request",
      message: 'The "question" argument must not be empty.',
    };
  }

  const recordError = (code: string, message: string): void => {
    hooks.metrics?.recordLlmCall(
      hooks.config.llm.provider,
      hooks.config.llm.model,
      "error",
      0,
      0,
      0,
    );
    if (toolCallId !== undefined) {
      hooks.setGenAiAttributes?.(toolCallId, {
        provider: hooks.config.llm.provider,
        model: hooks.config.llm.model,
      });
    }
    if (hooks.nodeId !== undefined) {
      hooks.onNodeDiagnostic?.(hooks.nodeId, { level: "error", code, message });
    }
  };

  let model: ReturnType<typeof hooks.llmProviderFactory>;
  try {
    model = hooks.llmProviderFactory(
      hooks.config.llm,
      hooks.appConfig,
      hooks.resolution,
    );
  } catch {
    const message = "Could not initialise the vision model.";
    recordError("image_inspection_provider_error", message);
    return {
      isError: true,
      status: "vision_provider_error",
      message,
    };
  }

  const dataUrl = `data:${stored.mediaType};base64,${Buffer.from(
    stored.data,
  ).toString("base64")}`;
  const params: Parameters<typeof generateText>[0] = {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Answer the following question about the attached image, ` +
              `strictly from what is visible in it. If the answer is not ` +
              `visible, say so.\n\nQuestion: ${question}`,
          },
          { type: "file", data: new URL(dataUrl), mediaType: stored.mediaType },
        ],
      },
    ],
  };
  const visionParams = filterLlmParameters(
    hooks.config.llm.parameters as Record<string, unknown> | undefined,
    hooks.config.llm.provider,
    hooks.config.llm.model,
  );
  if (typeof visionParams?.temperature === "number") {
    params.temperature = visionParams.temperature;
  }
  if (typeof visionParams?.maxTokens === "number") {
    params.maxOutputTokens = visionParams.maxTokens;
  }
  if (hooks.signal !== undefined) params.abortSignal = hooks.signal;

  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText(params);
  } catch {
    const message = "Vision inspection failed.";
    recordError("image_inspection_call_failed", message);
    return {
      isError: true,
      status: "vision_call_failed",
      message,
    };
  }

  // Report the vision call to the monitoring/cost layer under the tool-call id,
  // exactly as the media-generation path does, so the spend is visible rather
  // than hidden inside a tool result.
  const usage = result.usage;
  if (toolCallId !== undefined) {
    hooks.setGenAiAttributes?.(
      toolCallId,
      { provider: hooks.config.llm.provider, model: hooks.config.llm.model },
      {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
      },
    );
  }
  if (usage !== undefined) {
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    if (hooks.usage !== undefined) {
      hooks.usage.promptTokens += inputTokens;
      hooks.usage.completionTokens += outputTokens;
      hooks.usage.totalTokens += inputTokens + outputTokens;
    }
    hooks.executionBudget?.addTokens(inputTokens + outputTokens);
    const cost = estimateCost(
      hooks.config.llm.provider,
      hooks.config.llm.model,
      {
        prompt_tokens: usage.inputTokens ?? 0,
        completion_tokens: usage.outputTokens ?? 0,
      },
      hooks.pricingOverrides ?? hooks.appConfig.llmPricing,
    );
    hooks.metrics?.recordLlmCall(
      hooks.config.llm.provider,
      hooks.config.llm.model,
      "ok",
      usage.inputTokens ?? 0,
      usage.outputTokens ?? 0,
      cost,
    );
    if (cost > 0) {
      if (hooks.usage !== undefined) {
        hooks.usage.costUsd = (hooks.usage.costUsd ?? 0) + cost;
      }
      hooks.costTracker?.record(hooks.clientId, cost, {
        provider: hooks.config.llm.provider,
        model: hooks.config.llm.model,
        promptTokens: usage.inputTokens ?? 0,
        completionTokens: usage.outputTokens ?? 0,
        ...(hooks.costAttribution ?? {}),
      });
    }
  }

  const cap =
    typeof hooks.config.maxAnswerChars === "number" &&
    hooks.config.maxAnswerChars > 0
      ? Math.floor(hooks.config.maxAnswerChars)
      : DEFAULT_IMAGE_ANSWER_CHARS;
  const answer = typeof result.text === "string" ? result.text.trim() : "";
  if (answer === "") {
    return {
      status: "no_answer",
      image,
      message: "The vision model returned no description for this image.",
    };
  }
  return {
    status: "ok",
    image,
    description: answer.length > cap ? `${answer.slice(0, cap)}…` : answer,
  };
}
