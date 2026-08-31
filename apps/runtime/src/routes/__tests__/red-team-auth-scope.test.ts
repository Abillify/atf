// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Regression test: the red-team router's auth middleware must be scoped to
 * `/security/*` only. It is mounted at the app root (`app.route("/", …)`), so a
 * `use("*")` guard would run for EVERY request and shadow the auth of unrelated
 * planes (e.g. /monitoring/*), rejecting tokens with a 403 before those routes'
 * own handlers/auth run. That previously broke the in-chat approval widget and
 * turned the operator plane's refreshable 401 into a dead-end 403.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { createRedTeamRouter } from "../red-team.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";

function appWithRedTeamAtRoot() {
  const operatorAuth = createOperatorAuthorizer({ authRequired: true });
  const a = new Hono();
  // Mounted at root exactly like src/index.ts does.
  a.route("/", createRedTeamRouter({ operatorAuth }));
  // A sibling route registered AFTER the red-team router, on another plane.
  a.get("/monitoring/anything", (ctx) => ctx.json({ ok: true }));
  return a;
}

describe("red-team auth middleware scope", () => {
  test("does NOT gate non-/security routes (no leaked global 403)", async () => {
    const a = appWithRedTeamAtRoot();
    const res = await a.request("/monitoring/anything");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("still gates /security/* routes (403 without an operator token)", async () => {
    const a = appWithRedTeamAtRoot();
    const res = await a.request("/security/red-team/runs");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("auth_error");
  });
});
