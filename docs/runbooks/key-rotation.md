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
(queue depth is the Prometheus metric `aiperator_queue_depth`, scraped via
`GET /metrics` on Runtime).

## OIDC (`OIDC_CLIENT_SECRET`, `OIDC_SESSION_SECRET`)

Two different secrets — rotate both, in this order:

1. **Client secret** (IdP side): create a second secret for the ATF client in
   your IdP (Authentik/Keycloak support two active secrets). Set
   `OIDC_CLIENT_SECRET` to the new value in Runtime, Gate, Search, Extract (the
   auth block is deliberately identical across services), restart, then revoke
   the old secret in the IdP. The Gate reads its OIDC client secret from the
   environment variable named in monitoring.oidc / auth config
   (`clientSecretEnv`), not from `OIDC_CLIENT_SECRET`.
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
2. Export the tenant key inventory (`GET /admin/tenants/{id}/provider-keys` as
   admin), decrypt with the old key, and re-register each key
   (`PUT /admin/tenants/{id}/provider-keys/{provider}`) so it is re-encrypted
   with the new one.
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
4. Verify: `GET /monitoring/audit/verify` must report the chain valid against
   the current anchor.

## Evidence chain (`EVIDENCE_SIGNING_KEY`)
`EVIDENCE_SIGNING_KEY` is the Ed25519 key (PEM PKCS#8, or a base64 32-byte seed)
that signs audit anchors, evidence bundles and — unless
`ERASURE_RECEIPT_SIGNING_KEY` is set — erasure receipts (ADR 0030). Its public
half is published at `/.well-known/atf-evidence-jwks.json`, `kid` =
`base64url(sha256(publicKey))`. Like the receipt JWKS, it contains **only the
current key**, and verification checks the artefact's `kid` against the key it is
given: after a rotation, anchors, bundles and receipts signed with the old key
are `signature_mismatch` against the live endpoint. They stay valid against the
old public key.
1. Before rotating, save the current JWKS response (`curl` the endpoint) next to
   the evidence and anchor archives and note the `kid`. Treat it as part of the
   rotation log — it is the only way a third party can verify older artefacts.
2. Export the anchor file (see "Audit anchor" above) and store it off-host.
3. Generate a new key (`openssl genpkey -algorithm ed25519`) and set
   `EVIDENCE_SIGNING_KEY` in the secret store; rolling-restart Runtime. A
   malformed key stops startup.
4. Verify: the JWKS shows the new `kid`; a fresh evidence bundle verifies with
   `atf verify-bundle <bundle.json> --jwks <url>`; for an archived bundle pass
   the archived JWKS file (`--jwks <file>`), which selects the key by the bundle's
   own `kid`.
5. Keep retired private keys only as long as policy requires; keep every retired
   **public** key indefinitely. Legacy HMAC artefacts (no `alg`) verify with
   `--secret` against the secret that signed them — rotating `AUDIT_ANCHOR_SECRET`
   or `EVIDENCE_BUNDLE_SECRET` does not touch Ed25519 artefacts.
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
`ERASURE_RECEIPT_SIGNING_KEY` signs erasure receipts the same way. Signing key
precedence is `ERASURE_RECEIPT_SIGNING_KEY` → `EVIDENCE_SIGNING_KEY` → an HMAC
derived from `AUDIT_ANCHOR_SECRET`; the algorithm and the `kid` are recorded in
the receipt envelope, and when the key is set its public key is also published
in the evidence JWKS. Rotating any key in that chain changes the signature of
newly issued receipts. Keep retired keys for verifying earlier receipts.
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
## Transaction keys (`TRANSACTION_SIGNING_KEY`, `MCPGATE_TRANSACTION_HS256_SECRET`)

Transaction tokens are signed by the Runtime (`TRANSACTION_SIGNING_KEY` with
`TRANSACTION_SIGNING_ALG`) and verified by each service that enforces them —
the Gate with `MCPGATE_TRANSACTION_HS256_SECRET` / `MCPGATE_TRANSACTION_JWKS_URI`,
Search with `TRANSACTION_HS256_SECRET` / `TRANSACTION_JWKS_URI`. Because the
verifiers accept a set of algorithms at the same time, rotation is a sequenced
migration rather than a single restart: every verifier must accept both the old
and the new algorithm before the issuer switches over, and only then may the old
one be removed. See the
[transaction-token rotation runbook](./transaction-token-rotation.md) for the
ordered procedure.
## Rotation frequency (recommended)

| Secret | Interval | Immediate on |
| --- | --- | --- |
| PII-Vault key | 90 days | Suspected vault/DB exposure |
| OIDC client secret | 180 days | IdP or admin compromise |
| OIDC session secret | 180 days | Any session hijack report |
| BYOK encryption key | 180 days | Any tenant key leak |
| Audit anchor secret | 365 days | Anchor file tampering suspicion |
| Receipt signing key | 365 days | Key exposure |
| Evidence signing key | yearly or on suspicion | Old public key must stay available to verify old artefacts (archive the JWKS) |
| Service tokens (`API_TOKEN`) | 180 days | Token leak |
| Control session secret | 180 days | Any session hijack report |
| TLS certificates | before expiry | Key exposure |
| `API_KEY_PEPPER`, `STATS_QUERY_PEPPER` | only with a plan (see above) | Pepper exposure |
