# Identity Contract

The shared minimal representation of an authenticated actor. Runtime and Gate each verify their
own tokens, then reduce the result to this shape so a principal can cross a service boundary
without either side depending on the other's auth stack.

Package `1.1.0`, contract `1.0.0`. The two version independently: the package version moves when
exports are added, `IDENTITY_PRINCIPAL_CONTRACT_VERSION` moves only when the wire shape changes.

| Export | Purpose |
| --- | --- |
| `IdentityPrincipalSchema`, `IdentityPrincipal` | The canonical principal |
| `RuntimePrincipalInputSchema`, `RuntimePrincipalInput` | Runtime's pre-normalisation shape |
| `GatePrincipalInputSchema`, `GatePrincipalInput` | Gate's pre-normalisation shape |
| `IDENTITY_PRINCIPAL_CONTRACT_VERSION` | Wire-shape version |

Validate untrusted payloads with the exported Zod schema. Convert between the input shapes and
the canonical principal with `adaptRuntimePrincipal` / `adaptGatePrincipal` from
[`@atf/contract-adapter`](../contract-adapter) rather than assuming the shapes are already
identical.
