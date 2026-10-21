# @atf/canonical-json

Package `1.0.1`. The one canonical-JSON implementation of the monorepo. Its bytes back
signed erasure receipts, the Runtime audit chain, evidence-bundle signatures,
action-contract hashes, tool-authz policy hashes and cache keys, so the byte semantics are
part of the contract: they must not change once a hash has been committed.

Before this package, five hand-rolled variants existed and their outputs were not
interchangeable. Each former variant maps onto exactly one named mode below, and
`test/differential.test.ts` proves byte identity against the original implementations on
edge inputs. Pick the mode the artefact you verify was produced with; do not "clean up"
into the default mode.

None of the modes is RFC 8785 (JCS); external verifiers must reproduce the mode used by the artefact.
The exact bytes of each mode are specified in [SPEC.md](SPEC.md), with machine-checked examples in
[test-vectors.json](test-vectors.json).

## Modes

Two families differ on object keys that look like array indices (`{"9": …, "10": …}`):

- **stringify family** canonicalises into an intermediate object and calls `JSON.stringify`.
  The engine lists integer-like keys first in ascending numeric order, so
  `{10:"x",9:"y","01":"z"}` becomes `{"9":"y","10":"x","01":"z"}`.
- **concat family** builds the text from the sorted key list, so the order is purely
  lexicographic: `{"01":"z","10":"x","9":"y"}`.

| Export | Family | Key order | `undefined` member | Number format | Used by |
| --- | --- | --- | --- | --- | --- |
| `canonicalJson` | stringify | UTF-16 code unit | dropped | `JSON.stringify` (non-finite → `null`) | erasure receipts, evidence bundles, audit chain, Gate cache keys, Search evidence-pack signature |
| `canonicalJsonValue` | stringify (structure form) | UTF-16 code unit | dropped | as above | audit chain (embedded in a fixed-key object) |
| `canonicalJsonConcat` | concat | UTF-16 code unit | dropped | as above | Extract pipeline and prompt hashes |
| `canonicalJsonNull` | concat | UTF-16 code unit | `null` | as above | Runtime tool-loop detection (ephemeral), Gate crypto helper |
| `canonicalJsonLocale` | concat | `localeCompare` | `null` | as above | evidence action contracts (`actionContractHash`; order frozen by issuance) |
| `canonicalJsonLocaleDrops` | stringify | `localeCompare` | dropped | as above | Runtime coverage-search keys, Gate transaction fabric |
| `canonicalSetJson` / `canonicalSetJsonValue` | stringify | UTF-16 code unit | dropped | `JSON.stringify` (non-finite → `null`) | Search evidence-pack hashes; additionally de-duplicates and sorts array elements |

`canonicalizeValue(value, { keyOrder, undefinedAs })` is the recursive core behind the
stringify modes. `keyOrder` is `"codeunit"` or `"locale"`; `undefinedAs` is `"drop"` or `"null"`.
The `"locale"` order differs from `"codeunit"` for keys that differ in case or accents, which
is why it survives as an explicit mode.

Input domain: JSON-safe values (the output of `JSON.parse`, or objects built from contract
schemas). Values with `toJSON()`, functions, symbols, `-0` or non-finite numbers are not part
of any hash-committed call site.

## Exports

| Export | Purpose |
| --- | --- |
| `canonicalJson` | Default mode; canonical bytes as a string |
| `canonicalJsonValue` | Structure form of `canonicalJson` |
| `canonicalJsonConcat` | Concat family, code-unit order, `undefined` dropped |
| `canonicalJsonNull` | Concat family, code-unit order, `undefined` as `null` |
| `canonicalJsonLocale` | Concat family, `localeCompare`, `undefined` as `null` |
| `canonicalJsonLocaleDrops` | Stringify family, `localeCompare`, `undefined` dropped |
| `canonicalSetJson`, `canonicalSetJsonValue` | Array elements de-duplicated and sorted (set normalisation) |
| `canonicalizeValue` | Recursive core with `CanonicalizeOptions` |
| `CanonicalKeyOrder`, `CanonicalUndefinedHandling`, `CanonicalizeOptions`, `CanonicalSetScalar` | Types |

## Usage

```ts
import { createHash } from "node:crypto";
import { canonicalJson } from "@atf/canonical-json";

const bytes = canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] });
// {"a":[2,{"c":3}],"b":1}
const digest = createHash("sha256").update(bytes).digest("hex");
```

## Compatibility

Imported by `apps/control`, `apps/extract`, `apps/gate`, `apps/runtime`, `apps/search`,
`@atf/erasure-contract` and `@atf/evidence-contract`.

## Tests

```bash
bun run --filter @atf/canonical-json test
```
