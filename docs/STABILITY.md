<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Stability contract

What ATF promises not to break, from which version, and which features are
still allowed to change. It is the reference for deciding whether an upgrade
can break an integration: if a surface is listed as stable below, a breaking
change to it needs a new major version.

## Scope

From 1.0.0 the surfaces listed under [Stable surfaces](#stable-surfaces) follow
[semantic versioning](https://semver.org/spec/v2.0.0.html). A breaking change
to one of them ships only in a new major version, and only after at least one
minor release that announced it as a deprecation (see `docs/DEPRECATIONS.md`).
Additions that keep existing callers working are minor changes; fixes are patch
changes.

The contract packages under `packages/` keep their own versions and their own
compatibility rules; the product version does not replace them.

## Stable surfaces

| Surface | Reference | Notes |
| --- | --- | --- |
| Runtime HTTP API: the OpenAI-compatible endpoints, `/v1/*`, `/monitoring/*`, `/admin/*` | [openapi/runtime.json](openapi/runtime.json) | Paths, methods, request and response fields, status codes and error codes. Experimental routes are listed under [Experimental](#experimental). |
| Search HTTP API `/v2/*` and the MCP tool names with their parameters | [openapi/search.json](openapi/search.json), [../apps/search/README.md](../apps/search/README.md) | Experimental routes are listed under [Experimental](#experimental). |
| Extract HTTP API `/v2/*` and `@atf/extract-contract` | [openapi/extract.json](openapi/extract.json) | The contract package is versioned separately. |
| Gate MCP endpoints and the Gate configuration file | [openapi/gate.json](openapi/gate.json), [CONFIGURATION.md](CONFIGURATION.md#gate-configuration-file-yaml) | The generated YAML key reference in the configuration reference is the contract for the file. |
| Flow schema | [../apps/runtime/schemas/flow.schema.json](../apps/runtime/schemas/flow.schema.json), [FLOWS.md](FLOWS.md) | Fields, node types and their settings. A flow that validates today keeps validating. |
| Environment variables | [CONFIGURATION.md](CONFIGURATION.md) | Names, meaning and accepted values. Defaults may change in a minor release when the change is listed in the changelog with a migration note. |
| Helm values | [../deploy/helm/atf/values.schema.json](../deploy/helm/atf/values.schema.json) | Keys and their types. |
| Contract packages | [../ARCHITECTURE.md](../ARCHITECTURE.md#shared-packages) | Each package follows its own semantic version; the table lists the current versions. |
| Signature and receipt formats: Evidence Bundle, decision, erasure and release receipts, citation impact report | `atf-verify` (`scripts/atf-verify.ts`) | What `atf-verify` accepts as valid today stays valid. |
| Prometheus metric names and their labels | [METRICS-AND-RETENTION.md](METRICS-AND-RETENTION.md) | Names and label keys. Help texts and bucket boundaries are not covered. |
| Runtime CLI (`apps/runtime/scripts/cli.ts`: subcommands and options) and `atf-verify` | `apps/runtime/scripts/cli.ts`, `scripts/atf-verify.ts` | Exit codes are part of the contract. The `bench capture` subcommand is [experimental](#experimental). |

## Not covered

These can change in any release without a deprecation period:

- Debug-trace fields. They are additive, and no field is guaranteed to stay.
- The log format and the content of log messages.
- The Control UI: layout, routes, texts and translations.
- Internal TypeScript APIs of the applications, as opposed to the contract and
  shared packages.
- The order of fields in JSON documents.
- The evaluation scripts under `scripts/eval/` and test fixtures.

## Experimental

Experimental features may change in a minor release; each change is listed in the changelog with a migration note.

| Feature | Variable or field |
| --- | --- |
| Model cascade | `config.cascade` on an `llm` node |
| LLM query decomposition in answer-ready retrieval | `retrieve_for_answer` with `decomposition: "llm"` |
| Citation index and impact report | `CITATION_INDEX_ENABLED`, `GET /monitoring/citation-impact`, `POST /v2/citations/check` |
| Flow service objectives | the `slo` field of a flow |
| Bench cases from executions | `bun run scripts/cli.ts bench capture` |
| SharePoint source of the Outpost | source type `sharepoint` |
| Output format of `atf-doctor` | the table and the `--json` document |

A feature leaves this list when it has proven itself in use; it then becomes
stable in the minor release that announces it.

## Pre-1.0 versions

0.x versions are not covered by this contract. Between 0.x releases, anything
can change; the changelog and the [upgrade notes](UPGRADE.md) describe what to
do.
