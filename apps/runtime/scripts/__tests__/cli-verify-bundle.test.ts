// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * `verify-bundle` (ADR 0030): Ed25519 bundles verify against a JWKS
 * (`--jwks <url|file> [--kid]`) without any shared secret; legacy HMAC
 * bundles keep working via `--secret`. The wrong key material for the
 * envelope's algorithm must fail, not pass.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEvidenceBundle,
  signEvidenceBundle,
  type SignedEvidenceBundle,
} from "../../src/observability/evidence-bundle.js";
import { parseEvidenceSigningKey } from "../../src/observability/evidence-key.js";
import type { ExplainCard } from "../../src/observability/explain.js";

const cli = join(import.meta.dir, "..", "cli.ts");
const SECRET = "a-shared-signing-secret-at-least-16-chars";

function seed(n: number): string {
  return Buffer.from(Array.from({ length: 32 }, (_, i) => (i + n) % 256)).toString("base64");
}

function card(): ExplainCard {
  return {
    executionId: "exec-cli-1",
    flowId: "my-flow",
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:02.000Z",
    totalLatencyMs: 2000,
    totalCost: 0.001,
    userName: "alice",
    userPrompt: "hello",
    steps: [],
    modelsUsed: [],
    routingDecisions: [],
    auditEntries: [],
    degraded: [],
  };
}

describe("verify-bundle --jwks (Ed25519, ADR 0030)", () => {
  let dir: string;
  const run = (...argv: string[]) =>
    Bun.spawnSync(["bun", "run", cli, "verify-bundle", ...argv], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, EVIDENCE_BUNDLE_SECRET: "", AUDIT_ANCHOR_SECRET: "" },
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-verify-bundle-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("verifies an Ed25519 bundle against a JWKS file, no secret needed", () => {
    const key = parseEvidenceSigningKey(seed(1));
    if (key === undefined) throw new Error("key parse failed");
    const signed = signEvidenceBundle(buildEvidenceBundle(card()), key);
    const bundleFile = join(dir, "bundle.json");
    const jwksFile = join(dir, "jwks.json");
    writeFileSync(bundleFile, JSON.stringify(signed));
    writeFileSync(jwksFile, JSON.stringify({ keys: [key.jwk] }));

    const res = run(bundleFile, "--jwks", jwksFile);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toContain("are valid");
    expect(res.stdout.toString()).toContain("ed25519");
    expect(res.stdout.toString()).toContain(key.kid);
  });

  test("detects tampered content via the content hash", () => {
    const key = parseEvidenceSigningKey(seed(2));
    if (key === undefined) throw new Error("key parse failed");
    const signed = signEvidenceBundle(buildEvidenceBundle(card()), key);
    const tampered: SignedEvidenceBundle = {
      ...signed,
      bundle: { ...signed.bundle, executionId: "exec-other" },
    };
    const bundleFile = join(dir, "bundle.json");
    const jwksFile = join(dir, "jwks.json");
    writeFileSync(bundleFile, JSON.stringify(tampered));
    writeFileSync(jwksFile, JSON.stringify({ keys: [key.jwk] }));

    const res = run(bundleFile, "--jwks", jwksFile);
    expect(res.exitCode).toBe(1);
    expect(res.stderr.toString()).toContain("content hash");
  });

  test("selects the matching key from a multi-key JWKS by --kid", () => {
    const keyA = parseEvidenceSigningKey(seed(3));
    const keyB = parseEvidenceSigningKey(seed(4));
    if (keyA === undefined || keyB === undefined) throw new Error("key parse failed");
    const signed = signEvidenceBundle(buildEvidenceBundle(card()), keyB);
    const bundleFile = join(dir, "bundle.json");
    const jwksFile = join(dir, "jwks.json");
    writeFileSync(bundleFile, JSON.stringify(signed));
    writeFileSync(jwksFile, JSON.stringify({ keys: [keyA.jwk, keyB.jwk] }));

    // Without --kid, the bundle's own kid selects the key.
    const auto = run(bundleFile, "--jwks", jwksFile);
    expect(auto.exitCode).toBe(0);
    expect(auto.stdout.toString()).toContain("are valid");

    // The wrong key must fail, not pass.
    const wrong = run(bundleFile, "--jwks", jwksFile, "--kid", keyA.kid);
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr.toString()).toContain("Ed25519 signature does not match");

    const right = run(bundleFile, "--jwks", jwksFile, "--kid", keyB.kid);
    expect(right.exitCode).toBe(0);
    expect(right.stdout.toString()).toContain("are valid");
  });

  test("an Ed25519 bundle does not verify with a legacy --secret", () => {
    const key = parseEvidenceSigningKey(seed(5));
    if (key === undefined) throw new Error("key parse failed");
    const signed = signEvidenceBundle(buildEvidenceBundle(card()), key);
    const bundleFile = join(dir, "bundle.json");
    writeFileSync(bundleFile, JSON.stringify(signed));

    const res = run(bundleFile, "--secret", SECRET);
    expect(res.exitCode).toBe(1);
    expect(res.stderr.toString()).toContain("Verification FAILED");
  });

  test("legacy HMAC bundles still verify with --secret", () => {
    const signed = signEvidenceBundle(buildEvidenceBundle(card()), SECRET);
    const bundleFile = join(dir, "bundle.json");
    writeFileSync(bundleFile, JSON.stringify(signed));

    const res = run(bundleFile, "--secret", SECRET);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toContain("hmac-sha256");
  });

  test("missing verifier material is a usage error naming both options", () => {
    const bundleFile = join(dir, "bundle.json");
    writeFileSync(bundleFile, JSON.stringify(signEvidenceBundle(buildEvidenceBundle(card()), SECRET)));
    const res = run(bundleFile);
    expect(res.exitCode).toBe(1);
    expect(res.stderr.toString()).toContain("--jwks");
    expect(res.stderr.toString()).toContain("--secret");
  });
});
