// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { describeShortcut, type ModelShortcutsData } from "../model-shortcuts.js";

const data = {
  engines: { lms: { provider: "openai" }, aws: { provider: "bedrock" } },
  modelPresets: { qwen: { model: "qwen/qwen3.6-35b-a3b" }, sonnet: { model: "anthropic.claude-sonnet" } },
  shortcuts: {
    qwen: { engine: "lms", model: "qwen" },
    sonnet: { engine: "aws", model: "sonnet" },
    "thinking-pool": {
      strategy: "round-robin",
      members: [{ shortcut: "qwen" }, { engine: "aws", model: "sonnet" }],
    },
  },
} as unknown as ModelShortcutsData;

describe("describeShortcut", () => {
  test("names provider and concrete model of a single shortcut", () => {
    expect(describeShortcut(data, "qwen")).toBe("openai · qwen/qwen3.6-35b-a3b");
  });

  test("lists a pool's strategy and members", () => {
    expect(describeShortcut(data, "thinking-pool")).toBe(
      "pool (round-robin): qwen, bedrock · anthropic.claude-sonnet",
    );
  });

  test("returns undefined for an unknown shortcut", () => {
    expect(describeShortcut(data, "nope")).toBeUndefined();
  });
});
