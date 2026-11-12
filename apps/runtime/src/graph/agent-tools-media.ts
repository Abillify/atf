// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Media tools: image generation and editing through chat or the images API.
 * Split out of `agent-tools.ts` unchanged; that module re-exports the public functions.
 */

import {
  tool,
  jsonSchema,
  generateText,
  generateImage,
  NoImageGeneratedError,
} from "ai";
import type { ImageModelV4 } from "@ai-sdk/provider";
import type {
  ToolSet,
  ToolExecutionOptions,
} from "ai";
import type {
  FlowNode,
  MediaToolConfig,
} from "../types/flow.js";
import { estimateCost } from "../observability/cost.js";
import { createImageProvider, filterLlmParameters } from "./llm-factory.js";
import { decodeBase64Bytes } from "./media-store.js";
import type {
  AgentMediaHooks,
} from "./agent-tools-hooks.js";

/**
 * Default provider options for an image-generation model when a media tool's
 * `llm.parameters.providerOptions` is not set. Google's native image models
 * require `responseModalities: ["IMAGE"]` to emit a file part.
 */
const DEFAULT_IMAGE_PROVIDER_OPTIONS = {
  google: { responseModalities: ["IMAGE"] },
} as const;

/**
 * Max characters per streamed media chunk. A single base64-encoded image
 * easily exceeds aiohttp's 131072-byte per-line limit used by Open WebUI, so
 * the markdown data-URI is split before being emitted as SSE frames; the client
 * concatenates them back into the full image. Matches the native image-gen path.
 */
const MEDIA_SSE_CHUNK_SIZE = 60_000;

/** Hard ceiling on input images one edit call accepts, whatever the flow asks for. */
const MAX_EDIT_INPUT_IMAGES = 4;

/**
 * The model-facing name of the edit tool's image-reference argument. Kept as a
 * constant because the description, the schema, and the execute wrapper all
 * have to agree on it.
 */
const EDIT_IMAGE_ARG = "image";

/**
 * Normalises a media tool's `mode`. Anything other than the two images-API
 * spellings is the historical chat path, so an existing flow keeps its exact
 * pre-existing behaviour when the key is absent.
 */
function mediaToolMode(mt: MediaToolConfig): "chat" | "image" | "edit" {
  if (mt.mode === "image-generation") return "image";
  if (mt.mode === "image-edit") return "edit";
  return "chat";
}

/**
 * Clamp an operator's `maxInputImages` into the range the runtime will honour.
 * A flow cannot raise the ceiling above {@link MAX_EDIT_INPUT_IMAGES}.
 */
function editInputImageLimit(mt: MediaToolConfig): number {
  const requested = mt.maxInputImages;
  if (typeof requested !== "number" || !Number.isFinite(requested)) return 1;
  return Math.max(1, Math.min(MAX_EDIT_INPUT_IMAGES, Math.floor(requested)));
}

/**
 * The valid `config.mediaTools` entries paired with the tool key each one gets.
 *
 * Keys are assigned in declaration order by {@link uniqueMediaToolKey} over the
 * media tools alone, so a repeated `name` becomes `name_2` instead of silently
 * overwriting its twin. {@link buildMediaTools} consumes these keys verbatim —
 * that shared iterator is what lets {@link editMediaToolNames} report the real
 * name a model must call, rather than a guess derived from the flow's YAML.
 */
function* mediaToolEntries(
  node: FlowNode,
): Generator<{ key: string; mt: MediaToolConfig }> {
  const cfg = node.config as { mediaTools?: unknown } | undefined;
  const list = cfg?.mediaTools;
  if (!Array.isArray(list)) return;
  const taken: Record<string, unknown> = {};
  for (const raw of list) {
    if (
      raw === null ||
      typeof raw !== "object" ||
      typeof (raw as MediaToolConfig).name !== "string" ||
      (raw as MediaToolConfig).llm === undefined
    ) {
      continue;
    }
    const mt = raw as MediaToolConfig;
    const key = uniqueMediaToolKey(taken, mt.name);
    taken[key] = {};
    yield { key, mt };
  }
}

/**
 * The tool keys of a node's `mode: image-edit` media tools, in declaration
 * order. The hosting model has to *name* one of these to change a picture it can
 * see, and an image-reference placeholder that advertises a tool which does not
 * exist is worse than no hint at all — so the keys come from the same iterator
 * that builds the tools.
 *
 * Returns `[]` for a node with no edit tool. A node whose edit tool is unusable
 * (no image registry) still returns its keys; the caller decides whether to
 * advertise them.
 */
export function editMediaToolNames(node: FlowNode): string[] {
  const names: string[] = [];
  for (const { key, mt } of mediaToolEntries(node)) {
    if (mediaToolMode(mt) === "edit") names.push(key);
  }
  return names;
}

/**
 * Builds an AI SDK ToolSet from an `llm` node's `config.mediaTools` array.
 *
 * A `chat`-mode tool (the default) exposes a single `prompt` argument; the two
 * images-API modes add what the endpoint needs — see {@link runMediaGeneration}
 * for the wire-level difference. When called, a tool runs its own configured
 * generation model, streams every produced image/media file back to the client
 * via {@link AgentMediaHooks.emit}, and returns a short text confirmation so the
 * hosting model continues the conversation without trying to reproduce the
 * (large) media payload as text.
 *
 * Returns an empty ToolSet when the node declares no media tools.
 */
export function buildMediaTools(
  node: FlowNode,
  media: AgentMediaHooks,
): ToolSet {
  const tools: ToolSet = {};
  for (const { key, mt } of mediaToolEntries(node)) {
    const mode = mediaToolMode(mt);
    const limit = editInputImageLimit(mt);

    // The `prompt` argument is common to every mode; only its wording differs.
    const promptDescription =
      mt.promptDescription ??
      (mode === "edit"
        ? "Die gewünschte Änderung am Bild, so konkret wie möglich (Motiv, Farbe, Text, Stil)."
        : "A detailed description of the media to generate.");

    const properties: Record<string, Record<string, unknown>> = {
      prompt: { type: "string", description: promptDescription },
    };
    const required: string[] = ["prompt"];
    if (mode === "edit") {
      // The reference is OPTIONAL: a vision-capable host model sees the attached
      // picture directly and can edit it by describing the change alone (the
      // runtime then uses the most recent image). A text-only host, or one
      // working from an earlier turn's image, names the `img-N` it was given.
      properties[EDIT_IMAGE_ARG] = {
        type: limit > 1 ? ["string", "array"] : "string",
        ...(limit > 1
          ? { items: { type: "string" }, maxItems: limit }
          : {}),
        description:
          mt.imageDescription ??
          `Optionale Referenz des zu bearbeitenden Bildes im Format "img-N" (auch die gezeigte /v1/media/-URL wird akzeptiert). ${
            limit > 1
              ? `Mehrere Referenzen als Liste (max. ${limit}) werden gemeinsam als Ausgangspunkt verwendet.`
              : "Genau ein Bild."
          } Weglassen, um das zuletzt gezeigte Bild zu bearbeiten.`,
      };
    }

    tools[key] = tool<Record<string, unknown>, unknown, never>({
      description:
        mt.description ??
        (mode === "edit"
          ? `Bearbeitet ein vorhandenes Bild (${mt.llm.model}) anhand einer Textanweisung und zeigt das Ergebnis dem Nutzer direkt an.`
          : mode === "image"
            ? `Generiert ein Bild aus einer Textbeschreibung (${mt.llm.model}) und zeigt es dem Nutzer direkt an.`
            : `Generates media (image/audio/video) from a text prompt using ${mt.llm.model}. The generated media is shown directly to the user.`),
      inputSchema: jsonSchema<Record<string, unknown>>({
        type: "object",
        properties,
        required,
      }),
      execute: async (
        args: Record<string, unknown>,
        opts: ToolExecutionOptions<never>,
      ): Promise<unknown> => {
        const prompt = String(args.prompt ?? "");
        const refs =
          mode === "edit"
            ? (Array.isArray(args[EDIT_IMAGE_ARG])
                ? (args[EDIT_IMAGE_ARG] as unknown[])
                : [args[EDIT_IMAGE_ARG]]
              )
                .map((r) => String(r ?? "").trim())
                .filter((r) => r !== "")
                .slice(0, limit)
            : [];
        await media.onEffectiveArgs?.(
          opts.toolCallId,
          key,
          JSON.stringify(
            mode === "edit" ? { prompt, [EDIT_IMAGE_ARG]: refs } : { prompt },
          ),
        );
        return runMediaGeneration(
          mt,
          mode,
          prompt,
          refs,
          media,
          opts.toolCallId,
        );
      },
    }) as ToolSet[string];
  }
  return tools;
}

/** One produced media file, normalised from either SDK surface. */
interface GeneratedMedia {
  base64: string;
  mediaType: string;
}

/** Token counts as both SDK surfaces report them (either may be absent). */
interface MediaUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** Outcome of the model call, before streaming/cost accounting. */
type MediaCallOutcome =
  | { ok: true; files: GeneratedMedia[]; usage?: MediaUsage; text?: string }
  | { ok: false; result: unknown };

/**
 * Runs a single media-generation call and streams any produced files to the
 * client. Returns a compact, model-facing result describing the outcome — never
 * the raw media bytes (those are streamed separately via {@link AgentMediaHooks.emit}).
 *
 * The model call itself depends on the tool's mode, because the two kinds of
 * generation model cannot be reached through one API:
 *
 *   - `chat`  — `generateText()` on a multimodal chat model that answers with a
 *     file part (Google's image models with `responseModalities: ["IMAGE"]`).
 *   - `image` / `edit` — `generateImage()` on an `ImageModelV4`, i.e. the
 *     OpenAI **images** API. A dedicated image server (mflux behind LiteLLM,
 *     DALL·E, gpt-image) implements only this API — it has no chat route, and a
 *     chat provider never parses image output — so the chat path would return
 *     zero files and the tool would report `no_media` for a request the server
 *     answered perfectly well.
 *
 * Everything after the call (usage/cost accounting, publish-or-inline streaming)
 * is shared, so both paths report identical telemetry and SSE framing.
 */
async function runMediaGeneration(
  mt: MediaToolConfig,
  mode: "chat" | "image" | "edit",
  prompt: string,
  refs: readonly string[],
  media: AgentMediaHooks,
  toolCallId?: string,
): Promise<unknown> {
  const outcome =
    mode === "chat"
      ? await runChatMediaCall(mt, prompt, media)
      : await runImagesApiCall(mt, mode, prompt, refs, media);
  if (!outcome.ok) return outcome.result;

  // Report model + token usage to the monitoring/cost layer so the synthetic
  // generate_image tool node shows which model ran and how many tokens it used.
  if (toolCallId !== undefined) {
    const usage = outcome.usage;
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    media.setGenAiAttributes?.(
      toolCallId,
      { provider: mt.llm.provider, model: mt.llm.model },
      { inputTokens, outputTokens },
    );
    // The call is counted whether or not the server reported tokens: a
    // self-hosted image server (mflux) answers without a `usage` block, and
    // dropping the sample there would make every image generation invisible in
    // the per-model metrics — a regression against the chat path, where the
    // provider always reports usage. Cost stays 0 for a zero-token call, so
    // budget accounting below is unaffected.
    const cost = estimateCost(
      mt.llm.provider,
      mt.llm.model,
      { prompt_tokens: inputTokens, completion_tokens: outputTokens },
      media.pricingOverrides ?? media.appConfig.llmPricing,
    );
    media.metrics?.recordLlmCall(
      mt.llm.provider,
      mt.llm.model,
      "ok",
      inputTokens,
      outputTokens,
      cost,
    );
    // A zero-token call costs nothing, so a server without `usage` never
    // reaches spend accounting — only the metrics sample above.
    if (cost > 0) {
      media.costTracker?.record(media.clientId, cost, {
        provider: mt.llm.provider,
        model: mt.llm.model,
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        ...(media.costAttribution ?? {}),
      });
    }
  }

  const files = outcome.files;
  let emitted = 0;
  // Every image this tool produced is also parked as an `img-N` reference, so a
  // follow-up edit call can target it. Without this the model could only edit
  // what the USER attached, and "mach das Bild heller" would have nothing to
  // resolve — the natural generate-then-refine loop would be broken.
  const producedRefs: string[] = [];
  for (const f of files) {
    const mediaType = f.mediaType;
    const base64 = f.base64;
    if (!base64) continue;
    if (media.imageRefs !== undefined && mediaType.startsWith("image/")) {
      const bytes = decodeBase64Bytes(base64);
      if (bytes !== undefined) {
        const ref = media.imageRefs.register(bytes, mediaType);
        if (ref !== undefined) producedRefs.push(ref);
      }
    }
    // Prefer a short media URL — Open WebUI cannot render megabyte-long base64
    // data-URIs (open-webui#16976) and they overflow the SSE line limit. When
    // media serving is not configured, fall back to a chunked inline data-URI.
    const mediaUrl = media.publishMedia?.(base64, mediaType);
    if (mediaUrl !== undefined) {
      const markdown = mediaType.startsWith("image/")
        ? `\n\n![](${mediaUrl})\n\n`
        : `\n\n[media](${mediaUrl})\n\n`;
      try {
        await media.emit(markdown);
      } catch {
        /* client disconnect — stop streaming this media */
      }
      emitted++;
      continue;
    }
    const markdown = mediaType.startsWith("image/")
      ? `\n\n![](data:${mediaType};base64,${base64})\n\n`
      : `\n\n[media](data:${mediaType};base64,${base64})\n\n`;
    for (
      let offset = 0;
      offset < markdown.length;
      offset += MEDIA_SSE_CHUNK_SIZE
    ) {
      try {
        await media.emit(markdown.slice(offset, offset + MEDIA_SSE_CHUNK_SIZE));
      } catch {
        /* client disconnect — stop streaming this media */
      }
    }
    emitted++;
  }

  if (emitted === 0) {
    const text = typeof outcome.text === "string" ? outcome.text : "";
    return {
      status: "no_media",
      message:
        text.length > 0
          ? text
          : "The model did not return any media for this prompt.",
    };
  }

  return {
    status: "ok",
    generated: emitted,
    ...(producedRefs.length > 0 ? { image_refs: producedRefs } : {}),
    message:
      `Generated ${emitted} media file(s) and displayed ${
        emitted === 1 ? "it" : "them"
      } to the user. Do not repeat the media as text or a data URI.` +
      (producedRefs.length > 0
        ? ` To change one of these images, call the image-edit tool with ${
            producedRefs.length === 1
              ? `the reference ${producedRefs[0]}`
              : `one of ${producedRefs.join(", ")}`
          }.`
        : ""),
  };
}

/**
 * The historical path: a multimodal CHAT model that answers a text prompt with
 * a media part. Unchanged in behaviour — extracted so the shared streaming and
 * accounting code below serves both call shapes.
 */
async function runChatMediaCall(
  mt: MediaToolConfig,
  prompt: string,
  media: AgentMediaHooks,
): Promise<MediaCallOutcome> {
  let model: ReturnType<typeof media.llmProviderFactory>;
  try {
    model = media.llmProviderFactory(mt.llm, media.appConfig, media.resolution);
  } catch {
    return {
      ok: false,
      result: {
        isError: true,
        error: "media_provider_error",
        message: "Could not initialise the media model.",
      },
    };
  }

  const params: Parameters<typeof generateText>[0] = { model, prompt };
  const provOpts =
    mt.llm.parameters?.providerOptions ?? DEFAULT_IMAGE_PROVIDER_OPTIONS;
  if (provOpts !== null && typeof provOpts === "object") {
    params.providerOptions = provOpts as unknown as NonNullable<
      (typeof params)["providerOptions"]
    >;
  }
  const mediaParams = filterLlmParameters(
    mt.llm.parameters as Record<string, unknown> | undefined,
    mt.llm.provider,
    mt.llm.model,
  );
  const temperature = mediaParams?.temperature;
  if (typeof temperature === "number") params.temperature = temperature;
  const maxTokens = mediaParams?.maxTokens;
  if (typeof maxTokens === "number") params.maxOutputTokens = maxTokens;
  if (media.signal !== undefined) params.abortSignal = media.signal;

  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText(params);
  } catch {
    return { ok: false, result: mediaGenerationFailure() };
  }

  return {
    ok: true,
    files: (result.files ?? []) as GeneratedMedia[],
    usage: result.usage as MediaUsage | undefined,
    text: result.text,
  };
}

/**
 * The images-API path: `generateImage()` against an `ImageModelV4` from
 * {@link createImageProvider}. The SDK picks the endpoint from the presence of
 * input files — none means `POST /images/generations` (JSON), one or more means
 * `POST /images/edits` (multipart) — which is exactly the split a self-hosted
 * image server implements, so no hand-rolled request building is needed here.
 *
 * Input images come from the run's image-reference registry, never from the
 * model's own context: the model quotes `img-N` and the runtime reads the bytes
 * back. That keeps a multi-megabyte payload out of the hosting model's prompt
 * and makes an edit request reference the *actual* picture rather than a
 * paraphrase of it. A reference the registry does not know is reported as
 * `unknown_image` with the live references listed, mirroring `inspect_image`.
 */
async function runImagesApiCall(
  mt: MediaToolConfig,
  mode: "image" | "edit",
  prompt: string,
  refs: readonly string[],
  media: AgentMediaHooks,
): Promise<MediaCallOutcome> {
  // An edit without a registry can never succeed: there is nothing to resolve
  // `img-N` against. Fail closed and say why, rather than quietly degrading to
  // a text-to-image call the user did not ask for.
  if (mode === "edit" && media.imageRefs === undefined) {
    return {
      ok: false,
      result: {
        isError: true,
        error: "media_input_unavailable",
        message:
          "Image editing is not available in this run: no image store is configured, " +
          "so image references cannot be resolved.",
      },
    };
  }

  let model: ImageModelV4;
  try {
    // Same key precedence as the chat factory's BYOK wrapper: a per-request
    // bring-your-own-key for this provider wins, then an explicit pool key.
    const byokKey = media.resolution?.providerKeyOverrides?.[mt.llm.provider];
    const apiKey = byokKey ?? media.resolution?.apiKey;
    const build = media.imageProviderFactory ?? createImageProvider;
    model = build(mt.llm, media.appConfig, {
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
  } catch (err) {
    // A protocol without an images endpoint is a configuration mistake, not a
    // transient failure — name the offending provider so the operator fixes the
    // flow instead of retrying the prompt. Anything else stays opaque (the
    // error may carry an endpoint or credential).
    const message = err instanceof Error ? err.message : "";
    const unsupported = message.includes("images endpoint");
    return {
      ok: false,
      result: unsupported
        ? {
            isError: true,
            error: "media_mode_unsupported",
            message: `This media tool cannot use the configured provider: ${message}`,
          }
        : {
            isError: true,
            error: "media_provider_error",
            message: "Could not initialise the media model.",
          },
    };
  }

  // Resolve the edit input before spending a generation slot on it.
  let images: { data: Uint8Array; mediaType: string }[] = [];
  if (mode === "edit") {
    const registry = media.imageRefs;
    if (registry === undefined)
      return { ok: false, result: mediaGenerationFailure() };
    // No reference named: use the most recently registered image. A
    // vision-capable host model can see the picture the user just attached and
    // reasonably expects "mache das Logo größer" to apply to it without having
    // to quote a handle it was never given. The registry lists refs in
    // registration order, so the last one is the newest.
    let wanted = refs;
    if (wanted.length === 0) {
      const live = registry.list();
      const newest = live[live.length - 1];
      if (newest === undefined) {
        return {
          ok: false,
          result: {
            status: "no_image_available",
            message:
              "Es ist noch kein Bild in diesem Gespräch vorhanden. Bitte zuerst eines generieren oder anhängen.",
          },
        };
      }
      wanted = [newest.ref];
    }
    const resolved: { data: Uint8Array; mediaType: string }[] = [];
    const unknown: string[] = [];
    for (const ref of wanted) {
      const stored = registry.resolve(ref);
      if (stored === undefined) unknown.push(ref);
      else resolved.push(stored);
    }
    if (unknown.length > 0) {
      const live = registry.list();
      return {
        ok: false,
        result: {
          status: "unknown_image",
          message:
            `Unknown image reference(s): ${unknown.join(", ")}. ` +
            (live.length > 0
              ? `Available: ${live.map((r) => r.ref).join(", ")}.`
              : "No image is available in this conversation yet — ask the user to attach one."),
        },
      };
    }
    images = resolved;
  }

  const size = parseMediaSize(mt.defaultSize);
  let result: Awaited<ReturnType<typeof generateImage>>;
  try {
    result = await generateImage({
      model,
      prompt:
        mode === "edit"
          ? { images: images.map((i) => i.data), text: prompt }
          : prompt,
      ...(size !== undefined ? { size } : {}),
      ...(media.signal !== undefined ? { abortSignal: media.signal } : {}),
    });
  } catch (err) {
    // A server that answered successfully with zero images (a safety rejection,
    // or an unparseable answer) surfaces as `NoImageGeneratedError`, not an
    // empty result. That is a definitive "nothing here", not a transport
    // failure: reporting it as `media_generation_failed` invites the hosting
    // model to retry the same prompt indefinitely.
    if (NoImageGeneratedError.isInstance(err)) {
      return {
        ok: false,
        result: {
          status: "no_media",
          message:
            "The image model returned no image for this prompt. Rephrase it or " +
            "tell the user it could not be generated.",
        },
      };
    }
    return { ok: false, result: mediaGenerationFailure() };
  }

  return {
    ok: true,
    files: result.images.map((img) => ({
      base64: img.base64,
      mediaType: img.mediaType,
    })),
    usage: result.usage as MediaUsage | undefined,
  };
}

/** The shared opaque failure for a failed generation call. */
function mediaGenerationFailure(): Record<string, unknown> {
  return {
    isError: true,
    error: "media_generation_failed",
    message: "Media generation failed.",
  };
}

/**
 * Validate an operator-configured `WxH` size. Returns `undefined` for anything
 * malformed so a typo in a flow degrades to the server's own default instead of
 * sending a body the endpoint rejects.
 */
function parseMediaSize(
  value: string | undefined,
): `${number}x${number}` | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(\d{2,5})\s*[xX*]\s*(\d{2,5})$/.exec(value.trim());
  if (m === null) return undefined;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 64 || h < 64) {
    return undefined;
  }
  return `${w}x${h}`;
}

/**
 * Produces a deterministic, AI-SDK-valid (`^[A-Za-z0-9_-]{1,64}$`) key for a
 * media tool from its configured name, disambiguating collisions with a numeric
 * suffix. Exported for unit testing.
 */
export function uniqueMediaToolKey(
  existing: Record<string, unknown>,
  name: string,
): string {
  const base =
    name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "media_tool";
  if (existing[base] === undefined) return base;
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const candidate = base.slice(0, 64 - suffix.length) + suffix;
    if (existing[candidate] === undefined) return candidate;
  }
}
