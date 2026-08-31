# Changelog

Notable changes to ATF are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Three things version independently of this file, because they are contracts rather than
releases:

- **Contract packages** under `packages/` carry their own versions. A breaking change to a
  cross-service message is a major bump there, and `integration/system` fails in CI when a
  change breaks the combined lifecycle.
- **Flows** declare `metadata.version` in their own YAML. That version appears as
  `flow_version` in the execution debug trace, which is how a deployed flow revision is
  verified after a rollout.
- **Node and tool schemas** are validated on load, so an incompatible flow fails at load
  time rather than mid-execution.

## [Unreleased]

Nothing yet.

## [0.1.0] — 2026-09-01

Initial public release of the Aiperator Trust Fabric monorepo: Runtime, Control, Search, and
Gate, with the versioned contract packages that connect them.

The four applications, their request path, and the design rules are described in
[ARCHITECTURE.md](ARCHITECTURE.md). The capability surface is enumerated in
[docs/CAPABILITIES.md](docs/CAPABILITIES.md), and every environment variable in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md). Architecture decisions carried over from the
predecessor repositories are in [docs/adr/](docs/adr/); a version statement inside a migrated
ADR describes that document's point in time, not this release.

### What `0.1.0` commits to

ATF is pre-1.0, and this release does not promise a stable public surface. Concretely:

- The **contract packages** under `packages/` are the surfaces that already carry a stability
  promise, because a break there breaks a running deployment across services. They version
  independently of this file.
- Environment variables, flow YAML fields, and HTTP routes **may change without a major bump**
  before 1.0. Breaking changes will be listed here with the migration.
- Two names are already deprecated aliases kept for compatibility and will be removed in a
  future major: the `X-Mandant-Id` request header (use `X-Tenant-Id`) and the implicit
  `clientClientdocs` default for `ragProfiles.authoritativeTagField` (declare the field
  explicitly).
- A small number of environment variables are read outside Runtime's startup schema and are
  marked **read directly — not validated at startup** in
  [docs/CONFIGURATION.md](docs/CONFIGURATION.md). Migrating them into the schema is tracked
  work, not settled design.

See [SECURITY.md](SECURITY.md) for which versions receive security fixes.

[Unreleased]: https://github.com/abillify/atf/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/abillify/atf/releases/tag/v0.1.0
