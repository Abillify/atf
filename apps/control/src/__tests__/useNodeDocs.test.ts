// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { useNodeDocs } from "../hooks/useNodeDocs";
import type { NodeTypeDoc } from "../lib/node-types";

const llm = { type: "llm", title: "LLM" } as NodeTypeDoc;
const tool = { type: "tool", title: "Tool" } as NodeTypeDoc;
const catalog = { types: [llm, tool] };

type Inspect = { nodeId: string; type: string } | null;

function setup(initial: Inspect) {
  return renderHook(({ inspect }: { inspect: Inspect }) => useNodeDocs(inspect, catalog), {
    initialProps: { inspect: initial },
  });
}

describe("useNodeDocs", () => {
  test("shows the selected node's docs; close hides them, show reopens", () => {
    const { result } = setup({ nodeId: "a", type: "llm" });
    expect(result.current.doc).toBe(llm);
    act(() => result.current.close());
    expect(result.current.doc).toBeUndefined();
    expect(result.current.hidden).toBe(llm);
    act(() => result.current.show());
    expect(result.current.doc).toBe(llm);
    expect(result.current.hidden).toBeUndefined();
  });

  test("closing applies to the current selection only", () => {
    const { result, rerender } = setup({ nodeId: "a", type: "llm" });
    act(() => result.current.close());
    rerender({ inspect: { nodeId: "b", type: "tool" } });
    expect(result.current.doc).toBe(tool);
    // Back to the first node: its docs show again.
    rerender({ inspect: { nodeId: "a", type: "llm" } });
    expect(result.current.doc).toBe(llm);
    // Deselect and reselect the same node: shown again, too.
    act(() => result.current.close());
    rerender({ inspect: null });
    rerender({ inspect: { nodeId: "a", type: "llm" } });
    expect(result.current.doc).toBe(llm);
  });

  test("nothing to show without a selection or for an unknown type", () => {
    expect(setup(null).result.current).toMatchObject({ doc: undefined, hidden: undefined });
    expect(setup({ nodeId: "x", type: "plugin" }).result.current).toMatchObject({
      doc: undefined,
      hidden: undefined,
    });
  });
});
