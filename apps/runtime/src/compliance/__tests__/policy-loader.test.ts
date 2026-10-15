// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the compliance policy loader (`src/compliance/policy-loader.ts`):
 * an invalid policy file must never silently switch enforcement off — neither
 * at startup nor on hot-reload.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCompliancePolicyLoader } from "../policy-loader.js";

const VALID = `version: "1"
modelRules:
  - tenant: "*"
    blockedModels:
      - provider: openai
        model: "gpt-3*"
`;
const INVALID_SCHEMA = `version: "1"
modelRules:
  - tenant: ""
`;
const UNPARSEABLE = "modelRules: [unclosed\n";

let dir: string;
const write = (content: string) =>
  writeFileSync(path.join(dir, "compliance-policy.yaml"), content);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "atf-policy-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createCompliancePolicyLoader", () => {
  it("reports no policy and no block when the file is absent", () => {
    const loader = createCompliancePolicyLoader(dir);
    expect(loader.policy).toBeUndefined();
    expect(loader.loadError).toBeUndefined();
    expect(loader.enforcementBlocked).toBe(false);
  });

  it("loads a valid policy", () => {
    write(VALID);
    const loader = createCompliancePolicyLoader(dir);
    expect(loader.hasPolicy).toBe(true);
    expect(loader.enforcementBlocked).toBe(false);
  });

  it("blocks enforcement when the file is invalid at startup", () => {
    for (const content of [INVALID_SCHEMA, UNPARSEABLE]) {
      write(content);
      const loader = createCompliancePolicyLoader(dir);
      expect(loader.policy).toBeUndefined();
      expect(loader.enforcementBlocked).toBe(true);
      expect(loader.loadError).toBeString();
    }
  });

  it("keeps the last valid policy in force when a hot-reload is invalid", () => {
    write(VALID);
    const loader = createCompliancePolicyLoader(dir);
    const before = loader.policy;

    write(INVALID_SCHEMA);
    loader.reload();
    expect(loader.policy).toBe(before);
    expect(loader.enforcementBlocked).toBe(false);
    expect(loader.loadError).toContain("modelRules.0.tenant");

    write(UNPARSEABLE);
    loader.reload();
    expect(loader.policy).toBe(before);

    write(VALID);
    loader.reload();
    expect(loader.loadError).toBeUndefined();
  });

  it("unblocks once a broken startup file is fixed or removed", () => {
    write(INVALID_SCHEMA);
    const loader = createCompliancePolicyLoader(dir);
    expect(loader.enforcementBlocked).toBe(true);

    write(VALID);
    loader.reload();
    expect(loader.enforcementBlocked).toBe(false);
    expect(loader.hasPolicy).toBe(true);

    write(INVALID_SCHEMA);
    loader.reload();
    rmSync(path.join(dir, "compliance-policy.yaml"));
    loader.reload();
    expect(loader.policy).toBeUndefined();
    expect(loader.loadError).toBeUndefined();
    expect(loader.enforcementBlocked).toBe(false);
  });
});
