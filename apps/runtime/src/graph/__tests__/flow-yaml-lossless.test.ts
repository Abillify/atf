// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect } from "bun:test";
import { parse } from "yaml";
import { mergeFlowIntoYaml, patchYamlLosslessly } from "../flow-yaml-merge.js";

const SRC = `id: f
# why: keep this
description: >
  A hand-wrapped folded paragraph that the yaml
  serializer would otherwise re-wrap at its own width.
nodes:
  - id: a
    type: llm
    label: Answer # trailing note
    llm:
      shortcut: "{{vars.model_main}}"
      parameters:
        temperature: 0.2
  - id: b
    type: router
edges:
  - source: a
    target: b
`;

describe("patchYamlLosslessly", () => {
  test("returns the text byte-for-byte when the content is unchanged", () => {
    expect(patchYamlLosslessly(SRC, parse(SRC))).toBe(SRC);
    expect(mergeFlowIntoYaml(SRC, parse(SRC))).toBe(SRC);
  });

  test("rewrites only the changed scalars", () => {
    const next = parse(SRC);
    next.nodes[0].label = "Answer v2";
    next.nodes[0].llm.parameters.temperature = 0.5;
    next.nodes[0].llm.shortcut = "{{vars.model_fast}}";
    const out = mergeFlowIntoYaml(SRC, next);
    expect(parse(out)).toEqual(next);
    const changed = SRC.split("\n").filter((l, i) => out.split("\n")[i] !== l);
    expect(changed).toEqual([
      "    label: Answer # trailing note",
      '      shortcut: "{{vars.model_main}}"',
      "        temperature: 0.2",
    ]);
    expect(out).toContain("label: Answer v2 # trailing note");
    expect(out).toContain("serializer would otherwise re-wrap at its own width.");
  });

  test("quotes a string that would not read back as a string in plain style", () => {
    const next = parse(SRC);
    next.nodes[0].label = "{{vars.label}}";
    const out = patchYamlLosslessly(SRC, next);
    expect(out).not.toBeNull();
    expect(parse(out!)).toEqual(next);
  });

  test("declines structural changes (left to the Document merge)", () => {
    const added = parse(SRC);
    added.nodes.push({ id: "c", type: "tool" });
    expect(patchYamlLosslessly(SRC, added)).toBeNull();

    const reordered = parse(SRC);
    reordered.nodes.reverse();
    expect(patchYamlLosslessly(SRC, reordered)).toBeNull();

    const newKey = parse(SRC);
    newKey.metadata = { ui: { layout: [] } };
    expect(patchYamlLosslessly(SRC, newKey)).toBeNull();
    // …and the merge still produces the right content
    expect(parse(mergeFlowIntoYaml(SRC, newKey))).toEqual(newKey);
  });
});
