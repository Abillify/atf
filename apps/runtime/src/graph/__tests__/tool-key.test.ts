// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for uniqueToolKey — namespaced, collision-free AI SDK tool keys.
 *
 * Guards the fix for the previous bug where two MCP servers exposing a tool of
 * the same bare name silently shadowed each other in the ToolSet.
 */

import { describe, test, expect } from "bun:test";
import { uniqueToolKey } from "../agent-tools.js";

describe("uniqueToolKey", () => {
  test("namespaces by server so same bare names do not collide", () => {
    const tools: Record<string, unknown> = {};
    const k1 = uniqueToolKey(tools, "serverA", "search");
    tools[k1] = true;
    const k2 = uniqueToolKey(tools, "serverB", "search");
    tools[k2] = true;

    expect(k1).not.toBe(k2);
    expect(k1).toBe("serverA__search");
    expect(k2).toBe("serverB__search");
  });

  test("sanitises invalid identifier characters", () => {
    const key = uniqueToolKey({}, "my-mcp.io", "weird/tool name");
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("disambiguates a genuine collision with a numeric suffix", () => {
    const tools: Record<string, unknown> = {};
    // Two refs that sanitise to the same base.
    const k1 = uniqueToolKey(tools, "s", "a/b");
    tools[k1] = true;
    const k2 = uniqueToolKey(tools, "s", "a_b"); // sanitises to the same base
    tools[k2] = true;
    expect(k1).not.toBe(k2);
    expect(k2.endsWith("_2")).toBe(true);
  });

  test("keys never exceed 64 characters", () => {
    const long = "x".repeat(200);
    const key = uniqueToolKey({}, long, long);
    expect(key.length).toBeLessThanOrEqual(64);
  });
});
