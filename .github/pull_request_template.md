## What and why

<!-- What changes, and what problem it solves. Link the issue if there is one. -->

Closes #

## How

<!-- The approach, and any alternative you rejected and why. Skip for a one-line fix. -->

## Verification

<!-- What you actually ran, not what you assume passes. -->

- [ ] `bun run typecheck`
- [ ] `bun run test`
- [ ] `bun run build`
- [ ] `bun run verify:public`
- [ ] `bun run verify:spdx`
- [ ] `bun run supply-chain:check` (required if dependencies changed)

Tests added or updated:

<!-- Which ones, and what behaviour they pin down. If none, say why. -->

## Risk

- [ ] Changes a default, or changes behaviour for an existing deployment
- [ ] Touches authentication, authorization, or tenant isolation
- [ ] Touches guardrails, approvals, the PII vault, or the compliance path
- [ ] Adds, removes, or upgrades a dependency
- [ ] Changes a contract package or a cross-service message shape
- [ ] Adds or changes a network-exposed endpoint
- [ ] None of the above

<!-- If you checked anything other than "None", explain the migration or rollback path. -->

## Checklist

- [ ] Commits are signed off (`git commit -s`) — see [DCO](../DCO)
- [ ] Conventional Commit messages
- [ ] New source files carry an SPDX header (`bun run spdx`)
- [ ] Documentation updated where behaviour or configuration changed
- [ ] Test data is synthetic; no customer names, personal data, real endpoints, or credentials
- [ ] Fail-closed defaults preserved, or the deviation is justified above
