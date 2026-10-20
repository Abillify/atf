<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Runbook: Backup and Restore

Applicable to: ATF 0.18.x. All services are stateless except their databases, the
Search asset store, the Extract source store and the optional Gate monitor audit
file; back up state, not containers. (Redis holds only ephemeral coordination
state — rate-limit counters, pending approvals, budgets — nothing that must be
restored.)

## What must be backed up

| State | Location | Notes |
| --- | --- | --- |
| Runtime database | Postgres, `DATABASE_URL` (Runtime) | Schema version 47 (see `docs/UPGRADE.md`); includes the audit chain tables — migrations run automatically on start outside production, `bun run migrate` or the Helm hooks apply them in production |
| Search database | Postgres, `POSTGRES_URL` (Search, required) | Index metadata, revisions, ACLs — and with the default `ASSET_STORE_BACKEND=postgres` the `vs_assets` table holds every v2 asset's bytes (figures, thumbnails, previews). The vector index can be rebuilt from stored data; the asset bytes cannot. **This dump is the only copy of that content — never skip it.** With `ASSET_STORE_BACKEND=filesystem` the bytes live in `ASSET_STORE_DIR` instead (see below) |
| Search asset store (filesystem backend) | `ASSET_STORE_DIR` volume (Search) | Only with `ASSET_STORE_BACKEND=filesystem`: `vs_assets` rows then reference files on this volume; back the volume up alongside the Search dump |
| Extract database | Postgres, `EXTRACT_DATABASE_URL` | Schema version 5; only present when Extract persistence (the v2 job store) is enabled — skip the dump otherwise |
| Extract source store | `SOURCE_STORE_DIR` volume (Extract) | Content-addressed store of the ingested v2 source documents — the only durable copy of the originals the v2 pipeline re-renders from. **Defaults to a directory under `TEMP_DIR` when unset; point it at a persistent volume or those bytes are lost with the scratch.** Back up with object-storage replication or `restic`/`rclone` — it has no WAL |
| Gate | No database | The Gate is stateless: sessions live in memory (or optionally Redis, `redisUrl` — shared state, regenerable, not user data). Its only persistent state is the optional monitor audit JSONL file (`monitoring.audit.file`): back that file up if the sink is enabled and the events matter outside the log shipper |
| Converter scratch | `TEMP_DIR` volume (Extract + isolated converter) | Ephemeral; do NOT back up — must be wiped on restore (`UPLOAD_TMP_DIR` likewise) |
| Audit anchor file | `AUDIT_ANCHOR_FILE` (Runtime) | Append-only hash chain over the Runtime audit tables; back it up together with the Runtime dump |
| Signing keys and peppers | Secret store: `EVIDENCE_SIGNING_KEY`, `RECEIPT_SIGNING_KEY`, `ERASURE_RECEIPT_SIGNING_KEY`, `AUDIT_ANCHOR_SECRET`, `EVIDENCE_BUNDLE_SECRET`, `API_KEY_PEPPER`, `STATS_QUERY_PEPPER` | `EVIDENCE_SIGNING_KEY` (Ed25519, ADR 0030) signs audit anchors, evidence bundles and erasure receipts: restore the same key, or new artefacts get a new `kid` and every earlier artefact needs the old public key (archive `/.well-known/atf-evidence-jwks.json` with the backup). The HMAC secrets (`AUDIT_ANCHOR_SECRET`, `EVIDENCE_BUNDLE_SECRET`) are still needed to verify legacy artefacts. Without the receipt keys the signed receipts can no longer be verified against the JWKS; without `API_KEY_PEPPER` stored API-key hashes stop matching and every key must be reissued; without `STATS_QUERY_PEPPER` the stored query hashes no longer match. Back them up with the database, but in the secret store, not next to the dump |
| Control session secret | Secret store: `CONTROL_SESSION_SECRET` (BFF mode) | Losing it only ends Control sessions; no data is lost |
| Collection FTS language | Search database (per collection) | Part of the Search dump; `bun run fts:language` recomputes a collection's vectors if you restore into a deployment with a different `FTS_LANGUAGE` |
| Secrets | Your secret store (K8s Secrets / vault) | Never store backups of secrets next to the data they protect |
| Flow bundles | Deployment system (ConfigMaps / flow repo) | Flows are data-as-code; keep them in git, not only in the DB |

## Backup procedure (Postgres)

1. Take a consistent snapshot per database. `$RUNTIME_DATABASE_URL`, `$SEARCH_POSTGRES_URL` and `$EXTRACT_DATABASE_URL` are placeholders for the values of the service variables `DATABASE_URL` (Runtime), `POSTGRES_URL` (Search) and `EXTRACT_DATABASE_URL` (Extract):

   ```sh
   pg_dump "$RUNTIME_DATABASE_URL"   -Fc -f atf-runtime-$(date +%F).dump
   pg_dump "$SEARCH_POSTGRES_URL"    -Fc -f atf-search-$(date +%F).dump
   pg_dump "$EXTRACT_DATABASE_URL"   -Fc -f atf-extract-$(date +%F).dump  # only when persistence is enabled
   ```

   The Search dump carries the v2 asset bytes with the default
   `ASSET_STORE_BACKEND=postgres`; treating it as optional "index cache" loses
   every stored figure. For large installations use filesystem snapshots of the
   Postgres volumes plus `pg_start_backup`/`pg_stop_backup` (or your managed
   database's PITR).
2. Back up the Extract source store (`SOURCE_STORE_DIR`) and, with the
   filesystem asset backend, the Search `ASSET_STORE_DIR` with your
   object-storage replication or `restic`/`rclone` — neither has a WAL, and each
   is the only copy of the bytes it holds.
3. Copy the audit anchor file **after** the Runtime dump so the anchor chain
   covers the dumped audit rows. If the Gate monitor audit sink is enabled,
   copy its JSONL file (`monitoring.audit.file`) too. Do not restore an old copy
   of that file over a newer one blindly: with `monitoring.audit.appendOnly`
   off, a subject erasure rewrites it, and restoring a pre-erasure copy brings
   the erased personal data back — replay the erasure requests afterwards.
4. Encrypt backups at rest and ship them to a second failure domain.
   Restore capability is only proven by a restore test, not by a backup job.

## Restore procedure

1. Provision Postgres at or above the version used in production; create the
   `atf-runtime`, `atf-search`, `atf-extract` roles/databases.
2. Restore dumps:

   ```sh
   pg_restore --no-owner -d "$RUNTIME_DATABASE_URL"  atf-runtime-<date>.dump
   pg_restore --no-owner -d "$SEARCH_POSTGRES_URL"   atf-search-<date>.dump
   pg_restore --no-owner -d "$EXTRACT_DATABASE_URL"  atf-extract-<date>.dump  # only when persistence is enabled
   ```

3. Restore the Extract source store (and the filesystem asset store, if used)
   to the volumes the services expect, and place the anchor file at
   `AUDIT_ANCHOR_FILE` **before** starting Runtime.
4. Start services in order: Postgres → Runtime → Gate → Search → Extract →
   Control. Outside production migrations apply on start; in production (with
   `MIGRATE_ON_START` unset) run `bun run migrate` or the Helm hooks first
   (advisory lock, additive). Provide the same signing keys and peppers as at
   backup time before the services start.
5. Verify:

   ```sh
   curl -fsS http://runtime:3000/health
   curl -fsS http://gate:3003/healthz
   curl -fsS http://search:3002/health
   curl -fsS http://extract:3004/health
   ```

6. Re-run one end-to-end transaction (ingest → chat → evidence) and confirm the
   audit chain verifies (see `key-rotation.md` § Audit anchor for the
   verification command).

## Point-in-time recovery

If the database supports WAL archiving, restore to just before the incident, then
replay ingest changes only forward — the Extract source store and a filesystem
asset store have no WAL (with `ASSET_STORE_BACKEND=postgres` the asset bytes are
inside the Search database and follow its WAL). Document the resulting divergence
window in the incident record (`incident.md`).

## What must never be restored blindly

- `TEMP_DIR`/scratch contents (attacker-controlled files after an incident).
- Session cookies or vault entries from a snapshot taken with a **rotated-out**
  encryption key — decryption will fail closed by design (AAD binds
  execution + token); that is expected, not corruption.
