// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the tool-authorization policy loader (`src/graph/tool-authz-loader.ts`).
 *
 * Covers Req 7.7: a failed reload of `tool-authz.json` (parse error or read
 * error) sets the `policyStale` flag and counts `aiperator_policy_stale_total`;
 * a subsequent successful reload clears it again. A simply-absent file is NOT a
 * failure and must not mark the policy stale.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolAuthzLoader } from "../tool-authz-loader.js";
import { TOOL_AUTHZ_FILE } from "../tool-authz-loader.js";
import { createMetrics } from "../../observability/metrics.js";
import type { RequestContext } from "../../types/monitoring.js";

function ctx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    ssoToken: "t",
    executionId: "e1",
    ...overrides,
  };
}

const GOOD_POLICY = {
  defaultAction: "deny",
  rules: [
    { id: "allow-all", tool: "*", action: "allow" as const },
  ],
};

describe("tool-authz-loader — policy_stale (Req 7.7)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "atf-tool-authz-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writePolicy = (text: string): void => {
    fs.writeFileSync(path.join(dir, TOOL_AUTHZ_FILE), text, "utf-8");
  };

  test("no stale flag when the file is simply absent", () => {
    const m = createMetrics(true);
    const loader = createToolAuthzLoader(dir, undefined, { metrics: m });
    // Absent file is the normal "no policy configured" state, not a failure.
    expect(loader.policyStale).toBe(false);
    expect(loader.hasPolicy).toBe(false);
    expect(m.render()).not.toContain("aiperator_policy_stale_total");
  });

  test("clean load leaves policyStale false", () => {
    writePolicy(JSON.stringify(GOOD_POLICY));
    const m = createMetrics(true);
    const loader = createToolAuthzLoader(dir, undefined, { metrics: m });
    expect(loader.policyStale).toBe(false);
    expect(loader.hasPolicy).toBe(true);
    expect(loader.engine.evaluate("any/tool", {}, ctx()).allowed).toBe(true);
    expect(m.render()).not.toContain("aiperator_policy_stale_total");
  });

  test("malformed JSON after a good load keeps the old policy and marks stale", () => {
    writePolicy(JSON.stringify(GOOD_POLICY));
    const m = createMetrics(true);
    const loader = createToolAuthzLoader(dir, undefined, { metrics: m });
    expect(loader.policyStale).toBe(false);

    // Break the file and reload — the last-known-good policy stays in effect.
    writePolicy("{ this is not valid json");
    loader.reload();

    expect(loader.policyStale).toBe(true);
    // The previous (allow-all) engine is still enforced.
    expect(loader.engine.evaluate("any/tool", {}, ctx()).allowed).toBe(true);
    // Empty-labels counter renders as a bare series name.
    expect(m.render()).toContain("aiperator_policy_stale_total 1");
  });

  test("first-load malformed JSON fails closed (deny-all) and marks stale", () => {
    writePolicy("{ broken");
    const m = createMetrics(true);
    const loader = createToolAuthzLoader(dir, undefined, {
      failClosed: true,
      metrics: m,
    });
    expect(loader.policyStale).toBe(true);
    // No last-known-good policy exists, so every call is denied.
    expect(loader.engine.evaluate("any/tool", {}, ctx()).allowed).toBe(false);
    expect(m.render()).toContain("aiperator_policy_stale_total 1");
  });

  test("stale flag clears after a successful reload following a failure", () => {
    writePolicy(JSON.stringify(GOOD_POLICY));
    const m = createMetrics(true);
    const loader = createToolAuthzLoader(dir, undefined, { metrics: m });

    writePolicy("{ broken");
    loader.reload();
    expect(loader.policyStale).toBe(true);

    // Repair the file — the next successful reload clears the flag.
    writePolicy(JSON.stringify({ defaultAction: "allow", rules: [] }));
    loader.reload();
    expect(loader.policyStale).toBe(false);
    // The counter is cumulative: it recorded the one failure and stays at 1.
    expect(m.render()).toContain("aiperator_policy_stale_total 1");
  });

  test("each failed reload increments the counter again", () => {
    writePolicy(JSON.stringify(GOOD_POLICY));
    const m = createMetrics(true);
    const loader = createToolAuthzLoader(dir, undefined, { metrics: m });

    writePolicy("{ broken");
    loader.reload();
    loader.reload();
    loader.reload();

    expect(loader.policyStale).toBe(true);
    expect(m.render()).toContain("aiperator_policy_stale_total 3");
  });

  test("save() rejects an invalid policy without touching disk or flag", () => {
    const m = createMetrics(true);
    const loader = createToolAuthzLoader(dir, undefined, { metrics: m });
    const res = loader.save({ rules: [{ id: "x", tool: "*", action: "nope" }] });
    expect(res.ok).toBe(false);
    expect(fs.existsSync(path.join(dir, TOOL_AUTHZ_FILE))).toBe(false);
    expect(loader.policyStale).toBe(false);
  });

  test("save() persists a valid policy and reloads it", () => {
    const m = createMetrics(true);
    const loader = createToolAuthzLoader(dir, undefined, { metrics: m });
    const res = loader.save(GOOD_POLICY);
    expect(res.ok).toBe(true);
    expect(loader.hasPolicy).toBe(true);
    expect(loader.policyStale).toBe(false);
    expect(loader.engine.evaluate("any/tool", {}, ctx()).allowed).toBe(true);
  });
});
