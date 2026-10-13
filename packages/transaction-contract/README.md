# Transaction Contract

A transaction records an authenticated principal action with correlation metadata. The envelope
adds the budget, delegation chain, and trace deadline that travel with a tool call so a
downstream service can enforce limits it did not set.

Package `1.1.0`, contract `1.0.0`, envelope protocol `v1`
(`TRANSACTION_ENVELOPE_PROTOCOL_VERSION`). `bun run verify:version` enforces that the package major.minor never falls below the wire
constant's major.minor.

| Export | Purpose |
| --- | --- |
| `TransactionV1Schema`, `TransactionV1` | The transaction record |
| `TransactionEnvelopeV1Schema`, `TransactionEnvelopeV1` | Producer-side envelope |
| `TransactionEnvelopeConsumerV1Schema`, `TransactionEnvelopeConsumerV1` | Consumer-side envelope |
| `TransactionBudgetSchema`, `DelegationHopSchema`, `TransactionTraceSchema` | Envelope components |

The producer and consumer envelope schemas are deliberately separate. A consumer tolerates
fields a producer does not emit, so validating outbound data against the consumer schema would
accept envelopes that are not actually valid to send. Parse with
`parseTransactionEnvelopeProducer` or `parseTransactionEnvelopeConsumer` from
[`@atf/contract-adapter`](../contract-adapter) to pick the right side explicitly.

Consumers must validate untrusted payloads with the exported Zod schema.
