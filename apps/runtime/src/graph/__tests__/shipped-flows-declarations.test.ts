// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { DATA_CLASSES } from "../../types/flow.js";

const publicFixtures = [
  { id: "read-summary", dataClasses: ["public"], recovery: { retry: true, maxAttempts: 2 }, text: "catalog/read" },
  { id: "update-record", dataClasses: ["confidential"], recovery: { retry: false }, text: "records/update" },
] as const;

const WRITE_TOOL_PATTERN = /\b[a-z0-9_-]+\/(?:[a-z0-9_-]*_(?:create|update|delete))\b/;

describe("public flow declaration fixtures", () => {
  test("declares valid data classes and bounded recovery for every flow", () => {
    expect(publicFixtures.length).toBeGreaterThan(0);
    for (const flow of publicFixtures) {
      expect(flow.dataClasses.length).toBeGreaterThan(0);
      for (const dataClass of flow.dataClasses) expect(DATA_CLASSES as readonly string[]).toContain(dataClass);
      expect(typeof flow.recovery.retry).toBe("boolean");
      const maxAttempts = "maxAttempts" in flow.recovery ? flow.recovery.maxAttempts : undefined;
      if (maxAttempts !== undefined) {
        expect(maxAttempts).toBeGreaterThanOrEqual(1);
        expect(maxAttempts).toBeLessThanOrEqual(10);
      }
    }
  });

  test("does not permit retry for a fixture that reaches a writing tool", () => {
    for (const flow of publicFixtures) {
      if (flow.recovery.retry) expect(WRITE_TOOL_PATTERN.test(flow.text)).toBe(false);
    }
  });
});
