// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Asset fetch for `inspect_image` (Req 16.3).
 *
 * Extracted verbatim from `llm.ts` (task 18.1, Req 13.6) — behaviour is
 * unchanged. Resolves an `asset:<id>[#bbox]` reference through the configured
 * MCP server's `get_asset` tool so the read inherits its tenant/collection/row
 * ACL and fail-closed behaviour (task 3.9).
 */
import type { ImageInspectionConfig } from "../../types/flow.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import type { RequestContext } from "../../types/monitoring.js";
import { decodeBase64Bytes } from "../media-store.js";

/** Config block that enables `asset:<id>[#bbox]` resolution. */
type AssetSourceConfig = NonNullable<ImageInspectionConfig["assetSource"]>;

/** One MCP content part, in the shape `get_asset` returns image bytes as. */
interface McpImagePart {
  type: string;
  data?: unknown;
  mimeType?: unknown;
}

/**
 * Extracts the first image part (base64 `data` + `mimeType`) from an MCP tool
 * result's `content` array. Returns `undefined` when the result carries no
 * decodable image — which is exactly what a fail-closed `get_asset` returns for
 * an unauthorized/unknown asset (an `isError` text-only result). Never throws.
 */
function extractMcpImage(
  content: unknown,
): { bytes: Uint8Array; mediaType: string } | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const raw of content) {
    if (raw === null || typeof raw !== "object") continue;
    const part = raw as McpImagePart;
    if (part.type !== "image") continue;
    if (typeof part.data !== "string") continue;
    const mediaType =
      typeof part.mimeType === "string" && part.mimeType !== ""
        ? part.mimeType
        : "image/png";
    const bytes = decodeBase64Bytes(part.data);
    if (bytes === undefined || bytes.byteLength === 0) continue;
    return { bytes, mediaType };
  }
  return undefined;
}

/**
 * Builds the `fetchAsset` hook the `inspect_image` tool uses to resolve an
 * `asset:<id>[#bbox]` reference (Req 16.3). It calls the configured MCP server's
 * `get_asset` tool with the caller's request context, so the read inherits
 * `get_asset`'s tenant/collection/row ACL and fail-closed behaviour (task 3.9),
 * and returns only the decoded image bytes — the responder model never sees the
 * base64. A `region` triggers `get_asset`'s server-side zoom crop; a whole-asset
 * fetch uses the configured `variant`. Any error or an image-less result yields
 * `undefined`, which the tool reports as a fail-closed `unknown_image`.
 */
export function buildAssetFetch(
  mcpWrapper: McpWrapperService,
  ctx: RequestContext,
  assetSource: AssetSourceConfig,
  signal?: AbortSignal,
): (
  assetId: string,
  opts: { region?: [number, number, number, number] },
) => Promise<{ bytes: Uint8Array; mediaType: string } | undefined> {
  return async (assetId, opts) => {
    const args: Record<string, unknown> = { asset_id: assetId };
    if (assetSource.collection !== undefined) {
      args.collection = assetSource.collection;
    }
    if (opts.region !== undefined) {
      args.region = opts.region;
    } else if (assetSource.variant !== undefined) {
      args.variant = assetSource.variant;
    }
    let result: Awaited<ReturnType<McpWrapperService["callTool"]>>;
    try {
      result = await mcpWrapper.callTool(
        assetSource.server,
        "get_asset",
        args,
        ctx,
        signal !== undefined ? { signal } : undefined,
      );
    } catch {
      // Fail closed: a transport/tool error must not crash the inspection or
      // leak its cause. The tool treats undefined as an unavailable asset.
      return undefined;
    }
    if (result.isError === true) return undefined;
    return extractMcpImage(result.content);
  };
}
