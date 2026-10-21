#!/usr/bin/env bun
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * atf-verify — offline verification of ATF Decision_Receipts (Req 15.5).
 *
 * Checks, without contacting the issuing Runtime, that
 *
 *   1. the receipt's COSE_Sign1 (Ed25519) signature verifies against a key
 *      from a JWKS (URL or local file, selected by `kid`), and
 *   2. with --proof, that the receipt is included in the RFC 6962 Merkle
 *      tree covered by the signed tree head (SCITT-style audit anchor).
 *
 * Inputs are the files a holder downloads from the Runtime:
 *
 *   GET /v1/receipts/{id}         -> receipt file (JSON with "cose_base64",
 *                                    or raw COSE_Sign1 bytes)
 *   GET /v1/receipts/{id}/proof   -> proof file (JSON with "proof" and
 *                                    "tree_head")
 *   GET /.well-known/atf-receipt-jwks.json -> JWKS (URL or saved file)
 *
 * Modes (exactly one is required):
 *
 *   --receipt <file>  Decision_Receipt verification (checks 1 and 2 above).
 *   --bundle <file>   Signed Evidence Bundle (the JSON envelope with
 *                     "bundle", "contentHash", "signature" and "kid"): the
 *                     content hash and the Ed25519 signature are verified
 *                     offline against the key from the JWKS.
 *   --erasure-receipt <file>
 *                     Signed erasure receipt envelope ({"typ", "alg", "kid",
 *                     "payload", "signature"}): the Ed25519 signature over
 *                     the canonical JSON payload is verified offline against
 *                     the key from the JWKS and the payload is schema-checked.
 *   --audit-export <file>
 *                     Audit-log export (JSONL from
 *                     GET /monitoring/audit/export?format=jsonl): the hash
 *                     chain is re-verified offline. With --anchor, anchors
 *                     written by the AUDIT_ANCHOR_FILE writer are verified
 *                     against the Ed25519 key from the JWKS.
 *
 * Usage:
 *   atf-verify --receipt <file> --jwks <url|file> [--proof <file>]
 *              [--kid <kid>] [--json] [--help]
 *   atf-verify --bundle <file> --jwks <url|file> [--kid <kid>] [--json]
 *              [--help]
 *   atf-verify --erasure-receipt <file> --jwks <url|file> [--kid <kid>]
 *              [--json] [--help]
 *   atf-verify --audit-export <file> [--anchor <file>] [--jwks <url|file>]
 *              [--kid <kid>] [--json] [--help]
 *
 * Exit codes: 0 = everything verified, 1 = verification failed,
 * 2 = usage or input error.
 *
 * A compiled standalone binary can be built with:
 *   bun run atf-verify:build
 */

import { readFile } from "node:fs/promises";
import {
  COSE_ALG_EDDSA,
  cborDecodeSign1,
  coseSign1Verify,
  decodeProtectedHeader,
  jwkToEd25519RawKey,
} from "../packages/security-kit/src/cose/index.ts";
import {
  cborDecode,
  type CborValue,
} from "../packages/security-kit/src/cbor/index.ts";
import { base64UrlDecode } from "../packages/security-kit/src/base64url.ts";
import {
  type InclusionProofResult,
  verifyReceiptInclusion,
} from "../apps/runtime/src/receipts/transparency-log.ts";
import {
  type SignedEvidenceBundle,
  verifyEvidenceBundle,
} from "../apps/runtime/src/observability/evidence-bundle.ts";
import { createPublicKey, verify as ed25519Verify } from "node:crypto";
import type { ErasureReceiptEnvelope } from "../apps/runtime/src/compliance/erasure-receipt.ts";
import {
  ERASURE_RECEIPT_TYPE,
  ErasureReceiptPayloadSchema,
  canonicalizeJson,
} from "../packages/erasure-contract/src/receipt.ts";
import {
  type AuditChainAnchor,
  type AuditRecord,
  verifyAuditAnchor,
  verifyAuditChain,
} from "../apps/runtime/src/observability/audit-log.ts";

const EXIT_VALID = 0;
const EXIT_INVALID = 1;
const EXIT_USAGE = 2;

const USAGE = `atf-verify — offline verification of ATF artifacts

Usage:
  atf-verify --receipt <file> --jwks <url|file> [options]
  atf-verify --bundle <file> --jwks <url|file> [options]
  atf-verify --erasure-receipt <file> --jwks <url|file> [options]
  atf-verify --audit-export <file> [--anchor <file>] [--jwks <url|file>]
             [options]

Modes (exactly one is required):
  --receipt <file>  Decision_Receipt: JSON response from GET /v1/receipts/{id}
                    ({"cose_base64": ...}) or raw COSE_Sign1 bytes.
  --bundle <file>   Signed Evidence Bundle JSON (the envelope with "bundle",
                    "contentHash", "signature" and "kid") as downloaded from
                    the Runtime.
  --erasure-receipt <file>
                    Signed erasure receipt JSON (the envelope with "typ",
                    "alg", "kid", "payload" and "signature"): the Ed25519
                    signature over the canonical JSON payload is verified
                    offline and the payload is schema-checked.
  --audit-export <file>
                    Audit-log export in JSON Lines format (the body of
                    GET /monitoring/audit/export?format=jsonl, one compact
                    JSON AuditRecord per line). The hash chain is recomputed
                    offline; the report lists the line count, the first and
                    last record id and the number of rows that only verify
                    under the legacy hash form.

Options:
  --jwks <url|file> JWKS used to verify the signature (http(s) URL or local
                    file). Required except for --audit-export without
                    --anchor.
  --anchor <file>   Audit chain anchor file written by the
                    AUDIT_ANCHOR_FILE writer (JSON Lines of anchors). The
                    newest anchor is verified against the record with the
                    same id in the export and the Ed25519 key from the JWKS.
                    --audit-export mode only.
  --proof <file>    Inclusion proof from GET /v1/receipts/{id}/proof (JSON).
                    Receipt mode only. When given, the Merkle inclusion and
                    the signed tree head are verified too.
  --kid <kid>       Override the key id selected from the JWKS (default: the
                    kid in the artifact).
  --json            Emit a machine-readable JSON report instead of text.
  --help            Show this help.

Exit codes:
  0  signature (and inclusion, if requested) verified
  1  verification failed (bad signature, bad proof, altered content)
  2  usage or input error (missing file, unreadable JWKS, no matching key)
`;

/** Input/usage problems: the artifact could not even be examined. */
class UsageError extends Error {}

/** Exactly one verification mode is selected on the command line. */
type Mode = "receipt" | "bundle" | "erasure-receipt" | "audit-export";

interface CliOptions {
  mode: Mode;
  receipt?: string;
  bundle?: string;
  erasureReceipt?: string;
  auditExport?: string;
  anchor?: string;
  jwks: string;
  proof?: string;
  kid?: string;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: Partial<CliOptions> = {};
  const needValue = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    switch (arg) {
      case "--receipt":
        opts.receipt = needValue(arg, argv[++i]);
        break;
      case "--bundle":
        opts.bundle = needValue(arg, argv[++i]);
        break;
      case "--erasure-receipt":
        opts.erasureReceipt = needValue(arg, argv[++i]);
        break;
      case "--audit-export":
        opts.auditExport = needValue(arg, argv[++i]);
        break;
      case "--anchor":
        opts.anchor = needValue(arg, argv[++i]);
        break;
      case "--jwks":
        opts.jwks = needValue(arg, argv[++i]);
        break;
      case "--proof":
        opts.proof = needValue(arg, argv[++i]);
        break;
      case "--kid":
        opts.kid = needValue(arg, argv[++i]);
        break;
      case "--json":
        opts.json = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (opts.help === true) {
    return { mode: "receipt", jwks: "", json: false, help: true };
  }
  // Exactly one mode flag is required.
  const modeFlags = [
    opts.receipt !== undefined ? "--receipt" : undefined,
    opts.bundle !== undefined ? "--bundle" : undefined,
    opts.erasureReceipt !== undefined ? "--erasure-receipt" : undefined,
    opts.auditExport !== undefined ? "--audit-export" : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  if (modeFlags.length > 1) {
    throw new UsageError(
      `${modeFlags.join(" and ")} cannot be combined; choose one mode`,
    );
  }
  if (modeFlags.length === 0) {
    throw new UsageError(
      "--receipt, --bundle, --erasure-receipt or --audit-export is required",
    );
  }
  if (opts.proof !== undefined && opts.receipt === undefined) {
    throw new UsageError("--proof is only valid with --receipt");
  }
  if (opts.anchor !== undefined && opts.auditExport === undefined) {
    throw new UsageError("--anchor is only valid with --audit-export");
  }
  // A chain-only audit export verification needs no key; every other mode
  // (and audit exports with anchors) verifies a signature and needs a JWKS.
  const jwksOptional =
    opts.auditExport !== undefined && opts.anchor === undefined;
  if (opts.jwks === undefined && !jwksOptional) {
    throw new UsageError("--jwks is required");
  }
  return {
    mode:
      opts.bundle !== undefined
        ? "bundle"
        : opts.erasureReceipt !== undefined
          ? "erasure-receipt"
          : opts.auditExport !== undefined
            ? "audit-export"
            : "receipt",
    jwks: opts.jwks ?? "",
    json: opts.json === true,
    help: false,
    ...(opts.receipt !== undefined ? { receipt: opts.receipt } : {}),
    ...(opts.bundle !== undefined ? { bundle: opts.bundle } : {}),
    ...(opts.erasureReceipt !== undefined
      ? { erasureReceipt: opts.erasureReceipt }
      : {}),
    ...(opts.auditExport !== undefined
      ? { auditExport: opts.auditExport }
      : {}),
    ...(opts.anchor !== undefined ? { anchor: opts.anchor } : {}),
    ...(opts.proof !== undefined ? { proof: opts.proof } : {}),
    ...(opts.kid !== undefined ? { kid: opts.kid } : {}),
  };
}

/**
 * Load the receipt as COSE_Sign1 bytes. Accepts the JSON response shape of
 * GET /v1/receipts/{id} ({"cose_base64": ...}, also nested under
 * {"receipt": {...}}) or a file containing the raw COSE bytes.
 */
async function loadReceiptBytes(path: string): Promise<Uint8Array> {
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(await readFile(path));
  } catch {
    throw new UsageError(`cannot read receipt file: ${path}`);
  }
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(raw)
    .trim();
  if (text.startsWith("{")) {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new UsageError(`receipt file is not valid JSON: ${path}`);
    }
    const top = (doc ?? {}) as Record<string, unknown>;
    const nested = (top.receipt ?? {}) as Record<string, unknown>;
    const b64 = top.cose_base64 ?? nested.cose_base64;
    if (typeof b64 !== "string") {
      throw new UsageError(`receipt file has no "cose_base64" field: ${path}`);
    }
    return base64UrlDecode(b64);
  }
  return raw;
}

/**
 * Load the signed Evidence Bundle envelope written by the Runtime
 * (`GET /v1/executions/{id}/evidence-bundle`). Structural problems are input
 * errors (exit 2); a well-formed envelope may still fail verification (exit 1).
 */
async function loadBundleFile(path: string): Promise<SignedEvidenceBundle> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new UsageError(`cannot read bundle file: ${path}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new UsageError(`bundle file is not valid JSON: ${path}`);
  }
  const top = (doc ?? {}) as Record<string, unknown>;
  if (
    top.bundle === null ||
    typeof top.bundle !== "object" ||
    Array.isArray(top.bundle)
  ) {
    throw new UsageError(`bundle file has no "bundle" object: ${path}`);
  }
  if (typeof top.contentHash !== "string" || top.contentHash === "") {
    throw new UsageError(`bundle file has no "contentHash" string: ${path}`);
  }
  if (typeof top.signature !== "string" || top.signature === "") {
    throw new UsageError(`bundle file has no "signature" string: ${path}`);
  }
  if (top.algorithm !== "ed25519" && top.algorithm !== "hmac-sha256") {
    throw new UsageError(`bundle file has an unsupported "algorithm": ${path}`);
  }
  if (top.kid !== undefined && typeof top.kid !== "string") {
    throw new UsageError(`bundle file has a non-string "kid": ${path}`);
  }
  if (top.algorithm === "hmac-sha256") {
    throw new UsageError(
      'bundles signed with "hmac-sha256" need the shared secret; verify them with the Runtime',
    );
  }
  return doc as unknown as SignedEvidenceBundle;
}

/**
 * Load the signed erasure receipt envelope served by the Runtime
 * (`GET /v1/me/data/erasures/{id}`). Structural problems are input errors
 * (exit 2); a well-formed envelope may still fail verification (exit 1).
 */
async function loadErasureReceiptFile(path: string): Promise<ErasureReceiptEnvelope> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new UsageError(`cannot read erasure receipt file: ${path}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new UsageError(`erasure receipt file is not valid JSON: ${path}`);
  }
  const top = (doc ?? {}) as Record<string, unknown>;
  if (top.typ !== ERASURE_RECEIPT_TYPE) {
    throw new UsageError(
      `erasure receipt file has no "typ" of "${ERASURE_RECEIPT_TYPE}": ${path}`,
    );
  }
  if (top.alg === "HS256") {
    throw new UsageError(
      "HMAC receipts need the shared secret; use the Runtime API",
    );
  }
  if (top.alg !== "Ed25519") {
    throw new UsageError(`erasure receipt file has an unsupported "alg": ${path}`);
  }
  if (top.payload === null || typeof top.payload !== "object" || Array.isArray(top.payload)) {
    throw new UsageError(`erasure receipt file has no "payload" object: ${path}`);
  }
  if (typeof top.signature !== "string" || top.signature === "") {
    throw new UsageError(`erasure receipt file has no "signature" string: ${path}`);
  }
  if (top.kid !== undefined && typeof top.kid !== "string") {
    throw new UsageError(`erasure receipt file has a non-string "kid": ${path}`);
  }
  return doc as unknown as ErasureReceiptEnvelope;
}

/**
 * Load an audit-log export in JSON Lines format — the body of
 * GET /monitoring/audit/export?format=jsonl (one compact JSON AuditRecord
 * per line, newest first, trailing newline). Structural problems are input
 * errors (exit 2). Returns the records sorted ASCENDING by id, which is the
 * order verifyAuditChain expects.
 */
async function loadAuditExportFile(path: string): Promise<AuditRecord[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new UsageError(`cannot read audit export file: ${path}`);
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    throw new UsageError(`audit export file is empty: ${path}`);
  }
  const records: AuditRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    let doc: unknown;
    try {
      doc = JSON.parse(lines[i]);
    } catch {
      throw new UsageError(
        `audit export line ${i + 1} is not valid JSON: ${path}`,
      );
    }
    const rec = (doc ?? {}) as Record<string, unknown>;
    if (
      typeof rec.id !== "number" ||
      typeof rec.at !== "string" ||
      typeof rec.hash !== "string" ||
      typeof rec.prevHash !== "string" ||
      typeof rec.actor !== "string" ||
      typeof rec.action !== "string"
    ) {
      throw new UsageError(
        `audit export line ${i + 1} is not an audit record: ${path}`,
      );
    }
    records.push(doc as AuditRecord);
  }
  records.sort((a, b) => a.id - b.id);
  return records;
}

/**
 * Load an anchor file written by the AUDIT_ANCHOR_FILE writer (JSON Lines,
 * one AuditChainAnchor per line, oldest first). Returns all anchors in file
 * order; the newest (last) one is the relevant checkpoint.
 */
async function loadAnchorFile(path: string): Promise<AuditChainAnchor[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new UsageError(`cannot read anchor file: ${path}`);
  }
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    throw new UsageError(`anchor file is empty: ${path}`);
  }
  const anchors: AuditChainAnchor[] = [];
  for (let i = 0; i < lines.length; i++) {
    let doc: unknown;
    try {
      doc = JSON.parse(lines[i]);
    } catch {
      throw new UsageError(
        `anchor file line ${i + 1} is not valid JSON: ${path}`,
      );
    }
    const rec = (doc ?? {}) as Record<string, unknown>;
    if (
      typeof rec.uptoId !== "number" ||
      typeof rec.tipHash !== "string" ||
      typeof rec.signature !== "string"
    ) {
      throw new UsageError(
        `anchor file line ${i + 1} is not an audit chain anchor: ${path}`,
      );
    }
    anchors.push(doc as AuditChainAnchor);
  }
  return anchors;
}

/** The DOM JsonWebKey type has no `kid`; JWKS entries always carry one. */
type JwkEntry = JsonWebKey & { kid?: string };

interface Jwks {
  keys: JwkEntry[];
}

/** Load a JWKS from an http(s) URL or a local file. */
async function loadJwks(spec: string): Promise<Jwks> {
  let text: string;
  if (/^https?:\/\//i.test(spec)) {
    let res: Response;
    try {
      res = await fetch(spec);
    } catch {
      throw new UsageError(`cannot fetch JWKS: ${spec}`);
    }
    if (!res.ok) {
      throw new UsageError(`JWKS fetch failed with HTTP ${res.status}: ${spec}`);
    }
    text = await res.text();
  } else {
    try {
      text = await readFile(spec, "utf8");
    } catch {
      throw new UsageError(`cannot read JWKS file: ${spec}`);
    }
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new UsageError(`JWKS is not valid JSON: ${spec}`);
  }
  const keys = (doc as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) {
    throw new UsageError(`JWKS has no "keys" array: ${spec}`);
  }
  return { keys: keys as JwkEntry[] };
}

function selectKey(keys: readonly JwkEntry[], kid: string | undefined): JwkEntry {
  if (kid !== undefined) {
    const found = keys.find((k) => k.kid === kid);
    if (found === undefined) {
      throw new UsageError(`no JWKS key with kid "${kid}"`);
    }
    return found;
  }
  const only = keys.length === 1 ? keys[0] : undefined;
  if (only !== undefined) return only;
  throw new UsageError(
    "receipt has no kid; pass --kid or provide a single-key JWKS",
  );
}

/** The receipt payload is a string-keyed CBOR map; decode it for display. */
function decodePayloadFields(
  payload: Uint8Array,
): Record<string, CborValue> | undefined {
  let v: CborValue;
  try {
    v = cborDecode(payload);
  } catch {
    return undefined;
  }
  if (
    v === null ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    v instanceof Uint8Array ||
    "entries" in v ||
    "tag" in v
  ) {
    return undefined;
  }
  return v as Record<string, CborValue>;
}

function field(rec: Record<string, CborValue>, key: string): string {
  const v = rec[key];
  if (v === null || v === undefined) return "-";
  if (
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "bigint" ||
    typeof v === "boolean"
  ) {
    return String(v);
  }
  return "-";
}

interface ProofFile {
  receipt_id?: string;
  proof: { leaf_index: number; tree_size: number; node_hashes: string[] };
  tree_head: { tree_size: number; cose_base64: string };
}

async function loadProofFile(path: string): Promise<ProofFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new UsageError(`cannot read proof file: ${path}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new UsageError(`proof file is not valid JSON: ${path}`);
  }
  const d = (doc ?? {}) as Record<string, unknown>;
  const p = (d.proof ?? {}) as Record<string, unknown>;
  const h = (d.tree_head ?? {}) as Record<string, unknown>;
  if (
    typeof p.leaf_index !== "number" ||
    typeof p.tree_size !== "number" ||
    !Array.isArray(p.node_hashes) ||
    !p.node_hashes.every((n) => typeof n === "string") ||
    typeof h.tree_size !== "number" ||
    typeof h.cose_base64 !== "string"
  ) {
    throw new UsageError(`proof file has unexpected shape: ${path}`);
  }
  return {
    ...(typeof d.receipt_id === "string" ? { receipt_id: d.receipt_id } : {}),
    proof: {
      leaf_index: p.leaf_index,
      tree_size: p.tree_size,
      node_hashes: p.node_hashes as string[],
    },
    tree_head: { tree_size: h.tree_size, cose_base64: h.cose_base64 },
  };
}

interface InclusionReport {
  valid: boolean;
  head_signature_valid: boolean;
  leaf_index: number;
  tree_size: number;
  leaf_hash: string | null;
  root_hash: string | null;
  head_timestamp: string | null;
}

interface Report {
  valid: boolean;
  receipt_id: string | null;
  kid: string | null;
  signature_valid: boolean;
  inclusion: InclusionReport | null;
  summary: Record<string, string>;
  errors: string[];
}

async function run(opts: CliOptions): Promise<Report> {
  const errors: string[] = [];
  const coseBytes = await loadReceiptBytes(opts.receipt ?? "");

  let message: ReturnType<typeof cborDecodeSign1>;
  try {
    message = cborDecodeSign1(coseBytes);
  } catch {
    return {
      valid: false,
      receipt_id: null,
      kid: null,
      signature_valid: false,
      inclusion: null,
      summary: {},
      errors: ["receipt is not a valid COSE_Sign1 message"],
    };
  }

  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(message.protectedBytes);
  } catch {
    return {
      valid: false,
      receipt_id: null,
      kid: null,
      signature_valid: false,
      inclusion: null,
      summary: {},
      errors: ["receipt protected header is invalid"],
    };
  }
  if (header.alg !== COSE_ALG_EDDSA) {
    return {
      valid: false,
      receipt_id: null,
      kid: header.kid ?? null,
      signature_valid: false,
      inclusion: null,
      summary: {},
      errors: [`unsupported COSE alg ${header.alg} (only EdDSA/-8 is supported)`],
    };
  }

  const jwks = await loadJwks(opts.jwks);
  const kid = opts.kid ?? header.kid;
  const jwk = selectKey(jwks.keys, kid);
  let rawKey: Uint8Array;
  try {
    rawKey = jwkToEd25519RawKey(jwk);
  } catch {
    throw new UsageError(`JWKS key "${jwk.kid ?? "?"}" is not an OKP/Ed25519 key`);
  }

  const signatureValid = await coseSign1Verify(message, rawKey);
  if (!signatureValid) errors.push("signature does not verify against this key");

  const fields = decodePayloadFields(message.payload);
  const summary: Record<string, string> = {};
  let receiptId: string | null = null;
  if (fields !== undefined) {
    for (const key of [
      "receipt_id",
      "kind",
      "flow_id",
      "flow_version",
      "tenant_id",
      "execution_id",
      "status",
      "started_at",
      "finished_at",
    ]) {
      summary[key] = field(fields, key);
    }
    receiptId = summary.receipt_id !== "-" ? (summary.receipt_id ?? null) : null;
  } else {
    errors.push("receipt payload is not a CBOR map");
  }

  let inclusion: InclusionReport | null = null;
  if (opts.proof !== undefined) {
    const pf = await loadProofFile(opts.proof);
    if (pf.receipt_id !== undefined && receiptId !== null && pf.receipt_id !== receiptId) {
      errors.push(
        `proof is for receipt "${pf.receipt_id}", not "${receiptId}"`,
      );
    }
    if (pf.proof.tree_size !== pf.tree_head.tree_size) {
      errors.push(
        `proof tree_size ${pf.proof.tree_size} does not match tree head tree_size ${pf.tree_head.tree_size}`,
      );
    }
    const proof: InclusionProofResult = {
      leafIndex: pf.proof.leaf_index,
      treeSize: pf.proof.tree_size,
      nodeHashes: pf.proof.node_hashes,
    };
    const check = await verifyReceiptInclusion(
      coseBytes,
      base64UrlDecode(pf.tree_head.cose_base64),
      proof,
      rawKey,
    );
    inclusion = {
      valid: check?.inclusionValid === true,
      head_signature_valid: check?.headSignatureValid === true,
      leaf_index: pf.proof.leaf_index,
      tree_size: pf.proof.tree_size,
      leaf_hash: check?.leafHash ?? null,
      root_hash: check !== undefined ? bytesToHex(check.head.rootHash) : null,
      head_timestamp: check?.head.timestamp ?? null,
    };
    if (check === undefined) {
      errors.push("tree head signature does not verify against this key");
    } else if (!check.inclusionValid) {
      errors.push("inclusion proof does not recompute the signed tree root");
    }
  }

  return {
    valid: errors.length === 0,
    receipt_id: receiptId,
    kid: kid ?? null,
    signature_valid: signatureValid,
    inclusion,
    summary,
    errors,
  };
}

interface BundleReport {
  valid: boolean;
  mode: "bundle";
  execution_id: string | null;
  generated_at: string | null;
  algorithm: string | null;
  kid: string | null;
  content_hash_valid: boolean;
  signature_valid: boolean;
  verifier: string | null;
  errors: string[];
}

async function runBundle(opts: CliOptions): Promise<BundleReport> {
  const signed = await loadBundleFile(opts.bundle ?? "");
  const jwks = await loadJwks(opts.jwks);
  const kid = opts.kid ?? signed.kid;
  const jwk = selectKey(jwks.keys, kid);
  let rawKey: Uint8Array;
  try {
    rawKey = jwkToEd25519RawKey(jwk);
  } catch {
    throw new UsageError(`JWKS key "${jwk.kid ?? "?"}" is not an OKP/Ed25519 key`);
  }

  const check = verifyEvidenceBundle(signed, rawKey);
  const errors: string[] = [];
  // Distinguish the failure reasons for a human-readable report: the content
  // hash check is independent of the signature, so report both when the
  // bundle is broken.
  let contentHashValid = true;
  let signatureValid = true;
  if (!check.valid) {
    if (check.reason === "content_hash_mismatch") {
      contentHashValid = false;
      signatureValid = false;
      errors.push("content does not match its recorded content hash");
    } else {
      signatureValid = false;
      errors.push("signature does not verify against this key");
    }
  }

  const bundle = signed.bundle as unknown as Record<string, unknown>;
  return {
    valid: check.valid,
    mode: "bundle",
    execution_id:
      typeof bundle.executionId === "string" ? bundle.executionId : null,
    generated_at:
      typeof bundle.generatedAt === "string" ? bundle.generatedAt : null,
    algorithm: signed.algorithm,
    kid: kid ?? signed.kid ?? null,
    content_hash_valid: contentHashValid,
    signature_valid: signatureValid,
    verifier: opts.jwks,
    errors,
  };
}

interface ErasureReceiptReport {
  valid: boolean;
  mode: "erasure-receipt";
  receipt_id: string | null;
  request_id: string | null;
  tenant_id: string | null;
  scope: string | null;
  status: string | null;
  completed_at: string | null;
  algorithm: string | null;
  kid: string | null;
  signature_valid: boolean;
  verifier: string | null;
  errors: string[];
}

async function runErasureReceipt(opts: CliOptions): Promise<ErasureReceiptReport> {
  const envelope = await loadErasureReceiptFile(opts.erasureReceipt ?? "");
  const jwks = await loadJwks(opts.jwks);
  const kid = opts.kid ?? envelope.kid;
  const jwk = selectKey(jwks.keys, kid);
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    throw new UsageError(`JWKS key "${jwk.kid ?? "?"}" is not a usable Ed25519 public key`);
  }

  const errors: string[] = [];
  // The signature covers the canonical JSON bytes of the payload, exactly as
  // produced by signReceipt() in the Runtime.
  const signingBytes = Buffer.from(canonicalizeJson(envelope.payload), "utf8");
  let signatureValid = true;
  try {
    signatureValid = ed25519Verify(
      null,
      signingBytes,
      publicKey,
      Buffer.from(envelope.signature, "base64url"),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    errors.push("signature does not verify against this key");
  }

  // The payload must additionally satisfy the contract schema, so a receipt
  // that verifies but attests something malformed is still rejected.
  const parsed = ErasureReceiptPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const at = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
      errors.push(`payload is not a valid erasure receipt${at}: ${issue.message}`);
    }
  }

  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  return {
    valid: signatureValid && parsed.success,
    mode: "erasure-receipt",
    receipt_id:
      typeof payload.receiptId === "string" ? payload.receiptId : null,
    request_id:
      typeof payload.requestId === "string" ? payload.requestId : null,
    tenant_id: typeof payload.tenantId === "string" ? payload.tenantId : null,
    scope: typeof payload.scope === "string" ? payload.scope : null,
    status: typeof payload.status === "string" ? payload.status : null,
    completed_at:
      typeof payload.completedAt === "string" ? payload.completedAt : null,
    algorithm: envelope.alg,
    kid: kid ?? envelope.kid ?? null,
    signature_valid: signatureValid,
    verifier: opts.jwks,
    errors,
  };
}

function printErasureReceiptText(
  report: ErasureReceiptReport,
  opts: CliOptions,
): void {
  const line = (label: string, value: string): string =>
    `  ${label.padEnd(14)}${value}`;
  console.log("ATF erasure receipt verification (offline)");
  console.log("");
  console.log(line("receipt:", opts.erasureReceipt ?? "-"));
  console.log(line("receipt id:", report.receipt_id ?? "-"));
  console.log(line("request:", report.request_id ?? "-"));
  console.log(line("tenant:", report.tenant_id ?? "-"));
  console.log(line("scope:", report.scope ?? "-"));
  console.log(line("status:", report.status ?? "-"));
  console.log(line("completed:", report.completed_at ?? "-"));
  console.log(line("algorithm:", report.algorithm ?? "-"));
  console.log("");
  console.log(line("jwks:", report.verifier ?? "-"));
  console.log(line("kid:", report.kid ?? "-"));
  console.log(line("signature:", report.signature_valid ? "VALID" : "INVALID"));
  if (report.errors.length > 0) {
    console.log("");
    for (const e of report.errors) console.error(`  ! ${e}`);
  }
  console.log("");
  console.log(`RESULT: ${report.valid ? "VALID" : "INVALID"}`);
}

interface AuditExportReport {
  valid: boolean;
  mode: "audit-export";
  /** Number of records in the export. */
  lines: number;
  first_id: number | null;
  last_id: number | null;
  /** Number of records the chain walk verified. */
  checked: number;
  /** Records that only verify under the legacy (pre-canonicalization) hash form. */
  legacy_form: number;
  broken_at_id: number | null;
  broken_at_reason: string | null;
  /** Present only with --anchor. */
  anchor_status?: "valid" | "invalid";
  anchor_upto_id?: number;
  anchor_kid?: string | null;
  verifier: string | null;
  errors: string[];
}

async function runAuditExport(opts: CliOptions): Promise<AuditExportReport> {
  const records = await loadAuditExportFile(opts.auditExport ?? "");
  const verification = verifyAuditChain(records);

  const errors: string[] = [];
  if (!verification.valid && verification.brokenAt !== undefined) {
    errors.push(
      `chain broken at record ${verification.brokenAt.id} (${verification.brokenAt.reason})${
        verification.message !== undefined ? `: ${verification.message}` : ""
      }`,
    );
  }

  const report: AuditExportReport = {
    valid: verification.valid,
    mode: "audit-export",
    lines: records.length,
    first_id: records.length > 0 ? (records[0]?.id ?? null) : null,
    last_id: records.length > 0 ? (records[records.length - 1]?.id ?? null) : null,
    checked: verification.checked,
    legacy_form: verification.legacyForm ?? 0,
    broken_at_id: verification.brokenAt?.id ?? null,
    broken_at_reason: verification.brokenAt?.reason ?? null,
    verifier: opts.anchor !== undefined ? opts.jwks : null,
    errors,
  };

  if (opts.anchor === undefined) {
    return report;
  }
  const anchors = await loadAnchorFile(opts.anchor);
  const anchor = anchors[anchors.length - 1] as AuditChainAnchor;
  report.anchor_upto_id = anchor.uptoId;
  report.anchor_kid = anchor.kid ?? null;
  if ((anchor.alg ?? "hmac-sha256") !== "ed25519") {
    throw new UsageError(
      "HMAC anchors need the shared secret; use the Runtime API",
    );
  }
  const jwks = await loadJwks(opts.jwks);
  const jwk = selectKey(jwks.keys, opts.kid ?? anchor.kid);
  let publicKey: Uint8Array;
  try {
    publicKey = jwkToEd25519RawKey(jwk);
  } catch {
    throw new UsageError(
      `JWKS key "${jwk.kid ?? "?"}" is not a usable Ed25519 public key`,
    );
  }
  const tip = records.find((rec) => rec.id === anchor.uptoId);
  const result = verifyAuditAnchor(anchor, tip, publicKey);
  report.anchor_status = result.valid ? "valid" : "invalid";
  if (!result.valid) {
    errors.push(`anchor for record ${anchor.uptoId} is invalid (${result.reason ?? "unknown"})`);
    report.valid = false;
  }
  return report;
}

function printAuditExportText(
  report: AuditExportReport,
  opts: CliOptions,
): void {
  const line = (label: string, value: string): string =>
    `  ${label.padEnd(14)}${value}`;
  console.log("ATF audit export verification (offline)");
  console.log("");
  console.log(line("export:", opts.auditExport ?? "-"));
  console.log(line("records:", String(report.lines)));
  console.log(
    line(
      "ids:",
      report.first_id !== null && report.last_id !== null
        ? `${report.first_id} .. ${report.last_id}`
        : "-",
    ),
  );
  console.log(line("verified:", String(report.checked)));
  console.log(line("legacy form:", String(report.legacy_form)));
  console.log(line("chain:", report.broken_at_id === null ? "VALID" : `BROKEN at ${report.broken_at_id}`));
  if (opts.anchor !== undefined) {
    console.log(line("anchor file:", opts.anchor));
    console.log(line("anchor:", report.anchor_status ?? "-"));
    console.log(line("upto id:", String(report.anchor_upto_id ?? "-")));
    console.log(line("kid:", report.anchor_kid ?? "-"));
  }
  if (report.errors.length > 0) {
    console.log("");
    for (const e of report.errors) console.error(`  ! ${e}`);
  }
  console.log("");
  console.log(`RESULT: ${report.valid ? "VALID" : "INVALID"}`);
}

function printBundleText(report: BundleReport, opts: CliOptions): void {
  const line = (label: string, value: string): string =>
    `  ${label.padEnd(14)}${value}`;
  console.log("ATF Evidence Bundle verification (offline)");
  console.log("");
  console.log(line("bundle:", opts.bundle ?? "-"));
  console.log(line("execution:", report.execution_id ?? "-"));
  console.log(line("generated:", report.generated_at ?? "-"));
  console.log(line("algorithm:", report.algorithm ?? "-"));
  console.log("");
  console.log(line("jwks:", report.verifier ?? "-"));
  console.log(line("kid:", report.kid ?? "-"));
  console.log(
    line("content hash:", report.content_hash_valid ? "VALID" : "INVALID"),
  );
  console.log(line("signature:", report.signature_valid ? "VALID" : "INVALID"));
  if (report.errors.length > 0) {
    console.log("");
    for (const e of report.errors) console.error(`  ! ${e}`);
  }
  console.log("");
  console.log(`RESULT: ${report.valid ? "VALID" : "INVALID"}`);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function printText(report: Report, opts: CliOptions): void {
  const line = (label: string, value: string): string =>
    `  ${label.padEnd(14)}${value}`;
  console.log("ATF Decision_Receipt verification (offline)");
  console.log("");
  console.log(line("receipt:", opts.receipt ?? "-"));
  for (const [k, v] of Object.entries(report.summary)) {
    console.log(line(k, v));
  }
  console.log("");
  console.log(line("jwks:", opts.jwks));
  console.log(line("kid:", report.kid ?? "-"));
  console.log(line("signature:", report.signature_valid ? "VALID" : "INVALID"));
  if (report.inclusion !== null) {
    const inc = report.inclusion;
    console.log(
      line(
        "inclusion:",
        inc.valid
          ? `VALID (leaf ${inc.leaf_index} in tree ${inc.tree_size})`
          : "INVALID",
      ),
    );
    console.log(line("head sig:", inc.head_signature_valid ? "VALID" : "INVALID"));
    if (inc.root_hash !== null) console.log(line("root:", inc.root_hash));
    if (inc.head_timestamp !== null) {
      console.log(line("head time:", inc.head_timestamp));
    }
  }
  if (report.errors.length > 0) {
    console.log("");
    for (const e of report.errors) console.error(`  ! ${e}`);
  }
  console.log("");
  console.log(`RESULT: ${report.valid ? "VALID" : "INVALID"}`);
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return EXIT_VALID;
  }
  if (opts.mode === "bundle") {
    const report = await runBundle(opts);
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printBundleText(report, opts);
    }
    return report.valid ? EXIT_VALID : EXIT_INVALID;
  }
  if (opts.mode === "erasure-receipt") {
    const report = await runErasureReceipt(opts);
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printErasureReceiptText(report, opts);
    }
    return report.valid ? EXIT_VALID : EXIT_INVALID;
  }
  if (opts.mode === "audit-export") {
    const report = await runAuditExport(opts);
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printAuditExportText(report, opts);
    }
    return report.valid ? EXIT_VALID : EXIT_INVALID;
  }
  const report = await run(opts);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printText(report, opts);
  }
  return report.valid ? EXIT_VALID : EXIT_INVALID;
}

try {
  process.exit(await main());
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`atf-verify: ${err.message}`);
    process.exit(EXIT_USAGE);
  }
  throw err;
}
