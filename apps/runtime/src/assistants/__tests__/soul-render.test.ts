// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Soul rendering: byte stability, section order, and the budget precedence.
 *
 * The precedence tests encode a security-relevant decision: operator constraints
 * render LAST and are never dropped, because instruction following degrades with
 * distance from the model's turn and a silently omitted rule is one the operator
 * believes is enforced.
 */
import { describe, expect, test } from "bun:test";
import { buildSoulTruncationNotice, renderSoul } from "../soul-render.js";
import type { SoulDocument } from "../soul-document.js";

function doc(overrides: Partial<SoulDocument> = {}): SoulDocument {
  return {
    identity: { name: "Molty", vibe: "dry", role: "reporting" },
    directives: { instructions: "answer in German", style: "terse" },
    constraints: { rules: "never send external email" },
    ...overrides,
  };
}

describe("section order", () => {
  test("constraints render last", () => {
    const text = renderSoul(doc()).text;
    const identityAt = text.indexOf("Who you are");
    const directivesAt = text.indexOf("What your user expects");
    const constraintsAt = text.indexOf("Hard limits");
    expect(identityAt).toBeLessThan(directivesAt);
    // Closest to the model's turn, so it cannot be shadowed by earlier text.
    expect(directivesAt).toBeLessThan(constraintsAt);
  });

  test("constraints are marked non-negotiable", () => {
    expect(renderSoul(doc()).text).toContain("not negotiable");
  });

  test("an empty soul renders nothing at all", () => {
    const result = renderSoul({
      identity: {},
      directives: {},
      constraints: {},
    });
    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
  });
});

describe("byte stability", () => {
  test("rendering is idempotent", () => {
    expect(renderSoul(doc()).text).toBe(renderSoul(doc()).text);
  });

  test("field insertion order does not change the output", () => {
    const a = renderSoul({
      identity: { vibe: "dry", name: "Molty", role: "reporting" },
      directives: {},
      constraints: {},
    }).text;
    const b = renderSoul({
      identity: { name: "Molty", role: "reporting", vibe: "dry" },
      directives: {},
      constraints: {},
    }).text;
    // The rendered soul sits in the cacheable prompt prefix; a reordering here would
    // rewrite it on every JSONB round trip.
    expect(a).toBe(b);
  });

  test("nothing volatile is rendered", () => {
    const text = renderSoul(doc()).text;
    // No timestamps, revision numbers or counts: each would change the prefix on a
    // turn where nothing about the assistant actually changed.
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(text.toLowerCase()).not.toContain("revision");
  });
});

describe("budget precedence", () => {
  test("identity is dropped first", () => {
    const large = doc({
      identity: { name: "Molty", notes: "n".repeat(3_000) },
      directives: { instructions: "i".repeat(500) },
      constraints: { rules: "r".repeat(500) },
    });
    const result = renderSoul(large, { maxChars: 1_500 });
    expect(result.droppedSections).toContain("identity");
    // Losing the self-description degrades tone, not correctness.
    expect(result.text).toContain("Hard limits");
    expect(result.chars).toBeLessThanOrEqual(1_500);
  });

  test("constraints are never dropped", () => {
    const large = doc({
      identity: { notes: "n".repeat(5_000) },
      directives: { instructions: "i".repeat(5_000) },
      constraints: { rules: "the rule that must reach the model" },
    });
    const result = renderSoul(large, { maxChars: 400 });
    expect(result.droppedSections).not.toContain("constraints");
    expect(result.text).toContain("Hard limits");
  });

  test("constraints alone over budget are truncated with a visible marker", () => {
    const result = renderSoul(
      {
        identity: {},
        directives: {},
        constraints: { rules: "r".repeat(5_000) },
      },
      { maxChars: 300 },
    );
    // A partial rule the model KNOWS is partial is safer than a rule it never sees.
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("truncated");
    expect(result.chars).toBeLessThanOrEqual(300);
  });

  test("a soul within budget reports no truncation", () => {
    const result = renderSoul(doc());
    expect(result.truncated).toBe(false);
    expect(result.droppedSections).toEqual([]);
  });
});

describe("display name fallback", () => {
  test("the provisioned name is used when the assistant has not named itself", () => {
    const result = renderSoul(
      { identity: { vibe: "dry" }, directives: {}, constraints: {} },
      { assistantDisplayName: "Work Assistant" },
    );
    // Without this the model sees no name and invents one per turn, which reads as
    // instability to the user.
    expect(result.text).toContain("Work Assistant");
  });

  test("a self-chosen name wins over the provisioned one", () => {
    const result = renderSoul(
      { identity: { name: "Molty" }, directives: {}, constraints: {} },
      { assistantDisplayName: "Work Assistant" },
    );
    expect(result.text).toContain("Molty");
    expect(result.text).not.toContain("Work Assistant");
  });
});

describe("denied tools", () => {
  test("forbidden tools are named with the reason not to attempt them", () => {
    const result = renderSoul({
      identity: {},
      directives: {},
      constraints: { deniedTools: ["send_email", "exec"] },
    });
    // Stating WHY stops the model repeatedly attempting a call authorization will
    // always refuse.
    expect(result.text).toContain("do not attempt them");
    expect(result.text).toContain("exec");
  });

  test("the list renders in stored order, which is sorted", () => {
    const text = renderSoul({
      identity: {},
      directives: {},
      constraints: { deniedTools: ["exec", "send_email"] },
    }).text;
    expect(text.indexOf("exec")).toBeLessThan(text.indexOf("send_email"));
  });
});

describe("truncation notice", () => {
  test("a dropped section is named to the model", () => {
    const result = renderSoul(doc({ identity: { notes: "n".repeat(4_000) } }), { maxChars: 1_200 });
    const notice = buildSoulTruncationNotice(result);
    // A truncated context that announces itself produces a question; a silent one
    // produces a confident wrong answer.
    expect(notice).toContain("Soul truncated");
    expect(notice).toContain("ask the user");
  });

  test("truncated constraints tell the model to treat a partial rule as binding", () => {
    const result = renderSoul(
      { identity: {}, directives: {}, constraints: { rules: "r".repeat(5_000) } },
      { maxChars: 300 },
    );
    expect(buildSoulTruncationNotice(result)).toContain("fully binding");
  });

  test("no notice when nothing was dropped", () => {
    expect(buildSoulTruncationNotice(renderSoul(doc()))).toBeUndefined();
  });
});

describe("multi-line values", () => {
  test("a prose field is indented under its label", () => {
    const text = renderSoul({
      identity: {},
      directives: { instructions: "first line\nsecond line" },
      constraints: {},
    }).text;
    // Indented so a paragraph cannot be mistaken for the start of the next field.
    expect(text).toContain("- Standing instructions:\n  first line\n  second line");
  });
});
