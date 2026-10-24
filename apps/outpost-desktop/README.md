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
│  src/main.tsx — sources, sync status, logs                               │
│  src/api-client.ts — fetch + Bearer to the sidecar's loopback control API│
└───────────────┬───────────────────────────────────────┬──────────────────┘
                │ Tauri IPC: `control_info`             │ HTTP, 127.0.0.1,
                │ (control URL + per-launch token)      │ Bearer control token
┌───────────────▼───────────────────────┐               │
│  src-tauri/ — Rust host: spawns and   │               │
│  supervises the sidecar, keychain     │               │
│  bridge, bundled binary at            │               │
│  binaries/atf-outpost (externalBin)   │               │
└───────────────┬───────────────────────┘               │
                │ stdio, token handshake (see below)    │
┌───────────────▼───────────────────────────────────────▼──────────────────┐
│  atf-outpost sidecar — @atf/outpost + @atf/outpost-core sync engine      │
└───────────────────────────────────────────────────────────────────────────┘
```
- The WebView asks the host for the sidecar's loopback URL and control
  token (`control_info`) and then calls the sidecar's control API itself
  with `fetch` and `Authorization: Bearer` (`src/api-client.ts`): status,
  sync, pause/resume, login and configuration. The sidecar's API is not
  reachable from the network. Cloud credentials (S3 secret, Google Drive
  service-account JSON) are typed into the WebView and sent write-only to the
  local sidecar; they are not read back. The Control API token is available to
  the WebView's JavaScript, so a script injected into the UI could drive the
  control API (start or pause syncs, change the configuration) — keep the
  UI free of third-party content, and see the CSP in `tauri.conf.json`.
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

## Release builds

Before a build that ships the updater, provision a real signing key:

1. Generate a minisign key pair:
   `bunx @tauri-apps/cli signer generate -p` (the password becomes the
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` build secret).
2. Put the printed **public key** into `plugins.updater.pubkey` in
   `src-tauri/tauri.conf.json` and set the update `endpoints` next to it.
3. Store the **private key** only as a CI secret
   (`TAURI_SIGNING_PRIVATE_KEY`) — never commit it or keep it on a
   developer machine beyond the signing step.
4. Check the configuration before building:
   `OUTPOST_DESKTOP_RELEASE=1 bun run check:desktop-updater` (from the
   repository root). With `OUTPOST_DESKTOP_RELEASE=1` the check fails while
   `pubkey` still starts with `REPLACE_WITH` or `endpoints` is empty;
   without the variable it only prints a hint.

## Security notes

- Windows installs run with `installMode: passive` — no elevation prompts
  beyond the installer's own.
- The sidecar inherits the outpost-core safety rails, including the
  delete-mirror pause with `confirm-deletes` for large candidate sets
  (see [`apps/outpost`](../outpost/README.md)).
- Source paths are guarded (`path-guard.ts` in outpost-core): a configured
  source can never escape its declared root.
