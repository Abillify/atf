// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `POST /flows/write` must not destroy the file's comments.
 *
 * The editor round-trips a flow through JSON. Serialising that object back with
 * `stringify()` produced equivalent YAML and silently removed every comment —
 * and in these flow files the comments hold the reasoning (which override
 * ordering is deliberate, why a schema is forced, which incident led to a rule).
 * The written file then looked perfectly fine, so nothing signalled the loss.
 *
 * Exercised end-to-end against a real temp directory, so the route's read →
 * merge → atomic-write path is covered rather than just the merge helper.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse } from "yaml";
import { createFlowsRouter } from "../flows.js";
import type { FlowRegistry } from "../../graph/flow-parser.js";

const FLOW_YAML = `# Coach flow — the comments below are operational knowledge.
id: coach
name: Coach

nodes:
  - id: classify
    type: classifier
    classifierSchema:
      classKey: intent
      schema:
        type: object
  # PRAEZEDENZ: der ERSTE passende override gewinnt. Diese Reihenfolge ist eine
  # fachliche Entscheidung, keine Kosmetik — wer sie "aufraeumt", aendert das
  # Verhalten fuer Nutzer mit Mehrfachmitgliedschaft.
  - id: respond
    type: llm
    llm:
      provider: openai
      model: gpt-4o # bewusst das teure Modell
edges:
  - source: classify
    target: respond
`;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiperator-flows-write-"));
  fs.writeFileSync(path.join(dir, "coach.yaml"), FLOW_YAML, "utf-8");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function emptyRegistry(): FlowRegistry {
  return {
    get: () => undefined,
    list: () => [],
  } as unknown as FlowRegistry;
}

function app() {
  const a = new Hono();
  a.route(
    "/",
    createFlowsRouter({
      fileRegistry: emptyRegistry(),
      flowsDir: dir,
    }),
  );
  return a;
}

const write = (definition: unknown, id = "coach") => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ id, format: "yaml", definition }),
});

const readFlow = (): string =>
  fs.readFileSync(path.join(dir, "coach.yaml"), "utf-8");

const currentDefinition = (): Record<string, unknown> =>
  parse(FLOW_YAML) as Record<string, unknown>;

// ---------------------------------------------------------------------------

describe("POST /flows/write preserves comments", () => {
  test("an unchanged save leaves the file byte-identical", async () => {
    const res = await app().request("/flows/write", write(currentDefinition()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commentsPreserved: boolean };
    expect(body.commentsPreserved).toBe(true);
    expect(readFlow()).toBe(FLOW_YAML);
  });

  test("editing a model keeps every comment and applies the change", async () => {
    const def = currentDefinition();
    const nodes = def.nodes as Record<string, unknown>[];
    const node1 = nodes[1];
    if (node1 === undefined) throw new Error("expected a second node");
    (node1.llm as Record<string, unknown>).model = "gpt-4o-mini";

    const res = await app().request("/flows/write", write(def));
    expect(res.status).toBe(200);

    const written = readFlow();
    expect(written).toContain("model: gpt-4o-mini");
    // The operational knowledge survives — this is the whole point.
    expect(written).toContain("Coach flow — the comments below");
    expect(written).toContain("PRAEZEDENZ: der ERSTE passende override gewinnt");
    expect(written).toContain("fachliche Entscheidung, keine Kosmetik");
    expect(written).toContain("bewusst das teure Modell");
    // And the file still parses to exactly what was submitted.
    expect(parse(written)).toEqual(def);
  });

  test("the response and audit entry report that comments were preserved", async () => {
    const recorded: { action: string; details?: Record<string, unknown> }[] = [];
    const a = new Hono();
    a.route(
      "/",
      createFlowsRouter({
        fileRegistry: emptyRegistry(),
        flowsDir: dir,
        auditLog: {
          record: (e: { action: string; details?: Record<string, unknown> }) => {
            recorded.push(e);
          },
        } as never,
      }),
    );

    await a.request("/flows/write", write(currentDefinition()));
    const entry = recorded.find((e) => e.action === "flows.write");
    expect(entry?.details?.commentsPreserved).toBe(true);
  });

  test("a brand-new file is written plainly and says so", async () => {
    const def = {
      id: "fresh",
      name: "Fresh",
      nodes: [{ id: "answer", type: "llm" }],
      edges: [],
    };
    const res = await app().request("/flows/write", write(def, "fresh"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commentsPreserved: boolean };
    // Nothing existed, so nothing was preserved — reported honestly rather than
    // claiming success.
    expect(body.commentsPreserved).toBe(false);
    expect(parse(fs.readFileSync(path.join(dir, "fresh.yaml"), "utf-8"))).toEqual(
      def,
    );
  });

  test("an unparseable existing file falls back instead of refusing the save", async () => {
    fs.writeFileSync(path.join(dir, "broken.yaml"), "id: [unclosed\n", "utf-8");
    const def = {
      id: "broken",
      name: "Broken",
      nodes: [{ id: "answer", type: "llm" }],
      edges: [],
    };
    const res = await app().request("/flows/write", write(def, "broken"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commentsPreserved: boolean };
    expect(body.commentsPreserved).toBe(false);
    expect(
      parse(fs.readFileSync(path.join(dir, "broken.yaml"), "utf-8")),
    ).toEqual(def);
  });

  test("removing a node drops its comment but keeps the others", async () => {
    const def = currentDefinition();
    const nodes = def.nodes as Record<string, unknown>[];
    const node0 = nodes[0];
    if (node0 === undefined) throw new Error("expected a first node");
    def.nodes = [node0]; // keep classify, drop respond
    def.edges = [];

    await app().request("/flows/write", write(def));
    const written = readFlow();
    expect(written).not.toContain("id: respond");
    expect(written).not.toContain("PRAEZEDENZ");
    expect(written).toContain("Coach flow — the comments below");
  });
});
