// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Multimodal Content Block Processor
 *
 * Processes an array of ContentBlocks with full error isolation:
 * a failure in block i emits an error and continues with block i+1.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
 */

import type { ContentBlock, StreamError } from "../types/openai.js";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** A successfully processed content block with decoded payload */
export type ProcessedBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string; url: string }
  | { type: "file"; mimeType: string; data: Buffer; url: string }
  | { type: "url"; url: string };

/** Result for a single block — either success or a structured error */
export type BlockProcessingResult =
  | { success: true; block: ProcessedBlock }
  | { success: false; error: StreamError };

/** Aggregated result returned by processContentBlocks */
export interface ContentProcessingResult {
  processed: ProcessedBlock[];
  errors: StreamError[];
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Regex that matches a data URL for supported image MIME types.
 * Capture group 1: mime subtype (png|jpeg|webp|gif)
 * Capture group 2: raw base64 payload
 */
const IMAGE_DATA_URL_RE =
  /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+=*)$/;

/**
 * Regex that matches any data URL with a generic MIME type.
 * Capture group 1: full mime type (e.g. application/pdf)
 * Capture group 2: raw base64 payload
 */
const DATA_URL_RE = /^data:([^;]+);base64,([A-Za-z0-9+/]+=*)$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a StreamError for a content-block problem.
 */
function blockError(
  blockIndex: number,
  message: string,
  reason: string,
): StreamError {
  return {
    message,
    type: "invalid_request_error",
    details: { block_index: blockIndex, reason },
  };
}

/**
 * Attempt to decode a base64 string into a Buffer.
 * Returns null if the string is not valid base64.
 */
function tryDecodeBase64(b64: string): Buffer | null {
  try {
    const buf = Buffer.from(b64, "base64");
    // Re-encode and compare to catch invalid padding / chars
    if (buf.toString("base64") !== b64) {
      return null;
    }
    return buf;
  } catch {
    return null;
  }
}

/**
 * Validate that a string is a well-formed URL using the WHATWG URL parser.
 */
function isValidUrl(raw: string): boolean {
  try {
    new URL(raw);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-type processors
// ---------------------------------------------------------------------------

function processImageBlock(
  url: string,
  blockIndex: number,
): BlockProcessingResult {
  // Check whether this is a data URL
  const dataMatch = IMAGE_DATA_URL_RE.exec(url);

  if (dataMatch === null) {
    // Not a recognised image data URL — check if it is a plain URL reference
    if (!DATA_URL_RE.test(url)) {
      // Plain URL path — validate URL format (Req 8.7)
      if (!isValidUrl(url)) {
        return {
          success: false,
          error: blockError(
            blockIndex,
            `Invalid URL format in content block: ${url}`,
            "invalid_url",
          ),
        };
      }
      // Valid URL reference — keep as-is (Req 8.2)
      return { success: true, block: { type: "url", url } };
    }

    // It IS a data URL but with an unsupported image MIME type.
    // Extract the MIME type so the error message is actionable.
    const genericMatch = DATA_URL_RE.exec(url);
    const detectedMime = genericMatch?.[1] ?? "unknown";
    const isSvg = detectedMime === "image/svg+xml";

    if (isSvg) {
      // SVG is vector XML — most vision and image-generation models only accept
      // raster formats. Decode the SVG and surface it as a text block so
      // text-capable models can at least read the markup; attach a clear hint
      // so the user knows raster conversion is needed for image tools.
      const b64Data = genericMatch?.[2];
      if (b64Data) {
        const decoded = tryDecodeBase64(b64Data);
        if (decoded !== null) {
          const svgText = decoded.toString("utf-8");
          return {
            success: true,
            block: {
              type: "text",
              text: `[SVG image attached — raster formats (PNG/JPEG) are required for image generation tools. SVG source:\n${svgText}]`,
            },
          };
        }
      }
      return {
        success: false,
        error: blockError(
          blockIndex,
          "SVG images are not supported by image generation tools. Please convert the SVG to PNG or JPEG first.",
          "unsupported_image_format",
        ),
      };
    }

    return {
      success: false,
      error: blockError(
        blockIndex,
        `Unsupported image format: ${detectedMime}. Supported formats are PNG, JPEG, WebP, and GIF.`,
        "unsupported_image_format",
      ),
    };
  }

  // dataMatch[1] is mime subtype, dataMatch[2] is base64 payload
  const mimeSubtype = dataMatch[1];
  const b64Data = dataMatch[2];

  if (!mimeSubtype || !b64Data) {
    return {
      success: false,
      error: blockError(
        blockIndex,
        "Invalid base64 encoding in image block",
        "invalid_base64",
      ),
    };
  }

  const mimeType = `image/${mimeSubtype}`;

  // Attempt base64 decode
  const decoded = tryDecodeBase64(b64Data);
  if (decoded === null) {
    return {
      success: false,
      error: blockError(
        blockIndex,
        "Invalid base64 encoding in image block",
        "invalid_base64",
      ),
    };
  }

  // Size check (Req 8.3)
  if (decoded.byteLength > MAX_IMAGE_BYTES) {
    return {
      success: false,
      error: blockError(
        blockIndex,
        "Image exceeds maximum size of 10 MB",
        "image_too_large",
      ),
    };
  }

  return {
    success: true,
    block: { type: "image", mimeType, data: b64Data, url },
  };
}

function processFileBlock(
  url: string,
  blockIndex: number,
): BlockProcessingResult {
  const dataMatch = DATA_URL_RE.exec(url);

  if (dataMatch === null) {
    // Not a data URL — treat as plain URL reference (Req 8.2)
    if (!isValidUrl(url)) {
      return {
        success: false,
        error: blockError(
          blockIndex,
          `Invalid URL format in content block: ${url}`,
          "invalid_url",
        ),
      };
    }
    return { success: true, block: { type: "url", url } };
  }

  const mimeType = dataMatch[1];
  const b64Data = dataMatch[2];

  // Validate MIME type — must be non-empty and contain a slash
  if (!mimeType || !b64Data || !mimeType.includes("/")) {
    return {
      success: false,
      error: blockError(
        blockIndex,
        "Invalid MIME type in file block",
        "invalid_mime_type",
      ),
    };
  }

  // Decode base64 (Req 8.1, 8.5)
  const decoded = tryDecodeBase64(b64Data);
  if (decoded === null) {
    return {
      success: false,
      error: blockError(
        blockIndex,
        "Invalid base64 encoding in file block",
        "invalid_base64",
      ),
    };
  }

  return {
    success: true,
    block: { type: "file", mimeType, data: decoded, url },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Process an array of ContentBlocks with full per-block error isolation.
 *
 * - text blocks are passed through unchanged
 * - image blocks: data URLs are decoded + size-checked; plain URLs are validated
 * - file blocks: data URLs are decoded; plain URLs are validated
 * - unsupported types (audio, video, …) produce an error chunk
 *
 * A failure in any block never stops the processing of subsequent blocks.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
 */
export function processContentBlocks(
  blocks: ContentBlock[],
): ContentProcessingResult {
  const processed: ProcessedBlock[] = [];
  const errors: StreamError[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    // TypeScript narrows the union — but we still guard the runtime type
    // so we can emit errors for truly unknown block types (Req 8.6)
    if (block === undefined) continue;

    if (block.type === "text") {
      // Text blocks are always valid — pass through (Req 8.1)
      processed.push({ type: "text", text: block.text });
      continue;
    }

    if (block.type === "image" || block.type === "image_url") {
      const result = processImageBlock(block.image_url.url, i);
      if (result.success) {
        processed.push(result.block);
      } else {
        errors.push(result.error);
      }
      continue;
    }

    if (block.type === "file") {
      const result = processFileBlock(block.file_url.url, i);
      if (result.success) {
        processed.push(result.block);
      } else {
        errors.push(result.error);
      }
      continue;
    }

    // Unsupported block type — emit error, skip block (Req 8.6)
    // At runtime, `block` may have a type not present in the ContentBlock union
    const unknownType = (block as { type: string }).type;
    errors.push(
      blockError(
        i,
        `Unsupported content block type: ${unknownType}`,
        "unsupported_type",
      ),
    );
  }

  return { processed, errors };
}
