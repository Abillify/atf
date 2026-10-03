// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for classification-access: non-destructive per-node / per-turn
 * classifier output, and the dotted/[n]/hyphen path + template resolvers.
 */
import { describe, test, expect } from "bun:test";
import {
  appendNodeClassification,
  buildClassificationNamespaces,
  resolveStatePath,
  renderTemplateAggressive,
  renderTemplateNamespaced,
  type TurnSnapshot,
} from "../classification-access.js";

describe("appendNodeClassification", () => {
  test("multiple classifiers in one run accumulate into the same snapshot", () => {
    let turns: TurnSnapshot[] = [];
    turns = appendNodeClassification(turns, "triage", { route: "CLIENTS" }, "CLIENTS");
    turns = appendNodeClassification(
      turns,
      "refine-client",
      { client: "Example Logistics" },
      "CLIENTS",
    );
    expect(turns.length).toBe(1);
    const turn0 = turns[0];
    if (turn0 === undefined) throw new Error("expected a first turn");
    const triage = turn0.triage;
    const refineClient = turn0["refine-client"];
    if (triage === undefined || refineClient === undefined) {
      throw new Error("expected triage and refine-client entries");
    }
    expect(triage.classification.route).toBe("CLIENTS");
    expect(refineClient.classification.client).toBe("Example Logistics");
  });

  test("a re-run of the same classifier node starts a NEW turn snapshot", () => {
    let turns: TurnSnapshot[] = [];
    // turn 1
    turns = appendNodeClassification(turns, "triage", { route: "RETOURE" }, "RETOURE");
    turns = appendNodeClassification(
      turns,
      "refine-client",
      { client: "Example Finance" },
      "RETOURE",
    );
    // turn 2 — triage runs again → boundary detected
    turns = appendNodeClassification(turns, "triage", { route: "BETRIEB" }, "BETRIEB");
    expect(turns.length).toBe(2);
    const [turn0, turn1] = turns;
    if (turn0 === undefined || turn1 === undefined) {
      throw new Error("expected two turns");
    }
    const triage0 = turn0.triage;
    const triage1 = turn1.triage;
    if (triage0 === undefined || triage1 === undefined) {
      throw new Error("expected triage entries in both turns");
    }
    expect(triage0.classification.route).toBe("RETOURE");
    expect(triage1.classification.route).toBe("BETRIEB");
    // turn 1's refine-client is preserved, turn 2 has no refine-client yet
    expect(turn0["refine-client"]).toBeDefined();
    expect(turn1["refine-client"]).toBeUndefined();
  });

  test("does not mutate the input array", () => {
    const turns: TurnSnapshot[] = [];
    const next = appendNodeClassification(turns, "triage", { route: "X" }, "X");
    expect(turns.length).toBe(0);
    expect(next.length).toBe(1);
  });
});

describe("buildClassificationNamespaces", () => {
  test("node = current run; turn[0] = current, turn[1] = previous", () => {
    let turns: TurnSnapshot[] = [];
    turns = appendNodeClassification(turns, "triage", { route: "RETOURE" }, "RETOURE");
    turns = appendNodeClassification(turns, "triage", { route: "CLIENTS" }, "CLIENTS");
    const { node, turn } = buildClassificationNamespaces(turns);
    const nodeTriage = node.triage;
    const [turn0, turn1] = turn;
    if (nodeTriage === undefined || turn0 === undefined || turn1 === undefined) {
      throw new Error("expected node and two turn entries");
    }
    const turn0Triage = turn0.triage;
    const turn1Triage = turn1.triage;
    if (turn0Triage === undefined || turn1Triage === undefined) {
      throw new Error("expected triage entries in both turns");
    }
    expect(nodeTriage.classification.route).toBe("CLIENTS"); // current
    expect(turn0Triage.classification.route).toBe("CLIENTS"); // current
    expect(turn1Triage.classification.route).toBe("RETOURE"); // previous
  });

  test("empty history yields empty node and turn", () => {
    const { node, turn } = buildClassificationNamespaces([]);
    expect(node).toEqual({});
    expect(turn).toEqual([]);
  });
});

describe("resolveStatePath", () => {
  const root = {
    node: {
      triage: { classification: { route: "CLIENTS" } },
      "refine-client": { classification: { client: "Example Logistics" } },
    },
    turn: [
      { triage: { classification: { route: "CLIENTS" } } },
      { triage: { classification: { route: "RETOURE" } } },
    ],
  };

  test("dotted path", () => {
    expect(resolveStatePath(root, "node.triage.classification.route")).toBe("CLIENTS");
  });
  test("hyphenated segment", () => {
    expect(resolveStatePath(root, "node.refine-client.classification.client")).toBe(
      "Example Logistics",
    );
  });
  test("[n] index (previous turn)", () => {
    expect(resolveStatePath(root, "turn[1].triage.classification.route")).toBe("RETOURE");
  });
  test("missing path → undefined", () => {
    expect(resolveStatePath(root, "node.nope.classification.route")).toBeUndefined();
    expect(resolveStatePath(root, "turn[9].triage.classification.route")).toBeUndefined();
  });
});

describe("renderTemplateAggressive", () => {
  const ctx = {
    node: { triage: { classification: { route: "CLIENTS" } } },
    turn: [{ triage: { classification: { route: "CLIENTS" } } }],
  };
  test("replaces known path and blanks unknown", () => {
    expect(renderTemplateAggressive("{{node.triage.classification.route}}", ctx)).toBe(
      "CLIENTS",
    );
    expect(renderTemplateAggressive("[{{does.not.exist}}]", ctx)).toBe("[]");
  });
});

describe("renderTemplateNamespaced", () => {
  const roots = {
    context: { userName: "Ada" },
    now: { date: "2026-07-18" },
    node: { triage: { classification: { route: "CLIENTS" } } },
    turn: [
      { triage: { classification: { route: "CLIENTS" } } },
      { triage: { classification: { route: "RETOURE" } } },
    ],
  };
  test("resolves known roots (context/now/node/turn)", () => {
    expect(renderTemplateNamespaced("Hi {{context.userName}} ({{now.date}})", roots)).toBe(
      "Hi Ada (2026-07-18)",
    );
    expect(
      renderTemplateNamespaced("{{node.triage.classification.route}}", roots),
    ).toBe("CLIENTS");
    expect(
      renderTemplateNamespaced("{{turn[1].triage.classification.route}}", roots),
    ).toBe("RETOURE");
  });
  test("leaves unknown roots INTACT", () => {
    expect(renderTemplateNamespaced("keep {{vars.x}} and {{weird}}", roots)).toBe(
      "keep {{vars.x}} and {{weird}}",
    );
  });
  test("known root, missing sub-path → empty string", () => {
    expect(renderTemplateNamespaced("[{{context.nope}}]", roots)).toBe("[]");
  });
});
