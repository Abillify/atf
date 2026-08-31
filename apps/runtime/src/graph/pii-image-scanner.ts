// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Multimodal PII handling for the reversible PII vault (ADR-0016).
 *
 * The text vault (`pii-vault.ts`) tokenizes PII in *text* before it reaches an
 * LLM and transparently restores it in the streamed response. That reversible
 * round-trip is impossible for an *image* or *file*: the model consumes pixels,
 * and there is no placeholder we can swap back into a picture after the fact.
 *
 * So for image/file content blocks the vault applies a *one-way* control chosen
 * per deployment (`PII_VAULT_MULTIMODAL_MODE`):
 *
 *   - `off`     — attachments pass through unchanged (legacy behaviour).
 *   - `block`   — attachments are stripped before the prompt reaches the
 *                 provider and replaced with a short text notice. Needs no
 *                 external service: a hard guarantee that no un-scanned pixels
 *                 leave the system (correct default for a regulated flow that
 *                 does not actually need the image).
 *   - `redact`  — each attachment is sent to a configured {@link PiiImageRedactor}
 *                 (e.g. a presidio-image-redactor sidecar) which returns a
 *                 redacted copy; the redacted copy replaces the original so the
 *                 model still gets the visual context minus the PII.
 *
 * A redactor failure is governed by a fail mode: `open` degrades to `block`
 * (strip the attachment — availability without ever forwarding raw PII),
 * `closed` throws so the whole request fails rather than proceeding.
 *
 * No `any` at module boundaries.
 */

import type { ContentBlock } from "../types/openai.js";
import type { Logger } from "../observability/logger.js";

export type MultimodalMode = "off" | "block" | "redact" | "describe";
export type MultimodalFailMode = "open" | "closed";

/**
 * Converts an attachment into a factual text description. The description then
 * flows through the SAME text tokenization/redaction as normal message text, so
 * the downstream provider never receives the raw pixels — only a de-identified
 * text rendering.
 *
 * TRUST BOUNDARY: the describer model *does* see the raw image. To actually keep
 * PII off the downstream provider it must be a trusted model — ideally a local
 * / on-prem vision model (e.g. Ollama `llava`). Pointing it at the same
 * third-party provider you are trying to shield defeats the purpose.
 */
export interface PiiImageDescriber {
  /**
   * @returns a plain-text description of the attachment.
   * @throws  when description could not be produced (fail mode applies).
   */
  describe(url: string, mime: string): Promise<string>;
}

/** Redacts PII from a single attachment, returning a redacted data URL. */
export interface PiiImageRedactor {
  /**
   * @param url  the attachment source — a `data:<mime>;base64,...` URI or an
   *             `http(s)://` URL.
   * @param mime best-effort MIME hint (may be empty).
   * @returns    a redacted `data:` URL to send in place of the original.
   * @throws     when redaction could not be performed (fail mode applies).
   */
  redact(url: string, mime: string): Promise<string>;
}

/** Default text shown in place of a withheld/failed attachment. */
export const DEFAULT_WITHHELD_NOTICE =
  "[attachment withheld: could not be scanned for personal data before reaching the model]";

// ---------------------------------------------------------------------------
// Block helpers
// ---------------------------------------------------------------------------

/** True for the two image block shapes (`image` and OpenAI's `image_url`). */
export function isImageBlock(block: ContentBlock): boolean {
  return block.type === "image" || block.type === "image_url";
}

/** True for a file attachment block. */
export function isFileBlock(block: ContentBlock): boolean {
  return block.type === "file";
}

/** True for any non-text attachment the multimodal control acts on. */
export function isAttachmentBlock(block: ContentBlock): boolean {
  return isImageBlock(block) || isFileBlock(block);
}

/** Extracts the source URL from an image/file block, or undefined for text. */
export function attachmentUrl(block: ContentBlock): string | undefined {
  if (block.type === "image" || block.type === "image_url") {
    return block.image_url.url;
  }
  if (block.type === "file") {
    return block.file_url.url;
  }
  return undefined;
}

/** Best-effort MIME type from a `data:` URL (empty string when unknown). */
export function dataUrlMime(url: string): string {
  const m = /^data:([^;,]+)[;,]/.exec(url);
  return m?.[1] ?? "";
}

/** Rebuilds a block of the same shape carrying a new (redacted) URL. */
function withUrl(block: ContentBlock, url: string): ContentBlock {
  if (block.type === "image") return { type: "image", image_url: { url } };
  if (block.type === "image_url")
    return { type: "image_url", image_url: { url } };
  if (block.type === "file") return { type: "file", file_url: { url } };
  return block;
}

// ---------------------------------------------------------------------------
// Core per-block transform
// ---------------------------------------------------------------------------

export interface MultimodalOptions {
  mode: MultimodalMode;
  /** Required for `redact` mode; when absent, `redact` degrades to `block`. */
  redactor?: PiiImageRedactor;
  /** Required for `describe` mode; when absent, `describe` degrades to `block`. */
  describer?: PiiImageDescriber;
  /** Behaviour when the redactor/describer throws. Default `open` (strip the attachment). */
  failMode?: MultimodalFailMode;
  /** Override the withheld-notice text. */
  withheldNotice?: string;
  logger?: Logger;
}

export interface MultimodalScanResult {
  /**
   * The transformed block: a text notice when stripped, a redacted attachment
   * block, a text block carrying the vision description (`describe`), or the
   * original block (`off`).
   */
  block: ContentBlock;
  /**
   * What happened — for metrics/telemetry. `described` signals the caller that
   * the resulting text block should be run through text tokenization (so the
   * description is redacted like any other text).
   */
  action: "passed" | "blocked" | "redacted" | "described";
}

/**
 * Applies the configured multimodal control to a single content block.
 * Text blocks are returned untouched (their PII is handled by the text vault).
 *
 * @throws when the redactor fails under `failMode: "closed"`.
 */
export async function scanAttachmentBlock(
  block: ContentBlock,
  opts: MultimodalOptions,
): Promise<MultimodalScanResult> {
  if (opts.mode === "off" || !isAttachmentBlock(block)) {
    return { block, action: "passed" };
  }

  const notice = opts.withheldNotice ?? DEFAULT_WITHHELD_NOTICE;
  const strip = (): MultimodalScanResult => ({
    block: { type: "text", text: notice },
    action: "blocked",
  });

  if (opts.mode === "block") return strip();

  if (opts.mode === "describe") {
    if (opts.describer === undefined) {
      opts.logger?.warn(
        "PII vault multimodal mode is 'describe' but no image describer is configured — stripping the attachment instead",
      );
      return strip();
    }
    // Describe is image-only: a vision model consumes an image part, not an
    // arbitrary file (a PDF/doc sent as an image part is rejected by the model).
    // A non-image attachment (e.g. a `file` block) is stripped, so it is never
    // forwarded raw either.
    if (!isImageBlock(block)) {
      opts.logger?.debug?.(
        "PII vault describe mode: non-image attachment stripped (only images can be described)",
      );
      return strip();
    }
    const url = attachmentUrl(block);
    if (url === undefined || url === "") return strip();
    try {
      const description = await opts.describer.describe(url, dataUrlMime(url));
      const text = description.trim();
      if (text === "") return strip();
      // Returned as a text block; the caller (withPiiVault) routes it through
      // the SAME text tokenization as normal content, so any PII the describer
      // reported is redacted before the downstream provider sees it.
      return {
        block: { type: "text", text: `[image description] ${text}` },
        action: "described",
      };
    } catch (err) {
      const failMode = opts.failMode ?? "open";
      opts.logger?.warn("PII image description failed", {
        failMode,
        error: err instanceof Error ? err.message : String(err),
      });
      if (failMode === "closed") {
        throw err instanceof Error
          ? err
          : new Error("PII image description failed (fail-closed)");
      }
      return strip();
    }
  }

  // mode === "redact"
  if (opts.redactor === undefined) {
    opts.logger?.warn(
      "PII vault multimodal mode is 'redact' but no image redactor is configured — stripping the attachment instead",
    );
    return strip();
  }

  const url = attachmentUrl(block);
  if (url === undefined || url === "") return strip();

  try {
    const redactedUrl = await opts.redactor.redact(url, dataUrlMime(url));
    return { block: withUrl(block, redactedUrl), action: "redacted" };
  } catch (err) {
    const failMode = opts.failMode ?? "open";
    opts.logger?.warn("PII image redaction failed", {
      failMode,
      error: err instanceof Error ? err.message : String(err),
    });
    if (failMode === "closed") {
      throw err instanceof Error
        ? err
        : new Error("PII image redaction failed (fail-closed)");
    }
    // fail-open: never forward the raw attachment — degrade to strip.
    return strip();
  }
}

// ---------------------------------------------------------------------------
// Remote redactor (presidio-image-redactor style sidecar)
// ---------------------------------------------------------------------------

export interface RemoteImageRedactorOptions {
  endpoint: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

/**
 * A {@link PiiImageRedactor} backed by an external HTTP service. The service
 * receives `{ image, mime }` and must return a JSON body containing the
 * redacted image as a data URL under `image` (or `redactedImage`). Any non-2xx
 * response, timeout, or malformed body throws — letting the vault's fail mode
 * decide whether to strip or reject.
 */
export function createRemoteImageRedactor(
  opts: RemoteImageRedactorOptions,
): PiiImageRedactor {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return {
    async redact(url: string, mime: string): Promise<string> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(opts.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(opts.apiKey !== undefined
              ? { Authorization: `Bearer ${opts.apiKey}` }
              : {}),
          },
          body: JSON.stringify({ image: url, mime }),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`redactor returned HTTP ${res.status}`);
        }
        const data = (await res.json()) as {
          image?: string;
          redactedImage?: string;
        };
        const redacted = data.image ?? data.redactedImage;
        if (typeof redacted !== "string" || redacted === "") {
          throw new Error("redactor response missing an image field");
        }
        return redacted;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// LLM-backed describer (vision model → text)
// ---------------------------------------------------------------------------

import type { LanguageModel } from "ai";
import { generateText } from "ai";

const DEFAULT_DESCRIBE_PROMPT =
  "You convert an attachment into a faithful, plain-text description for " +
  "downstream processing. Transcribe ALL visible text verbatim (including any " +
  "names, numbers, addresses, IBANs, case/reference numbers) and briefly " +
  "describe non-text visual content. Do NOT summarise away or omit personal " +
  "data — it is redacted in a later step and must be present to be redacted. " +
  "Output only the description, no preamble.";

/**
 * Minimal subset of the AI SDK `generateText` used here (injectable for tests).
 * Mirrors the pattern in `tool-group-summary.ts`.
 */
export type GenerateDescriptionFn = (args: {
  model: LanguageModel;
  system: string;
  messages: Array<{
    role: "user";
    content: Array<
      { type: "text"; text: string } | { type: "image"; image: string }
    >;
  }>;
}) => Promise<{ text: string }>;

export interface LlmImageDescriberOptions {
  /** Override the system prompt steering the description. */
  prompt?: string;
  /** Per-attachment timeout in ms. Default 20000. */
  timeoutMs?: number;
  logger?: Logger;
  /** Injectable AI SDK call for tests. Defaults to the real `generateText`. */
  generate?: GenerateDescriptionFn;
}

/**
 * A {@link PiiImageDescriber} backed by a vision {@link LanguageModel}. The
 * model receives the attachment as a real image part and returns a text
 * description. Use a LOCAL/on-prem vision model so the raw pixels never leave
 * your infrastructure (the whole point of `describe` mode).
 */
export function createLlmImageDescriber(
  model: LanguageModel,
  opts: LlmImageDescriberOptions = {},
): PiiImageDescriber {
  const generate = opts.generate ?? (generateText as unknown as GenerateDescriptionFn);
  const system = opts.prompt ?? DEFAULT_DESCRIBE_PROMPT;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return {
    async describe(url: string): Promise<string> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`image description timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      });
      try {
        const result = await Promise.race([
          generate({
            model,
            system,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Describe this attachment:" },
                  { type: "image", image: url },
                ],
              },
            ],
          }),
          timeout,
        ]);
        return result.text;
      } finally {
        // Clear the timer so a resolved call leaves no dangling timeout (and no
        // late rejection of the already-settled race).
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
