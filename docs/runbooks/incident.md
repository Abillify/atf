<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Runbook: Incident Handling

Goal: contain, understand, and recover — while keeping the audit trail usable as
evidence. The audit log is the Runtime's hash-chained audit table in PostgreSQL
(verify with `GET /monitoring/audit/verify`); the Gate writes JSONL audit lines
but has no database. Preserve both early.

## Roles

- **IC (Incident Commander)**: one named person, owns severity and comms.
- **Ops**: executes containment/recovery steps below.
- **Compliance**: DSFA/DPIA obligations, 72 h GDPR notification clock (start it
  at *awareness*, not confirmation).

## Severity

| Sev | Definition | Response |
| --- | --- | --- |
| S1 | Confirmed data exposure, auth bypass, or audit tampering | Page IC + security, freeze deploys |
| S2 | Single-tenant impact, credential leak without confirmed access | IC within 1 h |
| S3 | Degraded service, no data impact | Business hours |

## First 15 minutes (S1)

1. **Snapshot evidence before changing anything**:
   - `pg_dump` the Runtime database (the audit chain lives there) — see
     `backup-restore.md`. If the Gate monitor audit sink is enabled, copy its
     JSONL file (`monitoring.audit.file`) too; the Gate itself has no database.
   - Copy `AUDIT_ANCHOR_FILE` off-host.
   - `kubectl logs`/`docker logs` for all five services, current + previous pod.
2. **Verify the audit chain**: `GET /monitoring/audit/verify` on the Runtime.
   A failed verification means the audit trail itself is in scope; treat all
   data as potentially read.
3. **Contain, minimally**:
   - Rotate `OIDC_SESSION_SECRET` → invalidates every active session
     (`key-rotation.md`). This is the fastest global logout.
   - Revoke the affected OIDC client secret in the IdP.
   - If a tenant key leaked: rotate `BYOK_ENCRYPTION_KEY` and re-register
     affected tenant keys.
   - If the Runtime API is the attack surface, scale it to zero behind the Gate
     or block at the gateway — Gate can stay up for the monitor UI.
4. **Do not** delete rows, purge logs, or "clean" the scratch volume before the
   snapshot. `TEMP_DIR` wipe happens **after** evidence capture
   (`backup-restore.md`).

## Investigation aids

| Question | Where to look |
| --- | --- |
| Who did what, when | Runtime audit log (`GET /monitoring/audit`, export `GET /monitoring/audit/export`) |
| What did a flow decide | Runtime evidence/dossier per execution id |
| Was PII exposed | PII-Vault entries + output-guardrail events for the execution |
| Which flows changed | Flow version history in Control; `flow_version` in execution traces |
| Outbound calls made | Runtime egress log (`security/egress.ts` records) |
| MCP/tool activity | Gate monitor UI (`/monitor`), tool authorization policy decisions |
| Tool calls through the Gate | Gate JSONL audit (per instance) |

## Evidence signing key compromised

`EVIDENCE_SIGNING_KEY` signs audit anchors, evidence bundles and (unless
overridden) erasure receipts. If it is compromised:

1. Generate a new `EVIDENCE_SIGNING_KEY` (`openssl genpkey -algorithm ed25519`)
   and set it in the secret store (`key-rotation.md`).
2. Archive the old JWKS fetched from
   `GET /.well-known/atf-evidence-jwks.json` with the date — the endpoint
   publishes only the current key, and old artefacts verify only against the
   archived public key.
3. Rolling-restart the Runtime so it signs with the new key.
4. Fix the point in time from which the old key is untrusted: artefacts signed
   with the old `kid` **after** the compromise window are not trustworthy, even
   though they verify cryptographically.
5. Re-anchor the audit chain: let the anchor service write a fresh anchor and
   confirm `GET /monitoring/audit/verify` reports `ok`.

## Tokens leaked into the audit log

Earlier versions wrote raw `Authorization` headers (or bearer-token prefixes)
into the audit `actor` field; see the actor-correction item in
`docs/UPGRADE.md`. If audit rows contain live tokens:

1. Rotate every operator token that appears in the audit rows — the log is
   readable by anyone with `GET /monitoring/audit` and by the log shipper.
2. Restrict `GET /monitoring/audit` and the audit log-shipper stream until the
   rotation is complete.
3. The rows stay in the hash chain (removing them breaks it); a purge needs the
   documented `audit_log_purge` procedure with its pre-purge anchor.

## Erasure requests during an incident

`POST /v1/erasure` (Gate, service-auth) stays available — GDPR deadlines do not
pause for incidents. If you must freeze writes to a database, document the
decision and the compensating control; process erasure immediately after
recovery.

## Recovery and close-out

1. Restore services per `backup-restore.md`; verify health endpoints and one
   end-to-end transaction.
2. Re-verify the audit chain covers the incident window.
3. Write the incident record within 48 h: timeline, detection source, blast
   radius, keys rotated, anchor file hashes before/after.
4. Feed lessons back: new red-team attack cases (`security/red-team-attacks.ts`
   registry) and, if a control failed, a regression test — never only a doc.
5. If personal data was exposed: complete the DSFA-relevant assessment
   (`docs/DSFA-VORLAGE.md` annex) and the 72 h notification if required.
