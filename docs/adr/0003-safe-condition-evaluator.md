# 3. Safe condition evaluator instead of eval / new Function

Date: 2026-06-14

## Status

Accepted

## Context

Flow routing edges and dispatch/override/access rules branch on expressions like
`classLabel == 'INKASSO'` or `tier == 'gold'`. These expressions come from flow
JSON and policy files that operators (and potentially less-trusted authors) edit.
Evaluating them with `eval`/`new Function` would hand arbitrary JavaScript
execution and access to the host scope to anyone who can author a flow — a
remote code execution and state-exfiltration risk.

## Decision

`src/graph/condition-evaluator.ts` implements a small recursive-descent parser
and evaluator over a safe grammar: boolean/comparison/additive operators and
dot-path identifier resolution against a typed context object. Supported operand
types are number, string, boolean and null. There is no function call, property
assignment, prototype access, or global reference. Any parse/eval error
evaluates to `false` at runtime; a separate `validateConditionExpression`
parse-checks expressions at author time so a malformed rule is caught early
instead of silently routing to `false`.

## Consequences

- Flow authors cannot execute arbitrary code or read host state through routing
  expressions.
- The grammar is intentionally limited; new operators require extending the
  parser (and its tests) rather than reaching for `eval`.
- Attribute-based routing on JWT claims is only as trustworthy as the claims —
  which is why claim-based rules require cryptographic JWT verification (the
  production-readiness gate enforces this under `APP_ENV=production`).
