// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, test, expect, vi } from "vitest";
import {
  buildVocabulary,
  referencedPaths,
  renderTemplatePreview,
  setPath,
  parseSampleValue,
} from "../lib/formula";
import { FormulaInput, FormulaProvider, FormulaTextarea } from "../components/FormulaEditor";
import type { FlowDefinition } from "../types/flow";
// The runtime's reference data — the same source the Studio receives with the
// node type catalog and docs/FLOWS.md is generated from.
import { FLOW_REFERENCE } from "../../../runtime/src/graph/flow-reference-data";

vi.mock("../lib/auth/useAuth", () => ({
  useAuth: () => ({ token: undefined, ready: true, isAuthenticated: true }),
}));

const flow: Pick<FlowDefinition, "nodes" | "variables"> = {
  variables: { model_main: "fast-pool", _comment: "hidden" },
  nodes: [
    {
      id: "triage",
      type: "classifier",
      classifierSchema: {
        classKey: "route",
        schema: { type: "object", properties: { route: { type: "string", enum: ["INKASSO", "BETRIEB"] }, needsInfo: { type: "boolean" } } },
      },
    },
    { id: "refine-client", type: "classifier", classifierSchema: { classKey: "client", schema: { type: "object", properties: { client: { type: "string" } } } } },
    { id: "client-map", type: "transform", config: { derive: [{ from: "client", lookup: { a: { clientTaiga: "x" } } }] } },
  ],
};

describe("formula vocabulary", () => {
  test("offers flow variables, classification fields, node outputs and time for templates", () => {
    const paths = buildVocabulary(flow, "template", FLOW_REFERENCE).flatMap((g) => g.symbols.map((s) => s.path));
    expect(paths).toEqual(
      expect.arrayContaining([
        "vars.model_main",
        "classification.route",
        "classification.needsInfo",
        "classification.clientTaiga",
        "node.triage.classification.route",
        "turn[1].triage.classification.route",
        "query",
        "context.userEmail",
        "now.date",
      ]),
    );
    expect(paths).not.toContain("vars._comment");
  });

  test("conditions get run-state fields and mark hyphenated node ids unusable", () => {
    const symbols = buildVocabulary(flow, "condition", FLOW_REFERENCE).flatMap((g) => g.symbols);
    expect(symbols.map((s) => s.path)).toEqual(expect.arrayContaining(["lastMessageText", "messageCount", "params.<name>"]));
    expect(symbols.find((s) => s.path === "node.refine-client.classification.client")?.unavailable).toBeDefined();
    expect(symbols.find((s) => s.path === "node.triage.classification.route")?.unavailable).toBeUndefined();
  });

  test("finds referenced paths, ignoring literals, keywords and methods", () => {
    expect(
      referencedPaths("classification.route == 'a.b' && groups.includes('x') && lastMessageText.length > 3 || !hasErrors == true", "condition"),
    ).toEqual(["classification.route", "groups", "lastMessageText", "hasErrors"]);
    expect(referencedPaths("Hallo {{context.userName}}, heute {{now.date}} {{turn[1].triage.classification.route}}", "template")).toEqual([
      "context.userName",
      "now.date",
      "turn[1].triage.classification.route",
    ]);
  });

  test("renders a template preview with variables, sample values and reports gaps", () => {
    const sample = setPath({}, "turn[1].triage.classification.route", "INKASSO");
    const out = renderTemplatePreview("{{vars.model_main}} / {{turn[1].triage.classification.route}} / {{query}}", sample, flow.variables);
    expect(out.text).toBe("fast-pool / INKASSO / ");
    expect(out.unresolved).toEqual(["query"]);
    expect(parseSampleValue("2")).toBe(2);
    expect(parseSampleValue("true")).toBe(true);
    expect(parseSampleValue("Hallo")).toBe("Hallo");
  });
});

describe("formula components", () => {
  test("the ƒx picker inserts a variable at the cursor", () => {
    const onChange = vi.fn();
    render(
      <FormulaProvider flow={flow} reference={FLOW_REFERENCE}>
        <FormulaInput ariaLabel="Message" value="Hallo !" onChange={onChange} />
      </FormulaProvider>,
    );
    // ƒx opens the expression builder right away.
    fireEvent.click(screen.getByRole("button", { name: "Open the expression builder for Message" }));
    const dialog = screen.getByRole("dialog");
    const area = within(dialog).getByLabelText("Message") as HTMLTextAreaElement;
    area.setSelectionRange(6, 6);
    fireEvent.click(within(dialog).getByText("{{context.userName}}"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenCalledWith("Hallo {{context.userName}}!");
  });

  test("the condition editor evaluates with sample values via the runtime and applies", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ valid: true, result: true }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    const onChange = vi.fn();
    render(
      <FormulaProvider flow={flow} reference={FLOW_REFERENCE}>
        <FormulaTextarea kind="condition" ariaLabel="Condition" value="classification.route == 'INKASSO'" onChange={onChange} />
      </FormulaProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open the formula editor for Condition" }));
    const dialog = await screen.findByRole("dialog");
    // pre-filled from the classifier enum
    expect((screen.getByLabelText("Sample value for classification.route") as HTMLInputElement).value).toBe("INKASSO");
    await waitFor(() => expect(screen.getByText(/true — would match/)).toBeInTheDocument());
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)![1].body)) as { sample: unknown };
    expect(body.sample).toEqual({ classification: { route: "INKASSO" } });
    fireEvent.click(screen.getByRole("button", { name: "and" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenCalledWith(expect.stringContaining(" && "));
    expect(dialog).not.toBeInTheDocument();
  });
});

describe("single-value fields", () => {
  test("a picked variable replaces a number instead of being appended", async () => {
    const { NumberOrVarInput } = await import("../components/form-controls");
    const onChange = vi.fn();
    render(
      <FormulaProvider flow={{ nodes: [], variables: { max_tokens: 4096 } }} reference={FLOW_REFERENCE}>
        <NumberOrVarInput label="Max tokens" value={2048} onChange={onChange} />
      </FormulaProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open the expression builder for Max tokens" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByText("{{vars.max_tokens}}"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenLastCalledWith("{{vars.max_tokens}}");
  });
});
