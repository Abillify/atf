<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# 29. Verifiable execution receipts (COSE_Sign1 + Merkle log)

Date: 2026-10-08

## Status

Accepted (implemented in the platform-hardening plan, Phase 21)

## Context

A third party (auditor, customer, counterparty) who receives the *result*
of an ATF execution has no way to verify *that* the execution really
happened on this platform, under which policy version, with which approvals
and evidence — without trusting a database export or a screenshot. The
existing audit chain (ADR 0026) is an internal accountability record keyed
to operators, not a portable artifact a business consumer can validate.

## Decision

Every execution produces a **receipt**: a compact, self-contained,
cryptographically signed statement over the execution's non-PII decision
facts — debug-trace digest, policy hashes, PII-handling metrics,
evidence-pack digest, approval records and cost-ledger totals. The receipt
payload must contain no PII (Req. 15.6).

- **Encoding/signature**: CBOR with a COSE_Sign1 structure, Ed25519 via
  WebCrypto. A minimal CBOR encoder/decoder lives in the platform so no
  third-party serialization stack sits on the trust path.
- **Transparency**: receipts are appended to a `receipt_log` maintained as
  an RFC-6962 Merkle tree; signed tree heads (COSE_Sign1 with the receipt
  key, domain-separated from receipts) are the audit anchors and are
  persisted in the append-only `receipt_tree_heads` table. Inclusion proofs
  let a verifier confirm a receipt is part of the log without trusting the
  log operator's honesty about history. The in-memory tree is the hot path
  for proofs and is rebuilt from `receipt_log` at startup, so a restarted
  replica continues the same log.
- **Distribution**: `GET /v1/receipts/{id}` and `GET /v1/receipts/{id}/proof`
  serve receipt and inclusion proof; signing keys are published as JWKS;
  the Runtime response header `X-ATF-Receipt` points a client at the
  receipt for the request's execution.
- **Verification**: the `atf-verify` CLI (script plus compiled binary)
  verifies a receipt offline against the JWKS and an inclusion proof —
  verification must not require database access.
- **Operator UX**: the Control trace viewer shows the receipt and offers
  export.

## Consequences

- Receipts are only as strong as the signing key custody and the
  transparency log: tree-head anchoring is what prevents silent
  history rewriting, so it is part of the design, not an add-on.
- The payload schema is externally observable once issued; it is versioned
  from the start and treated as a public contract.
- Receipt signing and the Merkle append run once per execution, after the
  inner engine finishes; issuance is best-effort, so a receipt failure is
  logged and never breaks the request. While audit anchoring is active
  (`AUDIT_ANCHOR_SECRET`), tree heads are sealed on the audit-anchor
  interval (`AUDIT_ANCHOR_INTERVAL_MS`) whenever the log grew; in addition
  the proof route seals a head on demand when no sealed head covers the
  receipt yet. Sealed heads are persisted in `receipt_tree_heads` only; they
  are not written to the audit-anchor file (`AUDIT_ANCHOR_FILE`), so an
  off-host copy of the heads requires exporting that table.
- Known limitation: the transparency log assumes a single receipt-issuing
  writer. With several Runtime replicas each replica keeps its own
  in-memory tree, so their trees (and the proofs they issue) diverge from
  each other and from the shared `receipt_log`. Run one receipt-issuing
  replica, or treat the logs as per-replica, until a shared sequencer
  exists. For the same reason the lookup fallback reads the replica's
  rebuilt in-memory tree, not `receipt_log`: a receipt issued by another
  replica returns 404 until this replica restarts.
- A receipt evicted from the bounded in-memory store is still served by
  `GET /v1/receipts/{id}` from the rebuilt log; the per-execution listing
  (`GET /v1/receipts?execution_id=`) only covers receipts the replica
  still holds in memory.
- Known limitation: startup hydration reads every `receipt_log` row (no
  bound, no checkpoint) and keeps all leaves in memory, so boot time and
  memory grow with the lifetime receipt volume (one receipt per chat
  completion plus one per tool call). Watch Runtime start-up time and RSS
  when receipts are enabled; a checkpointed tree (sealed head plus frontier)
  would remove the full replay and is not implemented yet.
