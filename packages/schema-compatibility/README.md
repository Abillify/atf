# Schema Compatibility

Deterministic classification of a tool-schema change. Given the previous and next JSON Schema
for a tool, `diffToolSchemas` sorts every difference into `breaking`, `nonBreaking`, or
`unknown`.

Package `1.0.0`. No runtime dependencies.

```ts
import { diffToolSchemas } from "@atf/schema-compatibility";

const diff = diffToolSchemas(
  { inputSchema: previous },
  { inputSchema: next, outputSchema: nextOutput },
);
if (diff.breaking.length > 0) throw new Error("Tool contract regressed");
```

Each finding carries a `direction` (`input` or `output`), a JSON path, a stable `code`, and a
message.

## Why three buckets and not two

Direction matters, and the two directions invert. Tightening an *input* constraint is breaking
because an existing caller may now be rejected; tightening an *output* constraint is not,
because the consumer already tolerated a wider range. The classifier applies that asymmetry
rather than treating "more restrictive" as uniformly bad.

`unknown` is the third bucket because a wrong answer here is worse than no answer. JSON Schema
keywords that make compatibility undecidable by structural comparison — `$ref`, `allOf`, `not`,
`if`/`then`/`else`, `patternProperties`, `contains`, `propertyNames`, and the rest of
`UNSUPPORTED_KEYWORDS` — are reported as `unknown` instead of being guessed at. A caller that
wants to fail closed treats a non-empty `unknown` as breaking; one that wants to warn can
surface it for a human. Silently classifying these as `nonBreaking` would let a real break
through a green check, which is the failure this package exists to prevent.

Comparison is purely structural and does not mutate either input. Values are compared through a
canonical serialisation with sorted keys, so key order never registers as a difference.
