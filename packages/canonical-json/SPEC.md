# Canonical JSON byte specification

This is the exact byte contract of every mode of `@atf/canonical-json`. The bytes back signed
erasure receipts, the audit chain, evidence-bundle signatures, `actionContractHash` values, cache
keys and snapshot hashes, so a mode never changes once a hash has been committed with it. A new
need gets a new mode.

None of the modes is RFC 8785 (JCS); external verifiers must reproduce the mode used by the artefact.

Machine-checked examples are in [`test-vectors.json`](test-vectors.json); `test/vectors.test.ts`
runs every vector against every mode, and `test/differential.test.ts` proves byte identity with the
legacy implementations each mode replaced.

## Shared rules

- **Input domain.** JSON-safe values: the output of `JSON.parse`, or objects built from contract
  schemas. `toJSON()`, functions, symbols, `-0` and non-finite numbers are not part of any
  hash-committed call site.
- **No insignificant whitespace.** Separators are `,` and `:` only.
- **Strings and escapes.** Every string, object keys included, is written by `JSON.stringify`: `"`
  and `\` are escaped, control characters below U+0020 become `\b \f \n \r \t` or `\u00XX`
  (lowercase hex), U+007F and non-ASCII characters are written as they are (UTF-8), and lone
  surrogates become lowercase `\ud800`-style escapes. No Unicode normalization is applied.
- **Numbers.** Written by `JSON.stringify` (ECMAScript `Number::toString`): `1e+21`, `1e-7`, `-1.5`;
  there is no trailing `.0` and no fixed notation for large or small magnitudes. `NaN`, `Infinity`
  and `-Infinity` become `null`.
- **Booleans and `null`** are `true`, `false`, `null`.
- **Arrays** keep their order, except in the set mode. An `undefined` array item becomes `null`.
- **Output is UTF-8 text.** Hashes are computed over those UTF-8 bytes.

## Object keys

Modes differ in three things only: how keys are ordered, what happens to a member whose value is
`undefined`, and the serializer family.

### Key order

- **Code-unit order** (`Array#sort()` default): keys compare by UTF-16 code units. For ASCII keys
  this equals byte order, so `"B"` sorts before `"a"`. Code points above U+FFFF compare by their
  surrogate pair, which differs from UTF-8 byte order for some keys (the emoji case); verifiers
  that do not use JavaScript must emulate UTF-16 ordering.
- **Locale order** (`String#localeCompare` with the runtime's default locale): `"a"` sorts before
  `"A"` before `"b"`, and `"é"` sorts between `"e"` and `"f"`. This depends on the ICU collation
  data of the runtime. It is acceptable only for the frozen call sites that use it, whose keys are
  schema-controlled ASCII; do not use it for new data.

### Integer-like keys

- **Stringify family** builds an intermediate object and calls `JSON.stringify`. The engine lists
  keys that are canonical array indices (`"0"`, `"9"`, `"10"`, not `"01"`) first, in ascending numeric
  order, then the remaining keys in insertion order, which is the sorted order. `{10, 9, "01"}` is
  written `{"9":…,"10":…,"01":…}` in any key order.
- **Concat family** builds the text from the sorted key list, so the order is purely lexicographic:
  `{"01":…,"10":…,"9":…}`.

### Members whose value is `undefined`

Dropped, or written as `null`, depending on the mode.

## Modes

| Export | Family | Key order | `undefined` member | Notes |
| --- | --- | --- | --- | --- |
| `canonicalJson` | stringify | code unit | dropped | Default. Signed erasure receipts, evidence bundles, audit chain, Gate cache keys |
| `canonicalJsonValue` | stringify (structure) | code unit | dropped | The structure `canonicalJson` serializes; `JSON.stringify` of it equals `canonicalJson` |
| `canonicalJsonConcat` | concat | code unit | dropped | Extract pipeline and prompt hashes (resume keys) |
| `canonicalJsonNull` | concat | code unit | `null` | Runtime tool-loop detection (ephemeral), Gate crypto helper |
| `canonicalJsonLocale` | concat | locale | `null` | `actionContractHash` of evidence action contracts; analysis-artifact content hashes |
| `canonicalJsonLocaleDrops` | stringify | locale | dropped | Runtime coverage-search keys |
| `canonicalSetJson`, `canonicalSetJsonValue` | stringify | code unit | dropped | Arrays are sets, see below |

A top-level `undefined` is written `null` by every mode. (The legacy stringify-based functions
returned the value `undefined` there; no committed hash can contain it.)

### Set mode

`canonicalSetJson` treats every array as a set: each element is canonicalized, then elements are
de-duplicated by their serialized form and sorted by that serialized string (UTF-16 order). Nested
arrays are normalized the same way, so `[[2,1],[1,2],[2,1]]` is `[[1,2]]`. An `undefined` or
non-finite element becomes `null` before de-duplication. Used for Search evidence-pack hashes, where
the evidence arrays must hash the same whatever the retrieval order. Never use it for data whose
array order carries meaning.

## Deviations outside this package

- `@atf/schema-compatibility` keeps its own `stableValue`. It is a concat-family, code-unit-order
  serializer like `canonicalJsonNull`, but it writes an `undefined` member or item as the text
  `undefined` instead of `null`, so it is not byte-identical and is not replaced. Its output is
  only compared in memory (schema constraint equality) and never hashed or stored.

## Changing a mode

Do not. A change of bytes silently invalidates every hash already committed with the mode. Add a
new named mode instead, add vectors to `test-vectors.json`, and add a differential test if it
replaces a legacy implementation.
