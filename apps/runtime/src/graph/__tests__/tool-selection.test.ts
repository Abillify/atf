// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for `parseToolSelection` — focused on the `cacheStable` flag that opts
 * a node into advertising its full tool pool (stable order) so the
 * Anthropic/Bedrock prompt-cache prefix (tools + system) stays byte-identical
 * across turns.
 */

import { describe, test, expect } from "bun:test";
import { parseToolSelection } from "../tool-selection.js";

describe("parseToolSelection — cacheStable", () => {
  test("defaults cacheStable to false when omitted", () => {
    const cfg = parseToolSelection({ toolSelection: { mode: "semantic" } });
    expect(cfg?.mode).toBe("semantic");
    expect(cfg?.cacheStable).toBe(false);
  });

  test("parses cacheStable: true", () => {
    const cfg = parseToolSelection({
      toolSelection: { mode: "semantic", cacheStable: true },
    });
    expect(cfg?.cacheStable).toBe(true);
  });

  test("treats non-boolean cacheStable as false (only strict true enables it)", () => {
    const cfg = parseToolSelection({
      toolSelection: { mode: "semantic", cacheStable: "yes" },
    });
    expect(cfg?.cacheStable).toBe(false);
  });

  test("returns undefined when toolSelection is absent", () => {
    expect(parseToolSelection({})).toBeUndefined();
    expect(parseToolSelection(undefined)).toBeUndefined();
  });
});
