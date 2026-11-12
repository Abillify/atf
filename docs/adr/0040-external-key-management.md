# 40. Secrets from files, and a design for external key management

Date: 2026-11-11

## Status

Accepted (2026-11-12). Layer 1 (`NAME_FILE`) is implemented. Layer 2 (`KeyProvider`) is the
accepted design for external key management; its first implementation step is defined below
and not yet built.

## Context

ATF's signing and encryption keys, service tokens and connection strings arrived only through
environment variables: `EVIDENCE_SIGNING_KEY`, `RECEIPT_SIGNING_KEY`,
`ERASURE_RECEIPT_SIGNING_KEY`, `SEARCH_EVIDENCE_SIGNING_KEY`, `PII_VAULT_ENCRYPTION_KEY`,
`BYOK_ENCRYPTION_KEY`, the transaction-token secrets, `CONTROL_SESSION_SECRET`,
`OIDC_CLIENT_SECRET`, `PROVIDERS` (which carries API keys), `DATABASE_URL` and the other
connection URLs (which carry passwords), and the rest of the variables marked SECRET in
`docs/CONFIGURATION.md`. The only file-based inputs were TLS material (`TLS_KEY_FILE` and
siblings), which are paths, not a secret pattern.

That is awkward where enterprise deployments run. Kubernetes secret mounts (projected volumes,
External Secrets Operator, Sealed Secrets) and Docker/Swarm secrets deliver secrets as files;
pushing them into environment variables needs an extra translation step whose failure modes are
silent (a trailing newline corrupts a base64 key and surfaces as "invalid key" at first use). A
KMS or HSM — the answer to "where should signing keys live" in a regulated deployment — was not
reachable at all: private key bytes are consumed directly wherever they are needed.

The two concerns are not equally ready, so this record splits them.

## Decision

### Layer 1 — `NAME_FILE` before `NAME` (implemented)

`resolveSecret(env, name)` and `materializeSecrets(names)` in `@atf/security-kit`
(`packages/security-kit/src/auth/resolve-secret.ts`) are the single implementation:

- If `NAME_FILE` is set, the file is read, exactly one trailing `\n` or `\r\n` is stripped, and
  the content is the value. Nothing else is trimmed.
- If only `NAME` is set, it is used verbatim, as before.
- Both set is a startup error naming both variables — never a precedence rule. Ambiguity about
  which key signed a receipt is an evidence problem, not a configuration preference.
- An unreadable file is a startup error with the path and the OS error; an empty file is a
  startup error. Neither falls back to `NAME` or to an empty secret.
- Reading happens once, at configuration load. Rotation remains a restart
  (`docs/runbooks/key-rotation.md`).

Coverage:

- Runtime, Search, Extract and Gate resolve an explicit list per service (`RUNTIME_SECRET_VARS`,
  `SEARCH_SECRET_VARS`, `EXTRACT_SECRET_VARS`, `GATE_SECRET_VARS`) at the top of configuration
  loading and write the resolved values back into the process environment, so subsystems that
  read `process.env` directly see them too. The lists are explicit rather than a name pattern,
  so path-valued variables (`TLS_KEY_FILE`, `SEARCH_CA_CERT_FILE`, `AUDIT_ANCHOR_FILE`,
  `OUTPOST_CONFIG_FILE`, …) are never read as secret pointers. They include the connection URLs
  (`DATABASE_URL`, `DATABASE_OPERATOR_URL`, `REDIS_URL`, `POSTGRES_URL`,
  `EXTRACT_DATABASE_URL`, `RATE_LIMIT_REDIS_URL`, `MCPGATE_TRANSACTION_REDIS_URL`),
  `PROVIDERS` and `OPERATOR_TOKENS`.
- In the Gate, every `${VAR}` reference in the YAML configuration and every
  `tokenExchange.clientSecretEnv` honours `VAR_FILE` the same way, because Gate secrets are
  operator-named and no fixed list can cover them.
- Control resolves `CONTROL_SESSION_SECRET` the same way.
- The configuration reference documents the rule once for all services instead of adding a
  `*_FILE` row per variable; the Helm chart passes mounts through
  `extraVolumes`/`extraVolumeMounts` and documents an example.

### Layer 2 — `KeyProvider`: keys as an operation, not data (accepted design)

A key becomes reachable through an interface rather than as bytes:

```ts
interface KeyProvider {
  /** Sign `payload` with the key `keyId`; the private key never leaves the provider. */
  sign(keyId: string, payload: Uint8Array): Promise<Uint8Array>;
  /** Encrypt / decrypt for encryption keys (PII vault, BYOK). */
  encrypt?(keyId: string, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  decrypt?(keyId: string, ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  /** Public key material for the JWKS endpoints, by key id. */
  publicKey(keyId: string): Promise<JsonWebKey>;
  /** Key ids this provider currently signs with, newest first. */
  activeKeyIds(): readonly string[];
}
```

Where it plugs in:

| Key | Today | With a provider |
| --- | --- | --- |
| `EVIDENCE_SIGNING_KEY` (Ed25519, ADR 0030) | `CryptoKey` from seed at boot | `sign()`; JWKS from `publicKey()` |
| `RECEIPT_SIGNING_KEY`, tree-head sealing | same | same |
| `ERASURE_RECEIPT_SIGNING_KEY`, `SEARCH_EVIDENCE_SIGNING_KEY` | same | same |
| `PII_VAULT_ENCRYPTION_KEY`, `BYOK_ENCRYPTION_KEY` (AES-GCM) | raw 32 bytes in memory | `encrypt()`/`decrypt()` with the existing per-entry AAD |
| HS256 transaction secrets | HMAC with a shared secret | **not a fit** — the migration is ES256/EdDSA transaction tokens (ADR 0035), whose signing key then goes through the provider |

Rules the implementation must keep:

- **No SDK in the core.** The interface and an in-process provider (today's behaviour, keys from
  layer 1) live in the core. Cloud and HSM adapters (AWS KMS, GCP KMS, Azure Key Vault, PKCS#11)
  are separate optional packages, added one at a time with a named deployment that needs them —
  each SDK is a supply-chain review (`supply-chain:check`).
- **Evidence keys first.** Their call volume follows the sealing and issuance cadence, not
  request traffic, so a 5–50 ms remote sign call is acceptable. Per-request operations are not
  routed through a remote provider.
- **Key ids are explicit.** Every signature format already carries a `kid`; a provider serves
  several key ids so verification works across rotations.
- **Fail closed.** A provider that cannot reach its KMS fails the signing operation; receipt
  issuance or sealing stops and `/health/ready` reports it. It never falls back to a cached,
  local or generated key.

First implementation step (when scheduled): introduce the interface with the in-process
provider and route the four evidence-signing call sites through it, with no behaviour change
and no new dependency. Remote adapters follow as separate decisions.

## Consequences

- Operators mount secrets as files in Kubernetes and Docker (`NAME_FILE`), and the startup
  refuses ambiguous or broken configurations instead of failing at first use.
- The evidence-signing call sites converge on one seam, so a KMS adapter later touches one
  module instead of every signer.
- Explicitly out of scope: automatic key rotation, per-tenant keys, live re-reading of secret
  files, and any concrete KMS integration. ADR 0025 and ADR 0030 remain the records for what the
  keys protect; this record governs only how they are supplied.
