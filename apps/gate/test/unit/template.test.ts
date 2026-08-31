// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { renderSqlTemplate } from "../../src/db/template.ts";

describe("renderSqlTemplate", () => {
  it("returns the template unchanged when there are no directives", () => {
    expect(renderSqlTemplate("SELECT 1", {})).toBe("SELECT 1");
  });

  it("selects the then-branch when the condition is true", () => {
    expect(renderSqlTemplate("a{{if:p}}X{{else}}Y{{endif}}b", { p: true })).toBe("aXb");
  });

  it("selects the else-branch when the condition is false", () => {
    expect(renderSqlTemplate("a{{if:p}}X{{else}}Y{{endif}}b", { p: false })).toBe("aYb");
  });

  it("supports an empty branch and missing else", () => {
    expect(renderSqlTemplate("a{{if:p}}{{else}}Y{{endif}}", { p: true })).toBe("a");
    expect(renderSqlTemplate("a{{if:p}}X{{endif}}", { p: false })).toBe("a");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderSqlTemplate("{{ if:p }}X{{ endif }}", { p: true })).toBe("X");
  });

  it("handles nested conditions", () => {
    const tmpl = "{{if:a}}A{{if:b}}B{{else}}b{{endif}}{{else}}Z{{endif}}";
    expect(renderSqlTemplate(tmpl, { a: true, b: true })).toBe("AB");
    expect(renderSqlTemplate(tmpl, { a: true, b: false })).toBe("Ab");
    expect(renderSqlTemplate(tmpl, { a: false, b: true })).toBe("Z");
  });

  it("throws on unknown conditions", () => {
    expect(() => renderSqlTemplate("{{if:missing}}x{{endif}}", {})).toThrow(/unknown condition/);
  });

  it("throws on an unclosed if", () => {
    expect(() => renderSqlTemplate("{{if:p}}x", { p: true })).toThrow();
  });

  it("throws on a dangling endif", () => {
    expect(() => renderSqlTemplate("x{{endif}}", {})).toThrow();
  });
});
