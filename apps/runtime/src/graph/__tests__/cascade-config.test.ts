// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `config.cascade` of an `llm` node: shape validation, expansion of the
 * `escalateTo` shortcut by the loader, and the load error for an unknown one.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFlowParserService } from "../flow-parser.js";
import { CascadeConfigSchema } from "../flow-parser/validate.js";
import { getFlowLoadFailures, resetFlowLoadFailures } from "../flow-parser/validate.js";
import { resolveModelShortcuts, type ModelShortcutsData } from "../flow-parser/model-shortcuts.js";
import { nodeTypeDoc } from "../node-type-catalog.js";
import { knownConfigKeys } from "../flow-config-keys.js";

const MODEL = { provider: "openai", model: "pro-model" };

describe("CascadeConfigSchema", () => {
  test("accepts escalateTo alone and with every condition", () => {
    expect(CascadeConfigSchema.safeParse({ escalateTo: MODEL }).success).toBe(true);
    expect(
      CascadeConfigSchema.safeParse({
        escalateTo: MODEL,
        when: { minCitations: 2, sourcesCheckFailed: false, maxTopScore: 0.35, finishReasonLength: true },
      }).success,
    ).toBe(true);
  });

  test("rejects a missing or incomplete escalateTo", () => {
    expect(CascadeConfigSchema.safeParse({}).success).toBe(false);
    expect(CascadeConfigSchema.safeParse({ escalateTo: { provider: "openai" } }).success).toBe(false);
    // An unexpanded shortcut has no provider/model.
    expect(CascadeConfigSchema.safeParse({ escalateTo: { shortcut: "pro" } }).success).toBe(false);
  });

  test("rejects out-of-range values and unknown keys", () => {
    for (const when of [
      { minCitations: -1 },
      { minCitations: 1.5 },
      { maxTopScore: 1.5 },
      { maxTopScore: -0.1 },
      { sourcesCheckFailed: "yes" },
      { finishReasonLength: 1 },
      { minCitation: 1 },
    ]) {
      expect(CascadeConfigSchema.safeParse({ escalateTo: MODEL, when }).success, JSON.stringify(when)).toBe(false);
    }
    expect(CascadeConfigSchema.safeParse({ escalateTo: MODEL, escalate_to: MODEL }).success).toBe(false);
  });
});

describe("the catalog", () => {
  test("documents cascade as a config key of the llm node", () => {
    expect(knownConfigKeys("llm")?.has("cascade")).toBe(true);
    const field = nodeTypeDoc("llm")?.config.find((f) => f.key === "cascade");
    expect(field?.fields?.map((f) => f.key)).toEqual(["escalateTo", "when"]);
    expect(field?.fields?.find((f) => f.key === "escalateTo")?.kind).toBe("llm");
  });
});

describe("shortcut expansion", () => {
  const shortcuts: ModelShortcutsData = {
    engines: { cloud: { provider: "bedrock" } },
    modelPresets: { flash: { model: "example/flash" }, pro: { model: "example/pro", parameters: { maxTokens: 2048 } } },
    shortcuts: { flash: { engine: "cloud", model: "flash" }, pro: { engine: "cloud", model: "pro" } },
  };

  test("config.cascade.escalateTo is expanded like node.llm", () => {
    const raw = {
      nodes: [
        {
          id: "answer",
          type: "llm",
          llm: { shortcut: "flash" },
          config: { cascade: { escalateTo: { shortcut: "pro" }, when: { minCitations: 1 } } },
        },
      ],
    } as Record<string, unknown>;
    resolveModelShortcuts(raw, shortcuts, "flow.yaml");
    const node = (raw.nodes as Array<{ llm: unknown; config: { cascade: { escalateTo: Record<string, unknown> } } }>)[0];
    expect(node?.config.cascade.escalateTo).toMatchObject({
      provider: "bedrock",
      model: "example/pro",
      parameters: { maxTokens: 2048 },
    });
    expect(node?.config.cascade.escalateTo.shortcut).toBeUndefined();
    expect(CascadeConfigSchema.safeParse(node?.config.cascade).success).toBe(true);
  });
});

describe("loading flows with a cascade", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    resetFlowLoadFailures();
  });

  function workspace(escalateTo: unknown): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-"));
    fs.writeFileSync(
      path.join(d, "model-shortcuts.yaml"),
      [
        "engines:",
        "  cloud: { provider: bedrock }",
        "modelPresets:",
        "  flash: { model: example/flash }",
        "  pro: { model: example/pro }",
        "shortcuts:",
        "  flash: { engine: cloud, model: flash }",
        "  pro: { engine: cloud, model: pro }",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(d, "answer.json"),
      JSON.stringify({
        id: "answer",
        name: "Answer",
        nodes: [
          {
            id: "a",
            type: "llm",
            llm: { shortcut: "flash" },
            config: { cascade: { escalateTo } },
          },
        ],
        edges: [],
      }),
    );
    return d;
  }

  async function load(d: string) {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const service = createFlowParserService(d);
      await service.start();
      const flow = service.getRegistry().get("answer");
      await service.stop();
      return flow;
    } finally {
      stderr.mockRestore();
    }
  }

  test("a known shortcut is resolved when the flow loads", async () => {
    dir = workspace({ shortcut: "pro" });
    const flow = await load(dir);
    const cascade = (flow?.nodes[0]?.config as { cascade?: { escalateTo?: Record<string, unknown> } } | undefined)?.cascade;
    expect(cascade?.escalateTo).toMatchObject({ provider: "bedrock", model: "example/pro" });
  });

  test("an unknown shortcut is a load error and the flow is not registered", async () => {
    dir = workspace({ shortcut: "does-not-exist" });
    const flow = await load(dir);
    expect(flow).toBeUndefined();
    expect(getFlowLoadFailures().map((f) => f.file)).toEqual(["answer.json"]);
  });

  test("an escalateTo without a model is a load error", async () => {
    dir = workspace({ provider: "openai" });
    expect(await load(dir)).toBeUndefined();
  });
});
