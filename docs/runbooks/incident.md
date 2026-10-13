<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Runbook: Incident Handling

Goal: contain, understand, and recover — while keeping the audit trail usable as
evidence. The audit log lives in the **Gate** database and is hash-chained; the
Runtime anchor file signs snapshots of that chain. Preserve both early.

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
   - `pg_dump` the Gate database (audit log) — see `backup-restore.md`.
   - Copy `AUDIT_ANCHOR_FILE` off-host.
   - `kubectl logs`/`docker logs` for all five services, current + previous pod.
2. **Verify the audit chain**: Runtime monitoring status → anchor
   `verifyLatest`. A failed verification means the audit trail itself is in
   scope; treat all data as potentially read.
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
| Who did what, when | Gate audit log (per-tenant, per-subject) |
| What did a flow decide | Runtime evidence/dossier per execution id |
| Was PII exposed | PII-Vault entries + output-guardrail events for the execution |
| Which flows changed | Flow version history in Control; `flow_version` in execution traces |
| Outbound calls made | Runtime egress log (`security/egress.ts` records) |
| MCP/tool activity | Gate monitor UI (`/monitor`), tool authorization policy decisions |

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
