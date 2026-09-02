# Documentation

## Start here

| Document | Read it when |
| --- | --- |
| [../README.md](../README.md) | You want to know what ATF is and get it running |
| [../ARCHITECTURE.md](../ARCHITECTURE.md) | You need the applications, contracts, and request path |
| [CAPABILITIES.md](CAPABILITIES.md) | You want to know whether ATF does a specific thing |
| [CONFIGURATION.md](CONFIGURATION.md) | You are configuring a deployment. Generated from the schemas |
| [../DEVELOPMENT.md](../DEVELOPMENT.md) | You are about to change code |
| [../DEPLOYMENT.md](../DEPLOYMENT.md) | You are deploying to production |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | You are opening a pull request |
| [../SECURITY.md](../SECURITY.md) | You found a vulnerability |
| [../LICENSING.md](../LICENSING.md) | You need to know what you may do with ATF |

## Per application

| Application | README |
| --- | --- |
| Runtime | [../apps/runtime/README.md](../apps/runtime/README.md) |
| Control | [../apps/control/README.md](../apps/control/README.md) |
| Search | [../apps/search/README.md](../apps/search/README.md) |
| Gate | [../apps/gate/README.md](../apps/gate/README.md) |

Contract packages: [identity](../packages/identity-contract/README.md),
[transaction](../packages/transaction-contract/README.md),
[evidence](../packages/evidence-contract/README.md),
[schema compatibility](../packages/schema-compatibility/README.md), and
[contract adapter](../packages/contract-adapter/README.md).

## Reference

| Document | Contents |
| --- | --- |
| [CAPABILITIES.md](CAPABILITIES.md) | Every capability and the settings that govern it |
| [CONFIGURATION.md](CONFIGURATION.md) | All environment variables per service. **Generated** — run `bun run config-reference` |
| [UI-STYLE-GUIDE.md](UI-STYLE-GUIDE.md) | Control UI conventions and accessibility expectations |
| [operations-and-retrieval.md](operations-and-retrieval.md) | Search operational behavior and retrieval tuning |
| [router-result-interpretation.md](router-result-interpretation.md) | Configuring Gate's optional second-pass result interpretation |
| [MCP-2026-CONTEXT-LAYER.md](MCP-2026-CONTEXT-LAYER.md) | MCP context-layer design |
| [../deploy/examples/flows/README.md](../deploy/examples/flows/README.md) | Example flows, ordered by what they add |
| [../licenses/README.md](../licenses/README.md) | Why some third-party license texts are vendored here |

## Architecture decisions

[`adr/`](adr/) holds 27 records. They document the reasoning and the trade-offs, which is
usually more useful than the current code when you are deciding whether to change something.

- [`adr/`](adr/) — Runtime, Control, and platform decisions (0001–0023)
- [`adr/search/`](adr/search/) — Search decisions
- [`adr/gate/`](adr/gate/) — Gate decisions

Numbering is per directory, carried over from the predecessor repositories, so an identifier can
repeat across subdirectories. Cite them as `adr/0009`, `adr/search/0001`, `adr/gate/0002`.

Frequently referenced:

| ADR | Subject |
| --- | --- |
| [0002](adr/0002-optional-dependencies-graceful-degradation.md) | Why every optional dependency has a defined fallback, and what each costs |
| [0005](adr/0005-tenant-data-isolation.md) | Tenant isolation and row-level security |
| [0007](adr/0007-reversible-pii-vault-decorator.md) | The reversible PII vault |
| [0008](adr/0008-autopilot-governance-human-approval-and-drift-guard.md) | Approval gating and the drift guard |
| [0009](adr/0009-compliance-policy-as-code-and-evidentiary-dossier.md) | Policy as code and the compliance dossier |
| [0011](adr/0011-declarative-tool-authorization-policy.md) | Declarative, fail-closed tool authorization |
| [0020](adr/0020-verifiable-evidence-bundle.md) | Verifiable evidence bundles |
| [search/0001](adr/search/0001-verified-identity-is-authoritative.md) | Why the verified identity is never taken from a request field |
| [gate/0001](adr/gate/0001-production-readiness-gate-and-hardened-defaults.md) | Hardened defaults and the readiness gate |

## Historical documents

ADRs and the Gate changelogs were migrated from predecessor repositories. Their decisions and
reasoning still hold, but a version statement inside one describes that document's point in
time unless it is marked current.

Repository paths inside migrated documents predate the monorepo layout:

| Historical path | Current path |
| --- | --- |
| `aiperator/src/` | `apps/runtime/src/` |
| `aiperator/frontend/` or `frontend/` | `apps/control/` |
| `vectorsearch/src/` | `apps/search/src/` |
| `mcpgate/src/` | `apps/gate/src/` |

Historical Gate change record: [CHANGELOG-gate.md](CHANGELOG-gate.md). Current router
result-interpretation configuration is in
[router-result-interpretation.md](router-result-interpretation.md).

## Generated documents

Two documents are generated and must not be edited by hand. CI fails when they are stale.

| Document | Generator | Source |
| --- | --- | --- |
| [CONFIGURATION.md](CONFIGURATION.md) | `bun run config-reference` | Runtime's Zod env schema, Search's `Config` interface, and a scan of every service's source for raw environment reads |
| [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and [../sbom.cdx.json](../sbom.cdx.json) | `bun run supply-chain` | The installed dependency tree |

## A note on missing paths

Environment-specific and customer-related operations documents are deliberately not in this
repository. A relative link here that does not resolve is documentation drift — please report it
as a bug rather than assuming there is an unpublished artifact behind it.
