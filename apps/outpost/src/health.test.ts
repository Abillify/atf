// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "vitest";
import {
  DEFAULT_HEALTH_BIND,
  DEFAULT_HEALTH_PORT,
  healthBody,
  healthStatusCode,
  isLoopbackBind,
  probeExtract,
} from "./health.js";

describe("health contract", () => {
  const state = {
    auth: "ok" as const,
    extract: { reachable: true, status: 200, checkedAt: "2026-09-30T00:00:00.000Z" },
    sources: [
      { sourceId: "docs", status: "needs-authorization" as const, pending: false },
    ],
  };

  test("uses the documented loopback defaults", () => {
    expect(DEFAULT_HEALTH_BIND).toBe("127.0.0.1");
    expect(DEFAULT_HEALTH_PORT).toBe(8787);
    expect(isLoopbackBind(DEFAULT_HEALTH_BIND)).toBe(true);
    expect(isLoopbackBind("0.0.0.0")).toBe(false);
  });

  test("keeps source needs-authorization healthy", () => {
    expect(healthStatusCode(state)).toBe(200);
    expect(healthBody(state)).toEqual({
      auth: "ok",
      extract: state.extract,
      sources: [{ id: "docs", status: "needs-authorization", pending: false }],
    });
    expect(healthStatusCode({ ...state, auth: "reauth_required" })).toBe(503);
    expect(healthStatusCode({ ...state, extract: { ...state.extract, reachable: false } })).toBe(503);
  });

  test("converts probe failures into an unreachable result", async () => {
    const result = await probeExtract({ request: async () => { throw new Error("offline"); } });
    expect(result.reachable).toBe(false);
    expect(result.status).toBeUndefined();
  });
});
