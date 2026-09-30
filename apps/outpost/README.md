# ATF Extract Outpost

`@atf/outpost` mirrors local folders, S3, Google Drive and Dropbox into ATF Extract. It runs as a non-root Docker container or as the sidecar of the desktop application.

## Docker

```sh
docker run --rm \
  -v "$PWD/outpost.yaml:/config/outpost.yaml:ro" \
  -v outpost-data:/data \
  -v "$PWD/source:/sources/source:ro" \
  ghcr.io/abillify/atf-outpost:latest daemon
```

The image stores sync state and file credentials below `/data`. The default health endpoint is `127.0.0.1:8787`; set `OUTPOST_HEALTH_BIND` only when an unauthenticated network health endpoint is intentional. A non-loopback bind is logged as a warning.

Useful commands:

```sh
docker exec -it outpost atf-outpost once
docker exec -it outpost atf-outpost source-login <sourceId>
docker exec -it outpost atf-outpost confirm-deletes <sourceId>
```

Exit codes are `0` for success, `1` for item/source failures or missing source authorization, `2` for Extract connection/authentication failures, `64` for command usage errors and `78` for invalid configuration.

## Configuration and secrets

The optional configuration file is `/config/outpost.yaml`. The data directory is `/data`; override it with `OUTPOST_DATA_DIR`. Every secret supports an adjacent `_FILE` environment variable. File contents are read once, registered with the secret redactor and never written to logs.

Extract authentication uses API token, client credentials or the configured OIDC device flow. Cloud sources use read-only Google Drive and Dropbox scopes. Required Extract permissions are `extract.ingest` and `extract.delete`; deployments without own-job read support may additionally require `extract.admin` as an explicit transition workaround.

For a Google Drive service account, set `auth: service-account`, share the folder with the service-account email and provide `OUTPOST_SOURCE_<ID>_GDRIVE_SA_KEY_FILE`. The Google client secret is supplied through `OUTPOST_GDRIVE_CLIENT_SECRET` or its `_FILE` variant.

For Dropbox Docker login, use the no-redirect code-paste flow. For Google Drive, copy the complete redirected URL from the browser address bar. A running daemon watches credential files and picks up a new token without a restart.

## Safe deletion

With `mirrorDelete: true`, the Outpost pauses a deletion when the candidate set is large. Confirm the exact candidate hash with:

```sh
atf-outpost confirm-deletes <sourceId>
```

A source with `needs-authorization` remains HTTP `200` on `/healthz` so an orchestrator does not restart a healthy container. `once` returns exit code `1` for that source state.

## Desktop sidecar

The Tauri host creates a fresh 32-byte IPC token, passes it on the sidecar's first stdin line and verifies the first stdout line:

```json
{"event":"ready","port":12345}
```

The host binds the keychain bridge to the sidecar's stdio protocol. Tokens are kept in the OS keychain service `me.abillify.atf-outpost`; they are not exposed to the WebView or written to disk.
