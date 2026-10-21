// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for unknown node `config` key detection
 * (src/graph/flow-config-keys.ts).
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
  COMMON_CONFIG_FIELDS,
  nodeTypeDoc,
} from "../node-type-catalog.js";
import {
  findUnknownConfigKeys,
  formatUnknownConfigKey,
  knownConfigKeys,
} from "../flow-config-keys.js";
import { parseFlowFile } from "../../util/parse-flow-file.js";

describe("knownConfigKeys", () => {
  test("returns the common keys plus the type's own keys", () => {
    const keys = knownConfigKeys("llm");
    expect(keys).toBeDefined();
    for (const f of COMMON_CONFIG_FIELDS) expect(keys?.has(f.key)).toBe(true);
    for (const f of nodeTypeDoc("llm")?.config ?? [])
      expect(keys?.has(f.key)).toBe(true);
  });

  test("undefined for a type outside the catalog", () => {
    expect(knownConfigKeys("custom-plugin")).toBeUndefined();
  });
});

describe("findUnknownConfigKeys", () => {
  test("(a) a typo on an llm node is reported with a suggestion", () => {
    const found = findUnknownConfigKeys([
      {
        id: "answer",
        type: "llm",
        config: { maxToolSteps: 3, toolArgz: {} },
      },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.key).toBe("toolArgz");
    expect(found[0]?.suggestion).toBe("toolArgs");
    expect(found[0]?.nodeIndex).toBe(0);
    expect(found[0]?.nodeId).toBe("answer");
  });

  test("(b) x-prefixed annotation keys are never reported", () => {
    const found = findUnknownConfigKeys([
      { id: "n", type: "llm", config: { "x-note": "handover" } },
    ]);
    expect(found).toEqual([]);
  });

  test("(c) a node type outside the catalog reports nothing", () => {
    const found = findUnknownConfigKeys([
      { id: "n", type: "custom-plugin", config: { anything: 1 } },
    ]);
    expect(found).toEqual([]);
  });

  test("(d) a common key on a tool node is not reported", () => {
    const first = COMMON_CONFIG_FIELDS[0];
    expect(first).toBeDefined();
    const found = findUnknownConfigKeys([
      { id: "t", type: "tool", config: { [first.key]: true } },
    ]);
    expect(found).toEqual([]);
  });

  test("(e) the example flows have no unknown config keys", () => {
    const dir = path.join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "..",
      "deploy",
      "examples",
      "flows",
    );
    const files = [
      "02-routed-support.yaml",
      "03-grounded-retrieval.yaml",
      "04-tool-use-with-approval.yaml",
      "05-support-assistant.yaml",
      "quickstart.yaml",
    ];
    for (const name of files) {
      const raw = parseFlowFile(path.join(dir, name)) as {
        nodes: Array<{ id: string; type: string; config?: unknown }>;
      };
      const unknown = findUnknownConfigKeys(raw.nodes);
      expect(unknown.map((u) => `${name} ${u.nodeId}.${u.key}`)).toEqual([]);
    }
  });

  test("results are sorted by node index, then key", () => {
    const found = findUnknownConfigKeys([
      { id: "a", type: "llm", config: { zzzTypo: 1, aaaTypo: 2 } },
      { id: "b", type: "llm", config: { midTypo: 3 } },
    ]);
    expect(found.map((u) => `${u.nodeId}.${u.key}`)).toEqual([
      "a.aaaTypo",
      "a.zzzTypo",
      "b.midTypo",
    ]);
  });
});

describe("formatUnknownConfigKey", () => {
  test("names the key and type, with a suggestion when present", () => {
    expect(
      formatUnknownConfigKey({
        nodeIndex: 0,
        nodeId: "a",
        nodeType: "llm",
        key: "toolArgz",
        suggestion: "toolArgs",
      }),
    ).toBe(
      'Unknown config key "toolArgz" for node type "llm" — the runtime ignores it. Did you mean "toolArgs"?',
    );
    expect(
      formatUnknownConfigKey({
        nodeIndex: 0,
        nodeId: "a",
        nodeType: "llm",
        key: "totallyDifferent",
      }),
    ).toBe(
      'Unknown config key "totallyDifferent" for node type "llm" — the runtime ignores it.',
    );
  });
});
