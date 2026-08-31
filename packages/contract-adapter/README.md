# Contract Adapter

Explicit conversions between the shared contract packages, and one place to decide how strictly
a contract violation is treated.

Package `1.0.0`. Depends on `@atf/identity-contract`, `@atf/transaction-contract`,
`@atf/evidence-contract`, and `@atf/schema-compatibility`.

## Inspection instead of exceptions

`inspectContract` returns a result rather than throwing, and never exposes a validation-library
type at the boundary:

```ts
const inspection = inspectContract(IdentityPrincipalSchema, untrusted);
if (inspection.ok) use(inspection.value);
else report(inspection.findings);
```

`applyContractPolicy` then applies the deployment's chosen strictness — `report` (collect and
continue), `warn` (log and continue), or `enforce` (throw). Keeping the policy separate from the
parse means a service can roll out a tightened contract in `warn` before switching to `enforce`,
without two code paths.

## Principal adapters

| Export | Purpose |
| --- | --- |
| `adaptRuntimePrincipal` | Runtime's verified-token shape to `IdentityPrincipal` |
| `adaptGatePrincipal` | Gate's subject/scopes shape to `IdentityPrincipal` |

`adaptRuntimePrincipal` fails closed: it requires `verified === true` and a non-empty `sub`
claim, so an unverified token cannot become a principal by passing through the adapter.

## Envelope and evidence parsing

| Export | Purpose |
| --- | --- |
| `parseTransactionEnvelopeProducer` | Validates against the producer schema |
| `parseTransactionEnvelopeConsumer` | Validates against the consumer schema |
| `parseEvidenceActionContract` | Validates an evidence action contract |
| `assessSchemaEvolution` | Re-exports the tool-schema diff for contract migrations |

Both envelope parsers additionally require that `actionContractHash` and
`evidenceContractHash` are identical when both are present. They are aliases of the same digest,
and accepting a mismatch would let two services disagree about which contract was in force while
both believed they had verified it.

## Why this package exists

Runtime, Search, and Gate still carry protocol-specific transaction and evidence envelopes where
their wire protocols genuinely differ. Those local envelopes are **not** aliases of the shared
records. Converging them goes through an explicit adapter here; assuming the shapes are already
identical is the mistake this package exists to prevent. See the contract boundary note in
[ARCHITECTURE.md](../../ARCHITECTURE.md).
