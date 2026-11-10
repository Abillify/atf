# Local unauthenticated quickstart

This example starts all five ATF applications plus PostgreSQL/pgvector and a deterministic OpenAI-compatible mock. It is intended only for local functional smoke testing. Authentication, authorization, tenant isolation, TLS, durable Runtime state, Redis, real inference, and production hardening are deliberately disabled or omitted.

Two ways to start the same stack:

| Option | What you get | Needs |
| --- | --- | --- |
| [A](#option-a--published-images) | The released images, pulled from the registry | Docker with Compose v2, roughly 4 GB of free disk |
| [B](#option-b--build-from-source) | Images built from this checkout | A build toolchain, at least 6 GB free memory and 10 GB free disk |

Choose Option A to look around the product, Option B once you have changed code in this checkout and want to see it.

## Option A — published images

`compose.images.yaml` is an overlay that swaps every `build:` section for a
`ghcr.io/abillify/atf-*` image, so the service definitions, flow files, mock
model and health checks are identical in both options. From the repository root:

```bash
docker compose --env-file deploy/examples/.env.example \
  -f deploy/examples/compose.yaml -f deploy/examples/compose.images.yaml \
  up -d --wait
docker compose --env-file deploy/examples/.env.example \
  -f deploy/examples/compose.yaml -f deploy/examples/compose.images.yaml ps
```

`ATF_VERSION` in [`.env.example`](.env.example) picks the release. `bun run
verify:version` keeps it equal to the version in `package.json`, so a fresh
checkout pulls the images of the code you are reading. The registry is public and
needs no `docker login`.

This variant adds one service the build variant does not have: a digest-pinned
Caddy router in front of the Control. The released Control bakes no backend URL
into its bundle and therefore calls its own origin through relative paths, which
works only if the UI and the Runtime share one origin — that is what the router
provides, and it mirrors how the applications are wired in production. What that
means in practice:

- The router is the only way to reach the Control here; the Control container
  publishes no host port of its own. Runtime, Search, Gate and Extract keep the
  ports listed under [Endpoints](#endpoints).
- Nothing is built, so this path needs no build toolchain and no compile-time
  memory; the disk figure in the table above is the pulled images themselves.
- Flow changes still apply without a rebuild: the Runtime watches `FLOWS_DIR` in
  every mode, so editing a file in [`flows/`](flows/) is picked up on its own. A
  Control UI change is not, because the released image serves a built page — that
  is what Option B is for.

## Option B — build from source

From the repository root:

```bash
docker compose --env-file deploy/examples/.env.example -f deploy/examples/compose.yaml up --build -d
docker compose --env-file deploy/examples/.env.example -f deploy/examples/compose.yaml ps
```

## Endpoints

Wait until all application health checks are healthy. Endpoints:

- Control: <http://localhost:3001> — in Option A this URL is the router, which forwards the UI and the Runtime API to the right service
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

Repeat the `-f` flags you started with, otherwise Compose treats the stack as a
different project:

```bash
docker compose --env-file deploy/examples/.env.example -f deploy/examples/compose.yaml down
docker compose --env-file deploy/examples/.env.example -f deploy/examples/compose.yaml \
  -f deploy/examples/compose.images.yaml down
```

To also delete the local PostgreSQL volume, add `--volumes` to the matching command.

## Security boundary

All APIs are unauthenticated and intended for loopback development only. The host ports default to local developer ports but Docker publishes them on available host interfaces. Do not run this stack on an untrusted network or internet-accessible machine. Production and customer deployments must use separately reviewed images, authentication, authorization, tenant isolation, TLS, secret management, backups, observability, and immutable image digests.
