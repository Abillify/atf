# Governance

How decisions get made in this repository, who makes them, and how that can change.

## Who decides

All review ownership in [`.github/CODEOWNERS`](.github/CODEOWNERS) points at the
`@abillify/maintainers` team — every pull request, and explicitly the legal documents
(license, copyright, trademarks, the contributor agreement), CI gates, and the
cross-service contract packages under [`packages/`](packages) and
[`integration/`](integration). The team currently consists of the author listed in
[AUTHORS.md](AUTHORS.md), employed by Abillify Technology GmbH, which is also the
publisher and the assignee of contributed copyright under
[CONTRIBUTOR_ASSIGNMENT_AGREEMENT.md](CONTRIBUTOR_ASSIGNMENT_AGREEMENT.md).

Practical consequences:

- No change merges without a maintainer review; GitHub rulesets enforce this.
- Changes that alter the project's legal position (the files listed above) need the
  maintainer's explicit sign-off, not just a passing CI.
- Releases follow the gated workflow documented in the repository's release process:
  version bump, changelog, redaction scan, the full gate suite, then a signed tag.
  TODO(human): whether release approval beyond the maintainer (e.g. a company
  officer) is formally required is not written down anywhere in this repository.

## How contracts and ADRs change

- **Stability contract.** [docs/STABILITY.md](docs/STABILITY.md) defines what semantic
  versioning covers from 1.0.0. Widening or narrowing that contract is a maintainer
  decision and lands with a changelog entry.
- **Cross-service contracts.** Anything under [`packages/`](packages) is consumed by
  several applications at once; the schema-compatibility package and the
  `test:contracts` suite fail CI on a break, so a contract change is only mergeable
  together with its migration.
- **Architecture decisions** are recorded in [`docs/adr/`](docs/adr/) (index with
  statuses: [`docs/adr/README.md`](docs/adr/README.md)). The working pattern so far:
  a significant design choice gets an ADR first, in status `Proposed`; discussion
  happens on the pull request; the maintainer accepts it by merging with status
  `Accepted`, or supersedes it with a later ADR. Code that depends on a rejected or
  still-proposed ADR does not merge.
- **Deprecations** follow [docs/DEPRECATIONS.md](docs/DEPRECATIONS.md): a deprecated
  option keeps working until its documented removal version.

## How to influence a decision

Open a [Discussion](https://github.com/abillify/atf/discussions) with the proposal, or
open a pull request with an ADR in status `Proposed` — the ADR template's trade-off
sections are the expected format for the argument. Maintainers respond in the open;
there is no separate RFC process.

## Becoming a maintainer

TODO(human): there is no written path to gaining commit or review rights outside
Abillify Technology GmbH. Until one exists, expect that contributions land through the
contributor agreement and maintainer review described in
[CONTRIBUTING.md](CONTRIBUTING.md), and that decision-making stays with the team
named in [AUTHORS.md](AUTHORS.md).

## Changes to this document

Governance changes are ordinary pull requests, reviewed by the maintainers team like
everything else in this file's scope.
