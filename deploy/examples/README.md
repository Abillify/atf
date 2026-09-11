# Local unauthenticated quickstart

This example starts all five ATF applications plus PostgreSQL/pgvector and a deterministic OpenAI-compatible mock. It is intended only for local functional smoke testing. Authentication, authorization, tenant isolation, TLS, durable Runtime state, Redis, real inference, and production hardening are deliberately disabled or omitted.

## Requirements

- Docker with Compose v2
- At least 6 GB free memory and 10 GB free disk space for image builds and dependencies

## Start

From the repository root:

```bash
docker compose --env-file deploy/examples/.env.example -f deploy/examples/compose.yaml up --build -d
docker compose --env-file deploy/examples/.env.example -f deploy/examples/compose.yaml ps
```

Wait until all application health checks are healthy. Endpoints:

- Control: <http://localhost:3001>
- Runtime readiness: <http://localhost:3000/health/ready>
- Search health: <http://localhost:3002/health>
- Gate readiness: <http://localhost:3003/readyz>
- Extract health: <http://localhost:3004/health>, upload UI at <http://localhost:3004/>

Run the synthetic flow through Runtime's OpenAI-compatible endpoint:

```bash
curl --fail-with-body http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"quickstart","messages":[{"role":"user","content":"Confirm the quickstart."}]}'
```

The response comes from `model-mock.py`; it demonstrates the Runtime-to-model wiring, not model
quality. The health checks confirm that Search, Gate and Extract start, but this curl does not
exercise those services. Extract runs against the same mock as a vision model, so a conversion
returns deterministic placeholder text rather than real extraction output. The quickstart does not preload retrieval documents or governed tools; see
[`flows/README.md`](flows/README.md) before running examples that depend on them. Search
embeddings are deterministic three-dimensional smoke vectors and must never be used for
relevance evaluation.

## Stop

```bash
docker compose --env-file deploy/examples/.env.example -f deploy/examples/compose.yaml down
```

To also delete the local PostgreSQL volume:

```bash
docker compose --env-file deploy/examples/.env.example -f deploy/examples/compose.yaml down --volumes
```

## Security boundary

All APIs are unauthenticated and intended for loopback development only. The host ports default to local developer ports but Docker publishes them on available host interfaces. Do not run this stack on an untrusted network or internet-accessible machine. Production and customer deployments must use separately reviewed images, authentication, authorization, tenant isolation, TLS, secret management, backups, observability, and immutable image digests.
