// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The `show_figure` tool (`src/graph/figure-embedding.ts`).
 *
 * Lets an `llm` node put a document figure directly into its answer: the
 * hosting model passes an `asset:<id>[#bbox]` reference (or a bare asset id)
 * taken from its own search results, the engine fetches the bytes through the
 * MCP `get_asset` tool — inheriting its tenant/collection/row ACL and
 * fail-closed behaviour (task 3.9) — parks them in the run's media store, and
 * the tool hands the model a markdown image with a short-lived media URL
 * (`<MEDIA_BASE_URL>/v1/media/<id>.<ext>`) to paste into the answer. The
 * answer therefore shows the original picture without the model ever seeing
 * (or re-emitting) a single byte of it.
 *
 * The mirror image of `inspect_image`: that tool turns pixels into text for
 * the model; this one turns a reference into pixels for the user.
 *
 * Gating is deliberately double: the deployment must set
 * `EMBED_SEARCH_FIGURES=true` plus `MEDIA_BASE_URL` (the media link has to be
 * reachable from the user's browser), and the node must declare
 * `config.figureEmbedding`. The link itself is capability-style — knowledge
 * of the unguessable id is the access, bounded by the media store's TTL — so
 * flows should embed deliberately chosen figures, not every hit.
 *
 * No `any` at module boundaries.
 */
import { tool, jsonSchema } from "ai";
import type { ToolExecutionOptions, ToolSet } from "ai";
import type { FigureEmbeddingConfig } from "../types/flow.js";
import { parseAssetReference } from "./image-reference.js";
import { uniqueMediaToolKey } from "./agent-tools.js";

/** Default tool name models use to embed a figure into their answer. */
export const SHOW_FIGURE_TOOL_NAME = "show_figure";

/** Caps the model-supplied caption so one call cannot bloat the answer. */
const MAX_CAPTION_CHARS = 200;

/**
 * Wiring for {@link buildShowFigureTools}. Deliberately narrow: the module
 * stays decoupled from the MCP client (the engine supplies a `fetchAsset`
 * hook, same shape as `inspect_image`'s) and from the HTTP layer (the engine
 * supplies `publishMedia`, the same hook `generate_image` uses).
 */
export interface FigureEmbeddingHooks {
  /** Existing model tools, used to choose a non-colliding tool key. */
  existingTools?: ToolSet;
  /** The node's `config.figureEmbedding` block. */
  config: FigureEmbeddingConfig;
  /**
   * Fetches a stored document asset by id via the configured MCP server's
   * `get_asset` tool (caller ACL, fail-closed — see
   * `handlers/llm-asset-fetch.ts`). Returns `undefined` when the asset is
   * unavailable/forbidden or the fetch fails; the tool then fails closed and
   * no bytes are published.
   */
  fetchAsset: (
    assetId: string,
    opts: { region?: [number, number, number, number] },
  ) => Promise<{ bytes: Uint8Array; mediaType: string } | undefined>;
  /**
   * Persists the fetched bytes and returns the browser-reachable media URL,
   * or `undefined` when media serving is not configured (then the tool fails
   * closed — there is no inline fallback, the bytes must not enter the
   * model's context).
   */
  publishMedia: (base64: string, mediaType: string) => string | undefined;
  /** See {@link AgentMediaHooks.onEffectiveArgs} — same local-tool reason. */
  onEffectiveArgs?: (
    toolCallId: string,
    toolName: string,
    argsJson: string,
  ) => void | Promise<void>;
}

/**
 * Strips characters that would break the markdown image link out of a
 * model-supplied caption and caps its length. Never throws.
 */
function sanitizeCaption(raw: string): string {
  const cleaned = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/[[\]()]/g, "")
    .trim();
  return cleaned.length > MAX_CAPTION_CHARS
    ? `${cleaned.slice(0, MAX_CAPTION_CHARS - 1)}…`
    : cleaned;
}

/**
 * Builds the `show_figure` tool for an `llm` node that declares
 * `config.figureEmbedding` (and whose deployment gate is on — the caller in
 * `handlers/llm-tool-setup.ts` checks `EMBED_SEARCH_FIGURES` +
 * `MEDIA_BASE_URL` before calling this). Returns an empty ToolSet when the
 * config block is missing so a node that did not opt in is unaffected.
 */
export function buildShowFigureTools(
  hooks: FigureEmbeddingHooks,
): ToolSet {
  const cfg = hooks.config as FigureEmbeddingConfig | undefined;
  if (cfg === null || typeof cfg !== "object") return {};
  const key = uniqueMediaToolKey(
    (hooks.existingTools ?? {}) as Record<string, unknown>,
    SHOW_FIGURE_TOOL_NAME,
  );
  const tools: ToolSet = {};
  tools[key] = tool<{ asset: string; caption?: string }, unknown, never>({
    description:
      hooks.config.description ??
      `Shows a document figure (image) directly to the user inside your ` +
      `answer. Pass the asset reference exactly as it appeared in a search ` +
      `hit, list_figures or follow_ref result: "asset:<id>", optionally with ` +
      `a normalised bounding box "asset:<id>#x0,y0,x1,y1" (each 0..1) to ` +
      `crop a region, or a bare asset id. The tool returns a markdown image ` +
      `link — paste it verbatim into your answer at the place where the ` +
      `figure belongs, and never invent, alter or re-fetch the URL. Use it ` +
      `only for figures that materially support the answer, not for every ` +
      `hit. If the tool reports the asset as unavailable, continue without ` +
      `the figure and do not mention the failure.`,
    inputSchema: jsonSchema<{ asset: string; caption?: string }>({
      type: "object",
      properties: {
        asset: {
          type: "string",
          description:
            'The figure to show: "asset:<id>" (optionally with a region ' +
            'zoom, "asset:<id>#x0,y0,x1,y1" where each coordinate is ' +
            "between 0 and 1), or a bare asset id from a tool result.",
        },
        caption: {
          type: "string",
          description:
            "Short caption for the figure shown to the user (optional).",
        },
      },
      required: ["asset"],
    }),
    execute: async (
      args: { asset: string; caption?: string },
      opts: ToolExecutionOptions<never>,
    ): Promise<unknown> => {
      const asset = String(args?.asset ?? "");
      const caption =
        typeof args?.caption === "string" ? sanitizeCaption(args.caption) : "";
      await hooks.onEffectiveArgs?.(
        opts.toolCallId,
        key,
        JSON.stringify({ asset, ...(caption !== "" ? { caption } : {}) }),
      );
      return runShowFigure(hooks, asset, caption);
    },
  }) as ToolSet[string];
  return tools;
}

/**
 * Resolves one asset reference, fetches the bytes (fail-closed) and publishes
 * them as a media link. The bytes never enter the hosting model's context —
 * the tool result carries only the markdown link (or an error status).
 */
async function runShowFigure(
  hooks: FigureEmbeddingHooks,
  asset: string,
  caption: string,
): Promise<unknown> {
  // Same reference grammar as `inspect_image`: an `asset:<id>[#bbox]` ref, or
  // — as a convenience for models that drop the scheme — a bare asset id.
  // Anything that parses as an asset ref but is malformed fails closed with
  // an actionable message; a bare id must at least be non-empty and
  // whitespace-free so an accidental sentence is not treated as an id.
  const parsed = parseAssetReference(asset);
  let assetId: string;
  let region: [number, number, number, number] | undefined;
  if (parsed === undefined) {
    const bare = asset.trim();
    if (bare === "" || /\s/.test(bare)) {
      return {
        status: "invalid_request",
        message:
          'Malformed asset reference. Use "asset:<id>" or ' +
          '"asset:<id>#x0,y0,x1,y1" (each coordinate between 0 and 1) ' +
          "with an id taken from a search hit, list_figures or follow_ref " +
          "result.",
      };
    }
    assetId = bare;
  } else if (!parsed.ok) {
    return {
      status: "invalid_request",
      message:
        'Malformed asset reference. Use "asset:<id>" or ' +
        '"asset:<id>#x0,y0,x1,y1" where each coordinate is a number ' +
        "between 0 and 1 with x0<x1 and y0<y1.",
    };
  } else {
    assetId = parsed.ref.assetId;
    region = parsed.ref.region;
  }

  let fetched: { bytes: Uint8Array; mediaType: string } | undefined;
  try {
    fetched = await hooks.fetchAsset(assetId, {
      ...(region !== undefined ? { region } : {}),
    });
  } catch {
    // Fail closed: a transport error must not crash the answer or leak its
    // cause. The model continues without the figure.
    fetched = undefined;
  }
  if (fetched === undefined) {
    return {
      status: "asset_unavailable",
      message:
        "This figure is not available (unknown, unauthorized, or the " +
        "asset service is unreachable). Continue your answer without it; " +
        "do not retry with a different id and do not mention this failure " +
        "to the user.",
    };
  }

  const url = hooks.publishMedia(
    Buffer.from(fetched.bytes).toString("base64"),
    fetched.mediaType,
  );
  if (url === undefined) {
    // Media serving went away between wiring and call (store full / budget
    // exhausted). Fail closed — an inline data-URI would put the bytes into
    // the model context, which this tool must never do.
    return {
      status: "asset_unavailable",
      message:
        "The figure could not be published for display right now. Continue " +
        "your answer without it and do not mention this failure to the user.",
    };
  }

  const alt = caption !== "" ? caption : "Abbildung";
  return {
    status: "ok",
    markdown: `![${alt}](${url})`,
    message:
      "Paste this exact markdown into your answer where the figure belongs. " +
      "Do not modify the URL, repeat the figure, or describe it as a link.",
  };
}
