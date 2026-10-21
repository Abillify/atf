<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Runbook: Transaction-token rotation

Transaction tokens are minted by the Runtime and verified by each service that
enforces them. Rotation is a sequenced migration — verifiers must accept the
old and the new algorithm at the same time before the issuer switches over, so
nothing is rejected at any step. The background and the optional HS256→EdDSA
migration are described in the transaction-token item of `docs/UPGRADE.md` and
[ADR-0035](../adr/0035-asymmetric-transaction-tokens-audience-per-service.md).

## Variables per service

| Service | Role | Variables |
| --- | --- | --- |
| Runtime | issuer | `TRANSACTION_SIGNING_KEY` (PKCS#8 PEM), `TRANSACTION_SIGNING_ALG` (`HS256` \| `ES256` \| `EdDSA`), `AGENT_TRANSACTION_AUDIENCES` (JSON object server name → audience) |
| Gate | verifier | `MCPGATE_TRANSACTION_HS256_SECRET`, `MCPGATE_TRANSACTION_JWKS_URI`, `MCPGATE_TRANSACTION_ALGORITHMS`, `MCPGATE_TRANSACTION_AUDIENCE`, `MCPGATE_TRANSACTION_ISSUER`, `MCPGATE_TRANSACTION_ENFORCEMENT` (default `off`), `MCPGATE_TRANSACTION_REDIS_URL` |
| Search | verifier | `TRANSACTION_HS256_SECRET`, `TRANSACTION_JWKS_URI`, `TRANSACTION_ALGORITHMS`, `TRANSACTION_AUDIENCE` |

Extract does not verify transaction tokens and needs no changes.

The Runtime publishes its public key at
`GET /.well-known/atf-transaction-jwks.json`. While
`TRANSACTION_SIGNING_ALG` is `HS256` the endpoint answers `{"keys":[]}`; it
publishes the key once a non-HS256 algorithm is active.

## Rotation order (verifiers first)

1. **Prepare the new issuer key** on the Runtime: generate the new key
   (for Ed25519: `openssl genpkey -algorithm ed25519` in PKCS#8 PEM form) and
   set `TRANSACTION_SIGNING_KEY`. Leave `TRANSACTION_SIGNING_ALG` unchanged for
   now — tokens are still signed the old way.
2. **Every verifier accepts both**: keep the HS256 secret and add the JWKS
   URI. Gate: keep `MCPGATE_TRANSACTION_HS256_SECRET`, add
   `MCPGATE_TRANSACTION_JWKS_URI` (default algorithms then include HS256 plus
   RS256/ES256/EdDSA). Search: keep `TRANSACTION_HS256_SECRET`, add
   `TRANSACTION_JWKS_URI` (defaults then include HS256, ES256, EdDSA). In
   Search production the JWKS URL must be https.
3. **Per-service audiences** (recommended alongside a rotation): set
   `MCPGATE_TRANSACTION_AUDIENCE` on the Gate, `TRANSACTION_AUDIENCE` on
   Search, and `AGENT_TRANSACTION_AUDIENCES` on the Runtime, e.g.
   `{"taiga":"mcpgate-taiga","search":"vectorsearch"}`. Roll the verifiers
   first, then the Runtime.
4. **Switch the issuer**: set `TRANSACTION_SIGNING_ALG=EdDSA` (or the chosen
   algorithm) on the Runtime and restart it. New tokens carry the new
   signature; the JWKS now publishes the active key.
5. **Verifiers drop the old algorithm**: remove the HS256 secrets and set
   `MCPGATE_TRANSACTION_ALGORITHMS=EdDSA` / `TRANSACTION_ALGORITHMS=EdDSA`.
   The production-gate warnings stop. Remove any legacy
   `AGENT_TRANSACTION_SECRET` from the Runtime.

## Timing window

The JWKS publishes only the active key. Rotate in a quiet window: tokens
signed with the old key that are still in flight (TTL ≤ 300 s) are refused
once the verifiers drop the old algorithm. Between steps 4 and 5 both
signatures verify, so the safe order is always verifiers-accept-both →
issuer-switches → verifiers-drop-old.

## Verifying a rotation

- `GET /.well-known/atf-transaction-jwks.json` on the Runtime lists the new
  key after step 4.
- One end-to-end call through the Gate and one through Search succeed after
  each step.
- The Gate and Search logs show no transaction verification failures and no
  shared-secret warnings once step 5 is complete.
