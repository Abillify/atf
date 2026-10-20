# Deployment

## Repository boundary

The repository includes source code, a local unauthenticated quickstart under `deploy/examples`, and a reference Helm chart under `deploy/helm/atf`. It does **not** include a production Compose stack, customer flow bundle, credentials, production endpoints, or operational overlay. The Helm chart carries no environment-specific values: image registry/tag or digest, Secret names, flow ConfigMaps, and replica counts are supplied by the deployment system at install time.

Environment-specific stack definitions, operational flows, and customer configuration must live in a separately access-controlled deployment system. Released images must be built from a reviewed commit, scanned, accompanied by `sbom.cdx.json` and `THIRD_PARTY_NOTICES.md`, and pinned by immutable digest in the deployment system.

## Local quickstart

Use `deploy/examples/README.md`. Its auth-off settings, deterministic mock model, local password, and development servers are intentionally unsafe for production.

## Extract Outpost

The Extract Outpost runs as the non-root `atf-outpost` container. Mount the read-only configuration at `/config/outpost.yaml`, persistent state at `/data` and local sources below `/sources/*`. Its unauthenticated health endpoint defaults to `127.0.0.1:8787`; bind it publicly only behind an authenticated network boundary.

Cloud source login can be performed without restarting the daemon:

```sh
docker exec -it outpost atf-outpost source-login <sourceId>
docker exec -it outpost atf-outpost confirm-deletes <sourceId>
```

`source-login` uses code paste for Dropbox and the complete redirected browser URL for Google Drive. A missing source authorization is shown as `needs-authorization` and keeps `/healthz` at HTTP 200; `once` returns exit code 1. Use `auth: service-account` for Google Drive service accounts and provide the key through `OUTPOST_SOURCE_<ID>_GDRIVE_SA_KEY_FILE`. Secrets are redacted and never included in health responses or logs.

## Application artifacts

- Runtime and Gate are Bun applications (toolchain pin 1.4.0; the production images in
  `deploy/images/` run the digest-pinned Bun 1.4.2 base, a patch release inside the declared
  `engines` range — see `DEVELOPMENT.md`).
- Search is Bun-native and additionally supports `bun run --filter @atf/search build:node` for a Node.js 26 artifact. That build keeps the native module `sharp` external, so the Node image must install `sharp` (the version pinned in `apps/search/package.json`) for its target platform next to the artifact.
- Control is built with Bun and deployed on Node.js 26 from the Next.js standalone output.

Production Dockerfiles live under `deploy/images/` (one per service, pinned base-image
digests, non-root). Orchestration beyond the reference Helm chart below — network fabric,
ingress, TLS termination, and overlays — remains deployment-owned.

## Helm chart (`deploy/helm/atf`)

The umbrella chart `deploy/helm/atf` is the reference Kubernetes deployment for the five
services (Runtime, Gate, Search, Extract, Control). It is validated in CI with `helm lint`
and `kubeconform -strict` against every rendered manifest. For sizing and
budgeting the chart's resource defaults — and the inference cost drivers behind
them — see [docs/OPERATIONS-TCO.md](docs/OPERATIONS-TCO.md).

Layout: an umbrella chart with one subchart per service plus an `atf-common` library chart
that holds the shared templates (Deployment, Service, HPA, PDB, NetworkPolicy,
ServiceAccount, migration Job hooks). Every workload runs with a restrictive
`securityContext` (`runAsNonRoot`, `readOnlyRootFilesystem`, dropped capabilities,
`RuntimeDefault` seccomp), requests/limits, liveness/readiness probes matching the table
below, a `PodDisruptionBudget`, and a default-deny `NetworkPolicy` that only admits the
documented service-to-service callers (plus ingress for `control`, or `gate`/`search`/
`extract` when their `expose` flag is set).

The chart references **existing** Secrets — it never contains secret material. Set
`global.secrets.<service>` to the name of a Secret whose keys are the service's environment
variables (`DATABASE_URL`, `POSTGRES_URL`, `EXTRACT_DATABASE_URL`, …); workloads consume it
via `envFrom`, and the migration hooks read the database URL from it via `secretKeyRef`.
Runtime flows come from a ConfigMap named by `runtime.flowsConfigMap` (mounted at
`/config/flows`), Gate configuration from `gate.configMap` (mounted at `/config`).

Migrations run as `pre-install`/`pre-upgrade` Jobs (`<service>.migration.enabled`, ordered
by hook weight: Runtime 10, Search 20, Extract 30) that execute `bun run scripts/migrate.ts`
from the service image; the replicas themselves boot with `MIGRATE_ON_START=false`.

**What the chart does not model.** It deploys the five services only: PostgreSQL, Redis and
the model endpoints are yours. Three consequences matter in production:
- `replicaCount` defaults to 2 for every service and is exported as `REPLICAS`
  (Gate: `MCPGATE_REPLICAS`; the HPA's `maxReplicas` when autoscaling is on), so the
  production gates judge the real topology. Search and Extract therefore refuse to start
  without `RATE_LIMIT_REDIS_URL`, and Runtime warns without `REDIS_URL`: put the URL in the
  service's Secret or `extraEnv`, or run `replicaCount: 1`. The chart creates no Redis.
- Extract runs LibreOffice inside its pod (`CONVERTER_MODE=local`). The production gate
  refuses that without an acknowledgement, so the chart exports
  `CONVERTER_ALLOW_LOCAL_HTML=true` unless `extract.config.converterAllowLocalHtml` is
  `false`. The chart cannot run the isolated converter (a second container sharing the
  scratch volume and a socket); if you need it, add that wiring yourself through
  `extraEnv` and a patched pod spec, then turn the acknowledgement off.
- `global.profile` (`development`, `staging`, `production`, `test`) is exported as
  `ATF_PROFILE` to Runtime, Gate, Search and Extract only when set; it overrides the
  per-service profile variable. Leave it empty to keep each service's own judgement, or set
  `staging` to see the production findings as warnings first.
`extraEnv` renders after the chart's own variables and wins. CI renders the chart, validates
it with `kubeconform -strict` and asserts these exports.
Images default to `ghcr.io/abillify/atf-<service>` tagged with the chart `appVersion`.
`global.image.tag` renders a mutable `:tag` reference; in production pin the per-service
`image.digest` (rendered as `@sha256:…`) to an immutable digest instead. Example:

```sh
helm install atf deploy/helm/atf --namespace atf --create-namespace \
  --set global.secrets.runtime=atf-runtime --set global.secrets.gate=atf-gate \
  --set global.secrets.search=atf-search --set global.secrets.extract=atf-extract \
  --set global.secrets.control=atf-control \
  --set runtime.flowsConfigMap=atf-flows --set gate.configMap=atf-gate-config \
  --set global.image.tag=0.16.0
```

## Inference provider configuration

Runtime inference endpoints and credentials are configured exclusively through `PROVIDERS`, a JSON array of uniquely named instances. Supported protocols are `openai`, `google`, `ollama`, `azure`, `bedrock`, and `anthropic`.

```dotenv
PROVIDERS=[{"name":"gpu-vllm","protocol":"openai","url":"http://model.internal:8000/v1","local":true},{"name":"aws-eu","protocol":"bedrock","region":"eu-central-1"}]
DEFAULT_LLM={"provider":"gpu-vllm","model":"org/primary-model"}
FALLBACK_LLM={"provider":"aws-eu","model":"provider/fallback-model"}
```

Optional provider fields include `url`, `apiKey`, `region`, `accessKeyId`, `secretAccessKey`, `sessionToken`, `resourceName`, `apiVersion`, and `local`. Store credential-bearing JSON in a secret manager, never a ConfigMap or source control. `local: true` is an explicit operator assertion; it is not inferred from URL shape.

All model settings use the provider instance `name`, not a protocol name. Runtime walks the whole parsed environment for `{ provider, model }` shapes and validates every reference at startup, so a typo fails the boot rather than the first request that happens to use it.

Per-protocol variables such as `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `GOOGLE_API_KEY`, `OLLAMA_BASE_URL`, `AZURE_*`, `BEDROCK_*`, and `ANTHROPIC_API_KEY` are **not** Runtime configuration sources and are ignored by the Runtime process. They are still read by the standalone smoke scripts under `apps/runtime/scripts/` and by the model integration tests, which talk to providers directly and bypass the provider registry deliberately. Do not set them on a production Runtime deployment; they will have no effect and will mislead the next person reading the manifest.

## Production minimums

A production deployment must define and verify, per service:

- authentication, authorization, tenant isolation, issuer/audience, and least-privilege scopes;
- TLS, trusted proxy behavior, CORS, DNS/host validation, and network policy;
- secret management and credential rotation;
- PostgreSQL/pgvector lifecycle, backups, restore tests, migrations, and RLS where applicable;
- Redis or another shared coordination backend where multiple replicas require it;
- immutable model/provider configuration, timeouts, budgets, and egress controls;
- health, metrics, logs, traces, retention, erasure, alerting, and incident procedures;
- immutable image digests, vulnerability scans, SBOM retention, and rollback.

The production-readiness gates are safeguards, not a substitute for deployment review.

### What the production gate enforces

Every service (Runtime, Gate, Search, Extract) resolves one operational profile
the same way through `@atf/security-kit`: the platform-wide `ATF_PROFILE` wins
over the service variable (`APP_ENV`, `MCPGATE_ENV`, `NODE_ENV`), and unset
means `development`. The value set is closed — `development`, `staging`,
`production`, `test` — and an unknown value aborts startup, so a typo like
`prod` can no longer silently disable the gates. `staging` runs the checks in
warn mode: every finding a production start would refuse is reported, but the
service starts.

With the profile set to `production`, Runtime refuses to start rather than warn when a setting is unsafe —
open CORS, unverified JWTs, an unauthenticated monitoring or metrics endpoint, and similar. Gate,
Search, and Extract have equivalent gates of their own (ADR `gate/0001`). See
`apps/runtime/src/config/prod-gate.ts` for the exact set.

The gate covers settings a process can inspect about itself. It cannot verify TLS termination,
network policy, backup restores, secret rotation, or least-privilege database grants. Those
remain deployment review items, which is why the list above is longer than what the gate checks.

### Schema migrations (`bun run migrate`, `MIGRATE_ON_START`)

Runtime, Search, and Extract each ship a standalone migration command:

```sh
cd apps/runtime && DATABASE_URL=...            bun run migrate
cd apps/search  && POSTGRES_URL=...            bun run migrate
cd apps/extract && EXTRACT_DATABASE_URL=...    bun run migrate
```

Every migrator runs under a PostgreSQL session advisory lock, so a migration
Job and booting replicas serialise safely — the losers see the schema already
at the target version and no-op. The scripts read only the database variables
(Search additionally the DDL-shaping knobs `VECTOR_HALF_PRECISION`, `HNSW_M`,
`HNSW_EF_CONSTRUCTION`), so a one-shot Job needs the database secret and
nothing else. Exit code 0 means the schema is at the target version
(including "already up to date"); 1 means it is not.

`MIGRATE_ON_START` controls whether a service applies migrations itself at
boot. Unset means: `true` outside production, `false` when
`APP_ENV`/`NODE_ENV` is `production` — production replicas therefore do not do
DDL on their boot path, and a one-shot migration Job runs `bun run migrate`
ahead of the rollout instead (the Helm chart wires this as a
`pre-install`/`pre-upgrade` hook). An explicit `true`/`false` always wins, e.g.
to keep migrate-on-boot during a brownout migration window.

### Liveness and readiness probes

Every service exposes a liveness probe that never touches a dependency and a
readiness probe that gates the load balancer, so an orchestrator restarts a
wedged process without removing healthy replicas from rotation over a slow
database — and vice versa:

| Service | Liveness | Readiness | 503 when |
| --- | --- | --- | --- |
| Runtime | `GET /health/live` | `GET /health/ready` | a configured dependency (database, Redis, flows) is down |
| Gate | `GET /healthz` | `GET /readyz` | a required dependency is down |
| Search | `GET /health/live` | `GET /health/ready` | PostgreSQL is unreachable |
| Extract | `GET /health/live` | `GET /health/ready` | the poppler binaries or the vision endpoint are unavailable |

The legacy composite `GET /health` stays unchanged on every service for
back-compat (the Compose healthchecks and the `/ui` status pages use it). For
Search it remains the diagnostic probe that also reports embedding, reranker,
and circuit-breaker state — degraded model providers are visible there without
pulling a replica out of rotation, because the database is the source of truth
for readiness. For Extract, LibreOffice absence degrades only the Office
formats and an unreachable Search only `/v1/ingest`, so neither makes
`/health/ready` fail; `?deep=1` forces a re-probe past the cached results.

### Service TLS and mTLS (`TLS_CERT_FILE`, `TLS_CLIENT_CA_FILE`)

Search and Extract serve plain HTTP by default and terminate TLS at the ingress,
which is the supported topology. For deployments that require transport
encryption all the way to the service (compliance networks, cross-cluster
links), both services accept the same knobs:

| Variable | Effect |
| --- | --- |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | PEM material for the listener; both must be set together or startup fails. The service then serves HTTPS directly. |
| `TLS_CLIENT_CA_FILE` | Optional. When set, the listener requests and **requires** a client certificate chained to this CA — mTLS. |

The client side mirrors this: Search trusts a self-signed Converter via
`CONVERTER_CA_CERT_FILE`, Extract trusts a self-signed Search via
`SEARCH_CA_CERT_FILE`. The CA file is concatenated onto the platform trust
store rather than replacing it, so a bundle containing both a private CA and
public roots works in one setting.

In the Helm chart, set `search.config.tls.secretName` (and/or
`extract.config.tls.secretName`) to an existing `kubernetes.io/tls` Secret. The
chart mounts it read-only at `/etc/atf/tls`, wires `TLS_CERT_FILE`/`TLS_KEY_FILE`
from the mount, and flips the liveness/readiness probes to the `HTTPS` scheme
(kubelet probes do not verify certificates). With search TLS enabled, also set
`extract.config.searchTls: true` so the in-cluster `SEARCH_URL` uses `https`.
`TLS_CLIENT_CA_FILE` (mTLS) is deliberately **not** chart-wired: kubelet HTTP
probes cannot present a client certificate, so enabling it through the chart
would fail every probe. Operators who need mTLS between services in Kubernetes
should manage the client-CA variable and probe trade-offs explicitly (for
example via a sidecar proxy) rather than through the chart defaults.

**SPIFFE compatibility.** The implementation does no SPIFFE-specific protocol
work; it validates ordinary X.509 chains against a configured CA bundle. A SPIFFE
trust bundle is a PEM CA file and an SVID is a standard X.509 SNI-capable
certificate, so a SPIFFE-compatible workload can drop its rotated SVID into
`TLS_CERT_FILE`/`TLS_KEY_FILE` (server) or the client CA/credential knobs and
the services trust the same trust domain — including with a workload-attested CA
in `TLS_CLIENT_CA_FILE`. Certificate rotation is a file replacement plus the
service's standard restart/rollout; there is no in-process watcher.

### Service-token rotation (`API_TOKEN_NEXT`)

Static service tokens support two simultaneously valid values so a rotation
never has a window where old and new token are both required to be identical
everywhere at once (Requirement 11.8). Search and Extract accept
`API_TOKEN_NEXT` in addition to `API_TOKEN`; while both are set, **either** one
authenticates. `API_TOKEN_NEXT` alone also enables token auth — useful when the
old token has already been withdrawn. The production gate additionally refuses a
rotation token shorter than 32 characters and one identical to `API_TOKEN`.

Runbook per service pair (example: Extract → Search):

1. Mint the new token and set it as `API_TOKEN_NEXT` on the **server** (Search).
   Both tokens are now accepted; nothing changes for existing clients.
2. Roll every **client** (Extract, Runtime, monitors, hand-written callers) to
   send the new token.
3. Promote: set the new token as `API_TOKEN` and **unset** `API_TOKEN_NEXT`.
   The old token stops authenticating at this point — keep it valid in the
   secret store until the previous step has fully converged on every replica.

The same procedure applies to each service's own inbound `API_TOKEN`; the
`MONITOR_TOKEN` has no rotation twin and is rotated by the ordinary
pull-out-of-rotation restart.

### Supply-chain inventories per artifact and platform

The committed root `sbom.cdx.json` and `THIRD_PARTY_NOTICES.md` are the byte-stable
**Linux x64 workspace reference**. They deliberately record Git SHA `unknown`: embedding the
commit that changes a committed generated file would create a self-referential two-commit
artifact cycle. The project version and SHA-256 of `bun.lock` identify the reference inputs;
Linux CI regenerates with the same stable metadata and compares both files byte-for-byte. Do
not regenerate these root files on macOS while labeling them as Linux.

Every CI run also creates commit-specific workspace inventories natively on `linux-x64` and
`darwin-arm64`. Their directory and artifact names include the exact `github.sha`; the macOS
inventory is a separate release artifact and never replaces the committed Linux reference.
Commit-specific notices and CycloneDX metadata record the exact commit; all inventories record
project version, platform, artifact kind/name, and the SHA-256 of `bun.lock`.

The Dockerfile under `deploy/examples` is Quickstart-only. After its in-image `bun install`,
each final target (`runtime`, `control`, `search`, and `gate`) generates an inventory from that
image's own `/workspace/node_modules/.bun` under `/usr/share/doc/atf`. CI builds the exact
checkout, inspects the resulting image platform and ID/digest, extracts those embedded files,
and publishes a per-target `image.json` plus a combined `index.json`. These inventories must
not be replaced with host `node_modules` output.

LGPL, MPL, and CC-BY components carry explicit artifact-specific compliance entries. The
Quickstart inventories distinguish source forms from native executable prebuilds: readable
`axe-core` and `@axe-core/playwright` JavaScript source remains in each installed package, while
Lightning CSS native prebuilds link each installed version to a commit-pinned upstream
corresponding-source archive. `/workspace` itself must not be described as containing the Rust
source for those prebuilds. libvips remains a dynamically loaded, replaceable shared library with its LGPL text. Caniuse data retains its CC-BY
attribution link and unmodified status. These statements describe only the repository's Quickstart
artifacts; they do not assert compliance for separately built production images.

The Extract Quickstart image additionally installs Debian packages — `poppler-utils`,
`libreoffice-writer-nogui`, `libreoffice-calc-nogui`, `libreoffice-impress-nogui`,
`libreoffice-draw-nogui`, `fonts-liberation` and `fonts-dejavu-core`
— because PDF and office conversion needs external binaries. Those packages come from the base
image's distribution archive with their own licenses and are **not** covered by the generated
inventories, which describe the JavaScript dependency tree only. A production Extract image must
account for them in its own review.

**Minimum poppler version.** The deterministic page analysis (S2) reads per-word geometry with
`pdftotext -bbox-layout`, a flag that requires **poppler ≥ 0.42** (2016). Every currently
supported distribution ships far newer poppler, so a stock `poppler-utils` package satisfies this;
the requirement matters only for an image pinned to a very old base. Extract probes the capability
at startup and reports it under `dependencies.bbox_layout` in `GET /health`. A missing capability
is **not fatal** — a v1-only deployment that never runs the analyzed stage starts cleanly, and a
newer deployment simply falls back to a vision pass for each page — but it disables the
geometry-driven refinements (heading candidates, bbox snapping, the text fast-path). Check the
`bbox_layout.supported` field in `/health` (or the boot log) to confirm S2 is available.

Tag releases attach a checksummed bundle containing both native workspace inventories and all
five Quickstart image inventories. They also publish the five service images (`runtime`,
`search`, `gate`, `extract`, `control`) to `ghcr.io/abillify/atf-<service>`, tagged with the
release version and the exact commit SHA. The `Container images` job in
`.github/workflows/release.yml` signs each image digest with cosign (keyless) and attaches a
SLSA build-provenance attestation and a CycloneDX SBOM attestation. The images exist only after
the tag run has finished. Production images remain deployment-owned and require their own
inventory, source-availability, replaceability, attribution, scanning, and immutable-digest
review. The 0.16 operating changes (`JWT_ISSUER_TENANTS`, `CONTROL_PUBLIC_ORIGIN`, the German
full-text default) are listed in [docs/UPGRADE.md](docs/UPGRADE.md).

### Image verification

Verify an image before you pin its digest. Replace `<service>` and the version:

```sh
IMAGE=ghcr.io/abillify/atf-<service>:0.16.0
DIGEST=$(docker buildx imagetools inspect "$IMAGE" --format '{{json .Manifest.Digest}}' | tr -d '"')

# Signature: the identity is the release workflow at the release tag.
cosign verify "ghcr.io/abillify/atf-<service>@${DIGEST}" \
  --certificate-identity "https://github.com/Abillify/atf/.github/workflows/release.yml@refs/tags/v0.16.0" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# Build provenance and SBOM attestations.
gh attestation verify "oci://ghcr.io/abillify/atf-<service>@${DIGEST}" --repo Abillify/atf
gh attestation verify "oci://ghcr.io/abillify/atf-<service>@${DIGEST}" --repo Abillify/atf \
  --predicate-type https://cyclonedx.org/bom
```

Deploy by the verified digest through the per-service `image.digest` value (for example
`--set runtime.image.digest=${DIGEST}`), not by the mutable version tag in `global.image.tag`.
## Throughput tuning: `PAGE_CONCURRENCY` vs. the vLLM batch

`PAGE_CONCURRENCY` (Extract) is the number of pages of **one job** Extract keeps in flight
against the vision model at once. Each in-flight page is one request to the OpenAI-compatible
vLLM endpoint, and vLLM packs concurrent requests into a single running batch bounded by its
`--max-num-seqs`. So `PAGE_CONCURRENCY` is effectively "how many sequences one job offers vLLM
to batch". The default of 4 is deliberately conservative; on a real GPU the knee is usually
higher (design guidance: 8–16).

The tuning goal is to keep the vLLM running batch **saturated but not oversubscribed**:

- **Too low** — `num_requests_running` sits well below `--max-num-seqs`, `num_requests_waiting`
  is 0, the GPU idles between decode steps, and pages/minute is left on the table.
- **Right** — `num_requests_running` ≈ `--max-num-seqs`, `waiting` stays near 0, KV-cache usage
  is high but below thrash. Throughput is at its plateau.
- **Too high** — `num_requests_waiting` grows, per-request latency climbs, KV-cache usage nears
  100 % and vLLM begins pre-empting/swapping. More concurrency now buys latency, not throughput.

### Procedure

1. Read the vLLM server's `--max-num-seqs` (its running-batch ceiling). Divide it across the
   number of Extract jobs you expect to hit that server at once — normally the standard lane plus
   the large-job lane (`LARGE_JOB_MAX_CONCURRENCY`, see task 5.2). That quotient is the starting
   per-job batch share, and the expected knee is at or just below it.
2. Pick a fixed, representative source (a document that exercises the vision path — mostly `text`
   pages that the fast-path skips will not stress the model). Upload it once so it has a stable
   `sha256`.
3. Sweep `PAGE_CONCURRENCY` across a ladder that brackets the share, e.g. `1, 2, 4, 8, 16`. For
   each value: set `PAGE_CONCURRENCY`, restart Extract, run the fixed source to completion, and
   record end-to-end pages/minute, mean/95p per-page latency, and — if the vLLM `/metrics`
   endpoint is reachable — `vllm:num_requests_running`, `vllm:num_requests_waiting` and
   `vllm:gpu_cache_usage_perc`.
4. Pick the knee: the highest value at which throughput still climbs meaningfully while
   `num_requests_waiting` stays near 0 and KV-cache usage stays clear of thrash. Set
   `PAGE_CONCURRENCY` to that value (or one step below it for headroom).

The repeatable tool that runs steps 3–4 for you is
[`apps/extract/scripts/throughput-sweep.ts`](apps/extract/scripts/throughput-sweep.ts). Its
arithmetic (the sweep ladder, the vLLM `/metrics` parser, the pages/min + knee analysis, the
report) lives in the unit-tested pure core `apps/extract/src/jobs/throughput-tuning.ts`. Print
the plan with no cluster:

```
bun run scripts/throughput-sweep.ts --plan --max-num-seqs 16 --concurrent-jobs 2
```

Then, for each swept value, set `PAGE_CONCURRENCY`, restart Extract, and append a measured row:

```
bun run scripts/throughput-sweep.ts \
  --base-url http://127.0.0.1:3004 --token <bearer> \
  --source-sha <sha256> --reference tuning/corpus.pdf \
  --concurrency 8 \
  --vllm-metrics-url http://vllm:8000/metrics \
  --extract-metrics-url http://127.0.0.1:3004/metrics \
  --out reports/page-concurrency-sweep
```

The tool writes `reports/page-concurrency-sweep.{json,csv,md}` and prints the recommendation. It
records only what it measures: a server column reads `n/a` when no vLLM `/metrics` URL was given.
Without `--source-sha` (or with `--plan`) it prints only the plan and exits — it never fabricates
a throughput or latency.

### Interaction with other knobs

- **`CONVERT_CONCURRENCY`** governs how many documents convert (LibreOffice/poppler) at once and
  is CPU/subprocess-bound, independent of the GPU batch. Tune it against CPU cores and
  LibreOffice memory, not the vLLM batch. `PAGE_CONCURRENCY × active jobs` is what lands on the
  GPU; keep that product at your target batch share.
- **The large-job lane** (`LARGE_JOB_MAX_CONCURRENCY`, task 5.2) caps how many 1000+-page jobs
  run at once. A single large job saturates the batch by itself, so with the lane at 1 the batch
  share for that job is the full `--max-num-seqs`. If you raise the lane cap or run the standard
  lane alongside it, divide the share accordingly (step 1).
- **`SUMMARY_*` / text-LLM** calls share GPU time if the summary model is co-located with the
  vision model. Sweep with the summary pass enabled if that is your production shape, so the
  measured knee reflects the real contention.

### Worked example (illustrative — replace with your measured numbers)

> The figures below are **placeholders to show the shape of a result table**, not measurements.
> This environment has no GPU/vLLM cluster, so no real numbers were produced. Run the sweep on
> your own hardware to fill these in.

Assume a single vLLM with `--max-num-seqs=16`, one job at a time (large-job lane = 1), so the
expected knee is around 16. An illustrative sweep might look like:

| PAGE_CONCURRENCY | pages/min | mean latency (s) | p95 latency (s) | vllm running | vllm waiting | kv-cache peak |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | _to be measured_ | _tbm_ | _tbm_ | ~1 | 0 | low |
| 4 | _to be measured_ | _tbm_ | _tbm_ | ~4 | 0 | moderate |
| 8 | _to be measured_ | _tbm_ | _tbm_ | ~8 | 0 | high |
| 16 | _to be measured_ | _tbm_ | _tbm_ | ~16 | ~0 | near-full |
| 32 | _to be measured_ | _tbm_ | _tbm_ | ~16 | **grows** | full/thrash |

The pattern to look for: pages/min rises with concurrency until the running batch fills
(`running` ≈ `--max-num-seqs`), then plateaus; pushing past it (32 here) makes `waiting` grow and
latency climb with no throughput gain. The recommendation is the last value **before** that
turn — 16 in this illustrative shape.

## Large documents and formats: lanes, tiling, and the finalize pass

Phase 5 of Document Intelligence v2 added a few operational knobs an operator running large or
large-format corpora should know. All are additive with safe defaults; the full variable list
lives in [docs/CONFIGURATION.md](docs/CONFIGURATION.md) rather than being duplicated here.

- **Large-job lane** — `LARGE_JOB_PAGE_THRESHOLD` (default 1000) is the page count above which a
  job runs in the bounded large-job lane, and `LARGE_JOB_MAX_CONCURRENCY` (default 1) caps how
  many such jobs lease across the whole worker fleet at once. A single large job saturates the
  vision batch by itself; keep the lane small and account for it when computing the
  `PAGE_CONCURRENCY` batch share (see the throughput procedure above). The lane also drives the
  budget warning at 80 % and the remaining-time estimate.
- **Tiling for large formats** — `drawing` pages and pages larger than A3 are split into an N×M
  grid of overlapping tiles, each transcribed separately and merged. `TILE_TARGET_PIXELS`
  (default 2000) is the long edge a single tile is rendered towards, `TILE_OVERLAP_FRACTION`
  (default 0.1) the adjacent-tile overlap so a symbol on a seam appears whole in at least one
  tile, and `TILE_MAX_PER_PAGE` (default 16) a hard ceiling so a vast plan does not spawn
  hundreds of vision calls. Tiles are stored as `tile:` assets and a region zoom is served from
  the covering tile — sharper than the same region cut from a downscaled full page.
- **Finalize pass** — `FINALIZE_PASS` (default `true`) runs a deterministic, **model-free**
  correction of the outline metadata at document end and re-embeds only the units whose heading
  path changed. Set it to `false` to emit the streaming outline as-is (no correction, no
  selective re-embedding).

## Corpus migration (re-ingest into v2)

To migrate an existing corpus into the v2 pipeline, use the repeatable operator CLI
[`apps/extract/scripts/corpus-migrate.ts`](apps/extract/scripts/corpus-migrate.ts) (its
arithmetic — manifest parsing, usage ordering, and the asset-id-stability check — lives in the
unit-tested pure core `apps/extract/src/jobs/corpus-migration.ts`). It re-ingests each document
one at a time in **`version` mode**, so the running system keeps serving the old revision until
the new one is fully committed (Search performs the atomic `is_latest` switch on commit), orders
documents by usage so the most-used become searchable on the new pipeline first, and proves
asset-id stability (asset ids are derived from reference + local id, never the image bytes, so a
re-extraction keeps them byte-identical and previously uploaded crops stay valid).

```bash
# Print the usage-ordered plan and expected asset ids — contacts no server, fabricates nothing:
bun run scripts/corpus-migrate.ts --manifest corpus.json --plan

# Migrate for real, most-used first, in version mode:
bun run scripts/corpus-migrate.ts \
  --manifest corpus.json \
  --base-url http://127.0.0.1:3004 --token <bearer> \
  [--collection documents] [--out reports/corpus-migration.json]
```

A note on versioning per path: the migration CLI sets `X-Version-Mode: version` on `/v1/ingest`.
On the **synchronous v1 Search path** the header is honored directly; on the **v2 path** the
v2 ingest wrapper (`apps/extract/src/handlers/ingest-v2.ts`) does not read the header itself —
versioning there is governed by the emitter's revision flow (Extract opens a new revision through
the Search revision API and Search does the atomic `is_latest` switch on commit). Either way the
old revision stays visible until the new one commits.

## Configuration

Every variable is listed in [docs/CONFIGURATION.md](docs/CONFIGURATION.md), generated from the
schemas themselves. Per-service annotated templates:
[`apps/runtime/.env.example`](apps/runtime/.env.example),
[`apps/search/.env.example`](apps/search/.env.example),
[`apps/gate/.env.example`](apps/gate/.env.example),
[`apps/control/.env.example`](apps/control/.env.example),
[`apps/extract/.env.example`](apps/extract/.env.example).

Control defaults to relative Runtime URLs in production. An external same-origin reverse proxy
must route the Runtime paths used by the browser (including `/v1/*`, `/monitoring/*`, and health
requests) to Runtime; Control does not provide an internal Next.js rewrite or proxy.

`NEXT_PUBLIC_BACKEND_URL` is an explicit development or cross-origin escape hatch. When set,
Next.js freezes this public value into the browser bundle at **build** time, so it must be the URL
the browser can reach, not an in-cluster service name. Omit it from reusable production builds
to preserve relative same-origin routing.
