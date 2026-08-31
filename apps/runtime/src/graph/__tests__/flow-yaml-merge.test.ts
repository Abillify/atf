// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Comment-preserving flow write-back.
 *
 * Saving a flow from the editor used to re-serialise the parsed object with
 * `stringify()`, which produced valid YAML and destroyed every comment — the
 * bundled flows carry hundreds of comment lines holding the *reasoning* (which
 * override ordering is deliberate, why a schema is forced, which incident led to
 * a rule), and the resulting file looked perfectly fine, so nothing signalled
 * the loss.
 *
 * These tests pin the merge behaviour, including the id-based sequence matching
 * that keeps a reordered array's comments attached to the right entry.
 */

import { describe, test, expect } from "bun:test";
import { parse, stringify } from "yaml";
import {
  mergeFlowIntoYaml,
  yamlHasComments,
  YamlMergeError,
} from "../flow-yaml-merge.js";

const FLOW = `# Flow-level rationale that must survive a UI save.
id: coach
name: Coach

# WARUM outputSchema erzwungen wird: deutsche Anfuehrungszeichen brachen
# JSON.parse im Proxy (Vorfall 2026-03).
strictOutput: true

nodes:
  # The classifier runs first — it is cheap and gates the expensive responder.
  - id: classify
    type: classifier
    llm:
      provider: google
      model: gemini-2.0-flash # deliberately the fast model
  # PRAEZEDENZ: der ERSTE passende override gewinnt. Die Reihenfolge unten ist
  # eine fachliche Entscheidung, keine Kosmetik.
  - id: respond
    type: llm
    llm:
      provider: openai
      model: gpt-4o
edges:
  - source: classify
    target: respond # default path
`;

const parsed = (): Record<string, unknown> =>
  parse(FLOW) as Record<string, unknown>;

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

// ---------------------------------------------------------------------------
// The regression itself
// ---------------------------------------------------------------------------

describe("the loss this prevents", () => {
  test("plain stringify() drops every comment (documents the old behaviour)", () => {
    const rewritten = stringify(parsed(), { lineWidth: 120 });
    expect(rewritten).not.toContain("#");
    expect(yamlHasComments(rewritten)).toBe(false);
    // ... while the source clearly had them.
    expect(yamlHasComments(FLOW)).toBe(true);
  });

  test("an unchanged round-trip through the merge keeps all comments", () => {
    const out = mergeFlowIntoYaml(FLOW, parsed());
    expect(out).toContain("Flow-level rationale that must survive a UI save");
    expect(out).toContain("WARUM outputSchema erzwungen wird");
    expect(out).toContain("deutsche Anfuehrungszeichen brachen");
    expect(out).toContain("The classifier runs first");
    expect(out).toContain("PRAEZEDENZ: der ERSTE passende override gewinnt");
    expect(out).toContain("deliberately the fast model");
    expect(out).toContain("default path");
  });

  test("an unchanged round-trip is byte-identical", () => {
    expect(mergeFlowIntoYaml(FLOW, parsed())).toBe(FLOW);
  });
});

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

describe("editing values", () => {
  test("changing a nested leaf keeps the surrounding comments", () => {
    const next = parsed();
    const nodes = next.nodes as Record<string, unknown>[];
    (at(nodes, 1).llm as Record<string, unknown>).model = "gpt-4o-mini";

    const out = mergeFlowIntoYaml(FLOW, next);
    expect(out).toContain("model: gpt-4o-mini");
    expect(out).not.toContain("model: gpt-4o\n");
    // The rationale above the edited node is untouched.
    expect(out).toContain("PRAEZEDENZ: der ERSTE passende override gewinnt");
    expect(out).toContain("The classifier runs first");
  });

  test("a changed leaf keeps its own trailing comment", () => {
    const next = parsed();
    const nodes = next.nodes as Record<string, unknown>[];
    (at(nodes, 0).llm as Record<string, unknown>).model = "gemini-2.5-flash";

    const out = mergeFlowIntoYaml(FLOW, next);
    expect(out).toContain("gemini-2.5-flash");
    expect(out).toContain("deliberately the fast model");
  });

  test("a new key is added without disturbing existing comments", () => {
    const next = parsed();
    next.description = "A coaching flow";

    const out = mergeFlowIntoYaml(FLOW, next);
    expect(out).toContain("description: A coaching flow");
    expect(out).toContain("WARUM outputSchema erzwungen wird");
  });

  test("a removed key takes its comment with it", () => {
    // The explanation belongs to the key; keeping it would leave a comment
    // describing something that no longer exists.
    const next = parsed();
    delete next.strictOutput;

    const out = mergeFlowIntoYaml(FLOW, next);
    expect(out).not.toContain("strictOutput");
    expect(out).not.toContain("WARUM outputSchema erzwungen wird");
    // Unrelated comments stay.
    expect(out).toContain("The classifier runs first");
  });

  test("the merged output still parses to exactly the new definition", () => {
    const next = parsed();
    next.name = "Renamed Coach";
    const nodes = next.nodes as Record<string, unknown>[];
    (at(nodes, 1).llm as Record<string, unknown>).model = "gpt-4.1";

    const out = mergeFlowIntoYaml(FLOW, next);
    expect(parse(out)).toEqual(next);
  });
});

// ---------------------------------------------------------------------------
// Sequence identity — the subtle part
// ---------------------------------------------------------------------------

describe("sequences are matched by id, not index", () => {
  test("reordering nodes moves a node's own comment WITH it", () => {
    const next = parsed();
    const nodes = next.nodes as Record<string, unknown>[];
    next.nodes = [at(nodes, 1), at(nodes, 0)]; // respond first now

    const out = mergeFlowIntoYaml(FLOW, next);

    // An index-based merge would have grafted the responder's precedence note
    // onto the classifier — a file that looks right while documenting the wrong
    // node. The note must still sit directly above `id: respond`.
    const respondAt = out.indexOf("id: respond");
    const classifyAt = out.indexOf("id: classify");
    const praezedenzAt = out.indexOf("PRAEZEDENZ");

    expect(respondAt).toBeLessThan(classifyAt);
    expect(praezedenzAt).toBeLessThan(respondAt);
    // And it is not left behind next to the classifier.
    expect(praezedenzAt).toBeLessThan(classifyAt);
  });

  test("removing a node removes its own comment", () => {
    const next = parsed();
    const nodes = next.nodes as Record<string, unknown>[];
    next.nodes = [at(nodes, 0)]; // keep classify, drop respond
    next.edges = [];

    const out = mergeFlowIntoYaml(FLOW, next);
    expect(out).not.toContain("id: respond");
    expect(out).not.toContain("PRAEZEDENZ");
    expect(out).toContain("id: classify");
  });

  test("KNOWN LIMITATION: the comment above the first entry belongs to the list", () => {
    // `yaml` attaches a comment preceding the first sequence entry to the
    // SEQUENCE, not to that entry — the position is genuinely ambiguous (list
    // heading vs. note on the first item). It therefore stays at the top of the
    // list even when that entry is removed. Asserted so the behaviour is known
    // rather than surprising; re-homing it would be guesswork that can silently
    // relocate a section heading.
    const next = parsed();
    const nodes = next.nodes as Record<string, unknown>[];
    next.nodes = [at(nodes, 1)]; // drop classify, whose note is first
    next.edges = [];

    const out = mergeFlowIntoYaml(FLOW, next);
    expect(out).not.toContain("id: classify");
    expect(out).toContain("The classifier runs first"); // stays at the list head
  });

  test("adding a node preserves the existing ones' comments", () => {
    const next = parsed();
    const nodes = next.nodes as Record<string, unknown>[];
    next.nodes = [...nodes, { id: "audit", type: "tool" }];

    const out = mergeFlowIntoYaml(FLOW, next);
    expect(out).toContain("id: audit");
    expect(out).toContain("The classifier runs first");
    expect(out).toContain("PRAEZEDENZ");
  });

  test("id-less sequence entries fall back to positional matching", () => {
    const yaml = `id: f
nodes:
  - id: fan
    type: parallel
    parallelNodes:
      - alpha # first source
      - beta # second source
`;
    const next = parse(yaml) as Record<string, unknown>;
    const out = mergeFlowIntoYaml(yaml, next);
    expect(out).toContain("first source");
    expect(out).toContain("second source");
    expect(parse(out)).toEqual(next);
  });
});

// ---------------------------------------------------------------------------
// Fallback behaviour
// ---------------------------------------------------------------------------

describe("merge base validation", () => {
  test("unparseable YAML is rejected so the caller can fall back", () => {
    expect(() => mergeFlowIntoYaml("id: [unclosed\n", { id: "f" })).toThrow(
      YamlMergeError,
    );
  });

  test("a non-mapping document is rejected", () => {
    expect(() => mergeFlowIntoYaml("- just\n- a list\n", { id: "f" })).toThrow(
      YamlMergeError,
    );
  });

  test("an empty existing file is rejected (nothing to merge into)", () => {
    expect(() => mergeFlowIntoYaml("", { id: "f" })).toThrow(YamlMergeError);
  });

  test("a comment-free file still merges correctly", () => {
    const plain = "id: f\nname: F\nnodes: []\nedges: []\n";
    const next = { id: "f", name: "G", nodes: [], edges: [] };
    const out = mergeFlowIntoYaml(plain, next);
    expect(parse(out)).toEqual(next);
  });

  test("a shape change from scalar to object is handled", () => {
    const yaml = "id: f\nllm: gpt-4o # was a bare string\n";
    const next = { id: "f", llm: { provider: "openai", model: "gpt-4o" } };
    const out = mergeFlowIntoYaml(yaml, next);
    expect(parse(out)).toEqual(next);
  });

  test("a shape change from object to scalar is handled", () => {
    const yaml = "id: f\nllm:\n  provider: openai\n";
    const next = { id: "f", llm: "gpt-4o" };
    expect(parse(mergeFlowIntoYaml(yaml, next))).toEqual(next);
  });
});

// ---------------------------------------------------------------------------
// yamlHasComments
// ---------------------------------------------------------------------------

describe("yamlHasComments", () => {
  test("detects leading, trailing and nested comments", () => {
    expect(yamlHasComments("# lead\nid: f\n")).toBe(true);
    expect(yamlHasComments("id: f # trailing\n")).toBe(true);
    expect(yamlHasComments("nodes:\n  - id: a # nested\n")).toBe(true);
  });

  test("returns false for genuinely comment-free YAML", () => {
    expect(yamlHasComments("id: f\nname: F\n")).toBe(false);
    expect(yamlHasComments("")).toBe(false);
  });

  test("a '#' inside a quoted string is not a comment", () => {
    expect(yamlHasComments('id: f\nprompt: "a # b"\n')).toBe(false);
  });
});
