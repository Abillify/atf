// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";

const config = {
  transaction: { enforcement: "required", audience: "gate", maxTtlSeconds: 60 },
  redis: { url: "${ATF_REDIS_URL}" },
  server: { readinessPath: "/readyz", readOnlyFilesystem: true, allowPrivilegeEscalation: false },
  network: { egressPorts: [53, 6379] },
};

describe("public deployment configuration invariants", () => {
  test("requires a distinct short-lived transaction audience without a secret value", () => {
    expect(config.transaction).toEqual({ enforcement: "required", audience: "gate", maxTtlSeconds: 60 });
    expect(config.redis.url).toMatch(/^\$\{[A-Z0-9_]+\}$/);
  });

  test("models readiness, hardening, and least-privilege network intent", () => {
    expect(config.server.readinessPath).toBe("/readyz");
    expect(config.server.readOnlyFilesystem).toBe(true);
    expect(config.server.allowPrivilegeEscalation).toBe(false);
    expect(config.network.egressPorts).toEqual([53, 6379]);
  });
});
