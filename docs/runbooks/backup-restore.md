<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Runbook: Backup and Restore

Applicable to: ATF 0.14.x. All services are stateless except their databases and
the Extract scratch/outstore volumes; back up state, not containers.

## What must be backed up

| State | Location | Notes |
| --- | --- | --- |
| Runtime database | Postgres, `DATABASE_URL` (Runtime) | Schema version 41; migrations run automatically on start |
| Gate database | Postgres, `POSTGRES_URL` (Gate) | Audit log, sessions, monitor credentials |
| Search database | Postgres (`DATABASE_URL`, Search) | Index metadata; vector index can be rebuilt from source data |
| Extract database | Postgres, `EXTRACT_DATABASE_URL` | Schema version 5 |
| Extract outstore | Object storage / volume behind Extract | Source documents and derived artifacts |
| Converter scratch | `TEMP_DIR` volume (Extract + isolated converter) | Ephemeral; do NOT back up — must be wiped on restore |
| Audit anchor file | `AUDIT_ANCHOR_FILE` (Runtime) | Append-only hash chain; back up together with the Gate audit DB |
| Secrets | Your secret store (K8s Secrets / vault) | Never store backups of secrets next to the data they protect |
| Flow bundles | Deployment system (ConfigMaps / flow repo) | Flows are data-as-code; keep them in git, not only in the DB |

## Backup procedure (Postgres)

1. Take a consistent snapshot per database:

   ```sh
   pg_dump "$RUNTIME_DATABASE_URL" -Fc -f atf-runtime-$(date +%F).dump
   pg_dump "$GATE_POSTGRES_URL"    -Fc -f atf-gate-$(date +%F).dump
   ```

   For large installations use filesystem snapshots of the Postgres volumes plus
   `pg_start_backup`/`pg_stop_backup` (or your managed database's PITR).
2. Back up the outstore with your object-storage replication or
   `restic`/`rclone` — it is the only copy of ingested source documents.
3. Copy the audit anchor file **after** the Gate dump so the anchor chain covers
   the dumped audit rows.
4. Encrypt backups at rest and ship them to a second failure domain.
   Restore capability is only proven by a restore test, not by a backup job.

## Restore procedure

1. Provision Postgres at or above the version used in production; create the
   `atf-runtime`, `atf-gate`, `atf-search`, `atf-extract` roles/databases.
2. Restore dumps:

   ```sh
   pg_restore --no-owner -d "$RUNTIME_DATABASE_URL" atf-runtime-<date>.dump
   pg_restore --no-owner -d "$GATE_POSTGRES_URL"    atf-gate-<date>.dump
   ```

3. Restore the outstore to the bucket/volume Extract expects, and place the
   anchor file at `AUDIT_ANCHOR_FILE` **before** starting Runtime.
4. Start services in order: Postgres → Runtime → Gate → Search → Extract →
   Control. Migrations apply automatically on first database access (advisory
   lock, single transaction, additive).
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
replay Extract outstore changes only forward — the outstore has no WAL. Document
the resulting divergence window in the incident record
(`incident.md`).

## What must never be restored blindly

- `TEMP_DIR`/scratch contents (attacker-controlled files after an incident).
- Session cookies or vault entries from a snapshot taken with a **rotated-out**
  encryption key — decryption will fail closed by design (AAD binds
  execution + token); that is expected, not corruption.
