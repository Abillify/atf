<!-- SPDX-License-Identifier: Elastic-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 Abillify Technology GmbH -->

# Configuration essentials

A first production deployment needs a fraction of the ~700 variables in
[CONFIGURATION.md](CONFIGURATION.md). This page lists, per service, the variables to set
first: **Required for production** are the ones a deployment without them gets wrong or
refuses to start; **Recommended** are the ones an operator usually wants. Every variable
here exists in the generated reference — CI checks that (`bun run check:config-essentials`).
Everything else stays in [CONFIGURATION.md](CONFIGURATION.md).

Examples are synthetic (`example.test`, `192.0.2.x`, `198.51.100.x` are documentation
ranges). Secrets are shown as placeholders, never as values.

## Runtime

### Required for production

| Variable | Purpose | Example |
| --- | --- | --- |
| `ATF_PROFILE` | Operational profile; `production` enables the startup guardrails. | `production` |
| `ATF_PRESET` | Curated bundle of defaults for unset variables; explicit env vars win. | `regulated` |
| `DATABASE_URL` | Postgres for runs, traces, audit and approvals. | `postgres://atf:REPLACE_ME@192.0.2.10:5432/atf` |
| `REDIS_URL` | Redis for queues, caches and rate limiting. | `redis://192.0.2.11:6379` |
| `AUTHN_MODE` | Request authentication; production wants `oidc`, not `disabled`. | `oidc` |
| `OIDC_ISSUER` | OIDC issuer URL; enables JWT verification via discovery/JWKS. | `https://id.example.test/realms/atf` |
| `OIDC_AUDIENCE` | Expected `aud` claim of tokens verified against the issuer. | `atf-runtime` |
| `PROVIDERS` | Named inference endpoints the flows may use. | `[{"name":"gpuvllm","protocol":"openai","url":"http://198.51.100.20:8000/v1"}]` |
| `DEFAULT_LLM` | Model used when a flow node names none. | `{"provider":"gpuvllm","model":"meta-llama/Llama-3.1-8B-Instruct"}` |
| `FLOWS_DIR` | Directory the flows are loaded from. | `/etc/atf/flows` |
| `EVIDENCE_SIGNING_KEY` | Ed25519 key signing the whole evidence chain; generate per deployment. | `REPLACE_WITH_ED25519_SEED_BASE64` |
| `EGRESS_ALLOWED_HOSTS` | Egress allow-list; empty means any public host. | `198.51.100.20,api.example.test` |

### Recommended

| Variable | Purpose | Example |
| --- | --- | --- |
| `AUDIT_ANCHOR_FILE` | Append-only anchor file outside the audit DB. | `/var/lib/atf/anchors.jsonl` |
| `TAINT_MODE` | When taint rules start; `on-untrusted-source` is stricter. | `on-untrusted-source` |
| `AI_DISCLOSURE` | Mark completions as AI-generated for downstream systems. | `header` |
| `COMPLIANCE_POLICY_REQUIRED` | Refuse startup without a loaded compliance policy. | `true` |
| `MONITORING_AUTH` | Operator authentication for `/monitoring/*` and `/admin/*` (default `true`). | `true` |
| `METRICS_AUTH` | Authentication for `/metrics` (default `true`). | `true` |

## Search

### Required for production

| Variable | Purpose | Example |
| --- | --- | --- |
| `ATF_PROFILE` | Operational profile, shared platform-wide. | `production` |
| `POSTGRES_URL` | Postgres with the vector store. | `postgres://atf_search:REPLACE_ME@192.0.2.10:5432/atf_search` |
| `AUTHN_MODE` | API authentication; inferred from credentials when unset, a mode without them fails startup. | `token_or_oidc` |
| `API_OIDC_ISSUERS` | Trusted API token issuers (JSON array). | `[{"issuer":"https://id.example.test/realms/atf","audience":"atf-search"}]` |
| `EMBED_URL` | Embedding endpoint. | `http://198.51.100.21:8080` |
| `EMBED_MODEL` | Embedding model name. | `BAAI/bge-m3` |
| `EMBED_EXPECTED_DIMENSION` | Required vector dimension for both embedding paths. | `1024` |

### Recommended

| Variable | Purpose | Example |
| --- | --- | --- |
| `RERANK_URL` | TEI rerank endpoint; falls back to `EMBED_URL`. | `http://198.51.100.22:8080` |
| `RERANK_MODEL` | Rerank model name. | `BAAI/bge-reranker-v2-m3` |
| `FTS_LANGUAGE` | Default FTS language for new collections (default `german`). | `german` |
| `CONVERTER_URL` | Document converter behind `POST /ingest-file`. | `http://198.51.100.30:8090` |
| `CONVERTER_TOKEN` | Bearer token Search sends to the converter. | `REPLACE_WITH_SHARED_SECRET` |
| `RATE_LIMIT_REDIS_URL` | Shared Redis for the rate limiter; without it the budget is per replica — set it with more than one replica. | `redis://192.0.2.11:6379` |

## Extract

### Required for production

| Variable | Purpose | Example |
| --- | --- | --- |
| `ATF_PROFILE` | Operational profile, shared platform-wide. | `production` |
| `EXTRACT_DATABASE_URL` | Postgres for extraction jobs. | `postgres://atf_extract:REPLACE_ME@192.0.2.10:5432/atf_extract` |
| `VISION_URL` | OpenAI-compatible chat-completions API for vision extraction. | `http://198.51.100.23:8000/v1` |
| `VISION_MODEL` | Vision model name. | `Qwen/Qwen2.5-VL-7B-Instruct` |
| `SEARCH_URL` | Search service that receives extracted content. | `http://198.51.100.40:3001` |

### Recommended

| Variable | Purpose | Example |
| --- | --- | --- |
| `MAX_PAGES` | Refuse documents longer than this (default `500`, `0` = unlimited). | `200` |
| `SOURCE_URL_ALLOWED_HOSTS` | Allow-list for hosts in caller-supplied `source_url`. | `docs.example.test` |
| `CALLBACK_ALLOWED_HOSTS` | Allow-list for `X-Callback-URL` hosts. | `hooks.example.test` |
| `JOB_RETENTION_DAYS` | Days a finished job is kept after its last change (default `0`). | `30` |

## Gate

The Gate's substantive configuration — tools, backends, scopes, policies — lives in YAML
under `MCPGATE_CONFIG_DIR`, not in environment variables. See the generated
[Gate configuration file (YAML)](CONFIGURATION.md#gate-configuration-file-yaml) reference
and `deploy/examples/gate/config.yaml` for the shape.

| Variable | Purpose | Example |
| --- | --- | --- |
| `MCPGATE_CONFIG_DIR` | Directory with the YAML configuration (default `./config`). | `/etc/atf/gate` |
| `ATF_PROFILE` | Operational profile; wins over `MCPGATE_ENV`. | `production` |

## Control

Control talks to Runtime over HTTP/SSE; same-origin relative URLs are the production
default and the reverse proxy provides the routing. For a server-held session, set
`CONTROL_SESSION_MODE=bff` together with `CONTROL_SESSION_SECRET` (≥ 32 characters).

| Variable | Purpose | Example |
| --- | --- | --- |
| `CONTROL_SESSION_MODE` | `bff` keeps the token server-side behind an HttpOnly cookie. | `bff` |
| `CONTROL_SESSION_SECRET` | Sealing secret for the `bff` session cookie. | `REPLACE_WITH_32_PLUS_CHARACTERS` |
| `CONTROL_PUBLIC_ORIGIN` | Public origin of the Control deployment. | `https://atf.example.test` |
