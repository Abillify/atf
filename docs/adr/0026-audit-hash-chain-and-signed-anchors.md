<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# 26. Audit integrity: hash chain plus signed external anchors

Date: 2026-10-08

## Status

Accepted — the HMAC-only anchor signature is partially superseded by
[ADR-0030](0030-asymmetric-evidence-chain-ed25519.md); HMAC anchors remain
verifiable as legacy artefacts

## Context

The audit log is the platform's accountability record. Stored as plain rows
in Postgres it is only as trustworthy as the database: anyone with write
access to the DB — an attacker with stolen credentials, or an operator —
could edit or delete events without leaving evidence. "We trust the DB" is
not an acceptable threat model for a compliance product.

## Decision

Audit integrity is built from two complementary mechanisms
(`apps/runtime/src/observability/`):

1. **Append-only hash chain** (`audit-log.ts`): every event stores
   `hash = H(event, prev_hash)` over the hash of its predecessor. Writes
   serialize against the current chain tip in SQL (no in-process tip cache,
   so concurrent writers cannot fork the chain). Any edit, insertion or
   deletion of a stored row breaks the chain from that point on;
   `verifyChain` walks the log and reports the first broken record
   (`hash_mismatch` / `prev_hash_mismatch`).

2. **Signed external anchors** (`audit-anchor.ts`): periodically and on
   demand, the current chain tip is signed with an operator-held secret
   (`AUDIT_ANCHOR_SECRET`) that lives outside the audit database — in the
   secret store, never in the DB — and the anchor is appended to
   `AUDIT_ANCHOR_FILE`, also outside the database. `verifyLatest()`
   re-checks the stored anchor against the current chain. An attacker who
   rewrites history must also forge an anchor, which requires the external
   secret.

The anchor service is secret-gated: without `AUDIT_ANCHOR_SECRET` it is
inactive — anchoring is an explicit deployment decision, and its absence is
visible, not silently half-on.

## Consequences

- Tamper detection is cryptographic, not procedural: chain verification
  plus an external signed checkpoint bounds what a DB-level attacker can
  get away with to "the window since the last anchor".
- Key handling becomes operational policy: the anchor secret must be
  retained after rotation (old anchors must stay verifiable) — see the
  key-rotation runbook.
- Chain verification is O(n) over the log; it runs as a scheduled/
  on-demand check, not on the request path. Anchoring adds one small
  signing operation per interval.
