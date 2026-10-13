// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the declarative tool authorization engine (`src/graph/tool-authz.ts`).
 *
 * Covers:
 *  - constraintMode "all" (default, backward compatible) vs "any"
 *  - fail-closed behaviour on a malformed policy (deny-all) vs fail-open (no-op)
 */

import { describe, test, expect } from "bun:test";
import {
  createToolAuthzEngine,
  createToolAuthzEngineFromJson,
  createDenyAllToolAuthzEngine,
  TOOL_AUTHZ_DENY_ALL_MARKER,
  TOOL_AUTHZ_NOOP_MARKER,
  type ToolAuthzPolicy,
} from "../tool-authz.js";
import type { RequestContext } from "../../types/monitoring.js";

function ctx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    ssoToken: "t",
    executionId: "e1",
    ...overrides,
  };
}

describe("tool-authz — constraint modes", () => {
  test("default mode 'all' fires only when EVERY constraint is breached", () => {
    const policy: ToolAuthzPolicy = {
      defaultAction: "allow",
      rules: [
        {
          id: "deny-big-and-forbidden",
          tool: "billing/refund",
          constraints: {
            amount: { max: 100 },
            currency: { allowedValues: ["EUR"] },
          },
          action: "deny",
        },
      ],
    };
    const engine = createToolAuthzEngine(policy);

    // Only ONE constraint breached (amount) → rule does NOT fire → allowed.
    expect(
      engine.evaluate("billing/refund", { amount: 500, currency: "EUR" }, ctx())
        .allowed,
    ).toBe(true);

    // BOTH breached (amount > 100 AND currency not EUR) → rule fires → denied.
    const d = engine.evaluate(
      "billing/refund",
      { amount: 500, currency: "USD" },
      ctx(),
    );
    expect(d.allowed).toBe(false);
    expect(d.ruleId).toBe("deny-big-and-forbidden");
  });

  test("mode 'any' fires when AT LEAST ONE constraint is breached", () => {
    const policy: ToolAuthzPolicy = {
      defaultAction: "allow",
      rules: [
        {
          id: "deny-any-breach",
          tool: "billing/refund",
          constraintMode: "any",
          constraints: {
            amount: { max: 100 },
            currency: { allowedValues: ["EUR"] },
          },
          action: "deny",
        },
      ],
    };
    const engine = createToolAuthzEngine(policy);

    // A single breach (amount) is enough to deny.
    expect(
      engine.evaluate("billing/refund", { amount: 500, currency: "EUR" }, ctx())
        .allowed,
    ).toBe(false);
    // No breach → allowed.
    expect(
      engine.evaluate("billing/refund", { amount: 50, currency: "EUR" }, ctx())
        .allowed,
    ).toBe(true);
  });

  test("describe() surfaces constraintMode", () => {
    const engine = createToolAuthzEngine({
      defaultAction: "allow",
      rules: [
        {
          id: "r",
          tool: "x/*",
          constraintMode: "any",
          constraints: { a: { max: 1 } },
          action: "deny",
        },
      ],
    });
    expect(engine.describe().rules[0]?.constraintMode).toBe("any");
  });
});

describe("tool-authz — fail-closed on malformed policy", () => {
  const badJson = '{ "rules": [ { "id": 123, "tool": true } ] }'; // schema-invalid

  test("fail-closed (default): malformed policy denies all tool calls", () => {
    const { engine, error } = createToolAuthzEngineFromJson(badJson);
    expect(error).toBeDefined();
    expect(engine.active).toBe(true);
    expect(engine.evaluate("anything/at-all", {}, ctx()).allowed).toBe(false);
  });
  test("explicit failClosed:false opts into legacy fail-open behaviour", () => {
    const { engine } = createToolAuthzEngineFromJson(badJson, {
      failClosed: false,
    });
    expect(engine.evaluate("anything/at-all", {}, ctx()).allowed).toBe(true);
  });

  test("fail-closed: malformed policy denies ALL tool calls", () => {
    const { engine, error } = createToolAuthzEngineFromJson(badJson, {
      failClosed: true,
    });
    expect(error).toBeDefined();
    expect(engine.active).toBe(true);
    const d = engine.evaluate("anything/at-all", {}, ctx());
    expect(d.allowed).toBe(false);
    expect(d.ruleId).toBe("fail-closed");
  });

  test("fail-closed: invalid JSON syntax also denies all", () => {
    const { engine, error } = createToolAuthzEngineFromJson("{ not json", {
      failClosed: true,
    });
    expect(error).toBeDefined();
    expect(engine.evaluate("x/y", {}, ctx()).allowed).toBe(false);
  });

  test("createToolAuthzEngine honours failClosed on a malformed object", () => {
    // Explicit opt-out → legacy fail-open.
    const open = createToolAuthzEngine(
      { rules: [{ bogus: true }] },
      { failClosed: false },
    );
    expect(open.evaluate("x/y", {}, ctx()).allowed).toBe(true);

    // Default → fail-closed (deny all).
    const closed = createToolAuthzEngine({ rules: [{ bogus: true }] });
    expect(closed.evaluate("x/y", {}, ctx()).allowed).toBe(false);
  });

  test("valid policy is unaffected by failClosed", () => {
    const { engine, error } = createToolAuthzEngineFromJson(
      JSON.stringify({
        defaultAction: "allow",
        rules: [{ id: "a", tool: "search/*", action: "allow" }],
      }),
      { failClosed: true },
    );
    expect(error).toBeUndefined();
    expect(engine.evaluate("search/web", {}, ctx()).allowed).toBe(true);
  });

  test("the deny-all engine reports itself active with a deny default", () => {
    const engine = createDenyAllToolAuthzEngine("nope");
    expect(engine.active).toBe(true);
    expect(engine.describe().defaultAction).toBe("deny");
    expect(engine.evaluate("x/y", {}, ctx()).reason).toBe("nope");
  });
});
describe("tool-authz — policyHash (Decision_Receipt provenance, Req 15.2)", () => {
  const policy: ToolAuthzPolicy = {
    defaultAction: "deny",
    rules: [{ id: "a", tool: "search/*", action: "allow" }],
  };
  test("a real policy hashes to a stable SHA-256 hex digest independent of key order", () => {
    const first = createToolAuthzEngine(policy).policyHash();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const reordered = createToolAuthzEngine({
      rules: [{ action: "allow", tool: "search/*", id: "a" }],
      defaultAction: "deny",
    }).policyHash();
    expect(reordered).toBe(first);
    const changed = createToolAuthzEngine({
      ...policy,
      defaultAction: "allow",
    }).policyHash();
    expect(changed).not.toBe(first);
  });
  test("engines without a real policy return the documented markers, not a digest", () => {
    expect(createToolAuthzEngine(undefined).policyHash()).toBe(
      TOOL_AUTHZ_NOOP_MARKER,
    );
    expect(createDenyAllToolAuthzEngine().policyHash()).toBe(
      TOOL_AUTHZ_DENY_ALL_MARKER,
    );
  });
});
