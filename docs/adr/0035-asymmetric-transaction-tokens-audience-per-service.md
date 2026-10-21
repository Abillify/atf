<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->
# 35. Asymmetric transaction tokens and one audience per service
Date: 2026-10-20
## Status
Accepted — extends [ADR-0030](0030-asymmetric-evidence-chain-ed25519.md) from the
evidence chain to the transaction envelope the runtime sends to every Gate and
to Search. Does not change the envelope itself.
## Context
Every tool call the runtime makes carries a short-lived transaction token (the
Agent Transaction Fabric envelope, `@atf/transaction-contract`): who acts, for
which execution and invocation, with which scopes and budget. It was signed
HS256 with one shared secret, and in the reference deployments every Gate and
the runtime used the same audience, `mcpgate`.
That has two consequences the project review called out:
- **Verifying equals minting.** Every party that holds the secret to *check* a
  token can also *create* one. A leak at any Gate, or a compromised Search,
  yields tokens every other service accepts.
- **A token is valid everywhere.** With one audience, a token minted for the
  ticketing Gate is accepted by the ERP Gate. The binding to tool and arguments
  limits the damage, but the audience exists precisely to stop this.
Most of the machinery was already there. The runtime can sign ES256/EdDSA
(`TRANSACTION_SIGNING_ALG`, `TRANSACTION_SIGNING_KEY`) and publishes the public
key at `/.well-known/atf-transaction-jwks.json`; it mints each token for a
per-server audience (`AGENT_TRANSACTION_AUDIENCES`, default: the server name);
the Gate verifies HS256, RS256, ES256 and EdDSA (`MCPGATE_TRANSACTION_JWKS_URI`,
`MCPGATE_TRANSACTION_ALGORITHMS`, `MCPGATE_TRANSACTION_AUDIENCE`). What was
missing: **Search could only verify HS256**, nothing steered a deployment away
from the shared secret or the shared audience, and there was no described path
to switch a running system over.
## Decision
1. **Search verifies asymmetric tokens.** New settings `TRANSACTION_JWKS_URI`
   (the issuer's public keys) and `TRANSACTION_ALGORITHMS` (a subset of `HS256`,
   `ES256`, `EdDSA`). Default: `HS256` when `TRANSACTION_HS256_SECRET` is set,
   plus `ES256` and `EdDSA` when a JWKS URI is set. The remote key set is
   fetched and cached by `jose`, and re-fetched when a token names an unknown
   `kid`.
2. **An allow-list, not negotiation.** The token's `alg` header only selects
   *which key source* checks it, and only if the algorithm is on the
   configured list. `none`, an unlisted algorithm and a symmetric/asymmetric
   mix-up are refused with `TRANSACTION_TOKEN_INVALID` before any key is
   touched. HS256 is checked only against the secret, the asymmetric algorithms
   only against the JWKS: there is no fallback from one to the other.
3. **The transition accepts both.** Verifiers can accept HS256 and EdDSA at the
   same time (Gate: set the secret and the JWKS URI; Search: the default above),
   so issuers switch one at a time instead of in a flag day. The order is in
   `docs/UPGRADE.md`: verifiers first (add the JWKS, keep the secret), then the
   runtime (`TRANSACTION_SIGNING_ALG=EdDSA`), then verifiers drop HS256
   (`*_ALGORITHMS=EdDSA` and the secret removed).
4. **One audience per service.** The runtime mints for the audience mapped to
   the target server; each Gate and Search accept only their own
   (`MCPGATE_TRANSACTION_AUDIENCE`, `TRANSACTION_AUDIENCE`). Nothing new is
   needed in the code for this; the production gates now say so. The Gate warns
   when the audience is the example value `mcpgate` that every reference
   deployment shared.
5. **The production gates push, they do not force.** Both Gate and Search warn
   (non-fatal) while HS256 is accepted, including during the transition, so the
   warning disappears exactly when the migration is finished. Search additionally
   makes an asymmetric configuration fatal in production without an `https`
   JWKS URL: the keys that vouch for tokens must not travel in clear text. HS256
   stays supported; a deployment that does not migrate keeps working.
6. **No contract change.** Algorithm and audience are properties of the
   signature and the JWT, not of the envelope schema. `@atf/transaction-contract`
   is unchanged.
## Consequences
- A compromised verifier can no longer mint tokens for others; it holds only
  public keys. Together with per-service audiences, a token stolen from one
  service is useless at the next.
- The runtime's JWKS endpoint publishes **only the active key** (as for the
  evidence chain, ADR-0030). After a key rotation, tokens signed with the old key
  that are still in flight (the TTL is at most 300 s) fail at the verifier with
  `TRANSACTION_TOKEN_INVALID`; the next call is signed with the new key. Rotate
  in a quiet window. A dual-key overlap is not implemented; neither is multi-key
  evidence signing, which was decided against for the same reason (it would
  have to be operated, tested and explained for little gain at this size).
- The runtime has to be reachable from every verifier at the JWKS URL (it is
  unauthenticated by design and exposes public material only). A verifier that
  cannot reach it keeps verifying with the cached set but refuses tokens with an
  unknown `kid`.
- HS256 remains a supported configuration, so the old threat does not vanish by
  itself: it is made visible (warnings in the Gate, Search and runtime
  production gates) and the path off it is documented and tested.
- Not covered here: the audit anchors and evidence bundles (ADR-0030), the
  erasure receipts, and the Search evidence pack, which is hashed rather than
  signed.
