# 40. Secrets from files, and a design for external key management

Date: 2026-11-11

## Status

Proposed

## Context

ATF's signing and encryption keys arrive through environment variables:
`EVIDENCE_SIGNING_KEY`, `RECEIPT_SIGNING_KEY`, `ERASURE_RECEIPT_SIGNING_KEY`,
`SEARCH_EVIDENCE_SIGNING_KEY`, `PII_VAULT_ENCRYPTION_KEY`,
`BYOK_ENCRYPTION_KEY`, `TRANSACTION_HS256_SECRET` (and its per-service
variants), `CONTROL_SESSION_SECRET`, `OIDC_CLIENT_SECRET`, `PROVIDER_KEYS`,
and roughly two dozen more marked SECRET in `docs/CONFIGURATION.md`. There is
no `*_FILE` variant for any of them — the only file-based secret in the whole
surface is `TLS_KEY_FILE`, which is a TLS listener input, not a pattern to
reuse — and no shared loader: each service reads its variables through its own
Zod `EnvSchema`.

That is awkward in exactly the environments the enterprise track targets.
Kubernetes secret mounts (`projected` volumes, External Secrets Operator,
Sealed Secrets) deliver secrets as files by default; pushing them into env
vars requires an extra translation step whose failure modes are silent (a
trailing newline from `echo $SECRET > env` corrupts base64 keys in ways that
surface as "invalid key" at first use, not at deploy). And a KMS/HSM — the
answer to "where should signing keys live" in a regulated deployment — is not
reachable at all: the private key bytes are consumed directly wherever they
are needed.

This ADR splits the two concerns, because they are not equally ready:

1. **`*_FILE` variants** are a small, mechanical, uncontroversial improvement.
   The implementation part lives in the review follow-up (G2); this ADR pins
   the semantics so the implementation and the docs agree.
2. **External key management (KMS/HSM)** is a real architectural change —
   keys stop being data the process holds and become an operation the process
   calls. It gets a design here and nothing more; no KMS dependency is added
   by any current task.

## Decision

Proposed, in two layers.

### Layer 1 — `resolveSecret(env, name)`: `NAME_FILE` before `NAME`

A single function in `@atf/security-kit`, used by every service's config
loading for every variable marked SECRET:

- If `NAME_FILE` is set, read the file at that path, use its content with one
  trailing `\n` (and `\r\n`) trimmed, and ignore `NAME` entirely.
- Else if `NAME` is set, use it verbatim (today's behavior, unchanged — no
  trimming of the variable itself, so a secret that legitimately ends in
  whitespace is not silently altered).
- If both are set, fail at startup with a message naming both variables —
  never pick one. Ambiguity about which key signed a receipt is an evidence
  problem, not a config preference.
- If `NAME_FILE` is set but the file cannot be read, fail at startup with the
  path and the OS error, not a generic "secret missing" — a typo'd secret path
  and an absent secret need different fixes.
- Empty content is a configuration error, not "the secret is the empty
  string".

Reading happens once, at config load, like every other variable — no live
re-read, so a secret rotation stays a restart (which is already the rotation
story for these keys; see `docs/runbooks/key-rotation.md`, which this change
extends with the file path). The function is pure `env → value` so each
service keeps its own Zod schema; the schemas gain the `*_FILE` twin as an
optional string, and the config-reference generator picks them up like any
other variable.

### Layer 2 — `KeyProvider`: keys as an operation, not data

Design only. A key becomes reachable through an interface rather than as
bytes:

```ts
interface KeyProvider {
  /** Stable key id this provider answers for (appears in kid/`kid` headers). */
  readonly keyId: string;
  /** Sign a payload; the private key never leaves the provider. */
  sign(payload: Uint8Array): Promise<Uint8Array>;
  /** Decrypt a payload, if the key is an encryption key. */
  decrypt?(ciphertext: Uint8Array): Promise<Uint8Array>;
}
```

Where it would plug in, per current key consumer:

| Key | Today | With a provider |
| --- | --- | --- |
| `EVIDENCE_SIGNING_KEY` (Ed25519, ADR 0030) | WebCrypto `CryptoKey` from PEM/seed at boot | `sign()` on the provider; verification unchanged (public key via JWKS) |
| `RECEIPT_SIGNING_KEY` / `tree-head-sealer.ts` | same | same |
| `PII_VAULT_ENCRYPTION_KEY` (AES-GCM) | raw 32-byte key in memory | `decrypt()` + `encrypt()`; the vault's per-entry AAD contract must be provider-independent |
| `TRANSACTION_HS256_SECRET` | HMAC with shared secret | **not a fit** — HMAC needs the secret on both sides; an asymmetric replacement (ADR 0035's ES256/EdDSA path) is the actual migration, and the provider design must not imply HS256 can be externalized |

Design constraints the implementation must honor:

- **No SDK dependency in the core.** The interface is the dependency; a KMS
  adapter (AWS KMS, GCP KMS, PKCS#11) is a separate optional package. ATF's
  dependency policy (supply-chain review per package, `supply-chain:check`)
  makes "one SDK per cloud" expensive, so the first implementation is the
  interface plus the existing in-process provider, and cloud adapters follow
  only with a named customer requirement.
- **Latency budget.** A KMS sign call is 5–50 ms over the network. Receipt
  sealing and audit anchoring are periodic — fine. Per-execution operations
  (transaction tokens) are not, which again points at the asymmetric-token
  path rather than per-signature KMS calls. The design therefore scopes
  `KeyProvider` to the *evidence* keys first (receipts, audit anchors,
  erasure receipts, search evidence packs), where call volume is anchored to
  the sealing cadence, not to traffic.
- **Key id discipline.** Every signature format already carries a `kid`; the
  provider must be able to serve an old key id for verification-side
  operations after rotation, which means a provider is a *set* of key handles
  in practice, addressed by id — the interface above shows the single-key
  shape for clarity; the implementation will take `keyId` per call.
- **Fail closed.** A provider that cannot reach its KMS must fail signing
  operations loudly (receipt issuance pauses, the production gate reports
  degraded), never fall back to a cached or generated key. A silently
  substituted signing key is worse than no receipt.

## Consequences

- **For operators (layer 1):** Helm/K8s deployments mount secrets as files and
  set `NAME_FILE=/run/secrets/name`; docker-compose keeps env vars. Both paths
  are tested; `docs/runbooks/key-rotation.md` gains the file variant; the Helm
  chart documents a mounted-secret example.
- **For the config surface:** roughly 30 new optional `*_FILE` variables in
  `docs/CONFIGURATION.md`. That is noise the reference table pays for one
  time; the alternative (per-service file conventions) is worse.
- **For layer 2:** nothing changes today. The value of writing the design now
  is that the evidence-signing call sites can be nudged toward a single
  seam (one module that holds the `CryptoKey`) as they are touched, so a
  future provider does not require touching twelve files.
- **Explicitly out:** rotating keys automatically, splitting a key per
  tenant, and any concrete KMS integration. ADR 0025 (cross-service erasure)
  and ADR 0030 (asymmetric evidence chain) remain the governing records for
  what the keys protect; this ADR changes only how they are supplied.
