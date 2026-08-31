// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for FlowDispatcher — rule-based flow resolution.
 *
 * Validates that dispatch rules correctly map user attributes, JWT claims,
 * request params, plan, language and groups to target flows.
 */

import { describe, test, expect } from "bun:test";
import { createFlowDispatcher, loadDispatchTable } from "../flow-dispatcher.js";
import type { FlowDispatchRule } from "../../types/flow.js";
import type { RequestContext } from "../../types/monitoring.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<RequestContext>): RequestContext {
  return {
    ssoToken: "a.b.c",
    executionId: "exec-1",
    ...overrides,
  };
}

function withDispatcher(
  rules: FlowDispatchRule[],
  fn: (dispatcher: ReturnType<typeof createFlowDispatcher>) => void,
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-test-"));
  fs.writeFileSync(path.join(dir, "dispatch.json"), JSON.stringify({ rules }));
  try {
    const dispatcher = createFlowDispatcher(dir);
    fn(dispatcher);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FlowDispatcher — whenRole", () => {
  test("matches admin role → admin-flow", () => {
    withDispatcher(
      [
        { whenRole: "admin", targetFlow: "admin-flow" },
        { whenRole: "user", targetFlow: "user-flow" },
      ],
      (d) => {
        expect(d.resolveFlow("any", makeCtx({ role: "admin" }))).toBe(
          "admin-flow",
        );
        expect(d.resolveFlow("any", makeCtx({ role: "user" }))).toBe(
          "user-flow",
        );
        expect(d.resolveFlow("any", makeCtx())).toBe("any"); // no match → fallback
      },
    );
  });
});

describe("FlowDispatcher — whenGroup", () => {
  test("matches if ctx.groups contains the value", () => {
    withDispatcher(
      [{ whenGroup: "premium", targetFlow: "premium-flow" }],
      (d) => {
        expect(
          d.resolveFlow("x", makeCtx({ groups: ["free", "premium"] })),
        ).toBe("premium-flow");
        expect(d.resolveFlow("x", makeCtx({ groups: ["free"] }))).toBe("x");
        expect(d.resolveFlow("x", makeCtx())).toBe("x");
      },
    );
  });
});

describe("FlowDispatcher — whenPlan", () => {
  test("matches plan exactly", () => {
    withDispatcher(
      [
        { whenPlan: "enterprise", targetFlow: "enterprise-flow" },
        { whenPlan: "pro", targetFlow: "pro-flow" },
      ],
      (d) => {
        expect(d.resolveFlow("x", makeCtx({ plan: "enterprise" }))).toBe(
          "enterprise-flow",
        );
        expect(d.resolveFlow("x", makeCtx({ plan: "pro" }))).toBe("pro-flow");
        expect(d.resolveFlow("x", makeCtx({ plan: "free" }))).toBe("x");
      },
    );
  });
});

describe("FlowDispatcher — whenLanguage", () => {
  test("prefix match: 'de' matches 'de-AT', 'de-CH'", () => {
    withDispatcher([{ whenLanguage: "de", targetFlow: "de-flow" }], (d) => {
      expect(d.resolveFlow("x", makeCtx({ language: "de-AT" }))).toBe(
        "de-flow",
      );
      expect(d.resolveFlow("x", makeCtx({ language: "de-CH" }))).toBe(
        "de-flow",
      );
      expect(d.resolveFlow("x", makeCtx({ language: "de" }))).toBe("de-flow");
      expect(d.resolveFlow("x", makeCtx({ language: "en-US" }))).toBe("x");
    });
  });
});

describe("FlowDispatcher — whenModel (regex)", () => {
  test("regex matches against the requested model name", () => {
    withDispatcher(
      [
        { whenModel: "^gpt-", targetFlow: "openai-flow" },
        { whenModel: "llama", targetFlow: "local-flow" },
      ],
      (d) => {
        expect(d.resolveFlow("gpt-4o", makeCtx())).toBe("openai-flow");
        expect(d.resolveFlow("gpt-3.5-turbo", makeCtx())).toBe("openai-flow");
        expect(d.resolveFlow("llama3:8b", makeCtx())).toBe("local-flow");
        expect(d.resolveFlow("claude-3", makeCtx())).toBe("claude-3"); // no match
      },
    );
  });
});

describe("FlowDispatcher — AND conditions", () => {
  test("all conditions in a rule must match (AND semantics)", () => {
    withDispatcher(
      [
        // Both group AND language must match
        {
          whenGroup: "enterprise",
          whenLanguage: "de",
          targetFlow: "de-enterprise-flow",
        },
        // Only group needed for second rule
        { whenGroup: "enterprise", targetFlow: "enterprise-flow" },
      ],
      (d) => {
        expect(
          d.resolveFlow(
            "x",
            makeCtx({ groups: ["enterprise"], language: "de-DE" }),
          ),
        ).toBe("de-enterprise-flow");

        // group ok, language fails first rule → falls to second
        expect(
          d.resolveFlow(
            "x",
            makeCtx({ groups: ["enterprise"], language: "en-US" }),
          ),
        ).toBe("enterprise-flow");

        // no group match
        expect(
          d.resolveFlow("x", makeCtx({ groups: ["free"], language: "de-DE" })),
        ).toBe("x");
      },
    );
  });
});

describe("FlowDispatcher — whenClaim expression", () => {
  test("evaluates claim expressions safely", () => {
    withDispatcher(
      [{ whenClaim: "tier == 'gold'", targetFlow: "gold-flow" }],
      (d) => {
        expect(d.resolveFlow("x", makeCtx({ claims: { tier: "gold" } }))).toBe(
          "gold-flow",
        );
        expect(
          d.resolveFlow("x", makeCtx({ claims: { tier: "silver" } })),
        ).toBe("x");
        expect(d.resolveFlow("x", makeCtx())).toBe("x");
      },
    );
  });
});

describe("FlowDispatcher — whenParam expression", () => {
  test("evaluates requestParam expressions", () => {
    withDispatcher(
      [{ whenParam: "channel == 'mobile'", targetFlow: "mobile-flow" }],
      (d) => {
        expect(
          d.resolveFlow("x", makeCtx({ requestParams: { channel: "mobile" } })),
        ).toBe("mobile-flow");
        expect(
          d.resolveFlow("x", makeCtx({ requestParams: { channel: "web" } })),
        ).toBe("x");
      },
    );
  });
});

describe("FlowDispatcher — first rule wins", () => {
  test("evaluates rules top-to-bottom, first match wins", () => {
    withDispatcher(
      [
        { whenRole: "admin", targetFlow: "admin-flow" },
        { whenRole: "admin", targetFlow: "never-reached" },
      ],
      (d) => {
        expect(d.resolveFlow("x", makeCtx({ role: "admin" }))).toBe(
          "admin-flow",
        );
      },
    );
  });
});

describe("FlowDispatcher — fallback", () => {
  test("returns original model when no rule matches", () => {
    withDispatcher([{ whenRole: "admin", targetFlow: "admin-flow" }], (d) => {
      expect(d.resolveFlow("my-flow", makeCtx({ role: "user" }))).toBe(
        "my-flow",
      );
    });
  });
});

describe("FlowDispatcher — resilience", () => {
  test("empty dispatch.json → always returns original model", () => {
    withDispatcher([], (d) => {
      expect(d.resolveFlow("my-flow", makeCtx({ role: "admin" }))).toBe(
        "my-flow",
      );
    });
  });

  test("missing dispatch.json → always returns original model", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-dispatch-"));
    try {
      const d = createFlowDispatcher(dir);
      expect(d.resolveFlow("my-flow", makeCtx({ role: "admin" }))).toBe(
        "my-flow",
      );
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test("malformed dispatch.json → always returns original model", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bad-dispatch-"));
    fs.writeFileSync(path.join(dir, "dispatch.json"), "{{{not json}}}");
    try {
      const d = createFlowDispatcher(dir);
      expect(d.resolveFlow("my-flow", makeCtx())).toBe("my-flow");
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe("loadDispatchTable", () => {
  test("returns empty rules when file does not exist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-dispatch-"));
    try {
      const table = loadDispatchTable(dir);
      expect(table.rules).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe("loadDispatchTable — schema validation (Fix #6)", () => {
  function tableFromRaw(raw: unknown): ReturnType<typeof loadDispatchTable> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-schema-"));
    fs.writeFileSync(path.join(dir, "dispatch.json"), JSON.stringify(raw));
    try {
      return loadDispatchTable(dir);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  }

  test("accepts a well-formed table", () => {
    const table = tableFromRaw({
      rules: [{ whenRole: "admin", targetFlow: "admin-flow" }],
    });
    expect(table.rules).toHaveLength(1);
  });

  test("rejects a rule missing targetFlow → empty rules", () => {
    const table = tableFromRaw({ rules: [{ whenRole: "admin" }] });
    expect(table.rules).toHaveLength(0);
  });

  test("rejects a rule with no 'when…' condition → empty rules", () => {
    const table = tableFromRaw({ rules: [{ targetFlow: "x" }] });
    expect(table.rules).toHaveLength(0);
  });

  test("rejects a non-array rules field → empty rules", () => {
    const table = tableFromRaw({ rules: "nope" });
    expect(table.rules).toHaveLength(0);
  });

  test("rejects a missing rules field → empty rules", () => {
    const table = tableFromRaw({ foo: "bar" });
    expect(table.rules).toHaveLength(0);
  });
});
