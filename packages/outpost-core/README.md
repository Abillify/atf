<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# @atf/outpost-core

Locally-operated sync agent core: mirrors local folders, S3, Google Drive
and Dropbox into ATF Extract collections. Pure logic plus I/O adapters
behind interfaces, shared by the Docker runtime
([`@atf/outpost`](../../apps/outpost)) and the desktop sidecar
([`@atf/outpost-desktop`](../../apps/outpost-desktop)).

The package deliberately has **no process-management, no CLI and no UI**:
hosts compose it, so both runtimes execute the exact same sync logic and
one bug fix or safety rule lands everywhere at once.

## Layout

| Directory | Responsibility |
| --- | --- |
| `src/config/` | `outpost.yaml` load/save (secrets via `_FILE` env vars, redaction-aware) |
| `src/sources/` | source adapters: `local`, `s3`, `gdrive`, `dropbox`; `filter.ts` include/exclude rules; `path-guard.ts` keeps a local source inside its declared root |
| `src/sync/` | the sync engine: `planner`/`reducer` (desired-state diff), `executor`/`run` (drive Extract ingest), `delete-planner` (mirror-delete with large-set pause + confirm hash), `concurrency`, `counters` |
| `src/auth/` | Extract auth (API token, client credentials, OIDC device flow) and cloud token refresh |
| `src/credentials/` | credential store interface; `MemoryCredentialStore` for tests, host-provided stores (keychain bridge, `/data` files) in production |
| `src/state/` | persisted sync state (seen files, hashes, cursors) |
| `src/extract/` | Extract API client (ingest, delete, job status, `whoami`) |
| `src/http/`, `src/log/`, `src/schedule/` | fetch wrapper, secret-redacting logger, daemon scheduling |

Everything crosses a boundary through an interface: filesystem, network,
clock and credential store are injected, which is what lets the property
tests run the real planner/executor against fakes.

## Safety rails

- **Read-only cloud scopes**: Google Drive and Dropbox tokens request read
  access only.
- **Path guard**: a local source can never read outside its configured
  root (symlink and `..` traversal checked at the adapter boundary).
- **Delete mirroring**: with `mirrorDelete: true`, deletions propagate to
  the Extract collection only below a candidate threshold; larger sets
  pause until an operator confirms the exact candidate hash
  (`confirm-deletes`). A mass-delete caused by a mount glitch therefore
  stops instead of running.
- **Secret hygiene**: every secret supports a `_FILE` variant, file
  contents are registered with the redactor, and the logger scrubs
  registered secrets — tokens cannot leak through log output.

## Development

```sh
bun install
bun run test          # unit + property + integration (fakes, no network)
bun run typecheck
```

Tests live in `tests/unit`, `tests/properties` (fast-check properties over
the sync reducer, delete planner, config round-trip and credential
pickup) and `tests/integration` with `tests/fakes` providing deterministic
source/Extract doubles.
