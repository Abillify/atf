<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# @atf/outpost-desktop

Desktop application for the ATF Extract Outpost: a Tauri (Rust) host with a
small TypeScript/React UI (`src/`, Vite) that controls the
[`@atf/outpost-core`](../../packages/outpost-core) sync agent running as a
local sidecar. It mirrors local folders, S3, Google Drive and Dropbox into
ATF Extract collections from a workstation — no cloud-side agent, no
browser extension.

## How it is put together

```
┌───────────────────────── Tauri window (WebView) ─────────────────────────┐
│  src/main.tsx — sources, sync status, logs (talks only to the host)      │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ Tauri IPC (src/api-client.ts)
┌──────────────────────────────▼───────────────────────────────────────────┐
│  src-tauri/ — Rust host: spawns and supervises the sidecar, keychain     │
│  bridge, bundled binary at binaries/atf-outpost (bundle.externalBin)     │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ stdio, token handshake (see below)
┌──────────────────────────────▼───────────────────────────────────────────┐
│  atf-outpost sidecar — @atf/outpost + @atf/outpost-core sync engine      │
└───────────────────────────────────────────────────────────────────────────┘
```

- The WebView never sees the sync agent's credentials and never talks to
  the network on its own; all I/O goes through the Rust host and the
  sidecar.
- The host spawns the sidecar with a fresh 32-byte IPC token on its first
  stdin line and verifies the sidecar's `{"event":"ready","port":…}`
  stdout line before using it. The sidecar's control API binds to
  loopback only.
- Tokens (Extract + cloud sources) live in the OS keychain under the
  service `me.abillify.atf-outpost`, bridged to the sidecar over stdio —
  they are not written to disk and not exposed to the WebView.

## Development

```sh
bun install
bun run dev        # Vite UI only (no sidecar)
bun run tauri dev  # full app: Rust host + sidecar + UI
bun run build      # tsc --noEmit && vite build
bun run test:a11y  # Playwright accessibility suite
```

Building the Tauri app needs the Rust toolchain; `src-tauri/deny.toml`
governs the Rust dependency policy and `entitlements.plist` the macOS
hardened-runtime entitlements.

## Updates

The Tauri updater is **disabled** in `src-tauri/tauri.conf.json`
(`createUpdaterArtifacts: false`, empty endpoint list, placeholder signing
public key). Until a release signing key is provisioned and the minisign
public key is committed, the app does not self-update; distribution and
updates happen through the deployment channel. The threat-model entry for
the updater (`docs/THREAT-MODEL.md`) describes what changes once it is
enabled.

## Security notes

- Windows installs run with `installMode: passive` — no elevation prompts
  beyond the installer's own.
- The sidecar inherits the outpost-core safety rails, including the
  delete-mirror pause with `confirm-deletes` for large candidate sets
  (see [`apps/outpost`](../outpost/README.md)).
- Source paths are guarded (`path-guard.ts` in outpost-core): a configured
  source can never escape its declared root.
