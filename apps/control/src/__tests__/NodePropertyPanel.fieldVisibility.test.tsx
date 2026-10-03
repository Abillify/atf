// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Which node fields the panel offers is driven by the runtime's node type
 * catalog (`topLevel`), not by a second hand-maintained list in the UI — that
 * list drifted from the engine and offered settings the type never reads.
 *
 * A value that IS set stays visible even for a type that ignores it, with a
 * warning: hiding it would leave a dead setting in the flow file that looks
 * effective and could not be removed from the Studio.
 */

import { render, screen, cleanup } from "@testing-library/react";
import { describe, test, expect, vi } from "vitest";
import { NodePropertyPanel } from "../components/NodePropertyPanel";
import type { NodeTypeCatalog, NodeTypeDoc } from "../lib/node-types";
import type { FlowNode } from "../types/flow";

const doc = (
  type: string,
  topLevel: NodeTypeDoc["topLevel"],
): NodeTypeDoc => ({
  type,
  title: type,
  summary: "",
  description: "",
  whenToUse: [],
  topLevel,
  config: [],
  examples: [],
  notes: [],
});

const CATALOG: NodeTypeCatalog = {
  common: [],
  types: [
    doc("llm", [
      { key: "llm", usage: "recommended", description: "Model." },
      { key: "systemPrompt", usage: "recommended", description: "Prompt." },
      { key: "tools", usage: "optional", description: "Tools." },
    ]),
    doc("agent-harness", [
      { key: "llm", usage: "optional", description: "Planner model." },
      {
        key: "systemPrompt",
        usage: "optional",
        description: "Planner guidance; ignored when plannerless.",
      },
    ]),
    doc("router", [
      { key: "llm", usage: "ignored", description: "Not read." },
      { key: "tools", usage: "ignored", description: "Not read." },
    ]),
    doc("classifier", [
      { key: "llm", usage: "recommended", description: "Model." },
      { key: "priority", usage: "optional", description: "Queue priority." },
      { key: "overrides", usage: "ignored", description: "Not applied." },
    ]),
    doc("memory", []),
  ],
  tools: [],
  shortcuts: [],
  shortcutInfo: {},
  constants: {},
  publicEnv: {},
  models: [],
} as unknown as NodeTypeCatalog;

function renderPanel(node: FlowNode, catalog?: NodeTypeCatalog): HTMLElement {
  const { container } = render(
    <NodePropertyPanel
      node={node}
      edge={null}
      onNodeChange={vi.fn()}
      onDeleteNode={vi.fn()}
      onEdgeChange={vi.fn()}
      onDeleteEdge={vi.fn()}
      {...(catalog ? { catalog } : {})}
    />,
  );
  return container;
}

/** Titles of the collapsible sections the panel rendered. */
const sections = (container: HTMLElement): string[] =>
  [...container.querySelectorAll("summary")].map((s) => s.textContent ?? "");

const hasSection = (container: HTMLElement, re: RegExp): boolean =>
  sections(container).some((t) => re.test(t));

const prompt = () => screen.queryByRole("textbox", { name: "System prompt" });

describe("NodePropertyPanel — catalog-driven field visibility", () => {
  test("a type that reads the field gets it", () => {
    const c = renderPanel({ id: "answer", type: "llm" }, CATALOG);
    expect(prompt()).not.toBeNull();
    expect(hasSection(c, /^Model$/)).toBe(true);
    expect(hasSection(c, /^Tools \(/)).toBe(true);
  });

  test("a type that reads nothing but its config gets no model, prompt or tools", () => {
    const c = renderPanel({ id: "recall", type: "memory" }, CATALOG);
    expect(prompt()).toBeNull();
    expect(hasSection(c, /^Model$/)).toBe(false);
    expect(hasSection(c, /^Tools \(/)).toBe(false);
  });

  test("a field the type explicitly ignores is hidden while unset", () => {
    const c = renderPanel({ id: "route", type: "router" }, CATALOG);
    expect(hasSection(c, /^Model$/)).toBe(false);
    expect(hasSection(c, /^Tools \(/)).toBe(false);
    expect(prompt()).toBeNull();
  });

  test("an agent-harness keeps its prompt field — the planner reads it", () => {
    const c = renderPanel({ id: "orchestrator", type: "agent-harness" }, CATALOG);
    expect(prompt()).not.toBeNull();
    expect(hasSection(c, /^Model$/)).toBe(true);
    // The harness delegates tool use to its allowlist nodes.
    expect(hasSection(c, /^Tools \(/)).toBe(false);
  });

  test("a value set on a type that ignores it stays visible and is flagged", () => {
    const c = renderPanel(
      { id: "route", type: "router", tools: ["search"] } as FlowNode,
      CATALOG,
    );
    expect(hasSection(c, /^Tools \(/)).toBe(true);
    expect(screen.getByText(/does not read/)).toBeInTheDocument();
  });

  test("a field the type does read is not flagged", () => {
    renderPanel(
      { id: "answer", type: "llm", systemPrompt: "Hallo" } as FlowNode,
      CATALOG,
    );
    expect(screen.queryByText(/does not read/)).toBeNull();
  });

  test("without a catalog the panel keeps its previous defaults", () => {
    const harness = renderPanel({ id: "orchestrator", type: "agent-harness" });
    expect(prompt()).not.toBeNull();
    expect(hasSection(harness, /^Model$/)).toBe(false);

    const memory = renderPanel({ id: "recall", type: "memory" });
    expect(hasSection(memory, /^Model$/)).toBe(false);
  });

  test("priority is offered where the queue reads it and hidden where it does not", () => {
    // Only `llm` and `classifier` node priorities feed the queue priority.
    renderPanel({ id: "triage", type: "classifier" }, CATALOG);
    expect(screen.getByLabelText("Priority")).toBeInTheDocument();
    cleanup();

    renderPanel({ id: "recall", type: "memory" }, CATALOG);
    expect(screen.queryByLabelText("Priority")).toBeNull();
  });

  test("a priority set on a type the queue ignores is shown and flagged", () => {
    renderPanel({ id: "recall", type: "memory", priority: 90 } as FlowNode, CATALOG);
    expect(screen.getByLabelText("Priority")).toBeInTheDocument();
    expect(screen.getByText(/does not read/)).toBeInTheDocument();
  });

  test("overrides on a classifier are flagged — only llm and tool nodes apply them", () => {
    const c = renderPanel(
      { id: "triage", type: "classifier", overrides: [{ llm: {} }] } as unknown as FlowNode,
      CATALOG,
    );
    expect(hasSection(c, /^Overrides$/)).toBe(true);
    expect(screen.getByText(/does not read/)).toBeInTheDocument();
  });

  test("an unknown node type falls back instead of hiding everything", () => {
    const c = renderPanel({ id: "x", type: "future-type" } as unknown as FlowNode, CATALOG);
    expect(hasSection(c, /^Model$/)).toBe(false);
    expect(prompt()).toBeNull();
  });
});
