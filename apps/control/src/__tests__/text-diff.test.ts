// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "vitest";
import { diffText } from "../lib/text-diff";

const join = (parts: ReturnType<typeof diffText>, keep: "same" | "add" | "del") =>
  parts.filter((p) => p.type === "same" || p.type === keep).map((p) => p.text).join("");

describe("diffText", () => {
  test("token diff for one-liners", () => {
    const parts = diffText("route == 'INKASSO'", "route == 'INKASSO' || route == 'BETRIEB'");
    expect(parts[0]).toEqual({ type: "same", text: "route == 'INKASSO'" });
    expect(parts.filter((p) => p.type === "add").map((p) => p.text).join("")).toBe(" || route == 'BETRIEB'");
    expect(parts.some((p) => p.type === "del")).toBe(false);
  });

  test("line diff for multi-line values; both sides reconstruct", () => {
    const a = "{\n  \"a\": 1,\n  \"b\": 2\n}";
    const b = "{\n  \"a\": 1,\n  \"b\": 3\n}";
    const parts = diffText(a, b);
    expect(join(parts, "del")).toBe(a);
    expect(join(parts, "add")).toBe(b);
    expect(parts.find((p) => p.type === "del")?.text).toBe('  "b": 2\n');
  });

  test("empty before is all added", () => {
    expect(diffText("", "{{= 1 }}")).toEqual([{ type: "add", text: "{{= 1 }}" }]);
  });
});
