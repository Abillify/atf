// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the `show_figure` tool (`buildShowFigureTools`).
 *
 * What matters: the tool hands the model a markdown media link and nothing
 * else — never bytes; the asset fetch receives the parsed id/region; every
 * failure path (malformed ref, unavailable/forbidden asset, throwing fetch,
 * unpublishable media) fails closed with a status the model can act on and
 * without leaking the underlying error; the caption is sanitised so it cannot
 * break the markdown link; and the effective-args hook sees the local call.
 */

import { describe, test, expect } from "bun:test";
import type { Tool } from "ai";
import {
  buildShowFigureTools,
  SHOW_FIGURE_TOOL_NAME,
  type FigureEmbeddingHooks,
} from "../figure-embedding.js";
import type { FigureEmbeddingConfig } from "../../types/flow.js";

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64");

const config: FigureEmbeddingConfig = {
  assetSource: { server: "vectorsearch", collection: "docs" },
};

interface FixtureOptions {
  fetchAsset?: {
    bytes?: Uint8Array;
    mediaType?: string;
    throw?: boolean;
    undefinedResult?: boolean;
  };
  publishMedia?: (base64: string, mediaType: string) => string | undefined;
}

interface FixtureResult {
  tool: Tool & {
    execute: (
      args: { asset: string; caption?: string },
      opts: { toolCallId?: string },
    ) => Promise<Record<string, unknown>>;
  };
  fetchAssetCalls: {
    assetId: string;
    region?: [number, number, number, number];
  }[];
  publishCalls: { base64: string; mediaType: string }[];
  effectiveArgs: { toolCallId: string; toolName: string; argsJson: string }[];
}

function fixture(options: FixtureOptions = {}): FixtureResult {
  const fetchAssetCalls: FixtureResult["fetchAssetCalls"] = [];
  const publishCalls: FixtureResult["publishCalls"] = [];
  const effectiveArgs: FixtureResult["effectiveArgs"] = [];
  const fetchAsset = async (
    assetId: string,
    opts: { region?: [number, number, number, number] },
  ): Promise<{ bytes: Uint8Array; mediaType: string } | undefined> => {
    fetchAssetCalls.push({
      assetId,
      ...(opts.region !== undefined ? { region: opts.region } : {}),
    });
    if (options.fetchAsset?.throw === true) throw new Error("get_asset boom");
    if (options.fetchAsset?.undefinedResult === true) return undefined;
    return {
      bytes: options.fetchAsset?.bytes ?? PNG_BYTES,
      mediaType: options.fetchAsset?.mediaType ?? "image/png",
    };
  };
  const publishMedia =
    options.publishMedia ??
    ((base64: string, mediaType: string): string | undefined => {
      publishCalls.push({ base64, mediaType });
      return "http://localhost:3000/v1/media/0f8fad5b-d9cb-469f-a165-70867728950e.png";
    });
  const hooks: FigureEmbeddingHooks = {
    config,
    fetchAsset,
    publishMedia,
    onEffectiveArgs: (toolCallId, toolName, argsJson) => {
      effectiveArgs.push({ toolCallId, toolName, argsJson });
    },
  };
  const tools = buildShowFigureTools(hooks);
  const key = Object.keys(tools)[0];
  return {
    tool: tools[key] as FixtureResult["tool"],
    fetchAssetCalls,
    publishCalls,
    effectiveArgs,
  };
}

describe("show_figure", () => {
  test("registers the tool under the default name", () => {
    const tools = buildShowFigureTools({
      config,
      fetchAsset: async () => undefined,
      publishMedia: () => undefined,
    });
    expect(Object.keys(tools)).toEqual([SHOW_FIGURE_TOOL_NAME]);
  });

  test("suffixes the key on collision with an existing tool", () => {
    const existing = { [SHOW_FIGURE_TOOL_NAME]: {} } as never;
    const tools = buildShowFigureTools({
      existingTools: existing,
      config,
      fetchAsset: async () => undefined,
      publishMedia: () => undefined,
    });
    expect(Object.keys(tools)).toEqual([`${SHOW_FIGURE_TOOL_NAME}_2`]);
  });

  test("publishes the fetched bytes and returns a markdown link", async () => {
    const f = fixture();
    const result = await f.tool.execute(
      { asset: "asset:abc123", caption: "Rechnung 2024" },
      { toolCallId: "call-1" },
    );
    expect(f.fetchAssetCalls).toEqual([{ assetId: "abc123" }]);
    expect(f.publishCalls).toEqual([
      { base64: PNG_B64, mediaType: "image/png" },
    ]);
    expect(result.status).toBe("ok");
    expect(result.markdown).toBe(
      "![Rechnung 2024](http://localhost:3000/v1/media/0f8fad5b-d9cb-469f-a165-70867728950e.png)",
    );
    expect(typeof result.message).toBe("string");
    // The bytes must never travel back into the model context.
    expect(JSON.stringify(result)).not.toContain(PNG_B64);
    expect(f.effectiveArgs).toEqual([
      {
        toolCallId: "call-1",
        toolName: SHOW_FIGURE_TOOL_NAME,
        argsJson: JSON.stringify({ asset: "asset:abc123", caption: "Rechnung 2024" }),
      },
    ]);
  });

  test("passes a parsed region through to the asset fetch", async () => {
    const f = fixture();
    const result = await f.tool.execute(
      { asset: "asset:abc123#0.1,0.2,0.5,0.8" },
      { toolCallId: "call-r" },
    );
    expect(result.status).toBe("ok");
    expect(f.fetchAssetCalls).toEqual([
      { assetId: "abc123", region: [0.1, 0.2, 0.5, 0.8] },
    ]);
  });

  test("accepts a bare asset id without the scheme", async () => {
    const f = fixture();
    const result = await f.tool.execute(
      { asset: "  abc123  " },
      { toolCallId: "call-b" },
    );
    expect(result.status).toBe("ok");
    expect(f.fetchAssetCalls).toEqual([{ assetId: "abc123" }]);
  });

  test("rejects a malformed asset reference without fetching", async () => {
    const f = fixture();
    const result = await f.tool.execute(
      { asset: "asset:abc123#0.9,0.2,0.5,0.8" },
      { toolCallId: "call-m" },
    );
    expect(result.status).toBe("invalid_request");
    expect(f.fetchAssetCalls).toEqual([]);
    expect(f.publishCalls).toEqual([]);
  });

  test("rejects an empty or sentence-like reference", async () => {
    const f = fixture();
    const empty = await f.tool.execute(
      { asset: "   " },
      { toolCallId: "c1" },
    );
    expect(empty.status).toBe("invalid_request");
    const sentence = await f.tool.execute(
      { asset: "asset:abc123#0.1,0.2" },
      { toolCallId: "c2" },
    );
    expect(sentence.status).toBe("invalid_request");
    expect(f.fetchAssetCalls).toEqual([]);
  });

  test("fails closed when the asset is unavailable or forbidden", async () => {
    const f = fixture({ fetchAsset: { undefinedResult: true } });
    const result = await f.tool.execute(
      { asset: "asset:gone" },
      { toolCallId: "call-u" },
    );
    expect(result.status).toBe("asset_unavailable");
    expect(result.markdown).toBeUndefined();
    expect(f.publishCalls).toEqual([]);
  });

  test("swallows a throwing asset fetch without leaking its cause", async () => {
    const f = fixture({ fetchAsset: { throw: true } });
    const result = await f.tool.execute(
      { asset: "asset:boom" },
      { toolCallId: "call-t" },
    );
    expect(result.status).toBe("asset_unavailable");
    expect(JSON.stringify(result)).not.toContain("boom");
    expect(f.publishCalls).toEqual([]);
  });

  test("fails closed when the media cannot be published", async () => {
    const f = fixture({ publishMedia: () => undefined });
    const result = await f.tool.execute(
      { asset: "asset:abc123" },
      { toolCallId: "call-p" },
    );
    expect(result.status).toBe("asset_unavailable");
    expect(result.markdown).toBeUndefined();
  });

  test("sanitises the caption so it cannot break the markdown link", async () => {
    const f = fixture();
    const result = await f.tool.execute(
      { asset: "asset:abc123", caption: "a](evil\n[b] text" },
      { toolCallId: "call-s" },
    );
    expect(result.status).toBe("ok");
    const markdown = String(result.markdown);
    // Exactly one image link, no injected brackets from the caption.
    expect(markdown.match(/\[/g)?.length).toBe(1);
    expect(markdown.match(/\]/g)?.length).toBe(1);
    expect(markdown.startsWith("![aevil b text](")).toBe(true);
  });

  test("caps a very long caption", async () => {
    const f = fixture();
    const result = await f.tool.execute(
      { asset: "asset:abc123", caption: "x".repeat(500) },
      { toolCallId: "call-l" },
    );
    const markdown = String(result.markdown);
    expect(markdown.length).toBeLessThan(300);
    expect(markdown).toContain("…");
  });

  test("uses a neutral alt text when no caption is given", async () => {
    const f = fixture();
    const result = await f.tool.execute(
      { asset: "asset:abc123" },
      { toolCallId: "call-n" },
    );
    expect(String(result.markdown).startsWith("![Abbildung](")).toBe(true);
  });

  test("honours a config description override", () => {
    const tools = buildShowFigureTools({
      config: { ...config, description: "Zeigt eine Abbildung im Antworttext." },
      fetchAsset: async () => undefined,
      publishMedia: () => undefined,
    });
    const t = tools[SHOW_FIGURE_TOOL_NAME] as { description?: string };
    expect(t.description).toBe("Zeigt eine Abbildung im Antworttext.");
  });
});
