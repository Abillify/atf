// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import type { FlowDefinition } from "../../types/flow.js";
import { describeFlowCapabilities } from "../../graph/flow-capabilities.js";
import { buildReleasePassport, readSemanticVersion } from "../release-passport.js";

const flow: FlowDefinition = { id: "release", name: "Release", metadata: { version: "2.1.0" }, nodes: [{ id: "n", type: "router" }], edges: [] };

describe("buildReleasePassport", () => {
  test("keeps semantic and store versions distinct and reports missing bound evidence", () => {
    const passport = buildReleasePassport({
      flow,
      source: "online",
      storeVersion: 7,
      policy: { decision: "allow", violations: [], policyAbsent: false },
      capabilities: describeFlowCapabilities(flow),
      now: () => new Date("2026-08-29T00:00:00.000Z"),
    });
    expect(passport.flow).toMatchObject({ storeVersion: 7, semanticVersion: "2.1.0" });
    expect(passport.assessment).toBe("review");
    expect(passport.eval.status).toBe("missing");
  });

  test("blocks policy denial without overstating release evidence", () => {
    const passport = buildReleasePassport({
      flow,
      source: "file",
      policy: { decision: "deny", violations: [{ rule: "model", message: "blocked" }], policyAbsent: false },
      capabilities: describeFlowCapabilities(flow),
    });
    expect(passport.assessment).toBe("blocked");
  });

  test("ignores invalid semantic metadata versions", () => {
    expect(readSemanticVersion({ version: "latest" })).toBeUndefined();
  });
});
