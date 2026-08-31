// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for FlowAuthorizer — per-identity flow access control.
 *
 * Covers the pure decision function (allow-lists, default effect, fail-closed
 * on malformed policy) and the file-backed authorizer with hot-reload.
 */

import { describe, test, expect } from "bun:test";
import {
  createFlowAuthorizer,
  decideAccess,
  loadAccessTable,
  type AccessTable,
} from "../flow-authorizer.js";
import type { RequestContext } from "../../types/monitoring.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function makeCtx(overrides?: Partial<RequestContext>): RequestContext {
  return { ssoToken: "a.b.c", executionId: "exec-1", ...overrides };
}

function withAuthorizer(
  table: unknown,
  fn: (a: ReturnType<typeof createFlowAuthorizer>, dir: string) => void,
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "access-test-"));
  fs.writeFileSync(path.join(dir, "access.json"), JSON.stringify(table));
  try {
    fn(createFlowAuthorizer(dir), dir);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// decideAccess — pure function
// ---------------------------------------------------------------------------

describe("decideAccess — no policy", () => {
  test("undefined table allows everything (backward compatible)", () => {
    expect(decideAccess(undefined, "any-flow", makeCtx()).allowed).toBe(true);
  });
});

describe("decideAccess — default effect", () => {
  const table: AccessTable = {
    defaultEffect: "deny",
    rules: [{ flow: "public", allowRoles: undefined } as never],
  };

  test("default deny rejects a flow with no applicable rule", () => {
    const d = decideAccess(
      { defaultEffect: "deny", rules: [{ flow: "other" }] },
      "secret-flow",
      makeCtx(),
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("default deny");
  });

  test("default allow permits a flow with no applicable rule", () => {
    const d = decideAccess(
      { defaultEffect: "allow", rules: [{ flow: "other" }] },
      "x",
      makeCtx(),
    );
    expect(d.allowed).toBe(true);
  });

  test("an unconditional rule for the flow allows it", () => {
    void table;
    const d = decideAccess(
      { defaultEffect: "deny", rules: [{ flow: "public" }] },
      "public",
      makeCtx(),
    );
    expect(d.allowed).toBe(true);
  });
});

describe("decideAccess — role / group / plan / tenant constraints", () => {
  const table: AccessTable = {
    defaultEffect: "deny",
    rules: [
      { flow: "admin-flow", allowRoles: ["admin"] },
      { flow: "ent-flow", allowGroups: ["enterprise"], allowLanguages: ["de"] },
      { flow: "tenant-flow", allowTenants: ["tenant-a"] },
      { flow: "gold-flow", allowClaim: "tier == 'gold'" },
    ],
  };

  test("role match allows", () => {
    expect(
      decideAccess(table, "admin-flow", makeCtx({ role: "admin" })).allowed,
    ).toBe(true);
  });

  test("role mismatch denies", () => {
    expect(
      decideAccess(table, "admin-flow", makeCtx({ role: "user" })).allowed,
    ).toBe(false);
  });

  test("group + language must BOTH match (AND across types)", () => {
    expect(
      decideAccess(
        table,
        "ent-flow",
        makeCtx({ groups: ["enterprise"], language: "de-AT" }),
      ).allowed,
    ).toBe(true);
    // right group, wrong language → deny
    expect(
      decideAccess(
        table,
        "ent-flow",
        makeCtx({ groups: ["enterprise"], language: "en" }),
      ).allowed,
    ).toBe(false);
  });

  test("tenant allow-list", () => {
    expect(
      decideAccess(table, "tenant-flow", makeCtx({ clientId: "tenant-a" }))
        .allowed,
    ).toBe(true);
    expect(
      decideAccess(table, "tenant-flow", makeCtx({ clientId: "tenant-b" }))
        .allowed,
    ).toBe(false);
  });

  test("claim expression", () => {
    expect(
      decideAccess(table, "gold-flow", makeCtx({ claims: { tier: "gold" } }))
        .allowed,
    ).toBe(true);
    expect(
      decideAccess(table, "gold-flow", makeCtx({ claims: { tier: "silver" } }))
        .allowed,
    ).toBe(false);
  });
});

describe("decideAccess — wildcard rule", () => {
  test("a '*' rule applies to every flow", () => {
    const table: AccessTable = {
      defaultEffect: "deny",
      rules: [{ flow: "*", allowRoles: ["staff"] }],
    };
    expect(
      decideAccess(table, "anything", makeCtx({ role: "staff" })).allowed,
    ).toBe(true);
    expect(
      decideAccess(table, "anything", makeCtx({ role: "guest" })).allowed,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// File-backed authorizer
// ---------------------------------------------------------------------------

describe("createFlowAuthorizer — file backed", () => {
  test("no access.json → allow everything, hasPolicy false", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "access-empty-"));
    try {
      const a = createFlowAuthorizer(dir);
      expect(a.hasPolicy()).toBe(false);
      expect(a.authorize("any", makeCtx()).allowed).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test("loaded policy enforces default deny", () => {
    withAuthorizer(
      { defaultEffect: "deny", rules: [{ flow: "open" }] },
      (a) => {
        expect(a.hasPolicy()).toBe(true);
        expect(a.authorize("open", makeCtx()).allowed).toBe(true);
        expect(a.authorize("closed", makeCtx()).allowed).toBe(false);
      },
    );
  });

  test("malformed access.json fails CLOSED (deny all)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "access-bad-"));
    fs.writeFileSync(path.join(dir, "access.json"), "{ not valid json");
    try {
      const table = loadAccessTable(dir);
      expect(table).toEqual({ defaultEffect: "deny", rules: [] });
      const a = createFlowAuthorizer(dir);
      expect(a.authorize("anything", makeCtx({ role: "admin" })).allowed).toBe(
        false,
      );
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test("reload picks up policy changes", () => {
    withAuthorizer(
      { defaultEffect: "deny", rules: [{ flow: "a" }] },
      (a, dir) => {
        expect(a.authorize("b", makeCtx()).allowed).toBe(false);
        fs.writeFileSync(
          path.join(dir, "access.json"),
          JSON.stringify({ defaultEffect: "allow", rules: [] }),
        );
        a.reload();
        expect(a.authorize("b", makeCtx()).allowed).toBe(true);
      },
    );
  });
});
