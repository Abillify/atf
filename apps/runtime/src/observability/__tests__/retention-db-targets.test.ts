// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the database-free parts of `retention-db-targets.ts`: the
 * assistant workspace target and the erasure-gap target. The SQL targets are
 * covered by the Postgres integration suite (src/db/__tests__/pg-integration.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assistantWorkspaceRetentionTarget,
  uncoveredRetentionTarget,
} from "../retention-db-targets.js";
import { RetentionService } from "../retention.js";
import { aggregateStatus } from "../../compliance/erasure-orchestrator.js";

let root: string;
const mkWorkspace = (...segments: string[]) =>
  fs.mkdirSync(path.join(root, ...segments, "notes"), { recursive: true });
const exists = (...segments: string[]) => fs.existsSync(path.join(root, ...segments));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), "atf-ws-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("assistantWorkspaceRetentionTarget", () => {
  it("removes only the user's workspace inside the (normalised) tenant", async () => {
    mkWorkspace("acme", "u-1", "helper");
    mkWorkspace("acme", "u-2", "helper");
    mkWorkspace("other", "u-1", "helper");
    const target = assistantWorkspaceRetentionTarget(root);
    expect(await target.eraseSubject?.({ tenantId: "ACME", userId: "U-1" })).toBe(1);
    expect(exists("acme", "u-1")).toBe(false);
    expect(exists("acme", "u-2")).toBe(true);
    expect(exists("other", "u-1")).toBe(true);
  });

  it("removes the user's workspace in every tenant when no tenant is given, aliases included", async () => {
    mkWorkspace("acme", "u-1", "helper");
    mkWorkspace("other", "u-x-de", "helper");
    const target = assistantWorkspaceRetentionTarget(root);
    expect(await target.eraseSubject?.({ userId: "u@x.de", userAliases: ["u-1"] })).toBe(2);
    expect(fs.readdirSync(path.join(root, "acme"))).toEqual([]);
  });

  it("removes the tenant directory for a tenant-only subject and tolerates a missing root", async () => {
    mkWorkspace("acme", "u-1", "helper");
    const target = assistantWorkspaceRetentionTarget(root);
    expect(await target.eraseSubject?.({ tenantId: "acme" })).toBe(1);
    expect(exists("acme")).toBe(false);
    const missing = assistantWorkspaceRetentionTarget(path.join(root, "nope"));
    expect(await missing.eraseSubject?.({ userId: "u-1" })).toBe(0);
  });
});

describe("uncoveredRetentionTarget", () => {
  it("turns a DSAR into a partial erasure that names the gap", async () => {
    const retention = new RetentionService([
      { name: "covered", eraseSubject: async () => 3 },
      uncoveredRetentionTarget("semantic_cache", "keyed by prompt, not by user"),
    ]);
    const report = await retention.forget({ tenantId: "acme", userId: "u-1" });
    expect(report[1]?.error).toContain("keyed by prompt, not by user");
    expect(
      aggregateStatus(
        report.map((r) => ({
          store: r.target,
          status: r.error === undefined ? ("ok" as const) : ("failed" as const),
          erased: r.erased,
        })),
      ),
    ).toBe("partial");

    const [covered, gap] = retention.describeTargets();
    expect(covered?.subjectErase).toBe(true);
    expect(gap?.subjectErase).toBe(false);
    expect(gap?.erasureGap).toBe("keyed by prompt, not by user");
  });
});
