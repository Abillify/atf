// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { materializeStoredFlow } from "../flow-registry-composite.js";
import type { FlowDefinition } from "../../types/flow.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-materialize-"));
  fs.writeFileSync(
    path.join(dir, "model-shortcuts.yaml"),
    `engines:\n  local: { provider: openai }\nmodelPresets:\n  small: { model: example/small }\nshortcuts:\n  local-small: { engine: local, model: small }\n`,
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("materializeStoredFlow (online flows saved in source form)", () => {
  test("expands a shortcut referenced through a variable", () => {
    const stored = {
      id: "online",
      name: "Online",
      variables: { model_main: "local-small" },
      nodes: [{ id: "a", type: "llm", llm: { shortcut: "{{vars.model_main}}" } }],
      edges: [],
    } as unknown as FlowDefinition;
    const runtime = materializeStoredFlow(stored, dir);
    expect(runtime.nodes[0]?.llm).toMatchObject({ provider: "openai", model: "example/small" });
    // the stored record itself is untouched
    const storedLlm = stored.nodes[0]?.llm as { shortcut?: string } | undefined;
    expect(storedLlm?.shortcut).toBe("{{vars.model_main}}");
  });

  test("passes an already-expanded definition through", () => {
    const stored: FlowDefinition = {
      id: "plain",
      name: "Plain",
      nodes: [{ id: "a", type: "llm", llm: { provider: "openai", model: "m" } }],
      edges: [],
    };
    expect(materializeStoredFlow(stored, dir)).toMatchObject(stored);
  });

  test("keeps the stored definition when it cannot be expanded", () => {
    const broken = {
      id: "broken",
      name: "Broken",
      nodes: [{ id: "a", type: "llm", llm: { shortcut: "does-not-exist" } }],
      edges: [],
    } as unknown as FlowDefinition;
    expect(materializeStoredFlow(broken, dir)).toBe(broken);
  });
});
