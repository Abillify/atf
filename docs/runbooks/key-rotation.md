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

## Decision receipts (`RECEIPT_SIGNING_KEY`, `ERASURE_RECEIPT_SIGNING_KEY`)
`RECEIPT_SIGNING_KEY` is the Ed25519 key (PEM, or a raw base64 32-byte seed) that
signs Decision_Receipts. The public half is served at
`/.well-known/atf-receipt-jwks.json` with a `kid` derived from the public key.
The JWKS contains **only the current key** and the Runtime has no dual-key
overlap, so after a rotation receipts signed with the old key no longer verify
against the live JWKS. Keep the old public JWK (and its `kid`) with the archived
receipts.
1. Before rotating, save the current JWKS response next to the receipt archive.
2. Generate a new Ed25519 key and set `RECEIPT_SIGNING_KEY` in the secret store.
3. Rolling-restart Runtime. A malformed key stops startup when
   `DECISION_RECEIPTS_ENABLED=true`.
4. Verify: `GET /.well-known/atf-receipt-jwks.json` shows the new `kid`, and a new
   chat yields a receipt that verifies against it.
`ERASURE_RECEIPT_SIGNING_KEY` signs erasure receipts the same way. When it is
unset, erasure receipts are signed with an HMAC derived from
`AUDIT_ANCHOR_SECRET` (the algorithm is recorded in the receipt envelope), so
rotating the anchor secret changes that signature too. Keep retired keys for
verifying earlier receipts.
## API key pepper (`API_KEY_PEPPER`)
With a pepper, API keys are stored as HMAC-SHA-256 hashes (`api_keys.hash_alg =
hmac-sha256`). Keys created before the pepper was set carry plain SHA-256 hashes
and migrate to HMAC on their next successful lookup. A lookup tries the current
pepper's HMAC form and the SHA-256 form only; a dual-pepper overlap is not
implemented. **Changing or removing the pepper therefore stops every key hashed
under the old value from authenticating**, and tenants have to issue new keys.
Plan it as a coordinated reissue, not as a routine rotation, and take a database
backup first. Set the same value on every Runtime replica.
## Search statistics pepper (`STATS_QUERY_PEPPER`)
Search hashes query terms (HMAC-SHA-256) into `vs_search_stats.query_hash` with
this pepper, and the erasure path hashes subject identifiers the same way to
find matching rows. After a change, existing hashes no longer match the new
pepper: old statistics rows stay unreadable as terms, and a subject erasure
cannot find them by hash until they expire under `STATS_RETENTION_DAYS`. Rotate
at most once per retention window, and set the same value on all Search
replicas.
## Service tokens (`API_TOKEN`, `API_TOKEN_NEXT`)
Search and Extract accept `API_TOKEN_NEXT` next to `API_TOKEN`; while both are
set, either authenticates. Rotate without downtime:
1. Set the new token as `API_TOKEN_NEXT` and rolling-restart the service.
2. Roll every caller of that service (for example the Runtime, Gate or Control
   deployments that hold the token) over to the new token.
3. Promote the new token to `API_TOKEN`, unset `API_TOKEN_NEXT`, restart.
4. Verify: a request with the old token returns 401.
## Control session (`CONTROL_SESSION_SECRET`)
In BFF mode (`CONTROL_SESSION_MODE=bff`) the secret (at least 32 characters)
derives the AES-256-GCM key that seals the session cookie. Rotating it
**invalidates all Control sessions**; users sign in again through SSO. There is
no data to migrate. Without a valid secret the session endpoints answer 503.
Set the new value on every Control replica at the same time, then restart them.
## TLS and mTLS (`TLS_CERT_FILE`, `TLS_KEY_FILE`, `TLS_CLIENT_CA_FILE`)
The files are read directly by the service, not validated at startup, and a
hot reload is not documented. Replace the certificate and key files (or the
client CA bundle for mTLS) and rolling-restart the service, one replica at a
time. Add a new client CA to the bundle before issuing client certificates from
it, and remove the old CA only after all clients have switched. Verify with a
handshake against each replica.
## Rotation frequency (recommended)

| Secret | Interval | Immediate on |
| --- | --- | --- |
| PII-Vault key | 90 days | Suspected vault/DB exposure |
| OIDC client secret | 180 days | IdP or admin compromise |
| OIDC session secret | 180 days | Any session hijack report |
| BYOK encryption key | 180 days | Any tenant key leak |
| Audit anchor secret | 365 days | Anchor file tampering suspicion |
| Receipt signing key | 365 days | Key exposure |
| Service tokens (`API_TOKEN`) | 180 days | Token leak |
| Control session secret | 180 days | Any session hijack report |
| TLS certificates | before expiry | Key exposure |
| `API_KEY_PEPPER`, `STATS_QUERY_PEPPER` | only with a plan (see above) | Pepper exposure |
