# Blueprint — mirroring a file share into Extract (Outpost)

An Outpost runs **where the documents are** — next to a file server, in a department's own
network — and pushes them into Extract. The connection is only ever outbound: nothing has to
be opened inbound, and no share is exposed to a central service.

This blueprint mirrors two sources into one collection: a mounted local folder and an
S3-compatible bucket.

## Prerequisites

- An Extract endpoint you can reach, and an API token for it with `extract.ingest` and
  `extract.delete`. Deployments without own-job read support may additionally need
  `extract.admin` — an explicit transition workaround, not a default to copy.
- **If the sources carry an ACL** (as both do here): the token also needs the scope
  `extract.acl.assign`. Without it, Extract intersects your list with the token's own
  identity — empty for a service token — and the documents end up visible tenant-wide. The
  Outpost notices this and fails the item rather than letting it through, then deletes it
  again; the log says `Extract did not apply the requested access list`.
- The folder to mirror, mounted read-only into the container.
- The image is published only on `outpost-v*` tags (never on a product `vX.Y.Z` tag). Check
  the repository tags, or build it: `docker build -f apps/outpost/Dockerfile -t atf-outpost .`

## Variables

Config file values live in `outpost.yaml`. Secrets live in the environment — the schema knows
no secret fields at all, so a stray `apiToken:` key in the YAML is **stripped silently rather
than used**. Every secret also accepts a `_FILE` variant naming a readable path; the `_FILE`
form wins and the value is registered with the log redactor.

| Variable | Purpose |
| --- | --- |
| `OUTPOST_API_TOKEN` (`_FILE`) | Extract API token. Preferred auth method when set. |
| `OUTPOST_CLIENT_SECRET` (`_FILE`) | client-credentials auth instead of a token; the client id then comes from `oidc.clientId` in the file (`OUTPOST_OIDC_CLIENT_ID` overrides it) |
| `OUTPOST_EXTRACT_URL` | overrides `extractUrl` |
| `OUTPOST_COLLECTION` | overrides `collection` |
| `OUTPOST_DATA_DIR` | state + credentials directory, default `/data` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 credentials for `credentials: store` when the Outpost's own store is empty; `AWS_PROFILE` works too |
| `OUTPOST_HEALTH_BIND` | only to move the health endpoint off loopback — logged as a warning |
| `OUTPOST_LOG_LEVEL` | `debug` shows per-file decisions, which is where a wrong `include` pattern becomes visible |

## Start

```bash
docker run --rm \
  -v "$PWD/deploy/blueprints/dms-mirror/outpost.yaml:/config/outpost.yaml:ro" \
  -v outpost-blueprint-data:/data \
  -v "$PWD/share:/sources/dept-share:ro" \
  -e OUTPOST_API_TOKEN_FILE=/run/secrets/extract_token \
  ghcr.io/abillify/atf-outpost:outpost-v<version> daemon
```

Two things to check before letting it run on an interval:

```bash
# One pass, then exit — the fastest way to see a wrong path or pattern.
docker exec -it outpost atf-outpost once
# Unauthenticated, on loopback inside the container.
docker exec -it outpost curl -s localhost:8787/healthz
```

Exit codes: `0` success, `1` item/source failures or missing source authorization, `2`
Extract connection/authentication failure, `64` command usage, `78` invalid configuration.
`78` on first start almost always means a path or a collection name, not a secret.

## Decisions in the file

- **`collection` is the access-control boundary**, and it is baked into every document id
  already ingested. Changing it later means re-ingesting everything.
- **`path` is the path inside the container**, not on the host. A source that reports zero
  files is nearly always a mount mismatch, and `once` above is how you see it.
- **`followSymlinks: false`.** A link out of the folder turns a folder-scoped mirror into
  whatever the share's owner pointed at, and no ACL sees that coming.
- **`mirrorDelete: false` on the share, `true` on the archive.** An unmounted volume reads as
  an empty folder; with mirror-delete on, that is a mass deletion in the collection. Where
  deletions *are* authoritative, `deleteThresholdPercent` refuses the batch above that share
  of the mirror and the rest waits for `atf-outpost confirm-deletes <id>`.
- **Tags and metadata are set here**, per source, where they are reviewable — not in a
  prompt. They are what a flow filters retrieval on later.
- **`syncIntervalSec` is a cost knob.** Each pass hashes every file it sees, so a short
  interval on a large share spends the day re-hashing unchanged documents. `watch: true`
  covers freshness on a local filesystem; on NFS/SMB, events are unreliable — leave it off
  and rely on the interval, which always re-reads.

## Limits of this blueprint

- **No offline validation step.** Unlike the flow and Gate blueprints, the Outpost has no CLI
  that checks a config file without starting, so `outpost.yaml` is checked by eye here.
  `once` is the practical equivalent: it exits `78` on an invalid config before syncing.
- **Two source types only.** Google Drive, Dropbox and SharePoint are configured
  differently — interactive login (`source-login`), service-account key files, or a Microsoft
  app registration. See `apps/outpost/README.md`; the per-document ACL those adapters return
  overrides the source `acl` here.
- **ACL users must be spelled the way Extract spells them.** `dana.keller` is a placeholder
  for whatever the identity looks like on your Extract; a name it does not recognise is not
  an error at config time — it shows up as an item failure.
- **`endpoint` / `forcePathStyle` are for S3-compatible services.** Unset both for AWS S3.
