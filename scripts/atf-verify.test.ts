// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  base64UrlDecode,
  base64UrlEncode,
} from "../packages/security-kit/src/base64url.ts";
import { parseReceiptSigningKey } from "../apps/runtime/src/receipts/signing-key.ts";
import { signReceiptPayload } from "../apps/runtime/src/receipts/receipt-builder.ts";
import { InMemoryTransparencyLog } from "../apps/runtime/src/receipts/transparency-log.ts";
import type { DecisionReceiptPayload } from "../apps/runtime/src/receipts/types.ts";
import {
  parseEvidenceSigningKey,
  type Ed25519EvidenceKey,
} from "../apps/runtime/src/observability/evidence-key.ts";
import {
  buildEvidenceBundle,
  signEvidenceBundle,
  type SignedEvidenceBundle,
} from "../apps/runtime/src/observability/evidence-bundle.ts";
import type { ExplainCard } from "../apps/runtime/src/observability/explain.ts";
import {
  ed25519ReceiptKey,
  hmacReceiptKey,
  signReceipt,
  type ErasureReceiptEnvelope,
} from "../apps/runtime/src/compliance/erasure-receipt.ts";
import type { ErasureReceiptPayload } from "../packages/erasure-contract/src/receipt.ts";
import {
  InMemoryAuditLog,
  signAuditAnchor,
  type AuditRecord,
} from "../apps/runtime/src/observability/audit-log.ts";
import {
  buildReleaseReceipt,
  signReleaseReceipt,
  type FlowReleaseReceipt,
} from "../apps/runtime/src/eval/flow-release.ts";
import { signCitationImpact } from "../apps/runtime/src/compliance/citation-impact.ts";

const CLI = join(import.meta.dir, "atf-verify.ts");
// A fixed 32-byte Ed25519 seed (base64) so the kid is deterministic.
const SEED_B64 = Buffer.alloc(32, 7).toString("base64");

function fixturePayload(receiptId: string): DecisionReceiptPayload {
  return {
    receipt_id: receiptId,
    typ: "atf.decision-receipt",
    version: 1,
    kind: "chat_completion",
    parent_receipt_id: null,
    execution_id: `exec-${receiptId}`,
    tenant_id: "acme",
    flow_id: "flows/test",
    flow_version: "1.0.0",
    status: "completed",
    policy_hashes: {
      prompt_template: null,
      tool_authz: "atf:tool-authz:noop",
      compliance: "atf:compliance:none",
    },
    models: [{ model: "openai/gpt-4o", provider: "openai" }],
    pii: null,
    retrieval_sources: [],
    approvals: [],
    tool_calls: [],
    cost: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      usd: 0.01,
    },
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:00:01.000Z",
    response_hash: "a".repeat(64),
  };
}

interface Artifacts {
  dir: string;
  receiptPath: string;
  proofPath: string;
  jwksPath: string;
  kid: string;
}

/** Issue a receipt, append it to a transparency log, and write the three
 * files a holder would download from the Runtime. */
async function makeArtifacts(receiptId: string): Promise<Artifacts> {
  const key = await parseReceiptSigningKey(SEED_B64);
  const signed = await signReceiptPayload(
    fixturePayload(receiptId),
    key.privateKey,
    key.kid,
  );
  const log = new InMemoryTransparencyLog(key.privateKey, key.kid);
  await log.append(receiptId, signed.coseBytes);
  await log.sealTreeHead();
  const proof = await log.proofForReceipt(receiptId);
  const head = log.latestTreeHead();
  if (proof === undefined || head === undefined) {
    throw new Error("fixture: missing proof or head");
  }
  const dir = await mkdtemp(join(tmpdir(), "atf-verify-"));
  const receiptPath = join(dir, "receipt.json");
  const proofPath = join(dir, "proof.json");
  const jwksPath = join(dir, "jwks.json");
  await writeFile(
    receiptPath,
    JSON.stringify({
      receipt_id: receiptId,
      cose_base64: base64UrlEncode(signed.coseBytes),
      payload: {},
    }),
  );
  await writeFile(
    proofPath,
    JSON.stringify({
      receipt_id: receiptId,
      proof: {
        leaf_index: proof.leafIndex,
        tree_size: proof.treeSize,
        node_hashes: proof.nodeHashes,
      },
      tree_head: {
        tree_size: head.treeSize,
        cose_base64: base64UrlEncode(head.coseBytes),
      },
    }),
  );
  await writeFile(
    jwksPath,
    JSON.stringify({
      keys: [{ ...key.jwk, kid: key.kid, alg: "EdDSA", use: "sig" }],
    }),
  );
  return { dir, receiptPath, proofPath, jwksPath, kid: key.kid };
}

async function runCli(args: readonly string[]): Promise<{
  exit: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exit: await proc.exited, stdout: out, stderr: err };
}

describe("atf-verify CLI", () => {
  it("verifies a valid receipt offline (exit 0)", async () => {
    const a = await makeArtifacts("r-ok");
    const r = await runCli([
      "--receipt",
      a.receiptPath,
      "--jwks",
      a.jwksPath,
      "--json",
    ]);
    expect(r.exit).toBe(0);
    const report = JSON.parse(r.stdout) as {
      valid: boolean;
      receipt_id: string;
      kid: string;
      signature_valid: boolean;
      summary: Record<string, string>;
    };
    expect(report.valid).toBe(true);
    expect(report.receipt_id).toBe("r-ok");
    expect(report.kid).toBe(a.kid);
    expect(report.signature_valid).toBe(true);
    expect(report.summary.flow_id).toBe("flows/test");
  });

  it("verifies receipt + inclusion proof (exit 0)", async () => {
    const a = await makeArtifacts("r-proof");
    const r = await runCli([
      "--receipt",
      a.receiptPath,
      "--jwks",
      a.jwksPath,
      "--proof",
      a.proofPath,
      "--json",
    ]);
    expect(r.exit).toBe(0);
    const report = JSON.parse(r.stdout) as {
      valid: boolean;
      inclusion: {
        valid: boolean;
        head_signature_valid: boolean;
        tree_size: number;
      } | null;
    };
    expect(report.valid).toBe(true);
    expect(report.inclusion?.valid).toBe(true);
    expect(report.inclusion?.head_signature_valid).toBe(true);
    expect(report.inclusion?.tree_size).toBe(1);
  });

  it("rejects a tampered receipt (exit 1)", async () => {
    const a = await makeArtifacts("r-tamper");
    const doc = JSON.parse(await readFile(a.receiptPath, "utf8")) as {
      cose_base64: string;
    };
    const bytes = base64UrlDecode(doc.cose_base64);
    // Flip a bit inside the COSE payload (well before the trailing signature)
    // so the message stays decodable but no longer verifies.
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    await writeFile(
      a.receiptPath,
      JSON.stringify({ ...doc, cose_base64: base64UrlEncode(bytes) }),
    );
    const r = await runCli([
      "--receipt",
      a.receiptPath,
      "--jwks",
      a.jwksPath,
      "--json",
    ]);
    expect(r.exit).toBe(1);
  });

  it("rejects a receipt signed with a different key (exit 1)", async () => {
    const a = await makeArtifacts("r-other");
    const otherKey = await parseReceiptSigningKey(
      Buffer.alloc(32, 9).toString("base64"),
    );
    await writeFile(
      a.jwksPath,
      JSON.stringify({
        keys: [{ ...otherKey.jwk, kid: otherKey.kid, alg: "EdDSA", use: "sig" }],
      }),
    );
    const r = await runCli([
      "--receipt",
      a.receiptPath,
      "--jwks",
      a.jwksPath,
      "--kid",
      otherKey.kid,
      "--json",
    ]);
    expect(r.exit).toBe(1);
    const report = JSON.parse(r.stdout) as {
      valid: boolean;
      signature_valid: boolean;
    };
    expect(report.valid).toBe(false);
    expect(report.signature_valid).toBe(false);
  });

  it("rejects a proof from a different tree (exit 1)", async () => {
    const a = await makeArtifacts("r-tree");
    const key = await parseReceiptSigningKey(SEED_B64);
    const receiptBytes = base64UrlDecode(
      (JSON.parse(await readFile(a.receiptPath, "utf8")) as {
        cose_base64: string;
      }).cose_base64,
    );
    // Grow a fresh log with the same receipt plus a second entry and seal a
    // NEW head over tree size 2. The old single-leaf proof (tree size 1)
    // recomputes a different root than the new head covers — invalid.
    const signed2 = await signReceiptPayload(
      fixturePayload("r-tree-2"),
      key.privateKey,
      key.kid,
    );
    const log = new InMemoryTransparencyLog(key.privateKey, key.kid);
    await log.append("r-tree", receiptBytes);
    await log.append("r-tree-2", signed2.coseBytes);
    await log.sealTreeHead();
    const head = log.latestTreeHead();
    if (head === undefined) throw new Error("fixture: missing head");
    // Old proof (leaf 0, tree 1) against the new head (tree 2): invalid.
    await writeFile(
      a.proofPath,
      JSON.stringify({
        receipt_id: "r-tree",
        proof: { leaf_index: 0, tree_size: 1, node_hashes: [] },
        tree_head: {
          tree_size: head.treeSize,
          cose_base64: base64UrlEncode(head.coseBytes),
        },
      }),
    );
    const r = await runCli([
      "--receipt",
      a.receiptPath,
      "--jwks",
      a.jwksPath,
      "--proof",
      a.proofPath,
      "--json",
    ]);
    expect(r.exit).toBe(1);
    const report = JSON.parse(r.stdout) as {
      valid: boolean;
      inclusion: { valid: boolean; head_signature_valid: boolean } | null;
    };
    expect(report.inclusion?.head_signature_valid).toBe(true);
    expect(report.inclusion?.valid).toBe(false);
    expect(report.valid).toBe(false);
  });

  it("accepts raw COSE bytes as receipt input", async () => {
    const a = await makeArtifacts("r-raw");
    const doc = JSON.parse(await readFile(a.receiptPath, "utf8")) as {
      cose_base64: string;
    };
    const rawPath = join(a.dir, "receipt.cose");
    await Bun.write(rawPath, base64UrlDecode(doc.cose_base64));
    const r = await runCli(["--receipt", rawPath, "--jwks", a.jwksPath]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("RESULT: VALID");
  });

  it("fails with usage errors (exit 2)", async () => {
    const r1 = await runCli([]);
    expect(r1.exit).toBe(2);
    expect(r1.stderr).toContain(
      "--receipt, --bundle, --erasure-receipt, --release-receipt, --citation-impact or --audit-export is required",
    );
    const a = await makeArtifacts("r-usage");
    const r2 = await runCli(["--receipt", a.receiptPath, "--jwks", "/nope/x"]);
    expect(r2.exit).toBe(2);
    expect(r2.stderr).toContain("cannot read JWKS file");
  });

  it("prints help with --help (exit 0)", async () => {
    const r = await runCli(["--help"]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("atf-verify");
  });
});

// ---------------------------------------------------------------------------
// --bundle mode
// ---------------------------------------------------------------------------

function fixtureCard(executionId: string): ExplainCard {
  return {
    executionId,
    flowId: "flows/test",
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    totalLatencyMs: 1000,
    totalCost: 0.01,
    userName: "alice",
    userPrompt: "hello",
    steps: [],
    modelsUsed: [],
    routingDecisions: [],
    auditEntries: [],
    degraded: [],
  };
}

interface BundleArtifacts {
  dir: string;
  bundlePath: string;
  jwksPath: string;
  kid: string;
  signed: SignedEvidenceBundle;
}

/** Build and sign an Ed25519 Evidence Bundle and write the bundle JSON plus
 * the evidence JWKS a holder would download. */
async function makeBundleArtifacts(executionId: string): Promise<BundleArtifacts> {
  const key = parseEvidenceSigningKey(SEED_B64);
  if (key === undefined) throw new Error("fixture: evidence key parse failed");
  const signed = signEvidenceBundle(
    buildEvidenceBundle(fixtureCard(executionId), { now: () => 1_767_225_600_000 }),
    key,
  );
  const dir = await mkdtemp(join(tmpdir(), "atf-verify-bundle-"));
  const bundlePath = join(dir, "bundle.json");
  const jwksPath = join(dir, "jwks.json");
  await writeFile(bundlePath, JSON.stringify(signed));
  await writeFile(
    jwksPath,
    JSON.stringify({
      keys: [{ ...key.jwk, kid: key.kid, alg: "EdDSA", use: "sig" }],
    }),
  );
  return { dir, bundlePath, jwksPath, kid: key.kid, signed };
}

describe("atf-verify --bundle", () => {
  it("verifies a valid Ed25519 bundle (exit 0)", async () => {
    const a = await makeBundleArtifacts("exec-bundle-ok");
    const r = await runCli(["--bundle", a.bundlePath, "--jwks", a.jwksPath]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("RESULT: VALID");
    expect(r.stdout).toContain("exec-bundle-ok");
  });

  it("emits a JSON report with --json", async () => {
    const a = await makeBundleArtifacts("exec-bundle-json");
    const r = await runCli([
      "--bundle",
      a.bundlePath,
      "--jwks",
      a.jwksPath,
      "--json",
    ]);
    expect(r.exit).toBe(0);
    const report = JSON.parse(r.stdout) as {
      valid: boolean;
      mode: string;
      execution_id: string;
      kid: string;
      algorithm: string;
      content_hash_valid: boolean;
      signature_valid: boolean;
    };
    expect(report.valid).toBe(true);
    expect(report.mode).toBe("bundle");
    expect(report.execution_id).toBe("exec-bundle-json");
    expect(report.kid).toBe(a.kid);
    expect(report.algorithm).toBe("ed25519");
    expect(report.content_hash_valid).toBe(true);
    expect(report.signature_valid).toBe(true);
  });

  it("fails on a tampered bundle (exit 1)", async () => {
    const a = await makeBundleArtifacts("exec-bundle-tampered");
    const tampered = JSON.parse(
      JSON.stringify(a.signed),
    ) as SignedEvidenceBundle;
    // Alter the embedded card but keep the stale content hash.
    (tampered.bundle.card as { userPrompt: string | null }).userPrompt =
      "tampered";
    const tamperedPath = join(a.dir, "tampered.json");
    await writeFile(tamperedPath, JSON.stringify(tampered));
    const r = await runCli(["--bundle", tamperedPath, "--jwks", a.jwksPath]);
    expect(r.exit).toBe(1);
    expect(r.stdout).toContain("RESULT: INVALID");
    expect(r.stderr).toContain("content does not match its recorded content hash");
  });

  it("fails with exit 2 for an unknown --kid", async () => {
    const a = await makeBundleArtifacts("exec-bundle-wrongkid");
    const r = await runCli([
      "--bundle",
      a.bundlePath,
      "--jwks",
      a.jwksPath,
      "--kid",
      "unknown-kid",
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain('no JWKS key with kid "unknown-kid"');
  });

  it("rejects mode-flag misuse (exit 2)", async () => {
    const a = await makeBundleArtifacts("exec-bundle-modes");
    const both = await runCli([
      "--bundle",
      a.bundlePath,
      "--receipt",
      join(a.dir, "receipt.json"),
      "--jwks",
      a.jwksPath,
    ]);
    expect(both.exit).toBe(2);
    expect(both.stderr).toContain("cannot be combined");

    const noJwks = await runCli(["--bundle", a.bundlePath]);
    expect(noJwks.exit).toBe(2);
    expect(noJwks.stderr).toContain("--jwks is required");

    const missing = await runCli(["--bundle", join(a.dir, "nope.json"), "--jwks", a.jwksPath]);
    expect(missing.exit).toBe(2);
    expect(missing.stderr).toContain("cannot read bundle file");
  });
});

// ---------------------------------------------------------------------------
// --erasure-receipt mode
// ---------------------------------------------------------------------------

// The receipt id must be a UUID (contract schema); the fixture derives one
// deterministically from a label so tests can assert on it.
function fixtureReceiptId(label: string): string {
  const hex = Buffer.from(label.padEnd(36, "-").slice(0, 36), "utf8").toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function fixtureErasurePayload(receiptId: string): ErasureReceiptPayload {
  return {
    receiptId,
    requestId: "5f0c7a52-2c6e-4e6a-9b98-3b1a2c3d4e5f",
    tenantId: "acme",
    scope: "subject",
    subjectHashes: ["a".repeat(64)],
    completedAt: "2026-01-01T00:00:00.000Z",
    results: [{ store: "search", status: "ok", erased: 3 }],
    status: "complete",
  };
}

async function makeErasureArtifacts(label: string): Promise<{
  dir: string;
  receiptId: string;
  receiptPath: string;
  jwksPath: string;
  kid: string;
  envelope: ErasureReceiptEnvelope;
}> {
  const dir = await mkdtemp(join(tmpdir(), "atf-verify-erasure-"));
  const receiptId = fixtureReceiptId(label);
  const key = ed25519ReceiptKey(SEED_B64);
  if (key === undefined) throw new Error("fixture signing key missing");
  const envelope = signReceipt(fixtureErasurePayload(receiptId), key);
  const receiptPath = join(dir, "receipt.json");
  await writeFile(receiptPath, JSON.stringify(envelope));
  // The Ed25519 receipt kid is the same thumbprint as the evidence key, so a
  // single-key evidence JWKS verifies the receipt.
  const evidenceKey = parseEvidenceSigningKey(SEED_B64);
  if (evidenceKey === undefined) throw new Error("fixture JWKS key missing");
  const jwksPath = join(dir, "jwks.json");
  await writeFile(
    jwksPath,
    JSON.stringify({
      keys: [{ ...evidenceKey.jwk, kid: evidenceKey.kid, alg: "EdDSA", use: "sig" }],
    }),
  );
  return { dir, receiptId, receiptPath, jwksPath, kid: evidenceKey.kid, envelope };
}

describe("atf-verify --erasure-receipt", () => {
  it("verifies a valid Ed25519 erasure receipt (exit 0)", async () => {
    const a = await makeErasureArtifacts("erasure-ok");
    const r = await runCli([
      "--erasure-receipt",
      a.receiptPath,
      "--jwks",
      a.jwksPath,
    ]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("RESULT: VALID");
    expect(r.stdout).toContain(a.receiptId);
  });

  it("emits a JSON report with --json", async () => {
    const a = await makeErasureArtifacts("erasure-json");
    const r = await runCli([
      "--erasure-receipt",
      a.receiptPath,
      "--jwks",
      a.jwksPath,
      "--json",
    ]);
    expect(r.exit).toBe(0);
    const report = JSON.parse(r.stdout) as {
      valid: boolean;
      mode: string;
      receipt_id: string;
      tenant_id: string;
      scope: string;
      status: string;
      algorithm: string;
      kid: string;
      signature_valid: boolean;
    };
    expect(report.valid).toBe(true);
    expect(report.mode).toBe("erasure-receipt");
    expect(report.receipt_id).toBe(a.receiptId);
    expect(report.tenant_id).toBe("acme");
    expect(report.scope).toBe("subject");
    expect(report.status).toBe("complete");
    expect(report.algorithm).toBe("Ed25519");
    expect(report.kid).toBe(a.kid);
    expect(report.signature_valid).toBe(true);
  });

  it("uses the single JWKS key when the envelope has no kid", async () => {
    const a = await makeErasureArtifacts("erasure-nokid");
    // An HS256-style envelope has no kid; simulate the Ed25519 case by
    // stripping the kid from a valid envelope and re-signing with the same key.
    const key = ed25519ReceiptKey(SEED_B64);
    if (key === undefined) throw new Error("fixture signing key missing");
    const noKid = { ...signReceipt(a.envelope.payload, key), kid: undefined };
    const path = join(a.dir, "no-kid.json");
    await writeFile(path, JSON.stringify(noKid));
    const r = await runCli(["--erasure-receipt", path, "--jwks", a.jwksPath]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("RESULT: VALID");
  });

  it("fails on a modified payload with stale signature (exit 1)", async () => {
    const a = await makeErasureArtifacts("erasure-tampered");
    const tampered = JSON.parse(JSON.stringify(a.envelope)) as {
      payload: { tenantId: string };
    };
    tampered.payload.tenantId = "evil";
    const path = join(a.dir, "tampered.json");
    await writeFile(path, JSON.stringify(tampered));
    const r = await runCli(["--erasure-receipt", path, "--jwks", a.jwksPath]);
    expect(r.exit).toBe(1);
    expect(r.stdout).toContain("RESULT: INVALID");
    expect(r.stderr).toContain("signature does not verify against this key");
  });

  it("fails on a schema-invalid payload even with a valid signature (exit 1)", async () => {
    const a = await makeErasureArtifacts("erasure-badschema");
    const key = ed25519ReceiptKey(SEED_B64);
    if (key === undefined) throw new Error("fixture signing key missing");
    // Sign a payload that does not satisfy the contract schema (bad scope).
    const bad = {
      ...fixtureErasurePayload("erasure-badschema"),
      scope: "everything",
    } as unknown as ErasureReceiptPayload;
    const envelope = signReceipt(bad, key);
    const path = join(a.dir, "bad-schema.json");
    await writeFile(path, JSON.stringify(envelope));
    const r = await runCli(["--erasure-receipt", path, "--jwks", a.jwksPath]);
    expect(r.exit).toBe(1);
    expect(r.stdout).toContain("RESULT: INVALID");
    expect(r.stderr).toContain("payload is not a valid erasure receipt");
  });

  it("rejects HS256 receipts with the shared-secret message (exit 2)", async () => {
    const a = await makeErasureArtifacts("erasure-hmac");
    const hmacKey = hmacReceiptKey("s".repeat(32));
    if (hmacKey === undefined) throw new Error("fixture HMAC key missing");
    const envelope = signReceipt(a.envelope.payload, hmacKey);
    const path = join(a.dir, "hmac.json");
    await writeFile(path, JSON.stringify(envelope));
    const r = await runCli(["--erasure-receipt", path, "--jwks", a.jwksPath]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain(
      "HMAC receipts need the shared secret; use the Runtime API",
    );
  });

  it("fails with exit 2 for an unknown --kid", async () => {
    const a = await makeErasureArtifacts("erasure-wrongkid");
    const r = await runCli([
      "--erasure-receipt",
      a.receiptPath,
      "--jwks",
      a.jwksPath,
      "--kid",
      "unknown-kid",
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain('no JWKS key with kid "unknown-kid"');
  });

  it("rejects mode-flag misuse and bad input (exit 2)", async () => {
    const a = await makeErasureArtifacts("erasure-modes");
    const both = await runCli([
      "--erasure-receipt",
      a.receiptPath,
      "--bundle",
      join(a.dir, "bundle.json"),
      "--jwks",
      a.jwksPath,
    ]);
    expect(both.exit).toBe(2);
    expect(both.stderr).toContain("cannot be combined");

    const proof = await runCli([
      "--erasure-receipt",
      a.receiptPath,
      "--jwks",
      a.jwksPath,
      "--proof",
      join(a.dir, "proof.json"),
    ]);
    expect(proof.exit).toBe(2);
    expect(proof.stderr).toContain("--proof is only valid with --receipt");

    const missing = await runCli([
      "--erasure-receipt",
      join(a.dir, "nope.json"),
      "--jwks",
      a.jwksPath,
    ]);
    expect(missing.exit).toBe(2);
    expect(missing.stderr).toContain("cannot read erasure receipt file");

    const notJson = join(a.dir, "not-json.json");
    await writeFile(notJson, "hello");
    const bad = await runCli(["--erasure-receipt", notJson, "--jwks", a.jwksPath]);
    expect(bad.exit).toBe(2);
    expect(bad.stderr).toContain("erasure receipt file is not valid JSON");

    const wrongTyp = join(a.dir, "wrong-typ.json");
    await writeFile(
      wrongTyp,
      JSON.stringify({ ...a.envelope, typ: "atf-something-else/1.0.0" }),
    );
    const typ = await runCli(["--erasure-receipt", wrongTyp, "--jwks", a.jwksPath]);
    expect(typ.exit).toBe(2);
    expect(typ.stderr).toContain('no "typ" of "atf-erasure-receipt/1.0.0"');
  });
});

async function makeReleaseArtifacts(label: string): Promise<{
  dir: string;
  receiptPath: string;
  jwksPath: string;
  kid: string;
  receipt: FlowReleaseReceipt;
}> {
  const dir = await mkdtemp(join(tmpdir(), "atf-verify-release-"));
  const key = parseEvidenceSigningKey(SEED_B64);
  if (key === undefined) throw new Error("fixture signing key missing");
  const receipt = signReleaseReceipt(
    buildReleaseReceipt({
      flowId: `flow-${label}`,
      flowVersion: "1.2.4",
      flowDigest: "sha256:aaa",
      baseRef: "v1.2.3",
      baseFlowVersion: "1.2.3",
      benchDigest: "sha256:bbb",
      results: { cases: 3, passed: 3, passRate: 1, latencyMsP50: 12, tokensP50: 20 },
      thresholds: { passRate: 1, maxLatencyMsP50: 30_000 },
      createdAt: "2026-02-22T12:00:00.000Z",
    }),
    key,
  );
  const receiptPath = join(dir, "release-receipt.json");
  await writeFile(receiptPath, JSON.stringify(receipt));
  const jwksPath = join(dir, "jwks.json");
  await writeFile(
    jwksPath,
    JSON.stringify({
      keys: [{ ...key.jwk, kid: key.kid, alg: "EdDSA", use: "sig" }],
    }),
  );
  return { dir, receiptPath, jwksPath, kid: key.kid, receipt };
}

describe("atf-verify --release-receipt", () => {
  it("verifies a valid signed release receipt (exit 0)", async () => {
    const a = await makeReleaseArtifacts("release-ok");
    const r = await runCli([
      "--release-receipt",
      a.receiptPath,
      "--jwks",
      a.jwksPath,
    ]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("RESULT: VALID");
    expect(r.stdout).toContain("flow-release-ok");
  });

  it("emits a JSON report with --json", async () => {
    const a = await makeReleaseArtifacts("release-json");
    const r = await runCli([
      "--release-receipt",
      a.receiptPath,
      "--jwks",
      a.jwksPath,
      "--json",
    ]);
    expect(r.exit).toBe(0);
    const report = JSON.parse(r.stdout) as {
      valid: boolean;
      mode: string;
      flow_id: string;
      flow_version: string;
      flow_digest: string;
      base_ref: string;
      base_flow_version: string;
      bench_digest: string;
      pass_rate: number;
      created_at: string;
      algorithm: string;
      kid: string;
      signature_valid: boolean;
    };
    expect(report.valid).toBe(true);
    expect(report.mode).toBe("release-receipt");
    expect(report.flow_id).toBe("flow-release-json");
    expect(report.flow_version).toBe("1.2.4");
    expect(report.flow_digest).toBe("sha256:aaa");
    expect(report.base_ref).toBe("v1.2.3");
    expect(report.base_flow_version).toBe("1.2.3");
    expect(report.bench_digest).toBe("sha256:bbb");
    expect(report.pass_rate).toBe(1);
    expect(report.created_at).toBe("2026-02-22T12:00:00.000Z");
    expect(report.algorithm).toBe("EdDSA");
    expect(report.kid).toBe(a.kid);
    expect(report.signature_valid).toBe(true);
  });

  it("fails on a tampered field with stale signature (exit 1)", async () => {
    const a = await makeReleaseArtifacts("release-tampered");
    const tampered = JSON.parse(JSON.stringify(a.receipt)) as FlowReleaseReceipt;
    tampered.results.passRate = 0.5;
    const path = join(a.dir, "tampered.json");
    await writeFile(path, JSON.stringify(tampered));
    const r = await runCli(["--release-receipt", path, "--jwks", a.jwksPath]);
    expect(r.exit).toBe(1);
    expect(r.stdout).toContain("RESULT: INVALID");
    expect(r.stderr).toContain("signature does not verify against this key");
  });

  it("fails on a schema-invalid document even with a valid signature (exit 1)", async () => {
    const a = await makeReleaseArtifacts("release-badschema");
    const key = parseEvidenceSigningKey(SEED_B64);
    if (key === undefined) throw new Error("fixture signing key missing");
    // Sign a document that does not satisfy the receipt schema (passRate > 1).
    const bad = signReleaseReceipt(
      buildReleaseReceipt({
        flowId: "flow-release-badschema",
        flowVersion: "1.0.0",
        flowDigest: "sha256:aaa",
        benchDigest: "sha256:bbb",
        results: { cases: 1, passed: 1, passRate: 2, latencyMsP50: 1, tokensP50: 0 },
        thresholds: { passRate: 1 },
        createdAt: "2026-02-22T12:00:00.000Z",
      }),
      key,
    );
    const path = join(a.dir, "bad-schema.json");
    await writeFile(path, JSON.stringify(bad));
    const r = await runCli(["--release-receipt", path, "--jwks", a.jwksPath]);
    expect(r.exit).toBe(1);
    expect(r.stdout).toContain("RESULT: INVALID");
    expect(r.stderr).toContain("document is not a valid release receipt");
  });

  it("fails with exit 2 for an unknown --kid", async () => {
    const a = await makeReleaseArtifacts("release-wrongkid");
    const r = await runCli([
      "--release-receipt",
      a.receiptPath,
      "--jwks",
      a.jwksPath,
      "--kid",
      "unknown-kid",
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain('no JWKS key with kid "unknown-kid"');
  });

  it("rejects mode-flag misuse and bad input (exit 2)", async () => {
    const a = await makeReleaseArtifacts("release-modes");
    const both = await runCli([
      "--release-receipt",
      a.receiptPath,
      "--bundle",
      join(a.dir, "bundle.json"),
      "--jwks",
      a.jwksPath,
    ]);
    expect(both.exit).toBe(2);
    expect(both.stderr).toContain("cannot be combined");

    const missing = await runCli([
      "--release-receipt",
      join(a.dir, "nope.json"),
      "--jwks",
      a.jwksPath,
    ]);
    expect(missing.exit).toBe(2);
    expect(missing.stderr).toContain("cannot read release receipt file");

    const notJson = join(a.dir, "not-json.json");
    await writeFile(notJson, "hello");
    const bad = await runCli(["--release-receipt", notJson, "--jwks", a.jwksPath]);
    expect(bad.exit).toBe(2);
    expect(bad.stderr).toContain("release receipt file is not valid JSON");

    const wrongType = join(a.dir, "wrong-type.json");
    await writeFile(
      wrongType,
      JSON.stringify({ ...a.receipt, type: "atf.something-else" }),
    );
    const typ = await runCli([
      "--release-receipt",
      wrongType,
      "--jwks",
      a.jwksPath,
    ]);
    expect(typ.exit).toBe(2);
    expect(typ.stderr).toContain('no "type" of "atf.flow-release-receipt"');

    const noSig = join(a.dir, "no-sig.json");
    const { signature: _signature, ...unsigned } = a.receipt;
    await writeFile(noSig, JSON.stringify(unsigned));
    const sig = await runCli(["--release-receipt", noSig, "--jwks", a.jwksPath]);
    expect(sig.exit).toBe(2);
    expect(sig.stderr).toContain('no "signature" object');
  });
});

interface AuditArtifacts {
  dir: string;
  exportPath: string;
  jwksPath: string;
  kid: string;
  records: AuditRecord[];
  key: Ed25519EvidenceKey;
}

/**
 * Build an audit-log export the way GET /monitoring/audit/export?format=jsonl
 * serves it (JSONL from InMemoryAuditLog.list(), newest first) plus a JWKS
 * file for anchor verification.
 */
async function makeAuditArtifacts(label: string): Promise<AuditArtifacts> {
  const log = new InMemoryAuditLog();
  for (let i = 0; i < 5; i++) {
    log.record({
      actor: `actor-${i}`,
      role: "operator",
      action: i % 2 === 0 ? "flows.publish" : "replay.run",
      target: `target-${i}`,
      details: { index: i, note: `${label}-${i}` },
    });
  }
  const newestFirst = await log.list();
  const body =
    newestFirst.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const dir = await mkdtemp(join(tmpdir(), "atf-verify-audit-"));
  const exportPath = join(dir, "audit.jsonl");
  await writeFile(exportPath, body);
  const key = parseEvidenceSigningKey(SEED_B64);
  if (key === undefined) throw new Error("fixture signing key missing");
  const jwksPath = join(dir, "jwks.json");
  await writeFile(
    jwksPath,
    JSON.stringify({ keys: [{ ...key.jwk, kid: key.kid, alg: "EdDSA", use: "sig" }] }),
  );
  const records = newestFirst.toReversed();
  return { dir, exportPath, jwksPath, kid: key.kid, records, key };
}

describe("atf-verify --audit-export", () => {
  it("verifies an intact export chain (exit 0)", async () => {
    const a = await makeAuditArtifacts("ok");
    const r = await runCli(["--audit-export", a.exportPath]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("RESULT: VALID");
    expect(r.stdout).toContain("records:      5");
    expect(r.stdout).toContain(`ids:          ${a.records[0]?.id} .. ${a.records[a.records.length - 1]?.id}`);
  });

  it("emits a JSON report with --json", async () => {
    const a = await makeAuditArtifacts("json");
    const r = await runCli(["--audit-export", a.exportPath, "--json"]);
    expect(r.exit).toBe(0);
    const report = JSON.parse(r.stdout) as {
      valid: boolean;
      mode: string;
      lines: number;
      first_id: number;
      last_id: number;
      checked: number;
      legacy_form: number;
      broken_at_id: number | null;
    };
    expect(report.valid).toBe(true);
    expect(report.mode).toBe("audit-export");
    expect(report.lines).toBe(5);
    expect(report.first_id).toBe(a.records[0]?.id);
    expect(report.last_id).toBe(a.records[a.records.length - 1]?.id);
    expect(report.checked).toBe(5);
    expect(report.legacy_form).toBe(0);
    expect(report.broken_at_id).toBeNull();
  });

  it("fails on a modified record and names the first divergent id (exit 1)", async () => {
    const a = await makeAuditArtifacts("tampered");
    const lines = (await readFile(a.exportPath, "utf8"))
      .split("\n")
      .filter((l) => l !== "");
    // newest-first: modify the third line (id 3) without rehashing
    const rec = JSON.parse(lines[2] ?? "") as AuditRecord;
    const tamperedPath = join(a.dir, "tampered.jsonl");
    lines[2] = JSON.stringify({ ...rec, actor: "mallory" });
    await writeFile(tamperedPath, lines.join("\n") + "\n");
    const r = await runCli(["--audit-export", tamperedPath]);
    expect(r.exit).toBe(1);
    expect(r.stdout).toContain("RESULT: INVALID");
    expect(r.stderr).toContain(`chain broken at record ${rec.id}`);
    expect(r.stderr).toContain("hash_mismatch");
  });

  it("verifies an Ed25519 anchor against the export (exit 0)", async () => {
    const a = await makeAuditArtifacts("anchor");
    const tip = a.records[a.records.length - 1];
    if (tip === undefined) throw new Error("fixture missing tip");
    const anchor = signAuditAnchor(tip, a.key);
    const anchorPath = join(a.dir, "anchors.jsonl");
    await writeFile(anchorPath, JSON.stringify(anchor) + "\n");
    const r = await runCli([
      "--audit-export",
      a.exportPath,
      "--anchor",
      anchorPath,
      "--jwks",
      a.jwksPath,
    ]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("RESULT: VALID");
    expect(r.stdout).toContain("anchor:       valid");
  });

  it("fails when the chain was rewritten after the anchor (exit 1)", async () => {
    const a = await makeAuditArtifacts("anchor-broken");
    const tip = a.records[a.records.length - 1];
    if (tip === undefined) throw new Error("fixture missing tip");
    const anchor = signAuditAnchor(tip, a.key);
    const anchorPath = join(a.dir, "anchors.jsonl");
    await writeFile(anchorPath, JSON.stringify(anchor) + "\n");
    // Tamper with an earlier record: the chain check fails first.
    const lines = (await readFile(a.exportPath, "utf8"))
      .split("\n")
      .filter((l) => l !== "");
    const rec = JSON.parse(lines[3] ?? "") as AuditRecord;
    lines[3] = JSON.stringify({ ...rec, action: "evil.action" });
    await writeFile(a.exportPath, lines.join("\n") + "\n");
    const r = await runCli([
      "--audit-export",
      a.exportPath,
      "--anchor",
      anchorPath,
      "--jwks",
      a.jwksPath,
    ]);
    expect(r.exit).toBe(1);
    expect(r.stdout).toContain("RESULT: INVALID");
    expect(r.stderr).toContain(`chain broken at record ${rec.id}`);
  });

  it("reports HMAC anchors as unverifiable offline (exit 2)", async () => {
    const a = await makeAuditArtifacts("anchor-hmac");
    const tip = a.records[a.records.length - 1];
    if (tip === undefined) throw new Error("fixture missing tip");
    const anchor = signAuditAnchor(tip, "shared-secret");
    const anchorPath = join(a.dir, "anchors.jsonl");
    await writeFile(anchorPath, JSON.stringify(anchor) + "\n");
    const r = await runCli([
      "--audit-export",
      a.exportPath,
      "--anchor",
      anchorPath,
      "--jwks",
      a.jwksPath,
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("HMAC anchors need the shared secret");
  });

  it("rejects malformed input and bad flag combinations (exit 2)", async () => {
    const a = await makeAuditArtifacts("usage");

    const missing = await runCli(["--audit-export", join(a.dir, "nope.jsonl")]);
    expect(missing.exit).toBe(2);
    expect(missing.stderr).toContain("cannot read audit export file");

    const badLine = join(a.dir, "bad.jsonl");
    await writeFile(badLine, `${JSON.stringify(a.records[0])}\nnot json\n`);
    const bad = await runCli(["--audit-export", badLine]);
    expect(bad.exit).toBe(2);
    expect(bad.stderr).toContain("audit export line 2 is not valid JSON");

    const notRecord = join(a.dir, "not-record.jsonl");
    await writeFile(notRecord, '{"hello":"world"}\n');
    const nr = await runCli(["--audit-export", notRecord]);
    expect(nr.exit).toBe(2);
    expect(nr.stderr).toContain("audit export line 1 is not an audit record");

    const anchorOnly = await runCli([
      "--receipt",
      join(a.dir, "receipt.json"),
      "--anchor",
      join(a.dir, "anchors.jsonl"),
      "--jwks",
      a.jwksPath,
    ]);
    expect(anchorOnly.exit).toBe(2);
    expect(anchorOnly.stderr).toContain("--anchor is only valid with --audit-export");

    const noJwks = await runCli([
      "--audit-export",
      a.exportPath,
      "--anchor",
      join(a.dir, "anchors.jsonl"),
    ]);
    expect(noJwks.exit).toBe(2);
    expect(noJwks.stderr).toContain("--jwks is required");

    const combined = await runCli([
      "--audit-export",
      a.exportPath,
      "--receipt",
      join(a.dir, "receipt.json"),
    ]);
    expect(combined.exit).toBe(2);
    expect(combined.stderr).toContain("cannot be combined");
  });
});

// ---------------------------------------------------------------------------
// --citation-impact
// ---------------------------------------------------------------------------

interface CitationImpactArtifacts {
  dir: string;
  reportPath: string;
  jwksPath: string;
  kid: string;
  report: ReturnType<typeof signCitationImpact>;
}

async function makeCitationImpactArtifacts(
  label: string,
): Promise<CitationImpactArtifacts> {
  const dir = await mkdtemp(join(tmpdir(), `atf-verify-ci-${label}-`));
  const key = parseEvidenceSigningKey(SEED_B64);
  if (key === undefined) throw new Error("fixture signing key missing");
  const report = signCitationImpact(
    {
      generated_at: "2026-10-20T12:00:00.000Z",
      since: "2026-07-01T00:00:00.000Z",
      tenant_id: "acme",
      summary: {
        executions_checked: 12,
        executions_affected: 2,
        chunks: { current: 9, carried: 0, changed: 1, removed: 1, unknown: 0, unverified: 0 },
      },
      affected: [
        {
          execution_id: "exec-1",
          flow_id: "flows/test",
          flow_version: "1.0.0",
          created_at: "2026-10-01T10:00:00.000Z",
          chunks: [
            {
              base_ref: "doc-a",
              chunk_id: "c1",
              status: "changed",
              current_revision: "7",
            },
          ],
        },
      ],
    },
    key,
  );
  const reportPath = join(dir, "citation-impact.json");
  await writeFile(reportPath, JSON.stringify(report));
  const jwksPath = join(dir, "jwks.json");
  await writeFile(
    jwksPath,
    JSON.stringify({
      keys: [{ ...key.jwk, kid: key.kid, alg: "EdDSA", use: "sig" }],
    }),
  );
  return { dir, reportPath, jwksPath, kid: key.kid, report };
}

describe("atf-verify --citation-impact", () => {
  it("verifies a valid signed citation impact report (exit 0)", async () => {
    const a = await makeCitationImpactArtifacts("ok");
    const r = await runCli([
      "--citation-impact",
      a.reportPath,
      "--jwks",
      a.jwksPath,
    ]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("RESULT: VALID");
    expect(r.stdout).toContain("acme");
    expect(r.stdout).toContain("12 checked, 2 affected");
  });

  it("emits a JSON report with --json", async () => {
    const a = await makeCitationImpactArtifacts("json");
    const r = await runCli([
      "--citation-impact",
      a.reportPath,
      "--jwks",
      a.jwksPath,
      "--json",
    ]);
    expect(r.exit).toBe(0);
    const report = JSON.parse(r.stdout) as {
      valid: boolean;
      mode: string;
      generated_at: string;
      since: string;
      tenant_id: string | null;
      executions_checked: number;
      executions_affected: number;
      changed: number;
      removed: number;
      algorithm: string;
      kid: string;
      signature_valid: boolean;
    };
    expect(report.valid).toBe(true);
    expect(report.mode).toBe("citation-impact");
    expect(report.generated_at).toBe("2026-10-20T12:00:00.000Z");
    expect(report.since).toBe("2026-07-01T00:00:00.000Z");
    expect(report.tenant_id).toBe("acme");
    expect(report.executions_checked).toBe(12);
    expect(report.executions_affected).toBe(2);
    expect(report.changed).toBe(1);
    expect(report.removed).toBe(1);
    expect(report.algorithm).toBe("EdDSA");
    expect(report.kid).toBe(a.kid);
    expect(report.signature_valid).toBe(true);
  });

  it("fails on a tampered field with stale signature (exit 1)", async () => {
    const a = await makeCitationImpactArtifacts("tampered");
    const tampered = JSON.parse(JSON.stringify(a.report)) as {
      summary: { executions_affected: number };
    };
    tampered.summary.executions_affected = 99;
    const path = join(a.dir, "tampered.json");
    await writeFile(path, JSON.stringify(tampered));
    const r = await runCli(["--citation-impact", path, "--jwks", a.jwksPath]);
    expect(r.exit).toBe(1);
    expect(r.stdout).toContain("RESULT: INVALID");
    expect(r.stderr).toContain("signature does not verify against this key");
  });

  it("rejects an unsigned report (exit 2)", async () => {
    const a = await makeCitationImpactArtifacts("unsigned");
    const unsigned = JSON.parse(JSON.stringify(a.report)) as {
      signature?: unknown;
    };
    delete unsigned.signature;
    const path = join(a.dir, "unsigned.json");
    await writeFile(path, JSON.stringify(unsigned));
    const r = await runCli(["--citation-impact", path, "--jwks", a.jwksPath]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("report is not signed");
  });

  it("fails with exit 2 for an unknown --kid", async () => {
    const a = await makeCitationImpactArtifacts("wrongkid");
    const r = await runCli([
      "--citation-impact",
      a.reportPath,
      "--jwks",
      a.jwksPath,
      "--kid",
      "unknown-kid",
    ]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain('no JWKS key with kid "unknown-kid"');
  });

  it("rejects mode-flag misuse and bad input (exit 2)", async () => {
    const a = await makeCitationImpactArtifacts("modes");
    const both = await runCli([
      "--citation-impact",
      a.reportPath,
      "--bundle",
      join(a.dir, "bundle.json"),
      "--jwks",
      a.jwksPath,
    ]);
    expect(both.exit).toBe(2);
    expect(both.stderr).toContain("cannot be combined");

    const missing = await runCli([
      "--citation-impact",
      join(a.dir, "nope.json"),
      "--jwks",
      a.jwksPath,
    ]);
    expect(missing.exit).toBe(2);
    expect(missing.stderr).toContain("cannot read citation impact file");

    const notJson = join(a.dir, "not-json.json");
    await writeFile(notJson, "hello");
    const bad = await runCli([
      "--citation-impact",
      notJson,
      "--jwks",
      a.jwksPath,
    ]);
    expect(bad.exit).toBe(2);
    expect(bad.stderr).toContain("citation impact file is not valid JSON");
  });
});
