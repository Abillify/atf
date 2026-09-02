# Contributing

Contributions are welcome: bug reports, reproductions, documentation fixes, tests, and code.

ATF is source-available under the [Elastic License 2.0](LICENSE.md). Before contributing, each
individual or legal entity must separately execute the versioned
[ATF Contributor Copyright Assignment Agreement 1.0](CONTRIBUTOR_ASSIGNMENT_AGREEMENT.md).
Each commit carries a trailer documenting coverage by that existing Agreement; the trailer does
not execute the Agreement or replace any required legal form. The assignment enables Abillify
Technology GmbH to license accepted Contributions under Elastic-2.0 and other terms, including
commercial and dual- or multi-license terms. See [LICENSING.md](LICENSING.md).

## Before you start

For anything larger than a bug fix, open an issue or a discussion first. ATF has opinionated
boundaries — contract packages, service separation, fail-closed defaults — and a change that
cuts across them is much easier to agree on before it is written than after.

Security issues do **not** belong in a public issue. See [SECURITY.md](SECURITY.md).

## Toolchain

- Bun 1.3.14 (the only package manager and task runner; do not use npm, pnpm, or yarn)
- Node.js 26
- TypeScript 7.0.2 through the workspace dependency
- Docker with Compose v2 for the local stack

```bash
bun install --frozen-lockfile
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for the day-to-day workflow and per-workspace commands.

## Before you open a pull request

Run the same gates CI runs:

```bash
bun run verify:public           # no secrets or forbidden paths in the tree
bun run verify:spdx             # tracked TypeScript source carries the project SPDX header
bun run supply-chain:check      # third-party notices and SBOM are current
bun run config-reference:check  # docs/CONFIGURATION.md is regenerated
bun run lint:baseline           # Biome findings have not grown past the baseline
bun run typecheck
bun run test
bun run test:contracts
bun run build
```

CI additionally validates the example flows
(`cd apps/runtime && bun run scripts/cli.ts validate ../../deploy/examples/flows/`) and starts
the quickstart Compose stack to check the documented health endpoints.

The lint gate is a **regression** gate, not a zero-findings gate. The tree carries pre-existing
Biome findings recorded in `.biome-baseline.json`; the gate fails only when they grow. Reduce
them and tighten the baseline with `bun run lint:baseline -- --update`; never raise it.

If you changed dependencies or the lockfile, the committed root artifacts must be regenerated
natively on Linux x64 and committed with `bun.lock`. macOS contributors must not overwrite the
Linux reference with a relabeled host inventory; Linux CI performs the byte-for-byte reference
check and also publishes a separate native macOS artifact. The license gate requires complete
text for every dependency, including MIT/ISC/BSD/Apache packages. It accepts package files,
then exact-repository and exact-license monorepo text, then only package-scoped supplemental
rules documented in `licenses/README.md`. Do not add a broad exception. Strong-copyleft and
source-available-competitor licenses remain denied; raise a required exception for review.

New source files need an SPDX header. `bun run spdx` adds it.

## Commits

Conventional Commits, matching the existing history:

```text
feat(graph): add regex-based value extraction to transform nodes
fix(gate): preserve calendar semantics in the PostgreSQL DATE parser
docs(readme): document the quickstart port overrides
```

Every commit must carry the contributor-assignment acceptance trailer:

```text
ATF-Contributor-Assignment-Accepted: 1.0, Full Name <name@example.com>
```

Add it with:

```bash
git commit --trailer "ATF-Contributor-Assignment-Accepted: 1.0, Full Name <name@example.com>"
```

Use your real name and a reachable address. The trailer documents that you are covered by a
separately executed [ATF Contributor Copyright Assignment Agreement
1.0](CONTRIBUTOR_ASSIGNMENT_AGREEMENT.md); it does not execute the Agreement or replace a
signature or other legally required form. Execute either the Individual Agreement or, for
organizational contributions, a Corporate Agreement identifying the legal entity, authorized
representative, and covered contributor identities before contributing. Pull-request CI uses
`git interpret-trailers` to validate the exact versioned trailer on every commit introduced by
the PR; configure that Hygiene check as a required branch-protection status.

## Code expectations

- Keep changes focused. One concern per pull request.
- Add or update tests for changed behavior. Do not lower an existing assertion to make a test
  pass.
- Match the surrounding style rather than introducing a new one. Biome is configured; run it
  through your editor or `bunx biome check`.
- Preserve fail-closed defaults. If a code path can fail open, it needs an explicit,
  documented reason.
- Cross-service messages belong in a versioned contract package under `packages/` with Zod
  validation, exports, tests, and a compatibility test. A service-local wire envelope is
  acceptable only when the protocol genuinely differs; document that distinction so it is not
  mistaken for contract convergence.
- Do not add a network-exposed endpoint without authentication and authorization, or without
  stating explicitly why it is safe unauthenticated.

## Language

English for code, comments, documentation, commit messages, and issues. Some older inline
comments are still in German; translating one you are already touching is welcome, but a
translation-only pull request across many files is not, because it makes history harder to
read for little benefit.

## Test data

Use synthetic fixtures only, with reserved example domains (`example.com`, `example.test`,
`example.invalid`) and RFC 5737 documentation IP ranges. Never add real customer names,
personal data, credentials, real endpoints, production traces, or internal analyses. This is
enforced by `bun run verify:public`, but the check is a safety net, not a substitute for
judgment.

## Third-party and AI-generated material

Do not copy code, prompts, documentation, fixtures, or media into ATF unless its provenance and
license compatibility are documented in the pull request. Preserve all third-party copyright,
attribution, license, and other notices: the Contributor Agreement transfers only rights held by
the Contributor and does not change third-party terms.

Disclose material produced with generative-AI or other automated tools, including relevant tool
and output provenance. Review the applicable terms and output sufficiently to confirm that the
covered rights holder can submit it under the Contributor Agreement. A bot, service account, or
generated contribution must be tied to an individual or corporate rights holder whose separately
executed Agreement covers that contributor identity; a bot cannot accept the Agreement for
itself.

## Review

Maintainers review for correctness, security posture, contract boundaries, and test coverage.
Before merge, they also verify that every contributor identity is covered by a separately
executed Individual or Corporate Agreement 1.0 and that corporate authority and schedule details
are adequate.
Expect questions about failure modes. A pull request that changes defaults, adds a dependency,
or touches authentication, authorization, tenancy, or the compliance path will get a closer
look and may take longer.
