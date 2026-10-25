# Total Cost of Ownership (TCO) Guide

Who reads this: whoever sizes and budgets an ATF deployment. This guide gives
the minimum and HA topologies, the resource envelope per service, and the cost
drivers that dominate a real bill — the vision model per page, embeddings, and
the reranker. All platform numbers below are the shipped defaults from
`deploy/helm/atf/charts/*/values.yaml`; model prices and cloud rates are not
shipped anywhere in this repository, so every monetary figure here is a
**formula plus a worked, clearly-marked example** — plug in your own rates.

Related: [../DEPLOYMENT.md](../DEPLOYMENT.md) (production minimums, throughput
tuning, migrations), [CONFIGURATION.md](CONFIGURATION.md) (every variable,
generated), [deploy/examples/README.md](../deploy/examples/README.md) (local
quickstart).

## 1. What you pay for

An ATF deployment has three cost pools, and they scale very differently:

| Pool | Components | Scales with |
| --- | --- | --- |
| **Platform** | runtime, gate, search, extract, control (5 containers), PostgreSQL/pgvector, Redis (required with more than one replica; the Helm defaults declare two) | request volume, corpus size, retention |
| **Inference** | VLM (Extract), embedding model (Search), reranker (Search), flow LLM (Runtime) | pages ingested, chunks embedded, queries reranked, flow executions |
| **Data** | Postgres storage (vectors + extracted content), backups, object storage for assets | corpus size × (1 + replica count) × retention |

The platform pool is small and flat; the inference pool is where 80–95 % of a
production bill usually sits. Budget it first.

## 2. Minimum topology (single node, non-HA)

For pilots and internal tools. Everything fits on one node with a GPU if the
VLM is self-hosted, or on a small CPU-only node if inference is an external
API.

| Component | Replicas | CPU req / limit | Memory req / limit |
| --- | --- | --- | --- |
| runtime | 1 | 500m / — | 1Gi / 2Gi |
| gate | 1 | 250m / — | 512Mi / 1Gi |
| search | 1 | 500m / — | 1Gi / 2Gi |
| extract | 1 | 500m / — | 2Gi / 4Gi |
| control | 1 | 250m / — | 512Mi / 1Gi |
| **Platform total** | | **~2 vCPU** | **~5Gi (10Gi at limits)** |

Plus, outside the chart (the chart ships no database and no model serving):

- **PostgreSQL/pgvector**: 2 vCPU / 4 GiB is a workable pilot floor. Size the
  disk from the corpus (§5), not from the row count.
- **Inference**: either one GPU node running vLLM (VLM) and an
  embedding/rerank server, or external API endpoints. A single modern
  data-center GPU (≥ 24 GiB VRAM per served model) covers a pilot's VLM plus
  embeddings.

A single-node Kubernetes (k3s/k0s) or plain Docker Compose
(`deploy/examples/`) is acceptable here; the Helm chart renders the same
workloads either way. Expect no availability guarantees: one node, one
database, restarts are downtime.

## 3. HA topology (production)

The chart's HA knobs are `autoscaling` (HPA, default off: min 2, max 6 for
Runtime and Gate, 8 for Search and Extract, 4 for Control; CPU 70 %) and
`podDisruptionBudget` (default on: `minAvailable: 1`). For HA:

| Component | Replicas | Notes |
| --- | --- | --- |
| runtime | 2–6 (HPA) | rate limits and approvals shared through `REDIS_URL` (incl. the GitOps webhook limiter); not fully stateless: SSE sessions pin to a pod and the metrics ring, replay buffer, red-team schedule, the decision-receipt transparency log and the media store are per process (`runbooks/scaling.md`) — use sticky routing or accept reconnects |
| gate | 2 (HPA) | identity rate limits and redeemed approval tokens shared with `store.type=redis`; SSE sessions are per process (sticky routing for `/sse` and `/monitor/stream`) |
| search | 2–8 (HPA) | no per-process user state; set `RATE_LIMIT_REDIS_URL` **and** `REPLICAS` above one replica (the production gate refuses `REPLICAS > 1` without it) so throttling is per-client fleet-wide; DB pool sized per replica — total connections must fit Postgres `max_connections` |
| extract | 2–4 | job worker uses Postgres row locks, so replicas are safe; set `RATE_LIMIT_REDIS_URL` and `REPLICAS` above one replica; more replicas = more parallel jobs: peak vision calls ≈ `JOB_CONCURRENCY × PAGE_CONCURRENCY × replicas` against the VLM. `TEMP_DIR` (conversions, derived-PDF cache) is per pod |
| control | 2 | stateless UI |
| **Platform total** | | **~5–15 vCPU / ~10–25 GiB** across ≥ 3 worker nodes |

HA requirements outside the chart:

- **PostgreSQL/pgvector**: primary + streaming replica (or a managed HA
  offering) in **separate availability zones**; PgBouncer in front if replica
  counts grow the connection count past a few hundred.
- **Nodes**: ≥ 3 worker nodes so a node drain never evicts the last replica
  (the PDBs assume this).
- **Inference**: the VLM is the hardest component to make HA. Two vLLM
  replicas behind a load balancer, or an external API with a fallback
  provider (`FALLBACK_LLM` covers the Runtime flow LLM; Extract/Search take a
  single `VISION_URL`/`EMBED_URL`, so redundancy there is a load balancer or
  DNS concern).
- **Backups**: PITR for Postgres, tested restores (§6). A restore you have not
  rehearsed is not a backup.

## 4. Cost drivers, in order of typical impact

### 4.1 VLM tokens per page (Extract) — usually #1

Extract sends **every page** of every ingested document to the vision model
(OpenAI-compatible `VISION_URL`). The per-page token cost is set by:

- `RENDER_DPI` (default 200) — the raster resolution the model sees. Token
  counts of vision encoders grow roughly with pixel area: halving the DPI
  roughly quarters the image tokens. Only lower it if your recall tests still
  pass. Measure instead of guessing: `bun run eval:extract-quality` scores
  CER, Heading-F1 and table TEDS of what a setting produced against your own
  annotated set ([scripts/eval/README.md](../scripts/eval/README.md)), so a lower
  DPI, a cheaper model or a prompt change is a number, not an impression.
- Page count — bounded by `MAX_PAGES` (default 500, 0 = unlimited), enforced
  in the v1 extractor and the v2 job runner: a job that would process more
  pages (the window selected with `pages`, at most the document) fails before its
  first vision call. An accidental 10 000-page scan is 20× a typical contract;
  keep the limit on. `pages` (`"5-"`, `"3-10"`) also caps what one job spends
  when only part of a large document is needed.
  `MAX_PAGES` bounds one document; the aggregate over many documents is bounded
  per tenant by `VISION_BUDGET_PAGES_PER_DAY` (default 0 = off) — and jobs
  without a tenant by neither that nor anything but the per-job token budget.
- Output tokens — the structured extraction schema plus the finalize pass.
  `PAGE_CONCURRENCY` (default 4) does **not** change total tokens; it only
  changes how fast they are spent (and how well a self-hosted vLLM batch is
  saturated — see "Throughput tuning" in [../DEPLOYMENT.md](../DEPLOYMENT.md)).

**Formula:**

```
cost_ingest = pages × (in_tokens_per_page × price_in
                     + out_tokens_per_page × price_out)
```

**Worked example (illustrative — replace with your measured numbers):** a
30-page invoice at ~1 100 image+prompt tokens and ~350 output tokens per page,
API prices $0.0021 / 1k in and $0.0063 / 1k out:

```
30 × (1.1 × 0.0021 + 0.35 × 0.0063) ≈ 30 × 0.0045 ≈ $0.14 per document
10 000 documents/month ≈ $1 400/month  ← dominated entirely by the VLM
```

Self-hosted, the same driver becomes GPU-hours: pages/minute per vLLM replica
is what you measure (vLLM metrics `num_requests_running` vs `--max-num-seqs`),
and the bill is `GPU-hours × rate`, with concurrency tuned to keep the running
batch saturated but not oversubscribed.

### 4.2 Embeddings per chunk (Search)

Every chunk of every document is embedded once (content-addressed revisions
skip unchanged content, so re-ingest of an unchanged corpus is nearly free).

- `CHUNK_SIZE` / `CHUNK_OVERLAP` set the chunk count: halving the chunk size
  roughly doubles embedding calls.
- Query-time embeddings are negligible (one short text per query).

**Formula:** `cost_embed = chunks × tokens_per_chunk × price_per_1k_tokens`.
Embedding prices are 1–2 orders of magnitude below VLM prices — usually the
second-largest line, not the first.

### 4.3 Reranker per query (Search)

The reranker is opt-in (`RERANK_MODEL` unset = off). When on, each query
reranks `RERANK_CANDIDATE_MULTIPLIER` (default 4) × the result count
documents. Cost scales with **query volume**, not corpus size:

```
cost_rerank = queries × candidates × tokens_per_candidate × price
```

Self-hosted, the reranker is a small model — it can share a GPU with the
embedding server.

### 4.4 Flow LLM (Runtime)

Flow executions consume LLM tokens per node that calls a model. Guardrails:
per-flow budgets and `MAX_*` token settings exist (see
[CONFIGURATION.md](CONFIGURATION.md)); set them per tenant before opening
self-serve usage.

### 4.5 Platform and data

- **Postgres storage**: pgvector dominates. A 1024-dimension float32 vector is
  4 KB before index overhead; HNSW adds roughly 1.2–2×. 10 M chunks ≈ 40–120 GB
  of vector data alone, plus extracted text, revisions, and assets.
- **Backups** multiply storage by retention × (1 + PITR WAL).
- **Egress**: cross-AZ traffic between services and the database is a classic
  silent line item; keep the DB in the same AZ as the app tier where
  availability rules allow.

## 5. Sizing worksheet (fill in your numbers)

1. Measure one representative document end-to-end in a staging environment
   with `TRACING_ENABLED=true`: the OTel spans show per-page VLM
   latency and per-request token usage (`gen_ai.*` attributes).
2. Record: `tokens_in/page`, `tokens_out/page`, `chunks/doc`, `pages/doc`.
3. Project monthly volume: documents, chunks, queries, flow executions.
4. Apply the formulas in §4 with your provider's price list (or your
   GPU-hour internal rate).
5. Add the platform pool from §2/§3 and data storage from §4.5 with a 30 %
   headroom margin.
6. Re-measure quarterly — model swaps change every inference number in this
   worksheet.

## 6. Cost controls that already exist in the product

- `MAX_PAGES` — hard cap on the pages one document/job may process (Extract, v1 and v2).
- `VISION_BUDGET_PAGES_PER_DAY` — per-tenant daily VLM page budget (Extract; off by default, and not applied to jobs without a tenant).
- `PAGE_CONCURRENCY` + vLLM `--max-num-seqs` — throttle how fast VLM capacity
  (and budget) is consumed; also protects the KV cache.
- Content-addressed revisions — unchanged content is never re-embedded.
- `MIN_RERANK_SCORE` / candidate multiplier — bound reranker spend per query.
- Flow budgets and fallback providers (`FALLBACK_LLM`) — cap and reroute LLM
  spend.
- `TRACING_ENABLED` + OTel export — attribute spend to services and routes
  before optimising blindly.
- Backups with tested restores — the cheapest insurance against the most
  expensive incident (corpus loss = full re-ingest = full VLM bill again).

## Cost levers in the Runtime

Beyond the per-service knobs above, the Runtime ships flow-level levers that
change what a flow execution costs. None of them has a universal right
setting — measure with your own flow and model before and after.

**Cascade.** A node with a `cascade` block answers with a cheap model first
and re-runs the same input on the model in `cascade.escalateTo` only when the
evidence rules in `cascade.when` fire (diagnostics, refusals, length). The
saving depends entirely on the escalation rate: at a low rate most executions
pay the cheap model once, at a high rate they pay both models. Measure the
rate — `flows release` runs the bench suite and its statistics cover the
executions behind the release decision, and the escalation counter
(`aiperator_cascade_escalations_total`) is exported per flow and node.

**Budgets.** A flow's `budgets` block caps one execution: total tokens, tool
calls, and wall-clock time. A budget breach stops the execution
(`BUDGET_EXCEEDED`) instead of letting a looping or oversized run spend
unbounded tokens — the per-execution floor under the deployment-level
`BUDGET_*` caps (§4.4).

**Service objectives.** A flow's `slo` block states what "good" costs: a
median latency target, a p95 latency target, a token ceiling per answer and a
maximum error rate. The Runtime evaluates it continuously (flow health in
Control, `aiperator_flow_slo_breach_total`), and `flows release` applies it as
a default: where the bench file sets no `maxLatencyMsP50` or `maxTokensP50`,
the `slo` values become the release thresholds, so a flow that drifts past its
own objective can no longer ship. A cost cut that doubles p50 latency then
fails the gate instead of going unnoticed — the receipt records which source
(`bench` or `slo`) supplied each applied threshold.

**Coverage-queue lanes.** The agent harness's `coverageQueue.lanes` runs
parallel coverage assignments for one execution. Each lane issues its own
model calls concurrently, so lanes trade latency for concurrent inference
load: size them to the number of model endpoints (or the batch capacity of
one server), not to the CPU of the Runtime pod.

**Sticky model pools.** A model pool with `pool.sticky` pins an execution (or
session) to one pool member. On single-slot servers — one model per GPU, with
a prefix cache that is per process — this reuses the cached prefix across the
calls of an execution instead of paying it cold on every call; round-robin
across replicas defeats that cache.

**Answer-ready retrieval.** `retrieve_for_answer` packs evidence into a token
budget (`packEvidence`): the answering model receives at most that many
tokens of passages regardless of how many candidates matched, bounding the
input side of the answer call per request.

## 7. Operating effort

Recurring platform work is small compared to the inference bill, but it is
not zero. The tasks below come from the runbooks (`runbooks/`); the effort
column is deliberately left unquantified — measure it in your deployment.

| Role | Typical tasks | Indicative effort |
| --- | --- | --- |
| Platform operator | Version upgrades and verified-digest rollouts (`runbooks/` upgrade flow), scaling decisions (`runbooks/scaling.md`), Redis outage handling (`runbooks/redis-outage.md`) | to be measured per deployment |
| Security / key custodian | Key rotation for signing, tokens and secrets (`runbooks/key-rotation.md`, `runbooks/transaction-token-rotation.md`) | to be measured per deployment |
| On-call / SRE | Monitoring and alert response, incident handling (`runbooks/incident.md`) | to be measured per deployment |
| Data custodian | Backup and restore drills (`runbooks/backup-restore.md`) | to be measured per deployment |
