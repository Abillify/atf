<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# 30. Asymmetric evidence chain: one Ed25519 key for independent verification

Date: 2026-10-20

## Status

Accepted — partially supersedes the HMAC-deliberate parts of
[ADR-0020](0020-verifiable-evidence-bundle.md) and
[ADR-0026](0026-audit-hash-chain-and-signed-anchors.md)

## Context

The evidence chain — signed audit anchors (ADR-0026), signed evidence bundles
(ADR-0020), and the HS256 fallback for erasure receipts — was built entirely
on HMAC-SHA256. At the time that was a deliberate simplification: ADR-0020
explicitly rejected asymmetric signing because it "would need a
key-management/distribution story disproportionate to what this feature
needs".

That assumption no longer holds. The consumers of these artefacts are
increasingly *third parties* — customers, auditors, regulators — who receive
a bundle or an anchor and want to prove its authenticity **without** the
platform's involvement. HMAC makes that impossible by construction:
verification requires the operator's shared secret, so either the verifier
must trust the operator to hand over (and not misuse) the secret, or the
artefact's signature is worthless to them. A regulator cannot check an
evidence bundle offline; a customer cannot confirm in a dispute that the
bundle they received is authentic without relying on the very party they are
disputing with. The shared secret also means the signing capability is
granted to everyone who can verify — the opposite of least privilege.

Meanwhile the platform already operates the exact key-management story ADR-0020
feared: execution receipts (ADR-0029) sign COSE_Sign1 with Ed25519 and publish
public keys at a JWKS endpoint. Reusing that shape costs almost nothing.

## Decision

Unify the evidence chain on **one asymmetric Ed25519 identity**, keeping HMAC
as verify-only legacy so every pre-existing artefact stays verifiable.

1. **One key, one config knob.** `EVIDENCE_SIGNING_KEY`
   (`apps/runtime/src/observability/evidence-key.ts`) holds an Ed25519 private
   key — PEM PKCS#8 or a base64-encoded 32-byte seed. From it we derive the
   raw public key and a stable `kid` = `base64url(sha256(publicKeyRaw))`.
   The same key signs audit anchors, evidence bundles, and (as fallback)
   erasure receipts.

2. **Public verification material.** The public key is published as a JWKS at
   `GET /.well-known/atf-evidence-jwks.json` (OKP/Ed25519, `alg: EdDSA`,
   never the private part). Anyone — auditor, customer, regulator — verifies
   offline with only the artefact and this public endpoint.

3. **Dual-algorithm envelopes, algorithm selected by the record.** Signed
   artefacts carry an `alg`/`algorithm` field (`"ed25519"` | `"hmac-sha256"`).
   Verification branches on it: absent `alg` means legacy HMAC. Key material
   that cannot check the envelope's algorithm (HMAC secret for an Ed25519
   record, Ed25519 key for an HMAC record, wrong `kid`) yields
   `signature_mismatch` — never a silent fallback. Pre-existing HMAC anchors
   and bundles verify byte-identically to before; HMAC signing output is
   unchanged.

4. **Precedence chains** (explicit, no implicit mixing):
   - audit anchor: `EVIDENCE_SIGNING_KEY` > `AUDIT_ANCHOR_SECRET` > inactive
   - evidence bundle: `EVIDENCE_SIGNING_KEY` > `EVIDENCE_BUNDLE_SECRET` >
     `AUDIT_ANCHOR_SECRET` > endpoint `404`
   - erasure receipt: `ERASURE_RECEIPT_SIGNING_KEY` > `EVIDENCE_SIGNING_KEY` >
     `AUDIT_ANCHOR_SECRET` (HMAC) > unsigned

5. **Offline verification CLI.**
   The standalone `atf-verify` binary (and `bun run scripts/atf-verify.ts` in a
   source checkout) verifies bundles with `atf-verify --bundle <bundle.json>
   --jwks <url|file> [--kid <kid>]` (the bundle's own `kid` auto-selects the
   key); see "Offline verification" below. As an alternative,
   `bun run scripts/cli.ts verify-bundle <bundle.json> --jwks <url|file> [--kid <kid>]`
   (run in `apps/runtime` of a source checkout) does the same for bundles;
   `--secret <secret>` remains for legacy HMAC artefacts. The Markdown
   rendering of a bundle names the matching verify command for its algorithm.

6. **Migration visibility.** The production gate warns (non-fatal) when a
   deployment still signs evidence with HMAC only, recommending
   `EVIDENCE_SIGNING_KEY`; compliance dossiers and the Control UI state which
   algorithm produced each artefact and how to verify it.

## Offline verification

The `atf-verify` CLI verifies every artefact family of this ADR without
contacting the issuing Runtime. Releases ship a Linux x64 binary
(`atf-verify-linux-x64`); in a source checkout the same tool runs as
`bun run scripts/atf-verify.ts` (or `bun run atf-verify:build` for a local
binary). A JWKS — fetched once from the endpoint or a previously saved file —
supplies the public key; the artefact's own `kid` selects it.

```
atf-verify --receipt <file> --jwks <url|file> [--proof <file>] [--kid <kid>] [--json]
atf-verify --bundle <file> --jwks <url|file> [--kid <kid>] [--json]
atf-verify --erasure-receipt <file> --jwks <url|file> [--kid <kid>] [--json]
atf-verify --audit-export <file> [--anchor <file>] [--jwks <url|file>] [--kid <kid>] [--json]
atf-verify --release-receipt <file> --jwks <url|file> [--kid <kid>] [--json]
```

- `--bundle` re-computes the canonical content hash of the bundle and verifies
  the Ed25519 signature against the JWKS key. The `apps/runtime` alternative
  `bun run scripts/cli.ts verify-bundle <bundle.json> --jwks <url|file>`
  remains available; `--secret <secret>` verifies legacy HMAC artefacts.
- `--erasure-receipt` verifies the Ed25519 signature over the canonical JSON
  payload and schema-checks the payload.
- `--audit-export` re-verifies the hash chain of a JSONL audit-log export
  (`GET /monitoring/audit/export?format=jsonl`); with `--anchor <file>` it
  additionally verifies anchors written by the `AUDIT_ANCHOR_FILE` writer
  against the Ed25519 key from the JWKS.
- `--receipt` verifies Decision_Receipts (COSE_Sign1) and, with `--proof`,
  Merkle inclusion against the signed tree head (ADR-0029).

Exit codes: `0` verified, `1` verification failed, `2` usage or input error.
Legacy HMAC artefacts are out of scope for the binary — they verify with
`--secret` via `cli.ts verify-bundle` against the secret that signed them.

## Consequences

- Third parties can verify anchors, bundles, and receipts **independently and
  offline** — no shared secret, no trust in the operator's honesty, no
  runtime dependency on the platform being reachable at verification time
  (fetch the JWKS once).
- Verification capability no longer grants signing capability: exposing the
  JWKS is safe; the old model leaked both together.
- HMAC is demoted to a compatibility path: it stays verifiable forever
  (existing artefacts must not become unverifiable), but new deployments
  should configure `EVIDENCE_SIGNING_KEY`, and the prod gate nudges them.
- Key handling becomes real key management. The JWKS endpoint publishes
  **only the active key** and the verifier compares an artefact's `kid` with
  the key it is given, so after a rotation artefacts signed with the old key
  stop verifying against the live endpoint. The old **public** key must be
  archived with the artefacts (`runbooks/key-rotation.md`, "Evidence chain");
  `verify-bundle --jwks <file>` selects the key by the bundle's own `kid`.
  A dual-key overlap (a previous-key setting published in the same JWKS) is
  not implemented.
- The two algorithms never mix silently: the envelope's `alg` is authoritative
  in both directions, so a downgrade swap (replacing an Ed25519 artefact with
  an HMAC-signed one, or vice versa) fails verification rather than being
  papered over.
