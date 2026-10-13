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
    expect(r1.stderr).toContain("--receipt is required");
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
