<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Runbook: Key Rotation

Rotate on schedule, on suspicion, and whenever a holder leaves the trust circle.
Every rotation below is a secret-store change plus a rolling restart — no code
deploy is required. Record each rotation (who, when, which key, reason) in the
rotation log; the audit anchor (see below) makes the audit trail itself
tamper-evident.

## PII-Vault (`PII_VAULT_ENCRYPTION_KEY`)

The vault stores tokenized PII in `pii_vault_entries`, encrypted with AES-256-GCM
(`SecretCipher`). The ciphertext is bound to `(execution_id, token)` as AAD, so
entries never decrypt outside their own execution — and **entries written with an
old key fail closed after rotation**. That is acceptable because vault entries
are short-lived (they exist to re-identify PII within one execution's lifetime).

1. Generate a new key: `openssl rand -base64 32`.
2. Update `PII_VAULT_ENCRYPTION_KEY` in the secret store.
3. Drain in-flight executions (or pick a quiet window; entries older than the
   vault TTL are purged anyway).
4. Rolling-restart Runtime.
5. Verify: run one chat flow with `PII_VAULT_ENABLED=true` and confirm the
   response re-identification works and `pii_vault_entries` gains rows.

Do **not** rotate while executions are mid-decision if re-identification after
restart matters to them; the safest window is after the queue is empty
(`GET /monitoring/queue` on Runtime).

## OIDC (`OIDC_CLIENT_SECRET`, `OIDC_SESSION_SECRET`)

Two different secrets — rotate both, in this order:

1. **Client secret** (IdP side): create a second secret for the ATF client in
   your IdP (Authentik/Keycloak support two active secrets). Set
   `OIDC_CLIENT_SECRET` to the new value in Runtime, Gate, Search, Extract (the
   auth block is deliberately identical across services), restart, then revoke
   the old secret in the IdP.
2. **Session secret** (`OIDC_SESSION_SECRET`): rotating this **invalidates all
   active sessions** — users must log in again. Announce it, set the new value,
   rolling-restart Runtime and Gate. Old cookies fail signature verification and
   are rejected (fail closed); no cleanup step is needed.
3. Verify with a fresh login through Control (`/api/auth/*`) and one proxied
   Search request.

## BYOK (`BYOK_ENCRYPTION_KEY`)

`BYOK_ENCRYPTION_KEY` encrypts tenant-provided provider keys at rest (same
AES-256-GCM primitive as the vault). Unlike the vault, BYOK records are
**long-lived**, so rotation needs a re-encryption pass:

1. Generate the new key and set it as `BYOK_ENCRYPTION_KEY` **only after** step 2
   if your deployment supports dual keys; otherwise:
2. Export the tenant key inventory (`GET /v1/byok` as admin), decrypt with the
   old key, and re-register each key so it is re-encrypted with the new one.
3. Restart Runtime; allow `BYOK_CACHE_TTL_SECONDS` (default 60 s) for caches to
   expire.
4. Verify one BYOK-backed completion per affected tenant.

## Audit anchor (`AUDIT_ANCHOR_SECRET`)

The anchor service periodically hashes the audit chain and signs the anchor with
`AUDIT_ANCHOR_SECRET` into `AUDIT_ANCHOR_FILE`. Rotation must preserve
verifiability of **historical** anchors:

1. Before rotating, export the current anchor file (it is the last thing an
   attacker can silently rewrite — keep the copy off-host).
2. Set the new `AUDIT_ANCHOR_SECRET`, restart Runtime.
3. New anchors sign with the new secret; old anchors remain in the file with
   their original signatures. Verification of an old anchor requires the old
   secret — keep rotated secrets in the secret store marked `retired-<date>`,
   never delete them.
4. Verify: `verifyLatest()` (exposed via the Runtime monitoring status) must
   report the chain valid against the current anchor.

## Rotation frequency (recommended)

| Secret | Interval | Immediate on |
| --- | --- | --- |
| PII-Vault key | 90 days | Suspected vault/DB exposure |
| OIDC client secret | 180 days | IdP or admin compromise |
| OIDC session secret | 180 days | Any session hijack report |
| BYOK encryption key | 180 days | Any tenant key leak |
| Audit anchor secret | 365 days | Anchor file tampering suspicion |
