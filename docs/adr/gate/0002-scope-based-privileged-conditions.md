# ADR-0002: Scope-based privileged conditions

- **Status:** Accepted
- **Date:** 2026-08-12
- **Context repo:** mcpgate

## Context

`live/parking/conditions.yaml` and `live/worktime/conditions.yaml` currently
classify a caller as `privileged` through hard-coded `username` and
`claims.email` allowlists. Their database tools use this condition to select
privileged SQL branches, such as acting for another person, returning unmasked
booking data, or allowing administrative worktime changes.

mcpgate already builds one final `AuthContext.scopes` array for every accepted
caller:

- Static tokens contribute their configured `scopes`.
- OAuth tokens contribute the configured JWT `scopeClaim`.
- After JWT signature, issuer, audience, algorithm and expiry verification,
  configured `groupScopes` are added for values from the configured
  `groupClaim`.
- The result is deduplicated and used for global OAuth requirements and MCP
  tool-scope checks.

This final array is the single authorization input for scope-based privilege
conditions. It supports direct OAuth entitlements, trusted group mappings and
static development tokens without checking raw JWT claims or person-specific
email addresses.

Existing scalar operators remain intentionally scalar: `in`, `equals` and
`exists` operate on a context value converted to a scalar representation.
They cannot safely express membership in `AuthContext.scopes`; using
`context: scopes` with `in` would compare the entire array instead of one
scope and must not be used as a workaround.

## Decision

Condition rules support explicit array-membership operators:

- `containsAny`: true when the resolved context value is a string array that
  contains at least one requested value.
- `containsAll`: true when the resolved context value is a string array that
  contains every requested value.

Both operators are intended for a generic array-valued context path, with
`context: scopes` as the primary use case. They do not replace existing scalar
operators and can be combined with other operators in the same rule using the
existing AND semantics.

### Configuration

Only an optional live-condition migration would be needed to use scope-based
privileges. The current `privileged` label and all existing SQL templates remain
unchanged until an operator edits the corresponding conditions file:

```yaml
# Supported syntax. This is intentionally not enabled in the current live config.
# live/parking/conditions.yaml
privileged:
  all:
    - context: scopes
      containsAny: ["parking:manage", "parking:admin"]
```

```yaml
# Supported syntax. This is intentionally not enabled in the current live config.
# live/worktime/conditions.yaml
privileged:
  all:
    - context: scopes
      containsAny: ["worktime:manage", "worktime:admin"]
```

For cumulative rights, `containsAll` makes the requirement explicit:

```yaml
privileged:
  all:
    - context: scopes
      containsAll: ["worktime:read-sensitive", "worktime:manage"]
```

## Required semantics and safety properties

1. Evaluate only the final `AuthContext.scopes` array. Never inspect
   `claims.scope`, `groups`, a client argument, or an unverified JWT payload
   directly.
2. Reject empty `containsAny` and `containsAll` arrays in schema validation.
3. Fail closed (`false`) when the resolved context value is missing, not an
   array, or contains non-string values.
4. Preserve the scalar semantics of `in`, `equals` and `exists`; do not make
   them silently handle arrays.
5. Treat Conditions as SQL-branch/redaction guards only. They do not expose or
   hide tools and are not a replacement for a tool-level authorization policy.
6. Keep scope domains separate. `parking:manage` must not confer worktime
   privileges, and `worktime:manage` must not confer parking privileges.
7. `scopeCheck: false` remains independent: it disables required tool scopes,
   but a scope condition still protects privileged SQL branches.

## Optional live-configuration migration

1. Define and assign the domain scopes in the identity provider or
   `auth.oauth.groupScopes`; give equivalent scopes to static development
   tokens.
2. Verify the direct-scope, group-mapped-scope, static-token and malformed-value
   cases with the implemented unit and integration tests.
3. Add integration tests for representative privileged and non-privileged
   Parking and Worktime SQL branches.
4. When approved, atomically replace each live E-Mail allowlist with its
   domain-specific scope condition. Keep the `privileged` condition name so no
   SQL template requires rewriting.
5. Re-enable tool-level scope checks independently when operationally ready;
   this migration does not depend on that change.

## Alternatives considered

- **Use `context: scopes` with existing `in`:** rejected. It compares the
  complete array, is representation/order-dependent and does not express
  membership.
- **Continue hard-coded email allowlists:** rejected as the long-term model.
  It binds authorization to mutable personal attributes and duplicates identity
  management in configuration.
- **Use one shared `admin` scope:** rejected. Parking and Worktime administrative
  privileges are separate domains and need separate grants.
- **Make group membership a condition input:** rejected. Group-to-scope mapping
  already has one verified, auditable auth-layer path; conditions should consume
  its final entitlement result.
