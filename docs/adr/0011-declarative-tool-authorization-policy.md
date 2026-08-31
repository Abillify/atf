# 11. Declarative, hot-reloadable tool-authorization policy

Date: 2026-07-13

## Status

Accepted

## Context

aiperator already had a human-in-the-loop approval gate (pauses a run, waits
for a reviewer) and, as of ADR-0009, declarative `approvalRules` in
`compliance-policy.yaml` that route specific tool patterns to that gate. Both
are asynchronous by design — they exist to insert a human, and both accept
the latency of doing so.

There was no *synchronous*, machine-level access-control layer: "operator role
X may never call `billing/refund` for more than €100" or "`db/delete_record`
requires an admin token" are authorization decisions a request should never
need a human to adjudicate, and hard-coding them (`if role === "operator" &&
tool === "billing/refund" && amount > 100`) would scatter tenant- and
role-specific business rules through `src/graph/handlers/tool.ts` and require
a code deploy for every policy change an operator wants to make.

## Decision

`src/graph/tool-authz.ts` implements a declarative rule engine, loaded from
`tool-authz.json` in the flows directory (see `flows/tool-authz.example.json`)
and evaluated synchronously, in-process, before a tool call reaches the MCP
wrapper — no pause, no human, no network call.

### Policy shape and evaluation order

```json
{
  "rules": [
    { "id": "...", "tool": "billing/refund",
      "match": { "role": "operator" },
      "constraints": { "amount": { "max": 100 } },
      "action": "deny" }
  ],
  "defaultAction": "allow"
}
```

`ToolAuthzEngineImpl.evaluate(toolId, args, ctx)` walks `policy.rules` in
order; the **first** rule whose `tool` glob matches (`toolMatches()` — exact id
or `server/*` prefix), whose `match` fields all equal the request context
(`contextMatches()` — tenantId/role/userId/clientId), and whose
`constraints` are violated (`constraintsViolated()`) wins. `constraintMode`
controls whether *all* listed constraints must be breached (`"all"`, default —
AND) or *any one* (`"any"` — OR); a constraint on an argument absent from the
call is treated as a pass, not a violation, so a rule targeting `amount` does
not block a call that never carries an `amount` argument. No matching rule
falls through to `defaultAction` (default `"allow"`).

### Fail-closed on a broken policy, opt-in

`createToolAuthzEngine()` / `createToolAuthzEngineFromJson()` return one of
three engine implementations:

- `ToolAuthzEngineImpl` — the real rule evaluator, when the file parses and
  validates against `ToolAuthzPolicySchema` (Zod).
- `NoopToolAuthzEngine` — permissive allow-all, used when no file is present
  (backward compatible with every deployment that predates this feature) or
  when parsing fails and `opts.failClosed !== true`.
- `DenyAllToolAuthzEngine` — denies every call, used when parsing fails and
  `opts.failClosed === true`. It still reports `active: true` from
  `describe()` so the dispatch site (`exec-runtime.ts`'s `runtime.toolAuthzEngine?.active`
  check, consumed in `graph/handlers/tool.ts`) actually consults it rather
  than skipping evaluation because the engine looks inactive.

`ToolAuthzLoader` (`src/graph/tool-authz-loader.ts`) additionally tracks
`_hasValidPolicy` — once a syntactically valid policy has loaded at least
once, a *subsequent* malformed edit keeps the last-known-good policy live
(fail-open on the reload, not fail-closed) rather than tearing down a working
policy over a save-in-progress or a typo; only the *first-ever* load failure
with `failClosed: true` installs the deny-all engine. `save()` writes via a
temp-file-then-`rename` (atomic) so a crash mid-write cannot leave a truncated
`tool-authz.json` that would disable every rule.

### Distinct from, and orthogonal to, `compliance-policy.yaml`'s approval rules

Tool authz and the compliance policy's `approvalRules` (ADR-0009) sit at
different points in the same request:

|                     | Tool authz                          | Compliance `approvalRules`         |
|---------------------|--------------------------------------|-------------------------------------|
| Decision            | allow / deny (synchronous)          | require-approval (asynchronous)     |
| Human involved      | never                                | always, when triggered              |
| File                | `tool-authz.json` (flows dir)       | `compliance-policy.yaml` (flows dir)|
| Purpose             | hard machine-level access control    | risk-based human oversight          |

A deployment can run either, both, or neither; they do not share an evaluator
or a schema, deliberately — conflating "deny" and "pause for a human" into one
rule shape would force every rule author to reason about both semantics at
once.

### Operator surface

`GET /security/tool-authz` (read, `monitoring:read`) and `PUT
/security/tool-authz` (write, `flows:write`) in `src/routes/red-team.ts` let
the dashboard show and edit the active policy without shell access to the
flows directory — `PUT` validates via the same `ToolAuthzPolicySchema` before
writing, so the API path and the file-hot-reload path share one source of
truth for what a valid policy looks like.

The loader documents (in its own header) that `tool-authz.json` lives in the
operator-controlled `flows` directory, not `PLUGINS_DIR` — it is trusted at
the same level as flow definitions, so it deliberately gets no additional
allowlist/signature verification beyond what the flows directory as a whole
already has (see ADR-0006 for the separate, stricter trust boundary that
*does* apply to `PLUGINS_DIR`).

## Consequences

- Tenant/role-specific tool access rules are now data, editable by an
  operator without a deploy, hot-reloaded on file change like every other
  policy file in `FLOWS_DIR`.
- The fail-closed opt-in (`failClosed: true`) is off by default — a
  deployment that has never configured tool authz keeps today's behaviour
  (all tools allowed) rather than a new file-not-found path suddenly denying
  everything. A deployment that wants tool authz to be a hard security
  boundary must opt into `failClosed` explicitly.
- Constraint matching only understands numeric `min`/`max` and
  `allowedValues` equality (via `JSON.stringify` comparison) — there is no
  regex, range-over-strings, or cross-argument constraint. Rules requiring
  richer logic must currently be expressed as multiple narrower rules.
- Because evaluation is a synchronous, in-process, ordered rule scan with no
  I/O, it adds negligible latency to a tool call and needs no separate
  infrastructure — unlike the compliance policy's `approvalRules`, which
  depend on the existing (possibly distributed/Redis-backed) approval gate.
