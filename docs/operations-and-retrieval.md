# Operations and retrieval boundaries

## Production check

With `NODE_ENV=production`, `loadConfig()` and `checkProductionReadiness()` run before the
database connection and the HTTP listener start. The gate requires
`AUTHZ_ENFORCEMENT=required`, `TRANSACTION_ENFORCEMENT=required`, a transaction HMAC key of at
least 32 characters, a non-empty issuer and audience, a TTL of at most 900 seconds, and — when
static credentials are used — a fixed service tenant plus the operational scopes
`vectorsearch.read`, `vectorsearch.write`, `vectorsearch.delete`, `vectorsearch.admin`,
`vectorsearch.acl.manage`, and `vectorsearch.metrics`. In production every OIDC issuer must
declare `audience` and `scopesClaim`; tenant isolation comes from `tenantClaim` or, when that
claim is absent, from the server-side `API_OIDC_DEFAULT_TENANT_ID`. Secrets belong exclusively
in the secret manager and must never appear in logs or in readiness output.

## Transaction and hash contract

Transaction envelope v1 binds tenant, scopes, and groups as canonical sets.
`actionContractHash` is the preferred 64-hex claim for the input action contract supplied by the
orchestrator. `evidenceContractHash` is accepted only as a compatible input alias. Both claims
are canonicalised to lowercase internally and in responses. When both are present they must be
identical case-insensitively; otherwise the envelope is rejected fail-closed. Responses name
this input value unambiguously as `actionContractHash`. `evidencePackHash` is a response field
only and is never a permitted envelope claim.

`verified_evidence_pack` returns response schema v2 and computes `evidencePackHash` separately:
SHA-256 over the schema, collection, query hash, temporal scope, effective retrieval parameters,
and the evidence IDs, ranks, scores, and snapshot hashes. `retrievedAt` and raw content are not
part of this reproducible hash input. The hash proves which data bytes and parameters were
delivered — not the truth, completeness, or trustworthiness of the source.

## Data minimisation

Search statistics store SHA-256 query hashes only. The column is still named `query` for
backwards compatibility; its content is not plaintext. Raw queries, qrels, and evidence content
must not be copied into operator logs, metric labels, or tickets. Bound statistics retention with
`STATS_RETENTION_DAYS`.

## Retrieval quality and versions

Document revisions may carry a nullable `valid_from` business timestamp. It is stored as `TIMESTAMPTZ` on every chunk; existing rows and ingests without the field use `COALESCE(valid_from, created)` as their effective start. API timestamps must be RFC 3339 date-times with an explicit timezone. `include_all_versions=false` without `valid_at` retains the legacy `is_latest` behavior; `true` without `valid_at` returns all revisions. With `valid_at`, `true` keeps all revisions introduced by that instant, while `false` deterministically selects the greatest effective start per logical document and keeps every chunk of that selected revision. No `valid_to` interval is inferred: earlier revisions remain eligible in the all-versions mode.

Collection schema 11 adds this column and the tenant/base-reference temporal index. Query timestamps remain bind parameters in dense, binary, FTS, sparse, and hybrid branches, and tenant/ACL predicates continue to apply to the final rows. Evaluation reports its normalized `valid_at`; verified evidence binds the selected temporal mode and instant into its provenance hash.

The lexical branch is PostgreSQL full-text search using `ts_rank` and `websearch_to_tsquery`,
fused via RRF with the dense branch and an optional SPLADE `sparsevec` branch. Okapi BM25 is not
implemented. "Late chunking" here means an alpha blend of chunk and whole-document embeddings,
not token-level late chunking.

`POST /evaluations/retrieval` authorises exactly `body.collection`; a differing `X-Collection`
header has no effect. Per request the limits are 100 queries, 100 qrels per query, 2,000 qrels in
total, plus string length limits. `deadline_ms` is capped at 300 seconds and `concurrency` at 8;
connection loss and deadline expiry are honoured fail-closed between upstream and database steps.
By default the same hybrid and candidate-multiplier defaults apply as in the production search
path; `hybrid`, `include_all_versions`, and `candidate_multiplier` are stated explicitly in both
the request and the result.

Qrels remain in memory. For versionable golden sets a client may send `dataset_version`, and the
response then additionally carries a deterministic `dataset.hash`. Optional `baseline` minimum
values produce a machine-readable `release_gate.passed`. Datasets and baselines must be version
controlled, reviewed, and tenant-bound outside this service. There is deliberately no new
persistent administrative data store, and no claim that the service signs golden sets.

## Schema, provenance, and reindex or cutover

Global schema version 2 adds `allowed_groups` and nullable provenance columns additively.
Collection schema 8 adds group ACL structures and transactionally replaces an existing sparse
index with `USING hnsw (sparse_vector sparsevec_ip_ops)`. This sparse-only rebuild does not alter
the global or dense provenance (`indexBuildVersion`, `indexAlgorithm`, `indexParameters`): known
existing values are preserved, and unknown legacy values stay `NULL`. No separate sparse
provenance is claimed. Startup migrations run under an advisory lock and abort on error. The
transactional sparse index rebuild is rollback-safe but blocking, so it must be scheduled in a
maintenance window for large collections.

New collections persist `EMBED_MODEL` and `EMBED_MODEL_REVISION` (falling back to the model
name), along with the index build version, algorithm, and parameters. Write and search requests
that contradict the recorded model or revision are rejected, which rules out a silent in-place
mix of incompatible embeddings. Legacy collections with unknown (`NULL`) provenance are not
retroactively labelled as current; they stay fail-closed until they have been reindexed into a
new collection in a controlled way.

The safe path, with no hidden in-place rebuild:

1. Create a new versioned collection and ingest it completely with the new model revision.
2. Verify ACL and tenant isolation, then run the versioned golden set against the approved
   baseline using identical retrieval parameters.
3. Pause write traffic briefly; rename the old collection to a retention name using the existing
   rename API, then rename the validated collection to the canonical name.
4. Run a smoke test, release write traffic, and delete the old collection only after the rollback
   and retention period has elapsed.

The two rename steps are not a single database transaction spanning both HTTP calls. The
maintenance window is therefore mandatory. An online atomic alias cutover would be a larger
architectural change, and this document does not pretend otherwise.

## Telemetry

`/metrics` exports HTTP request and error counters, an in-flight gauge, and a
`vectorsearch_http_request_duration_seconds` histogram with `_bucket`, `_sum`, and `_count`.
Labels use only the HTTP method, the canonical Express route, and the status class; unknown paths
are collapsed into `__unmatched__`. Prometheus label values are escaped. The endpoint requires the
dedicated `vectorsearch.metrics` scope. Do not expose it publicly.

## Incident and deployment runbook

1. For authorization or transaction incidents, block traffic, trace `executionId` and
   `invocationId` through the structured logs, and rotate the affected credentials according to
   the operator process.
2. On sparse-branch failure, check upstream and circuit-breaker status. Do not change a quality
   assumption without running an evaluation.
3. Before every production deployment, run the following from the monorepo root:
   `bun run verify:public && bun run supply-chain:check && bun run typecheck && bun run test && bun run build`.
   In addition, the exact release image and its SBOM must be scanned for known vulnerabilities in
   the deployment system.
4. PostgreSQL 18 Compose profiles mount the volume at `/pg` and set `PGDATA=/pg/18/data`. An
   existing volume from the earlier `/var/lib/postgresql/data` mount must not be started directly
   against the new layout: take a verified backup first, migrate via `pg_upgrade` or dump and
   restore into a fresh `/pg` volume, and switch over only after a restore smoke test.
