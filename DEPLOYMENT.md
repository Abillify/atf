# Deployment

## Repository boundary

The repository includes source code and a local unauthenticated quickstart under `deploy/examples`. It does **not** include a production Compose stack, Helm chart, customer flow bundle, credentials, production endpoints, or operational overlay.

Environment-specific stack definitions, operational flows, and customer configuration must live in a separately access-controlled deployment system. Released images must be built from a reviewed commit, scanned, accompanied by `sbom.cdx.json` and `THIRD_PARTY_NOTICES.md`, and pinned by immutable digest in the deployment system.

## Local quickstart

Use `deploy/examples/README.md`. Its auth-off settings, deterministic mock model, local password, and development servers are intentionally unsafe for production.

## Application artifacts

- Runtime and Gate are Bun 1.3.14 applications.
- Search is Bun-native and additionally supports `bun run --filter @atf/search build:node` for a Node.js 26 artifact.
- Control is built with Bun and deployed on Node.js 26 from the Next.js standalone output.

Production Dockerfiles and orchestration definitions are deployment-owned and are not represented by the quickstart Dockerfile.

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

With `APP_ENV=production`, Runtime refuses to start rather than warn when a setting is unsafe —
open CORS, unverified JWTs, an unauthenticated monitoring or metrics endpoint, and similar. Gate
has an equivalent gate of its own (ADR `gate/0001`). See `apps/runtime/src/config/prod-gate.ts`
for the exact set.

The gate covers settings a process can inspect about itself. It cannot verify TLS termination,
network policy, backup restores, secret rotation, or least-privilege database grants. Those
remain deployment review items, which is why the list above is longer than what the gate checks.

### SBOM per platform

`sbom.cdx.json` and `THIRD_PARTY_NOTICES.md` describe the platform they were generated on,
because optional native prebuilds resolve differently per platform. The committed copies are
generated on a maintainer machine; the artifacts to retain alongside a release image are the
ones CI produces on Linux. Both record the platform in the notices header and in the SBOM's
`metadata.properties` as `atf:inventory:platform`.

## Configuration

Every variable is listed in [docs/CONFIGURATION.md](docs/CONFIGURATION.md), generated from the
schemas themselves. Per-service annotated templates:
[`apps/runtime/.env.example`](apps/runtime/.env.example),
[`apps/search/.env.example`](apps/search/.env.example),
[`apps/gate/.env.example`](apps/gate/.env.example),
[`apps/control/.env.example`](apps/control/.env.example).

One deployment-time trap worth calling out: Next.js inlines `NEXT_PUBLIC_*` at **build** time, so
`NEXT_PUBLIC_BACKEND_URL` must be set when Control is built, not only when it starts. It must
also be the URL the **browser** can reach, not an in-cluster service name.
