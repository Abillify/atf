# Evidence Contract

Evidence records the observed, allowed, or denied outcome of a transaction, and requires a
digest. It is what lets a compliance dossier cite an action rather than assert one.

Package `1.1.0`, contract `1.0.0`. `EVIDENCE_ACTION_CONTRACT_VERSION` tracks the wire shape; the
package version moves when exports are added.

| Export | Purpose |
| --- | --- |
| `EvidenceActionSchema`, `EvidenceAction` | The evidence record |
| `EvidenceActionContractV1Schema`, `EvidenceActionContractV1` | The action contract carried alongside it |
| `inspectEvidenceActionContract` | Reads the contract and its hashes out of metadata |
| `canonicalJson`, `sha256Hex` | Deterministic serialisation and digest, so two services hash identically |
| `EVIDENCE_*_META_KEY` | Metadata keys under which contracts and hashes travel |

`canonicalJson` sorts object keys before serialising. Use it rather than `JSON.stringify` for
anything that will be hashed and compared across services — key order would otherwise change
the digest and break verification for no semantic reason.

Validate untrusted payloads with the exported Zod schemas.
