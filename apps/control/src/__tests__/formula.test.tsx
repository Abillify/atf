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
import { FormulaInput, FormulaProvider, FormulaTextarea, describeEditorSelection } from "../components/FormulaEditor";
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

describe("expression builder: data context and help", () => {
  const catalog = {
    reference: FLOW_REFERENCE,
    constants: { budget: 300 },
    publicEnv: { FLOW_PUBLIC_REGION: "eu" },
  };

  test("a plain field offers every group; run-time values are shown but disabled with the reason", () => {
    const groups = buildVocabulary(flow, "vars", catalog);
    const titles = groups.map((g) => g.title);
    for (const t of ["Flow variables", "Constants", "Environment", "Node results", "Latest classification", "Request & user", "Date & time (Europe/Berlin)", "Calculation"]) {
      expect(titles).toContain(t);
    }
    const all = groups.flatMap((g) => g.symbols);
    expect(all.find((s) => s.path === "const.budget")).toMatchObject({ insert: "{{const.budget}}", calcInsert: "const.budget" });
    expect(all.find((s) => s.path === "vars.model_main")?.unavailable).toBeUndefined();
    const nodeField = all.find((s) => s.path === "node.triage.classification.route");
    expect(nodeField?.section).toBe("triage (classifier)");
    expect(nodeField?.unavailable).toMatch(/resolved once when the flow loads/);
    expect(all.find((s) => s.path === "context.userName")?.unavailable).toMatch(/run time/);
  });

  test("in conditions a flow variable is inserted as {{vars.x}} (conditions have no vars root)", () => {
    const sym = buildVocabulary(flow, "condition", catalog).flatMap((g) => g.symbols).find((s) => s.path === "vars.model_main");
    expect(sym?.insert).toBe("{{vars.model_main}}");
  });

  test("the builder shows node results as a tree, examples, clear, and calculation help", () => {
    const onChange = vi.fn();
    render(
      <FormulaProvider flow={flow} catalog={catalog}>
        <FormulaInput kind="vars" ariaLabel="Setting" value="x" onChange={onChange} />
      </FormulaProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open the expression builder for Setting" }));
    const dialog = screen.getByRole("dialog");
    // Node results: per-node section, collapsed until opened.
    fireEvent.click(within(dialog).getByRole("button", { name: /Node results/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: /triage \(classifier\)/ }));
    expect(within(dialog).getByText("{{node.triage.classification.route}}").closest("button")).toBeDisabled();
    // Clear, then an example, then a function from the help.
    fireEvent.click(within(dialog).getByRole("button", { name: /Clear/ }));
    fireEvent.click(within(dialog).getByText("{{const.research_max_tokens}}"));
    const area = within(dialog).getByLabelText("Setting") as HTMLTextAreaElement;
    expect(area.value).toBe("{{const.research_max_tokens}}");
    fireEvent.click(within(dialog).getByRole("button", { name: /Clear/ }));
    fireEvent.click(within(dialog).getByText("How calculations work"));
    fireEvent.click(within(dialog).getByRole("button", { name: "round(x, digits)" }));
    expect(area.value).toBe("{{= round() }}");
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenLastCalledWith("{{= round() }}");
  });

  test("a field with load-time references shows what it resolves to when the flow loads", async () => {
    const evaluateVariables = vi.fn(async (vars: Record<string, unknown>) => ({
      values: { ...vars, __studio_draft__: 150 },
      errors: [],
    }));
    render(
      <FormulaProvider flow={flow} catalog={catalog} evaluateVariables={evaluateVariables}>
        <FormulaInput kind="vars" ariaLabel="Budget" value="{{= const.budget / 2 }}" onChange={() => {}} />
      </FormulaProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open the expression builder for Budget" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("When the flow loads")).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByText("150")).toBeInTheDocument());
    expect(evaluateVariables.mock.calls[0]?.[0]).toMatchObject({
      model_main: "fast-pool",
      __studio_draft__: "{{= const.budget / 2 }}",
    });
  });
});

describe("expression builder: pinned run data", () => {
  const runSample = {
    executionId: "exec-1",
    flowId: "abby@studio-x",
    startedAt: "2026-09-25T10:00:00.000Z",
    preview: "Ist ein Parkplatz frei?",
    sample: {
      query: "Ist ein Parkplatz frei?",
      context: { userName: "Erika" },
      node: { triage: { classification: { route: "BETRIEB" } } },
      classification: { route: "BETRIEB" },
    },
  };

  test("a pinned run fills the tree and the run-time preview", () => {
    render(
      <FormulaProvider
        flow={flow}
        catalog={{ reference: FLOW_REFERENCE }}
        runs={{ flowId: "abby", pinned: runSample, onPin: () => {} }}
      >
        <FormulaTextarea
          kind="template"
          ariaLabel="Prompt"
          value="Hallo {{context.userName}}: {{node.triage.classification.route}}"
          onChange={() => {}}
        />
      </FormulaProvider>,
    );
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ traces: [] }) }) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole("button", { name: "Open the formula editor for Prompt" }));
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByLabelText("Pinned run") as HTMLSelectElement).value).toBe("exec-1");
    expect(within(dialog).getByText("Hallo Erika: BETRIEB")).toBeInTheDocument();
    // Usable here (a prompt), so the group is open; the node section opens on click.
    fireEvent.click(within(dialog).getByRole("button", { name: /triage \(classifier\)/ }));
    expect(within(dialog).getAllByText('📌 "BETRIEB"').length).toBeGreaterThan(0);
  });

  test("picking a recorded run pins it", async () => {
    const onPin = vi.fn();
    global.fetch = vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        String(url).includes("/sample")
          ? runSample
          : { traces: [{ execution_id: "exec-1", flow_id: "abby@studio-x", started_at: runSample.startedAt, status: "completed", preview: "Ist ein Parkplatz frei?" }] },
    })) as unknown as typeof fetch;
    render(
      <FormulaProvider flow={flow} catalog={{ reference: FLOW_REFERENCE }} runs={{ flowId: "abby", pinned: null, onPin }}>
        <FormulaTextarea kind="template" ariaLabel="Prompt" value="{{query}}" onChange={() => {}} />
      </FormulaProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open the formula editor for Prompt" }));
    const select = (await screen.findByLabelText("Pinned run")) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getByText(/Studio test · .* · Ist ein Parkplatz frei\?/)).toBeInTheDocument());
    fireEvent.change(select, { target: { value: "exec-1" } });
    await waitFor(() => expect(onPin).toHaveBeenCalledWith(runSample));
  });
});

describe("expression builder: copilot", () => {
  test("sends the field's data and grammar kind, shows a diff, and applies only on Accept", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/flows/expressions/copilot")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            expression: "classification.route == 'INKASSO' || classification.route == 'BETRIEB'",
            explanation: "BETRIEB ergänzt.",
            changed: true,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ valid: true, result: true }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const onChange = vi.fn();
    render(
      <FormulaProvider flow={flow} catalog={{ reference: FLOW_REFERENCE }}>
        <FormulaTextarea kind="condition" ariaLabel="Condition" value="classification.route == 'INKASSO'" onChange={onChange} />
      </FormulaProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open the formula editor for Condition" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Ask the expression copilot"), { target: { value: "auch BETRIEB" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Ask" }));

    const proposal = await within(dialog).findByLabelText("Copilot proposal");
    expect(within(proposal).getByText("BETRIEB ergänzt.")).toBeInTheDocument();
    const added = within(proposal).getByLabelText("Proposed change").querySelectorAll("ins");
    expect([...added].map((n) => n.textContent).join("")).toBe(" || classification.route == 'BETRIEB'");

    const call = fetchMock.mock.calls.find(([u]) => String(u).includes("/flows/expressions/copilot"));
    const body = JSON.parse(String((call?.[1] as RequestInit).body)) as {
      kind: string;
      current: string;
      vocabulary: Array<{ title: string; entries: Array<{ ref: string; unavailable?: string }> }>;
      variables: Record<string, unknown>;
    };
    expect(body.kind).toBe("condition");
    expect(body.current).toBe("classification.route == 'INKASSO'");
    const refs = body.vocabulary.flatMap((g) => g.entries.map((e) => e.ref));
    expect(refs).toEqual(expect.arrayContaining(["node.triage.classification.route", "lastMessageText", "{{vars.model_main}}"]));
    expect(body.variables).toMatchObject({ model_main: "fast-pool" });

    // Nothing applied yet; Accept puts the proposal into the editor.
    const area = within(dialog).getByLabelText("Condition") as HTMLTextAreaElement;
    expect(area.value).toBe("classification.route == 'INKASSO'");
    fireEvent.click(within(proposal).getByRole("button", { name: "Accept" }));
    expect(area.value).toBe("classification.route == 'INKASSO' || classification.route == 'BETRIEB'");
    expect(onChange).not.toHaveBeenCalled(); // the field changes only with Apply
  });

  test("sends the editor's cursor / selection so “this part” resolves", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, expression: "x", explanation: "", changed: false }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    render(
      <FormulaProvider flow={flow} catalog={{ reference: FLOW_REFERENCE }}>
        <FormulaTextarea kind="condition" ariaLabel="Condition" value="classification.route == 'INKASSO'" onChange={() => {}} />
      </FormulaProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open the formula editor for Condition" }));
    const dialog = screen.getByRole("dialog");
    const area = within(dialog).getByLabelText("Condition") as HTMLTextAreaElement;
    area.setSelectionRange(24, 33);
    fireEvent.select(area);
    expect(within(dialog).getByTestId("expression-copilot-selection")).toHaveTextContent("selected “'INKASSO'”");
    fireEvent.change(within(dialog).getByLabelText("Ask the expression copilot"), { target: { value: "use BETRIEB here" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.selection).toEqual({ start: 24, end: 33 });
  });

  test("describes a caret by line and column", () => {
    expect(describeEditorSelection("ab\ncd", { start: 4, end: 4 })).toBe("cursor at line 2, column 2");
    expect(describeEditorSelection("ab", { start: 2, end: 2 })).toBe("cursor at the end");
  });

  test("a failed proposal shows the runtime's reason", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 422,
      json: async () => ({ ok: false, message: "The proposal is not valid: Unknown variable" }),
    })) as unknown as typeof fetch;
    render(
      <FormulaProvider flow={flow} catalog={{ reference: FLOW_REFERENCE }}>
        <FormulaInput kind="vars" ariaLabel="Budget" value="" onChange={() => {}} />
      </FormulaProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open the expression builder for Budget" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Ask the expression copilot"), { target: { value: "x" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Ask" }));
    expect(await within(dialog).findByText(/Unknown variable/)).toBeInTheDocument();
  });
});
