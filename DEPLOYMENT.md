# Deployment

## Repository boundary

The repository includes source code and a local unauthenticated quickstart under `deploy/examples`. It does **not** include a production Compose stack, Helm chart, customer flow bundle, credentials, production endpoints, or operational overlay.

Environment-specific stack definitions, operational flows, and customer configuration must live in a separately access-controlled deployment system. Released images must be built from a reviewed commit, scanned, accompanied by `sbom.cdx.json` and `THIRD_PARTY_NOTICES.md`, and pinned by immutable digest in the deployment system.

## Local quickstart

Use `deploy/examples/README.md`. Its auth-off settings, deterministic mock model, local password, and development servers are intentionally unsafe for production.

## Application artifacts

- Runtime and Gate are Bun 1.4.0 applications.
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
`libreoffice-writer-nogui`, `libreoffice-calc-nogui`, `fonts-liberation` and `fonts-dejavu-core`
— because PDF and office conversion needs external binaries. Those packages come from the base
image's distribution archive with their own licenses and are **not** covered by the generated
inventories, which describe the JavaScript dependency tree only. A production Extract image must
account for them in its own review.

Tag releases attach a checksummed bundle containing both native workspace inventories and all
five Quickstart image inventories. The release workflow publishes no OCI image. Production
images remain deployment-owned and require their own inventory, source-availability,
replaceability, attribution, scanning, and immutable-digest review.

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
