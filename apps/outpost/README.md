# ATF Extract Outpost

`@atf/outpost` mirrors local folders, S3, Google Drive, Dropbox and SharePoint Online / OneDrive for Business into ATF Extract. It runs as a non-root Docker container or as the sidecar of the desktop application.

## Docker

```sh
docker run --rm \
  -v "$PWD/outpost.yaml:/config/outpost.yaml:ro" \
  -v outpost-data:/data \
  -v "$PWD/source:/sources/source:ro" \
  ghcr.io/abillify/atf-outpost:outpost-v<version> daemon
```

The image is published by `.github/workflows/outpost-release.yml` only when an `outpost-v*` tag is pushed (tagged with that tag name, and `latest`); a product release (`vX.Y.Z`) does not publish it. Check the repository's tags for the newest `outpost-v*` before you pin a version — if none exists yet, build the image yourself from the repository root: `docker build -f apps/outpost/Dockerfile -t atf-outpost .`, then use `atf-outpost` instead of the GHCR name.

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

## Access control

A source can carry a static access control list that the Outpost sends to Extract on every ingest, so documents become visible only to the listed accounts and groups:

```yaml
sources:
  - type: local
    id: hr
    path: /sources/hr
    acl:
      users:
        - alice@example.com
      groups:
        - hr-staff
        - management
```

An adapter may also supply a per-document ACL (for example, a cloud drive that exposes sharing information); that per-document list wins over the source's `acl`. Sources without any ACL are ingested without access headers and keep Extract's default visibility.

Extract applies the access list as requested only when the Outpost token carries the scope `extract.acl.assign`; without it, Extract intersects the list with the identity of the token, which for a service token is empty, and the document becomes visible tenant-wide. The Outpost therefore checks the `X-ACL-Applied` response header of every item that has an access list: unless it says `assigned` (a missing header from an older Extract counts as not applied), the item fails with `Extract did not apply the requested access list`, the document is deleted again (this needs the scope `extract.delete`; if the delete fails, the error says so), and the next run retries the item. Grant the scope to the token, then re-sync the affected sources. Items without any access list are not affected.

When the effective ACL of a document changes — the source list is edited or a per-document list differs — the Outpost re-uploads the document so Extract applies the new access list. Content that did not change is otherwise skipped. Sync states written before this feature carry no ACL digest and are treated as "unknown": they do not trigger a mass re-upload, and the digest is recorded with the next real update.

## SharePoint and OneDrive

The `sharepoint` source mirrors a SharePoint Online document library or a OneDrive for Business account through Microsoft Graph. Authentication is OAuth2 client credentials against `https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/token` with the scope `https://graph.microsoft.com/.default`; the app secret (or certificate) is read from a file only and never appears in the configuration itself.

```yaml
sources:
  - type: sharepoint
    id: team-docs
    tenantId: 11111111-2222-3333-4444-555555555555
    clientId: 66666666-7777-8888-9999-aaaaaaaaaaaa
    clientSecretFile: /run/secrets/sharepoint-secret # or certificateFile: /run/secrets/sharepoint-cert.pem
    siteUrl: https://contoso.sharepoint.com/sites/team
    library: Shared Documents
    # Alternatively address the drive directly:
    # driveId: b!xxxxxxxxxxxxxxxxxxxx
    aclFromPermissions: true
    aclGroupMap:
      graph-group-object-id: team-a
```

The library is addressed either by `driveId` or by `siteUrl` plus `library` (the drive whose `name` matches). Listing uses the Graph delta endpoint: the first run performs a full scan, every later run reuses the stored delta link, and items reported as deleted are removed from the mirror by the normal deletion rules.

Required Graph **application** permissions: `Sites.Selected` (recommended — grant the app read access to exactly the sites it mirrors, which an administrator does per site) or, as a broader alternative, `Files.Read.All`. When `aclFromPermissions: true` reads item permissions, the app additionally needs `Sites.Read.All` (or `Sites.Selected` with the read right granted on the site).

With `aclFromPermissions: true`, each item's permissions become its access list: users are taken from `grantedToV2.user.email` (falling back to `userPrincipalName`, lowercased) and groups from `grantedToV2.group.id`, mapped through `aclGroupMap` — group ids without a mapping entry are kept unchanged. Sharing links (`link` facets) are never adopted. An item without a single mappable user or group (shared only via links, or only to identities that cannot be mapped) is **not** ingested: the Outpost logs `sharepoint.item_skipped_no_acl` with the item id and a reason (`link_only` or `no_mappable_permissions`) and leaves it out of the listing, so a copy synced earlier with a broader access list is removed by mirror delete. An empty access list would make the document visible to everyone in the tenant. Permission changes in SharePoint take effect with the next sync of the item.

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
