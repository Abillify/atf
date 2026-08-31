// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { McpProxyToolSchema } from "../../src/config/schema.ts";
import {
  hardPayloadLimitError,
  measureMcpPayloadBytes,
} from "../../src/tools/mcp-proxy-tool.ts";

const baseTool = {
  name: "downstream",
  type: "mcp" as const,
  server: { url: "https://mcp.example.com" },
  targetTool: "search",
};

describe("complete MCP payload measurement", () => {
  test("measures JSON.stringify output as UTF-8 bytes", () => {
    const result = { content: [{ type: "text", text: "Grüße 👋" }] };
    expect(measureMcpPayloadBytes(result)).toBe(
      Buffer.byteLength(JSON.stringify(result), "utf8"),
    );
    expect(measureMcpPayloadBytes(result)).toBeGreaterThan(JSON.stringify(result).length);
  });

  test("includes structured-only and non-text content", () => {
    const small = { structuredContent: { rows: [1] } };
    const large = {
      structuredContent: { rows: [1], detail: "x".repeat(100) },
      content: [{ type: "image", data: "y".repeat(100), mimeType: "image/png" }],
    };
    expect(measureMcpPayloadBytes(large)).toBeGreaterThan(measureMcpPayloadBytes(small));
  });

  test("allows the exact boundary and rejects one byte above it", () => {
    const result = { structuredContent: { tenant: "ä" } };
    const bytes = measureMcpPayloadBytes(result);
    const meta = { server: "https://mcp.example.com", targetTool: "search" };

    expect(hardPayloadLimitError(result, bytes, meta)).toBeUndefined();
    const error = hardPayloadLimitError(result, bytes - 1, meta);
    expect(error).toMatchObject({
      isError: true,
      meta: { source: "mcp", bytes },
    });
    expect(JSON.stringify(error)).not.toContain("tenant");
  });

  test("returns a controlled payload-free error for circular and BigInt results", () => {
    const circular: { self?: unknown; secret: string } = { secret: "do-not-leak" };
    circular.self = circular;
    const meta = { server: "https://mcp.example.com", targetTool: "search" };

    for (const result of [circular, { secret: "do-not-leak", value: 1n }]) {
      const error = hardPayloadLimitError(result, 1024, meta);
      expect(error).toMatchObject({
        isError: true,
        meta: { source: "mcp", payloadMeasurementFailed: true },
      });
      expect(JSON.stringify(error)).not.toContain("do-not-leak");
    }
  });

  test("limit 0 does not serialize circular or BigInt results", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const meta = { server: "https://mcp.example.com", targetTool: "search" };
    expect(hardPayloadLimitError(circular, 0, meta)).toBeUndefined();
    expect(hardPayloadLimitError({ value: 1n }, 0, meta)).toBeUndefined();
  });

  test("limit 0 disables the hard payload guard", () => {
    expect(
      hardPayloadLimitError(
        { structuredContent: { huge: "x".repeat(10_000) } },
        0,
        { server: "https://mcp.example.com", targetTool: "search" },
      ),
    ).toBeUndefined();
  });
});

describe("MCP proxy payload limit schema", () => {
  test("defaults hardPayloadLimitBytes to disabled without changing the text limit", () => {
    const parsed = McpProxyToolSchema.parse(baseTool);
    expect(parsed.hardPayloadLimitBytes).toBe(0);
    expect(parsed.maxResponseBytes).toBe(10 * 1024 * 1024);
  });

  test("coerces a configured nonnegative hard limit", () => {
    expect(
      McpProxyToolSchema.parse({ ...baseTool, hardPayloadLimitBytes: "2048" })
        .hardPayloadLimitBytes,
    ).toBe(2048);
    expect(() =>
      McpProxyToolSchema.parse({ ...baseTool, hardPayloadLimitBytes: -1 }),
    ).toThrow();
  });

  test("keeps maxResponseBytes positive", () => {
    expect(() => McpProxyToolSchema.parse({ ...baseTool, maxResponseBytes: 0 })).toThrow();
  });
});
